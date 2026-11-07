import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRegistry } from '../src/hub/index.mjs';

// Model preparation freezes the route and effort before agent/request in DSH
// 0.2.2. Exercise dispatch and resume against that contract, including a stale
// selection restored from a previous session.
function fixture(expected, { modern = true, contextOnly = false } = {}) {
  const selections = [];
  const makeHandle = async (options, resumed = false) => {
    const handlers = new Map();
    let selected = resumed
      ? { provider: 'old-provider', model: 'old-model', reasoningEffort: 'high' }
      : { ...options.agentOptions };
    const agent = {
      session: { id: options.sessionId ?? options.resumeSessionId },
      ...(modern ? { model: { select(value) { selected = { ...value }; selections.push(selected); } } } : {}),
      async whenIdle() {},
      async followup() {
        const fixed = { ...selected };
        for (const fn of handlers.get('system-prompt/assemble') ?? []) {
          await fn({}, {}, async () => ({ variables: {} }));
        }
        let proposed = { ...fixed };
        for (const fn of handlers.get('agent/request') ?? []) {
          const seed = proposed;
          proposed = await fn({}, async () => seed);
        }
        if (modern) {
          assert.equal(proposed.reasoningEffort, fixed.reasoningEffort,
            `agent/request proposed reasoning effort "${proposed.reasoningEffort}" after step preparation fixed "${fixed.reasoningEffort ?? 'adapter default'}"`);
          assert.deepEqual(proposed, fixed, 'request hooks must preserve the prepared model selection');
        }
        assert.deepEqual(proposed, expected);
        for (const fn of handlers.get('session/event') ?? []) {
          fn({}, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
        }
      },
    };
    await options.setup({ on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    } }, contextOnly ? undefined : agent);
    return { agent, async dispose() {} };
  };
  const ctx = {
    get() {}, logger: {}, sessions: { async flush() {} },
    agents: { create: (o) => makeHandle(o), resume: (o) => makeHandle(o, true) },
  };
  return { reg: new WorkerRegistry(ctx, { publish() {} }), selections };
}

async function exercise(tier, effort, options) {
  const expected = { provider: 'custom-provider', model: `custom-${tier}`, reasoningEffort: effort };
  const { reg, selections } = fixture(expected, options);
  const job = await reg.spawn({ task: 'first', tier, effort,
    provider: expected.provider, model: expected.model, cwd: '/tmp/crew-model-test' });
  try {
    await job.promise;
    assert.equal(job.status, 'idle', job.error);
    await reg.runTurn(job, 'follow-up');
    assert.equal(job.status, 'idle', job.error);
    job.status = 'done';
    await reg.runTurn(job, 'resume');
    assert.equal(job.status, 'idle', job.error);
    assert.equal(job.turns.length, 3, 'dispatch, follow-up and resume all completed');
    assert.equal(selections.length, options?.modern === false ? 0 : 2,
      'modern hosts select during create and resume, older hosts use request hooks');
  } finally {
    reg.clearIdleTimer(job);
    await job.handle?.dispose();
  }
}

for (const tier of ['flash', 'pro']) {
  for (const effort of ['off', 'high', 'max']) {
    test(`DSH 0.2.2: ${tier}/${effort} selected before preparation on dispatch, follow-up and resume`,
      () => exercise(tier, effort));
  }
}

test('older host without Agent.model preserves explicit route and effort',
  () => exercise('flash', 'max', { modern: false }));

test('older context-only setup callback preserves explicit route and effort',
  () => exercise('pro', 'high', { modern: false, contextOnly: true }));
