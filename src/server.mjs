// MCP stdio server exposing the DSH worker pool to Claude Code / Codex.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startJob, waitJob, cancelJob, listJobs, getJob, jobView } from './jobs.mjs';
import { hubAvailable, hub } from './hub-client.mjs';
import { startCliJob } from './cli-workers.mjs';
import { listProfiles, resolveProfile } from './worker-profiles.mjs';
import { readInheritedOrigin, extendOrigin, DEFAULT_ORIGIN_DEPTH_LIMIT } from './origin-guard.mjs';
import { acquireCwdLock, releaseCwdLockByJobId, updateCwdLockHolder, getCwdLocks, CwdLockError } from './cwd-lock.mjs';
import { resolveWorkerCwd } from './paths.mjs';
import { detectOrchestrator } from './process-info.mjs';
import { pathToFileURL } from 'node:url';
import { readGlobalConfig } from './install/install.mjs';
import { describeBindings, resolveTierBinding } from './tier-binding.mjs';

export function createServer({ hub: injectedHub = hub, hubAvailable: hubReady = hubAvailable, toolsProfile } = {}) {
const hub = injectedHub;
const server = new McpServer({ name: 'dsh-crew', version: '1.0.0' });

const tierSchema = z.enum(['flash', 'pro']).optional().describe('flash: small scoped tasks; pro: multi-file or design work.');
const effortSchema = z.enum(['off', 'high', 'max']).optional().describe('Reasoning effort; omit for the session default.');
const workerSchema = z.string().optional().describe('External CLI profile (agy/grok); opt-in only. Bypasses tier and mode.');
const allowConcurrentCwdSchema = z.boolean().optional().describe('Allow a second writer on the same cwd; read-only tasks only.');

// Session-level configuration. This MCP server process lives exactly as long
// as one Claude Code / Codex session, so plain memory IS session scope.
// Initial values come from the global config (~/.config/dsh-crew/config.json,
// edited on the DSH settings page); dsh_worker_config overrides per session.
const globalDefaults = readGlobalConfig();
const sessionConfig = {
  enabled: true,
  default_tier: globalDefaults.default_tier,
  default_effort: globalDefaults.default_effort,
  mode: globalDefaults.mode, // auto | hub | standalone
  default_timeout_seconds: globalDefaults.default_timeout_seconds,
  tier_policy: globalDefaults.tier_policy, // auto | flash-only | pro-only
  escalate_on_failure: globalDefaults.escalate_on_failure,
  preset_flash: globalDefaults.preset_flash ?? 'default',
  preset_pro: globalDefaults.preset_pro ?? 'default',
  // Tier -> LLM route. A provider id names a route the HOST already has
  // configured; blank means the tier's built-in DeepSeek default (#10).
  flash_provider: globalDefaults.flash_provider ?? '',
  flash_model: globalDefaults.flash_model ?? '',
  pro_provider: globalDefaults.pro_provider ?? '',
  pro_model: globalDefaults.pro_model ?? '',
  // WPC9: max worker→worker nesting depth before a dispatch is refused.
  origin_depth_limit: DEFAULT_ORIGIN_DEPTH_LIMIT,
  // C02: ask = park a worker's user-question and keep the turn alive until
  // dsh_worker_message (or the timeout) answers it; handoff = the legacy
  // behaviour where the question is returned as an unattended failure.
  question_policy: globalDefaults.question_policy ?? 'ask',
  idle_ttl_seconds: globalDefaults.idle_ttl_seconds ?? 1800,
  question_timeout_seconds: globalDefaults.question_timeout_seconds ?? 900,
  // C05/T06: every worker lands in this workspace; the hub pins the cwd.
  workspace_root: globalDefaults.workspace_root ?? '',
  // C06/T07: core exposes 5 tools, full exposes all 9. Env wins so a single
  // Codex session can opt in without editing the global config.
  tools_profile: process.env.DSHPLUGIN_CREW_TOOLS ?? globalDefaults.tools_profile ?? 'core',
};

const FULL_TOOLS = String(toolsProfile ?? sessionConfig.tools_profile).toLowerCase() === 'full';
const RESULT_CHARS = Number(process.env.DSHPLUGIN_CREW_RESULT_CHARS ?? globalDefaults.result_max_chars ?? 2000) || 2000;

/** The {provider, model} this session dispatches `tier` to. */
function bindingForTier(tier) {
  return resolveTierBinding(tier, sessionConfig);
}

function presetForTier(tier) {
  const p = tier === 'flash' ? sessionConfig.preset_flash : sessionConfig.preset_pro;
  return !p || p === 'default' ? undefined : p;
}

/** Tool-layer tier enforcement: the policy overrides whatever was requested. */
function applyTierPolicy(tier) {
  if (sessionConfig.tier_policy === 'flash-only') return 'flash';
  if (sessionConfig.tier_policy === 'pro-only') return 'pro';
  return tier ?? sessionConfig.default_tier;
}

function text(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

/** A hub job is settled only in a terminal state; idle/needs_input sessions stay live. */
const TERMINAL_JOB_STATUSES = new Set(['done', 'failed', 'cancelled', 'expired']);
function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.has(status);
}

/** Turn records from either a hub view (turnRecords) or a standalone view. */
function turnsArray(view) {
  if (Array.isArray(view?.turnRecords)) return view.turnRecords;
  if (Array.isArray(view?.turns)) return view.turns;
  return [];
}

/** Pending question details; hub views expose these only with the result. */
function pendingQuestionsArray(view) {
  if (Array.isArray(view?.pendingQuestionDetails)) return view.pendingQuestionDetails;
  if (Array.isArray(view?.pendingQuestions)) return view.pendingQuestions;
  return [];
}

/**
 * C06/T07: brief result shape — status, turn counts, a clipped result and the
 * pending question list (the caller needs those to answer). verbose returns
 * the full record. Result text is clipped at RESULT_CHARS unless max_chars.
 */
function resultPayload(view, opts = {}) {
  const turns = turnsArray(view);
  const pendingQuestions = pendingQuestionsArray(view);
  const limit = Number.isFinite(opts.maxChars) ? opts.maxChars : RESULT_CHARS;
  const maxChars = limit === 0 ? Infinity : limit;
  if (opts.verbose) {
    const { turnRecords, pendingQuestionDetails, ...rest } = view ?? {};
    return { ...rest, turns, pendingQuestions, pendingQuestionCount: pendingQuestions.length };
  }
  let result = view?.result;
  let truncated = false;
  if (typeof result === 'string' && result.length > maxChars) {
    result = result.slice(0, maxChars);
    truncated = true;
  }
  return {
    id: view?.id,
    status: view?.status,
    turn: view?.turn ?? turns.length,
    turns: turns.length,
    ...(result === undefined ? {} : { result }),
    ...(truncated ? { result_truncated: true, result_chars: String(view.result).length } : {}),
    pendingQuestions,
    pendingQuestionCount: pendingQuestions.length,
    ...(view?.error ? { error: String(view.error).slice(0, 500) } : {}),
  };
}

/** Stable dsh_worker_status entry fields, including standalone/CLI jobs. */
function countOf(value, fallback = 0) {
  if (Array.isArray(value)) return value.length;
  return Number.isFinite(value) ? value : fallback;
}

/**
 * C06/T07: the default view is brief. A full `{...view}` carries turns[],
 * capabilities and task text, which the model re-reads on every later turn;
 * verbose is opt-in for the rare debugging case.
 */
function statusPayload(view, opts = {}) {
  const turns = countOf(view?.turns, turnsArray(view).length);
  const pendingQuestions = countOf(view?.pendingQuestions);
  if (opts.verbose) {
    return {
      ...view,
      turns,
      turn: view?.turn ?? 0,
      currentTool: view?.currentTool ?? null,
      pendingQuestions,
      lastEventAt: view?.lastEventAt ?? view?.activity?.lastEventAt ?? null,
    };
  }
  return {
    id: view?.id,
    status: view?.status,
    tier: view?.tier,
    model: view?.model,
    turn: view?.turn ?? 0,
    turns,
    tokens: view?.tokens,
    currentTool: view?.currentTool ?? null,
    pendingQuestions,
    lastEventAt: view?.lastEventAt ?? view?.activity?.lastEventAt ?? null,
    ...(view?.cwd === undefined ? {} : { cwd: view.cwd }),
    ...(view?.cwdIgnored === undefined ? {} : { cwd_ignored: view.cwdIgnored }),
    ...(view?.error ? { error: String(view.error).slice(0, 500) } : {}),
  };
}

/** Turn an HTTP error from the hub client into a readable tool payload. */
function hubErrorPayload(err) {
  const out = { error: err?.message ?? String(err) };
  if (Number.isInteger(err?.status)) out.http_status = err.status;
  if (err?.body?.status) out.job_status = err.body.status;
  if (Array.isArray(err?.body?.allowed)) out.allowed = err.body.allowed;
  return out;
}

// Which orchestrator spawned this MCP server — stamped on every job so the
// panel can show where a dispatch came from.
const ORCHESTRATOR = detectOrchestrator();

// ---------- WPC9 guardrails ----------

// Origin chain this crew instance inherited from whoever spawned it (read at
// startup from the env written by the dispatching crew — origin-guard.mjs).
// Every dispatch appends its own hop and refuses loops / over-deep chains
// BEFORE anything is spawned, so recursion can never start burning quota.
const INHERITED_ORIGIN = readInheritedOrigin(process.env);
const depthLimitNow = () => sessionConfig.origin_depth_limit ?? DEFAULT_ORIGIN_DEPTH_LIMIT;

// Hub jobs run inside the DSH host and have no settle callback on this side,
// so the origin recorded at spawn time is kept here and re-attached to every
// hub view this session returns (the hub itself ignores the extra spawn
// fields until the hub side adopts them).
const hubOrigins = new Map();

function attachOrigin(view, jobId) {
  if (!view || typeof view !== 'object') return view;
  const o = hubOrigins.get(jobId);
  if (o && view.origin_depth === undefined) {
    view.origin_depth = o.depth;
    view.origin_chain = o.chain;
  }
  return view;
}

/** Readable refusal payload for the two origin guard checks. */
function originRefusal(res) {
  return text({ error: `dispatch refused by origin guard: ${res.error.reason}`, ...res.error });
}

/**
 * Acquire the cwd advisory lock for a hub dispatch (job id is unknown until
 * the hub answers, so it is backfilled by updateCwdLockHolder). A conflict
 * against a hub-held lock is re-checked once against the hub: a hub job can
 * settle without this side ever hearing about it, and a stale lock must not
 * permanently block the cwd.
 */
async function acquireDispatchLock({ cwd, backend, mode, allowConcurrent }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return acquireCwdLock({ cwd, jobId: null, backend, mode, startedAt: new Date().toISOString(), allowConcurrent });
    } catch (err) {
      if (!(err instanceof CwdLockError) || attempt > 0 || err.holder.mode !== 'hub') throw err;
      let settled = false;
      try { settled = isTerminalJobStatus((await hub.get(err.holder.jobId, 0)).status); }
      catch (e) { if (String(e?.message ?? e).includes('no such job')) settled = true; }
      if (!settled) throw err;
      releaseCwdLockByJobId(err.holder.jobId);
    }
  }
}

