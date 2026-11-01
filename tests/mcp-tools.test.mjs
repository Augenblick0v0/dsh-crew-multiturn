// T06: MCP tool surface. These tests drive the real McpServer over the SDK's
// in-memory transport, with a fake hub injected through createServer(), so the
// tools/list schema, argument validation and response shaping are exercised
// exactly as an MCP client sees them.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';

const HUB_JOB = {
  id: 'hub-1-test',
  sessionId: 'session-test-1',
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
  toolCalls: 4,
  tokens: { input: 10, output: 20, reasoning: 0 },
  mode: 'hub',
  turns: 2,
  pendingQuestions: 0,
  lastEventAt: '2026-10-31T01:00:00.000Z',
  startedAt: '2026-10-31T00:00:00.000Z',
  endedAt: null,
  result: { ok: true, text: 'finished' },
  error: null,
  stopReason: 'completed',
  turnRecords: [{ index: 1, status: 'idle' }, { index: 2, status: 'idle' }],
  pendingQuestionDetails: [],
};

const ASK_JOB = {
  ...HUB_JOB,
  id: 'hub-2-test',
  status: 'needs_input',
  turn: 1,
  turns: 1,
  pendingQuestions: 1,
  turnRecords: [{ index: 1, status: 'needs_input' }],
  pendingQuestionDetails: [{ questionId: 'q-1', question: 'Which colour?' }],
};

function makeFakeHub() {
  const calls = { message: [], answer: [], get: [], events: [] };
  const jobs = new Map([
    [HUB_JOB.id, HUB_JOB],
    [ASK_JOB.id, { ...ASK_JOB }],
  ]);
  return {
    calls,
    async get(id) {
      calls.get.push(id);
      const job = jobs.get(id);
      if (!job) throw Object.assign(new Error('no such job'), { status: 404, body: { ok: false, error: 'no such job' } });
      return job;
    },
    async list() { return [...jobs.values()]; },
    async providers() { return { providers: [], bindings: null }; },
    async probe() { return { status: 'ok' }; },
    async spawn() { throw new Error('not used'); },
    async cancel() { throw new Error('not used'); },
    async message(id, message, mode) {
      calls.message.push({ id, message, mode });
      return { action: 'followup', note: 'queued', job: jobs.get(id) };
    },
    async answer(id, answers) {
      calls.answer.push({ id, answers });
      const job = jobs.get(id);
      const answered = { ...job, status: 'running', pendingQuestions: 0, pendingQuestionDetails: [] };
      jobs.set(id, answered);
      return { answered: ['q-1'], job: answered };
    },
    async events(id, since) {
      calls.events.push({ id, since });
      return {
        events: [
          { seq: 1, ts: '2026-10-31T00:00:01.000Z', type: 'turn/start' },
          { seq: 2, ts: '2026-10-31T00:00:02.000Z', type: 'assistant/message', data: { text: 'hi' } },
        ].filter((e) => e.seq > since),
        next: 2,
        latest: 2,
        status: 'idle',
      };
    },
  };
}

let client;
let server;
const fakeHub = makeFakeHub();

before(async () => {
  server = createServer({ hub: fakeHub, hubAvailable: async () => true, toolsProfile: 'full' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'mcp-tools-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

after(async () => {
  await client?.close().catch(() => {});
  await server?.close().catch(() => {});
});

async function callTool(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.find((c) => c.type === 'text')?.text;
  return { res, data: text === undefined ? undefined : JSON.parse(text) };
}

test('core profile exposes six tools; full exposes ten', async () => {
  const core = createServer({ hub: fakeHub, hubAvailable: async () => true, toolsProfile: 'core' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'core-profile', version: '0.0.0' });
  await Promise.all([c.connect(ct), core.connect(st)]);
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['dsh_run_worker', 'dsh_worker_cancel', 'dsh_worker_message', 'dsh_worker_result', 'dsh_worker_status', 'dsh_worker_wait']);
  await c.close().catch(() => {});
  await core.close().catch(() => {});
});

test('full profile lists the ten documented tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'dsh_run_worker',
    'dsh_spawn_worker',
    'dsh_worker_cancel',
    'dsh_worker_config',
    'dsh_worker_events',
    'dsh_worker_message',
    'dsh_worker_probe',
    'dsh_worker_result',
    'dsh_worker_status',
    'dsh_worker_wait',
  ]);
});

