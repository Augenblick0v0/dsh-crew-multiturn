// DSH host plugin: workers-hub.
// Runs DeepSeek workers as first-class in-host agent sessions (visible in the
// Web UI session list), exposes a loopback jobs API for the CC/Codex MCP shim,
// and serves the one-click installer endpoints for the settings page.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isAbsoluteCwd, canonicalCwd } from '../paths.mjs';
import { createShardWriter, readMergedStatus } from '../status-shard.mjs';
import { procAlive, killWorkerProcess, parsePid, ProcKillRefused } from '../proc-kill.mjs';
import { installWorkerQuestionHandoff } from '../worker-question.mjs';
import { probeProvider } from '../provider-probe.mjs';

// No @deepseek-ai imports here on purpose: this plugin is loaded into the
// profile realm, and importing our own package copies would create duplicate
// module realms (symbol identity mismatches in the tool runtime). Everything
// below is either plain data or inlined logic that only touches ctx APIs.

/** Inlined from @deepseek-ai/dsh-agent model-selection.ts (same semantics). */
function installModelSelection(agentCtx, selection) {
  agentCtx.on('system-prompt/assemble', async (_assembly, _cause, next) => {
    const selected = selection.current;
    const assembled = await next();
    selection.assembled = selected;
    if (selected === undefined) return assembled;
    return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } };
  });
  agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next();
    const selected = selection.assembled;
    if (selected === undefined) return resolved;
    const { reasoningEffort: _inherited, ...rest } = resolved;
    return {
      ...rest, provider: selected.provider, model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    };
  });
}

/** Inlined shape of createUserMessage (role + fresh id, frozen). */
function userMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
}

/**
 * The rejection a worker's ask_user_question receives. Shaped like the host's
 * UserQuestionError (name + code) so the seam restores it as one and the
 * model sees the message, the same way the host answers a question from a
 * child agent that has no human either (DELEGATED_CALLER).
 */
export function unattendedQuestion() {
  const error = new Error(
    'no one is attending this dsh-crew worker session, so a question cannot be answered and must not be waited on. '
    + 'Stop and put the unresolved question in your final message so the orchestrator can obtain the required answer or approval. '
    + 'An unanswered question grants no permission; never select an option automatically.',
  );
  error.name = 'UserQuestionError';
  error.code = 'UNATTENDED_WORKER';
  return error;
}

export const name = 'dsh-crew';
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'tools', 'llm', 'attachments'];

// Optional: the host's durable locale preference seeds server-side strings
// before the panel is ever opened. Absent preference means "browser decides".
function seedLangFromHost(ctx) {
  try {
    const pref = ctx.settings?.get?.('locale')?.preference;
    if (pref) setLang(pref);
  } catch { /* settings service absent or shaped differently — keep the default */ }
}

import { setLang } from '../i18n.mjs';

const ROUTE_BASE = '/_dsh/dsh-crew';
// Tier -> {provider, model}. The defaults live in tier-binding.mjs; the
// caller may override per dispatch, and the hub's own config is the fallback
// when it does not (the same shape the preset lookup below uses).
import { describeBindings, resolveTierBinding, TIERS } from '../tier-binding.mjs';
const CONFIG_DIR = join(homedir(), '.config', 'dsh-crew');

// ---------- job registry ----------

/** Bounded task preview with a visible truncation marker (PATTERN-AUDIT D3:
// a silently truncated task reads like the whole brief in status views). */
function clipTask(task, cap = 300) {
  return task.length > cap ? task.slice(0, cap) + '…' : task;
}

/** A malformed request (HTTP 400): bad message text, mode or answer shape. */
export class JobRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JobRequestError';
    this.statusCode = 400;
  }
}

/** An unknown job id (HTTP 404). */
export class JobNotFoundError extends Error {
  constructor(id) {
    super(`no such job: ${id}`);
    this.name = 'JobNotFoundError';
    this.statusCode = 404;
    this.jobId = id;
  }
}

/**
 * A state transition the current job status does not allow (HTTP 409).
 * `jobStatus` and `allowed` are the machine-readable part: callers poll a job
 * and need to know what it is and what they may do instead, not only prose.
 */
export class JobStateError extends Error {
  constructor(jobStatus, message, allowed = []) {
    super(message);
    this.name = 'JobStateError';
    this.statusCode = 409;
    this.jobStatus = jobStatus;
    this.allowed = allowed;
  }
}

const ACTIVE_STATUSES = new Set(['running', 'queued']);
const LIVE_STATUSES = new Set(['running', 'queued', 'idle', 'needs_input']);
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'expired']);
const TURN_MODES = new Set(['auto', 'steer', 'followup']);

function normalizeMode(mode) {
  // Accept both call styles used by the docs and older callers:
  // runTurn(job, text, 'steer') and runTurn(job, text, { mode: 'steer' }).
  const value = mode !== null && typeof mode === 'object' ? mode.mode : mode;
  if (value === undefined || value === null || value === '') return 'auto';
  if (!TURN_MODES.has(value)) throw new JobRequestError('mode must be auto, steer or followup');
  return value;
}

function normalizeAnswers(answers) {
  if (!Array.isArray(answers) || answers.length === 0) throw new JobRequestError('answers must be a non-empty array');
  return answers.map((item) => {
    if (item === null || typeof item !== 'object' || !Object.prototype.hasOwnProperty.call(item, 'answer')) {
      throw new JobRequestError('each answer needs an "answer" field');
    }
    return {
      questionId: item.questionId === undefined || item.questionId === null ? undefined : String(item.questionId),
      answer: item.answer,
    };
  });
}

