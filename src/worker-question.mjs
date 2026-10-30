// How a hub worker's `user-questions/request` is settled.
//
// Upstream stopped the runtime on every question: nobody attends a worker
// session, so waiting would block forever (#13). That is still the `handoff`
// policy. The multiturn fork defaults to `ask`: park the request on the job,
// publish `needs_input`, and let POST /jobs/:id/answer resolve it so the
// worker continues in the same turn. A parked question is never an answer:
// only the /answer route (or a timeout) may settle it.

import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_SECONDS = 900;
const MAX_QUESTIONS = 16;

/** Same bounded shape upstream put on `job.questions`. */
function normalizeQuestions(request) {
  return Array.isArray(request?.questions)
    ? request.questions.slice(0, MAX_QUESTIONS).map((q) => ({
      id: String(q.id ?? '').slice(0, 200),
      question: String(q.question ?? '').slice(0, 4000),
      ...(typeof q.detail === 'string' ? { detail: q.detail.slice(0, 12000) } : {}),
      ...(Array.isArray(q.options)
        ? { options: q.options.slice(0, 32).map((o) => ({ label: String(o.label ?? '').slice(0, 500) })) }
        : {}),
    }))
    : [];
}

function questionPolicy(opts, job) {
  const value = opts?.question_policy ?? opts?.policy ?? opts?.questionPolicy
    ?? job?.question_policy ?? 'ask';
  // An unknown policy must never grant anything or stop a session silently:
  // `ask` is the documented default and the conservative choice.
  return value === 'handoff' ? 'handoff' : 'ask';
}

function questionTimeoutSeconds(opts, job) {
  const value = opts?.question_timeout_seconds ?? opts?.timeoutSeconds
    ?? opts?.questionTimeoutSeconds ?? job?.question_timeout_seconds;
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_SECONDS;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_TIMEOUT_SECONDS;
}

function logQuestionCount(opts, count, policy) {
  // Only the number of questions is logged — never the text: a worker may ask
  // about secrets or private data, and hub logs are readable by the panel.
  const message = `dsh-crew: worker question request (${count} question(s), policy=${policy})`;
  try {
    if (typeof opts?.log === 'function') opts.log(message);
    else if (typeof opts?.logger?.info === 'function') opts.logger.info(message);
    else if (typeof opts?.logger?.debug === 'function') opts.logger.debug(message);
  } catch { /* logging must never break the handshake */ }
}

/** One question item as the DSH answerer expects it. */
function answerItem(question, raw) {
  const item = { id: String(question?.id ?? ''), selected: [] };
  const normalizeSelected = (value) => {
    if (Array.isArray(value)) return value.map((v) => String(v));
    if (value === undefined || value === null) return [];
    return [String(value)];
  };
  if (raw === undefined || raw === null) return item;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const selected = raw.selected !== undefined ? raw.selected : (raw.answer ?? raw.value);
    item.selected = normalizeSelected(selected);
    if (typeof raw.custom === 'string' && raw.custom !== '') item.custom = raw.custom;
    return item;
  }
  item.selected = normalizeSelected(raw);
  return item;
}

/**
 * Turn whatever /answer stored into `AskUserQuestionAnswer` for the original
 * request: `{ answers: [{ id, selected, custom? }] }`, in request order.
 * Accepts a plain string, an array of strings/objects, an object keyed by
 * question id, a single `{selected, custom}` object, or an already-shaped
 * `{answers: [...]}`.
 */
function buildAnswer(questions, raw) {
  const answers = questions.map((q) => answerItem(q, undefined));
  const byId = new Map();
  answers.forEach((answer, index) => {
    if (!byId.has(answer.id)) byId.set(answer.id, index);
  });
  const assignAt = (index, value) => {
    if (index >= 0 && index < answers.length) answers[index] = answerItem(questions[index], value);
  };
  let payload = raw;
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray(payload.answers)) {
    payload = payload.answers;
  }
  if (Array.isArray(payload)) {
    payload.forEach((entry, index) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const idValue = entry.questionId ?? entry.id;
        if (idValue !== undefined && byId.has(String(idValue))) {
          assignAt(byId.get(String(idValue)), entry);
          return;
        }
      }
      assignAt(index, entry);
    });
    return { answers };
  }
  if (payload && typeof payload === 'object') {
    const keys = Object.keys(payload);
    const keyed = keys.filter((key) => byId.has(key));
    if (keyed.length > 0) {
      for (const key of keyed) assignAt(byId.get(key), payload[key]);
      return { answers };
    }
    assignAt(0, payload);
    return { answers };
  }
  assignAt(0, payload);
  return { answers };
}

