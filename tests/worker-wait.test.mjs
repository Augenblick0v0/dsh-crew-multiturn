// T01: dsh_worker_wait is the one blocking call that replaces status/events
// polling. These tests drive the real McpServer over the SDK's in-memory
// transport with an injected fake hub, so the tool surface and response shape
// are exactly what an MCP client sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { registerJob } from '../src/jobs.mjs';
import { HubRequestError } from '../src/hub-client.mjs';

const WAIT_KEYS = [
  'id', 'status', 'turn', 'timed_out', 'last_event',
  'result_preview', 'pending_questions',
];

function job(overrides = {}) {
  return {
    id: 'hub-1-wait',
    sessionId: 'session-1',
    tier: 'flash',
    model: 'test-model',
    provider: 'test-provider',
    effort: 'max',
    status: 'idle',
    source: 'test',
    task: 'do the thing',
    cwd: '/tmp/work',
    turn: 2,
    step: 1,
    currentTool: null,
    toolCalls: 3,
    tokens: { input: 1, output: 2, reasoning: 0 },
    mode: 'hub',
    turns: 2,
    pendingQuestions: 0,
    pendingQuestionDetails: [],
    lastEventAt: '2026-11-01T02:00:00.000Z',
    lastEvent: { seq: 9, ts: '2026-11-01T02:00:00.000Z', type: 'turn/settled', summary: 'turn 2 settled' },
    result: 'finished fine',
    ...overrides,
  };
}

function makeFakeHub(results) {
  const calls = [];
  return {
    calls,
    async list() { return []; },
    async get(id, waitSeconds = 0) { calls.push({ method: 'get', id, waitSeconds }); return results[id]?.job ?? null; },
    async waitFor(id, opts) {
      calls.push({ method: 'waitFor', id, opts });
      const entry = results[id];
      if (!entry) throw new HubRequestError(`no such job: ${id}`, { status: 404, body: { status: 404 } });
      if (entry.error) throw entry.error;
      return { job: entry.job, timed_out: !!entry.timed_out };
    },
  };
}

