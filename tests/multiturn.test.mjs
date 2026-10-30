// V03: the hub's multi-turn state machine.
//
// A fake agent stands in for the DSH runtime: `whenIdle()` parks on a gate the
// test releases by hand, `followup()` records the text and emits one completed
// turn. That keeps these assertions about the hub's own transitions — which
// message steers, which resumes, which is refused — and not about the runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerRegistry, JobStateError } from '../src/hub/index.mjs';

const quiet = { publish() {} };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const textOf = (input) => (input?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('');

function makeFakeCtx({ steer = true, resume = true } = {}) {
  const calls = { create: 0, followup: [], steer: [], resume: [], flush: 0, dispose: 0, whenIdle: 0 };
  const gates = [];
  const handlers = new Map();
  const emit = (event) => { for (const fn of handlers.get('session/event') ?? []) fn({}, event); };
  const reply = (text) => {
    emit({
      type: 'assistant/message',
      data: {
        message: { content: [{ type: 'text', text }] },
        usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 1 },
      },
    });
    emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
  };
  const makeAgent = (tag) => ({
    tag,
    session: { id: `session-of-${tag}` },
    whenIdle() { calls.whenIdle += 1; return new Promise((resolve) => gates.push(resolve)); },
    followup(input) {
      const text = textOf(input);
      calls.followup.push({ tag, text });
      reply(`reply:${text}`);
    },
    ...(steer ? { steer(input) { calls.steer.push({ tag, text: textOf(input) }); } } : {}),
  });
  const handle = { agent: makeAgent('a1'), dispose() { calls.dispose += 1; } };
  const resumed = { agent: makeAgent('a2'), dispose() { calls.dispose += 1; } };
  const ctx = {
    calls,
    logger: {},
    get() { return undefined; },
    sessions: { async flush() { calls.flush += 1; } },
    agents: {
      async create(options) {
        calls.create += 1;
        await options.setup({
          on(name, fn) {
            if (!handlers.has(name)) handlers.set(name, []);
            handlers.get(name).push(fn);
          },
        });
        return handle;
      },
      ...(resume ? { async resume(options) { calls.resume.push(options); return resumed; } } : {}),
    },
  };
  return { ctx, idle: () => { for (const gate of gates.splice(0)) gate(); }, emit };
}

/** Release idle gates until the promise settles (each turn needs two). */
async function drain(idle, promise, rounds = 12) {
  let settled = false;
  const tracked = Promise.resolve(promise).then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < rounds && !settled; i += 1) {
    idle();
    await tick();
  }
  await tracked;
  return settled;
}

test('a message to a running job steers the live turn and adds no turn record', async () => {
  const { ctx, idle } = makeFakeCtx();
  const reg = new WorkerRegistry(ctx, quiet);
  const job = await reg.spawn({ task: 'first task', tier: 'flash', cwd: '/tmp/fixture' });
  await tick();
  await tick();
  assert.equal(job.status, 'running');
  assert.equal(job.turns.length, 1);

  const followupsBefore = ctx.calls.followup.length;
  await reg.runTurn(job, 'steer this in', 'auto');

  assert.deepEqual(ctx.calls.steer, [{ tag: 'a1', text: 'steer this in' }]);
  assert.equal(ctx.calls.followup.length, followupsBefore, 'the original turn was not restarted');
  assert.equal(job.turns.length, 1, 'a steer does not create a turn record');
  assert.equal(job.status, 'running');
  assert.equal(reg.planTurn(job, 'still steerable', { mode: 'steer' }).action, 'steer', 'the documented { mode } call style works too');

  await drain(idle, job.promise);
  assert.equal(job.status, 'idle');
  assert.equal(ctx.calls.followup.length, 1);
});

test('a message to an idle job runs a follow-up turn on the same agent', async () => {
  const { ctx, idle } = makeFakeCtx();
  const reg = new WorkerRegistry(ctx, quiet);
  const job = await reg.spawn({ task: 'first task', tier: 'flash', cwd: '/tmp/fixture' });
  await drain(idle, job.promise);

  assert.equal(job.status, 'idle');
  assert.equal(job.turns.length, 1);
  const first = job.turns[0];
  assert.equal(first.index, 1);
  assert.equal(first.prompt, 'first task');
  assert.equal(first.stopReason, 'completed');
  assert.equal(first.textPreview, 'reply:first task');
  assert.deepEqual(first.usage, { input: 10, output: 5, reasoning: 1 });
  assert.ok(first.startedAt && first.endedAt, 'a settled turn carries both timestamps');
  assert.equal(ctx.calls.flush, 1, 'the session is flushed when a turn ends');

  const sessionId = job.sessionId;
  await drain(idle, reg.runTurn(job, 'second question', 'auto'));

  assert.equal(job.turns.length, 2);
  assert.equal(job.turns[1].index, 2);
  assert.equal(ctx.calls.followup.length, 2);
  assert.equal(ctx.calls.followup[1].tag, 'a1', 'the same live agent handled the follow-up');
  assert.equal(ctx.calls.resume.length, 0);
  assert.equal(ctx.calls.create, 1, 'no second agent was created');
  assert.equal(job.sessionId, sessionId, 'the session id never changes');
  assert.equal(job.status, 'idle');
  assert.equal(job.result, 'reply:second question');
  assert.equal(ctx.calls.flush, 2);
  assert.equal(ctx.calls.whenIdle, 4, 'two turns, two idle waits each');
});