export class WorkerRegistry {
  constructor(ctx, shard = createShardWriter('hub'), options = {}) {
    this.ctx = ctx;
    this.jobs = new Map();
    this.nextId = 1;
    this.shard = shard;
    // C03 ring buffer: bounded so a long multi-turn session cannot grow the
    // hub's heap without bound while still giving since-cursor readers a tail.
    this.eventLimit = options.eventLimit ?? 500;
    // C01: an idle session is disposed after 30 minutes by default.
    this.idleTtlSeconds = options.idleTtlSeconds ?? 1800;
    this.nextQuestionId = 1;
  }

  view(job, withResult = false) {
    const v = {
      id: job.id, sessionId: job.sessionId, tier: job.tier, model: job.model, provider: job.provider,
      effort: job.effort, status: job.status, source: job.source, task: clipTask(job.task),
      cwd: job.cwd, turn: job.turn, step: job.step, currentTool: job.currentTool,
      toolCalls: job.toolCalls, tokens: job.tokens, mode: 'hub',
      turns: job.turns?.length ?? 0,
      pendingQuestions: job.pendingQuestions?.length ?? 0,
      lastEventAt: job.lastEventAt ?? null,
      startedAt: job.startedAt, endedAt: job.endedAt,
      ...(job.questions === undefined ? {} : { questions: job.questions }),
      ...(job.capabilities === undefined ? {} : { capabilities: job.capabilities }),
    };
    if (withResult) {
      v.result = job.result; v.error = job.error; v.stopReason = job.stopReason;
      v.reasonDetail = job.reasonDetail;
      v.turnRecords = job.turns ?? [];
      v.pendingQuestionDetails = (job.pendingQuestions ?? []).map((q) => ({
        questionId: q.questionId ?? q.id, question: q.question, ...(q.detail === undefined ? {} : { detail: q.detail }),
      }));
    }
    return v;
  }

  publish() {
    this.shard.publish([...this.jobs.values()].map((j) => this.view(j)));
  }

  /** C05 capability probe, re-run whenever a handle (re)appears. */
  detectCapabilities(job) {
    return {
      resume: typeof this.ctx.agents?.resume === 'function',
      steer: typeof job.handle?.agent?.steer === 'function',
      flush: typeof this.ctx.sessions?.flush === 'function',
    };
  }

  idleTtlMs(job) {
    // T06: a dispatch may pin its own idle TTL; otherwise the hub config wins.
    const jobValue = Number(job?.idle_ttl_seconds);
    if (Number.isFinite(jobValue) && jobValue > 0) return jobValue * 1000;
    const configured = Number(this.getConfig?.()?.idle_ttl_seconds);
    const seconds = Number.isFinite(configured) && configured > 0 ? configured : this.idleTtlSeconds;
    return seconds * 1000;
  }

  recordEvent(job, type, data) {
    const event = {
      seq: job.nextSeq++,
      ts: new Date().toISOString(),
      type,
      // C03: summary is the single line a UI/CLI tail renders. `data` stays
      // available for programmatic readers but is never required to be small.
      summary: this.summarizeEventText(type, data),
    };
    if (data !== undefined) event.data = data;
    job.events.push(event);
    if (job.events.length > this.eventLimit) job.events.splice(0, job.events.length - this.eventLimit);
    job.lastEventAt = event.ts;
    return event;
  }

  /** Human-readable one-line form of an event, derived only from its summary data. */
  summarizeEventText(type, data) {
    const d = data ?? {};
    switch (type) {
      case 'step/start': return `turn ${d.turn ?? '?'} · step ${d.step ?? '?'}`;
      case 'tool/call': return `tool ${d.name ?? '?'}${d.callId === undefined ? '' : ` (${d.callId})`}`;
      case 'tool/result': return `tool ${d.name ?? '?'} ${d.ok === false ? 'failed' : 'done'}`;
      case 'assistant/message': {
        const text = typeof d.text === 'string' ? d.text : '';
        return text === '' ? 'assistant message' : clipTask(text, 160);
      }
      case 'turn/start': return `turn ${d.turn ?? '?'} started${d.resumed ? ' (resumed)' : ''}${d.queued ? ' (queued)' : ''}`;
      case 'turn/end': return `turn ended: ${d.reason?.kind ?? 'unknown'}`;
      case 'turn/settled': return `turn ${d.turn ?? '?'} settled: ${d.stopReason ?? 'unknown'} · ${d.status ?? '?'}`;
      case 'turn/error': return `turn error: ${clipTask(String(d.message ?? ''), 160)}`;
      case 'turn/steer': return `steer: ${clipTask(String(d.text ?? ''), 120)}`;
      case 'session/resumed': return `session resumed: ${d.sessionId ?? '?'}`;
      case 'question/pending': return `question pending: ${d.questionId ?? '?'}`;
      case 'question/answered': return `question answered: ${(d.answered ?? []).join(', ')}`;
      case 'job/cancelled': return 'job cancelled';
      case 'job/expired': return 'job expired';
      default: return type;
    }
  }