async function connect(hub) {
  const server = createServer({ hub, hubAvailable: async () => true, toolsProfile: 'core' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'worker-wait', version: '0.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, server };
}

async function callWait(hub, args) {
  const { client, server } = await connect(hub);
  const res = await client.callTool({ name: 'dsh_worker_wait', arguments: args });
  const data = JSON.parse(res.content.find((c) => c.type === 'text').text);
  return { data, client, server };
}

test('core profile exposes six tools including dsh_worker_wait', async () => {
  const hub = makeFakeHub({});
  const { client, server } = await connect(hub);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 6);
  assert.ok(tools.some((t) => t.name === 'dsh_worker_wait'));
  await client.close(); await server.close();
});

test('already settled: returns the fixed shape with defaults 600/settled', async () => {
  const hub = makeFakeHub({ 'hub-1-wait': { job: job() } });
  const { data, client, server } = await callWait(hub, { job_id: 'hub-1-wait' });

  assert.deepEqual(Object.keys(data).sort(), [...WAIT_KEYS].sort());
  assert.equal(data.id, 'hub-1-wait');
  assert.equal(data.status, 'idle');
  assert.equal(data.turn, 2);
  assert.equal(data.timed_out, false);
  assert.deepEqual(data.last_event, { seq: 9, ts: '2026-11-01T02:00:00.000Z', type: 'turn/settled', summary: 'turn 2 settled' });
  assert.equal(data.result_preview, 'finished fine');
  assert.deepEqual(data.pending_questions, []);
  assert.deepEqual(hub.calls[0].opts, { until: 'settled', timeoutSeconds: 600 });

  await client.close(); await server.close();
});

test('needs_input: returns pending questions with id and text', async () => {
  const parked = job({
    status: 'needs_input',
    turn: 1,
    turns: 1,
    pendingQuestions: 1,
    pendingQuestionDetails: [{ questionId: 'q-1', question: 'Which colour?' }],
    lastEvent: { seq: 5, ts: '2026-11-01T02:01:00.000Z', type: 'question/pending', summary: 'question pending' },
    result: null,
  });
  const hub = makeFakeHub({ 'hub-1-wait': { job: parked } });
  const { data, client, server } = await callWait(hub, { job_id: 'hub-1-wait', until: 'needs_input', timeout_seconds: 30 });

  assert.equal(data.status, 'needs_input');
  assert.equal(data.timed_out, false);
  assert.deepEqual(data.pending_questions, [{ questionId: 'q-1', question: 'Which colour?' }]);
  assert.equal(data.result_preview, null);
  assert.deepEqual(hub.calls[0].opts, { until: 'needs_input', timeoutSeconds: 30 });

  await client.close(); await server.close();
});

test('turn_end: returns while the job is running on the next turn', async () => {
  const nextTurn = job({ status: 'running', turn: 2, result: undefined, lastEvent: { seq: 11, ts: '2026-11-01T02:02:00.000Z', type: 'turn/start', summary: 'turn 2 started' } });
  const hub = makeFakeHub({ 'hub-1-wait': { job: nextTurn } });
  const { data, client, server } = await callWait(hub, { job_id: 'hub-1-wait', until: 'turn_end' });

  assert.equal(data.status, 'running');
  assert.equal(data.turn, 2);
  assert.equal(data.timed_out, false);
  assert.deepEqual(data.last_event, { seq: 11, ts: '2026-11-01T02:02:00.000Z', type: 'turn/start', summary: 'turn 2 started' });

  await client.close(); await server.close();
});

test('timeout: returns the current view with timed_out true and does not throw', async () => {
  const hub = makeFakeHub({ 'hub-1-wait': { job: job({ status: 'running', turn: 1, result: undefined }), timed_out: true } });
  const { data, client, server } = await callWait(hub, { job_id: 'hub-1-wait', timeout_seconds: 1 });

  assert.equal(data.timed_out, true);
  assert.equal(data.status, 'running');
  assert.equal(data.turn, 1);
  assert.equal(data.result_preview, null);
  assert.deepEqual(data.pending_questions, []);

  await client.close(); await server.close();
});

test('hub error: returns {error} and the server keeps serving', async () => {
  const failure = new HubRequestError('hub exploded', { status: 500, body: { status: 500 } });
  const hub = makeFakeHub({ 'hub-1-wait': { error: failure } });
  const { data, client, server } = await callWait(hub, { job_id: 'hub-1-wait' });

  assert.equal(data.error, 'hub exploded');
  assert.equal(data.http_status, 500);

  // The same process must still answer the next tool call.
  const res = await client.callTool({ name: 'dsh_worker_status', arguments: {} });
  assert.ok(Array.isArray(JSON.parse(res.content.find((c) => c.type === 'text').text)));

  await client.close(); await server.close();
});

test('result_preview uses RESULT_CHARS (2000) and an empty result stays null', async () => {
  const hub = makeFakeHub({
    'hub-1-wait': { job: job({ result: 'x'.repeat(2500) }) },
    'hub-2-empty': { job: job({ id: 'hub-2-empty', result: '' }) },
  });
  const long = await callWait(hub, { job_id: 'hub-1-wait' });
  assert.equal(long.data.result_preview.length, 2000);
  assert.equal(Object.hasOwn(long.data, 'result_truncated'), false);
  await long.client.close(); await long.server.close();

  const empty = await callWait(hub, { job_id: 'hub-2-empty' });
  assert.equal(empty.data.result_preview, null, 'empty result must stay null, not ""');
  await empty.client.close(); await empty.server.close();
});

test('standalone jobs reject until != settled and still serve the settled shape', async () => {
  registerJob({
    id: 'local-wait-1', tier: 'flash', model: 'm', provider: 'p', effort: 'high',
    status: 'idle', source: 'test', task: 'local task', cwd: '/tmp/work',
    turn: 1, step: 1, currentTool: null, tokens: { input: 0, output: 0, reasoning: 0 },
    toolCalls: 0, result: 'local done', error: null, stopReason: 'completed',
    activity: { lastEventAt: '2026-11-01T02:03:00.000Z', events: [] },
  });
  const hub = makeFakeHub({});
  const { data, client, server } = await callWait(hub, { job_id: 'local-wait-1', until: 'needs_input' });
  assert.match(data.error, /only supported for hub jobs/);

  const settled = await client.callTool({ name: 'dsh_worker_wait', arguments: { job_id: 'local-wait-1', timeout_seconds: 5 } });
  const view = JSON.parse(settled.content.find((c) => c.type === 'text').text);
  assert.equal(view.status, 'idle');
  assert.equal(view.timed_out, false);
  assert.equal(view.result_preview, 'local done');
  assert.deepEqual(view.last_event, { at: '2026-11-01T02:03:00.000Z' });

  await client.close(); await server.close();
});
