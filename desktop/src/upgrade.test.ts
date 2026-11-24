import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesktopConfig } from './config.js';
import {
  activeReleaseFile,
  clearServiceRefused,
  declineServiceRepair,
  markServiceRefusedNotice,
  packagedReleaseId,
  recordServiceRefused,
  serviceRefusedMessage,
  serviceRefusedNoticeDue,
  serviceRepairDeclinedFile,
  serviceRepairFailureMessage,
  serviceRepairPrompt,
  serviceRepairVerdict,
  serviceRepairWanted,
  serviceUpgradeNeeded,
  upgradeFailureMessage,
  runnerFailureReason,
  upgradeNeedsFallback,
  upgradePackagedService,
  windowsSessionIntent,
  declineWindowsRewrite,
  windowsRewriteDeclined,
  windowsTaskRepair,
  DESKTOP_SESSION_INTENT_ENV,
  UPGRADE_SESSION_FALLBACK_LINE,
  sessionFallbackMessage,
} from './upgrade.js';
import { windowsTaskShape } from './windows-task-shape.js';
import { WINDOWS_SERVICE_REVISION, hasDesktopService, windowsBatchLauncher, windowsLauncher, windowsLegacyLauncher, windowsRewriteDeclinedFile, windowsServiceRefusedFile, windowsServiceRevisionFile } from './service.js';

const cfg: DesktopConfig = {
  home: '/Users/sam/.timon', packagedDefaults: false,
  daemon: { listen: { host: '127.0.0.1', port: 3010 }, supervisor: 'launchd', heapMb: 4096, installDir: '/old' },
  app: { enabled: true, listen: { host: '127.0.0.1', port: 3110 } },
};

test('a legacy service or one from another version is migrated on the next launch', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-upgrade-'));
  try {
    const facts = { platform: 'darwin' as NodeJS.Platform, packaged: true, serviceInstalled: true };
    assert.equal(serviceUpgradeNeeded(home, '0.1.1', facts), true);
    mkdirSync(join(home, 'desktop-runtime'), { recursive: true });
    writeFileSync(activeReleaseFile(home), `${packagedReleaseId('0.1.0')}\n`);
    assert.equal(serviceUpgradeNeeded(home, '0.1.1', facts), true);
    writeFileSync(activeReleaseFile(home), `${packagedReleaseId('0.1.1')}\n`);
    assert.equal(serviceUpgradeNeeded(home, '0.1.1', facts), false);
    assert.equal(serviceUpgradeNeeded(home, '0.1.1', { ...facts, packaged: false }), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an older version reinstalled takes over the service too (rollback)', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-downgrade-'));
  try {
    mkdirSync(join(home, 'desktop-runtime'), { recursive: true });
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const facts = { platform, packaged: true, serviceInstalled: true };
      // The service runs 0.1.2; the tester reinstalled 0.1.1.
      writeFileSync(activeReleaseFile(home), `${packagedReleaseId('0.1.2')}\n`);
      assert.equal(serviceUpgradeNeeded(home, '0.1.1', facts), true, `${platform} back to 0.1.1`);
      writeFileSync(activeReleaseFile(home), `${packagedReleaseId('0.1.1')}\n`);
      assert.equal(serviceUpgradeNeeded(home, '0.1.2', facts), true, `${platform} forward again to 0.1.2`);
      assert.equal(serviceUpgradeNeeded(home, '0.1.1', facts), false, `${platform} already back on 0.1.1`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the upgrade runs only the runner shipped by the new app', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-upgrade-runner-'));
  try {
    const resourcesPath = join(root, 'Resources');
    const runner = join(resourcesPath, 'orchestrator', 'dist', 'host', 'packaged-upgrade-runner.js');
    mkdirSync(join(resourcesPath, 'orchestrator', 'dist', 'host'), { recursive: true });
    writeFileSync(runner, '');
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    await upgradePackagedService(cfg, { execPath: '/Applications/Timon.app/Contents/MacOS/Timon', resourcesPath, version: '0.1.1' }, async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return { stdout: '', stderr: '' };
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, '/Applications/Timon.app/Contents/MacOS/Timon');
    assert.deepEqual(calls[0]?.args, [runner]);
    assert.equal(calls[0]?.env['ELECTRON_RUN_AS_NODE'], '1');
    assert.equal(calls[0]?.env['TIMON_DESKTOP_VERSION'], '0.1.1');
    assert.equal(calls[0]?.env['TIMON_INSTALL_DIR'], join(resourcesPath, 'orchestrator'));
    assert.equal(calls[0]?.env['TIMON_HOME'], cfg.home);
    assert.equal(calls[0]?.env['TIMON_DESKTOP_UPGRADE'], '1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('macOS and Linux migrate a packaged release; the portable mode and dev never do', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-upgrade-matrix-'));
  try {
    for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      // Windows runs INSTDIR, not a staged copy: guarded by the onboarding test
      // "packaged windows: the service launches the install folder…". Its
      // task revision is covered by the next test.
      const staged = platform !== 'win32';
      for (const packaged of [true, false]) {
        for (const serviceInstalled of [true, false]) {
          rmSync(join(home, 'desktop-runtime'), { recursive: true, force: true });
          const facts = { platform, packaged, serviceInstalled };
          const expected = staged && packaged && serviceInstalled;
          assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), expected, `${platform} packaged=${packaged} service=${serviceInstalled}, no active-release`);
          mkdirSync(join(home, 'desktop-runtime'), { recursive: true });
          writeFileSync(activeReleaseFile(home), `${packagedReleaseId('0.1.0')}\n`);
          assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), expected, `${platform} packaged=${packaged} service=${serviceInstalled}, previous release`);
          writeFileSync(activeReleaseFile(home), packagedReleaseId('0.2.0'));
          assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), false, `${platform} already on this release`);
        }
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/**
 * Windows: an update replaces the files, never the registered task. The logon
 * task of revision 1 died at logoff and recorded no revision; it is rewritten
 * once, and never is a task installed where there was none.
 */