function removePending(job, entry) {
  const list = Array.isArray(job.pendingQuestions) ? job.pendingQuestions : [];
  const index = list.indexOf(entry);
  if (index >= 0) list.splice(index, 1);
  job.pendingQuestions = list;
  job.questions = list.map((q) => ({
    id: q.questionId ?? q.id,
    question: q.question,
    ...(q.detail === undefined ? {} : { detail: q.detail }),
  }));
}

function publishOf(publish) {
  return typeof publish === 'function' ? publish : () => {};
}

function questionTimeoutError(seconds) {
  const error = new Error(`the worker question timed out after ${seconds}s without an answer; the worker session was stopped`);
  error.name = 'UserQuestionError';
  error.code = 'QUESTION_TIMEOUT';
  return error;
}

/**
 * Wire one worker agent's pending questions.
 *
 * `opts.question_policy` / `opts.policy`: `ask` (default) parks the request on
 * `job.pendingQuestions` and resolves it from /answer; `handoff` preserves the
 * upstream stop-and-return behavior.
 * `opts.question_timeout_seconds` / `opts.timeoutSeconds`: ask timeout,
 * default 900.
 */
export function installWorkerQuestionHandoff(agentCtx, job, publish, opts = {}) {
  const notify = publishOf(publish);
  const policy = questionPolicy(opts, job);
  const timeoutSeconds = questionTimeoutSeconds(opts, job);

  agentCtx.on('user-questions/request', (request) => {
    const questions = normalizeQuestions(request);
    logQuestionCount(opts, questions.length, policy);

    if (policy === 'handoff') {
      // Upstream behavior, wording unchanged: an unanswered question is not
      // permission, so the runtime is disposed and the request rejected.
      job.status = 'needs_input';
      job.questions = questions;
      job.result = JSON.stringify({
        needs_input: true,
        questions,
        instruction: 'Obtain the required answer or approval from the user, then dispatch a new task with that answer. An unanswered question grants no permission.',
      });
      job.error = 'Worker stopped for an unresolved question; no option was selected automatically.';
      notify();
      // Dispose the runtime, not merely tell the model to stop: it must not run
      // another step after an unanswered overwrite/permission question.
      try { Promise.resolve(job.handle?.dispose()).catch(() => {}); } catch {}
      const error = new Error(job.error + ' Return the unresolved question to the orchestrator.');
      error.name = 'UserQuestionError'; error.code = 'UNATTENDED_WORKER';
      return Promise.reject(error);
    }

    // ask: park the request, never dispose. The tool call that raised it stays
    // suspended until /answer resolves this promise, so the worker continues
    // in the same turn once the orchestrator replies.
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const questionId = `q-${randomUUID()}`;
    const entry = {
      id: questionId,
      questionId,
      question: questions.length <= 1
        ? (questions[0]?.question ?? '')
        : questions.map((q) => q.question).join('\n'),
      ...(questions[0]?.detail === undefined ? {} : { detail: questions[0].detail }),
      ...(questions[0]?.options === undefined ? {} : { options: questions[0].options }),
      questions,
      promise,
      resolve: undefined,
      reject: undefined,
      createdAt: new Date().toISOString(),
      settled: false,
      timer: null,
    };
    const settle = (fn) => (value) => {
      if (entry.settled) return;
      entry.settled = true;
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      removePending(job, entry);
      if ((job.pendingQuestions ?? []).length === 0 && job.status === 'needs_input') {
        // The answered request hands control back to the same running turn.
        job.status = 'running';
      }
      fn(value);
      notify();
    };
    entry.resolve = settle(resolvePromise);
    entry.reject = settle(rejectPromise);

    if (!Array.isArray(job.pendingQuestions)) job.pendingQuestions = [];
    // A parked question owns the session's liveness: the idle sweep must not
    // dispose the worker while the orchestrator still has time to answer.
    if (job.idleTimer !== null && job.idleTimer !== undefined) {
      clearTimeout(job.idleTimer);
      job.idleTimer = null;
    }
    job.pendingQuestions.push(entry);
    job.status = 'needs_input';
    job.questions = job.pendingQuestions.map((q) => ({
      id: q.questionId ?? q.id,
      question: q.question,
      ...(q.detail === undefined ? {} : { detail: q.detail }),
    }));
    notify();

    const timeoutMs = Math.round(timeoutSeconds * 1000);
    entry.timer = setTimeout(() => {
      if (entry.settled) return;
      job.status = 'failed';
      job.error = `worker question timed out after ${timeoutSeconds}s; no answer was given`;
      job.endedAt = new Date().toISOString();
      entry.reject(questionTimeoutError(timeoutSeconds));
      // A timed-out answer never grants permission: stop the runtime so the
      // worker cannot continue as if it had been answered.
      try { Promise.resolve(job.handle?.dispose()).catch(() => {}); } catch {}
      notify();
    }, timeoutMs);

    return entry.promise.then((answer) => buildAnswer(questions, answer));
  }, true);
}
