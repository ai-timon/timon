/**
 * `windows-task-shape.ts` is a verbatim copy of the daemon's
 * `orchestrator/src/host/windows-task-shape.ts` (independent packages, as for
 * `agent-name-rule.ts`): the desktop must judge a registered task exactly as
 * `timon service status` does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { windowsTaskShape } from './windows-task-shape.js';

test('windows task shape: the copy is the daemon file, byte for byte', () => {
  const here = readFileSync(new URL('./windows-task-shape.ts', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../../orchestrator/src/host/windows-task-shape.ts', import.meta.url), 'utf8');
  assert.equal(here, source, 'copy orchestrator/src/host/windows-task-shape.ts over desktop/src/windows-task-shape.ts');
});

test('windows task shape: an interactive task running cmd.exe opens a console', () => {
  const xml = '<Task><Triggers><BootTrigger/></Triggers><Principals><Principal><LogonType>InteractiveToken</LogonType></Principal></Principals>'
    + '<Actions><Exec><Command>C:\\Windows\\System32\\cmd.exe</Command></Exec></Actions></Task>';
  assert.deepEqual(windowsTaskShape(xml), { logon: 'InteractiveToken', program: 'cmd.exe', triggers: ['Boot'], consoleVisible: true });
  assert.equal(windowsTaskShape('ERROR: The system cannot find the file specified.'), null);
});
