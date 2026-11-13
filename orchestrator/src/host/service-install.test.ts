/**
 * `timon service install|uninstall|status` (step 5.3).
 *
 * Everything runs against a temporary HOME with an injected `exec`: no test
 * ever writes a real unit, calls a real systemctl, or reads the real
 * `TIMON_HOME`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ExecResult } from './types.js';
import { packagedServiceOptions } from './packaged-service.js';
import {
  installService,
  uninstallService,
  statusService,
  renderPlist,
  renderUnit,
  plistPath,
  unitPath,
  LINUX_UNIT,
  MACOS_LABEL,
  WINDOWS_TASK,
  renderTaskXml,
  taskXmlPath,
  TASK_NEVER_RAN_KEPT,
  TASK_NEVER_RAN_REMOVED,
  TASK_VERIFY_SECONDS,
  verifyTaskStartedStep,
  WINDOWS_TASK_NEVER_RAN,
  WINDOWS_TASK_REFUSED_REASON,
  windowsTaskUserId,
  windowsTaskCommand,
  windowsLauncherPath,
  windowsServiceFiles,
  renderWindowsLauncher,
  stopLauncherStep,
  stopPortOwnerStep,
  stopInstallationProcessesStep,
  installationProcessNeedles,
  PROCESSES_REMAIN,
  serviceStoppedMarker,
  startService,
  stopService,
  windowsStartSteps,
  windowsStopSteps,
  WINDOWS_SERVICE_REVISION,
  elevatedScriptPath,
  elevatedLogPath,
  renderElevatedScript,
  parseElevatedTranscript,
  readServiceDefinition,
  removeServiceDefinition,
  restoreServiceDefinition,
  restartWindowsService,
  windowsRestartSteps,
  repairSessionWitness,
  readSessionWitnessCommand,
  windowsServiceNotes,
  type ServiceOpts,
} from './service-install.js';

/**
 * Ce que le batch élevé laisse derrière lui : une ligne par étape exécutée.
 * Une étape absente de l'objet n'a pas tourné — c'est ainsi qu'un garde se
 * prouve ici, plutôt que par un appel que le test aurait vu passer.
 */
function transcript(codes: Record<string, number>): string {
  return Object.entries(codes).map(([label, code]) => `TIMON-STEP ${label}=${code}\r\n`).join('');
}

/**
 * On a POSIX host a Windows path has no separator: writing to one creates a
 * single file named `\tmp\…\run\timon-service.vbs` in the working directory,
 * and from `orchestrator/` that is the repository (TODO #706). Read when this
 * file loads, so that a leftover from an older run is not blamed on this one.
 */
const backslashNames = (dir: string) => readdirSync(dir).filter((name) => name.includes('\\'));
const backslashNamesAtStart = new Set(backslashNames(process.cwd()));

function fixture(platform: NodeJS.Platform, exec?: (n: string, a: string[]) => ExecResult): ServiceOpts {
  const homeDir = mkdtempSync(join(tmpdir(), 'timon-service-test-'));
  const installDir = join(homeDir, 'timon', 'orchestrator');
  mkdirSync(join(installDir, 'scripts'), { recursive: true });
  writeFileSync(
    join(installDir, 'scripts', `${LINUX_UNIT}.service.template`),
    // Same placeholders as the shipped template, `@PORT@`/`@HEAP@` included:
    // a fixture that omitted them would let a renderer stop substituting them
    // without any test noticing.
    '[Service]\nWorkingDirectory=@REPO@/orchestrator\nUser=@USER@\n'
    + 'ExecStart=/usr/bin/env node --max-old-space-size=@HEAP@ dist/index.js\n'
    + 'Environment=PORT=@PORT@\n',
    'utf8',
  );
  return {
    platform,
    homeDir,
    timonHome: join(homeDir, '.timon'),
    installDir,
    userName: 'tester',
    uid: 1000,
    heapMb: 4096,
    port: 3000,
    nodePath: '/usr/bin/node',
    exec: (name, args) => {
      if (name === 'systemctl' && args.includes('show')) {
        const file = unitPath(homeDir);
        const unit = existsSync(file) ? readFileSync(file, 'utf8') : '';
        return { code: 0, stderr: '', stdout: unit
          ? `LoadState=loaded\nNeedDaemonReload=no\nActiveState=active\nWorkingDirectory=${installDir}\nEnvironment=TIMON_HOME=${join(homeDir, '.timon')}`
          : 'LoadState=not-found' };
      }
      return exec ? exec(name, args) : { code: 0, stdout: 'active', stderr: '' };
    },
  };
}

test('linux: the shipped template is rendered, linger is enabled, the unit is started', () => {
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: '', stderr: '' };
  });
  const res = installService(opts);
  assert.equal(res.ok, true);
  assert.equal(res.code, 0);

  const written = readFileSync(unitPath(opts.homeDir), 'utf8');
  assert.match(written, /WorkingDirectory=.*\/timon\/orchestrator/);
  assert.match(written, /User=tester/);
  assert.ok(!written.includes('@REPO@'), 'no placeholder left behind');

  assert.deepEqual(calls[0], ['loginctl', 'enable-linger', 'tester']);
  assert.deepEqual(calls[1], ['systemctl', '--user', 'daemon-reload']);
  assert.deepEqual(calls[2], ['systemctl', '--user', 'enable', '--now', LINUX_UNIT]);
});

test('linux: a refusing systemctl is a failure, not a silent success', () => {
  const opts = fixture('linux', (n, a) => (
    a.includes('enable') ? { code: 1, stdout: '', stderr: 'Failed to enable' } : { code: 0, stdout: '', stderr: '' }
  ));
  const res = installService(opts);
  assert.equal(res.ok, false);
  assert.equal(res.code, 1);
  assert.ok(res.lines.some((l) => l.includes('Failed to enable')));
});

test('linux: enable returning zero does not validate a malformed unit', () => {
  const opts = fixture('linux');
  opts.exec = (_name, args) => ({ code: 0, stderr: '', stdout: args.includes('show')
    ? `LoadState=${existsSync(unitPath(opts.homeDir)) ? 'bad-setting' : 'not-found'}\nNeedDaemonReload=no`
    : '' });
  const result = installService(opts);
  assert.equal(result.ok, false);
  assert.equal(result.installed, false);
  assert.match(result.reason!, /Cannot verify/);
});

test('linux: repair the known packaged template, but refuse foreign units, changed commands and drop-ins', () => {
  for (const scenario of ['ours', 'foreign', 'command', 'drop-in', 'unavailable']) {
    const base = fixture('linux');
    const opts = { ...packagedServiceOptions(base, '/package/timon', 3110), pendingHandover: true };
    const file = unitPath(opts.homeDir, opts.unitName);
    mkdirSync(join(opts.homeDir, '.config/systemd/user'), { recursive: true });
    let legacy = opts.legacyUnitContent!.replace(/^Environment="PATH=.*"$/m, 'Environment="PATH=/tmp/old-mount:/usr/bin"');
    if (scenario === 'foreign') legacy = legacy.replaceAll(opts.timonHome, '/another/home');
    if (scenario === 'command') legacy += 'ExecStartPost=/usr/bin/true\n';
    writeFileSync(file, legacy);
    const calls: string[][] = [];
    opts.exec = (name, args) => {
      calls.push([name, ...args]);
      if (!args.includes('show')) return { code: 0, stdout: '', stderr: '' };
      if (scenario === 'unavailable') return { code: 1, stdout: '', stderr: 'No bus' };
      const bad = readFileSync(file, 'utf8').includes('WorkingDirectory="');
      return { code: 0, stderr: '', stdout:
        `LoadState=${bad ? 'bad-setting' : 'loaded'}\nNeedDaemonReload=no\nActiveState=active\nUnitFileState=enabled\n`
        + `WorkingDirectory=${opts.installDir}\nEnvironment="TIMON_HOME=${opts.timonHome}"\n`
        + `FragmentPath=${file}\nDropInPaths=${scenario === 'drop-in' ? '/some/override.conf' : ''}` };
    };
    const result = installService(opts);
    assert.equal(result.ok, scenario === 'ours', scenario);
    if (scenario === 'ours') {
      assert.equal(readFileSync(file, 'utf8'), opts.unitContent);
      assert.equal(statusService(opts).installed, true);
      assert.equal(statusService(opts).ok, false, 'handover still waits for the embedded daemon');
    } else {
      assert.equal(readFileSync(file, 'utf8'), legacy);
      assert.ok(calls.every((call) => call.includes('show')), scenario);
    }
  }
});

test('a missing template refuses instead of inventing a unit', () => {
  const opts = fixture('linux');
  const res = installService({ ...opts, installDir: join(opts.homeDir, 'nowhere') });
  assert.equal(res.ok, false);
  assert.ok(res.lines.some((l) => l.includes('template not found')));
  assert.equal(existsSync(unitPath(opts.homeDir)), false);
});

test('macos: the plist declares KeepAlive, RunAtLoad and an explicit PATH', () => {
  const opts = fixture('darwin');
  const xml = renderPlist(opts);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<string>\/usr\/bin\/node<\/string>/);
  assert.match(xml, /--max-old-space-size=4096/);
  assert.match(xml, /\.local\/bin/, 'PATH must carry ~/.local/bin, where claude lives');
  assert.ok(xml.includes(join(opts.timonHome, 'tmp', 'daemon.log')));
});