function dispatchDisabled() {
  return text({
    error: 'worker dispatch is disabled for this session (set via dsh_worker_config). Report this to the user instead of doing the task yourself.',
  });
}

async function resolveMode() {
  if (sessionConfig.mode === 'standalone') return 'standalone';
  const up = await hubReady();
  if (sessionConfig.mode === 'hub' && !up) throw new Error('session mode is "hub" but the DSH workers hub is not reachable');
  return up ? 'hub' : 'standalone';
}

server.registerTool('dsh_run_worker', {
  title: 'Run DSH worker (blocking)',
  description: 'Run one self-contained task on a DSH worker and block until it stops. tier: flash for small scoped work, pro for multi-file or design work. Returns a brief job summary.',
  inputSchema: {
    task: z.string().describe('Full task description for the worker, self-contained'),
    tier: tierSchema,
    effort: effortSchema,
    worker: workerSchema,
    cwd: z.string().optional().describe('Ignored when workspace_root is set; otherwise the worker directory.'),
    timeout_seconds: z.number().int().positive().max(7200).optional(),
    allow_concurrent_cwd: allowConcurrentCwdSchema,
  },
}, async ({ task, tier, effort, worker, cwd, timeout_seconds, allow_concurrent_cwd }) => {
  if (!sessionConfig.enabled) return dispatchDisabled();
  const workDir = resolveWorkerCwd(cwd);
  const e = effort ?? sessionConfig.default_effort;
  const timeout = timeout_seconds ?? sessionConfig.default_timeout_seconds;
  const depthLimit = depthLimitNow();

  // CLI profile dispatch: worker= names a profile and bypasses the
  // hub/standalone tier logic entirely (no tier policy, no escalation — the
  // profile pins backend×model×effort). Calls without worker= are untouched.
  if (worker) {
    const profile = resolveProfile(worker); // throws listing the available profile names
    const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: profile.backend, cwd: workDir, source: ORCHESTRATOR, depthLimit });
    if (!origin.ok) return originRefusal(origin);
    let job;
    try {
      job = await startCliJob({ worker, task, cwd: workDir, timeoutMs: timeout * 1000, source: ORCHESTRATOR, effort, origin: origin.origin, allowConcurrentCwd: !!allow_concurrent_cwd });
    } catch (err) {
      if (err instanceof CwdLockError) return text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder });
      throw err;
    }
    await waitJob(job.id, timeout * 1000);
    const view = resultPayload(jobView(job, { withResult: true }));
    if (view.status === 'running') return text({ ...view, note: `still running after ${timeout}s; poll with dsh_worker_result` });
    return text(view);
  }

  const runOnce = async (t) => {
    if ((await resolveMode()) === 'hub') {
      const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: 'hub', cwd: workDir, source: ORCHESTRATOR, depthLimit });
      if (!origin.ok) return { refusal: originRefusal(origin) };
      let lock;
      try {
        lock = await acquireDispatchLock({ cwd: workDir, backend: 'hub', mode: 'hub', allowConcurrent: !!allow_concurrent_cwd });
      } catch (err) {
        if (err instanceof CwdLockError) return { refusal: text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder }) };
        throw err;
      }
      let spawned;
      try {
        spawned = await hub.spawn({ task, tier: t, effort: e, cwd: workDir, source: ORCHESTRATOR, preset: presetForTier(t), ...bindingForTier(t), question_policy: sessionConfig.question_policy, idle_ttl_seconds: sessionConfig.idle_ttl_seconds, question_timeout_seconds: sessionConfig.question_timeout_seconds, origin_chain: origin.origin.chain, origin_depth: origin.origin.depth });
        updateCwdLockHolder({ cwd: workDir, jobId: spawned.id });
        hubOrigins.set(spawned.id, origin.origin);
      } catch (err) {
        lock.release();
        throw err;
      }
      // The hub client slices this wait internally; a single request that
      // waits minutes would be cut by undici's 300 s header timeout and
      // reported as a bare "fetch failed" while the job kept running.
      const got = await hub.get(spawned.id, timeout);
      attachOrigin(got, spawned.id);
      if (isTerminalJobStatus(got.status)) releaseCwdLockByJobId(spawned.id);
      return { view: statusPayload(got) };
    }
    const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: 'standalone', cwd: workDir, source: ORCHESTRATOR, depthLimit });
    if (!origin.ok) return { refusal: originRefusal(origin) };
    let job;
    try {
      job = await startJob({ task, tier: t, effort: e, cwd: workDir, timeoutMs: timeout * 1000, source: ORCHESTRATOR, origin: origin.origin, allowConcurrentCwd: !!allow_concurrent_cwd, ...bindingForTier(t) });
    } catch (err) {
      if (err instanceof CwdLockError) return { refusal: text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder }) };
      throw err;
    }
    await waitJob(job.id, timeout * 1000);
    return { view: statusPayload(jobView(job, { withResult: true })) };
  };

  const firstTier = applyTierPolicy(tier);
  let res = await runOnce(firstTier);
  if (res.refusal) return res.refusal;
  let job = res.view;
  if (job.status === 'running') return text({ ...job, note: `still running after ${timeout}s; poll with dsh_worker_result` });

  // Escalate on evidence, not prediction: a failed flash run retries once on
  // pro — unless the policy pins the tier to flash.
  if (job.status === 'failed' && sessionConfig.escalate_on_failure
      && firstTier === 'flash' && sessionConfig.tier_policy !== 'flash-only') {
    const firstError = job.error ?? job.stopReason ?? 'unknown failure';
    res = await runOnce('pro');
    if (res.refusal) return res.refusal;
    job = res.view;
    if (job.status === 'running') return text({ ...job, escalated: true, note: `escalated to pro, still running after ${timeout}s; poll with dsh_worker_result` });
    return text({ ...job, escalated: true, flash_failure: String(firstError).slice(0, 200) });
  }
  return text(resultPayload(job));
});

