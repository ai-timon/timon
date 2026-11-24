/**
 * Packaging guard (step 5.5).
 *
 * The three-OS build is a manual gesture; what a test CAN hold is the list of
 * things that must travel with the app. Portable mode spawns
 * `resources/orchestrator/dist/boot.js`, which loads the daemon's
 * `node_modules` and serves `app/.next`. A packaging config that quietly drops
 * one of them produces an installer that opens a window on nothing — and only
 * on a machine that is not the developer's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PACKAGED_DEFAULTS } from './config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  main: string;
  scripts: Record<string, string>;
  homepage?: string;
  author?: { email?: string };
};

test('the daemon and the built app travel with the client', () => {
  for (const resource of [
    'orchestrator/dist',
    'orchestrator/bin',
    'orchestrator/presets',
    'orchestrator/node_modules',
    // `dist/boot.js` is ESM: without this manifest's `"type": "module"`, Node
    // refuses the first import — one file away from a package that boots.
    'orchestrator/package.json',
  ]) {
    assert.ok(yml.includes(`to: ${resource}`), `${resource} missing from extraResources`);
  }
  // The app travels as ONE directory: its traced standalone output, which
  // `prepare:deps` refuses to assemble unless the compiled server and workers
  // are in it. The live trees (25 000 files of node_modules, the TypeScript
  // sources) must not come back next to it.
  assert.match(yml, /- from: build-resources\/app\n {4}to: app\n/);
  for (const live of ['../app/src', '../app/.next', '../app/node_modules']) {
    assert.ok(!yml.includes(`from: ${live}`), `${live} must not ship: the standalone output replaces it`);
  }
});

/**
 * Next traces what ITS server needs, not our custom server nor the workers,
 * and leaves `static` and `public` out. A file missing from the package only
 * shows at runtime, on a tester's machine.
 */
test('the shell\'s languages travel as resources/locales, prepared and checked', () => {
  assert.match(yml, /- from: build-resources\/locales\n {4}to: locales\n/);
  const prepare = readFileSync(join(root, 'scripts', 'prepare-daemon-deps.mjs'), 'utf8');
  assert.match(prepare, /copyShellLocales\(\)/);
  const hooks = readFileSync(join(root, 'scripts', 'release-hooks.mjs'), 'utf8');
  assert.match(hooks, /assertPackagedShellLocales\(resources\)/);
  // The shell runs `intl-messageformat` from app.asar: a runtime dependency, not a dev one.
  assert.ok((pkg as { dependencies?: Record<string, string> }).dependencies?.['intl-messageformat']);
});