test('macos: a packaged Electron daemon is forced into Node mode', () => {
  const opts = fixture('darwin');
  const xml = renderPlist({
    ...opts,
    nodePath: '/Applications/Timon.app/Contents/MacOS/Timon',
    environment: {
      ELECTRON_RUN_AS_NODE: '1',
      TIMON_INSTALL_DIR: opts.installDir,
      TIMON_DESKTOP_SERVICE: '1',
    },
  });
  assert.match(xml, /<key>ELECTRON_RUN_AS_NODE<\/key><string>1<\/string>/);
  assert.match(xml, /<key>TIMON_INSTALL_DIR<\/key>/);
  assert.match(xml, /<key>TIMON_DESKTOP_SERVICE<\/key><string>1<\/string>/);
});

test('macos: bootout precedes bootstrap so a reinstall is not an EEXIST', () => {
  const calls: string[][] = [];
  const opts = fixture('darwin', (n, a) => {
    calls.push([n, ...a]);
    return { code: a[0] === 'print' ? 113 : 0, stdout: '', stderr: '' };
  });
  const res = installService(opts);
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], ['launchctl', 'bootout', `gui/1000/${MACOS_LABEL}`]);
  assert.equal(calls[1]?.[1], 'print');
  assert.equal(calls[2]?.[1], 'bootstrap');
  assert.ok(existsSync(plistPath(opts.homeDir)));
});

test('macos: wait for asynchronous bootout completion before loading the replacement', () => {
  let polls = 0;
  let pauses = 0;
  const opts = fixture('darwin', (_name, args) => {
    if (args[0] === 'print') return { code: ++polls >= 4 ? 113 : 0, stdout: '', stderr: '' };
    if (args[0] === 'bootstrap') assert.equal(polls, 4, 'the old job must have disappeared');
    return { code: 0, stdout: '', stderr: '' };
  });
  opts.pause = (ms) => { assert.equal(ms, 100); pauses++; };
  assert.equal(installService(opts).ok, true);
  assert.equal(pauses, 3);
});

test('macos: a stuck removal or failed probe cannot bootstrap a competing instance', () => {
  for (const probeCode of [0, 1]) {
    let polls = 0;
    const opts = fixture('darwin', (_name, args) => {
      assert.notEqual(args[0], 'bootstrap');
      if (args[0] === 'print') { polls++; return { code: probeCode, stdout: '', stderr: 'probe refused' }; }
      return { code: 0, stdout: '', stderr: '' };
    });
    opts.pause = () => {};
    assert.equal(installService(opts).ok, false);
    assert.equal(polls, probeCode === 0 ? 100 : 1);
  }
});

test('macos: first install and a bootstrap refusal do not wait on a nonexistent job', () => {
  for (const bootstrapCode of [0, 5]) {
    const opts = fixture('darwin', (_name, args) => {
      assert.notEqual(args[0], 'print');
      return { code: args[0] === 'bootout' ? 3 : bootstrapCode, stdout: '', stderr: 'bootstrap refused' };
    });
    assert.equal(installService(opts).ok, bootstrapCode === 0);
  }
});

/**
 * Windows (step 5.7.2) — l'installation du service y est obligatoire comme
 * ailleurs. Amendement au plan §5.3, qui la déclarait "non supportée en v1".
 *
 * Rien de tout cela ne peut être exécuté ici : la seule vérification possible
 * est l'argv exact, et c'est précisément là que ça casse en silence (un chemin
 * `C:\Program Files\…` non quoté produit une tâche qui échoue au premier
 * logon, sans message).
 */
test('windows: la tâche planifiée est créée depuis un XML, au boot, en S4U', () => {
  const calls: string[][] = [];
  const opts = fixture('win32', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: '', stderr: '' };
  });
  const res = installService({
    ...opts,
    nodePath: 'C:\\Program Files\\Timon\\Timon.exe',
    readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.code, 0);

  const files = windowsServiceFiles(opts.timonHome, join);
  assert.equal(readFileSync(files.launcher, 'utf8'), renderWindowsLauncher({
    ...opts,
    nodePath: 'C:\\Program Files\\Timon\\Timon.exe',
  }));
  // The revision is what tells the desktop this task needs no migration.
  assert.equal(readFileSync(files.revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION);
  if (process.platform !== 'win32') {
    assert.equal(existsSync(windowsLauncherPath(opts.timonHome)), false,
      'Windows separators must not become a literal filename in the working directory');
  }

  // Three calls. First the witness, sealed in the user's OWN session: an
  // elevation may belong to another account, whose DPAPI key would never
  // open under the task's logon. The account SID, for the same reason. Then
  // ONE elevation for every schtasks step.
  assert.equal(calls.length, 3);
  assert.equal(calls[0]![0], 'powershell');
  const seal = calls[0]!.at(-1)!;
  assert.deepEqual(calls[1], ['whoami', '/user', '/fo', 'csv', '/nh']);
  assert.doesNotMatch(seal, /RunAs/);
  assert.match(seal, /ConvertFrom-SecureString/);
  assert.ok(seal.includes(files.sessionWitness), 'the witness is sealed where the launcher reads it');
  assert.equal(calls[2]![0], 'powershell');
  const command = calls[2]!.at(-1)!;
  assert.match(command, /Start-Process/);
  assert.match(command, /-Verb RunAs/);
  assert.ok(command.includes(elevatedScriptPath()), 'le script élevé est celui qui vient d\'être écrit');

  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  // `/Run` : la tâche créée ne démarrerait qu'au prochain boot, et l'écran de
  // premier lancement attend une réponse du service. Et entre les deux, le
  // daemon qu'une réinstallation remplace : IgnoreNew ignorerait `/Run`.
  // Onboarding: the embedded daemon on the port serves the wizard, never ended.
  assert.doesNotMatch(batch, /Get-NetTCPConnection/);
  const order = ['schtasks /Create /TN TimonOrchestrator /XML', 'taskkill.exe /F /T', 'schtasks /Run /TN TimonOrchestrator']
    .map((needle) => batch.indexOf(needle));
  assert.ok(order.every((at) => at >= 0), batch);
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  // La sortie de schtasks est lue telle quelle : sans cette page de code, un
  // "Accès refusé" arrive dans l'UI en "Acc?s refus?".
  assert.match(batch, /chcp 65001/);

  const xml = renderTaskXml({ ...opts, nodePath: 'C:\\Program Files\\Timon\\Timon.exe' });
  // Au boot, sans session : une tâche InteractiveToken mourait à la déconnexion.
  assert.match(xml, /<BootTrigger><Enabled>true<\/Enabled><\/BootTrigger>/);
  assert.match(xml, /<LogonType>S4U<\/LogonType>/);
  assert.doesNotMatch(xml, /LogonTrigger|InteractiveToken|<Password>/);
  // Le superviseur : une répétition sans fin que IgnoreNew écarte tant que le
  // lanceur tient un daemon vivant, et qui le relance sinon — RestartOnFailure
  // ne relance qu'un lancement raté, jamais un daemon qui tombe.
  assert.match(xml, /<TimeTrigger>[\s\S]*<Interval>PT5M<\/Interval>[\s\S]*<StopAtDurationEnd>false<\/StopAtDurationEnd>[\s\S]*<\/TimeTrigger>/);
  assert.doesNotMatch(xml, /<Duration>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<RestartOnFailure>/);
  // Jamais de droits admin : c'est ce qui distingue une tâche d'un vrai service.
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.doesNotMatch(xml, /HighestAvailable/);
});

test('windows: sans témoin de session scellé, rien n\'est élevé ni enregistré', () => {
  const calls: string[][] = [];
  const res = installService(fixture('win32', (n, a) => {
    calls.push([n, ...a]);
    return { code: 1, stdout: '', stderr: 'DPAPI unavailable' };
  }));
  assert.equal(res.ok, false);
  assert.equal(res.written, false, 'the task in place was not touched');
  assert.equal(calls.length, 1);
  assert.match(res.lines.join(' '), /could not seal the session witness.*DPAPI unavailable/);
});

const WINDOWS_PATHS = {
  timonHome: 'C:\\Users\\robin\\.timon',
  installDir: 'C:\\Program Files\\Timon\\resources\\orchestrator',
  heapMb: 4096,
  port: 3010,
  nodePath: 'C:\\Program Files\\Timon\\Timon.exe',
};

/**
 * La tâche lance un batch qui TIENT le daemon. Le lanceur `wscript` de la
 * révision 1 rendait la main aussitôt : la tâche ne suivait plus son daemon,
 * et rien ne pouvait relancer un daemon tombé. La fenêtre console qui avait
 * écarté `cmd` n'existe pas ici : une tâche S4U tourne en session 0.
 */
test('windows: la tâche lance un batch qui tient le daemon', () => {
  assert.equal(windowsLauncherPath(WINDOWS_PATHS.timonHome),
    'C:\\Users\\robin\\.timon\\run\\timon-service.cmd');
  const args = windowsTaskCommand(WINDOWS_PATHS);
  // `/s` + guillemets doublés : cmd retire la paire extérieure et garde le
  // chemin quoté, quels que soient ses caractères.
  assert.equal(args, '/d /s /c ""C:\\Users\\robin\\.timon\\run\\timon-service.cmd""');
  const xml = renderTaskXml({ ...WINDOWS_PATHS, userName: 'rom' });
  assert.match(xml, /<Command>cmd\.exe<\/Command>/);
  assert.doesNotMatch(xml, /wscript/);
});