if (FULL_TOOLS) {
server.registerTool('dsh_worker_probe', {
  title: 'Probe a configured worker model route',
  description: 'Probe one configured LLM route with a minimal request and report whether it can run a worker.',
  inputSchema: { tier: z.enum(['flash', 'pro']).optional(), provider: z.string().optional(), model: z.string().optional() },
}, async ({ tier, provider, model }) => {
  if (!(await hubReady())) return text({ status: 'hub_unavailable', tool_call_verified: false });
  const bound = bindingForTier(tier ?? sessionConfig.default_tier);
  return text(await hub.probe({ provider: provider?.trim() || bound.provider, model: model?.trim() || bound.model }));
});

server.registerTool('dsh_worker_config', {
  title: 'Session worker configuration',
  description: 'Read or patch this MCP session\'s worker config (tier, model route, timeouts, tools profile).',
  inputSchema: {
    enabled: z.boolean().optional().describe('false = refuse all worker dispatch this session'),
    default_tier: z.enum(['flash', 'pro']).optional(),
    default_effort: z.enum(['off', 'high', 'max']).optional(),
    mode: z.enum(['auto', 'hub', 'standalone']).optional(),
    default_timeout_seconds: z.number().int().positive().max(7200).optional(),
    tier_policy: z.enum(['auto', 'flash-only', 'pro-only']).optional().describe('flash-only / pro-only clamp every dispatch to one tier'),
    escalate_on_failure: z.boolean().optional().describe('retry a failed blocking flash run once on pro'),
    preset_flash: z.string().optional().describe('hub-mode agent preset for flash workers (preset id, or "default")'),
    preset_pro: z.string().optional().describe('hub-mode agent preset for pro workers (preset id, or "default")'),
    flash_provider: z.string().optional().describe('LLM provider route the flash tier dispatches to. Must be a provider DSH already has configured — see available_providers in this tool\'s output. Empty string restores the built-in DeepSeek default. Configure the provider itself in DSH, not here.'),
    flash_model: z.string().optional().describe('Model id for the flash tier, as that provider names it (e.g. a local Ollama model). Empty string restores the default.'),
    pro_provider: z.string().optional().describe('LLM provider route the pro tier dispatches to. Same rules as flash_provider.'),
    pro_model: z.string().optional().describe('Model id for the pro tier. Empty string restores the default.'),
    origin_depth_limit: z.number().int().min(1).max(32).optional().describe('Max worker→worker origin-chain depth (default 3). Deeper dispatches are refused to stop recursive self-amplification; raise only for deliberate deep delegation.'),
    question_policy: z.enum(['ask', 'handoff']).optional().describe('How a worker\'s user question is handled. ask (default) parks it as needs_input and keeps the session alive until dsh_worker_message answers it; handoff returns it as an unattended failure (legacy behaviour).'),
    idle_ttl_seconds: z.number().int().positive().max(86400).optional().describe('How long a hub worker may sit idle before it is expired (default 1800).'),
    question_timeout_seconds: z.number().int().positive().max(86400).optional().describe('How long a parked question may wait for dsh_worker_message before the worker fails with QUESTION_TIMEOUT (default 900).'),
    reset: z.boolean().optional().describe('true = restore all defaults first'),
  },
}, async ({ reset, ...patch }) => {
  if (reset) {
    Object.assign(sessionConfig, { enabled: true, ...globalDefaults });
    sessionConfig.origin_depth_limit = DEFAULT_ORIGIN_DEPTH_LIMIT;
  }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) sessionConfig[k] = v;
  const reachable = await hubReady();
  // Only the hub can enumerate the host's LLM routes (this process has no
  // ctx.llm), so in standalone mode the list is honestly absent rather than
  // empty — "we cannot see them" is not "there are none".
  const available = reachable ? (await hub.providers()).providers : null;
  const bindings = describeBindings(sessionConfig);
  const custom = Object.entries(bindings).filter(([, b]) => b.custom).map(([tier]) => tier);
  const unknown = available === null
    ? []
    : custom.filter((tier) => !available.some((p) => p.id === bindings[tier].provider));
  return text({
    ...sessionConfig,
    hub_reachable: reachable,
    bindings,
    available_providers: available,
    ...(available === null && custom.length > 0
      ? { providers_note: 'The hub is not reachable, so the configured provider ids could not be checked against what DSH actually has. A route DSH does not know will fail at dispatch, not here.' }
      : {}),
    ...(unknown.length > 0
      ? { providers_warning: `DSH has no provider route named ${unknown.map((t) => JSON.stringify(bindings[t].provider)).join(', ')} (bound to: ${unknown.join(', ')}). Configure it in DSH first, or these dispatches will fail.` }
      : {}),
    ...(custom.length > 0
      ? { route_caveat: 'Appearing in available_providers only means an adapter is registered, NOT that it can run a worker. Measured: a route registered purely to re-route another provider fails a dispatch with "registration.adapter.prepareCall is not a function". Nor does DSH report tool-calling support anywhere, and a worker that cannot call tools returns prose and touches no files. A tier bound to a custom route is therefore UNVERIFIED until you call dsh_worker_probe for the configured route; the probe observes one request and is not a permanent capability guarantee.' }
      : {}),
    worker_profiles: listProfiles(),
    origin: { chain: INHERITED_ORIGIN.chain, depth: INHERITED_ORIGIN.depth, depth_limit: depthLimitNow() },
  });
});

