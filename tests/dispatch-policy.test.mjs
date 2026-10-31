// C07/T09: installing the role must not turn every Codex turn into a
// delegation. The shipped text is the policy, so guard it like code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('install guide states the default-local rule and hard thresholds', () => {
  const doc = read('docs/install-codex.md');
  assert.match(doc, /默认自己干，派发是例外/);
  assert.match(doc, /≥3 个文件/);
  assert.match(doc, />10 分钟/);
  assert.doesNotMatch(doc, /不必征求同意|不要问“?要不要派/);
});

test('both role descriptions gate dispatch on an explicit trigger', () => {
  for (const f of ['codex/agents/ds-pro.toml', 'codex/agents/ds-flash.toml']) {
    const toml = read(f);
    assert.match(toml, /Use ONLY when the user explicitly asks/);
    assert.match(toml, />=3 files changed/);
    assert.doesNotMatch(toml, /Spawn for harder subtasks/);
  }
});