test('windows: le lanceur attend le témoin DPAPI, puis démarre le daemon sur son log', () => {
  const bat = renderWindowsLauncher(WINDOWS_PATHS);
  const lines = bat.split('\r\n');
  assert.equal(lines[0], '@echo off');
  // Everything before the code page switch is ASCII; what follows is UTF-8.
  const chcp = lines.indexOf('chcp 65001 >nul');
  assert.ok(chcp > 0);
  assert.ok(lines.slice(0, chcp).every((line) => /^[\x20-\x7e]*$/.test(line)));
  // L'environnement du PROCESSUS, posé par le batch.
  assert.ok(lines.includes('set "ELECTRON_RUN_AS_NODE=1"'));
  assert.ok(lines.includes('set "TIMON_HOME=C:\\Users\\robin\\.timon"'));
  assert.ok(lines.includes('set "PORT=3010"'));
  assert.ok(lines.includes('set "TIMON_SERVICE_LOG=C:\\Users\\robin\\.timon\\tmp\\daemon.log"'));
  assert.ok(lines.includes('set "TIMON_SESSION_WITNESS=C:\\Users\\robin\\.timon\\run\\session-witness.dpapi"'));
  // Le daemon, chaque chemin quoté, sortie et erreurs dans daemon.log — et il
  // ne part qu'APRÈS le témoin : en S4U sans ouverture de session depuis le
  // boot, un claude efface les identifiants Windows de l'utilisateur.
  const daemon = lines.findIndex((line) => line.startsWith('"C:\\Program Files\\Timon\\Timon.exe" '));
  assert.ok(daemon > 0, bat);
  assert.equal(lines[daemon],
    '"C:\\Program Files\\Timon\\Timon.exe" --max-old-space-size=4096 "C:\\Program Files\\Timon\\resources\\orchestrator\\dist\\boot.js" >>"%TIMON_SERVICE_LOG%" 2>&1');
  const witness = lines.findIndex((line) => line.includes('$env:TIMON_SESSION_WITNESS'));
  assert.ok(witness > 0 && witness < daemon);
  assert.match(lines[witness]!, /ConvertTo-SecureString/);
  assert.ok(lines.includes('  goto wait'), 'the launcher loops until the witness opens');
  assert.ok(lines.includes('  exit /b 2'), 'a missing witness is refused, never skipped');
  assert.doesNotMatch(lines[witness]!, /"[^"]*"[^"]*"/, 'no quote inside the -Command string');
  // Taille bornée : le log est déplacé à 10 Mio, au démarrage.
  const rotate = lines.findIndex((line) => line.includes('move /y'));
  assert.ok(rotate > witness && rotate < daemon);
  assert.match(lines[rotate]!, /GEQ 10485760/);
  assert.match(lines[rotate]!, /^if exist "%TIMON_SERVICE_LOG%" /, 'an absent log would make the size test a syntax error');
});

test('windows: le lanceur double les % et refuse un guillemet', () => {
  const bat = renderWindowsLauncher({ ...WINDOWS_PATHS, timonHome: 'C:\\Users\\100%\\.timon' });
  assert.ok(bat.includes('set "TIMON_HOME=C:\\Users\\100%%\\.timon"'));
  assert.throws(() => renderWindowsLauncher({ ...WINDOWS_PATHS, nodePath: 'C:\\a"b.exe' }), /Invalid service value/);
  assert.throws(() => renderWindowsLauncher({ ...WINDOWS_PATHS, environment: { 'A B': '1' } }), /Invalid service environment/);
});

/**
 * TODO #342 : `userInfo().username` seul (`guilldu`) nommait un compte que
 * Windows connaît sous `EUROPE\guilldu` sur un poste joint à Entra ID. Le
 * principal est le SID lu par `whoami` dans la session de l'utilisateur ; à
 * défaut `DOMAINE\user`, puis le nom nu.
 */
test('windows: le principal de la tâche est le SID du compte, sinon DOMAINE\\user', () => {
  const sid = 'S-1-12-1-1234567890-123456789-1234567890-123456789';
  const whoami = (stdout: string, code = 0) => (n: string): ExecResult =>
    (n === 'whoami' ? { code, stdout, stderr: '' } : { code: 0, stdout: '', stderr: '' });
  assert.equal(windowsTaskUserId({ userName: 'guilldu', userDomain: 'EUROPE', exec: whoami(`"europe\\guilldu","${sid}"\r\n`) }), sid);
  assert.equal(windowsTaskUserId({ userName: 'guilldu', userDomain: 'EUROPE', exec: whoami('', 1) }), 'EUROPE\\guilldu');
  assert.equal(windowsTaskUserId({ userName: 'guilldu', userDomain: 'EUROPE', exec: whoami('"europe\\guilldu","garbage"') }), 'EUROPE\\guilldu');
  assert.equal(windowsTaskUserId({ userName: 'guilldu', exec: () => { throw new Error('ENOENT'); } }), 'guilldu');

  const opts = fixture('win32', whoami(`"europe\\guilldu","${sid}"\r\n`));
  const res = installService({ ...opts, readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }) });
  assert.equal(res.ok, true, res.lines.join('\n'));
  const xml = readFileSync(taskXmlPath(), 'utf16le');
  assert.match(xml, new RegExp(`<UserId>${sid}</UserId>`));
  assert.match(xml, /<LogonType>S4U<\/LogonType>/);
});

/**
 * TODO #342 : `/Run` répond "SUCCESS: Attempted" même quand Windows refuse
 * ensuite la session S4U (poste joint à Entra ID) ; la tâche reste Ready,
 * `LastTaskResult` 0x41303, `LastRunTime` en 1999. Le batch élevé vérifie
 * donc qu'elle a VRAIMENT démarré, et la supprime sinon — même invite UAC.
 */
test('windows: après /Run, le batch élevé vérifie que la tâche a tourné, et la supprime sinon', () => {
  const opts = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  installService({ ...opts, readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }) });
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  const run = batch.indexOf('schtasks /Run /TN TimonOrchestrator');
  const verify = batch.indexOf('Get-ScheduledTaskInfo');
  assert.ok(run >= 0 && verify > run, batch);
  // `/Run` refusé : rien à vérifier, la tâche n'a pas été lancée par nous.
  assert.match(batch.slice(run), /^[^\r\n]*\r\nset RC=%ERRORLEVEL%\r\necho TIMON-STEP run=%RC% [^\r\n]*\r\nif not "%RC%"=="0" goto :done/);
  const step = verifyTaskStartedStep().args.at(-1)!;
  // Les DEUX signaux du "jamais exécutée", et un état illisible passe.
  assert.ok(step.includes(`-ne ${WINDOWS_TASK_NEVER_RAN}`), step);
  assert.match(step, /LastRunTime\.Year -ge 2000/);
  assert.match(step, /if \(-not \$i\) \{ exit 0 \}/);
  assert.ok(step.includes(`AddSeconds(${TASK_VERIFY_SECONDS})`));
  assert.match(step, /schtasks\.exe \/Delete \/TN 'TimonOrchestrator' \/F/);
  // Ni `"` ni `%` : la commande traverse cmd entre guillemets.
  assert.doesNotMatch(step, /["%]/);
});

test('windows: une tâche jamais lancée est un refus honnête, sans révision, avec un marqueur', () => {
  const opts = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const files = windowsServiceFiles(opts.timonHome, join);
  const res = installService({ ...opts, readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: TASK_NEVER_RAN_REMOVED }) });
  assert.equal(res.ok, false);
  assert.equal(res.refused, true);
  assert.equal(res.reason, WINDOWS_TASK_REFUSED_REASON);
  assert.match(res.reason!, /Microsoft Entra ID/);
  assert.equal(existsSync(files.revision), false, 'no revision: the desktop must not wait on a removed task');
  assert.equal(existsSync(files.refused), true);

  // Pas supprimable : la tâche reste, sa révision aussi (le desktop la voit et repart en intégré).
  const kept = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const keptFiles = windowsServiceFiles(kept.timonHome, join);
  const res2 = installService({ ...kept, readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: TASK_NEVER_RAN_KEPT }) });
  assert.equal(res2.refused, true);
  assert.equal(readFileSync(keptFiles.revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION);
  assert.equal(existsSync(keptFiles.refused), true);

  // Une installation dont la tâche tourne efface le constat.
  const ok = installService({ ...kept, readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }) });
  assert.equal(ok.ok, true);
  assert.equal(existsSync(keptFiles.refused), false);
});

/**
 * Le chemin refusé dure invite UAC + 15 s de vérification : au plafond de 30 s
 * du bouton, le PowerShell extérieur était tué pendant que le batch élevé
 * continuait — et supprimait la tâche qu'on venait d'annoncer installée.
 */
test('windows: l\'appel élevé a son propre budget, un batch coupé avant sa vérification n\'est pas une réussite', () => {
  const timeouts: (number | undefined)[] = [];
  const opts = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const files = windowsServiceFiles(opts.timonHome, join);
  const res = installService({
    ...opts,
    exec: (_n, a, options) => { if (a.some((arg) => arg.includes('RunAs'))) timeouts.push(options?.timeout); return { code: 0, stdout: '', stderr: '' }; },
    readFile: () => transcript({ create: 0, stop: 0, run: 0 }),
  });
  assert.equal(timeouts.length, 1);
  assert.ok((timeouts[0] ?? 0) >= 120_000, `elevated budget ${timeouts[0]}`);
  assert.equal(res.ok, false);
  assert.notEqual(res.refused, true);
  assert.match(res.reason!, /did not confirm/);
  assert.equal(existsSync(files.revision), false);
  assert.equal(existsSync(files.refused), false);
});