test('windows: the task is rewritten as long as its revision is not the current one', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-upgrade-windows-'));
  try {
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, serviceInstalled: false };
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), false, 'no task, nothing to migrate');
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(windowsLegacyLauncher(home), "' revision 1");
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), true, 'revision 1');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...facts, packaged: false }), false, 'dev and portable: never');
    writeFileSync(windowsServiceRevisionFile(home), '1\n');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), true, 'an older recorded revision');
    writeFileSync(windowsServiceRevisionFile(home), `${WINDOWS_SERVICE_REVISION}\n`);
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), false, 'already migrated');
    writeFileSync(windowsServiceRevisionFile(home), '3\n');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), true, 'revision 3: the task has no SID yet (TODO #564)');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...facts, packaged: false }), false, 'revision 3, dev and portable: never');
    // Revision 5 ran a batch through cmd.exe or a hidden PowerShell, which Avast and AVG quarantine.
    writeFileSync(windowsServiceRevisionFile(home), '5\n');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), true, 'revision 5: the task still runs the batch');
    assert.notEqual(WINDOWS_SERVICE_REVISION, '5');
    writeFileSync(windowsServiceRevisionFile(home), 'restored\n');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), true, 'a rollback put an older task back: try again');
    assert.equal(hasDesktopService(home, 'win32'), true, 'and that task is still there');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/**
 * #116, PC A: Task Scheduler has the task, but no revision was recorded (the
 * install verdict removed it, then the task was changed by hand to run), so it
 * was never rewritten and looped on the embedded daemon's home.
 */
