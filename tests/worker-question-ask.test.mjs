// V05: the pending-answer handshake for worker questions.
//
// `ask` (default) parks the request on the job and leaves the runtime alive;
// /answer resolves it so the same turn continues. A timeout rejects and
// disposes. `handoff` keeps the upstream stop-and-return behavior verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerRegistry } from '../src/hub/index.mjs';
import { installWorkerQuestionHandoff } from '../src/worker-question.mjs';

function makeContext() {
  let handler;
  const ctx = {
    on(name, fn, prepend) {
      assert.equal(name, 'user-questions/request');
      assert.equal(prepend, true, 'the worker must claim its questions before the Web answerer');
      handler = fn;
    },
  };
  return { ctx, fire: (request) => handler(request) };
}

function makeJob({ id = 'job-1', status = 'running' } = {}) {
  const state = { disposed: 0, published: 0 };
  const job = {
    id, status, result: null, error: null,
    task: 'worker question fixture', tier: 'flash', model: 'test', provider: 'test', effort: 'max',
    source: 'api', cwd: '/fixture', turn: 0, step: 0, currentTool: null, toolCalls: 0,
    tokens: { input: 0, output: 0, reasoning: 0 }, startedAt: new Date().toISOString(), endedAt: null,
    pendingQuestions: [], questions: undefined,
    events: [], nextSeq: 1, waiters: [],
    handle: { dispose() { state.disposed += 1; } },
  };
  return { job, state, publish: () => { state.published += 1; } };
}

test('ask parks the request without disposing the runtime', async () => {
  const { ctx, fire } = makeContext();
  const { job, state, publish } = makeJob();
  installWorkerQuestionHandoff(ctx, job, publish);

  const pending = fire({
    questions: [{
      id: 'overwrite', question: 'Overwrite existing file?', detail: 'The file is not empty.',
      options: [{ label: 'Yes' }, { label: 'No' }],
    }],
  });

  assert.equal(job.status, 'needs_input');
  assert.equal(job.pendingQuestions.length, 1);
  const entry = job.pendingQuestions[0];
  assert.ok(entry.questionId, 'every parked request gets a questionId');
  assert.ok(entry.timer, 'the parked request carries its own timeout timer');
  assert.equal(state.disposed, 0, 'ask must never dispose the worker');
  assert.equal(state.published, 1, 'publish() is called when the question is parked');
  assert.equal(job.questions[0].id, entry.questionId);

  entry.resolve({ selected: ['Yes'] });
  const answer = await pending;

  assert.deepEqual(answer, { answers: [{ id: 'overwrite', selected: ['Yes'] }] });
  assert.equal(job.status, 'running', 'the same turn continues after the answer');
  assert.equal(job.pendingQuestions.length, 0);
  assert.equal(state.disposed, 0);
});

test('/answer resolves the parked promise with the original question order', async () => {
  const { ctx, fire } = makeContext();
  const { job, state, publish } = makeJob();
  const hub = new WorkerRegistry({ logger: {}, get() {} }, { publish() {} });
  hub.jobs.set(job.id, job);
  installWorkerQuestionHandoff(ctx, job, publish);

  const pending = fire({
    questions: [
      { id: 'first', question: 'Which branch?' },
      { id: 'second', question: 'Force push?' },
    ],
  });
  const questionId = job.pendingQuestions[0].questionId;

  const answered = hub.answer(job.id, [{
    questionId,
    answer: [{ id: 'first', selected: ['feat/multiturn'] }, { id: 'second', selected: ['No'], custom: 'ask later' }],
  }]);

  assert.deepEqual(answered.answered, [questionId]);
  const result = await pending;
  assert.deepEqual(result, {
    answers: [
      { id: 'first', selected: ['feat/multiturn'] },
      { id: 'second', selected: ['No'], custom: 'ask later' },
    ],
  });
  assert.equal(job.status, 'running', '/answer puts the job back into the running turn');
  assert.equal(job.pendingQuestions.length, 0);
  assert.equal(state.disposed, 0);
});

test('a timed-out question rejects with QUESTION_TIMEOUT and disposes once', async () => {
  const { ctx, fire } = makeContext();
  const { job, state, publish } = makeJob();
  installWorkerQuestionHandoff(ctx, job, publish, { question_timeout_seconds: 0.01 });

  const pending = fire({ questions: [{ id: 'q', question: 'Still there?' }] });

  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'UserQuestionError');
    assert.equal(error.code, 'QUESTION_TIMEOUT');
    return true;
  });
  assert.equal(state.disposed, 1, 'the timed-out runtime is disposed exactly once');
  assert.equal(job.pendingQuestions.length, 0);
  assert.equal(job.status, 'failed');
});

test('handoff keeps the upstream rejection and prompt text unchanged', async () => {
  const { ctx, fire } = makeContext();
  const { job, state, publish } = makeJob();
  installWorkerQuestionHandoff(ctx, job, publish, { question_policy: 'handoff' });

  await assert.rejects(fire({ questions: [{ id: 'q', question: 'Overwrite?' }] }), (error) => {
    assert.equal(error.name, 'UserQuestionError');
    assert.equal(error.code, 'UNATTENDED_WORKER');
    assert.match(error.message, /no option was selected automatically/);
    return true;
  });

  assert.equal(state.disposed, 1);
  assert.equal(job.status, 'needs_input');
  assert.equal(job.error, 'Worker stopped for an unresolved question; no option was selected automatically.');
  const result = JSON.parse(job.result);
  assert.equal(result.needs_input, true);
  assert.equal(
    result.instruction,
    'Obtain the required answer or approval from the user, then dispatch a new task with that answer. An unanswered question grants no permission.',
  );
});

test('the handshake log records only the question count', () => {
  const { ctx, fire } = makeContext();
  const { job, publish } = makeJob();
  const lines = [];
  installWorkerQuestionHandoff(ctx, job, publish, { log: (line) => lines.push(line) });

  const pending = fire({ questions: [{ id: 'q', question: 'What is the production database password?' }] });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /1 question/);
  assert.ok(!lines[0].includes('password'), 'question text must never reach the log');
  job.pendingQuestions[0].resolve('n/a');
  return pending;
});