test('windows: le XML échappe ce qui casserait le document', () => {
  const xml = renderTaskXml({
    userName: 'a & b',
    timonHome: 'C:\\home',
    installDir: 'C:\\dir',
  });
  assert.match(xml, /<UserId>a &amp; b<\/UserId>/);
  assert.match(xml, /\/d \/s \/c &quot;&quot;C:\\home\\run\\timon-service\.cmd&quot;&quot;/);
});

/**
 * `schtasks /End` tue le `cmd.exe` du lanceur et laisse le daemon orphelin
 * (vérifié sous Windows 11, 23/09/2026). L'arrêt vise donc l'arbre du lanceur
 * de CETTE instance, retrouvé par sa ligne de commande.
 */
test('windows: arrêter la tâche arrête l\'arbre du lanceur de cette instance', () => {
  const step = stopLauncherStep(WINDOWS_PATHS.timonHome);
  assert.equal(step.program, 'powershell');
  const script = step.args.at(-1)!;
  assert.ok(script.includes("'c:\\users\\robin\\.timon\\run\\timon-service.cmd'"));
  assert.match(script, /taskkill\.exe \/F \/T \/PID/);
  assert.match(script, /exit 0$/, 'nothing to stop is not a failure');
  const batch = renderElevatedScript([stopLauncherStep('C:\\Users\\100%\\.timon')], elevatedLogPath());
  assert.match(batch, /^powershell -NoProfile .*"Get-CimInstance .*100%%.*"/m, 'cmd expands % even between quotes');
});

/**
 * A revision-1 task started its daemon through `wscript`, detached: no
 * launcher holds it, so only the port finds it. Left running, it kept the port
 * and answered the update window with a 401 (0.1.1-rc.7 → 0.1.2-rc.1).
 */
test('windows: install ends the daemon of this installation that holds the port', () => {
  const step = stopPortOwnerStep(WINDOWS_PATHS);
  assert.equal(step.program, 'powershell');
  const script = step.args.at(-1)!;
  assert.match(script, /Get-NetTCPConnection -State Listen -LocalPort 3010 /);
  assert.ok(script.includes("'c:\\program files\\timon\\resources\\orchestrator\\dist\\boot.js'"),
    'only a process running this installation is ended, never a foreign listener');
  assert.match(script, /taskkill\.exe \/F \/T \/PID/);
  assert.match(script, /exit 0$/, 'nothing on the port is not a failure');
  assert.doesNotMatch(script, /"/, 'cmd doubles double quotes inside the quoted argument');

  // Only the upgrade runner asks for it, between the launcher stop and /Run.
  const opts = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  installService({ ...opts, replacePortOwner: true, readFile: () => transcript({ create: 0, stop: 0, 'stop-port': 0, run: 0, verify: 0 }) });
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  const order = ['taskkill.exe /F /T /PID $_.ProcessId', 'Get-NetTCPConnection', 'schtasks /Run /TN TimonOrchestrator'].map((n) => batch.indexOf(n));
  assert.ok(order.every((at) => at >= 0), batch);
  assert.deepEqual([...order].sort((x, y) => x - y), order);
});

/**
 * Le daemon S4U tourne en session 0 : un processus non élevé ne peut pas le
 * tuer, et un `/Run` sur un daemon vivant est ignoré (IgnoreNew). Le
 * redémarrage demandé par le desktop passe donc par UN lot élevé.
 */
test('windows: restart ends the launcher tree then runs the task, under one elevation', () => {
  const calls: string[][] = [];
  const opts = fixture('win32', (n, a) => { calls.push([n, ...a]); return { code: 0, stdout: '', stderr: '' }; });
  const steps = windowsRestartSteps(opts.timonHome);
  assert.deepEqual(steps.map((s) => s.label), ['stop', 'run']);
  const res = restartWindowsService({ ...opts, readFile: () => transcript({ stop: 0, run: 0 }) });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1, 'a single elevated process');
  assert.equal(calls[0]![0], 'powershell');
  assert.match(calls[0]!.join(' '), /-Verb RunAs/);
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  assert.ok(batch.indexOf('taskkill.exe /F /T') < batch.indexOf('schtasks /Run /TN TimonOrchestrator'));
  assert.doesNotMatch(batch, /\/Create|\/Delete|\/End/, 'the task itself is left as it is');
});

test('windows: restart reports a refused elevation and a task that would not start', () => {
  const opts = fixture('win32', () => ({ code: 1223, stdout: '', stderr: '' }));
  const refused = restartWindowsService({ ...opts, readFile: () => '' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'elevation refused');
  const ok = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const notStarted = restartWindowsService({ ...ok, readFile: () => transcript({ stop: 0, run: 1 }) });
  assert.equal(notStarted.ok, false);
  assert.match(notStarted.reason ?? '', /could not be started|TIMON-STEP/);
  assert.equal(restartWindowsService(fixture('linux')).ok, false);
});

test('windows: uninstall supprime la tâche, arrête son daemon, et laisse TIMON_HOME', () => {
  const calls: string[][] = [];
  const opts = fixture('win32', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: '', stderr: '' };
  });
  const files = windowsServiceFiles(opts.timonHome, join);
  mkdirSync(dirname(files.launcher), { recursive: true });
  for (const file of [files.launcher, files.legacyLauncher, files.sessionWitness, files.revision, files.repairDeclined, files.refused]) writeFileSync(file, 'x');
  writeFileSync(join(opts.timonHome, 'timon.db'), 'data', 'utf8');
  const res = uninstallService({ ...opts, readFile: () => transcript({ end: 0, delete: 0, stop: 0 }) });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], 'powershell');
  // Supprimée AVANT l'arrêt de son daemon : sinon la répétition pourrait le
  // relancer entre les deux. Et `/End` ne garde rien : une tâche à l'arrêt
  // fait échouer `/End` et doit partir quand même.
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  assert.ok(batch.indexOf('/Delete /TN TimonOrchestrator /F') < batch.indexOf('taskkill.exe'));
  assert.match(batch, /schtasks \/End \/TN TimonOrchestrator/);
  assert.doesNotMatch(batch, /goto :done/);
  // Les fichiers de la tâche partent avec elle, le constat de refus aussi
  // (TODO #342 : sinon le setup n'offrirait plus que le mode portable) ; les données restent.
  for (const file of [files.launcher, files.legacyLauncher, files.sessionWitness, files.revision, files.repairDeclined, files.refused]) {
    assert.equal(existsSync(file), false, file);
  }
  assert.equal(readFileSync(join(opts.timonHome, 'timon.db'), 'utf8'), 'data');
  assert.ok(res.lines.join(' ').includes(`${opts.timonHome} left untouched`));
});

test('windows: every service gesture writes under the home, nothing in the working directory (TODO #706)', () => {
  const opts = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const files = windowsServiceFiles(opts.timonHome, join);
  for (const file of Object.values(files)) {
    const inside = relative(opts.timonHome, file);
    assert.ok(!inside.startsWith('..') && !isAbsolute(inside), `${file} is outside ${opts.timonHome}`);
  }

  const elevated = { ...opts, readFile: () => transcript({ create: 0, end: 0, delete: 0, stop: 0, run: 0, verify: 0 }) };
  const cwd = process.cwd();
  // A path that lost its separators lands in the cwd: an empty one shows it.
  const scratch = mkdtempSync(join(tmpdir(), 'timon-service-cwd-'));
  process.chdir(scratch);
  try {
    assert.equal(installService(elevated).ok, true);
    assert.equal(readFileSync(files.launcher, 'utf8'), renderWindowsLauncher(opts));
    repairSessionWitness(elevated);
    stopService(elevated);
    startService(elevated);
    restartWindowsService(elevated);
    restoreServiceDefinition(elevated, '<Task />');
    removeServiceDefinition(elevated);
    // The revision 1 launcher is the file TODO #706 found: only an uninstall names it.
    writeFileSync(files.legacyLauncher, 'x');
    assert.equal(uninstallService(elevated).ok, true);
    assert.equal(existsSync(files.legacyLauncher), false);
    assert.deepEqual(readdirSync(scratch), []);
  } finally {
    process.chdir(cwd);
  }
});

test('windows: une tâche qui n\'a pas pu être supprimée garde son lanceur', () => {
  const opts = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const files = windowsServiceFiles(opts.timonHome, join);
  mkdirSync(dirname(files.launcher), { recursive: true });
  writeFileSync(files.launcher, 'x');
  writeFileSync(files.refused, 'x');
  uninstallService({ ...opts, readFile: () => transcript({ end: 1, delete: 1, stop: 0 }) });
  assert.equal(existsSync(files.launcher), true);
  assert.equal(existsSync(files.refused), true, 'the task is still there: so is the verdict on it');
});

test('windows: status lit la tâche, et une tâche absente n\'est pas « running »', () => {
  const running = statusService(fixture('win32', () => ({
    code: 0, stdout: 'TaskName: \\TimonOrchestrator\nStatus: Running\n', stderr: '',
  })));
  assert.equal(running.ok, true);
  assert.equal(running.code, 0);

  const absent = statusService(fixture('win32', () => ({
    code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.',
  })));
  assert.equal(absent.ok, false);
  assert.equal(absent.code, 3);
  assert.ok(absent.lines.join(' ').includes('registered: no'));
});

/**
 * The blocking first-run screen waits for `service-status` to answer.
 *
 * A BootTrigger alone only fires at the NEXT boot, so a task that is merely
 * created leaves a Windows user in front of a wizard waiting for a daemon that
 * will not come up until they restart — while Linux and macOS
 * start theirs on the spot (`systemctl --user enable --now`, `launchctl
 * bootstrap gui/<uid>`). Hence `/Run`, and hence a start failure counted as an
 * install failure: announcing success over a daemon that never came up is what
 * this whole step exists to prevent.
 */
