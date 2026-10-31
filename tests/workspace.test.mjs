// C05/T06: one workspace for every worker session. The pure resolver is the
// contract the hub pins spawns with; the installer default is what makes a
// fresh install land there without a manual step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceRootOf } from '../src/hub/index.mjs';
import { GLOBAL_CONFIG_DEFAULTS } from '../src/install/install.mjs';
import { isAbsolute } from 'node:path';

test('workspaceRootOf accepts an absolute pinned root', () => {
  assert.equal(workspaceRootOf({ workspace_root: '/root/dsh-workspaces/dsh-crew' }), '/root/dsh-workspaces/dsh-crew');
});

test('workspaceRootOf ignores blank, missing and relative values', () => {
  assert.equal(workspaceRootOf({}), null);
  assert.equal(workspaceRootOf({ workspace_root: '' }), null);
  assert.equal(workspaceRootOf({ workspace_root: '   ' }), null);
  assert.equal(workspaceRootOf({ workspace_root: 'relative/dir' }), null);
});

test('the install default pins an absolute dsh-crew workspace', () => {
  const root = GLOBAL_CONFIG_DEFAULTS.workspace_root;
  assert.ok(isAbsolute(root), `${root} is absolute`);
  assert.match(root, /dsh-crew$/);
});
