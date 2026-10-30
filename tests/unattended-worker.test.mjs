// A hub worker must not wait on ask_user_question (#13) under the handoff
// policy.
//
// T05 makes `ask` the default: the hub parks the request until /answer. The
// upstream unattended behavior is still selectable as `handoff` — the worker
// gets the error and finishes, and an ordinary session in the same host still
// shows the question card.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unattendedQuestion } from '../src/hub/index.mjs';
import { installWorkerQuestionHandoff } from '../src/worker-question.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hub = readFileSync(join(root, 'src/hub/index.mjs'), 'utf8');

test('the rejection is one the host restores as a UserQuestionError', () => {
  // dsh-user-questions restores a rejection only when name, message and
  // code are all strings; anything else loses its code on the way back.
  const error = unattendedQuestion();
  assert.equal(error.name, 'UserQuestionError');
  assert.equal(typeof error.message, 'string');
  assert.equal(typeof error.code, 'string');
  // The model must be told what to do instead, not just that it failed.
  assert.match(error.message, /final message/);
});

test('the worker claims its questions ahead of the Web answerer', () => {
  // On the worker's own agentCtx (so the listener is scoped to it and dies
  // with it), and prepended, so it runs before any answerer that would
  // otherwise hold the question.
  assert.ok(hub.includes('installWorkerQuestionHandoff(agentCtx, job'));
});

test('handoff still stops the worker instead of waiting for an answer', async () => {
  let handler;
  let disposed = 0;
  const agentCtx = {
    on(name, fn, prepend) {
      assert.equal(name, 'user-questions/request');
      assert.equal(prepend, true);
      handler = fn;
    },
  };
  const job = {
    status: 'running',
    questions: undefined,
    pendingQuestions: [],
    result: null,
    error: null,
    handle: { dispose() { disposed += 1; } },
  };
  installWorkerQuestionHandoff(agentCtx, job, () => {}, { question_policy: 'handoff' });

  await assert.rejects(
    handler({ questions: [{ id: 'q', question: 'May I overwrite the file?' }] }),
    (error) => error.name === 'UserQuestionError' && error.code === 'UNATTENDED_WORKER',
  );
  assert.equal(disposed, 1, 'handoff still disposes the unattended runtime');
  assert.equal(job.status, 'needs_input');
  assert.equal(job.pendingQuestions.length, 0, 'handoff never parks the request');
});