test('windows: a task that cannot be started is not a successful installation', () => {
  // Creation succeeds, starting does not — the elevated batch says so.
  const res = installService({
    ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })),
    readFile: () => `ERROR: The system cannot find the path specified.\n${transcript({ create: 0, stop: 0, run: 1 })}`,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 1);
  const text = res.lines.join(' ');
  assert.match(text, /could not be started/);
  assert.match(text, /cannot find the path specified/);
  // Et surtout : jamais le message de succès.
  assert.doesNotMatch(text, /installed and started/);
});

test("windows: la tâche n'est pas démarrée si sa création a échoué", () => {
  // Le garde vit dans le batch élevé : une création qui échoue saute la suite,
  // et l'absence de ligne `run=` est ce qui le prouve.
  const res = installService({
    ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })),
    readFile: () => `Access is denied.\n${transcript({ create: 1 })}`,
  });
  assert.equal(res.ok, false);
  assert.doesNotMatch(res.lines.join(' '), /could not be started/);
  const batch = renderElevatedScript(
    [
      { label: 'create', args: ['/Create'], stopOnFailure: true },
      { label: 'run', args: ['/Run'] },
    ],
    elevatedLogPath(),
  );
  assert.match(batch, /if not "%RC%"=="0" goto :done/);
});

/**
 * Refuser l'invite UAC n'est pas la même chose qu'un schtasks qui échoue :
 * l'utilisateur doit lire qu'il a refusé, pas un code d'erreur Windows.
 */
test('windows: une élévation refusée le dit, et ne prétend pas avoir installé', () => {
  const res = installService({
    // The witness is sealed without elevation; only the elevation is refused.
    ...fixture('win32', (_n, a) => ({ code: a.some((arg) => arg.includes('RunAs')) ? 1223 : 0, stdout: '', stderr: '' })),
    readFile: () => { throw new Error('ENOENT'); },
  });
  assert.equal(res.ok, false);
  assert.match(res.lines.join(' '), /elevation refused/);
  assert.doesNotMatch(res.lines.join(' '), /installed and started/);
});

test('windows: un schtasks qui refuse remonte le refus, pas un succès', () => {
  const res = installService({
    ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })),
    readFile: () => `Access is denied.\n${transcript({ create: 1 })}`,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 1);
  assert.ok(res.lines.join(' ').includes('Access is denied.'));
});

test('uninstall removes the unit and never touches TIMON_HOME', () => {
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: '', stderr: '' };
  });
  installService(opts);
  mkdirSync(opts.timonHome, { recursive: true });
  writeFileSync(join(opts.timonHome, 'timon.db'), 'data', 'utf8');

  const res = uninstallService(opts);
  assert.equal(res.ok, true);
  assert.equal(existsSync(unitPath(opts.homeDir)), false);
  assert.equal(readFileSync(join(opts.timonHome, 'timon.db'), 'utf8'), 'data');
  assert.ok(res.lines.some((l) => l.includes('left untouched')));
  assert.ok(calls.some((c) => c.join(' ') === `systemctl --user disable --now ${LINUX_UNIT}`));
});

test('status reports the unit state and exits 3 when it is not running', () => {
  const opts = fixture('linux', () => ({ code: 3, stdout: 'inactive\n', stderr: '' }));
  const res = statusService(opts);
  assert.equal(res.ok, false);
  assert.equal(res.code, 3);
  assert.ok(res.lines.some((l) => l.includes('state     : inactive')));
  assert.ok(res.lines.some((l) => l.includes('not installed')));
});

test('dry-run writes nothing and calls nothing', () => {
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: '', stderr: '' };
  });
  const res = installService({ ...opts, dryRun: true });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(unitPath(opts.homeDir)), false);
  assert.ok(res.lines.every((l) => l.startsWith('(dry-run)')), res.lines.join('\n'));
  assert.ok(res.lines.at(-1)!.includes(`would install the service (${LINUX_UNIT})`));
});

/**
 * Le port du service doit être celui que la config demande (étape 5.7.6).
 *
 * Le gabarit figeait `PORT=3000`. Un paquet démarre sur 3010 pour ne heurter
 * ni la v1 ni le home de dev : le service aurait écouté ailleurs que là où le
 * client de bureau va chercher son daemon — fenêtre blanche, sans message.
 */
test('linux: l\'unit porte le port et le heap de la config, pas des constantes', () => {
  const opts = fixture('linux');
  const unit = renderUnit({ ...opts, port: 3010, heapMb: 2048 });
  assert.match(unit, /Environment=PORT=3010/);
  assert.match(unit, /--max-old-space-size=2048/);
  assert.doesNotMatch(unit, /@PORT@|@HEAP@/, 'aucun gabarit laissé en place');
  assert.doesNotMatch(unit, /Environment=PORT=3000/);
});

test('linux: the unit PATH starts with the agent CLI directories the shell found', () => {
  const opts = fixture('linux');
  writeFileSync(
    join(opts.installDir, 'scripts', `${LINUX_UNIT}.service.template`),
    '[Service]\nEnvironment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin\n',
    'utf8',
  );
  const unit = renderUnit({
    ...opts,
    agentBinDirs: ['/home/tester/.npm-global/bin', '/usr/bin', join(opts.homeDir, '.local', 'bin'), 'relative/bin', '/odd:dir', '/home/tester/.npm-global/bin'],
  });
  assert.match(unit, /^Environment=PATH=\/home\/tester\/\.npm-global\/bin:%h\/\.local\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin$/m);
  assert.equal(renderUnit({ ...opts }).match(/^Environment=PATH=.*$/m)?.[0], 'Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin');
});

test('status: « enregistré » et « tourne » sont deux réponses distinctes', () => {
  // Unit écrite, mais systemd la dit inactive : installée, pas démarrée. C'est
  // l'état exact d'un premier lancement empaqueté, où le daemon embarqué tient
  // encore le port.
  const opts = fixture('linux', () => ({ code: 0, stdout: '', stderr: '' }));
  installService(opts);
  const stopped = statusService({ ...opts, exec: () => ({ code: 0, stdout: `LoadState=loaded\nNeedDaemonReload=no\nActiveState=inactive\nWorkingDirectory=${opts.installDir}\nEnvironment=TIMON_HOME=${opts.timonHome}`, stderr: '' }) });
  assert.equal(stopped.installed, true);
  assert.equal(stopped.ok, false);

  const running = statusService({ ...opts, exec: () => ({ code: 0, stdout: `LoadState=loaded\nNeedDaemonReload=no\nActiveState=active\nWorkingDirectory=${opts.installDir}\nEnvironment=TIMON_HOME=${opts.timonHome}`, stderr: '' }) });
  assert.equal(running.installed, true);
  assert.equal(running.ok, true);
});

function supervised(opts: ServiceOpts, home: string, directory = opts.installDir, extra = ''): string {
  return `LoadState=loaded\nNeedDaemonReload=no\nActiveState=active\nWorkingDirectory=${directory}\nEnvironment="TIMON_HOME=${home}"\n${extra}`;
}

test('linux: a development service is neither adopted, overwritten nor stopped', () => {
  const opts = fixture('linux');
  const file = unitPath(opts.homeDir);
  mkdirSync(join(opts.homeDir, '.config/systemd/user'), { recursive: true });
  const development = '[Service]\nEnvironment=TIMON_HOME=%h/.timon-dev\n';
  writeFileSync(file, development);
  const calls: string[][] = [];
  opts.exec = (name, args) => {
    calls.push([name, ...args]);
    return { code: 0, stderr: '', stdout: supervised(opts, '%h/.timon-dev') };
  };
  for (const action of [statusService, installService, uninstallService]) {
    const result = action(opts);
    assert.equal(result.ok, false);
    assert.equal(result.installed, false);
    assert.match(result.reason!, /another installation or data directory/);
    assert.equal(readFileSync(file, 'utf8'), development);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([name, ...args]) => name === 'systemctl' && args.includes('show')));
});

test('linux: the same home with another installation is a conflict too', () => {
  const opts = fixture('linux');
  opts.exec = () => ({ code: 0, stderr: '', stdout: supervised(opts, opts.timonHome, '/other/orchestrator') });
  assert.equal(statusService(opts).installed, false);
  assert.equal(installService(opts).ok, false);
  assert.equal(existsSync(unitPath(opts.homeDir)), false);
});

test('linux: stale definitions and unavailable supervisors fail closed', () => {
  const opts = fixture('linux');
  for (const result of [
    { code: 1, stdout: '', stderr: 'No bus' },
    { code: 0, stdout: supervised(opts, opts.timonHome, opts.installDir, 'NeedDaemonReload=yes'), stderr: '' },
  ]) {
    const calls: string[][] = [];
    opts.exec = (name, args) => { calls.push([name, ...args]); return result; };
    assert.equal(installService(opts).ok, false);
    assert.equal(uninstallService(opts).ok, false);
    assert.ok(calls.every((call) => call.includes('show')));
    assert.equal(existsSync(unitPath(opts.homeDir)), false);
  }
});

