/**
 * `windowsTaskShape` on the definitions issue #116 quoted, and on the two
 * shapes Timon writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTaskXml } from './service-install.js';
import { windowsProgramName, windowsTaskShape } from './windows-task-shape.js';

/** A task as `Export-ScheduledTask` prints it, with the parts the reading looks at. */
function exported(opts: { logon: string; command: string; args: string; boot?: boolean; logonTrigger?: boolean; hidden?: boolean }): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Timon orchestrator — local daemon, started at boot, runs without an open session.</Description>
  </RegistrationInfo>
  <Triggers>
    ${opts.boot === false ? '' : '<BootTrigger>\r\n      <Enabled>true</Enabled>\r\n    </BootTrigger>'}
    ${opts.logonTrigger ? '<LogonTrigger><Enabled>true</Enabled><UserId>S-1-5-21-1-2-3-1001</UserId></LogonTrigger>' : ''}
    <TimeTrigger>
      <Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-21-1-2-3-1001</UserId>
      <LogonType>${opts.logon}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    ${opts.hidden ? '<Hidden>true</Hidden>' : ''}
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${opts.command}</Command>
      <Arguments>${opts.args}</Arguments>
      <WorkingDirectory>C:\\Users\\t\\AppData\\Local\\Programs\\Timon\\resources\\orchestrator</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

const BATCH_ARGS = '/d /s /c &quot;&quot;C:\\Users\\t\\.timon\\run\\timon-service.cmd&quot;&quot;';

test('issue #116: an interactive task that starts cmd.exe shows a console', () => {
  const shape = windowsTaskShape(exported({ logon: 'InteractiveToken', command: 'cmd.exe', args: BATCH_ARGS, hidden: true }));
  assert.deepEqual(shape, { logon: 'InteractiveToken', program: 'cmd.exe', triggers: ['Boot', 'Time'], consoleVisible: true });
});

test('the same cmd.exe under S4U runs in session 0: nothing visible', () => {
  const shape = windowsTaskShape(exported({ logon: 'S4U', command: 'cmd.exe', args: BATCH_ARGS, hidden: true }));
  assert.deepEqual(shape, { logon: 'S4U', program: 'cmd.exe', triggers: ['Boot', 'Time'], consoleVisible: false });
});

test('the hidden PowerShell of revision 5 is still a console program in the session', () => {
  const shape = windowsTaskShape(exported({
    logon: 'InteractiveToken', command: 'powershell.exe', boot: false, logonTrigger: true,
    args: '-NoProfile -NonInteractive -WindowStyle Hidden -Command &quot;$i = New-Object Diagnostics.ProcessStartInfo&quot;',
  }));
  assert.deepEqual(shape, { logon: 'InteractiveToken', program: 'powershell.exe', triggers: ['Logon', 'Time'], consoleVisible: true });
});

test('Timon.exe in the session is a GUI program: no console', () => {
  const shape = windowsTaskShape(exported({
    logon: 'InteractiveToken', command: 'C:\\Users\\t\\AppData\\Local\\Programs\\Timon\\Timon.exe', boot: false, logonTrigger: true,
    args: '--timon-service &quot;C:\\Users\\t\\.timon\\run\\timon-service.json&quot;',
  }));
  assert.deepEqual(shape, { logon: 'InteractiveToken', program: 'timon.exe', triggers: ['Logon', 'Time'], consoleVisible: false });
});

test('node.exe under S4U is the boot task of revision 6; switched to the session it shows a console', () => {
  const node = 'C:\\Users\\t\\AppData\\Local\\Programs\\Timon\\resources\\node\\node.exe';
  const args = '&quot;C:\\x\\dist\\host\\windows-service-launcher.js&quot; &quot;C:\\Users\\t\\.timon\\run\\timon-service.json&quot;';
  assert.deepEqual(windowsTaskShape(exported({ logon: 'S4U', command: node, args })),
    { logon: 'S4U', program: 'node.exe', triggers: ['Boot', 'Time'], consoleVisible: false });
  assert.equal(windowsTaskShape(exported({ logon: 'InteractiveToken', command: node, args }))?.consoleVisible, true);
});

test('what Timon renders reads back as what it asked for', () => {
  const opts = {
    userName: 'tester', userId: 'S-1-5-21-1-2-3-1001', timonHome: 'C:\\Users\\t\\.timon',
    installDir: 'C:\\Program Files\\Timon\\resources\\orchestrator', nodePath: 'C:\\Program Files\\Timon\\resources\\node\\node.exe',
  };
  assert.deepEqual(windowsTaskShape(renderTaskXml({ ...opts, offSession: true })),
    { logon: 'S4U', program: 'node.exe', triggers: ['Boot', 'Time'], consoleVisible: false });
  assert.deepEqual(windowsTaskShape(renderTaskXml({ ...opts, offSession: false })),
    { logon: 'InteractiveToken', program: 'timon.exe', triggers: ['Logon', 'Time'], consoleVisible: false });
});

test('a password logon runs off session; an unknown logon is never judged visible', () => {
  assert.equal(windowsTaskShape(exported({ logon: 'Password', command: 'cmd.exe', args: '' }))?.consoleVisible, false);
  const unknown = windowsTaskShape(exported({ logon: 'InteractiveTokenOrPassword', command: 'cmd.exe', args: '' }));
  assert.equal(unknown?.logon, 'unknown');
  assert.equal(unknown?.consoleVisible, false);
});

test('what is not a definition reads as none, and a missing program never throws', () => {
  for (const text of [null, undefined, '', 'ERROR: The system cannot find the file specified.', 'Status: Running']) {
    assert.equal(windowsTaskShape(text), null, String(text));
  }
  const noAction = windowsTaskShape('<Task><Principals><Principal><LogonType>InteractiveToken</LogonType></Principal></Principals></Task>');
  assert.deepEqual(noAction, { logon: 'InteractiveToken', program: null, triggers: [], consoleVisible: false });
  assert.equal(windowsTaskShape('<Task><Actions><Exec><Command>   </Command></Exec></Actions></Task>')?.program, null);
});

test('program names: quotes, either separator, a bare name, any case', () => {
  assert.equal(windowsProgramName('"C:\\Windows\\System32\\CMD.EXE"'), 'cmd.exe');
  assert.equal(windowsProgramName('&quot;C:/Program Files/PowerShell/7/pwsh.exe&quot;'), 'pwsh.exe');
  assert.equal(windowsProgramName('%SystemRoot%\\system32\\conhost'), 'conhost.exe');
  assert.equal(windowsProgramName(null), null);
  assert.equal(windowsProgramName(''), null);
});
