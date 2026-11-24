/**
 * The "restart required" notice of a merge that touched `orchestrator/` names
 * the restart of THIS install. It used to print the source checkout's
 * `systemctl --user restart timon-orchestrator` everywhere: on a Linux package
 * the unit is `timon-desktop-<id>`, and macOS and Windows have no systemd.
 * The supervisor is injected (`setSelfRestartPortForTests`): nothing restarts.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { restartRequiredNotice } = await import('./deploy-hook.js');
const { setSelfRestartPortForTests } = await import('./onboarding-restart.js');
const { packagedUnit } = await import('./host/packaged-service.js');
const { TIMON_HOME } = await import('./paths.js');

function noticeOn(supervisor: 'systemd-user' | 'launchd' | 'windows' | null, packaged: boolean): string {
  const before = process.env.TIMON_DESKTOP_SERVICE;
  setSelfRestartPortForTests({ supervisor, canSelfRestart: false, restart: () => { throw new Error('a notice restarted the daemon'); } });
  if (packaged) process.env.TIMON_DESKTOP_SERVICE = '1';
  else delete process.env.TIMON_DESKTOP_SERVICE;
  try {
    return restartRequiredNotice('0123456789abcdef', 'feat: witness', ['orchestrator']).body;
  } finally {
    setSelfRestartPortForTests(null);
    if (before === undefined) delete process.env.TIMON_DESKTOP_SERVICE;
    else process.env.TIMON_DESKTOP_SERVICE = before;
  }
}

test('a packaged Linux service is named by its own unit', () => {
  const body = noticeOn('systemd-user', true);
  assert.ok(body.includes(`systemctl --user restart ${packagedUnit(TIMON_HOME)}`), body);
  assert.equal(body.includes('timon-orchestrator'), false, body);
});

test('a source checkout keeps its unit, and other systems get their own line', () => {
  assert.ok(noticeOn('systemd-user', false).includes('systemctl --user restart timon-orchestrator'));
  assert.match(noticeOn('launchd', true), /launchctl kickstart -k/);
  assert.match(noticeOn('windows', true), /schtasks \/End \/TN TimonOrchestrator/);
  const portable = noticeOn(null, false);
  assert.equal(portable.includes('systemctl'), false, portable);
  assert.match(portable, /quit and reopen Timon/);
});
