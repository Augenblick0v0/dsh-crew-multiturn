// C02: every hub dispatch carries a per-dispatch REPORT.md path. The worker
// writes that file, so a job that times out (or is cancelled) still leaves a
// readable deliverable even though hub `result` stays null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';

function makeFakeHub() {
  const spawns = [];
  const jobs = new Map();
  return {
    spawns,
    async list() { return [...jobs.values()]; },
    async get(id, waitSeconds = 0) { return jobs.get(id) ?? null; },
    async waitFor(id) { return { job: jobs.get(id), timed_out: false }; },
    async spawn(spec) {
      spawns.push(spec);
      const id = `hub-report-${spawns.length}`;
      const created = {
        id, sessionId: 'session-report', tier: spec.tier, model: 'test-model',
        provider: 'test-provider', status: 'running', source: 'mcp', task: spec.task,
        cwd: spec.cwd, turn: 1, pendingQuestions: 0, turns: 1,
        lastEventAt: new Date().toISOString(),
      };
      jobs.set(id, created);
      return created;
    },
  };
}

async function connect(hub) {
  const server = createServer({ hub, hubAvailable: async () => true, toolsProfile: 'full' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'report-path', version: '0.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, server };
}

const parse = (res) => JSON.parse(res.content.find((c) => c.type === 'text').text);

test('dsh_spawn_worker adds a report_path and prefixes the task with the report line', async () => {
  const hub = makeFakeHub();
  const { client, server } = await connect(hub);
  const data = parse(await client.callTool({ name: 'dsh_spawn_worker', arguments: { task: 'fix the build', tier: 'flash', allow_concurrent_cwd: true } }));

  assert.equal(typeof data.report_path, 'string');
  assert.match(data.report_path, /[/\\]\.crew[/\\]run-[a-z0-9]+-[a-z0-9]+\/REPORT\.md$/);
  assert.match(hub.spawns[0].task, /^\[crew-report\]/);
  assert.ok(hub.spawns[0].task.includes(data.report_path), 'the directive names the same path that is returned');
  assert.ok(hub.spawns[0].task.endsWith('fix the build'), 'the caller task is passed through unchanged after the directive');

  await client.close(); await server.close();
});

test('dsh_worker_wait repeats the report_path so a later wait can still find it', async () => {
  const hub = makeFakeHub();
  const { client, server } = await connect(hub);
  const spawned = parse(await client.callTool({ name: 'dsh_spawn_worker', arguments: { task: 'index the repo', tier: 'flash', allow_concurrent_cwd: true } }));
  const waited = parse(await client.callTool({ name: 'dsh_worker_wait', arguments: { job_id: spawned.id, timeout_seconds: 5 } }));

  assert.equal(waited.report_path, spawned.report_path);
  await client.close(); await server.close();
});