  /** Keep only what a status/event reader needs; never a whole model message. */
  summarizeEvent(event) {
    const data = event?.data ?? {};
    switch (event?.type) {
      case 'step/start': return { turn: data.turn, step: data.step };
      case 'tool/call': return { name: data.name, ...(data.callId === undefined ? {} : { callId: data.callId }) };
      case 'tool/result': return { name: data.name, ...(data.ok === undefined ? {} : { ok: data.ok }) };
      case 'assistant/message': {
        const text = (data.message?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('');
        return text === '' ? undefined : { text: clipTask(text, 500) };
      }
      case 'turn/end': return { reason: data.reason };
      default: return undefined;
    }
  }

  clearIdleTimer(job) {
    if (job.idleTimer !== null && job.idleTimer !== undefined) {
      clearTimeout(job.idleTimer);
      job.idleTimer = null;
    }
  }

  scheduleIdleExpiry(job) {
    this.clearIdleTimer(job);
    const timer = setTimeout(() => {
      job.idleTimer = null;
      void this.expireIdle(job).catch((err) => {
        this.ctx.logger?.warn?.(`dsh-crew: idle expiry failed for ${job.id}: ${err?.message ?? err}`);
      });
    }, this.idleTtlMs(job));
    // Never hold the host process open just to expire an idle worker.
    timer.unref?.();
    job.idleTimer = timer;
  }

  settleWaiters(job) {
    for (const w of job.waiters.splice(0)) w();
  }

  /** cancel() and idle expiry both reject every unanswered question. */
  rejectPendingQuestions(job, code = 'CANCELLED') {
    const pending = job.pendingQuestions ?? [];
    job.pendingQuestions = [];
    job.questions = [];
    for (const q of pending) {
      const error = new Error(code === 'EXPIRED'
        ? 'the worker session expired while a question was still unanswered'
        : 'the worker job was cancelled while a question was still unanswered');
      error.name = 'UserQuestionError';
      error.code = code;
      try { q.reject?.(error); } catch { /* the asker may already be gone */ }
    }
    return pending.length;
  }

  /**
   * C02 seam: park one question on the job until POST /jobs/:id/answer (or a
   * cancel/timeout) settles it. T05 wires this to `user-questions/request`.
   */
  addPendingQuestion(job, { id, question, detail, options } = {}) {
    if (!LIVE_STATUSES.has(job.status)) {
      throw new JobStateError(job.status, `job ${job.id} is ${job.status}; cannot park a question`, []);
    }
    const questionId = typeof id === 'string' && id !== '' ? id : `q-${this.nextQuestionId++}`;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const entry = {
      id: questionId,
      questionId,
      question: String(question ?? ''),
      ...(detail === undefined ? {} : { detail }),
      ...(options === undefined ? {} : { options }),
      promise,
      resolve,
      reject,
      createdAt: new Date().toISOString(),
    };
    this.clearIdleTimer(job);
    job.pendingQuestions.push(entry);
    job.status = 'needs_input';
    job.questions = job.pendingQuestions.map((q) => ({
      id: q.questionId ?? q.id, question: q.question, ...(q.detail === undefined ? {} : { detail: q.detail }),
    }));
    this.recordEvent(job, 'question/pending', { questionId });
    this.publish();
    return entry;
  }

  /** Resolve parked questions; only valid while the job is `needs_input`. */
  answer(id, answers) {
    const job = this.jobs.get(id);
    if (!job) throw new JobNotFoundError(id);
    if (job.status !== 'needs_input' || (job.pendingQuestions ?? []).length === 0) {
      throw new JobStateError(job.status, `job ${id} is not waiting for an answer`, ['cancel']);
    }
    const normalized = normalizeAnswers(answers);
    // Validate every questionId against a working copy first: a bad id must
    // leave all questions pending instead of half-answering the batch.
    const remaining = job.pendingQuestions.slice();
    const picked = [];
    for (const item of normalized) {
      const index = item.questionId === undefined
        ? 0
        : remaining.findIndex((q) => (q.questionId ?? q.id) === item.questionId);
      if (index < 0) throw new JobRequestError(`unknown questionId: ${item.questionId}`);
      picked.push(remaining.splice(index, 1)[0]);
    }
    const answered = picked.map((entry, index) => {
      entry.resolve(normalized[index].answer);
      return entry.questionId ?? entry.id;
    });
    job.pendingQuestions = remaining;
    if (remaining.length === 0) {
      job.questions = [];
      job.status = 'running';
    }
    this.recordEvent(job, 'question/answered', { answered });
    this.settleWaiters(job);
    this.publish();
    return { job, answered };
  }

  /**
   * Decide what a message does without touching the agent (sync, so an HTTP
   * caller gets 400/409 before any work is scheduled).
   */
  planTurn(job, message, mode = 'auto') {
    if (typeof message !== 'string' || message.trim() === '') {
      throw new JobRequestError('message must be a non-empty string');
    }
    const text = message.trim();
    const wanted = normalizeMode(mode);
    const status = job.status;

    if (status === 'cancelled' || status === 'expired') {
      throw new JobStateError(status, `job ${job.id} is ${status}; start a new task instead`, []);
    }
    if (status === 'needs_input') {
      throw new JobStateError(status, `job ${job.id} is waiting for an answer; answer it before sending another message`, ['answer', 'cancel']);
    }
    const steerable = typeof job.handle?.agent?.steer === 'function';

    if (status === 'running' || status === 'queued') {
      // auto on a live turn means "steer it", the whole point of a steerable
      // agent; an explicit followup queues instead, and a host without steer
      // degrades to queueing rather than dropping the message.
      if (wanted === 'followup') {
        return { action: 'queue', message: text, note: 'queued behind the running turn' };
      }
      if (!steerable) {
        if (wanted === 'steer') {
          throw new JobStateError(status, 'this host cannot steer a running turn; wait for it to finish', ['followup']);
        }
        return {
          action: 'queue',
          message: text,
          note: 'steer is unavailable on this host; message queued for the next turn',
        };
      }
      return { action: 'steer', message: text };
    }

    if (status === 'idle' || status === 'done' || status === 'failed') {
      if (wanted === 'steer') {
        throw new JobStateError(status, 'cannot steer a job that has no running turn', ['followup']);
      }
      const needsResume = status !== 'idle' || job.handle === null || job.handle === undefined;
      if (needsResume && typeof this.ctx.agents?.resume !== 'function') {
        throw new JobStateError(status, 'this host cannot resume a finished session; start a new task instead', []);
      }
      return { action: needsResume ? 'resume' : 'followup', message: text };
    }

    throw new JobStateError(status, `job ${job.id} is ${status}`, []);
  }

  /** Start a message turn and return immediately with its completion promise. */
  message(id, message, mode = 'auto') {
    const job = this.jobs.get(id);
    if (!job) throw new JobNotFoundError(id);
    const plan = this.planTurn(job, message, mode);
    const completion = plan.action === 'steer' ? this.#steerTurn(job, plan) : this.#enqueueTurn(job, plan);
    // The HTTP route returns before a turn ends, so nothing else would observe
    // a background failure: keep it on the job instead of an unhandled rejection.
    completion.catch((err) => {
      job.error = job.error ?? (err?.message ?? String(err));
      if (plan.action !== 'steer' && !TERMINAL_STATUSES.has(job.status) && job.status !== 'needs_input') {
        job.status = 'failed';
      }
      this.recordEvent(job, 'turn/error', { message: clipTask(String(err?.message ?? err), 300) });
      this.publish();
    });
    return { job, action: plan.action, note: plan.note, completion };
  }

  /** Resolve when the turn started by this call has ended (tests, MCP waits). */
  runTurn(job, message, mode = 'auto') {
    const plan = this.planTurn(job, message, mode);
    return plan.action === 'steer' ? this.#steerTurn(job, plan) : this.#enqueueTurn(job, plan);
  }

  async #steerTurn(job, plan) {
    await job.handle.agent.steer(userMessage(plan.message));
    this.recordEvent(job, 'turn/steer', { text: clipTask(plan.message, 200) });
    this.publish();
    return job;
  }

