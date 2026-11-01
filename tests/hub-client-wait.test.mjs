// T01: the long-poll loop and its pure helpers. fetch is injected so these
// tests exercise real slicing, deadline handling and error propagation without
// a live hub; worker-wait.test.mjs separately covers the MCP tool surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sliceSeconds, reachedTarget, hub, HubRequestError } from '../src/hub-client.mjs';

const job = (overrides = {}) => ({ id: 'hub-wait-1', status: 'running', turn: 1, ...overrides });
const reply = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, job: value }) });
const errorReply = (status, error) => ({ ok: false, status, json: async () => ({ ok: false, error }) });

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('sliceSeconds never returns 0 or more than 60', () => {
  assert.equal(sliceSeconds(0), 1);
  assert.equal(sliceSeconds(45_000), 45);
  assert.equal(sliceSeconds(125_000), 60);
  assert.equal(sliceSeconds(1), 1);
  assert.equal(sliceSeconds(60_000), 60);
});

test('reachedTarget: settled statuses stop every target', () => {
  for (const status of ['idle', 'done', 'failed', 'cancelled', 'expired']) {
    assert.equal(reachedTarget({ status }, { until: 'settled', startTurn: 0 }), true, status);
  }
});

test('reachedTarget: needs_input stops even when waiting for settled', () => {
  assert.equal(reachedTarget({ status: 'needs_input', pendingQuestions: 0 }, { until: 'settled', startTurn: 3 }), true);
  assert.equal(reachedTarget({ status: 'running', pendingQuestions: 2 }, { until: 'settled', startTurn: 3 }), true);
  assert.equal(reachedTarget({ status: 'running', pendingQuestions: 0 }, { until: 'needs_input', startTurn: 3 }), false);
});

test('reachedTarget: turn_end fires only after the turn advances', () => {
  assert.equal(reachedTarget({ status: 'running', turn: 4 }, { until: 'turn_end', startTurn: 3 }), true);
  assert.equal(reachedTarget({ status: 'running', turn: 3 }, { until: 'turn_end', startTurn: 3 }), false);
  assert.equal(reachedTarget({ status: 'running', turn: 5 }, { until: 'settled', startTurn: 3 }), false);
  assert.equal(reachedTarget(null, { until: 'settled' }), false);
});

test('waitFor: a settled baseline returns without issuing a wait slice', async () => {
  const waits = [];
  await withFetch(async (url) => {
    waits.push(Number(new URL(url).searchParams.get('wait')));
    return reply(job({ status: 'idle', result: 'done' }));
  }, async () => {
    const result = await hub.waitFor('hub-wait-1', { timeoutSeconds: 600 });
    assert.equal(result.timed_out, false);
    assert.equal(result.job.status, 'idle');
  });
  assert.deepEqual(waits, [0]);
});

test('waitFor: slices at 60s and uses the turn observed at call time', async () => {
  const sequence = [job({ turn: 1 }), job({ turn: 1 }), job({ turn: 2 })];
  const waits = [];
  let index = 0;
  await withFetch(async (url) => {
    waits.push(Number(new URL(url).searchParams.get('wait')));
    return reply(sequence[Math.min(index++, sequence.length - 1)]);
  }, async () => {
    const result = await hub.waitFor('hub-wait-1', { until: 'turn_end', timeoutSeconds: 200, pollMs: 1 });
    assert.equal(result.timed_out, false);
    assert.equal(result.job.turn, 2);
  });
  assert.deepEqual(waits, [0, 60, 60]);
});

test('waitFor: times out, returns the last view, and never exceeds a 1s slice', async () => {
  const waits = [];
  const started = Date.now();
  await withFetch(async (url) => {
    waits.push(Number(new URL(url).searchParams.get('wait')));
    return reply(job({ turn: 1 }));
  }, async () => {
    const result = await hub.waitFor('hub-wait-1', { timeoutSeconds: 0.05, pollMs: 10 });
    assert.equal(result.timed_out, true);
    assert.equal(result.job.status, 'running');
  });
  assert.ok(waits.length >= 2, 'baseline plus at least one wait');
  assert.ok(waits.every((n) => n <= 1), `all slices stay within the remaining deadline: ${waits}`);
  assert.ok(Date.now() - started < 500, 'timeout must not overshoot by a full second');
});

test('waitFor: inserts the configured gap between slices', async () => {
  const sequence = [job({ turn: 1 }), job({ turn: 1 }), job({ status: 'idle', turn: 1 })];
  const calls = [];
  let index = 0;
  await withFetch(async (url) => {
    calls.push({ at: Date.now(), wait: Number(new URL(url).searchParams.get('wait')) });
    return reply(sequence[Math.min(index++, sequence.length - 1)]);
  }, async () => {
    const result = await hub.waitFor('hub-wait-1', { timeoutSeconds: 100, pollMs: 30 });
    assert.equal(result.timed_out, false);
  });
  assert.equal(calls.length, 3);
  assert.ok(calls[2].at - calls[1].at >= 20, `gap was ${calls[2].at - calls[1].at}ms`);
});

test('waitFor: a 404 is surfaced as HubRequestError, not swallowed', async () => {
  await withFetch(async () => errorReply(404, 'no such job'), async () => {
    await assert.rejects(
      hub.waitFor('missing-job', { timeoutSeconds: 5 }),
      (err) => err instanceof HubRequestError && err.status === 404,
    );
  });
});

test('waitFor: aborts a hung request at the deadline', async () => {
  const started = Date.now();
  await withFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }), async () => {
    const result = await hub.waitFor('hung-job', { timeoutSeconds: 0.05, pollMs: 10 });
    assert.equal(result.timed_out, true);
    assert.equal(result.job, null);
  });
  assert.ok(Date.now() - started < 500, 'abort must fire near the deadline');
});
