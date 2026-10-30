#!/usr/bin/env node
// V07 / T07: end-to-end visibility.
//
// Starts an in-process hub (real WorkerRegistry + real loopback HTTP route,
// fake DSH ctx) on an ephemeral 127.0.0.1 port, dispatches two turns, then
// checks the four C03 promises:
//   1. the follow-up turn keeps the same sessionId;
//   2. /jobs/:id/events?since=0 exposes step/start, tool/call,
//      assistant/message and turn/end with seq/ts/type/summary;
//   3. the workspace session list contains that session;
//   4. the session file is flushed (mtime advances) after every turn/end.
//
// Run: node scripts/e2e-visibility.mjs   (prints PASS, exit 0)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { WorkerRegistry, createJobsHandler } from '../src/hub/index.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (input) => (input?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('');

const workspace = mkdtempSync(path.join(tmpdir(), 'dsh-crew-visibility-'));
const sessionDir = path.join(workspace, '.sessions');
mkdirSync(sessionDir, { recursive: true });

const state = { turnCount: 0, flush: 0, flushTurns: [] };
const handlers = new Map();
const emit = (event) => { for (const fn of handlers.get('session/event') ?? []) fn({}, event); };

const ctx = {
  logger: { warn() {} },
  get() { return undefined; },
  sessions: {
    // Stands in for DSH's session store: a flush writes the workspace session
    // file, exactly the artifact a real workspace session list would read.
    async flush(session) {
      state.flush += 1;
      state.flushTurns.push(state.turnCount);
      writeFileSync(
        path.join(sessionDir, `${session.id}.json`),
        JSON.stringify({ sessionId: session.id, turns: state.turnCount, flushedAt: new Date().toISOString() }),
      );
    },
    async list() {
      return readdirSync(sessionDir).filter((f) => f.endsWith('.json')).map((f) => {
        const file = path.join(sessionDir, f);
        return { ...JSON.parse(readFileSync(file, 'utf8')), path: file, mtimeMs: statSync(file).mtimeMs };
      });
    },
  },
  agents: {
    async create({ sessionId, setup }) {
      await setup({
        on(name, fn) {
          if (!handlers.has(name)) handlers.set(name, []);
          handlers.get(name).push(fn);
        },
      });
      return {
        agent: {
          session: { id: sessionId },
          async whenIdle() {},
          followup(input) {
            const text = textOf(input);
            state.turnCount += 1;
            // A realistic slice of the session event stream the hub listens to.
            emit({ type: 'step/start', data: { turn: state.turnCount, step: 1 } });
            emit({ type: 'tool/call', data: { name: 'read', callId: `call-${state.turnCount}` } });
            emit({ type: 'tool/result', data: { name: 'read', ok: true } });
            emit({
              type: 'assistant/message',
              data: {
                message: { content: [{ type: 'text', text: `reply:${text}` }] },
                usage: { inputTokens: 7, outputTokens: 3, reasoningTokens: 0 },
              },
            });
            emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
          },
          async steer() {},
        },
        async dispose() {},
      };
    },
  },
};

const hub = new WorkerRegistry(ctx, { publish() {} });
const handler = createJobsHandler(hub);
const server = createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((err) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
  });
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const base = `http://127.0.0.1:${server.address().port}/_dsh/dsh-crew`;