  #enqueueTurn(job, plan) {
    // One turn at a time per job: a second message while a follow-up turn is
    // still running queues behind it rather than interleaving the agent.
    const prior = job.turnChain ?? Promise.resolve();
    const next = prior.then(() => this.#followupTurn(job, plan), () => this.#followupTurn(job, plan));
    job.turnChain = next.then(() => undefined, () => undefined);
    return next;
  }

  #agentSetup(job) {
    return async (agentCtx) => {
      installModelSelection(agentCtx, { current: job._selection, assembled: undefined });
      if (job._presets !== undefined) await job._presets.mount(agentCtx, job._presetId);
      // Claim this agent's requests ahead of the Web answerer. C02: `ask`
      // parks the question until /answer (default); `handoff` is the upstream
      // unattended behavior (#13). Policy comes from the stored config (T06's
      // config tool writes it); no public spawn API is involved.
      const cfg = this.getConfig?.() ?? {};
      installWorkerQuestionHandoff(agentCtx, job, () => this.publish(), {
        policy: job.question_policy ?? cfg.question_policy,
        timeoutSeconds: job.question_timeout_seconds ?? cfg.question_timeout_seconds,
        logger: this.ctx.logger,
      });
      agentCtx.on('session/event', (_session, event) => this.#onEvent(job, event));
      agentCtx.on('agent/error', (payload) => {
        const err = payload?.error;
        if (job.status !== 'needs_input') job.error = err?.message ?? String(err);
      });
    };
  }