test('linux: quoted paths, home specifiers and the legacy default are recognized', () => {
  const opts = fixture('linux');
  for (const home of [opts.timonHome, '%h/.timon']) {
    opts.exec = () => ({ code: 0, stderr: '', stdout: supervised(opts, home) });
    assert.equal(statusService(opts).ok, true);
  }
  opts.exec = () => ({ code: 0, stderr: '', stdout: supervised(opts, opts.timonHome).replace(/Environment=.*\n/, 'Environment=NODE_ENV=production\n') });
  assert.equal(statusService(opts).ok, true);
  opts.timonHome = join(opts.homeDir, 'data with spaces');
  opts.exec = () => ({ code: 0, stderr: '', stdout: supervised(opts, opts.timonHome) });
  assert.equal(statusService(opts).ok, true);
});

test('linux: rendering persists the selected home in the real shipped template', () => {
  const opts = fixture('linux');
  opts.installDir = resolve('src/host/../../');
  opts.timonHome = '/tmp/a home % "quoted"';
  const unit = renderUnit(opts);
  assert.match(unit, /\[Service\]\nEnvironment="TIMON_HOME=\/tmp\/a home %% \\"quoted\\""/);
  // The template names `[Service]` in a comment too: only the section counts.
  const section = unit.slice(unit.search(/^\[Service\]$/m));
  assert.match(section, /^\[Service\]\nEnvironment="TIMON_HOME=\/tmp\/a home %% \\"quoted\\""$/m);
  assert.doesNotMatch(unit.slice(0, unit.search(/^\[Service\]$/m)), /TIMON_HOME=/);
  assert.throws(() => renderUnit({ ...opts, timonHome: '/tmp/home\nExecStart=bad' }));
});

/** A packaged unit left by the previous release, and the systemctl that reports it. */
function previousRelease(runningFrom: (opts: ServiceOpts) => string) {
  const base = fixture('linux');
  const opts: ServiceOpts = { ...packagedServiceOptions(base, '/package/timon', 3110, '0.2.0'), restart: true };
  const file = unitPath(opts.homeDir, opts.unitName);
  mkdirSync(join(opts.homeDir, '.config/systemd/user'), { recursive: true });
  const old = packagedServiceOptions(base, '/package/timon', 3110, '0.1.0').unitContent!;
  writeFileSync(file, old);
  const calls: string[][] = [];
  opts.exec = (name, args) => {
    calls.push([name, ...args]);
    if (!args.includes('show')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stderr: '', stdout: supervised(opts, opts.timonHome, runningFrom(opts), 'UnitFileState=enabled\n') };
  };
  return { opts, file, old, calls };
}

test('linux upgrade: the unit of a previous release is ours, rewritten, and its daemon restarted', () => {
  const { opts, file, calls } = previousRelease((o) => join(o.releasesRoot!, 'old-release', 'resources', 'orchestrator'));
  const result = installService(opts);
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.equal(readFileSync(file, 'utf8'), opts.unitContent);
  const acts = calls.filter((call) => !call.includes('show')).map((call) => call.join(' '));
  const enable = acts.indexOf(`systemctl --user enable --now ${opts.unitName}`);
  assert.ok(enable >= 0);
  // `enable --now` leaves the running previous release alone; only restart replaces it.
  assert.equal(acts[enable + 1], `systemctl --user restart ${opts.unitName}`);
});

test('linux upgrade: a first install does not restart, and nothing outside our releases is adopted', () => {
  const first = previousRelease((o) => o.installDir);
  first.opts.restart = false;
  assert.equal(installService(first.opts).ok, true);
  assert.ok(!first.calls.some((call) => call.includes('restart')));

  for (const foreign of [
    (o: ServiceOpts) => join(o.releasesRoot!, 'old', 'resources', 'orchestrator', 'nested'),
    (o: ServiceOpts) => join(o.releasesRoot!, 'old', 'orchestrator'),
    (o: ServiceOpts) => join(o.releasesRoot!, '..', 'elsewhere', 'resources', 'orchestrator'),
    () => '/opt/other/resources/orchestrator',
  ]) {
    const { opts, file, old, calls } = previousRelease(foreign);
    const result = installService(opts);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /another installation/);
    // The upgrade trusts this promise to leave the running service alone.
    assert.equal(result.written, false);
    assert.equal(readFileSync(file, 'utf8'), old);
    assert.ok(calls.every((call) => call.includes('show')));
  }
  // An unpackaged unit never gains the releases exemption.
  const cli = fixture('linux');
  cli.releasesRoot = join(cli.timonHome, 'desktop-runtime', 'releases');
  cli.exec = () => ({ code: 0, stderr: '', stdout: supervised(cli, cli.timonHome, join(cli.releasesRoot!, 'r', 'resources', 'orchestrator')) });
  assert.equal(statusService(cli).installed, false);
});

test('a failed upgrade puts the previous definition back and restarts it', () => {
  const { opts, file, old, calls } = previousRelease((o) => o.installDir);
  assert.equal(readServiceDefinition(opts), old);
  writeFileSync(file, opts.unitContent!);
  const restored = restoreServiceDefinition(opts, old);
  assert.equal(restored.ok, true);
  assert.equal(readFileSync(file, 'utf8'), old);
  assert.deepEqual(calls.map((call) => call.join(' ')), [
    'systemctl --user daemon-reload',
    `systemctl --user restart ${opts.unitName}`,
  ]);

  const mac = fixture('darwin');
  const macCalls: string[][] = [];
  mac.exec = (name, args) => {
    macCalls.push([name, ...args]);
    return { code: args[0] === 'print' ? 113 : 0, stdout: '', stderr: '' };
  };
  assert.equal(readServiceDefinition(mac), null);
  assert.equal(restoreServiceDefinition(mac, '<plist/>').ok, true);
  assert.equal(readFileSync(plistPath(mac.homeDir), 'utf8'), '<plist/>');
  assert.deepEqual(macCalls.map(([, verb]) => verb), ['bootout', 'print', 'bootstrap']);

  // Windows: the previous definition is the registered task, read as UTF-8
  // (schtasks would lose an accented path), and put back under one elevation.
  const winCalls: string[][] = [];
  const win = fixture('win32', (n, a) => {
    winCalls.push([n, ...a]);
    return { code: 0, stdout: '<?xml version="1.0"?><Task>é</Task>', stderr: '' };
  });
  assert.equal(readServiceDefinition(win), '<?xml version="1.0"?><Task>é</Task>');
  assert.match(winCalls[0]!.at(-1)!, /OutputEncoding = \[Text\.Encoding\]::UTF8; Export-ScheduledTask -TaskName 'TimonOrchestrator'/);
  assert.equal(readServiceDefinition(fixture('win32', () => ({ code: 1, stdout: '', stderr: 'not found' }))), null);

  const files = windowsServiceFiles(win.timonHome, join);
  mkdirSync(dirname(files.revision), { recursive: true });
  writeFileSync(files.revision, `${WINDOWS_SERVICE_REVISION}\n`);
  const legacy = '<Task><Command>wscript.exe</Command></Task>';
  const winRestored = restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 0, stop: 0, run: 0 }) }, legacy);
  assert.equal(winRestored.ok, true, winRestored.lines.join('\n'));
  assert.equal(readFileSync(taskXmlPath(), 'utf16le').replace(/^\ufeff/, ''), legacy);
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  assert.ok(batch.indexOf('/Create') < batch.indexOf('taskkill.exe') && batch.indexOf('taskkill.exe') < batch.indexOf('/Run'));
  // Back on revision 1: the desktop must try the migration again next launch.
  assert.equal(existsSync(files.revision), false);
  const refused = restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 1 }) }, legacy);
  assert.equal(refused.ok, false);

  // Back on an older definition of the same launcher: the file stays, or the
  // desktop would see no task at all, but it no longer says the current revision.
  writeFileSync(files.revision, `${WINDOWS_SERVICE_REVISION}\n`);
  const sameLauncher = renderTaskXml(win);
  assert.equal(restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 1 }) }, sameLauncher).ok, false);
  assert.equal(readFileSync(files.revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION, 'not put back: the new definition is still there');
  assert.equal(restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 0, stop: 0, run: 0 }) }, sameLauncher).ok, true);
  assert.notEqual(readFileSync(files.revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION);
});

test('a definition written with nothing to restore is stopped and removed', () => {
  const { opts, file, calls } = previousRelease((o) => o.installDir);
  writeFileSync(file, opts.unitContent!);
  const removed = removeServiceDefinition(opts);
  assert.equal(removed.ok, true, removed.lines.join('\n'));
  assert.equal(existsSync(file), false);
  assert.deepEqual(calls.map((call) => call.join(' ')), [
    `systemctl --user disable --now ${opts.unitName}`,
    'systemctl --user daemon-reload',
  ]);

  // A daemon that would not stop is reported, even though the file is gone.
  const stuck = previousRelease((o) => o.installDir);
  stuck.opts.exec = () => ({ code: 1, stdout: '', stderr: 'Failed to connect to bus' });
  const failed = removeServiceDefinition(stuck.opts);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'Failed to connect to bus');

  const mac = fixture('darwin');
  mkdirSync(dirname(plistPath(mac.homeDir)), { recursive: true });
  writeFileSync(plistPath(mac.homeDir), '<plist/>');
  mac.exec = () => ({ code: 113, stdout: '', stderr: '' });
  assert.equal(removeServiceDefinition(mac).ok, true);
  assert.equal(existsSync(plistPath(mac.homeDir)), false);

  const win = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const revision = windowsServiceFiles(win.timonHome, join).revision;
  mkdirSync(dirname(revision), { recursive: true });
  writeFileSync(revision, WINDOWS_SERVICE_REVISION);
  assert.equal(removeServiceDefinition({ ...win, readFile: () => transcript({ end: 0, delete: 0, stop: 0 }) }).ok, true);
  assert.equal(existsSync(revision), false);
  assert.match(readFileSync(elevatedScriptPath(), 'utf8'), /taskkill\.exe/);
  assert.equal(removeServiceDefinition({ ...win, readFile: () => transcript({ end: 1, delete: 1 }) }).ok, false);
});

