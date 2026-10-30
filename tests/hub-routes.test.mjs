// V04: the hub's job HTTP routes (message / events / answer / list).
//
// The handler is exercised directly with mock req/res objects: no DSH context,
// no listening socket. That keeps the assertions about status codes, bodies,
// loopback refusal and the since-cursor, which is what the panel relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerRegistry, createJobsHandler } from '../src/hub/index.mjs';

const quiet = { publish() {} };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const textOf = (input) => (input?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('');

function makeFakeCtx() {
  const calls = { followup: [], flush: 0, dispose: 0 };
  const gates = [];
  const handlers = new Map();
  const emit = (event) => { for (const fn of handlers.get('session/event') ?? []) fn({}, event); };
  const ctx = {
    calls,
    logger: {},
    get() { return undefined; },
    sessions: { async flush() { calls.flush += 1; } },
    agents: {
      async create(options) {
        await options.setup({
          on(name, fn) {
            if (!handlers.has(name)) handlers.set(name, []);
            handlers.get(name).push(fn);
          },
        });
        return {
          agent: {
            session: { id: 'session-of-a1' },
            whenIdle() { return new Promise((resolve) => gates.push(resolve)); },
            followup(input) {
              const text = textOf(input);
              calls.followup.push({ text });
              emit({
                type: 'assistant/message',
                data: { message: { content: [{ type: 'text', text: `reply:${text}` }] }, usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 0 } },
              });
              emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
            },
            steer() {},
          },
          dispose() { calls.dispose += 1; },
        };
      },
    },
  };
  return { ctx, idle: () => { for (const gate of gates.splice(0)) gate(); } };
}

async function drain(idle, promise, rounds = 12) {
  let settled = false;
  const tracked = Promise.resolve(promise).then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < rounds && !settled; i += 1) { idle(); await tick(); }
  await tracked;
  return settled;
}

async function drainUntil(idle, predicate, rounds = 12) {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate()) return true;
    idle();
    await tick();
  }
  return predicate();
}