  #onEvent(job, event) {
    this.recordEvent(job, event.type, this.summarizeEvent(event));
    switch (event.type) {
      case 'step/start': {
        // A resumed session numbers its own turns from 1 again; the hub view
        // must keep counting turns across the whole job, so never go backwards.
        const sessionTurn = Number(event.data?.turn);
        if (Number.isFinite(sessionTurn)) job.turn = Math.max(job.turn ?? 0, sessionTurn);
        job.step = event.data?.step ?? job.step;
        break;
      }
      case 'tool/call': job.currentTool = event.data?.name ?? null; job.toolCalls += 1; break;
      case 'tool/result': job.currentTool = null; break;
      case 'assistant/message': {
        const u = event.data?.usage;
        if (u) {
          job.tokens.input += u.inputTokens ?? 0;
          job.tokens.output += u.outputTokens ?? 0;
          job.tokens.reasoning += u.reasoningTokens ?? 0;
        }
        const text = (event.data?.message?.content ?? [])
          .filter((c) => c?.type === 'text').map((c) => c.text).join('');
        if (text) job.texts.push(text);
        break;
      }
      case 'turn/end':
        job.stopReason = event.data?.reason?.kind ?? null;
        job.reasonDetail = event.data?.reason;
        break;
    }
    this.publish();
  }

  async #followupTurn(job, plan) {
    // A queued turn may reach the front after the job was cancelled or expired;
    // it must not reopen a session somebody else already closed.
    if (job.status === 'cancelled' || job.status === 'expired') {
      throw new JobStateError(job.status, `job ${job.id} is ${job.status}; the queued turn was dropped`, []);
    }
    if (plan.action === 'resume') {
      const resume = this.ctx.agents?.resume;
      if (typeof resume !== 'function') {
        throw new JobStateError(job.status, 'this host cannot resume a finished session; start a new task instead', []);
      }
      // The old runtime owns the same session id; dispose it before a resumed
      // runtime attaches to that session, so two loops never write one log.
      if (job.handle) {
        try { await job.handle.dispose?.(); } catch { /* already gone */ }
        job.handle = null;
      }
      job.handle = await resume.call(this.ctx.agents, { resumeSessionId: job.sessionId, setup: this.#agentSetup(job) });
      job.capabilities = this.detectCapabilities(job);
      // cancel()/expire ran while resume() was in flight: nobody holds the new
      // runtime yet, so close it here instead of leaking a live session.
      if (job.status === 'cancelled' || job.status === 'expired') {
        try { await job.handle?.dispose?.(); } catch { /* already gone */ }
        job.handle = null;
        throw new JobStateError(job.status, `job ${job.id} is ${job.status}; the resume was superseded`, []);
      }
      this.recordEvent(job, 'session/resumed', { sessionId: job.sessionId });
    }

    const handle = job.handle;
    if (!handle?.agent) throw new JobStateError(job.status, 'job has no live agent session', []);

    this.clearIdleTimer(job);
    job.status = 'running';
    job.error = null;
    job.stopReason = null;
    job.reasonDetail = null;

    const turn = {
      index: job.turns.length + 1,
      prompt: clipTask(plan.message, 500),
      startedAt: new Date().toISOString(),
      endedAt: null,
      stopReason: null,
      usage: { input: 0, output: 0, reasoning: 0 },
      textPreview: '',
    };
    job.turns.push(turn);
    job.currentTurn = turn;
    job.turn = turn.index;
    const usageStart = { ...job.tokens };
    const textStart = job.texts.length;
    this.recordEvent(job, 'turn/start', {
      turn: turn.index,
      ...(plan.action === 'queue' ? { queued: true } : {}),
      ...(plan.action === 'resume' ? { resumed: true } : {}),
    });
    this.publish();

    let failure = null;
    try {
      await handle.agent.whenIdle();
      await handle.agent.followup(userMessage(plan.message));
      await handle.agent.whenIdle();
    } catch (err) {
      failure = err;
      job.error = job.error ?? (err?.message ?? String(err));
    }

    turn.endedAt = new Date().toISOString();
    turn.stopReason = job.stopReason ?? (failure === null ? null : 'error');
    turn.usage = {
      input: (job.tokens.input ?? 0) - (usageStart.input ?? 0),
      output: (job.tokens.output ?? 0) - (usageStart.output ?? 0),
      reasoning: (job.tokens.reasoning ?? 0) - (usageStart.reasoning ?? 0),
    };
    const turnTexts = job.texts.slice(textStart);
    turn.textPreview = clipTask(turnTexts.at(-1) ?? '', 200);
    job.currentTurn = null;

    // C03 visibility: flush after every turn, not only when the job dies, and
    // before the job is exposed as idle/failed. A poller that observes the new
    // status must not read a session file that is still missing this turn.
    if (typeof this.ctx.sessions?.flush === 'function' && handle.agent.session !== undefined) {
      try { await this.ctx.sessions.flush(handle.agent.session); }
      catch (err) { this.ctx.logger?.warn?.(`dsh-crew: session flush failed: ${err?.message ?? err}`); }
    }

    // A cancel/expire or a parked question wins over the turn outcome: the
    // state machine must not resurrect a session somebody else closed.
    if (!TERMINAL_STATUSES.has(job.status) && job.status !== 'needs_input') {
      const lastText = turnTexts.at(-1);
      if (typeof lastText === 'string' && lastText !== '') job.result = lastText;
      else if (job.result === null || job.result === undefined) job.result = '';
      if (turn.stopReason === 'completed' && failure === null) {
        job.status = 'idle';
        this.scheduleIdleExpiry(job);
      } else {
        job.status = 'failed';
        if (!job.error) job.error = `turn ended: ${turn.stopReason ?? 'unknown'}`;
      }
    }

    this.recordEvent(job, 'turn/settled', { turn: turn.index, stopReason: turn.stopReason, status: job.status });
    this.settleWaiters(job);
    this.publish();
    return job;
  }

  async spawn({ task, tier = 'flash', effort = 'max', cwd, source = 'api', provider, model, preset, question_policy, question_timeout_seconds, idle_ttl_seconds }) {
    if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}"`);
    // An explicit {provider, model} from the caller wins (the MCP process owns
    // session-level overrides, exactly as it does for presets); otherwise the
    // hub's own stored config decides, and failing that the tier default.
    const bound = resolveTierBinding(tier, this.getConfig?.() ?? {});
    const resolvedProvider = typeof provider === 'string' && provider.trim() !== '' ? provider.trim() : bound.provider;
    const resolvedModel = typeof model === 'string' && model.trim() !== '' ? model.trim() : bound.model;
    if (!['off', 'high', 'max'].includes(effort)) throw new Error(`unknown effort "${effort}"`);
    // Accept POSIX, Windows drive (D:\x, C:/x) and UNC (\\srv\share) roots.
    if (!isAbsoluteCwd(cwd)) throw new Error('cwd must be an absolute path');
    // One canonical form for the job, the advisory lock and the workspace
    // lookup: D:/x and D:\x must map to the same workspace on Windows.
    const cwdPath = canonicalCwd(cwd);
    await this.ctx.get('loader')?.await();

    const id = `hub-${this.nextId++}-${Date.now().toString(36)}`;
    const sessionId = `session-${randomUUID()}`;
    const job = {
      id, sessionId, tier, model: resolvedModel, provider: resolvedProvider, effort, task, source, cwd: cwdPath,
      status: 'running', turn: 0, step: 0, currentTool: null, toolCalls: 0,
      tokens: { input: 0, output: 0, reasoning: 0 },
      startedAt: new Date().toISOString(), endedAt: null,
      result: null, error: null, stopReason: null, handle: null, waiters: [],
      texts: [],
      // T03 multi-turn state: one record per follow-up turn, a ring buffer of
      // session events for since-cursor readers, and parked questions.
      turns: [], currentTurn: null, turnChain: null,
      pendingQuestions: [], questions: undefined, events: [], nextSeq: 1, lastEventAt: null,
      idleTimer: null,
      // T06: optional per-dispatch policy overrides (undefined = hub config).
      question_policy, question_timeout_seconds, idle_ttl_seconds,
      capabilities: {
        resume: typeof this.ctx.agents?.resume === 'function',
        steer: false,
        flush: typeof this.ctx.sessions?.flush === 'function',
      },
    };
    this.jobs.set(id, job);

    const selection = { provider: resolvedProvider, model: resolvedModel, reasoningEffort: effort };
    const presets = this.ctx.get('agentPresets');
    const cfg = this.getConfig?.() ?? {};
    const wanted = preset ?? (tier === 'flash' ? cfg.preset_flash : cfg.preset_pro);
    const presetId = presets === undefined
      ? undefined
      : (await presets.resolve(!wanted || wanted === 'default' ? undefined : wanted)).id;

    job._selection = selection;
    job._presets = presets;
    job._presetId = presetId;
    const setup = this.#agentSetup(job);

    const run = async () => {
      const handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: cwdPath, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup,
      });
      job.handle = handle;
      job.capabilities = this.detectCapabilities(job);
      // Cancelled (or answered by another path) while agents.create() was in
      // flight: drop the fresh runtime instead of starting a turn nobody wants.
      if (job.status === 'needs_input' || TERMINAL_STATUSES.has(job.status)) { await handle.dispose(); return; }
      try {
        // Group the worker session under the workspace of its cwd; create the
        // workspace when none exists yet (resolveByPath is exact-match, so a
        // job cwd never inherits a parent directory's workspace).
        const registry = this.ctx.get('workspaceRegistry');
        if (registry !== undefined) {
          const ws = (await registry.resolveByPath(cwdPath)) ?? (await registry.create(cwdPath));
          await ws.attachSession(sessionId);
        }
      } catch (err) {
        this.ctx.logger?.warn?.(`dsh-crew: workspace attach failed for ${cwdPath}: ${err?.message ?? err}`);
      }
      await this.#enqueueTurn(job, { action: 'followup', message: task });
    };

    job.promise = run()
      .catch((err) => {
        if (job.status === 'running') job.status = 'failed';
        job.error = job.error ?? (err?.message ?? String(err));
      })
      .finally(() => {
        job.endedAt = new Date().toISOString();
        job.currentTool = null;
        this.publish();
        this.settleWaiters(job);
      });

    this.publish();
    return job;
  }

  async wait(id, timeoutMs) {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (!ACTIVE_STATUSES.has(job.status)) return job;
    await Promise.race([
      new Promise((res) => job.waiters.push(res)),
      timeoutMs > 0 ? new Promise((res) => setTimeout(res, timeoutMs)) : Promise.resolve(),
    ]);
    return job;
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (LIVE_STATUSES.has(job.status)) {
      job.status = 'cancelled';
      job.error = 'cancelled by request';
      job.endedAt = new Date().toISOString();
      this.clearIdleTimer(job);
      const rejected = this.rejectPendingQuestions(job, 'CANCELLED');
      try { await job.handle?.dispose(); } catch { /* dispose is best-effort */ }
      this.recordEvent(job, 'job/cancelled', { rejectedQuestions: rejected });
      this.settleWaiters(job);
      this.publish();
    }
    return job;
  }

  /** T03 idle TTL: close the runtime and park the job as expired. */
  async expireIdle(job) {
    if (job.status !== 'idle') return job;
    job.status = 'expired';
    job.endedAt = new Date().toISOString();
    job.error = job.error ?? 'idle session expired';
    this.clearIdleTimer(job);
    const rejected = this.rejectPendingQuestions(job, 'EXPIRED');
    const handle = job.handle;
    job.handle = null;
    try { await handle?.dispose?.(); } catch { /* already gone */ }
    this.recordEvent(job, 'job/expired', { reason: 'idle_ttl', rejectedQuestions: rejected });
    this.settleWaiters(job);
    this.publish();
    return job;
  }

  async dispose() {
    for (const job of this.jobs.values()) {
      this.clearIdleTimer(job);
      if (LIVE_STATUSES.has(job.status)) { try { await job.handle?.dispose(); } catch {} }
    }
  }
}