server.registerTool('dsh_spawn_worker', {
  title: 'Spawn DSH worker (async)',
  description: 'Start a worker in the background and return its job id immediately. Follow with dsh_worker_result.',
  inputSchema: {
    task: z.string().describe('Full task description for the worker, self-contained — the worker has no conversation context, so include absolute paths, acceptance criteria and constraints'),
    tier: tierSchema,
    effort: effortSchema,
    worker: workerSchema,
    cwd: z.string().optional().describe('Ignored when workspace_root is set; otherwise the worker directory.'),
    allow_concurrent_cwd: allowConcurrentCwdSchema,
  },
}, async ({ task, tier, effort, worker, cwd, allow_concurrent_cwd }) => {
  if (!sessionConfig.enabled) return dispatchDisabled();
  const workDir = resolveWorkerCwd(cwd);
  const depthLimit = depthLimitNow();
  if (worker) {
    // CLI profile dispatch; no hub/standalone involvement, no tier policy.
    const profile = resolveProfile(worker);
    const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: profile.backend, cwd: workDir, source: ORCHESTRATOR, depthLimit });
    if (!origin.ok) return originRefusal(origin);
    try {
      const job = await startCliJob({ worker, task, cwd: workDir, source: ORCHESTRATOR, effort, origin: origin.origin, allowConcurrentCwd: !!allow_concurrent_cwd });
      return text(statusPayload(jobView(job)));
    } catch (err) {
      if (err instanceof CwdLockError) return text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder });
      throw err;
    }
  }
  const t = applyTierPolicy(tier);
  const e = effort ?? sessionConfig.default_effort;
  if ((await resolveMode()) === 'hub') {
    const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: 'hub', cwd: workDir, source: ORCHESTRATOR, depthLimit });
    if (!origin.ok) return originRefusal(origin);
    let lock;
    try {
      lock = await acquireDispatchLock({ cwd: workDir, backend: 'hub', mode: 'hub', allowConcurrent: !!allow_concurrent_cwd });
    } catch (err) {
      if (err instanceof CwdLockError) return text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder });
      throw err;
    }
    let spawned;
    try {
      spawned = await hub.spawn({ task, tier: t, effort: e, cwd: workDir, source: ORCHESTRATOR, preset: presetForTier(t), ...bindingForTier(t), question_policy: sessionConfig.question_policy, idle_ttl_seconds: sessionConfig.idle_ttl_seconds, question_timeout_seconds: sessionConfig.question_timeout_seconds, origin_chain: origin.origin.chain, origin_depth: origin.origin.depth });
      updateCwdLockHolder({ cwd: workDir, jobId: spawned.id });
      hubOrigins.set(spawned.id, origin.origin);
    } catch (err) {
      lock.release();
      throw err;
    }
    attachOrigin(spawned, spawned.id);
    return text(statusPayload(spawned));
  }
  const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: 'standalone', cwd: workDir, source: ORCHESTRATOR, depthLimit });
  if (!origin.ok) return originRefusal(origin);
  try {
    const job = await startJob({ task, tier: t, effort: e, cwd: workDir, source: ORCHESTRATOR, origin: origin.origin, allowConcurrentCwd: !!allow_concurrent_cwd, ...bindingForTier(t) });
    return text(statusPayload(jobView(job)));
  } catch (err) {
    if (err instanceof CwdLockError) return text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder });
    throw err;
  }
});

}
server.registerTool('dsh_worker_status', {
  title: 'DSH worker status',
  description: 'Brief status of worker jobs: turn, tokens, pending questions, last activity. Pass job_id + wait_seconds to long-poll one job.',
  inputSchema: {
    job_id: z.string().optional().describe('One job instead of the whole list'),
    wait_seconds: z.number().int().min(0).max(600).default(0).describe('Long-poll this job until it settles or the wait expires'),
    verbose: z.boolean().optional().describe('Full records instead of the brief shape'),
  },
}, async ({ job_id, wait_seconds, verbose }) => {
  if (job_id) {
    if (!job_id.startsWith('hub-')) {
      const local = getJob(job_id);
      return text(local ? statusPayload(jobView(local), { verbose }) : { error: `no such job: ${job_id}` });
    }
    if (!(await hubReady())) return text({ error: 'hub not reachable' });
    const view = await hub.get(job_id, wait_seconds).catch((e) => ({ error: e.message }));
    if (!view || !view.id) return text(view);
    attachOrigin(view, view.id);
    if (isTerminalJobStatus(view.status)) releaseCwdLockByJobId(job_id);
    return text(statusPayload(view, { verbose }));
  }
  const hubUp = await hubReady();
  const remote = hubUp ? await hub.list().catch(() => null) : [];
  const remoteJobs = remote ?? [];
  if (remote !== null) {
    // The list actually arrived: hub-held locks whose job is settled or gone
    // release now. A failed fetch (remote === null) must NOT release locks —
    // a down hub says nothing about whether its jobs still run.
    const byId = new Map(remoteJobs.map((j) => [j.id, j]));
    for (const l of getCwdLocks()) {
      if (l.holder.mode !== 'hub') continue;
      const j = byId.get(l.holder.jobId);
      if (j === undefined || isTerminalJobStatus(j.status)) releaseCwdLockByJobId(l.holder.jobId);
    }
  }
  for (const j of remoteJobs) attachOrigin(j, j.id);
  const local = listJobs().map((j) => jobView(j));
  const locks = getCwdLocks().map((l, i) => ({
    kind: 'cwd-lock',
    id: `cwd-lock-${i + 1}`,
    cwd: l.cwd,
    holder: l.holder,
    note: 'advisory workspace lock: a running worker holds this cwd, so a new dispatch to it is refused (unless allow_concurrent_cwd is set)',
  }));
  return text([
    ...[...remoteJobs, ...local].map((j) => statusPayload(j, { verbose })),
    ...locks,
  ]);
});