test('dsh_worker_message requires id and message, with mode optional', async () => {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === 'dsh_worker_message');
  assert.ok(tool, 'dsh_worker_message is registered');
  assert.deepEqual([...tool.inputSchema.required].sort(), ['id', 'message']);
  assert.deepEqual(tool.inputSchema.properties.mode.enum, ['auto', 'steer', 'followup']);
});

test('dsh_worker_message answers a needs_input job through /answer', async () => {
  const { data } = await callTool('dsh_worker_message', { id: ASK_JOB.id, message: 'Blue' });
  assert.equal(data.action, 'answered');
  assert.deepEqual(fakeHub.calls.answer.at(-1), { id: ASK_JOB.id, answers: [{ answer: 'Blue' }] });
  assert.equal(data.job.id, ASK_JOB.id);
});

test('dsh_worker_message sends an ordinary follow-up when the job is idle', async () => {
  const { data } = await callTool('dsh_worker_message', { id: HUB_JOB.id, message: 'one more thing', mode: 'steer' });
  assert.equal(data.action, 'followup');
  assert.deepEqual(fakeHub.calls.message.at(-1), { id: HUB_JOB.id, message: 'one more thing', mode: 'steer' });
});

test('dsh_worker_result is brief by default and verbose returns turn records', async () => {
  const { data } = await callTool('dsh_worker_result', { job_id: HUB_JOB.id });
  assert.equal(data.status, 'idle');
  assert.equal(data.turns, 2, 'brief shape carries the turn count');
  assert.deepEqual(data.result, { ok: true, text: 'finished' });
  assert.ok(Array.isArray(data.pendingQuestions));
  assert.equal(data.pendingQuestionCount, 0);

  const full = await callTool('dsh_worker_result', { job_id: HUB_JOB.id, verbose: true });
  assert.ok(Array.isArray(full.data.turns), 'verbose returns turn records');
  assert.equal(full.data.turns.length, 2);
});

test('dsh_worker_status exposes turn/currentTool/pendingQuestions/lastEventAt', async () => {
  const { data } = await callTool('dsh_worker_status', {});
  const job = data.find((j) => j.id === HUB_JOB.id);
  assert.ok(job, 'hub job appears in status');
  assert.equal(job.turn, 2);
  assert.equal(job.currentTool, null);
  assert.equal(job.pendingQuestions, 0);
  assert.equal(job.lastEventAt, HUB_JOB.lastEventAt);
});

test('dsh_worker_events returns a since-cursor tail', async () => {
  const { data } = await callTool('dsh_worker_events', { id: HUB_JOB.id, since: 1 });
  assert.deepEqual(fakeHub.calls.events.at(-1), { id: HUB_JOB.id, since: 1 });
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0].seq, 2);
  assert.equal(data.next, 2);
  assert.equal(data.latest, 2);
});

test('dsh_worker_message maps a hub 409 to http_status/job_status/allowed', async () => {
  const original = fakeHub.message;
  fakeHub.message = async () => {
    throw Object.assign(new Error('this host cannot steer a running turn'), {
      status: 409,
      body: { ok: false, error: 'this host cannot steer a running turn', status: 'running', allowed: ['followup'] },
    });
  };
  try {
    const { data } = await callTool('dsh_worker_message', { id: HUB_JOB.id, message: 'steer', mode: 'steer' });
    assert.equal(data.http_status, 409);
    assert.equal(data.job_status, 'running');
    assert.deepEqual(data.allowed, ['followup']);
  } finally {
    fakeHub.message = original;
  }
});

test('dsh_worker_config reports question_policy/idle_ttl_seconds/question_timeout_seconds', async () => {
  const { data } = await callTool('dsh_worker_config', {});
  assert.equal(typeof data.question_policy, 'string');
  assert.equal(typeof data.idle_ttl_seconds, 'number');
  assert.equal(typeof data.question_timeout_seconds, 'number');
  const { tools } = await client.listTools();
  const schema = tools.find((t) => t.name === 'dsh_worker_config').inputSchema;
  assert.deepEqual(schema.properties.question_policy.enum, ['ask', 'handoff']);
});
