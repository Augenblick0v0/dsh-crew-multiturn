// C06/T07: the MCP surface is what Codex re-reads on every request, so its
// size is a product constraint, not a style preference. These tests pin the
// budget: trimmed descriptions, brief payloads, clipped results, queue default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';

const HUGE = 'x'.repeat(50_000);
const HUGE_JOB = {
  id: 'hub-9-big', sessionId: 's', tier: 'pro', model: 'm', provider: 'p', effort: 'max',
  status: 'idle', source: 'test', task: 't', cwd: '/tmp/w', turn: 3, step: 1, currentTool: null,
  toolCalls: 9, tokens: { input: 1, output: 2, reasoning: 0 }, mode: 'hub',
  turns: 3, pendingQuestions: 0, lastEventAt: '2026-10-31T01:00:00.000Z',
  startedAt: null, endedAt: null, result: HUGE, error: null, stopReason: 'completed',
  turnRecords: [], pendingQuestionDetails: [],
};

async function connect(opts = {}) {
  const hub = { async get() { return HUGE_JOB; }, async list() { return [HUGE_JOB]; }, async message() { return { action: 'followup', job: HUGE_JOB }; } };
  const server = createServer({ hub, hubAvailable: async () => true, toolsProfile: 'core', ...opts });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'token-budget', version: '0.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, server };
}

test('tool descriptions and parameter docs stay within the 1,700 character budget', async () => {
  const { client, server } = await connect();
  const { tools } = await client.listTools();
  let chars = 0;
  for (const t of tools) {
    chars += t.description.length;
    for (const p of Object.values(t.inputSchema.properties ?? {})) chars += (p.description ?? '').length;
  }
  assert.equal(tools.length, 6, 'core profile exposes six tools');
  assert.ok(chars <= 1700, `schema prose is ${chars} chars, budget is 1700`);
  await client.close(); await server.close();
});

test('dsh_worker_wait defaults to 600 seconds and the settled target', async () => {
  const { client, server } = await connect();
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === 'dsh_worker_wait');
  assert.ok(tool, 'dsh_worker_wait is in the core profile');
  assert.equal(tool.inputSchema.properties.timeout_seconds.default, 600);
  assert.equal(tool.inputSchema.properties.until.default, 'settled');
  assert.deepEqual(tool.inputSchema.properties.until.enum, ['settled', 'needs_input', 'turn_end']);
  await client.close(); await server.close();
});

test('dsh_worker_result clips a huge result and says so', async () => {
  const { client, server } = await connect();
  const res = await client.callTool({ name: 'dsh_worker_result', arguments: { job_id: HUGE_JOB.id } });
  const data = JSON.parse(res.content.find((c) => c.type === 'text').text);
  assert.equal(data.result.length, 2000);
  assert.equal(data.result_truncated, true);
  assert.equal(data.result_chars, 50_000);
  await client.close(); await server.close();
});

test('dsh_worker_status brief entry stays under 1 KB', async () => {
  const { client, server } = await connect();
  const res = await client.callTool({ name: 'dsh_worker_status', arguments: {} });
  const data = JSON.parse(res.content.find((c) => c.type === 'text').text);
  const job = data.find((j) => j.id === HUGE_JOB.id);
  assert.ok(job, 'job present');
  assert.ok(Buffer.byteLength(JSON.stringify(job)) < 1024, 'brief entry is under 1 KB');
  await client.close(); await server.close();
});

test('dsh_worker_message defaults to a non-interrupting followup', async () => {
  const { client, server } = await connect();
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === 'dsh_worker_message');
  assert.equal(tool.inputSchema.properties.mode.default, 'followup');
  await client.close(); await server.close();
});