async function api(pathname, init) {
  const res = await fetch(`${base}${pathname}`, init);
  const body = await res.json();
  assert.equal(res.status, 200, `${pathname} -> HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}
const post = (pathname, body) => api(pathname, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

async function until(fn, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let failed = null;
try {
  // ---- dispatch turn 1 -------------------------------------------------
  const spawned = await post('/jobs', {
    task: 'visibility turn one', tier: 'flash', effort: 'max', cwd: workspace,
  });
  const id = spawned.job.id;
  const sessionId = spawned.job.sessionId;
  assert.ok(id && sessionId, 'spawn returns a job id and sessionId');

  const first = await until(async () => {
    const { job } = await api(`/jobs/${id}`);
    return job.status === 'idle' && job.turns === 1 ? job : null;
  }, 'turn 1 to settle');
  assert.equal(first.sessionId, sessionId, 'turn 1 keeps the spawned sessionId');
  assert.equal(state.flush, 1, 'turn/end flushed the session immediately (not only at job end)');

  const firstFile = await until(
    async () => (await ctx.sessions.list()).find((s) => s.sessionId === sessionId),
    'workspace session list to contain the job session after turn 1',
  );
  const firstMtime = firstFile.mtimeMs;

  // ---- events: full tail + summary shape ------------------------------
  const all = await api(`/jobs/${id}/events?since=0`);
  assert.ok(Array.isArray(all.events) && all.events.length > 0, 'events?since=0 returns a tail');
  assert.equal(all.next, all.events.at(-1).seq, 'next is the last delivered seq');
  for (const event of all.events) {
    assert.equal(typeof event.seq, 'number', 'event has a numeric seq');
    assert.equal(typeof event.ts, 'string', 'event has a timestamp');
    assert.equal(typeof event.type, 'string', 'event has a type');
    assert.equal(typeof event.summary, 'string', 'event has a one-line summary');
  }
  const types = new Set(all.events.map((e) => e.type));
  for (const required of ['step/start', 'tool/call', 'assistant/message', 'turn/end']) {
    assert.ok(types.has(required), `event tail contains ${required}`);
  }

  // ---- dispatch turn 2 -------------------------------------------------
  // A coarse filesystem may stamp mtimes at 1 s resolution; wait one tick so
  // the second flush is observable as an mtime change, not just new content.
  await sleep(1100);
  const followed = await post(`/jobs/${id}/message`, { message: 'visibility turn two' });
  assert.equal(followed.action, 'followup', 'second dispatch is a follow-up turn');

  const second = await until(async () => {
    const { job } = await api(`/jobs/${id}`);
    return job.status === 'idle' && job.turns === 2 ? job : null;
  }, 'turn 2 to settle');
  assert.equal(second.sessionId, sessionId, 'follow-up turn reuses the same sessionId');

  // ---- incremental cursor, flush + workspace list after turn 2 --------
  const delta = await api(`/jobs/${id}/events?since=${all.next}`);
  const deltaTypes = new Set(delta.events.map((e) => e.type));
  for (const required of ['turn/start', 'step/start', 'assistant/message', 'turn/end']) {
    assert.ok(deltaTypes.has(required), `incremental events contain ${required}`);
  }
  assert.ok(delta.next > all.next, 'incremental cursor advances');
  const empty = await api(`/jobs/${id}/events?since=${delta.next}`);
  assert.deepEqual(empty.events, [], 'a caught-up cursor returns no events');
  assert.equal(empty.next, delta.next, 'next never moves backwards');

  assert.equal(state.flush, 2, 'the second turn/end flushed again');
  assert.deepEqual(state.flushTurns, [1, 2], 'one flush per completed turn, with that turn\'s state');

  const sessionFile = await until(async () => {
    const found = (await ctx.sessions.list()).find((s) => s.sessionId === sessionId);
    return found && found.turns === 2 && found.mtimeMs > firstMtime ? found : null;
  }, 'workspace session file mtime to advance after turn 2');
  const sessions = await ctx.sessions.list();
  assert.equal(sessionFile.turns, 2, 'flushed session file carries both turns');

  // ---- ring buffer: default 500, bounded with stable seq ---------------
  assert.equal(hub.eventLimit, 500, 'hub default event ring capacity is 500');
  const ringCtx = { logger: {}, get() { return undefined; } };
  const ring = new WorkerRegistry(ringCtx, { publish() {} }, { eventLimit: 3 });
  const stub = { events: [], nextSeq: 1, lastEventAt: null };
  for (let i = 0; i < 5; i += 1) ring.recordEvent(stub, 'ring/test', { i });
  assert.deepEqual(stub.events.map((e) => e.seq), [3, 4, 5], 'ring keeps only the newest entries');
  assert.equal(stub.events.length, 3);

  const detail = await api(`/jobs/${id}`);
  assert.equal(detail.job.turnRecords.length, 2, 'job detail exposes turnRecords for the UI');

  console.log('PASS V07 visibility');
  console.log(`  ✓ same sessionId across 2 turns (${sessionId})`);
  console.log(`  ✓ events since=0 contains step/start, tool/call, assistant/message, turn/end (${all.events.length} events)`);
  console.log(`  ✓ workspace session list contains the session (${sessions.length} session file)`);
  console.log(`  ✓ per-turn flush advanced the session file mtime (${firstMtime} -> ${sessionFile.mtimeMs})`);
  console.log(`  ✓ event ring bounded (default 500, trim keeps newest seq)`);
} catch (err) {
  failed = err;
  console.error('FAIL V07 visibility');
  console.error(err?.stack ?? err);
} finally {
  await hub.dispose();
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
  rmSync(workspace, { recursive: true, force: true });
}

if (failed !== null) process.exitCode = 1;
