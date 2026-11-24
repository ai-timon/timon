/** Desktop removal is stricter than `service uninstall`: never claim success
 * after a failed stop, and never unregister another TIMON_HOME's supervisor. */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve, win32 } from 'node:path';
import { homeOfTask } from './orphan-services.js';
import {
  MACOS_LABEL, WINDOWS_TASK, launchDaemonPath, plistPath, stopInstallationProcessesStep, stopLauncherStep, unitPath, uninstallService, type ServiceOpts,
} from './service-install.js';

function sameHome(actual: string, expected: string): void {
  if (!actual || resolve(actual) !== resolve(expected)) {
    throw new Error('The installed service belongs to another data directory. No service was removed.');
  }
}

export function removeDesktopService(opts: ServiceOpts): void {
  const checked = (name: string, args: string[]) => {
    const result = opts.exec(name, args);
    if (result.code !== 0) throw new Error(`${name} ${args[0]} failed: ${result.stderr.trim() || result.code}`);
    return result;
  };
  let macLoaded = false;
  let macTarget = '';
  if (opts.platform === 'darwin') {
    // The LaunchDaemon (a claude token was configured) or the LaunchAgent. Both
    // carry TIMON_HOME, and `print` on the system domain needs no root.
    const daemon = existsSync(launchDaemonPath(opts.launchDaemonsDir));
    const target = daemon ? `system/${MACOS_LABEL}` : `gui/${opts.uid}/${MACOS_LABEL}`;
    macTarget = target;
    const status = opts.exec('launchctl', ['print', target]);
    if (status.code !== 0 && status.code !== 113) throw new Error(`Cannot inspect launchd: ${status.stderr}`);
    macLoaded = status.code === 0;
    const file = daemon ? launchDaemonPath(opts.launchDaemonsDir) : plistPath(opts.homeDir);
    if (!existsSync(file)) {
      if (macLoaded) throw new Error('The running launchd service has no verifiable installation file.');
      return;
    }
    sameHome(checked('/usr/bin/plutil', ['-extract', 'EnvironmentVariables.TIMON_HOME', 'raw', '-o', '-', file]).stdout.trim(), opts.timonHome);
    if (macLoaded) sameHome(status.stdout.match(/^\s*TIMON_HOME => (.+)$/m)?.[1]?.trim() ?? '', opts.timonHome);
  } else if (opts.platform === 'linux') {
    const name = opts.unitName ?? 'timon-orchestrator';
    const file = unitPath(opts.homeDir, name);
    const status = opts.exec('systemctl', ['--user', 'show', name, '--property=LoadState,FragmentPath,Environment,NeedDaemonReload']);
    // systemctl uses exit 4 for an unknown unit on some distributions.
    if (!existsSync(file) && (status.code === 0 || status.code === 4) && /^LoadState=not-found$/m.test(status.stdout)) return;
    if (status.code !== 0) throw new Error(`Cannot inspect systemd: ${status.stderr.trim() || status.code}`);
    if (!existsSync(file) || !status.stdout.split('\n').includes(`FragmentPath=${file}`)) {
      throw new Error('Cannot verify the installed systemd unit.');
    }
    const content = readFileSync(file, 'utf8');
    const quotedHome = opts.timonHome.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
    // Both CLI and packaged templates explicitly bind TIMON_HOME.
    if (!content.split('\n').includes(`Environment="TIMON_HOME=${quotedHome}"`)) {
      throw new Error('The systemd service belongs to another data directory.');
    }
    const environment = status.stdout.match(/^Environment=(.*)$/m)?.[1] ?? '';
    const match = environment.match(/(?:^|\s)(?:"TIMON_HOME=((?:\\.|[^"\\])*)"|TIMON_HOME=([^\s"\\]*))(?=\s|$)/);
    const liveHome = (match?.[1] ?? match?.[2] ?? '').replace(/\\(x[0-9a-fA-F]{2}|[\\"])/g,
      (_, escape: string) => escape.startsWith('x') ? String.fromCharCode(parseInt(escape.slice(1), 16)) : escape);
    sameHome(liveHome, opts.timonHome);
    if (!/^NeedDaemonReload=no$/m.test(status.stdout)) throw new Error('The systemd unit has pending changes. Reload it before uninstalling.');
    checked('systemctl', ['--user', 'disable', '--now', name]);
    const state = checked('systemctl', ['--user', 'show', name, '--property=ActiveState,MainPID']);
    if (!/^MainPID=0$/m.test(state.stdout) || !/^ActiveState=(inactive|failed)$/m.test(state.stdout)) {
      throw new Error('The systemd service has not stopped. Data has been preserved.');
    }
    rmSync(file, { force: true });
    checked('systemctl', ['--user', 'daemon-reload']);
    return;
  } else if (opts.platform === 'win32') {
    // Query through PowerShell so "missing task" is distinct from permission
    // errors, regardless of the language used by schtasks.
    const script = `$ErrorActionPreference='Stop'; $t=@(Get-ScheduledTask | Where-Object { $_.TaskName -eq '${WINDOWS_TASK}' -and $_.TaskPath -eq '\\' }); if ($t.Count -gt 0) { $t[0].Actions | ConvertTo-Json -Compress }`;
    const task = checked('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).stdout.trim();
    if (!task) return;
    const actions = JSON.parse(task) as { Arguments?: string } | { Arguments?: string }[];
    const action = Array.isArray(actions) ? actions.length === 1 ? actions[0] : undefined : actions;
    // The home the action names: the launcher configuration of revision 6, the
    // batch of revisions 2 to 5 (`homeOfTask`), or `set TIMON_HOME=…&&` of revision 1.
    const args = action?.Arguments ?? '';
    const owner = homeOfTask(args) ?? (args.includes(`set TIMON_HOME=${opts.timonHome}&&`) ? opts.timonHome : null);
    if (owner === null || win32.resolve(owner).toLowerCase() !== win32.resolve(opts.timonHome).toLowerCase()) {
      throw new Error('The Windows task belongs to another data directory.');
    }
    checked('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Stop-ScheduledTask -TaskName '${WINDOWS_TASK}' -TaskPath '\\'; Unregister-ScheduledTask -TaskName '${WINDOWS_TASK}' -TaskPath '\\' -Confirm:$false; if (@(Get-ScheduledTask | Where-Object { $_.TaskName -eq '${WINDOWS_TASK}' -and $_.TaskPath -eq '\\' }).Count) { throw 'Task still registered' }`]);
    // The daemon the launcher held outlives `Stop-ScheduledTask` (TIM-0115).
    // Best effort and not elevated: a daemon this process cannot reach is left
    // to `timon service uninstall`, and the uninstaller's own sweep. The
    // launcher first (`Timon.exe --timon-service` in the session holds one),
    // then whatever of the installation is left.
    opts.exec('powershell.exe', stopLauncherStep(opts.timonHome).args);
    const sweep = stopInstallationProcessesStep(opts);
    opts.exec('powershell.exe', sweep.args);
    return;
  } else throw new Error('Uninstall is not supported on this platform.');

  const result = uninstallService({ ...opts, exec: (name, args) => {
    if (name === 'launchctl' && args[0] === 'bootout') {
      // The agent left beside a LaunchDaemon: nothing of ours may be loaded there.
      if (args[1] !== macTarget) {
        const result = opts.exec(name, args);
        return result.code === 113 || result.code === 3 ? { code: 0, stdout: '', stderr: '' } : result;
      }
      if (!macLoaded) return { code: 0, stdout: '', stderr: '' };
      const stopped = checked(name, args);
      const pause = opts.pause ?? (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
      for (let attempt = 0; attempt < 300; attempt++) {
        const state = opts.exec('launchctl', ['print', args[1]!]);
        if (state.code === 113) return stopped;
        if (state.code !== 0) throw new Error(`Cannot verify launchd shutdown: ${state.stderr}`);
        pause(100);
      }
      throw new Error('The launchd service did not stop. Data has been preserved.');
    }
    return checked(name, args);
  } });
  if (!result.ok) throw new Error(result.reason ?? result.lines.join('\n'));

}