server.registerTool('dsh_worker_result', {
  title: 'DSH worker result',
  description: 'Result of one job, waiting up to wait_seconds. Default brief: status, turns count, result (truncated), pending question list.',
  inputSchema: {
    job_id: z.string(),
    wait_seconds: z.number().int().min(0).max(7200).default(0).describe('0 = return current state immediately'),
    max_chars: z.number().int().min(0).max(200000).optional().describe('Clip the result text (default 2000, 0 = no limit)'),
    verbose: z.boolean().optional().describe('Full record instead of the brief shape'),
  },
}, async ({ job_id, wait_seconds, max_chars, verbose }) => {
  if (job_id.startsWith('hub-')) {
    if (!(await hubReady())) return text({ error: 'hub not reachable' });
    const view = await hub.get(job_id, wait_seconds).catch((e) => ({ error: e.message }));
    if (view && view.id) {
      attachOrigin(view, view.id);
      if (isTerminalJobStatus(view.status)) releaseCwdLockByJobId(job_id);
      return text(resultPayload(view, { verbose, maxChars: max_chars }));
    }
    return text(view);
  }
  if (!getJob(job_id)) return text({ error: `no such job: ${job_id}` });
  const job = await waitJob(job_id, wait_seconds > 0 ? wait_seconds * 1000 : 1);
  return text(resultPayload(jobView(job, { withResult: true }), { verbose, maxChars: max_chars }));
});