// ---------- loopback route helpers (pattern from dsh-noema) ----------

function isIpv4Loopback(a) { return /^127(\.\d{1,3}){3}$/.test(a); }
function isLoopbackAddress(address) {
  if (!address) return false;
  const n = address.toLowerCase().split('%', 1)[0];
  if (n === '::1' || isIpv4Loopback(n)) return true;
  if (!n.startsWith('::ffff:')) return false;
  return isIpv4Loopback(n.slice(7));
}
function isLoopbackRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  let host = String(req.headers.host ?? '').toLowerCase();
  const bracket = host.startsWith('[') ? host.indexOf(']') : -1;
  host = bracket > 0 ? host.slice(1, bracket) : host.split(':')[0];
  return host === 'localhost' || isLoopbackAddress(host);
}
function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    ...headers,
  });
  res.end(body);
}
/**
 * The panel is the authority on the active locale (DSH's setting may be unset,
 * leaving it to the browser), so it tags requests with ?lang= / body.lang and
 * the hub adopts it. Conversation-side paths with no request behind them —
 * pasted-image transcription — then follow the same language.
 */
function adoptLang(value) {
  if (value === 'zh' || value === 'en') setLang(value);
}

/**
 * `?wait` as a non-negative integer second count. Absent/empty means 0;
 * anything non-numeric, fractional or negative is null (HTTP 400) — a
 * garbage wait must be an error, never a silent no-wait (PATTERN-AUDIT D2:
 * `?wait=abc` used to return immediately with 200 OK because
 * Math.min(NaN, 600) is NaN and the wait promise resolved instantly).
 */
export function parseWaitSeconds(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (!/^\d+$/.test(String(value))) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

async function readBody(req, limit = 64 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('payload too large');
  }
  return body.trim() === '' ? {} : JSON.parse(body);
}

/**
 * `?since` as a non-negative integer cursor. Absent/empty means 0; anything
 * non-integer is null so the route can answer 400 instead of silently
 * replaying the whole buffer (a bad cursor must never look like "no events").
 */