test('a message to a done job resumes the session, then follows up', async () => {
  const { ctx, idle } = makeFakeCtx();
  const reg = new WorkerRegistry(ctx, quiet);
  const job = await reg.spawn({ task: 'first task', tier: 'flash', cwd: '/tmp/fixture' });
  await drain(idle, job.promise);

  job.status = 'done';
  await drain(idle, reg.runTurn(job, 'after done', 'auto'));

  assert.equal(ctx.calls.resume.length, 1);
  assert.equal(ctx.calls.resume[0].resumeSessionId, job.sessionId);
  assert.equal(typeof ctx.calls.resume[0].setup, 'function', 'the resumed runtime gets the same hub wiring');
  assert.equal(ctx.calls.followup.at(-1).tag, 'a2');
  assert.equal(ctx.calls.followup.at(-1).text, 'after done');
  assert.equal(job.turns.length, 2);
  assert.equal(job.status, 'idle');
  assert.equal(ctx.calls.dispose, 1, 'the superseded runtime was disposed first');
});

test('a message to a cancelled job is a 409, not a new turn', async () => {
  const { ctx } = makeFakeCtx();
  const reg = new WorkerRegistry(ctx, quiet);
  const job = await reg.spawn({ task: 'first task', tier: 'flash', cwd: '/tmp/fixture' });
  await tick();
  await reg.cancel(job.id);
  assert.equal(job.status, 'cancelled');

  for (const mode of ['auto', 'steer', 'followup']) {
    assert.throws(
      () => reg.runTurn(job, 'too late', mode),
      (err) => err instanceof JobStateError
        && err.statusCode === 409
        && err.jobStatus === 'cancelled'
        && err.allowed.length === 0,
      `mode=${mode} must be refused`,
    );
  }
  assert.equal(job.turns.length, 1, 'no turn record was appended');
});

test('a queued turn is dropped when the job is cancelled before it starts', async () => {
  const { ctx, idle } = makeFakeCtx();
  const reg = new WorkerRegistry(ctx, quiet);
  const job = await reg.spawn({ task: 'first task', tier: 'flash', cwd: '/tmp/fixture' });
  await drain(idle, job.promise);
  assert.equal(job.status, 'idle');

  // message() schedules the turn on a microtask; cancel() sets `cancelled`
  // synchronously, so the turn reaches the top of the queue already dead.
  const queued = reg.message(job.id, 'later please', 'followup');
  await reg.cancel(job.id);
  await assert.rejects(
    queued.completion,
    (err) => err instanceof JobStateError && err.jobStatus === 'cancelled',
    'the queued turn must not run on a cancelled job',
  );
  assert.equal(job.status, 'cancelled');
  assert.equal(job.turns.length, 1, 'the dropped message left no turn record');
  assert.deepEqual(ctx.calls.followup.map((c) => c.text), ['first task']);
});

test('idle jobs expire after the TTL, disposing the session exactly once', async () => {
  const { ctx, idle } = makeFakeCtx();
  assert.equal(new WorkerRegistry(ctx, quiet).idleTtlSeconds, 1800, 'the documented 30-minute default');
  const reg = new WorkerRegistry(ctx, quiet, { idleTtlSeconds: 0.02 });
  const job = await reg.spawn({ task: 'first task', tier: 'flash', cwd: '/tmp/fixture' });
  await drain(idle, job.promise);
  assert.equal(job.status, 'idle');

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(job.status, 'expired');
  assert.equal(ctx.calls.dispose, 1);
  assert.throws(
    () => reg.runTurn(job, 'wake up', 'auto'),
    (err) => err.statusCode === 409 && err.jobStatus === 'expired',
  );
});