test('windows #116: a task that exists without a revision is rewritten, and none is installed where there is none', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-upgrade-norevision-'));
  try {
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, serviceInstalled: false };
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...facts, taskExists: true }), true, 'a task, no revision: rewrite it');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...facts, taskExists: false }), false, 'no task, no revision: never install');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), false, 'task state unknown: nothing assumed');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...facts, taskExists: true, packaged: false }), false, 'dev and portable: never');
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(windowsServiceRevisionFile(home), `${WINDOWS_SERVICE_REVISION}\n`);
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...facts, taskExists: true }), false, 'the current revision recorded: nothing to do');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/**
 * TIM-0087: `timon service install` from the CLI of 0.1.3 and earlier recorded
 * revision 3 with a launcher that does not mark its daemon as packaged. The
 * revision alone never had it rewritten.
 */
test('windows: an up-to-date task whose launcher is not marked packaged is rewritten', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-upgrade-unmarked-'));
  const launcher = (marked: boolean) => ['@echo off', 'chcp 65001 >nul', 'set "TIMON_HOME=C:\\Users\\sam\\.timon"',
    ...(marked ? ['set "TIMON_DESKTOP_SERVICE=1"', 'set "TIMON_DESKTOP_EMBEDDED=0"'] : []), 'set "PORT=3010"', ''].join('\r\n');
  try {
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, serviceInstalled: true };
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(windowsBatchLauncher(home), launcher(false));
    assert.equal(serviceUpgradeNeeded(home, '0.1.5', facts), false, 'a launcher without a task: never install one');
    writeFileSync(windowsServiceRevisionFile(home), `${WINDOWS_SERVICE_REVISION}\n`);
    assert.equal(serviceUpgradeNeeded(home, '0.1.5', facts), true, 'current revision, unmarked launcher');
    assert.equal(serviceUpgradeNeeded(home, '0.1.5', { ...facts, packaged: false }), false, 'dev and portable: never');
    writeFileSync(windowsBatchLauncher(home), launcher(true));
    assert.equal(serviceUpgradeNeeded(home, '0.1.5', facts), false, 'current revision, marked launcher (CRLF)');
    // The configuration of revision 6 is read first, as the host adapter does.
    const config = (env: Record<string, string>) => `${JSON.stringify({ format: 1, node: 'C:\\T\\resources\\node\\node.exe', env }, null, 2)}\n`;
    writeFileSync(windowsLauncher(home), config({ TIMON_HOME: 'C:\\Users\\sam\\.timon' }));
    assert.equal(serviceUpgradeNeeded(home, '0.1.5', facts), true, 'an unmarked configuration, whatever the batch says');
    writeFileSync(windowsLauncher(home), config({ TIMON_DESKTOP_SERVICE: '1', TIMON_DESKTOP_EMBEDDED: '0' }));
    assert.equal(serviceUpgradeNeeded(home, '0.1.5', facts), false, 'a marked configuration');
    rmSync(windowsLauncher(home));
    rmSync(windowsBatchLauncher(home));
    assert.equal(serviceUpgradeNeeded(home, '0.1.5', facts), false, 'current revision, no launcher to judge');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a migration failure says what still runs and that the data is intact', () => {
  const failure = Object.assign(new Error('Command failed: Timon runner.js'), {
    code: 1,
    stderr: 'the new release of the service did not answer. The previous service was restored.\n',
  });
  assert.equal(upgradeNeedsFallback(failure), false);
  const { message, detail } = upgradeFailureMessage(failure, '0.2.0', '/home/sam/.timon', 'en');
  assert.match(message, /0\.2\.0/);
  assert.match(detail, /background service it already had/);
  assert.match(detail, /\/home\/sam\/\.timon were not modified/);
  assert.match(detail, /did not answer\. The previous service was restored\.$/);
  assert.match(upgradeFailureMessage(new Error('spawn ENOENT'), '0.2.0', '/h', 'en').detail, /spawn ENOENT$/);

  // Exit 2: no service left to boot on, the embedded daemon takes over.
  const orphan = Object.assign(new Error('Command failed'), {
    code: 2,
    stderr: 'There was no previous service definition to restore, so the new one was removed.',
  });
  assert.equal(upgradeNeedsFallback(orphan), true);
  assert.match(upgradeFailureMessage(orphan, '0.2.0', '/h', 'en').detail, /built-in daemon for this session.*were not modified/s);
  assert.match(upgradeFailureMessage(orphan, '0.2.0', '/h', 'fr').detail, /daemon intégré pour cette session.*n’ont pas été modifiés\.\n\nThere was no previous/s); // french-ok: the French locale under test
  assert.equal(upgradeFailureMessage(orphan, '0.2.0', '/h', 'fr').message, 'Le service d’arrière-plan n’a pas pu passer à la version 0.2.0.'); // french-ok: the French locale under test
  assert.equal(upgradeNeedsFallback(new Error('spawn ENOENT')), false);
  assert.equal(upgradeNeedsFallback(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), false);
});

