// Client for the in-host workers-hub jobs API. When a DSH web instance with the
// dsh-crew bundle is running, jobs run inside it (sessions visible in the
// Web UI); otherwise the MCP server falls back to standalone runtimes.

import { readGlobalConfig } from './install/install.mjs';
import { pluginEnv } from './plugin-env.mjs';

const BASE = (pluginEnv('CREW_HUB') ?? readGlobalConfig().hub_url).replace(/\/$/, '');
const API = `${BASE}/_dsh/dsh-crew`;

let lastProbe = { at: 0, ok: false };

export async function hubAvailable() {
  if (Date.now() - lastProbe.at < 10_000) return lastProbe.ok;
  try {
    const res = await fetch(`${API}/ping`, { signal: AbortSignal.timeout(800) });
    const body = await res.json();
    lastProbe = { at: Date.now(), ok: res.ok && body?.service === 'dsh-crew-hub' };
  } catch {
    lastProbe = { at: Date.now(), ok: false };
  }
  return lastProbe.ok;
}

export class HubRequestError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'HubRequestError';
    this.status = status;
    this.body = body;
  }
}

async function call(path, init) {
  const res = await fetch(`${API}${path}`, init);
  let body;
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok || body?.ok === false) {
    throw new HubRequestError(body?.error ?? `hub request failed (${res.status})`, { status: res.status, body });
  }
  return body;
}

/**
 * One long-poll may never outlive the runtime's request timeouts. Node's
 * fetch (undici) aborts a request whose response headers have not arrived
 * within 300 s, and the hub sends nothing until the job settles — so a
 * `?wait=2700` poll dies at five minutes with a bare "fetch failed" while the
 * job keeps running server-side. Measured on 2026-08-19: dispatches of 2 s and
 * 4 m 03 s returned normally; 14 m, 22 m, 35 m and 41 m all failed that way.
 * Slicing the wait keeps every individual request short enough that no
 * runtime, proxy or load balancer can cut it.
 */
const MAX_POLL_SLICE_SECONDS = 60;

/**
 * C01: a hub job that records no event for this long is probably wedged (a
 * retry loop, a dead runtime), not busy — a healthy long tool call still emits
 * its own start event. The wait stops early and says so; it never cancels.
 */
export const STALL_QUIET_SECONDS = 1200;