/** Mock req/res pair: the handler only needs method, url, headers and a body. */
async function call(handler, {
  method = 'GET', url, body, remoteAddress = '127.0.0.1', host = '127.0.0.1:3080',
} = {}) {
  const req = {
    method,
    url,
    headers: { host, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(chunk) { if (chunk !== undefined) this.body += chunk; },
  };
  await handler(req, res);
  let json;
  try { json = JSON.parse(res.body); } catch { json = undefined; }
  return { status: res.statusCode, headers: res.headers, body: res.body, json };
}

async function setup() {
  const { ctx, idle } = makeFakeCtx();
  const hub = new WorkerRegistry(ctx, quiet);
  const job = await hub.spawn({ task: 'route fixture', tier: 'flash', cwd: '/tmp/fixture' });
  await drain(idle, job.promise);
  assert.equal(job.status, 'idle');
  return { ctx, idle, hub, job, handler: createJobsHandler(hub) };
}

test('POST /jobs/:id/message accepts a follow-up and later lists it as a turn', async () => {
  const { idle, hub, job, handler } = await setup();

  const res = await call(handler, {
    method: 'POST', url: `/_dsh/dsh-crew/jobs/${job.id}/message`, body: { message: 'second question' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.action, 'followup');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');

  await drainUntil(idle, () => job.turns.length === 2 && job.status === 'idle');
  assert.equal(job.turns.length, 2);
  assert.equal(job.turns[1].prompt, 'second question');

  const list = await call(handler, { url: '/_dsh/dsh-crew/jobs' });
  assert.equal(list.status, 200);
  const listed = list.json.jobs.find((j) => j.id === job.id);
  assert.ok(listed, 'the hub job is in the machine-wide list');
  assert.equal(listed.turns, 2, '/jobs exposes the turn count');
  assert.equal(listed.turn, 2, '/jobs keeps the current turn number in step with it');
  assert.equal(listed.pendingQuestions, 0, '/jobs exposes the pending-question count');
  assert.equal(hub.view(job).turns, 2);
});

test('POST /jobs/:id/message rejects malformed bodies and unknown jobs', async () => {
  const { handler, job } = await setup();

  const missing = await call(handler, {
    method: 'POST', url: `/_dsh/dsh-crew/jobs/${job.id}/message`, body: {},
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.ok, false);

  const badMode = await call(handler, {
    method: 'POST', url: `/_dsh/dsh-crew/jobs/${job.id}/message`, body: { message: 'hi', mode: 'teleport' },
  });
  assert.equal(badMode.status, 400);

  const unknown = await call(handler, {
    method: 'POST', url: '/_dsh/dsh-crew/jobs/hub-does-not-exist/message', body: { message: 'hi' },
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.ok, false);
  assert.match(unknown.json.error, /no such job/);
});

test('POST /jobs/:id/message on a cancelled job is a 409 with status and allowed', async () => {
  const { handler, job } = await setup();
  job.status = 'cancelled';

  const res = await call(handler, {
    method: 'POST', url: `/_dsh/dsh-crew/jobs/${job.id}/message`, body: { message: 'too late' },
  });

  assert.equal(res.status, 409);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.status, 'cancelled');
  assert.ok(Array.isArray(res.json.allowed));
  assert.match(res.json.error, /cancelled/);
});

test('GET /jobs/:id/events honours since and returns the next cursor', async () => {
  const { hub, job, handler } = await setup();
  const base = job.events.at(-1)?.seq ?? 0;
  hub.recordEvent(job, 'fixture/one', { n: 1 });
  hub.recordEvent(job, 'fixture/two', { n: 2 });
  const url = `/_dsh/dsh-crew/jobs/${job.id}/events`;

  const all = await call(handler, { url: `${url}?since=${base}` });
  assert.equal(all.status, 200);
  assert.equal(all.json.ok, true);
  assert.equal(all.json.events.length, 2);
  assert.ok(all.json.events.every((e) => e.seq > base), 'only events after the cursor');
  assert.deepEqual(all.json.events.map((e) => e.type), ['fixture/one', 'fixture/two']);
  const last = all.json.events.at(-1).seq;
  assert.equal(all.json.next, last);
  assert.equal(all.json.latest, last);

  const empty = await call(handler, { url: `${url}?since=${last}` });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.events, []);
  assert.equal(empty.json.next, last, 'next never moves backwards');

  const bad = await call(handler, { url: `${url}?since=abc` });
  assert.equal(bad.status, 400);

  const unknown = await call(handler, { url: '/_dsh/dsh-crew/jobs/hub-nope/events' });
  assert.equal(unknown.status, 404);
});

test('POST /jobs/:id/answer resolves a parked question', async () => {
  const { hub, job, handler } = await setup();
  const entry = hub.addPendingQuestion(job, { id: 'q-route', question: 'Proceed?' });
  assert.equal(job.status, 'needs_input');

  const res = await call(handler, {
    method: 'POST',
    url: `/_dsh/dsh-crew/jobs/${job.id}/answer`,
    body: { answers: [{ questionId: 'q-route', answer: 'yes' }] },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.json.answered, ['q-route']);
  assert.equal(res.json.job.status, 'running');
  assert.equal(await entry.promise, 'yes');
  assert.equal(job.pendingQuestions.length, 0);
});

test('POST /jobs/:id/answer rejects bad bodies and non-waiting jobs', async () => {
  const { hub, job, handler } = await setup();

  const notWaiting = await call(handler, {
    method: 'POST', url: `/_dsh/dsh-crew/jobs/${job.id}/answer`, body: { answers: [{ answer: 'yes' }] },
  });
  assert.equal(notWaiting.status, 409);
  assert.equal(notWaiting.json.status, 'idle');

  hub.addPendingQuestion(job, { id: 'q-shape', question: 'Proceed?' });
  const bad = await call(handler, {
    method: 'POST', url: `/_dsh/dsh-crew/jobs/${job.id}/answer`, body: { answers: [] },
  });
  assert.equal(bad.status, 400);

  const unknownQuestion = await call(handler, {
    method: 'POST',
    url: `/_dsh/dsh-crew/jobs/${job.id}/answer`,
    body: { answers: [{ questionId: 'q-nope', answer: 'yes' }] },
  });
  assert.equal(unknownQuestion.status, 400);
  assert.equal(job.pendingQuestions.length, 1, 'a bad id leaves the parked question untouched');

  const whileWaiting = await call(handler, {
    method: 'POST', url: `/_dsh/dsh-crew/jobs/${job.id}/message`, body: { message: 'hurry up' },
  });
  assert.equal(whileWaiting.status, 409);
  assert.equal(whileWaiting.json.status, 'needs_input');
  assert.ok(whileWaiting.json.allowed.includes('answer'));

  const unknown = await call(handler, {
    method: 'POST', url: '/_dsh/dsh-crew/jobs/hub-nope/answer', body: { answers: [{ answer: 'yes' }] },
  });
  assert.equal(unknown.status, 404);
});

test('every jobs route refuses non-loopback callers', async () => {
  const { handler, job } = await setup();

  for (const [method, url] of [
    ['GET', '/_dsh/dsh-crew/jobs'],
    ['GET', `/_dsh/dsh-crew/jobs/${job.id}/events`],
    ['POST', `/_dsh/dsh-crew/jobs/${job.id}/message`],
    ['POST', `/_dsh/dsh-crew/jobs/${job.id}/answer`],
  ]) {
    const remote = await call(handler, { method, url, body: method === 'POST' ? {} : undefined, remoteAddress: '192.168.1.9' });
    assert.equal(remote.status, 403, `${method} ${url} from a LAN address`);
    assert.match(remote.json.error, /loopback/);

    const host = await call(handler, { method, url, body: method === 'POST' ? {} : undefined, host: 'evil.example' });
    assert.equal(host.status, 403, `${method} ${url} with a non-local Host header`);
  }
});