test('an uncaught runner error shows its message, not the minified source line', () => {
  const stderr = [
    'file:///Applications/Timon.app/Contents/Resources/orchestrator/dist/data-version.js:1',
    `const _0x653e97=_0x3eb8;${'x'.repeat(4000)}`,
    '                                                  ^',
    '',
    'DataUpdatePendingError: Timon 0.1.1-rc.4 is waiting for update approval.',
    '    at assertDataUpdateApproved (file:///Applications/Timon.app/dist/data-version.js:1:9)',
    '    at file:///Applications/Timon.app/dist/db.js:1:42',
    '',
    'Node.js v22.20.0',
  ].join('\n');
  assert.equal(runnerFailureReason(stderr), 'DataUpdatePendingError: Timon 0.1.1-rc.4 is waiting for update approval.');
  const failure = Object.assign(new Error('Command failed'), { code: 1, stderr });
  assert.match(upgradeFailureMessage(failure, '0.1.1-rc.4', '/h', 'en').detail, /not modified\.\n\nDataUpdatePendingError: [^\n]+$/);
  // The runner's own messages come through unchanged.
  assert.equal(runnerFailureReason('the new release of the service did not answer.\n'), 'the new release of the service did not answer.');
});

test('Windows: a configured install whose task disappeared offers to reinstall it', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-repair-'));
  try {
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, configured: true, taskExists: false };
    assert.equal(serviceRepairWanted(home, '0.1.5', facts), true);
    assert.equal(serviceRepairWanted(home, '0.1.5', { ...facts, taskExists: true }), false, 'task present');
    assert.equal(serviceRepairWanted(home, '0.1.5', { ...facts, configured: false }), false, 'first run: the wizard installs it');
    assert.equal(serviceRepairWanted(home, '0.1.5', { ...facts, packaged: false }), false, 'source checkout');
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      assert.equal(serviceRepairWanted(home, '0.1.5', { ...facts, platform }), false, platform);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('"Not now" does not ask again for this version, the next one asks again', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-repair-'));
  try {
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, configured: true, taskExists: false };
    declineServiceRepair(home, '0.1.5');
    assert.equal(serviceRepairDeclinedFile(home), join(home, 'run', 'service-repair-declined'));
    assert.equal(serviceRepairWanted(home, '0.1.5', facts), false);
    assert.equal(serviceRepairWanted(home, '0.1.6', facts), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/**
 * TODO #342: Windows never launched the task for this account (machine joined to
 * Entra ID). The finding is lasting: no more reinstall offer, and the
 * honest message is said only once per version.
 */
test('Windows: a task that never ran is no longer offered again, its message is said once per version', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-refused-'));
  try {
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, configured: true, taskExists: false };
    assert.equal(serviceRepairWanted(home, '0.1.5', facts), true);
    recordServiceRefused(home);
    assert.equal(existsSync(windowsServiceRefusedFile(home)), true);
    assert.equal(serviceRepairWanted(home, '0.1.5', facts), false, 'a task Windows will not run is not offered again');
    recordServiceRefused(home);

    assert.equal(serviceRefusedNoticeDue(home, '0.1.5'), true);
    markServiceRefusedNotice(home, '0.1.5');
    assert.equal(serviceRefusedNoticeDue(home, '0.1.5'), false);
    assert.equal(serviceRefusedNoticeDue(home, '0.1.6'), true);

    const en = serviceRefusedMessage('en-US');
    assert.match(en.detail, /Microsoft Entra ID/);
    assert.match(en.detail, /built-in daemon/);
    assert.match(en.detail, /timon service uninstall/);
    assert.doesNotMatch(en.message, /does not answer/);
    assert.match(serviceRefusedMessage('fr-FR').message, /Windows ne lance pas/); // french-ok: the French locale under test
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/** TODO #342 continued: a task that ends up running lifts the finding, otherwise the setup stays in portable mode. */
test('Windows: a task that starts clears the refusal marker', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-refused-'));
  try {
    clearServiceRefused(home);
    recordServiceRefused(home);
    clearServiceRefused(home);
    assert.equal(existsSync(windowsServiceRefusedFile(home)), false);
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, configured: true, taskExists: false };
    assert.equal(serviceRepairWanted(home, '0.1.5', facts), true, 'the repair offer speaks again');
  } finally { rmSync(home, { recursive: true, force: true }); }

  // The start clears it on 'started', and only there: 'never-ran' writes it.
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const neverRan = main.indexOf("service === 'never-ran'");
  const cleared = main.indexOf('clearServiceRefused(cfg.home)');
  assert.ok(neverRan > 0 && cleared > neverRan, 'cleared after the never-ran branch');
  assert.ok(cleared < main.indexOf('waitForHealth(daemonOrigin, SERVICE_BOOT_BUDGET_MS)', neverRan), 'in the started branch');
  assert.equal(main.indexOf('clearServiceRefused(cfg.home)', cleared + 1), -1);
});

test('repair offer and failure: localised texts, runner reason without a stack', () => {
  assert.deepEqual(serviceRepairPrompt('fr-FR').buttons, ['Réinstaller le service', 'Plus tard']); // french-ok: the French locale under test
  assert.deepEqual(serviceRepairPrompt('en-US').buttons, ['Reinstall the service', 'Not now']);
  const error = Object.assign(new Error('Command failed'), {
    stderr: 'Error: elevation refused\n    at run (file:///x.js:1:1)\nNode.js v24.19.0',
  });
  const failure = serviceRepairFailureMessage(error, 'C:\\Users\\sam\\.timon', 'en');
  assert.match(failure.detail, /built-in daemon for this session/);
  assert.match(failure.detail, /Error: elevation refused$/);
  assert.doesNotMatch(failure.detail, /\bat run\b/);
});

test('TIM-0108: the repair verdict says why the offer stays silent', t => {
  const home = mkdtempSync(join(tmpdir(), 'timon-verdict-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'run'), { recursive: true });
  const facts = { platform: 'win32' as const, packaged: true, configured: true, taskExists: false };
  assert.equal(serviceRepairVerdict(home, '0.1.5', facts), 'wanted');
  assert.equal(serviceRepairVerdict(home, '0.1.5', { ...facts, taskExists: true }), 'task-exists');
  assert.equal(serviceRepairVerdict(home, '0.1.5', { ...facts, configured: false }), 'not-configured');
  assert.equal(serviceRepairVerdict(home, '0.1.5', { ...facts, packaged: false }), 'not-applicable');
  declineServiceRepair(home, '0.1.5');
  assert.equal(serviceRepairVerdict(home, '0.1.5', facts), 'declined');
  recordServiceRefused(home);
  assert.equal(serviceRepairVerdict(home, '0.1.5', facts), 'refused');
});

/** The shapes of #116: S4U written by Timon, then switched by hand to the interactive token. */
const taskXml = (logon: string, command: string, trigger: 'Boot' | 'Logon') => `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><${trigger}Trigger><Enabled>true</Enabled></${trigger}Trigger><TimeTrigger><Repetition><Interval>PT5M</Interval></Repetition></TimeTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-21-1</UserId><LogonType>${logon}</LogonType></Principal></Principals>
  <Actions Context="Author"><Exec><Command>${command}</Command></Exec></Actions>
</Task>`;

test('windows #116: a task that opens a console is rewritten whatever its revision says', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-upgrade-console-'));
  try {
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(windowsServiceRevisionFile(home), `${WINDOWS_SERVICE_REVISION}\n`);
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, serviceInstalled: true, taskExists: true };
    const pcB = windowsTaskShape(taskXml('InteractiveToken', 'C:\\Windows\\System32\\cmd.exe', 'Boot'));
    assert.equal(pcB?.consoleVisible, true);
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...facts, taskShape: pcB }), true, 'interactive + cmd.exe, current revision');
    const node = windowsTaskShape(taskXml('InteractiveToken', 'C:\\Timon\\resources\\node\\node.exe', 'Boot'));
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...facts, taskShape: node }), true, 'interactive + node.exe, revision 6 changed by hand');
    const s4u = windowsTaskShape(taskXml('S4U', 'C:\\Timon\\resources\\node\\node.exe', 'Boot'));
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...facts, taskShape: s4u }), false, 'S4U + node.exe: what Timon writes');
    const session = windowsTaskShape(taskXml('InteractiveToken', 'C:\\Timon\\Timon.exe', 'Logon'));
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...facts, taskShape: session }), false, 'the session task opens no console');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...facts, taskShape: null }), false, 'unreadable: the revision decides');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...facts, packaged: false, taskShape: pcB }), false, 'dev and portable: never');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/**
 * A repair declined at launch used to ask for elevation again at every launch,
 * as tiresome as the console it fixes. Remembered for the version: the next
 * one asks again, an explicit install removes the file (host adapter).
 */