test('without steer or resume the hub degrades instead of failing', async () => {
  const { ctx, idle } = makeFakeCtx({ steer: false, resume: false });
  const reg = new WorkerRegistry(ctx, quiet);
  const job = await reg.spawn({ task: 'first task', tier: 'flash', cwd: '/tmp/fixture' });
  await tick();
  await tick();

  assert.equal(job.capabilities.steer, false);
  assert.equal(job.capabilities.resume, false);
  assert.equal(job.capabilities.flush, true);

  assert.throws(
    () => reg.runTurn(job, 'steer this', 'steer'),
    (err) => err instanceof JobStateError
      && err.statusCode === 409
      && err.jobStatus === 'running'
      && err.allowed.length === 1
      && err.allowed[0] === 'followup',
    'an explicit steer must be refused, not silently queued, when the host cannot steer',
  );

  const started = reg.message(job.id, 'queue this', 'auto');
  assert.equal(started.action, 'queue');
  assert.match(started.note ?? '', /queued/);
  await drain(idle, started.completion);

  assert.equal(ctx.calls.steer.length, 0);
  assert.deepEqual(ctx.calls.followup.map((f) => f.text), ['first task', 'queue this']);
  assert.equal(job.turns.length, 2);
  assert.equal(job.status, 'idle');

  job.status = 'done';
  assert.throws(
    () => reg.runTurn(job, 'resume me', 'auto'),
    (err) => err.statusCode === 409 && err.jobStatus === 'done',
  );
  assert.equal(ctx.calls.resume.length, 0);
});

test('a host without sessions.flush still settles its turns', async () => {
  const { ctx, idle } = makeFakeCtx();
  delete ctx.sessions;
  const reg = new WorkerRegistry(ctx, quiet);
  const job = await reg.spawn({ task: 'first task', tier: 'flash', cwd: '/tmp/fixture' });
  await drain(idle, job.promise);

  assert.equal(job.capabilities.flush, false);
  assert.equal(job.status, 'idle');
  assert.equal(job.turns.length, 1);
});

test('bad input and unknown jobs are rejected before any work starts', async () => {
  const { ctx } = makeFakeCtx();
  const reg = new WorkerRegistry(ctx, quiet);
  const job = await reg.spawn({ task: 'first task', tier: 'flash', cwd: '/tmp/fixture' });
  await tick();

  assert.throws(() => reg.runTurn(job, '', 'auto'), (err) => err.statusCode === 400);
  assert.throws(() => reg.runTurn(job, '   ', 'auto'), (err) => err.statusCode === 400);
  assert.throws(() => reg.runTurn(job, 'hello', 'bogus'), (err) => err.statusCode === 400);
  assert.throws(() => reg.message('hub-does-not-exist', 'hello'), (err) => err.statusCode === 404);
  assert.equal(job.turns.length, 1, 'only the spawn turn exists');
});

test('cancel rejects every pending question and clears the queue', async () => {
  const { ctx } = makeFakeCtx();
  const reg = new WorkerRegistry(ctx, quiet);
  const job = await reg.spawn({ task: 'first task', tier: 'flash', cwd: '/tmp/fixture' });
  await tick();

  const entry = reg.addPendingQuestion(job, { id: 'q1', question: 'Proceed?' });
  assert.equal(job.status, 'needs_input');
  assert.equal(reg.view(job).pendingQuestions, 1);
  assert.throws(
    () => reg.message(job.id, 'another message'),
    (err) => err.statusCode === 409 && err.allowed.includes('answer'),
  );

  const settled = entry.promise.then((value) => ({ value }), (error) => ({ error }));
  await reg.cancel(job.id);
  const outcome = await settled;

  assert.equal(outcome.error?.name, 'UserQuestionError');
  assert.equal(outcome.error?.code, 'CANCELLED');
  assert.equal(job.pendingQuestions.length, 0);
  assert.equal(job.questions.length, 0);
  assert.equal(ctx.calls.dispose, 1);
});

test('answer resolves a parked question and reopens the job', async () => {
  const { ctx } = makeFakeCtx();
  const reg = new WorkerRegistry(ctx, quiet);
  const job = await reg.spawn({ task: 'first task', tier: 'flash', cwd: '/tmp/fixture' });
  await tick();

  const entry = reg.addPendingQuestion(job, { id: 'q-answer', question: 'Pick one' });
  const answered = reg.answer(job.id, [{ questionId: 'q-answer', answer: 'yes' }]);

  assert.deepEqual(answered.answered, ['q-answer']);
  assert.equal(await entry.promise, 'yes');
  assert.equal(job.status, 'running');
  assert.equal(job.pendingQuestions.length, 0);
  assert.throws(
    () => reg.answer(job.id, [{ answer: 'again' }]),
    (err) => err.statusCode === 409,
  );
  reg.addPendingQuestion(job, { id: 'q-empty', question: 'Anything?' });
  assert.throws(
    () => reg.answer(job.id, []),
    (err) => err.statusCode === 400,
  );
});