function parseSince(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (!/^\d+$/.test(String(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * HTTP surface for the hub's job registry (C01/C03/T04).
 *
 * Exported and hub-parameterised so the routes can be driven by tests without
 * booting a plugin context; `apply()` registers this as the /jobs handler.
 * Every failure maps to the documented status: 400 malformed input, 404
 * unknown job, 409 state transition not allowed (with `status` and `allowed`
 * so a polling UI can render the valid next action instead of prose).
 */
export function createJobsHandler(hub) {
  return async (req, res) => {
    if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return sendJson(res, 400, { ok: false, error: 'bad request url' }); }
    const parts = url.pathname.slice(`${ROUTE_BASE}/jobs`.length).split('/').filter(Boolean);

    try {
      if (req.method === 'GET' && parts.length === 0) {
        // Machine-wide view: this hub's live jobs plus fresh shards from
        // other writers (standalone MCP sessions, other hub instances).
        const own = [...hub.jobs.values()].map((j) => ({ ...hub.view(j), origin: hub.shard.writer }));
        let foreign = [];
        try { foreign = readMergedStatus({ excludeWriter: hub.shard.writer }); }
        catch { foreign = []; }
        return sendJson(res, 200, { ok: true, jobs: [...own, ...foreign] });
      }

      if (req.method === 'GET' && parts.length === 1) {
        const wait = parseWaitSeconds(url.searchParams.get('wait'));
        if (wait === null) return sendJson(res, 400, { ok: false, error: 'wait must be a non-negative integer number of seconds' });
        const job = await hub.wait(parts[0], Math.min(wait, 600) * 1000);
        if (!job) return sendJson(res, 404, { ok: false, error: 'no such job' });
        return sendJson(res, 200, { ok: true, job: hub.view(job, true) });
      }

      if (req.method === 'GET' && parts.length === 2 && parts[1] === 'events') {
        const job = hub.jobs.get(parts[0]);
        if (!job) return sendJson(res, 404, { ok: false, error: 'no such job' });
        const since = parseSince(url.searchParams.get('since'));
        if (since === null) return sendJson(res, 400, { ok: false, error: 'since must be a non-negative integer' });
        const events = job.events.filter((e) => e.seq > since);
        const latest = job.events.at(-1)?.seq ?? 0;
        return sendJson(res, 200, {
          ok: true, events, next: events.at(-1)?.seq ?? since, latest, status: job.status,
        });
      }

      if (req.method === 'POST' && parts.length === 0) {
        const payload = await readBody(req);
        const job = await hub.spawn(payload);
        return sendJson(res, 200, { ok: true, job: hub.view(job) });
      }

      if (req.method === 'POST' && parts.length === 2) {
        const job = hub.jobs.get(parts[0]);
        if (!job) return sendJson(res, 404, { ok: false, error: 'no such job' });
        if (parts[1] === 'cancel') {
          const cancelled = await hub.cancel(job.id);
          return sendJson(res, 200, { ok: true, job: hub.view(cancelled, true) });
        }
        if (parts[1] === 'message') {
          const body = await readBody(req);
          const started = hub.message(job.id, body?.message, body?.mode);
          return sendJson(res, 200, {
            ok: true, action: started.action,
            ...(started.note === undefined ? {} : { note: started.note }),
            job: hub.view(started.job),
          });
        }
        if (parts[1] === 'answer') {
          const body = await readBody(req);
          const answered = hub.answer(job.id, body?.answers);
          return sendJson(res, 200, { ok: true, answered: answered.answered, job: hub.view(answered.job) });
        }
        return sendJson(res, 404, { ok: false, error: 'unknown jobs endpoint' });
      }

      return sendJson(res, 404, { ok: false, error: 'unknown jobs endpoint' });
    } catch (err) {
      if (err instanceof JobNotFoundError) return sendJson(res, 404, { ok: false, error: err.message });
      if (err instanceof JobStateError) {
        return sendJson(res, 409, { ok: false, error: err.message, status: err.jobStatus, allowed: err.allowed });
      }
      if (err instanceof JobRequestError) return sendJson(res, 400, { ok: false, error: err.message });
      if (err instanceof SyntaxError) return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return sendJson(res, 400, { ok: false, error: err?.message ?? String(err) });
    }
  };
}

// ---------- plugin entry ----------

export async function apply(ctx) {
  seedLangFromHost(ctx);
  const hub = new WorkerRegistry(ctx);
  try {
    const { readGlobalConfig } = await import('../install/install.mjs');
    hub.getConfig = () => readGlobalConfig();
  } catch {}
  const disposers = [];

  // Multimodal bridge: register describe_image / generate_image for the DS
  // model. Config is read per call so settings-page edits apply live.
  try {
    const { createMultimodalTools } = await import('../multimodal.mjs');
    const { readGlobalConfig } = await import('../install/install.mjs');
    for (const tool of createMultimodalTools(() => readGlobalConfig())) {
      disposers.push(ctx.effect(() => ctx.tools.register(tool), `dsh-crew: ${tool.name} tool`));
    }
  } catch (err) {
    ctx.logger?.warn?.(`dsh-crew: multimodal tools unavailable: ${err?.message ?? err}`);
  }

  // Vision route: image paste on the text-only DS models (admission adapter +
  // pre-step transcription).
  try {
    const { installVisionRoute } = await import('../vision-route.mjs');
    const { readGlobalConfig } = await import('../install/install.mjs');
    disposers.push(installVisionRoute(ctx, () => readGlobalConfig()));
  } catch (err) {
    ctx.logger?.warn?.(`dsh-crew: vision route unavailable: ${err?.message ?? err}`);
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer;
    const disposers = [];

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/worker-probe`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' });
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'application/json required' });
        try {
          const body = await readBody(req);
          if (typeof body.provider !== 'string' || body.provider.trim() === '' || typeof body.model !== 'string' || body.model.trim() === '') return sendJson(res, 400, { ok: false, error: 'provider and model required' });
          const result = await probeProvider(ctx.llm, { provider: body.provider.trim(), model: body.model.trim() });
          return sendJson(res, 200, { ok: true, result });
        } catch { return sendJson(res, 400, { ok: false, error: 'invalid probe request' }); }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/ping`,
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        return sendJson(res, 200, { ok: true, service: 'dsh-crew-hub' });
      },
    }));

    // WPC14: liveness probe for a ghost job's recorded pid. The panel probes
    // orphaned tombstones that carry a pid so it can offer the "process still
    // alive" badge and a kill button; same process.kill(pid, 0) probe the
    // status shard uses for writer liveness (status-shard.mjs writerProcessAlive).
    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/proc-alive`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' }, { allow: 'GET' });
        try {
          const url = new URL(req.url, 'http://localhost');
          const pid = parsePid(url.searchParams.get('pid'));
          if (pid === null) return sendJson(res, 400, { ok: false, error: 'pid must be a positive integer' });
          return sendJson(res, 200, { ok: true, alive: procAlive(pid) });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    // WPC14: verified kill of a ghost job's recorded pid. The pid may have
    // been recycled since the job died, so the command line is read (ps) and
    // must match a process shape this plugin spawns (DSH runtime / agy /
    // grok) before anything is signalled; then SIGTERM (whole group when a
    // pgid is given) and SIGKILL after a ~3s grace. Refusals are readable,
    // in the origin-guard style.
    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/proc-kill`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' });
        try {
          const body = await readBody(req);
          adoptLang(body?.lang);
          const pid = parsePid(body?.pid);
          if (pid === null) return sendJson(res, 400, { ok: false, error: 'pid must be a positive integer' });
          let pgid = null;
          if (body.pgid !== undefined && body.pgid !== null) {
            pgid = parsePid(body.pgid);
            if (pgid === null) return sendJson(res, 400, { ok: false, error: 'pgid must be a positive integer' });
          }
          const result = await killWorkerProcess({ pid, pgid });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          if (err instanceof ProcKillRefused) {
            return sendJson(res, 403, { ok: false, error: err.message, code: err.code, pid: err.pid ?? null, command: err.command ?? null });
          }
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'prefix', path: `${ROUTE_BASE}/jobs`,
      handler: createJobsHandler(hub),
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/config`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const { readGlobalConfig, writeGlobalConfig } = await import(`../install/install.mjs?t=${Date.now()}`);
          if (req.method === 'GET') {
            adoptLang(new URL(req.url, 'http://localhost').searchParams.get('lang'));
            return sendJson(res, 200, { ok: true, config: readGlobalConfig() });
          }
          if (req.method === 'POST') return sendJson(res, 200, { ok: true, config: writeGlobalConfig(await readBody(req)) });
          return sendJson(res, 405, { ok: false, error: 'GET or POST' }, { allow: 'GET, POST' });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/presets`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const presets = ctx.get('agentPresets');
          if (presets === undefined) return sendJson(res, 200, { ok: true, presets: [] });
          const list = await presets.list();
          return sendJson(res, 200, {
            ok: true,
            defaultId: presets.defaultId,
            presets: list.map((p) => ({ id: p.id, name: p.name ?? p.id, trust: p.trust })),
          });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    // The MCP server runs as its own process and cannot reach ctx.llm, so the
    // routes the HOST has configured are published here. This is the whole
    // point of issue #10: a local model is configured once in DSH, and the
    // worker config names it instead of redefining it.
    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/providers`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const { readGlobalConfig } = await import('../install/install.mjs');
          const providers = ctx.llm.listProviders().map((p) => ({ id: p.id, name: p.name ?? p.id }));
          return sendJson(res, 200, {
            ok: true,
            providers,
            bindings: describeBindings(readGlobalConfig()),
          });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/vision-models`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const url = new URL(req.url, 'http://localhost');
          const provider = url.searchParams.get('provider');
          const force = url.searchParams.get('refresh') === '1';
          const lang = url.searchParams.get('lang');
          adoptLang(lang);
          const { listVisionModels } = await import('../multimodal.mjs');
          const { readGlobalConfig } = await import('../install/install.mjs');
          return sendJson(res, 200, { ok: true, models: await listVisionModels(provider, force, () => readGlobalConfig(), lang) });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/provider-test`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        try {
          // The entry comes from the panel form so unsaved edits can be probed.
          const entry = await readBody(req);
          adoptLang(entry?.lang);
          const { testProvider } = await import('../multimodal.mjs');
          const result = await testProvider(entry, entry?.lang);
          return sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/install/status`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const { installStatus } = await import(`../install/install.mjs?t=${Date.now()}`);
          return sendJson(res, 200, { ok: true, status: installStatus() });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/install`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' });
        try {
          const { target, statusline } = await readBody(req);
          // Cache-busted import: the installer must always run the code
          // currently on disk, not whatever this process first loaded —
          // a stale cached copy once re-broke user settings after a fix.
          const {
            installClaudeCode, installCodex, installHudSegment, uninstallClaudeCode, uninstallCodex,
            installAgy, installGrok, uninstallAgy, uninstallGrok,
          } = await import(`../install/install.mjs?t=${Date.now()}`);
          if (target === 'claude') {
            const base = await installClaudeCode({ statusline: !!statusline });
            const hud = installHudSegment({});
            return sendJson(res, 200, {
              ok: base.ok,
              actions: [...base.actions, ...hud.actions.map((a) => `hud: ${a}`)],
            });
          }
          if (target === 'codex') return sendJson(res, 200, installCodex({}));
          if (target === 'agy') return sendJson(res, 200, installAgy({}));
          if (target === 'grok') return sendJson(res, 200, installGrok({}));
          if (target === 'claude-uninstall') return sendJson(res, 200, await uninstallClaudeCode({}));
          if (target === 'codex-uninstall') return sendJson(res, 200, uninstallCodex({}));
          if (target === 'agy-uninstall') return sendJson(res, 200, uninstallAgy({}));
          if (target === 'grok-uninstall') return sendJson(res, 200, uninstallGrok({}));
          return sendJson(res, 400, { ok: false, error: 'target must be claude | codex | agy | grok | claude-uninstall | codex-uninstall | agy-uninstall | grok-uninstall' });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    return () => { for (const d of disposers.reverse()) d(); };
  });

  ctx.logger?.info?.('dsh-crew hub mounted (jobs API + installer endpoints + multimodal tools)');
  return async () => {
    for (const d of disposers.reverse()) { try { d(); } catch {} }
    await hub.dispose();
  };
}