test('windows #116: a declined repair is not asked again in the same version, and is at the next one', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-upgrade-declined-'));
  try {
    const pcA = { platform: 'win32' as NodeJS.Platform, packaged: true, serviceInstalled: false, taskExists: true };
    assert.equal(windowsTaskRepair(home, pcA), true, 'a task without a revision: a repair');
    assert.equal(windowsRewriteDeclined(home, '0.2.0'), false);
    declineWindowsRewrite(home, '0.2.0');
    assert.equal(readFileSync(windowsRewriteDeclinedFile(home), 'utf8'), '0.2.0\n');
    assert.equal(windowsRewriteDeclinedFile(home), join(home, 'run', 'service-rewrite-declined'));
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', pcA), false, 'declined for this version: not asked again');
    assert.equal(serviceUpgradeNeeded(home, '0.2.1', pcA), true, 'the next version asks again');

    // PC B: a console task, whatever its revision, is a repair too.
    writeFileSync(windowsServiceRevisionFile(home), '5\n');
    const pcB = { ...pcA, serviceInstalled: true, taskShape: windowsTaskShape(taskXml('InteractiveToken', 'cmd.exe', 'Boot')) };
    assert.equal(windowsTaskRepair(home, pcB), true);
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', pcB), false);
    assert.equal(serviceUpgradeNeeded(home, '0.2.1', pcB), true);
    // A revision upgrade of a task that opens no console is no repair: the marker is not read.
    assert.equal(windowsTaskRepair(home, { ...pcA, taskShape: windowsTaskShape(taskXml('S4U', 'node.exe', 'Boot')) }), false);
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...pcA, serviceInstalled: true }), true, 'revision 5: still moved to 6');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/**
 * The revision-1 logon task records no revision either, but its launcher
 * marks it: moving it is a migration, which an approved update cannot skip
 * (a failure still fails the update, as before #116).
 */