/** Seconds since the hub last recorded an event, or null when unknowable. */
export function quietSecondsOf(view) {
  const last = view?.lastEventAt ?? view?.activity?.lastEventAt;
  const t = last ? Date.parse(last) : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

/** One long-poll slice: at most 60 s, at least 1 s (a 0 s slice would spin). */
export function sliceSeconds(remainingMs) {
  return Math.max(1, Math.min(MAX_POLL_SLICE_SECONDS, Math.ceil(remainingMs / 1000)));
}

const SETTLED_STATUSES = new Set(['idle', 'done', 'failed', 'cancelled', 'expired']);

function pendingQuestionCount(view) {
  const pending = view?.pendingQuestions;
  if (Array.isArray(pending)) return pending.length;
  return Number.isFinite(pending) ? pending : 0;
}

/**
 * Has the job reached the requested stop state?
 *
 * A parked question always stops the wait: no further waiting can make
 * progress until a human answers it, so even `until=settled` returns instead
 * of burning the whole timeout. `turn_end` additionally stops when a new turn
 * has started past the turn observed when the wait began — the job may be
 * `running` again by then, which is exactly the queue case it exists for.
 */
export function reachedTarget(view, { until = 'settled', startTurn = 0 } = {}) {
  if (!view) return false;
  const status = view.status;
  if (status === 'needs_input' || pendingQuestionCount(view) > 0) return true;
  if (SETTLED_STATUSES.has(status)) return true;
  if (until === 'needs_input') return false;
  if (until === 'turn_end') return (view.turn ?? 0) > startTurn;
  return false;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export const hub = {
  probe: (binding) => call('/worker-probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(binding) }).then(b => b.result),
  spawn: (spec) => call('/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  }).then((b) => b.job),
  list: () => call('/jobs').then((b) => b.jobs),
  // The LLM routes the HOST has configured. Only the hub can answer this: the
  // MCP server is a separate process with no ctx.llm. Returns [] rather than
  // throwing when the hub is too old to serve the route, so a stale hub
  // degrades to "cannot enumerate" instead of breaking the config tool.
  providers: () => call('/providers').then((b) => ({
    providers: b.providers ?? [],
    bindings: b.bindings ?? null,
  })).catch(() => ({ providers: [], bindings: null })),
  // `waitSeconds = 0` keeps the plain "read it now" semantics; anything longer
  // is served by repeated short waits until the job settles or the budget ends.
  get: async (id, waitSeconds = 0) => {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const slice = waitSeconds <= 0 ? 0 : sliceSeconds(deadline - Date.now());
      const job = await call(`/jobs/${id}?wait=${slice}`).then((b) => b.job);
      if (job.status !== 'running' || waitSeconds <= 0 || Date.now() >= deadline) return job;
    }
  },
  /**
   * Block until the job reaches `until` (settled | needs_input | turn_end) or
   * the timeout expires. Uses only the existing `GET /jobs/:id?wait=` route:
   * every request is a <=60 s slice and slices are separated by pollMs, so no
   * proxy/runtime cuts a long request and no side ever busy-waits. Returns the
   * last view plus whether the wait timed out; it never mutates the job.
   */
  waitFor: async (id, { until = 'settled', timeoutSeconds = 600, pollMs = 1000 } = {}) => {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const jobPath = `/jobs/${encodeURIComponent(id)}`;
    // A wait slice is a whole number of seconds, so a sub-second remainder
    // cannot be requested. Abort the request itself at the deadline instead:
    // the wall-clock wait then never overshoots timeoutSeconds by a slice.
    const request = async (path) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, remaining));
      try {
        return await call(path, { signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) return null;
        throw err;
      } finally {
        clearTimeout(timer);
      }
    };
    const baseline = await request(`${jobPath}?wait=0`);
    let job = baseline?.job;
    if (!job) return { job: null, timed_out: true };
    const startTurn = job?.turn ?? 0;
    if (reachedTarget(job, { until, startTurn })) return { job, timed_out: false };
    const quietAtStart = quietSecondsOf(job);
    if (job.status === 'running' && quietAtStart !== null && quietAtStart >= STALL_QUIET_SECONDS) {
      return { job, timed_out: true, stalled: true, quiet_seconds: quietAtStart };
    }
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { job, timed_out: true };
      const body = await request(`${jobPath}?wait=${sliceSeconds(remaining)}`);
      if (!body) return { job, timed_out: true };
      job = body.job;
      if (reachedTarget(job, { until, startTurn })) return { job, timed_out: false };
      if (job.status === 'running') {
        const quiet = quietSecondsOf(job);
        if (quiet !== null && quiet >= STALL_QUIET_SECONDS) return { job, timed_out: true, stalled: true, quiet_seconds: quiet };
      }
      if (Date.now() >= deadline) return { job, timed_out: true };
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  },
  cancel: (id) => call(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).then((b) => b.job),
  // Continue a worker session: a follow-up on idle/done, a steer on a running
  // one, or (when the job is needs_input) use answer() to resolve the parked
  // question and resume the same turn.
  message: (id, message, mode) => call(`/jobs/${encodeURIComponent(id)}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, ...(mode ? { mode } : {}) }),
  }).then((b) => ({ action: b.action, note: b.note, job: b.job })),
  answer: (id, answers) => call(`/jobs/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers }),
  }).then((b) => ({ answered: b.answered ?? [], job: b.job })),
  events: (id, since = 0) => call(`/jobs/${encodeURIComponent(id)}/events?since=${encodeURIComponent(since)}`).then((b) => {
    const { ok, ...rest } = b;
    return rest;
  }),
};
