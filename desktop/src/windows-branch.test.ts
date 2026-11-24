import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowsStartBranch, type WindowsStartFacts } from './windows-branch.js';

const base: WindowsStartFacts = { taskExists: false, revisionRecorded: false, rewrite: 'none', heldOut: false };
const branch = (facts: Partial<WindowsStartFacts>) => windowsStartBranch({ ...base, ...facts }).branch;

/**
 * #116, PC A: the task is there, no revision was recorded and the config says
 * `supervisor none`. The embedded daemon used to take the home, and the task
 * was refused it every five minutes.
 */
test('windows #116, PC A: a task without a revision is rewritten, then serves; declined, it serves as it is', () => {
  const pcA: Partial<WindowsStartFacts> = { taskExists: true, revisionRecorded: false };
  assert.equal(branch({ ...pcA, rewrite: 'pending' }), 'rewrite');
  // Accepted: the runner recorded the revision.
  assert.equal(branch({ ...pcA, revisionRecorded: true, rewrite: 'done' }), 'service');
  assert.equal(branch({ ...pcA, revisionRecorded: true, rewrite: 'done', start: 'started' }), 'service');
  // Declined: the task in place still runs, so it serves, not a second daemon.
  const declined = windowsStartBranch({ ...base, ...pcA, rewrite: 'failed' });
  assert.equal(declined.branch, 'service');
  assert.match(declined.reason, /declined/);
  assert.equal(branch({ ...pcA, rewrite: 'failed', start: 'started' }), 'service');
  // Windows never starts it for this account: the embedded daemon, and the task off.
  assert.equal(branch({ ...pcA, rewrite: 'failed', start: 'never-ran' }), 'disable-task');
  // Declined at an earlier launch of this version: not asked again, the task serves.
  const remembered = windowsStartBranch({ ...base, ...pcA, rewrite: 'declined' });
  assert.equal(remembered.branch, 'service');
  assert.match(remembered.reason, /declined for this version/);
  assert.equal(branch({ ...pcA, rewrite: 'declined', start: 'never-ran' }), 'disable-task');
});

/** #116, PC B: revision 5, interactive token + cmd.exe, its daemon already up. */
test('windows #116, PC B: the console task is rewritten, then its service serves', () => {
  const pcB: Partial<WindowsStartFacts> = { taskExists: true, revisionRecorded: true };
  assert.equal(branch({ ...pcB, rewrite: 'pending' }), 'rewrite');
  assert.equal(branch({ ...pcB, rewrite: 'done' }), 'service');
  assert.equal(branch({ ...pcB, rewrite: 'failed' }), 'service', 'declined: the old task still serves, never a second daemon');
  assert.equal(branch({ ...pcB, rewrite: 'unusable' }), 'embedded', 'the runner left no task: the embedded daemon');
});

test('windows: no task means the embedded daemon, and a refused home proves a task', () => {
  const none = windowsStartBranch(base);
  assert.deepEqual(none, { branch: 'embedded', reason: 'no task' });
  assert.equal(branch({ heldOut: true }), 'service', 'both lookups failed, yet its daemon was refused the home');
  assert.equal(branch({ revisionRecorded: true, start: 'needs-repair' }), 'embedded', 'the revision outlived its task');
});

test('windows: a task that never ran is disabled, unless its daemon was refused the home lately', () => {
  assert.equal(branch({ taskExists: true, revisionRecorded: true, start: 'never-ran' }), 'disable-task');
  const kept = windowsStartBranch({ ...base, taskExists: true, revisionRecorded: true, start: 'never-ran', heldOut: true });
  assert.equal(kept.branch, 'embedded');
  assert.match(kept.reason, /kept enabled/);
});

test('windows: every verdict says why', () => {
  const rewrites = ['none', 'pending', 'done', 'failed', 'unusable', 'declined'] as const;
  const starts = [undefined, 'started', 'needs-repair', 'never-ran'] as const;
  for (const rewrite of rewrites) for (const start of starts) for (const taskExists of [false, true]) for (const heldOut of [false, true]) {
    const verdict = windowsStartBranch({ taskExists, revisionRecorded: taskExists, rewrite, heldOut, ...(start ? { start } : {}) });
    assert.ok(verdict.reason.length > 0, JSON.stringify({ rewrite, start, taskExists, heldOut }));
  }
});