test('windows #116: the revision-1 migration is no repair', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-upgrade-legacy-'));
  try {
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(windowsLegacyLauncher(home), 'x');
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, serviceInstalled: false, taskExists: true };
    assert.equal(windowsTaskRepair(home, facts), false);
    declineWindowsRewrite(home, '0.2.0');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), true, 'never silenced by a declined repair');
    assert.equal(windowsTaskRepair(home, { taskExists: false }), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('windows #116: the boot trigger of a console task says it was meant to run logged out', () => {
  assert.equal(windowsSessionIntent(windowsTaskShape(taskXml('InteractiveToken', 'cmd.exe', 'Boot'))), 'always');
  assert.equal(windowsSessionIntent(windowsTaskShape(taskXml('InteractiveToken', 'cmd.exe', 'Logon'))), 'session');
  assert.equal(windowsSessionIntent(windowsTaskShape(taskXml('S4U', 'cmd.exe', 'Boot'))), undefined, 'no console: the runner reads the task');
  assert.equal(windowsSessionIntent(windowsTaskShape(taskXml('InteractiveToken', 'Timon.exe', 'Logon'))), undefined);
  assert.equal(windowsSessionIntent(null), undefined);
});

test('windows #116: the intent reaches the runner under the name the host adapter reads', async () => {
  const source = readFileSync(new URL('../../orchestrator/src/host/packaged-upgrade.ts', import.meta.url), 'utf8');
  assert.equal(/export const DESKTOP_SESSION_INTENT_ENV = '([^']+)'/.exec(source)?.[1], DESKTOP_SESSION_INTENT_ENV);
  const root = mkdtempSync(join(tmpdir(), 'timon-upgrade-intent-'));
  try {
    const resourcesPath = join(root, 'resources');
    mkdirSync(join(resourcesPath, 'orchestrator', 'dist', 'host'), { recursive: true });
    writeFileSync(join(resourcesPath, 'orchestrator', 'dist', 'host', 'packaged-upgrade-runner.js'), '');
    const envs: NodeJS.ProcessEnv[] = [];
    const record = async (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => { envs.push(options.env); return { stdout: '', stderr: '' }; };
    const input = { execPath: 'C:\\Timon\\Timon.exe', resourcesPath, version: '0.2.0' };
    await upgradePackagedService(cfg, { ...input, sessionIntent: 'always' }, record);
    await upgradePackagedService(cfg, input, record);
    assert.equal(envs[0]?.[DESKTOP_SESSION_INTENT_ENV], 'always');
    assert.equal(envs[1]?.[DESKTOP_SESSION_INTENT_ENV], undefined, 'no intent: nothing handed over');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('windows #116: a rewrite kept for the session only is read from the runner\'s line, and said in the user\'s language', async () => {
  const source = readFileSync(new URL('../../orchestrator/src/host/packaged-upgrade.ts', import.meta.url), 'utf8');
  assert.equal(/export const UPGRADE_SESSION_FALLBACK_LINE = '([^']+)'/.exec(source)?.[1], UPGRADE_SESSION_FALLBACK_LINE);
  const root = mkdtempSync(join(tmpdir(), 'timon-upgrade-fallback-'));
  try {
    const resourcesPath = join(root, 'resources');
    mkdirSync(join(resourcesPath, 'orchestrator', 'dist', 'host'), { recursive: true });
    writeFileSync(join(resourcesPath, 'orchestrator', 'dist', 'host', 'packaged-upgrade-runner.js'), '');
    const input = { execPath: 'C:\\Timon\\Timon.exe', resourcesPath, version: '0.2.0' };
    const answering = (stdout: string) => async () => ({ stdout, stderr: '' });
    assert.deepEqual(await upgradePackagedService(cfg, input, answering(`it stops at logout\r\n${UPGRADE_SESSION_FALLBACK_LINE}\r\n`)), { sessionFallback: true });
    assert.deepEqual(await upgradePackagedService(cfg, input, answering('installed\n')), { sessionFallback: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
  const en = sessionFallbackMessage('en');
  assert.match(en.message, /signed in/);
  assert.match(en.detail, /sign out/);
  assert.notEqual(sessionFallbackMessage('fr').message, en.message, 'French has its own words');
});