test('the standalone app is completed and checked before it ships', () => {
  const prepare = readFileSync(join(root, 'scripts', 'prepare-daemon-deps.mjs'), 'utf8');
  for (const entry of ["'server.cjs'", "'telegram-poll.cjs'", "'mission-watcher.cjs'"]) {
    assert.ok(prepare.includes(entry), `${entry} must be required in the shipped app`);
  }
  assert.match(prepare, /assertEntriesResolve\(into,/);
  // Electron's Node 20 cannot require() jsdom's ES modules: tsx must travel.
  assert.match(prepare, /runtime: \[join\('node_modules', 'tsx', 'dist', 'cli\.mjs'\)\]/);
  const complete = readFileSync(join(root, '..', 'app', 'scripts', 'build-server.mjs'), 'utf8');
  assert.match(complete, /nodeFileTrace/);
  assert.match(complete, /copyPackageClosure\('tsx'/);
  assert.match(complete, /'static'/);
  assert.match(complete, /'public'/);
});

/**
 * `install-app-deps` rebuilds the dependencies of THIS package (it has none),
 * never `orchestrator/`'s — the tree that actually carries `better-sqlite3`.
 * A build that relied on it shipped an ABI-127 binary to an ABI-130 runtime:
 * the daemon crash-looped and the shell only said "the daemon keeps crashing".
 */
test('the shipped native module comes from the rebuilt copy, not the live tree', () => {
  assert.ok(
    yml.includes('from: build-resources/orchestrator/node_modules'),
    'extraResources must ship the rebuilt copy',
  );
  assert.ok(
    yml.includes('from: build-resources/app\n'),
    'the app runs under Electron too: its native modules must be rebuilt as well',
  );
  for (const live of ['from: ../orchestrator/node_modules', 'from: ../app/node_modules']) {
    assert.ok(!yml.includes(live), `${live} is built for the host ABI and must not be shipped`);
  }
  assert.equal(pkg.scripts['prepare:deps'], 'node scripts/prepare-daemon-deps.mjs');
  assert.match(pkg.scripts['dist'], /prepare:deps/);
  assert.equal(pkg.scripts['dist:deps'], undefined, 'install-app-deps does not rebuild the daemon tree');
});

test('the rebuild never touches the tree the local daemon runs on', () => {
  const script = readFileSync(join(root, 'scripts', 'prepare-daemon-deps.mjs'), 'utf8');
  assert.match(script, /refusing to rebuild inside/);
  // The rebuild runs in the staged copy, BY the shipped Node, so the module's
  // install script targets that Node's ABI and not the build machine's.
  assert.match(script, /execFileSync\(node, \[npmCli\(\), 'rebuild', moduleName/);
  assert.match(script, /cwd: staged/);
});

/**
 * The packaged daemon runs on the Node the package ships (Electron 33's Node 20
 * lacks `node:sqlite`): its version and archive hashes are pinned, and the pack
 * refuses to complete without it.
 */
test('the shipped Node is pinned, hash-checked and required by the pack', () => {
  const spec = JSON.parse(readFileSync(join(root, 'scripts', 'node-runtime.json'), 'utf8')) as {
    version: string; abi: string; files: Record<string, { archive: string; sha256: string }>;
  };
  assert.match(spec.version, /^22\./, 'Node 24 needs macOS 13.5: the interface runs from macOS 11');
  for (const key of ['linux-x64', 'darwin-x64', 'darwin-arm64', 'win32-x64']) {
    assert.match(spec.files[key]?.sha256 ?? '', /^[0-9a-f]{64}$/, key);
  }
  const fetcher = readFileSync(join(root, 'scripts', 'fetch-node.mjs'), 'utf8');
  assert.match(fetcher, /does not match the pinned/);
  const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  assert.match(builder, /- from: build-resources\/node\n\s+to: node/);
  const hooks = readFileSync(join(root, 'scripts', 'release-hooks.mjs'), 'utf8');
  assert.match(hooks, /assertPackagedNode\(resources, platform\)/);
});

/**
 * Missing one native module is as fatal as missing them all, and just as
 * silent until runtime: the daemon dies on `better_sqlite3`, the terminals on
 * `pty`, the app's remote API on its own database.
 */
test('every native module that travels is rebuilt', () => {
  const script = readFileSync(join(root, 'scripts', 'prepare-daemon-deps.mjs'), 'utf8');
  assert.match(script, /name: 'orchestrator', modules: \['better-sqlite3', 'node-pty'\]/);
  assert.match(script, /name: 'app',\s+modules: \['better-sqlite3'\]/);
});

/**
 * TODO #440: Windows terminals run on the ConPTY node-pty ships
 * (`useConptyDll`). The whole prebuild directory travels in
 * `orchestrator/node_modules`; the build refuses a package where its
 * `conpty/` folder went missing, since every terminal would then fail.
 */
test('the Windows node-pty prebuild ships its ConPTY', () => {
  const script = readFileSync(join(root, 'scripts', 'prepare-daemon-deps.mjs'), 'utf8');
  assert.match(script, /moduleName === 'node-pty' && process\.platform === 'win32'/);
  assert.match(script, /missingConptyFiles\(keep\)/);
  const helper = readFileSync(join(root, 'scripts', 'pty-helper.mjs'), 'utf8');
  assert.match(helper, /join\('conpty', 'conpty\.dll'\), join\('conpty', 'OpenConsole\.exe'\)/);
  const pty = readFileSync(join(root, '..', 'orchestrator', 'src', 'terminal-host', 'pty.ts'), 'utf8');
  assert.match(pty, /platform === 'win32' \? \{ useConptyDll: true \}/);
});

/**
 * Uninstall removes the task with a direct fallback; updates preserve it.
 * Registration remains owned by first run, with no second task definition.
 *
 * Registering it here means registering it before a `timon.config.json`
 * exists, so the CLI answers with the daemon's developer defaults: port 3000,
 * `app.enabled = false`, `profile = linux-desktop`. That service serves no UI
 * on a port the shell never looks at, and it makes the first-run screen report
 * "already installed" over it. The shell decides those values on first launch
 * and the first-run screen registers the service once they exist.
 */
test('an older installer can replace a newer version, to go back after a bad update', () => {
  // NSIS (electron-builder 25.1.8) has no version check; the macOS .pkg has one, on by default.
  assert.match(yml, /\npkg:\n(?:  .*\n)*  isVersionChecked: false\n/);
});

// 0.1.2-rc.2 update: the per-user installer could not end the S4U service in
// session 0 and looped on "Timon cannot be closed". rc.3 detected it with
// tasklist from the unelevated installer and saw nothing: elevation is now
// asked as the installer opens, whenever Timon is already there.
test('the NSIS installer pauses the service with one elevation as it opens, over an existing install', () => {
  const nsh = readFileSync(join(root, 'build', 'installer.nsh'), 'utf8');
  for (const hook of ['customInit', 'customUnInit']) {
    assert.match(nsh, new RegExp(`!macro ${hook}\\s+!insertmacro timonPauseService\\s+!macroend`));
  }
  assert.doesNotMatch(nsh, /!macro customCheckAppRunning/);
  const pause = nsh.match(/!macro timonPauseService\s+([\s\S]*?)!macroend/)?.[1] ?? '';
  assert.doesNotMatch(pause, /tasklist/, 'no detection from an unelevated process');
  // Never a prompt under /S, nor in an update's uninstaller, except for the
  // update Timon starts from its window (update-installer.ts, NSIS_SILENT_ARGS).
  assert.match(pause, /\$\{If\} \$\{Silent\}\s+\$\{OrIf\} \$\{isUpdated\}\s+StrCpy \$2 "skip"\s+\$\{StdUtils\.TestParameter\} \$1 "timon-app-update"\s+\$\{If\} \$1 == "true"\s+StrCpy \$2 "pause"/);
  assert.match(pause, /\$\{If\} \$2 == "pause"\s+\$\{If\} \$\{FileExists\}/);
  // A per-machine install elevates itself and runs again: one prompt, from the elevated instance.
  assert.match(pause, /!ifndef BUILD_UNINSTALLER[\s\S]*\$\{If\} \$\{Silent\}\s+\$\{AndIf\} \$hasPerMachineInstallation == "1"\s+\$\{AndIfNot\} \$\{UAC_IsAdmin\}\s+StrCpy \$2 "skip"/);
  assert.ok(pause.includes('${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"'), 'an existing install');
  assert.match(pause, /timon-service\.json[\s\S]*timon-service\.cmd[\s\S]*timon-service\.vbs/, 'a service launcher, revision 6, 2 or 1');
  assert.match(pause, /"runas"/);
  // Elevation refused (standard account, Entra-joined PC): the same script runs
  // unelevated, which is enough for the user's own Interactive task.
  const runas = pause.indexOf('"runas"');
  const fallback = pause.indexOf('"open"', runas);
  assert.ok(fallback > runas, 'an unelevated run follows a refused elevation');
  assert.match(pause.slice(runas, fallback), /\$\{Else\}/, 'only when elevation was refused');
  assert.equal(pause.slice(fallback).includes('timon-service-pause.ps1'), true, 'the same script');
  const ps1 = readFileSync(join(root, 'build', 'timon-service-pause.ps1'), 'utf8');
  // Disabled before anything is ended: the 5-minute trigger would restart it.
  assert.ok(ps1.indexOf('Disable-ScheduledTask') < ps1.indexOf('taskkill.exe'));
  assert.match(ps1, /Wait-Process -Id \$InstallerPid[\s\S]*Enable-ScheduledTask[\s\S]*Start-ScheduledTask/);
  // The daemon of an Interactive task lives in the user's session, not in
  // session 0: it is found by its entry point, in any session, and the window
  // (no boot.js) is left to the installer's own close step.
  assert.doesNotMatch(ps1, /SessionId -eq 0/, 'no session filter');
  assert.match(ps1, /Contains\('\\dist\\boot\.js'\)/);
  assert.match(ps1, /foreach \(\$daemon in \$daemons\) \{\s+if \(& \$mine \$daemon\) \{\s+& \$end \$daemon /, 'elsewhere than this installation, only this account\'s daemon');
  // After Quit, the daemon's web server, a mission's browser helper and the
  // terminal host outlive it with no live parent for `/T` to follow, and the
  // installer looped on "Timon cannot be closed" (0.1.5 update, 22/10/2026).
  // Everything of this installation that runs as Node is ended; the window
  // and Electron's own helpers are not.
  assert.equal((pause.match(/-InstallDir "\$INSTDIR"/g) ?? []).length, 2, 'both runs know the installation');
  assert.match(ps1, /\\resources\\orchestrator\\/);
  assert.match(ps1, /\\resources\\app\\/);
  assert.match(ps1, /Contains\('--type='\)/, 'Electron\'s helpers belong to the window, which the installer closes itself');
  assert.match(ps1, /1\.\.2/, 'a second pass for a child whose parent went first');
});

// 0.1.7 to 0.1.8 update: the installer passed `-User` in the NSIS form that is
// replaced when the installer is compiled, so it carried the build machine's
// account. On a tester's PC no process matched, and the previous daemon
// (node.exe, session 0) outlived the update holding its port.
test('the service pause knows its account by SID, and nothing of the build machine', () => {
  const nsh = readFileSync(join(root, 'build', 'installer.nsh'), 'utf8');
  assert.doesNotMatch(nsh, /\$%/, 'NSIS replaces $%NAME% at compile time, with the build machine\'s value');
  assert.doesNotMatch(nsh, /-User\b/);
  const ps1 = readFileSync(join(root, 'build', 'timon-service-pause.ps1'), 'utf8');
  assert.doesNotMatch(ps1, /\$User\b/, 'no account name, from the installer or anywhere else');
  assert.doesNotMatch(ps1, /MethodName GetOwner\b/, 'a name says nothing on an Entra account or under another account\'s elevation');
  // The account is the owner of the installer's process; every candidate is compared to it by SID.
  assert.match(ps1, /Get-CimInstance Win32_Process -Filter "ProcessId=\$InstallerPid"/);
  assert.match(ps1, /\$account = & \$sidOf \$installer/);
  assert.match(ps1, /\$sidOf = \{\s+param\(\$process\)\s+try \{ \(Invoke-CimMethod -InputObject \$process -MethodName GetOwnerSid -ErrorAction Stop\)\.Sid \}/);
  assert.match(ps1, /\$mine = \{ param\(\$process\) \$account -and \(\(& \$sidOf \$process\) -eq \$account\) \}/);
  // What runs from this installation is ended whoever owns it: the shipped
  // Node, and a runtime whose command line names a file of the installation.
  const own = ps1.match(/\$fromInstallation = \{\n([\s\S]*?)\n\}\n/)?.[1] ?? '';
  assert.match(own, /\$process\.ExecutablePath\.ToLowerInvariant\(\)\.StartsWith\(\$shipped\)/);
  assert.match(own, /foreach \(\$needle in \$needles\)/);
  assert.match(own, /-not \$root/, 'without an installation directory, nothing is of the installation');
  assert.doesNotMatch(own, /\$mine|\$account|sidOf/, 'no account filter under the installation');
  assert.match(ps1, /\$shipped = "\$root\\resources\\node\\"/);
  assert.match(ps1, /\$ofInstallation = \{ & \$processes \| Where-Object \{ & \$fromInstallation \$_ \} \}/);
  assert.match(ps1, /\$found = @\(& \$ofInstallation\)[\s\S]*?\$found \| ForEach-Object \{ & \$end \$_ '[^']+' \}/);
  // The resume is this script again: it takes the same parameters.
  assert.doesNotMatch(ps1, /-Resume[^\n]*\n[^\n]*-User/);
});

// The net under the fix above: whatever the pause missed (a refused elevation,
// a filter that is wrong again), the installer never replaces the files of a
// daemon that still runs. Windows renames a running executable without a word.
test('the installer stops when something of Timon still runs after the pause', async () => {
  const nsh = readFileSync(join(root, 'build', 'installer.nsh'), 'utf8');
  const ps1 = readFileSync(join(root, 'build', 'timon-service-pause.ps1'), 'utf8');
  const { NSIS_SERVICE_PAUSE_FAILED, NSIS_SERVICE_STILL_RUNNING } = await import('./update-installer.js');
  const service = readFileSync(join(root, '..', 'orchestrator', 'src', 'host', 'service-install.ts'), 'utf8');

  // One number, in the script, the installer, the shell and the host adapter.
  assert.match(nsh, new RegExp(`!define TIMON_SERVICE_STILL_RUNNING ${NSIS_SERVICE_STILL_RUNNING}\\b`));
  assert.match(ps1, new RegExp(`\\$stillRunning = ${NSIS_SERVICE_STILL_RUNNING}\\b`));
  assert.match(service, new RegExp(`export const PROCESSES_REMAIN = ${NSIS_SERVICE_STILL_RUNNING};`));
  // And one for a pause that reached no verdict, which the script itself never answers.
  assert.match(nsh, new RegExp(`!define TIMON_SERVICE_PAUSE_FAILED ${NSIS_SERVICE_PAUSE_FAILED}\\b`));
  assert.notEqual(NSIS_SERVICE_PAUSE_FAILED, NSIS_SERVICE_STILL_RUNNING);
  assert.doesNotMatch(ps1, new RegExp(`exit ${NSIS_SERVICE_PAUSE_FAILED}\\b`));

  // The script lists what is left once everything was ended and the resume started.
  const net = ps1.slice(ps1.indexOf('# The net.'));
  assert.ok(net.length > 0 && ps1.indexOf('# The net.') > ps1.lastIndexOf('MethodName Create'), 'after the resume is started: a refused install still enables the task again');
  assert.match(net, /\$remaining = \{\s+\$left = @\(& \$ofInstallation\)/, 'the processes of this installation');
  assert.match(net, /Get-NetTCPConnection -State Listen -LocalPort \$port -ErrorAction Stop/, 'and whoever listens on the daemon port');
  assert.match(net, /\$port = 3010\b/, `the packaged default (${PACKAGED_DEFAULTS.daemon.listen.port})`);
  assert.equal(PACKAGED_DEFAULTS.daemon.listen.port, 3010);
  assert.match(net, /Join-Path \$TimonHome 'timon\.config\.json'[\s\S]*\$config\.daemon\.listen\.port/, 'or the port this home configured');
  // A listener whose command line cannot be read is the session-0 daemon seen without elevation.
  assert.match(net, /if \(-not \$listener\.CommandLine\) \{ \$left \+= \$listener; continue \}/);
  assert.match(net, /\$runtimes -notcontains \$listener\.Name\) \{ continue \}/, 'a foreign program on the port is not waited for');
  assert.match(net, /if \(\$left\.Count -gt 0\) \{[\s\S]*exit \$stillRunning\s+\}\s+& \$note '[^']+'\s+exit 0\s*$/);
  // The 0 the installer waits for is said in one place only: after that list came back empty.
  assert.equal((ps1.slice(ps1.indexOf('# The stop phase writes')).match(/^\s*exit 0\s*$/gm) ?? []).length, 1);

  // The installer reads that code: Retry or Cancel with a window, an exit code without one.
  const pause = nsh.match(/!macro timonPauseService\s+([\s\S]*?)!macroend/)?.[1] ?? '';
  assert.equal((pause.match(/-TimonHome "\$3"/g) ?? []).length, 2, 'both runs know the data directory');
  assert.match(pause, /ReadEnvStr \$3 TIMON_HOME\s+\$\{If\} \$3 == ""\s+StrCpy \$3 "\$PROFILE\\\.timon"/, 'read while the installer runs');
  const loop = pause.match(/\$\{Do\}([\s\S]*?)\$\{Loop\}/)?.[1] ?? '';
  assert.ok(loop.includes('"runas"') && loop.includes('"open"'), 'Retry asks for the elevation again');
  // Fail closed: one way out of the loop, the script's own 0. A script that
  // could not be started, or that ended on anything else, has checked neither
  // the port nor the processes, and stops the installer like a daemon left alive.
  assert.equal((loop.match(/\$\{ExitDo\}/g) ?? []).length, 1);
  assert.match(loop, /\$\{If\} \$1 == "ok"\s+\$\{AndIf\} \$0 == 0\s+\$\{ExitDo\}\s+\$\{EndIf\}/, 'only "nothing of Timon runs any more" goes on');
  assert.doesNotMatch(loop, /!= "ok"\s+\$\{(OrIf|ExitDo)\}/, 'a script that did not run never lets the installer through');
  const verdict = loop.slice(loop.indexOf('${ExitDo}'));
  assert.match(verdict, /StrCpy \$4 \$\{TIMON_SERVICE_PAUSE_FAILED\}\s+\$\{If\} \$1 != "ok"[\s\S]*?\$\{ElseIf\} \$0 == \$\{TIMON_SERVICE_STILL_RUNNING\}\s+StrCpy \$4 \$\{TIMON_SERVICE_STILL_RUNNING\}\s+\$\{EndIf\}/,
    'a failure unless the script itself said that something still runs');
  // No window under /S: the exit code, whichever of the two it is.
  assert.match(verdict, /\$\{If\} \$\{Silent\}\s+SetErrorLevel \$4\s+Quit\s+\$\{EndIf\}/);
  // With a window, Retry or Cancel, and Cancel leaves with that code. One message per case.
  const boxes = [...verdict.matchAll(/\$\{If\} \$\{Cmd\} `MessageBox MB_RETRYCANCEL\|MB_ICONEXCLAMATION "([^`]*)" IDCANCEL`\s+SetErrorLevel \$4\s+Quit\s+\$\{EndIf\}/g)].map((box) => box[1]!);
  assert.equal(boxes.length, 2);
  assert.match(boxes[0]!, /still running in the background and could not be stopped/);
  assert.match(boxes[1]!, /check that Timon is stopped in the background did not run: Windows PowerShell failed \(PowerShell: \$1, result: \$0\)/);
  assert.match(verdict, /\$\{If\} \$4 == \$\{TIMON_SERVICE_STILL_RUNNING\}\s+\$\{If\} \$\{Cmd\}[\s\S]*?\$\{Else\}\s+\$\{If\} \$\{Cmd\}/);
  for (const box of boxes) {
    assert.match(box, /No file has been changed\./);
    assert.match(box, /Details: \$3\\tmp\\timon-service-pause\.log/, 'the message names the journal');
    assert.ok(box.length < 700, 'an NSIS string holds 1024 characters, the data directory included');
  }
  assert.ok(verdict.indexOf('${If} ${Silent}') < verdict.indexOf('MessageBox'), 'never a message box under /S');
  assert.equal((verdict.match(/\bQuit\b/g) ?? []).length, 3, 'silent, and Cancel of either message');
  // The script wrote nothing then: the installer leaves the line in its journal, for the diagnostic report.
  assert.match(verdict, /\$\{If\} \$4 == \$\{TIMON_SERVICE_PAUSE_FAILED\}[\s\S]*?FileOpen \$5 "\$3\\tmp\\timon-service-pause\.log" a\s+\$\{IfNot\} \$\{Errors\}\s+FileSeek \$5 0 END\s+FileWrite \$5 "installer: the service pause did not complete \(PowerShell: \$1, result: \$0\)[^"]*"\s+FileClose \$5/);
  assert.ok(verdict.indexOf('FileWrite $5') < verdict.indexOf('${If} ${Silent}'), 'written under /S too');
  assert.match(pause, /Push \$4\s+Push \$5[\s\S]*Pop \$5\s+Pop \$4\s+Pop \$3/, 'the registers it borrows are given back');
});

// 0.1.7 to 0.1.8 update: the pause ended nothing on two testers' PCs and no
// file said so. It ran with every error silenced and every output discarded.
test('the service pause writes what it found and did to its journal', () => {
  const ps1 = readFileSync(join(root, 'build', 'timon-service-pause.ps1'), 'utf8');
  const stop = ps1.slice(ps1.indexOf('# The stop phase writes'));
  assert.ok(stop.length > 0 && ps1.indexOf('# The stop phase writes') > ps1.indexOf('if ($Resume) {'));
  // Nothing silenced, nothing discarded: a failure is caught and written.
  assert.doesNotMatch(ps1, /ErrorActionPreference/);
  assert.doesNotMatch(stop, /SilentlyContinue|Out-Null/);
  assert.match(ps1, /\$Log = Join-Path \$TimonHome 'tmp\\timon-service-pause\.log'/);
  // Elevated or not, the account expected, the installation and the data directory.
  assert.match(stop, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
  assert.match(stop, /& \$note \("pause: start, elevated: \{0\}, installer pid \{1\}, account SID \{2\} \(from \{3\}\), installation '\{4\}', data '\{5\}'" -f \$elevated, \$InstallerPid, \$account, \$accountSource, \$InstallDir, \$TimonHome\)/);
  // The task: its state before and after, and what each call answered.
  assert.match(stop, /pause: task \{0\} is \{1\}" -f \$task, \(& \$taskState\)/);
  assert.match(stop, /try \{\s+\$null = Disable-ScheduledTask -TaskName \$task -TaskPath '\\' -ErrorAction Stop\s+& \$note 'pause: task disabled'\s+\} catch \{ & \$note "pause: task not disabled: \$\(\$_\.Exception\.Message\)" \}/);
  assert.match(stop, /Stop-ScheduledTask -TaskName \$task -TaskPath '\\' -ErrorAction Stop\s+& \$note 'pause: task stopped'\s+\} catch \{ & \$note "pause: task not stopped:/);
  assert.match(stop, /pause: task \{0\} is now \{1\}/);
  // Every process found: pid, name, session, path. Never the command line, which can carry a secret.
  assert.match(stop, /"pid \$\(\$process\.ProcessId\), \$\(\$process\.Name\), session \$\(\$process\.SessionId\), \$path"/);
  const describe = stop.match(/\$describe = \{\n([\s\S]*?)\n\}\n/)?.[1] ?? '';
  assert.match(describe, /ExecutablePath/);
  assert.doesNotMatch(describe, /CommandLine/);
  assert.doesNotMatch(stop, /\$note[^\n]*CommandLine/, 'no command line reaches the journal');
  // Every taskkill: which process, its exit code and what it said.
  const end = stop.match(/\$end = \{\n([\s\S]*?)\n\}\n/)?.[1] ?? '';
  assert.match(end, /& \$note \("pause: found \{0\}: \{1\}" -f \$what, \(& \$describe \$process\)\)/);
  assert.match(end, /\$said = \(& taskkill\.exe \/F \/T \/PID \$process\.ProcessId 2>&1 \| ForEach-Object \{ "\$_"\.Trim\(\) \}\) -join ' '/);
  assert.match(end, /pause: taskkill of pid \{0\} ended with \{1\}: \{2\}" -f \$process\.ProcessId, \$LASTEXITCODE, \$said/);
  assert.equal((stop.match(/taskkill\.exe/g) ?? []).length, 1, 'no process is ended outside the journaled call');
  // A daemon left alone for its owner is written with that owner: a wrong
  // account is how the pause once ended nothing.
  assert.match(stop, /pause: not this account's \(owner SID \{0\}\)/);
  assert.match(stop, /pause: \{0\} service launcher\(s\) of this account/);
  assert.match(stop, /pause: \{0\} daemon\(s\) by entry point/);
  assert.match(stop, /pause: installation sweep \{0\}: \{1\} process\(es\)/);
  // What is left, and the verdict handed to the installer.
  assert.match(stop, /pause: checking what is left, daemon port \{0\} \(from \{1\}\)/);
  assert.match(stop, /foreach \(\$process in \$left\) \{ & \$note \("pause: still running: \{0\}" -f \(& \$describe \$process\)\) \}/);
  assert.match(stop, /pause: exit \{0\}, \{1\} process\(es\) of Timon still run/);
  assert.match(stop, /& \$note 'pause: exit 0, nothing of Timon runs any more'\s+exit 0\s*$/);
  // The resume says how it ended too, and the journal does not grow without bound.
  assert.match(ps1, /resume: the installer exited, task \{0\} is \{1\}/);
  assert.match(stop, /\.Length -gt 1MB\) \{ Remove-Item -LiteralPath \$Log/);
});

// VM, 06/11/2026: an installer killed from SSH left the task Disabled and the
// daemon stopped. SilentlyContinue hid any failure of the resume, and the
// resume itself, a child of the pause, died with the SSH session's job object.
test('the service resume reports its failures, tries again and outlives the session that started it', () => {
  const ps1 = readFileSync(join(root, 'build', 'timon-service-pause.ps1'), 'utf8');
  const resume = ps1.match(/\nif \(\$Resume\) \{\n([\s\S]*?)\n\}\n/)?.[1] ?? '';
  assert.ok(resume.includes('Enable-ScheduledTask'), 'the resume block is found');
  assert.doesNotMatch(resume, /SilentlyContinue/);
  for (const call of ['Enable-ScheduledTask', 'Start-ScheduledTask']) {
    const line = resume.split('\n').find((text) => text.includes(call)) ?? '';
    assert.match(line, /-ErrorAction Stop/, `${call} reports its error`);
  }
  assert.match(resume, /foreach \(\$attempt in 1\.\.3\)[\s\S]*Start-Sleep -Seconds \d+/, 'a bounded retry');
  assert.match(resume, /\$failure\) \{ & \$note /, 'the last failure is written to the log');
  assert.match(ps1, /Add-Content -LiteralPath \$Log -Value [^\n]* -Encoding UTF8 -ErrorAction Stop/, 'the diagnostic report reads it as UTF-8');
  assert.match(ps1, /\$Log = Join-Path \$TimonHome 'tmp\\timon-service-pause\.log'/);
  assert.match(ps1, /\$TimonHome = Join-Path \$env:USERPROFILE '\.timon'/, 'the default home when the installer names none');
  // A task found Disabled is enabled whatever left it so; an uninstall's
  // deleted task is not an error.
  assert.match(resume, /-eq 'Disabled'\) \{ Enable-ScheduledTask/);
  assert.match(resume, /ObjectNotFound/);
  assert.match(resume, /while \(Get-Process -Id \$InstallerPid/, 'no resume while the installer still runs');
  // Created by WMI, outside the caller's job, hidden from the start (TIM-0030);
  // the log path travels with it, since its environment is WMI's.
  assert.match(ps1, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(ps1, /ShowWindow = \[uint16\]0/);
  assert.match(ps1, /-WindowStyle Hidden -File `"\$copy`" -Resume/);
  assert.match(ps1, /if \(\$Log\) \{ \$arguments \+= " -Log `"\$Log`""/);
});

// Onboarding on a blank Windows: winget from the session-0 service cannot ask
// for permission, and the Node.js MSI needs it. The installer asks once.
test('the NSIS installer installs missing Node.js and Git with one elevation', () => {
  const nsh = readFileSync(join(root, 'build', 'installer.nsh'), 'utf8');
  const install = nsh.match(/!macro customInstall\s+([\s\S]*?)!macroend/)?.[1] ?? '';
  assert.match(install, /!insertmacro timonPrerequisites/);
  const prereq = nsh.match(/!macro timonPrerequisites\s+([\s\S]*?)!macroend/)?.[1] ?? '';
  assert.match(prereq, /\$\{IfNot\} \$\{Silent\}/, 'never prompt under /S');
  assert.ok(prereq.includes('nodejs\\node.exe') && prereq.includes('Git\\cmd\\git.exe'), 'only what is missing');
  assert.match(prereq, /"runas"/);
  const ps1 = readFileSync(join(root, 'build', 'timon-prerequisites.ps1'), 'utf8');
  // The onboarding's id: LTS and current are MSIs that refuse each other (1603).
  const machine = readFileSync(join(root, '..', 'orchestrator', 'src', 'host', 'machine.ts'), 'utf8');
  const nodeId = machine.match(/node: \{[^}]*winget: '([^']+)'/)?.[1];
  assert.ok(nodeId && ps1.includes(`'${nodeId}'`), `the installer installs ${nodeId}, like the onboarding`);
  assert.ok(ps1.includes("Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'nodejs\\node.exe')"), 'an installed Node.js is skipped');
  assert.match(ps1, /Git\.Git/);
  assert.match(ps1, /--source winget/, 'the msstore source fails unattended (TIM-0022)');
  assert.match(ps1, /--silent/);
});

// 0.1.2-rc.5 reinstall: the fallback deleted the task and kept its revision.
test('the NSIS uninstaller removes the launcher files once the task is deleted', () => {
  const nsh = readFileSync(join(root, 'build', 'installer.nsh'), 'utf8');
  const uninstall = nsh.match(/!macro customUnInstall\s+([\s\S]*?)!macroend/)?.[1] ?? '';
  const cleanup = uninstall.match(/\$\{If\} \$0 == 0\s+([\s\S]*?)\$\{EndIf\}\s+DetailPrint "Timon data has been kept\."/)?.[1] ?? '';
  for (const file of ['service-revision', 'timon-service.json', 'timon-service.cmd', 'timon-service.vbs', 'session-witness.dpapi', 'service-repair-declined']) {
    assert.ok(cleanup.includes(`Delete "$PROFILE\\.timon\\run\\${file}"`), file);
  }
});

test('the NSIS installer removes the daemon task, and never registers it', () => {
  assert.match(yml, /include:\s*build\/installer\.nsh/);
  const nsh = readFileSync(join(root, 'build', 'installer.nsh'), 'utf8');
  assert.match(nsh, /!macro customUnInstall/);
  assert.ok(nsh.includes('service uninstall'), 'installer.nsh must call `timon service uninstall`');
  const install = nsh.match(/!macro customInstall\s+([\s\S]*?)!macroend/)?.[1];
  assert.ok(install, 'the install hook exposes the packaged CLI');
  assert.match(install, /!insertmacro timonCliPath install/);
  assert.doesNotMatch(install, /service|schtasks/i, 'service registration remains owned by first run');
  assert.doesNotMatch(
    nsh,
    /nsExec[^\n]*service install/,
    'no config file exists yet at install time: the values would be the developer defaults',
  );
  // The CLI runs on the Node the package ships: a machine with no Node
  // installed must still be able to remove the task, and the app's executable
  // no longer runs as Node (RunAsNode fuse off, TODO #764).
  assert.match(nsh, /"\$INSTDIR\\resources\\node\\node\.exe" "\$INSTDIR\\resources\\orchestrator\\bin\\timon" service uninstall/);
  assert.doesNotMatch(nsh, /ELECTRON_RUN_AS_NODE/);
  assert.doesNotMatch(nsh, /schtasks[^\n]*\/Create/i);
  assert.doesNotMatch(nsh, /\/XML/i);
  assert.match(nsh, /\/Delete \/TN TimonOrchestrator \/F/);
  const service = readFileSync(join(root, '..', 'orchestrator', 'src', 'host', 'service-install.ts'), 'utf8');
  const taskName = service.match(/export const WINDOWS_TASK = '([^']+)'/u)?.[1];
  assert.ok(taskName, 'the host adapter declares the task name');
  const targets = [...nsh.matchAll(/\/TN ([A-Za-z0-9_-]+)/g)].map(match => match[1]);
  assert.ok(targets.length > 0);
  assert.ok(targets.every(name => name === taskName), 'all cleanup commands target the host task');
  // The desktop's copies of what the host adapter writes for the task.
  const desktopService = readFileSync(join(root, 'src', 'service.ts'), 'utf8');
  assert.equal(desktopService.match(/export const WINDOWS_TASK = '([^']+)'/u)?.[1], taskName);
  const revision = service.match(/export const WINDOWS_SERVICE_REVISION = '([^']+)'/u)?.[1];
  assert.ok(revision);
  assert.equal(desktopService.match(/export const WINDOWS_SERVICE_REVISION = '([^']+)'/u)?.[1], revision);
  // The marker `timon service stop` leaves, read by the desktop at launch.
  assert.match(service, /export function serviceStoppedMarker\(timonHome: string\): string \{\s*return join\(timonHome, 'run', 'service-stopped'\);/u);
  assert.match(desktopService, /export function serviceStoppedMarkerFile\(home: string\): string \{ return join\(home, 'run', 'service-stopped'\); \}/u);
  // macOS: where the LaunchDaemon lives, read by the desktop without the host adapter.
  const daemonsDir = service.match(/export const MACOS_LAUNCH_DAEMONS_DIR = '([^']+)'/u)?.[1];
  assert.ok(daemonsDir);
  assert.equal(desktopService.match(/export const MACOS_LAUNCH_DAEMONS_DIR = '([^']+)'/u)?.[1], daemonsDir);
  for (const file of ['service-revision', 'timon-service.vbs', 'timon-service.cmd', 'timon-service.json', 'service-repair-declined', 'service-rewrite-declined', 'service-refused']) {
    assert.ok(service.includes(`'${file}'`) && desktopService.includes(`'${file}'`), file);
  }
  // The mark a service daemon refused the home leaves, read by the late handover.
  const homeLock = readFileSync(join(root, '..', 'orchestrator', 'src', 'home-lock.ts'), 'utf8');
  assert.match(homeLock, /export const serviceHeldOutFile = \(home: string\): string => join\(home, 'run', 'service-held-out'\);/u);
  assert.match(desktopService, /export function serviceHeldOutFile\(home: string\): string \{ return join\(home, 'run', 'service-held-out'\); \}/u);
  // TODO #342: the "never ran" result the desktop reads after `/Run`.
  const neverRan = service.match(/export const WINDOWS_TASK_NEVER_RAN = (0x[0-9a-f]+);/u)?.[1];
  assert.ok(neverRan);
  assert.equal(desktopService.match(/export const WINDOWS_TASK_NEVER_RAN = (0x[0-9a-f]+);/u)?.[1], neverRan);
  // TIM-0107: the desktop seals the session witness again with its own copies of what the host adapter does.
  const witnessText = service.match(/const SESSION_WITNESS_TEXT = '([^']+)'/u)?.[1];
  assert.ok(witnessText);
  assert.equal(desktopService.match(/export const SESSION_WITNESS_TEXT = '([^']+)'/u)?.[1], witnessText);
  assert.ok(service.includes("'session-witness.dpapi'") && desktopService.includes("'session-witness.dpapi'"));
  for (const expression of [
    "ConvertTo-SecureString -String '${SESSION_WITNESS_TEXT}' -AsPlainText -Force | ConvertFrom-SecureString -ErrorAction Stop",
    'ConvertTo-SecureString -String (Get-Content -LiteralPath $f -Raw -ErrorAction Stop).Trim() -ErrorAction Stop',
    "PtrToStringBSTR($b) -eq '${SESSION_WITNESS_TEXT}'",
  ]) {
    assert.ok(service.includes(expression) && desktopService.includes(expression), expression);
  }
  // `windowsLauncherUnmarked` reads the marker where the host adapter does (TIM-0087):
  // `env` of the configuration, or the line the batch of revisions 2 to 5 wrote per variable.
  assert.ok(service.includes("return config.env.TIMON_DESKTOP_SERVICE === '1';"));
  assert.ok(desktopService.includes("return env?.TIMON_DESKTOP_SERVICE !== '1';"));
  assert.ok(service.includes('/^set "TIMON_DESKTOP_SERVICE=1"\\r?$/m') && desktopService.includes('/^set "TIMON_DESKTOP_SERVICE=1"\\r?$/m'));
  // The executable the logon task starts, its switch, and the programs a launcher runs as.
  assert.equal(service.match(/export const WINDOWS_APP_EXECUTABLE = '([^']+)'/u)?.[1], `${yml.match(/^productName:\s*(\S+)/m)?.[1]}.exe`);
  const shell = readFileSync(join(root, 'src', 'windows-service-shell.ts'), 'utf8');
  assert.equal(shell.match(/export const WINDOWS_SERVICE_FLAG = '([^']+)'/u)?.[1], service.match(/export const WINDOWS_SERVICE_FLAG = '([^']+)'/u)?.[1]);
  const programs = (text: string, name: string) => new RegExp(`${name} = (\\[[^\\]]*\\])`).exec(text)?.[1];
  assert.equal(programs(desktopService, 'WINDOWS_LAUNCHER_PROGRAMS'), programs(service, 'LAUNCHER_PROGRAMS')?.replace("WINDOWS_APP_EXECUTABLE.toLowerCase()", "'timon.exe'"));
  // The macOS label and the packaged ports are copied the same way: both sides must agree.
  const label = service.match(/export const MACOS_LABEL = '([^']+)'/u)?.[1];
  assert.ok(label);
  assert.equal(desktopService.match(/export const MACOS_SERVICE_LABEL = '([^']+)'/u)?.[1], label);
  const hostPorts = readFileSync(join(root, '..', 'orchestrator', 'src', 'host', 'service-environment.ts'), 'utf8')
    .match(/const PACKAGED_PORTS = \{ daemon: (\d+), app: (\d+) \}/u);
  assert.ok(hostPorts);
  assert.equal(PACKAGED_DEFAULTS.daemon.listen.port, Number(hostPorts[1]));
  assert.equal(PACKAGED_DEFAULTS.app.listen.port, Number(hostPorts[2]));
  // The update exit must precede both CLI execution and the direct fallback.
  assert.match(nsh, /Push \$2\s+(?:;[^\n]*\n\s*)*\$\{If\} \$\{isUpdated\}\s+Goto timon_task_done\s+\$\{EndIf\}/);
  assert.match(nsh, /timon_task_done:\s+Pop \$2\s+Pop \$1\s+Pop \$0\s+!macroend/);
});

test('the desktop reads a service\'s home the way the host adapter does', () => {
  // TODO #735: what `hasDesktopService` says and what the runners refuse must
  // not disagree, or the tray offers a stop that its own runner refuses.
  const host = (file: string) => readFileSync(join(root, '..', 'orchestrator', 'src', 'host', file), 'utf8');
  const desktop = readFileSync(join(root, 'src', 'service.ts'), 'utf8');
  const fn = (source: string, name: string): string => {
    const match = source.match(new RegExp(`^(?:export )?function ${name}\\(.*?^\\}$`, 'msu'))?.[0];
    assert.ok(match, name);
    return match.replace(/^export /u, '');
  };
  for (const [file, names] of [
    ['orphan-services.ts', ['unescapeXml', 'homeOfPlist']],
    ['service-ownership.ts', ['unquoteShell', 'realOrNull', 'normalized', 'samePath']],
  ] as const) {
    for (const name of names) assert.equal(fn(desktop, name), fn(host(file), name), name);
  }
  // What those copies read is what the renderers write.
  const install = host('service-install.ts');
  assert.match(install, /return join\(timonHome, 'run', 'timon-service\.sh'\);/u);
  assert.ok(desktop.includes(String.raw`\/run\/timon-service\.sh`));
  assert.ok(install.includes('`export ${key}=${shQuote(value)}`'), 'the launcher exports each variable, quoted');
  assert.ok(desktop.includes(String.raw`^export TIMON_HOME='`));
  assert.ok(install.includes('<string>${escapeXml(macosLauncherPath(opts.timonHome))}</string>'), 'the plist names the launcher');
  assert.ok(install.includes('`    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`'), 'the plists set each variable');
  // The refusal says what the host adapter's says.
  assert.ok(host('service-ownership.ts').includes(': it was left in place.`') && desktop.includes(': it was left in place.`'));
  // Same fallback for a plist that names no home.
  assert.ok(host('service-ownership.ts').includes("homeOfPlist(daemon) ?? join(opts.homeDir, '.timon')"));
  assert.ok(desktop.includes("homeOfPlist(plist) ?? join(userHome, '.timon')"));
});

test('the desktop sweeps the same processes as the uninstall', () => {
  // TODO #458: `orphanNeedles` is a copy of `installationProcessNeedles`, the two
  // packages being independent. A needle added on one side only lets the quit
  // sweep and the uninstall disagree on what belongs to the installation.
  const body = (source: string, name: string, pathAlias: string): string => {
    const match = source.match(new RegExp(`export function ${name}\\(installDir: string\\): string\\[\\] \\{\\s*return \\[([^\\]]+)\\];`, 'u'));
    assert.ok(match?.[1], `${name} returns a literal list`);
    return match[1].replaceAll(`${pathAlias}.`, 'path.').replace(/\s+/gu, ' ').trim();
  };
  const service = readFileSync(join(root, '..', 'orchestrator', 'src', 'host', 'service-install.ts'), 'utf8');
  const embedded = readFileSync(join(root, 'src', 'embedded.ts'), 'utf8');
  const host = body(service, 'installationProcessNeedles', 'winPath');
  assert.equal(body(embedded, 'orphanNeedles', 'win32'), host);
  assert.ok(host.includes("'boot.js'") && host.includes("'browser-mcp.mjs'"));
});

test('the three targets of §5.5 are declared', () => {
  assert.match(yml, /- AppImage/);
  assert.match(yml, /- deb/);
  assert.match(yml, /- dmg/);
  assert.match(yml, /- nsis/);
});

test('every installer the package builds is one the in-app update can install (P3)', () => {
  // The shell picks its own format (`pickArtifact`) and installs it (`UpdateController.install`):
  // a target added here without its install path would be offered and never installed.
  const download = readFileSync(join(root, 'src', 'update-download.ts'), 'utf8');
  const install = readFileSync(join(root, 'src', 'update-ipc.ts'), 'utf8');
  for (const [target, format] of [['AppImage', 'appimage'], ['deb', 'deb'], ['pkg', 'pkg'], ['nsis', 'nsis']] as const) {
    assert.match(yml, new RegExp(`- ${target}\\b`), target);
    assert.match(download, new RegExp(`'${format}'`), format);
  }
  assert.match(install, /format === 'appimage'/);
  assert.match(install, /format === 'deb'/);
  assert.match(install, /format === 'nsis'/);
  // The Windows installer opens as a visible assistant, never silently (`/S` is P4).
  assert.match(yml, /oneClick: false/);
  assert.doesNotMatch(install, /['"]\/S['"]/);
});

test('the appId carries the brand, frozen in phase R', () => {
  assert.match(yml, /appId:\s*com\.timon\.desktop/);
  assert.match(yml, /productName:\s*Timon/);
});

/**
 * `fpm` refuses to build the .deb without a maintainer and a homepage — and it
 * only says so AFTER the AppImage succeeded, so the failure looks like a
 * packaging bug rather than two missing fields (observed 04/09/2026).
 */
test('the .deb has the metadata fpm requires', () => {
  assert.match(pkg.homepage ?? '', /^https:\/\//);
  assert.ok(pkg.author?.email, 'the Debian maintainer comes from author.email');
});

test('the entry point is the compiled main process', () => {
  assert.equal(pkg.main, 'dist/main.js');
});

/**
 * Last line of defence on the DEV instance marker.
 *
 * `app/.next` is built on the development machine and shipped as-is. The
 * manifest route is `force-dynamic` precisely so the instance name is resolved
 * by the running server (`app/src/lib/instance.ts`), and `embeddedEnv` strips
 * the variable from what a packaged client passes down. Should either guard
 * ever regress, the symptom is a prerendered body carrying "DEV" — a name and
 * an icon burned into every user's home screen, with no way to fix it short of
 * a new release. Cheap to check, expensive to miss.
 */
test('no build artefact carries the DEV instance into the package', () => {
  const body = join(root, '..', 'app', '.next', 'server', 'app', 'manifest.webmanifest.body');
  if (!existsSync(body)) return; // nothing built here yet — the release build will produce it
  const manifest = JSON.parse(readFileSync(body, 'utf8')) as { name?: string; short_name?: string };
  assert.ok(
    !`${manifest.name ?? ''} ${manifest.short_name ?? ''}`.includes('DEV'),
    'the prerendered manifest names the DEV instance: `force-dynamic` no longer holds in app/src/app/manifest.ts',
  );
});

test('distribution requires the signed daemon staging and verifies from the shell', () => {
  assert.match(yml, /beforePack: .\/scripts\/release-hooks\.mjs/);
  assert.match(yml, /afterPack: .\/scripts\/release-hooks\.mjs/);
  assert.match(yml, /asar: true/);
  assert.match(yml, /from: build-resources\/daemon-release\/dist/);
  assert.doesNotMatch(yml, /from: \.\.\/orchestrator\/dist/);
  assert.match(yml, /to: orchestrator\/release-manifest\.sig/);
  // Built-in plugins ship from the signed staging, never from the repo's examples.
  assert.match(yml, /from: build-resources\/daemon-release\/builtin-plugins\n\s+to: orchestrator\/builtin-plugins\n/);
  assert.match(yml, /from: build-resources\/daemon-release\/builtin-plugins\.json\n\s+to: orchestrator\/builtin-plugins\.json/);
  // Channel and expiry of the build: embedded next to dist/, guarded by afterPack.
  assert.match(yml, /from: build-resources\/daemon-release\/build-info\.json\n\s+to: orchestrator\/build-info\.json/);
  assert.match(readFileSync(join(root, 'scripts/release-hooks.mjs'), 'utf8'), /assertPackagedBuildInfo\(installed, /);
  assert.doesNotMatch(yml, /from: \.\.\/examples/);
  // The key must land INSIDE app.asar (main.ts reads it from `getAppPath()`).
  // `from:` is a base DIRECTORY for electron-builder: the file path this pins
  // against was accepted by the YAML, dropped by the packer, and killed every
  // packaged client with ENOENT. What actually proves the embedding is the
  // afterPack guard, which reads the archive.
  assert.doesNotMatch(yml, /from: build-resources\/release-public-key\.pem/);
  assert.match(yml, /from: build-resources\n\s+to: \.\n\s+filter:\n\s+- release-public-key\.pem/);
  assert.match(readFileSync(join(root, 'scripts/release-hooks.mjs'), 'utf8'),
    /assertPackagedPublicKey\(resources, keys\.publicKey\)/);
  assert.match(yml, /scripts\/release-integrity\.mjs/);
  // The desktop checks in a worker (TODO #439): its script must travel next to the module it loads.
  assert.match(yml, /scripts\/release-integrity-worker\.mjs/);
  const main = readFileSync(join(root, 'src/main.ts'), 'utf8');
  assert.match(main, /if \(app\.isPackaged\) await verifyInstalledRelease\(\)/);
  assert.match(main, /verifyReleaseInWorker\(join\(process\.resourcesPath, 'orchestrator'\)/);
  const body = main.slice(main.indexOf('async function main()'));
  assert.ok(body.indexOf('await verifyInstalledRelease()') < body.indexOf('nativeBrowser = new NativeBrowserEngine'));
  assert.ok(body.indexOf('await verifyInstalledRelease()') < body.indexOf('loadDesktopConfig('));
});

test('native package CLI hooks exist at their builder-resolved paths', () => {
  for (const hook of ['afterInstall', 'afterRemove']) {
    const path = yml.match(new RegExp(`${hook}: (.+)`))?.[1];
    assert.ok(path);
    assert.ok(existsSync(join(root, path)));
  }
  const scripts = yml.match(/pkg:\s+scripts: (.+)/)?.[1];
  assert.ok(scripts);
  assert.ok(existsSync(join(root, 'build', scripts, 'postinstall')));
  assert.match(yml, /isRelocatable: false/);
  assert.match(yml, /allowCurrentUserHome: false/);
});

/**
 * Local dictation (TODO #443). The recognizer is one native package per OS;
 * the five must move together (one version, so every OS runs the same
 * engine), stay optional (npm installs the build machine's only), and be
 * unpacked from the archive or the OS loader cannot open them. `zod`
 * validates the speech IPC in the packaged main process: as a devDependency
 * it would be missing from the package and the shell would die at import.
 */
test('the dictation recognizer travels unpacked, one version for every OS', () => {
  const manifest = pkg as unknown as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const optional = manifest.optionalDependencies ?? {};
  const names = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win-x64'].map((t) => `sherpa-onnx-${t}`);
  const versions = new Set(names.map((name) => optional[name]));
  assert.equal(versions.size, 1, 'the five sherpa-onnx packages must pin the same version');
  const [version] = [...versions];
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/, 'pin an exact version: the addon is loaded by a path, not a semver range');
  assert.equal(optional['sherpa-onnx'], undefined, 'the main sherpa-onnx package is the WASM build, which cannot read model files');
  assert.ok(manifest.dependencies?.zod, 'zod must be a runtime dependency of the desktop package');
  assert.match(yml, /asarUnpack:\n\s+- node_modules\/sherpa-onnx-\*\/\*\*/);
});

/**
 * macOS records silence, without ever prompting, when a hardened-runtime
 * build lacks the audio-input entitlement. The entitlement files replace
 * electron-builder's template, so its keys must be kept: losing
 * disable-library-validation stops the dictation engine from loading its
 * libraries on a signed build.
 */
test('a signed macOS build may use the microphone and the camera, and still load the dictation engine', () => {
  assert.match(yml, /\nmac:\n(?: {2}.*\n|\s*#.*\n)*? {2}hardenedRuntime: true\n/);
  assert.match(yml, /NSMicrophoneUsageDescription: "[^"]*dictation[^"]*site[^"]*"/, 'the prompt names dictation and keeps the site case');
  // electron-builder hands an `entitlements:` path to codesign verbatim.
  assert.doesNotMatch(yml, /^\s+entitlements(Inherit)?:/m, 'use the build/ convention, not a cwd-relative path');
  for (const file of ['entitlements.mac.plist', 'entitlements.mac.inherit.plist']) {
    const plist = readFileSync(join(root, 'build', file), 'utf8');
    for (const key of [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
      'com.apple.security.device.audio-input',
      // The built-in browser shares the camera with a site (TODO #446).
      'com.apple.security.device.camera',
    ]) {
      assert.match(plist, new RegExp(`<key>${key.replaceAll('.', '\\.')}</key>\\s*<true/>`), `${file}: ${key}`);
    }
  }
});

/**
 * The Info.plist text is what every Mac shows unless a localization replaces
 * it: English, the product's default language (TODO #448). French comes from
 * fr.lproj/InfoPlist.strings, which only survives if electron-builder is never
 * told to prune the .lproj directories.
 */
test('the macOS permission prompts are in English, and in French on a Mac set to French', () => {
  const extendInfo = /\n {2}extendInfo:\n((?: {4}.*\n)+)/.exec(yml)?.[1] ?? '';
  const keys = ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription'];
  for (const key of keys) assert.match(extendInfo, new RegExp(`${key}: "[^"]+"`), `${key} missing from mac.extendInfo`);
  assert.doesNotMatch(extendInfo, /[^\x00-\x7f]/, 'the default prompt text is English');
  // Under `mac:`, not the root list: Windows and Linux have no use for it.
  assert.match(yml, /\n {2}extraResources:\n {4}- from: assets\/mac\/fr\.lproj\n {6}to: fr\.lproj\n/);
  assert.doesNotMatch(yml, /^\s*electronLanguages:/m, 'electronLanguages deletes every .lproj it does not list');
  const strings = readFileSync(join(root, 'assets', 'mac', 'fr.lproj', 'InfoPlist.strings'), 'utf8');
  for (const key of keys) assert.match(strings, new RegExp(`^"${key}" = "[^"]*[éè][^"]*";$`, 'm'), `fr.lproj: ${key}`); // french-ok: the French locale under test
  assert.match(strings, /"NSMicrophoneUsageDescription" = "[^"]*dictée[^"]*site[^"]*";/, 'the French prompt names dictation too'); // french-ok: the French locale under test
});

// The shell names an action, the host adapter's runner runs it: two packages built apart.
test('the service runner knows every action the shell sends it', () => {
  const service = readFileSync(join(root, 'src', 'service.ts'), 'utf8');
  const actions = service.match(/export type ServiceControl = ([^;]+);/)?.[1]?.split('|').map((action) => action.trim().replace(/'/g, '')) ?? [];
  assert.deepEqual(actions, ['stop', 'start', 'restart']);
  const runner = readFileSync(join(root, '..', 'orchestrator', 'src', 'host', 'desktop-service-runner.ts'), 'utf8');
  assert.match(runner, new RegExp(actions.map((action) => `action !== '${action}'`).join(' && ')));
  for (const action of actions) assert.match(runner, new RegExp(`\\b${action}: ${action}Service\\b`), action);
  // The restart also ends a daemon no launcher holds: what an update leaves on the previous version.
  const install = readFileSync(join(root, '..', 'orchestrator', 'src', 'host', 'service-install.ts'), 'utf8');
  // And the task is not run again unless that sweep found nothing left.
  assert.match(install, /stopLauncherStep\(opts\.timonHome\),\s+stopPortOwnerStep\(opts\),\s+\{ \.\.\.stopInstallationProcessesStep\(opts\), stopOnFailure: true \},\s+\{ label: 'run'/);
  assert.match(install, /const swept = codes\.get\('sweep'\);\s+if \(swept !== 0\) return \{ ok: false,/);
});

// Volet F (docs/AUTO-UPDATE.md §10): the flag the shell passes is the one the installer reads.
test('the silent update flag of the shell is the one installer.nsh reads', async () => {
  const { NSIS_SILENT_ARGS } = await import('./update-installer.js');
  const nsh = readFileSync(join(root, 'build', 'installer.nsh'), 'utf8');
  const ours = NSIS_SILENT_ARGS.filter((arg) => arg.startsWith('--timon-'));
  assert.deepEqual(ours, ['--timon-app-update']);
  assert.ok(nsh.includes(`\${StdUtils.TestParameter} $1 "${ours[0]!.slice(2)}"`));
  // `/S`, `--updated`, `--force-run`: electron-builder's own, the uninstaller keeps the service task under `--updated`.
  assert.deepEqual(NSIS_SILENT_ARGS.slice(0, 3), ['/S', '--updated', '--force-run']);
  assert.match(nsh, /\$\{If\} \$\{isUpdated\}\s+Goto timon_task_done/);
});