test('TIM-0107: `timon service repair` seals the witness again only when it cannot be opened', () => {
  const calls: string[][] = [];
  const run = (readCode: number, sealCode = 0, launcher = true) => {
    const opts = fixture('win32', (n, a) => {
      calls.push([n, ...a]);
      return { code: a.at(-1)!.includes('ConvertFrom-SecureString') ? sealCode : readCode, stdout: '', stderr: sealCode ? 'DPAPI unavailable' : '' };
    });
    const files = windowsServiceFiles(opts.timonHome, join);
    if (launcher) { mkdirSync(dirname(files.launcher), { recursive: true }); writeFileSync(files.launcher, 'x'); }
    return { res: repairSessionWitness(opts), files };
  };

  let out = run(0);
  assert.equal(out.res.ok, true);
  assert.match(out.res.lines.join('\n'), /nothing to repair/);
  assert.equal(calls.filter((c) => c.at(-1)!.includes('ConvertFrom-SecureString')).length, 0, 'a witness that opens is left alone');

  calls.length = 0;
  for (const readCode of [1, 2]) {
    out = run(readCode);
    assert.equal(out.res.ok, true, `exit ${readCode}`);
    assert.ok(calls.at(-1)!.at(-1)!.includes(out.files.sessionWitness), 'sealed where the launcher reads it');
    assert.ok(calls.at(-1)!.includes('-NonInteractive') && !calls.some((c) => c.join(' ').includes('RunAs')), 'in the user session, no elevation');
  }

  out = run(1, 1);
  assert.equal(out.res.ok, false);
  assert.match(out.res.lines.join('\n'), /could not seal the session witness.*DPAPI unavailable/);

  assert.equal(run(1, 0, false).res.ok, false, 'no launcher: nothing installed to repair');
  const linux = repairSessionWitness({ ...fixture('linux'), exec: () => { throw new Error('never called'); } });
  assert.equal(linux.ok, true);
});

test('TIM-0107: the read command and the launcher judge the witness the same way', () => {
  const file = 'C:\\Users\\robin\\.timon\\run\\session-witness.dpapi';
  const command = readSessionWitnessCommand(file).at(-1)!;
  const launcher = renderWindowsLauncher({ timonHome: 'C:\\Users\\robin\\.timon', installDir: 'C:\\T', heapMb: 4096, port: 3010, nodePath: 'C:\\T\\Timon.exe' });
  const shared = command.slice(command.indexOf('if (-not (Test-Path'), command.lastIndexOf('; [Console]::Error.WriteLine($why)'));
  assert.ok(launcher.includes(shared), 'same decrypt-and-compare statements');
  assert.ok(command.startsWith(`$f = '${file}'`));
});

test('TODO #550: an unreadable witness leaves its cause in the service log, once, and never its content', () => {
  const launcher = renderWindowsLauncher(WINDOWS_PATHS);
  const witness = launcher.split('\r\n').find((line) => line.includes('$env:TIMON_SESSION_WITNESS'))!;
  const payload = /-Command "([^"]*)"$/.exec(witness)?.[1];
  assert.ok(payload, witness);
  // Raw inside a batch: cmd would expand a `%` and end the string on a quote.
  assert.doesNotMatch(payload, /[%"]/);
  // The catch keeps the cause instead of swallowing it, from the exception alone.
  const handler = /catch \{ (\$why = [^}]*) \}/.exec(payload)?.[1];
  assert.ok(handler, 'the decrypt failure is recorded, not swallowed');
  assert.match(handler, /\$_\.Exception\.Message/);
  assert.doesNotMatch(handler, /\$s\b|\$b\b|Get-Content|PtrToStringBSTR/, 'neither the blob nor what it decrypted to');
  assert.doesNotMatch(payload, /catch \{\s*\}/, 'no catch left empty');
  // Written to the service log on the first pass only, before the 10-second loop.
  const write = payload.split('; ').find((statement) => statement.includes('$env:TIMON_SERVICE_LOG'));
  assert.ok(write, payload);
  assert.match(write, /^if \(-not \$env:TIMON_SERVICE_WAITING\) \{/);
  assert.match(write, /AppendAllText\(\$env:TIMON_SERVICE_LOG, .*\$why/);
  assert.ok(payload.indexOf(write) < payload.indexOf('Start-Sleep'));
  const lines = launcher.split('\r\n');
  assert.ok(lines.indexOf(witness) < lines.findIndex((line) => line.includes('set "TIMON_SERVICE_WAITING=1"')));
  // The CLI's read command reports it on stderr, where status and repair read it.
  assert.match(readSessionWitnessCommand('C:\\w.dpapi').at(-1)!, /\[Console\]::Error\.WriteLine\(\$why\); exit 1$/);
});

test('TODO #550: status and repair show why the witness cannot be opened', () => {
  const cause = 'CryptographicException: Key not valid for use in specified state.';
  const notes = windowsServiceNotes(fixture('win32', (_n, a) => (
    a.at(-1)!.includes('Get-ScheduledTask') ? { code: 0, stdout: 'present\r\n', stderr: '' } : { code: 1, stdout: '', stderr: `${cause}\r\n` })));
  assert.ok(notes.some((line) => line.includes('timon service repair') && line.endsWith(`(cause: ${cause})`)), notes.join('\n'));
  const silent = windowsServiceNotes(fixture('win32', () => ({ code: 1, stdout: '', stderr: '' })));
  assert.ok(silent.some((line) => line.endsWith('run `timon service repair`')), 'no cause, no empty suffix');

  const opts = fixture('win32', (_n, a) => ({ code: a.at(-1)!.includes('ConvertFrom-SecureString') ? 0 : 1, stdout: '', stderr: a.at(-1)!.includes('ConvertFrom-SecureString') ? '' : cause }));
  const files = windowsServiceFiles(opts.timonHome, join);
  mkdirSync(dirname(files.launcher), { recursive: true });
  writeFileSync(files.launcher, 'x');
  assert.ok(repairSessionWitness(opts).lines.includes(`the session witness cannot be opened (cause: ${cause})`));
});

test('TIM-0107 / TIM-0108: the status notes say whether the witness opens and whether the module sees the task', () => {
  const notes = (witness: number, lookup: string) => windowsServiceNotes(fixture('win32', (_n, a) => (
    a.at(-1)!.includes('Get-ScheduledTask -TaskName')
      ? { code: 0, stdout: `${lookup}\r\n`, stderr: '' }
      : { code: witness, stdout: '', stderr: '' }))).join('\n');
  assert.match(notes(0, 'present'), /session witness: opens[\s\S]*task present/);
  assert.match(notes(1, 'present'), /cannot be opened.*timon service repair/);
  assert.match(notes(2, 'present'), /missing.*timon service install/);
  assert.match(notes(0, 'absent'), /ScheduledTasks module: task absent/);
  assert.deepEqual(windowsServiceNotes(fixture('linux')), []);
});

test('TIM-0115: the sweep targets this installation\'s daemon and terminal host, never the directory they share with the desktop', () => {
  const step = stopInstallationProcessesStep({ installDir: 'C:\\Users\\Robin\\AppData\\Local\\Programs\\Timon\\resources\\orchestrator', nodePath: 'C:\\Users\\Robin\\AppData\\Local\\Programs\\Timon\\Timon.exe' });
  const script = step.args.at(-1)!;
  assert.equal(step.label, 'sweep');
  // Only the runtime of this installation, never a foreign program whose command
  // line names one of its files, nor an Electron helper of the window.
  assert.match(script, /@\('Timon\.exe', 'node\.exe'\) -contains \$_\.Name -and/, 'bounded to the Timon runtimes: Electron, and the Node the package ships');
  assert.match(script, /-not \$_\.CommandLine\.Contains\('--type='\)/, 'Electron helpers are the window\'s');
  assert.match(stopInstallationProcessesStep({ installDir: 'C:\\svc\\orchestrator', nodePath: 'C:\\Program Files\\nodejs\\node.exe' }).args.at(-1)!, /@\('node\.exe', 'Timon\.exe'\) -contains \$_\.Name/, 'a CLI-installed service runs on node');
  assert.ok(script.includes("'c:\\users\\robin\\appdata\\local\\programs\\timon\\resources\\orchestrator\\dist\\boot.js'"));
  assert.ok(script.includes("\\dist\\terminal-host\\main.js'"));
  // After Quit, the web server and a mission's browser helper outlived the
  // daemon too (tester report, 22/10/2026): found by the sibling app directory
  // and the helper's entry, never by Electron's own `resources\app.asar`.
  assert.ok(script.includes("\\resources\\orchestrator\\bin\\browser-mcp.mjs'"));
  assert.ok(script.includes("'c:\\users\\robin\\appdata\\local\\programs\\timon\\resources\\app\\'"));
  assert.equal(installationProcessNeedles('C:\\T\\resources\\orchestrator').some((n) => 'c:\\t\\resources\\app.asar'.includes(n.toLowerCase())), false);
  assert.doesNotMatch(script, /orchestrator'\)/, 'the bare install directory is also where the CLI that runs this uninstall lives');
  assert.match(script, /\$_\.ProcessId -ne \$PID/, 'never this PowerShell, whose command line holds the needles');
  assert.match(script, new RegExp(`exit ${PROCESSES_REMAIN}`));
  assert.doesNotMatch(script, /"/, 'it travels inside a quoted batch line');
});

test('TIM-0115: uninstall sweeps after deleting the task, fails visibly when the elevation is refused, and says when programs remain', () => {
  const run = (codes: Record<string, number> | null) => {
    const opts = fixture('win32', () => ({ code: codes ? 0 : 1223, stdout: '', stderr: '' }));
    const files = windowsServiceFiles(opts.timonHome, join);
    mkdirSync(dirname(files.launcher), { recursive: true });
    writeFileSync(files.launcher, 'x');
    return { res: uninstallService({ ...opts, readFile: () => (codes ? transcript(codes) : '') }), files, opts };
  };
  const done = run({ end: 0, delete: 0, stop: 0, sweep: 0 });
  assert.equal(done.res.ok, true);
  assert.equal(existsSync(done.files.launcher), false);
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  const order = ['/End', '/Delete', 'taskkill.exe /F /T /PID $_.ProcessId', 'terminal-host'].map((needle) => batch.indexOf(needle));
  assert.ok(order.every((at) => at >= 0), batch);
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'task deleted before the daemon is stopped, the sweep last');

  const left = run({ end: 0, delete: 0, stop: 0, sweep: PROCESSES_REMAIN });
  assert.equal(left.res.ok, true, 'the task is gone: the uninstall stands');
  assert.match(left.res.lines.join('\n'), /still running after the stop/);

  const refused = run(null);
  assert.equal(refused.res.ok, false, 'a refused elevation is not a success');
  assert.match(refused.res.reason ?? '', /elevation refused.*still there/);
  assert.equal(existsSync(refused.files.launcher), true, 'the launcher stays with the task');
});

/**
 * "Quit and stop the background service" (decision of 22/10/2026): the task
 * is disabled before anything is ended — ended alone, its repeating trigger
 * started the daemon again within five minutes — and stays registered. The
 * marker is what the desktop reads at its next launch to start it again.
 */
test('windows: stop disables the task, ends the daemon and the orphans under one elevation, and leaves the marker', () => {
  const calls: string[][] = [];
  const opts = fixture('win32', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: n === 'schtasks' ? 'Status: Running' : '', stderr: '' };
  });
  assert.deepEqual(windowsStopSteps(opts).map((s) => s.label), ['disable', 'end', 'stop', 'sweep']);
  const res = stopService({ ...opts, readFile: () => transcript({ disable: 0, end: 0, stop: 0, sweep: 0 }) });
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.equal(calls.filter((c) => c[0] === 'powershell').length, 1, 'a single elevated process');
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  const order = ['/Change /TN TimonOrchestrator /DISABLE', '/End /TN TimonOrchestrator', 'taskkill.exe /F /T /PID $_.ProcessId', 'browser-mcp']
    .map((needle) => batch.indexOf(needle));
  assert.ok(order.every((at) => at >= 0), batch);
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'disabled first, the daemon next, the sweep last');
  assert.doesNotMatch(batch, /\/Delete/, 'the task stays registered');
  assert.equal(existsSync(serviceStoppedMarker(opts.timonHome)), true);
  assert.match(res.lines.join('\n'), /starts again when you open Timon/);

  const left = stopService({ ...opts, readFile: () => transcript({ disable: 0, end: 0, stop: 0, sweep: PROCESSES_REMAIN }) });
  assert.equal(left.ok, true);
  assert.match(left.lines.join('\n'), /still running after the stop/);
});

