import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  argsUnderFence, nestedSandboxProblems, PERMISSION_MODEL_OBLIGATIONS, resolveSupportedPermissionMode, sandboxLevelForPermissionMode,
} from './permission-models.js';
import { PERMISSION_MODELS } from './types.js';

test('permission_mode maps to the three sandbox levels, defaulting to the safe middle', () => {
  assert.equal(sandboxLevelForPermissionMode('plan'), 'read-only');
  assert.equal(sandboxLevelForPermissionMode('read-only'), 'read-only');
  assert.equal(sandboxLevelForPermissionMode('bypassPermissions'), 'danger-full-access');
  for (const mode of ['auto', 'acceptEdits', 'default', undefined, 'something-new']) {
    assert.equal(sandboxLevelForPermissionMode(mode), 'workspace-write', String(mode));
  }
});

test('every permission model says what a dialect owes for it', () => {
  assert.deepEqual(Object.keys(PERMISSION_MODEL_OBLIGATIONS).sort(), [...PERMISSION_MODELS].sort());
});

test('supportedModes: a listed mode runs as itself, any other in plan, and no list changes nothing', () => {
  const two = ['plan', 'bypassPermissions'];
  assert.equal(resolveSupportedPermissionMode('bypassPermissions', two), 'bypassPermissions');
  assert.equal(resolveSupportedPermissionMode('danger-full-access', two), 'bypassPermissions', 'a sandbox name reads as its mode');
  for (const mode of ['plan', 'read-only', 'default', 'acceptEdits', 'auto', 'dontAsk', 'workspace-write', 'typo', undefined, null]) {
    assert.equal(resolveSupportedPermissionMode(mode, two), 'plan', String(mode));
  }
  assert.equal(resolveSupportedPermissionMode('auto', ['plan', 'auto']), 'auto');
  assert.equal(resolveSupportedPermissionMode('workspace-write', ['plan', 'auto']), 'auto');
  for (const mode of ['default', 'auto', 'bypassPermissions', 'typo']) {
    assert.equal(resolveSupportedPermissionMode(mode, undefined), mode);
  }
  assert.equal(resolveSupportedPermissionMode(undefined, undefined), undefined);
});

const LEVEL = { level: { flag: '--sandbox', off: 'danger-full-access', readOnly: ['read-only'] } } as const;

test('under the fence, the declared level option is turned off, in both spellings', () => {
  assert.deepEqual(argsUnderFence(['exec', '--sandbox', 'workspace-write', '-'], LEVEL),
    { args: ['exec', '--sandbox', 'danger-full-access', '-'], readOnly: false, levelMissing: false });
  assert.deepEqual(argsUnderFence(['exec', '--sandbox=workspace-write', '-'], LEVEL),
    { args: ['exec', '--sandbox=danger-full-access', '-'], readOnly: false, levelMissing: false });
});

test('a read-only level keeps the working tree read-only; the most restrictive occurrence decides', () => {
  assert.equal(argsUnderFence(['--sandbox', 'read-only'], LEVEL).readOnly, true);
  const twice = argsUnderFence(['--sandbox', 'workspace-write', '--sandbox=read-only'], LEVEL);
  assert.deepEqual(twice.args, ['--sandbox', 'danger-full-access', '--sandbox=danger-full-access']);
  assert.equal(twice.readOnly, true);
});

test('a level option missing from the launch is said, and nothing is invented', () => {
  assert.deepEqual(argsUnderFence(['exec', '-'], LEVEL), { args: ['exec', '-'], readOnly: false, levelMissing: true });
  // A dangling option has no value to replace.
  assert.equal(argsUnderFence(['exec', '--sandbox'], LEVEL).levelMissing, true);
});

test('offArgs go in front of the launch\'s own, and are never read as a level', () => {
  const declaration = { offArgs: ['--sandbox', 'read-only'], level: { flag: '--sandbox', off: 'none', readOnly: ['read-only'] } };
  assert.deepEqual(argsUnderFence(['run', '--sandbox', 'full'], declaration),
    { args: ['--sandbox', 'read-only', 'run', '--sandbox', 'none'], readOnly: false, levelMissing: false });
  assert.deepEqual(argsUnderFence(['-p'], { offArgs: ['--settings', '{}'] }).args, ['--settings', '{}', '-p']);
});

test('no declaration, no change', () => {
  const args = ['exec', '--sandbox', 'read-only'];
  const out = argsUnderFence(args, undefined);
  assert.deepEqual(out, { args, readOnly: false, levelMissing: false });
  assert.notEqual(out.args, args);
});

test('a nestedSandbox declaration is checked for its author', () => {
  assert.deepEqual(nestedSandboxProblems(LEVEL), []);
  assert.deepEqual(nestedSandboxProblems({ offArgs: ['--settings', '{"sandbox":{"enabled":false}}'] }), []);
  assert.ok(nestedSandboxProblems(null)[0]?.includes('{ level?, offArgs? }'));
  assert.ok(nestedSandboxProblems({ level: { flag: '--sandbox' } }).some((p) => p.includes('level.off')));
  assert.ok(nestedSandboxProblems({ offArgs: [] }).some((p) => p.includes('offArgs')));
  assert.ok(nestedSandboxProblems({ offArgs: Array.from({ length: 9 }, () => '-x') }).some((p) => p.includes('offArgs')));
  assert.ok(nestedSandboxProblems({ level: { flag: '--sandbox', off: 'x', readOnly: 'ro' } }).some((p) => p.includes('readOnly')));
  assert.ok(nestedSandboxProblems({ offArgs: ['-x'] }, 'nestedSandbox').every((p) => !p.includes('permission.')));
});