server.registerTool('dsh_worker_message', {
  title: 'Message a DSH worker',
  description: 'Send a follow-up, an explicit steer, or the answer to a parked question. Default followup queues without interrupting.',
  inputSchema: {
    id: z.string().describe('Job id returned by dsh_spawn_worker / dsh_run_worker (hub ids start with "hub-")'),
    message: z.string().describe('The follow-up, steer instruction, or answer to the pending question'),
    mode: z.enum(['auto', 'steer', 'followup']).optional().default('followup').describe('followup (default, queues without interrupting) | steer (interrupts the current turn) | auto.'),
  },
}, async ({ id, message, mode }) => {
  if (!message || !message.trim()) return text({ error: 'message must be a non-empty string' });
  if (id.startsWith('hub-')) {
    if (!(await hubReady())) return text({ error: 'hub not reachable' });
    try {
      const current = await hub.get(id, 0);
      if (!current || !current.id) return text(current ?? { error: `no such job: ${id}` });
      if (current.status === 'needs_input' && (current.pendingQuestions ?? 0) > 0) {
        const answered = await hub.answer(id, [{ answer: message }]);
        const job = answered?.job ?? current;
        const remaining = Number(job?.pendingQuestions ?? 0);
        return text({
          action: 'answered',
          answered: answered?.answered ?? [],
          job: statusPayload(job),
          ...(remaining > 0 ? { note: `${remaining} more question(s) still pending; send another dsh_worker_message to answer them.` } : {}),
        });
      }
      const sent = await hub.message(id, message, mode);
      return text({ action: sent?.action ?? 'message', ...(sent?.note ? { note: sent.note } : {}), job: sent?.job ? statusPayload(sent.job) : sent?.job });
    } catch (err) {
      return text(hubErrorPayload(err));
    }
  }
  const job = getJob(id);
  if (!job) return text({ error: `no such job: ${id}` });
  return text({
    error: `job ${id} is a standalone worker (${job.status}); standalone sessions are one-shot. Dispatch a new task instead.`,
    job_id: id,
    status: job.status,
  });
});