test('windows: stop says when elevation is refused or the task is absent, and leaves no marker', () => {
  const refusedOpts = fixture('win32', (n) => ({ code: n === 'powershell' ? 1223 : 0, stdout: n === 'schtasks' ? 'Status: Ready' : '', stderr: '' }));
  const refused = stopService({ ...refusedOpts, readFile: () => '' });
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? '', /elevation refused.*keep running/);
  assert.equal(existsSync(serviceStoppedMarker(refusedOpts.timonHome)), false);

  const calls: string[][] = [];
  const absentOpts = fixture('win32', (n, a) => { calls.push([n, ...a]); return { code: n === 'schtasks' ? 1 : 0, stdout: '', stderr: 'ERROR: not found' }; });
  const absent = stopService({ ...absentOpts, readFile: () => '' });
  assert.equal(absent.ok, false);
  assert.match(absent.reason ?? '', /no service installed/);
  assert.equal(calls.some((c) => c[0] === 'powershell'), false, 'no prompt for a task that does not exist');

  const failed = stopService({ ...fixture('win32', () => ({ code: 0, stdout: 'Status: Ready', stderr: '' })), readFile: () => transcript({ disable: 1 }) });
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? '', /could not be disabled/);
});

test('windows: start enables the task, runs it, and clears the marker', () => {
  const opts = fixture('win32', () => ({ code: 0, stdout: 'Status: Disabled', stderr: '' }));
  const marker = serviceStoppedMarker(opts.timonHome);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, 'x');
  assert.deepEqual(windowsStartSteps().map((s) => s.label), ['enable', 'run']);
  const res = startService({ ...opts, readFile: () => transcript({ enable: 0, run: 0 }) });
  assert.equal(res.ok, true, res.lines.join('\n'));
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  assert.ok(batch.indexOf('/ENABLE') < batch.indexOf('/Run'));
  assert.equal(existsSync(marker), false);

  writeFileSync(marker, 'x');
  const refused = startService({ ...fixture('win32', (n) => ({ code: n === 'powershell' ? 1223 : 0, stdout: 'Status: Disabled', stderr: '' })), readFile: () => '' });
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? '', /stays disabled/);
  const notRun = startService({ ...opts, readFile: () => transcript({ enable: 0, run: 1 }) });
  assert.equal(notRun.ok, false);
  assert.equal(existsSync(marker), true, 'a service that did not start is still stopped');
});

test('linux: stop and start go through systemctl, the unit stays enabled, the marker follows', () => {
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => { calls.push([n, ...a]); return { code: 0, stdout: '', stderr: '' }; });
  assert.equal(installService(opts).ok, true);
  calls.length = 0;
  const stopped = stopService(opts);
  assert.equal(stopped.ok, true, stopped.lines.join('\n'));
  assert.deepEqual(calls, [['systemctl', '--user', 'stop', LINUX_UNIT]]);
  assert.equal(existsSync(serviceStoppedMarker(opts.timonHome)), true);
  assert.match(statusService(opts).lines.join('\n'), /stopped\s+: by the user/);
  calls.length = 0;
  const started = startService(opts);
  assert.equal(started.ok, true);
  assert.deepEqual(calls, [['systemctl', '--user', 'start', LINUX_UNIT]]);
  assert.equal(existsSync(serviceStoppedMarker(opts.timonHome)), false);

  const bare = fixture('linux');
  const none = stopService(bare);
  assert.equal(none.ok, false, 'no unit: nothing to stop');
  assert.equal(existsSync(serviceStoppedMarker(bare.timonHome)), false);
});

test('macos: stop boots the agent out and start loads it again; a LaunchDaemon goes through the administrator prompt', () => {
  const calls: string[][] = [];
  const base = fixture('darwin', (n, a) => {
    calls.push([n, ...a]);
    if (n === 'launchctl' && a[0] === 'print') return { code: 113, stdout: '', stderr: '' };
    if (n === 'osascript') return { code: 0, stdout: transcript({ bootout: 0, bootstrap: 0 }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const agent = { ...base, launchDaemonsDir: mkdtempSync(join(tmpdir(), 'timon-ld-')), elevation: 'osascript' as const };
  const plist = plistPath(agent.homeDir);
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, 'agent');
  const stopped = stopService(agent);
  assert.equal(stopped.ok, true, stopped.lines.join('\n'));
  assert.deepEqual(calls, [['launchctl', 'bootout', `gui/1000/${MACOS_LABEL}`]]);
  assert.equal(existsSync(serviceStoppedMarker(agent.timonHome)), true);
  calls.length = 0;
  const started = startService(agent);
  assert.equal(started.ok, true, started.lines.join('\n'));
  assert.deepEqual(calls.filter((c) => c[1] !== 'print'), [
    ['launchctl', 'bootout', `gui/1000/${MACOS_LABEL}`],
    ['launchctl', 'bootstrap', 'gui/1000', plist],
  ]);
  assert.equal(existsSync(serviceStoppedMarker(agent.timonHome)), false);

  calls.length = 0;
  writeFileSync(join(agent.launchDaemonsDir, `${MACOS_LABEL}.plist`), 'daemon');
  const daemonStopped = stopService(agent);
  assert.equal(daemonStopped.ok, true, daemonStopped.lines.join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], 'osascript');
  assert.match(calls[0]!.join(' '), new RegExp(`launchctl bootout system/${MACOS_LABEL}`));
  assert.doesNotMatch(calls[0]!.join(' '), /rm |unload/, 'booted out, not removed: the next boot loads it again');
  calls.length = 0;
  const daemonStarted = startService(agent);
  assert.equal(daemonStarted.ok, true, daemonStarted.lines.join('\n'));
  assert.match(calls[0]!.join(' '), /launchctl bootstrap system /);
});

// Stays the last test of this file: it answers for all the ones above.
test('no test of this file left a Windows path as a file name in the working directory (TODO #706)', () => {
  assert.deepEqual(backslashNames(process.cwd()).filter((name) => !backslashNamesAtStart.has(name)), []);
});
