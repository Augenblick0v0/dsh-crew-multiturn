// V04: GET /models — the panel's model catalog proxy.
//
// The handler is exercised directly with mock req/res objects and a fake ctx,
// so the assertions cover status codes, loopback refusal, caching and the
// "provider cannot enumerate" degradation without a real DSH runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createModelsHandler } from '../src/hub/index.mjs';

async function call(handler, {
  url, remoteAddress = '127.0.0.1', host = '127.0.0.1:3080',
} = {}) {
  const req = { method: 'GET', url, headers: { host }, socket: { remoteAddress } };
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
  return { status: res.statusCode, headers: res.headers, json };
}

function fakeCtx({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    llm: {
      listProviders: () => [{ id: 'router9', name: 'router9' }, { id: 'sub', name: 'sub' }],
      async listModels(provider) {
        calls.push(provider);
        if (fail !== null) throw new Error(fail);
        if (provider === 'sub') return [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }];
        return [{ id: 'gpt-6-sol', name: 'GPT-6 Sol' }, { id: 'gpt-6-luna' }];
      },
    },
  };
}

test('GET /models returns the provider catalog', async () => {
  const ctx = fakeCtx();
  const res = await call(createModelsHandler(ctx), { url: '/_dsh/dsh-crew/models?provider=router9' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.deepEqual(res.json.models, [{ id: 'gpt-6-sol', name: 'GPT-6 Sol' }, { id: 'gpt-6-luna', name: 'gpt-6-luna' }]);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('GET /models rejects a missing or unknown provider', async () => {
  const handler = createModelsHandler(fakeCtx());
  const missing = await call(handler, { url: '/_dsh/dsh-crew/models' });
  assert.equal(missing.status, 400);
  const unknown = await call(handler, { url: '/_dsh/dsh-crew/models?provider=nope' });
  assert.equal(unknown.status, 404);
});

test('GET /models degrades to an empty list when the provider throws', async () => {
  const res = await call(createModelsHandler(fakeCtx({ fail: 'boom' })), { url: '/_dsh/dsh-crew/models?provider=router9' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.deepEqual(res.json.models, []);
  assert.equal(res.json.error, 'boom');
});

test('GET /models caches a successful list and ?refresh=1 bypasses it', async () => {
  const ctx = fakeCtx();
  const handler = createModelsHandler(ctx);
  await call(handler, { url: '/_dsh/dsh-crew/models?provider=router9' });
  const cached = await call(handler, { url: '/_dsh/dsh-crew/models?provider=router9' });
  assert.equal(cached.json.cached, true);
  assert.equal(ctx.calls.length, 1);
  await call(handler, { url: '/_dsh/dsh-crew/models?provider=router9&refresh=1' });
  assert.equal(ctx.calls.length, 2);
});

test('GET /models refuses non-loopback callers', async () => {
  const res = await call(createModelsHandler(fakeCtx()), {
    url: '/_dsh/dsh-crew/models?provider=router9', remoteAddress: '192.168.1.9',
  });
  assert.equal(res.status, 403);
});
