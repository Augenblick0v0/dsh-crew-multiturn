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

// T03/C04: every shipped prompt surface teaches one blocking wait, not a polling loop.
test('shipped prompt surfaces name dsh_worker_wait and the exec yield', () => {
  const surfaces = [
    'codex/agents/ds-pro.toml',
    'codex/agents/ds-flash.toml',
    'codex/prompts/dsh-playbook.md',
    'docs/install-codex.md',
  ];
  for (const f of surfaces) {
    const text = read(f);
    assert.match(text, /dsh_worker_wait/, `${f} must name dsh_worker_wait`);
    assert.match(text, /yield_time_ms/, `${f} must state the exec yield`);
  }
});

test('prompt surfaces keep the wait semantics: timeout stops, needs_input resumes once', () => {
  for (const f of ['codex/agents/ds-pro.toml', 'codex/agents/ds-flash.toml']) {
    const toml = read(f);
    assert.match(toml, /dsh_worker_wait/);
    assert.match(toml, /timeout_seconds: 1800/);
    assert.match(toml, /\/\/ @exec: \{"yield_time_ms": 1830000\}/);
    assert.match(toml, /timed_out: true[\s\S]*wait again/);
    assert.match(toml, /NEVER call `dsh_worker_cancel`/);
    assert.match(toml, /report_path/);
    assert.match(toml, /needs_input[\s\S]*dsh_worker_wait` once/);
    assert.doesNotMatch(toml, /dsh_worker_result` once with wait_seconds 600/);
  }
  const doc = read('docs/install-codex.md');
  assert.match(doc, /等待而不轮询/);
  assert.match(doc, /timeout_seconds × 1000 \+ 30000/);
  assert.match(doc, /1830000/);
  assert.match(doc, /timed_out: true[\s\S]*不是失败/);
  assert.match(doc, /禁止调用 `dsh_worker_cancel`/);
  assert.match(doc, /needs_input[\s\S]*dsh_worker_wait/);
});