if (FULL_TOOLS) {
server.registerTool('dsh_worker_events', {
  title: 'DSH worker events',
  description: 'Incremental event log for one job since a sequence cursor.',
  inputSchema: {
    id: z.string().describe('Hub job id (starts with "hub-")'),
    since: z.number().int().min(0).default(0).describe('Return events with seq > since (default 0 = from the oldest retained event)'),
  },
}, async ({ id, since }) => {
  if (id.startsWith('hub-')) {
    if (!(await hubReady())) return text({ error: 'hub not reachable' });
    try {
      const got = await hub.events(id, since);
      return text({ id, ...got });
    } catch (err) {
      return text(hubErrorPayload(err));
    }
  }
  const job = getJob(id);
  if (!job) return text({ error: `no such job: ${id}` });
  return text({
    id,
    status: job.status,
    events: [],
    next: since,
    latest: 0,
    note: 'standalone/CLI jobs do not expose an event ring buffer; poll dsh_worker_result instead.',
  });
});

}
server.registerTool('dsh_worker_cancel', {
  title: 'Cancel DSH worker',
  description: 'Cancel a running or idle worker job.',
  inputSchema: { job_id: z.string() },
}, async ({ job_id }) => {
  if (job_id.startsWith('hub-')) {
    if (!(await hubReady())) return text({ error: 'hub not reachable' });
    const view = await hub.cancel(job_id).catch((e) => ({ error: e.message }));
    if (view && view.id) {
      attachOrigin(view, view.id);
      releaseCwdLockByJobId(job_id); // cancelled = holder being disposed
    }
    return text(statusPayload(view));
  }
  if (!getJob(job_id)) return text({ error: `no such job: ${job_id}` });
  return text(statusPayload(jobView(await cancelJob(job_id), { withResult: true })));
});

return server;
}

// Only auto-start the stdio transport when this file is executed as the MCP
// server entrypoint. Importing it (tests, tooling) must not touch stdio.
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  await createServer().connect(new StdioServerTransport());
}
