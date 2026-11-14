/**
 * Linux + systemd --user Host Adapter.
 *
 * Bodies extracted verbatim from the modules listed in §1.4: `resources.wrapMissionLaunch`,
 * `grepai` systemd-run/systemctl, `terminal.ts`, `files.ts::desktopEnv` + reveal,
 * `orchestrator-self` systemctl, `docker.ts` spawnSync. The `TIMON_HOME` isolation
 * prefix lives in `host/units.ts` (2.2.1); the slice comes from `MISSION_SLICE`.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { TimonConfig } from '../config/schema.js';
import type { BinaryPins } from './generic.js';
import { guardEnabled, MISSION_SLICE, profileLimits } from '../resources.js';
import { settingStr } from '../settings.js';
import { spawnInNewSession, spawnInScope } from './detached.js';
import { createGenericHost } from './generic.js';
import { createLandlockFence } from './landlock.js';
import {
  isolationArgsFor, resolveIsolation, sandboxSupported, SCOPE_SANDBOX_REASON,
  type IsolationTarget, type LauncherKind,
} from './isolation.js';
import { hasSystemd, systemctl } from './systemd.js';
import type { Capability, Host, Keyring, RevealVia } from './types.js';

const execFileAsync = promisify(execFile);

const SERVICE = 'timon-orchestrator.service';

/**
 * Unit kind a mission is launched in. A scope is what keeps `proc.pid` on the
 * backend CLI and every `proc.kill('SIGTERM')` of `agent.ts` effective; it is
 * also what forbids the filesystem masking (`host/isolation.ts` header). One
 * constant, so the day the launcher migrates the isolation lights up with it.
 */
const MISSION_LAUNCHER: LauncherKind = 'scope';

/** Variables without which a graphical app cannot display itself.
 *  `systemd-run --user` does NOT inherit the caller's environment but that
 *  of the user systemd manager — which only has these variables if the
 *  graphical session ran its `import-environment`. So they are passed again
 *  explicitly from the orchestrator's environment, which has them. */
const GUI_ENV_KEYS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
  'DBUS_SESSION_BUS_ADDRESS',
] as const;

/** Graphical session environment for a child launched by the
 *  orchestrator. In host mode it already inherits DISPLAY and the D-Bus bus from
 *  systemd --user; the default values only serve if the service was
 *  started outside a session (sudo systemctl, cron…). */
function desktopEnv(): NodeJS.ProcessEnv {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  return {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':0',
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`,
  };
}

/** Single service name for every Timon entry in the Secret Service. */
const KEYRING_SERVICE = 'timon';

/** A locked Secret Service does not fail, it BLOCKS on the unlock prompter —
 *  which in a headless daemon is a boot that never completes, worse than the
 *  crash we are avoiding. Every call is bounded, probe included. */
const KEYRING_TIMEOUT_MS = 3_000;

/**
 * `secret-tool` backed keyring, exposed only if a real write-read-delete probe
 * succeeds (SECRETS-VAULT §4.2). The binary being present proves nothing: the
 * collection may be locked, or D-Bus may have no Secret Service at all.
 */
function createSecretToolKeyring(base: Host, pins: BinaryPins): Keyring | undefined {
  // Under the test runner the ambient Secret Service is the USER's: same
  // service, same `master-key` account as the installed daemon. A suite that
  // seals without injecting `keyring: null` would write its key there — or,
  // through `key.ts` dropping the losing location, delete the real one (TODO
  // #574). A test that wants a keyring pins its own stand-in `secret-tool`.
  if (process.env.NODE_TEST_CONTEXT && !pins()['secret-tool']) return undefined;
  // Free gate before the expensive probe: on a server both fail and we never
  // touch D-Bus. Same shape as the `docker` probe of `generic.ts`.
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return undefined;
  try { base.bin('secret-tool'); } catch { return undefined; }

  const attrs = (account: string) => ['service', KEYRING_SERVICE, 'account', account];
  const keyring: Keyring = {
    get(account) {
      const r = base.exec('secret-tool', ['lookup', ...attrs(account)], { timeout: KEYRING_TIMEOUT_MS });
      // Strip the line ending `lookup` may add — implementations disagree on
      // whether they terminate the secret, and an unstripped `\n` makes every
      // read-back comparison fail, starting with the probe below. At most one,
      // and only at the end: the payload is base64, which cannot contain one.
      if (r.code === 0) return r.stdout.replace(/\r?\n$/, '');
      // `lookup` exits non-zero and says nothing when the entry is simply
      // absent. Anything on stderr is a real failure (locked collection, dead
      // bus, timeout) and must NOT be mistaken for an empty keyring: that
      // confusion is exactly what would trigger a master key regeneration.
      const detail = r.stderr.trim();
      if (!detail) return undefined;
      throw new Error(`secret-tool lookup failed: ${detail}`);
    },
    set(account, value) {
      // Value on stdin, never in argv: /proc/<pid>/cmdline is world-readable.
      const r = base.exec('secret-tool', ['store', `--label=Timon ${account}`, ...attrs(account)], {
        timeout: KEYRING_TIMEOUT_MS,
        input: value,
      });
      if (r.code !== 0) throw new Error(`secret-tool store failed: ${r.stderr.trim() || `code ${r.code}`}`);
    },
    del(account) {
      const r = base.exec('secret-tool', ['clear', ...attrs(account)], { timeout: KEYRING_TIMEOUT_MS });
      if (r.code !== 0) throw new Error(`secret-tool clear failed: ${r.stderr.trim() || `code ${r.code}`}`);
    },
  };

  const account = `probe-${process.pid}-${randomBytes(4).toString('hex')}`;
  const witness = randomBytes(16).toString('hex');
  // A failing probe is the normal outcome on a server or a locked session: the
  // file fallback takes over and the boot must not notice.
  try {
    keyring.set(account, witness);
  } catch {
    return undefined; // nothing was stored, nothing to clean up
  }

  // The witness exists from here on: it must go whatever follows, or a failing
  // keyring accumulates one dead entry per boot.
  let readBack = false;
  try { readBack = keyring.get(account) === witness; } catch { /* verdict already lost */ }

  // Deletion is part of the verdict, not mere cleanup. A keyring that stores
  // and reads but cannot clear would pass the probe and then trap `key.ts`:
  // its purge-before-file-fallback path would be unable to remove a half
  // written master key, turning a fresh install into a daemon refusing to boot
  // (`keyring-unavailable`). Better to never expose the capability at all.
  try { keyring.del(account); } catch { return undefined; }

  return readBack ? keyring : undefined;
}

export function createLinuxHost(config: TimonConfig, pins?: BinaryPins): Host {
  const binaryPins: BinaryPins = pins ?? (() => config.host.binaries);
  const base = createGenericHost(config, {}, binaryPins);
  const guiEnabled = config.host.gui !== 'disabled'
    && Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  // `secrets.keyring: 'off'` is honoured here rather than in `secrets/key.ts`:
  // not building the object makes the capability plainly absent, and the key
  // resolution keeps a single question to ask — does the host have a keyring.
  const keyring = config.secrets.keyring === 'off' ? undefined : createSecretToolKeyring(base, binaryPins);

  // One line per boot, on purpose. An operator who set `host.isolation` — or
  // who read the audit and assumes agents are jailed — must not have to read
  // the source to learn that the masking is inert on this launcher.
  if (config.host.isolation.filesystem !== 'off' && !sandboxSupported(MISSION_LAUNCHER)) {
    console.warn(`[host] mission filesystem masking is INERT: ${SCOPE_SANDBOX_REASON}`);
  }
  if (config.host.isolation.runAs) {
    console.warn(
      `[host] host.isolation.runAs="${config.host.isolation.runAs}" is IGNORED: `
      + 'running a mission under another OS account is an extension point, not an implemented feature',
    );
  }

  const capabilities = (): Capability[] => {
    const out: Capability[] = ['systemd'];
    if (base.containers) out.push('containers');
    if (config.host.traefik) out.push('traefik');
    if (guiEnabled) out.push('gui');
    if (keyring) out.push('keyring');
    for (const capability of ['git', 'grepai', 'uvx'] as const) {
      try { base.bin(capability); out.push(capability); } catch { /* capability missing */ }
    }
    return out;
  };

  return {
    ...base,
    platform: 'linux',
    capabilities,
    confine(cmd, args, unit, target) {
      if (!guardEnabled() || !hasSystemd()) return { cmd, args };
      const lim = profileLimits();
      const wrapped = [
        '--user', '--quiet', '--scope', '--collect',
        `--unit=${unit}`,
        `--slice=${MISSION_SLICE}`,
        // PER-MISSION ceiling: it is what turns "the machine freezes"
        // into "this mission gets killed".
        // NB: the `--property=K=V` form is mandatory — `-p=K=V` is rejected
        // ("Unknown assignment"), and the spawn would fail for every mission.
        // Already clamped strictly below the slice's MemoryMax (resources.ts
        // `missionMemCapMiB`): above it, the slice limit fires before this
        // ceiling is ever reached and hits whichever mission is biggest.
        `--property=MemoryMax=${lim.missionMemMaxMiB}M`,
        // NO MemoryHigh here, on purpose. Measured on 14/08: with a
        // MemoryHigh below the Max, a leaking process never dies — it stays
        // stuck in reclaim (1.8 s of CPU in 90 s, no kill, no event,
        // hence no alert) and holds a mission slot until the reaper. Without
        // it, the same hog is killed within seconds, the OOM stays confined to the
        // scope (`oom_memcg=…/timon-mission-*.scope`) and comes up as an alert.
        // No soft throttling on the slice either, since 19/09/2026: its
        // pressure went up to user@UID.service and systemd-oomd killed the
        // whole graphical session there (see the header of resources.ts).
        // No per-scope oomd: the slice carries `ManagedOOMMemoryPressure=kill`
        // and oomd picks its victim among its scopes. Above all no
        // `ManagedOOMPreference=avoid|omit`, which would move the kill onto the session.
        // Weight, not quota: a lone mission can use the whole quota of the
        // slice; it is under contention that the weight arbitrates.
        '--property=CPUWeight=20',
        // Filesystem masking, and NOTHING on a scope: systemd answers "Unknown
        // assignment" to every Exec* directive there, which would not degrade
        // the guard but kill it — `probeWrapper()` would mark the whole wrapper
        // unusable and missions would then run with no MemoryMax at all.
        ...isolationArgsFor(MISSION_LAUNCHER, config, target),
        '--',
        'nice', '-n', String(lim.nice),
        // ionice without -n: the idle class (3) takes none. In best-effort (2),
        // 4 = default priority; we deliberately stay above 4 at night.
        'ionice', '-c', String(lim.ioniceClass),
        ...(lim.ioniceClass === 2 ? ['-n', '6'] : []),
        cmd, ...args,
      ];
      return { cmd: 'systemd-run', args: wrapped };
    },
    services: {
      start(unit, cmd, args, cwd) {
        // grepai.ts: systemd-run --user --collect --unit= --working-directory=
        // --property=KillMode=mixed. Why systemd-run and not a detached
        // spawn: the orchestrator runs under a unit with KillMode=control-group.
        const r = spawnSync('systemd-run', [
          '--user',
          '--collect',
          `--unit=${unit}`,
          `--working-directory=${cwd}`,
          '--property=KillMode=mixed',
          cmd, ...args,
        ], { encoding: 'utf8' });
        if (r.status !== 0) {
          throw new Error(`systemd-run failed: ${(r.stderr || r.stdout || '').trim() || `code ${r.status}`}`);
        }
      },
      stop(unit) { systemctl(['stop', unit]); },
      status(unit) { return systemctl(['is-active', '--quiet', unit]).ok ? 'running' : 'stopped'; },
      self() {
        const r = systemctl(['show', SERVICE, '-p', 'ActiveState', '-p', 'ActiveEnterTimestamp']);
        const props = new Map<string, string>();
        for (const line of r.out.split('\n')) {
          const i = line.indexOf('=');
          if (i > 0) props.set(line.slice(0, i), line.slice(i + 1));
        }
        const parsed = Date.parse(props.get('ActiveEnterTimestamp') ?? '');
        return {
          status: props.get('ActiveState') || 'unknown',
          ...(Number.isFinite(parsed) ? { since: parsed } : {}),
        };
      },
      selfRestart() {
        const child = spawn('systemctl', ['--user', 'restart', SERVICE], { stdio: 'ignore', detached: true });
        child.unref();
      },
    },
    containers: base.containers,
    // The innermost layer of a mission launch, under the scope, nice and ionice
    // above (`resources.ts`, `wrapMissionLaunch`); applied without systemd too.
    fence: createLandlockFence(),
    // A unit of its own, or `restart` empties the cgroup and the shells with it.
    spawnDetached: (spec) => (hasSystemd() ? spawnInScope(spec) : spawnInNewSession(spec)),
    isolation: {
      launcher: MISSION_LAUNCHER,
      // The policy itself, NOT what the current launcher emits: a caller asks
      // this to know what a mission has no business reading, and on a scope
      // the emitted answer is always empty. `launcher` above says whether it
      // is enforced.
      masked: (target?: IsolationTarget) => resolveIsolation(config, target).deny,
      runAs(user: string): never {
        throw new Error(
          `running a mission as "${user}" is not implemented: it needs a privileged helper `
          + '(dedicated OS account or namespace) that Timon does not ship — see docs/SECURITY.md §9.1',
        );
      },
    },
    keyring,
    gui: guiEnabled ? {
      openTerminal(cwd) {
        const cmd = settingStr('TIMON_TERMINAL_COMMAND').trim() || 'hyper';
        const setenv: string[] = [];
        for (const k of GUI_ENV_KEYS) {
          const v = process.env[k];
          if (v) setenv.push(`--setenv=${k}=${v}`);
        }

        const attempt = (props: string[]) => spawnSync('systemd-run', [
          '--user',
          '--collect',
          ...props,
          `--working-directory=${cwd}`,
          ...setenv,
          cmd, cwd,
        ], { encoding: 'utf8' });

        // A graphical launcher is not its own main process: `hyper` is
        // a script that starts Electron then returns right away. With the default
        // ExitType (`main`), systemd sees the main exit, considers the unit finished
        // and SIGTERMs the cgroup — hence the window that had just opened, within
        // the second. `cgroup` keeps the unit active as long as a process remains in it;
        // `--collect` cleans up when the last one exits.
        let r = attempt(['--property=ExitType=cgroup', '--property=KillMode=mixed']);

        // `ExitType` dates from systemd 250. On older ones, the assignment is refused
        // outright: retry without it, which brings back the killed-launcher bug but keeps a
        // working terminal for the commands that stay in the foreground.
        if (r.status !== 0 && /ExitType/i.test(`${r.stderr ?? ''}${r.stdout ?? ''}`)) {
          console.warn('[terminal] ExitType=cgroup not supported by this systemd — falling back without it');
          r = attempt(['--property=KillMode=mixed']);
        }

        if (r.status === 0) return;

        // `systemd-run` missing (no systemd, container without a bus): The user is not
        // deprived of their terminal for all that, fall back on the old behaviour.
        if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
          console.warn('[terminal] systemd-run not found — falling back to a detached spawn (window tied to the orchestrator cgroup)');
          const child = spawn(cmd, [cwd], { detached: true, stdio: 'ignore', cwd });
          child.on('error', (err) => {
            console.warn(`[terminal] failed to launch "${cmd}": ${(err as Error).message}`);
          });
          child.unref();
          return;
        }

        const detail = (r.stderr || r.stdout || '').trim() || `code ${r.status}`;
        throw new Error(`systemd-run failed: ${detail}`);
      },
      async reveal(path): Promise<RevealVia> {
        const env = desktopEnv();
        const isDir = statSync(path).isDirectory();
        if (!isDir) {
          // The path is injected into a GVariant literal: escape what
          // could break its syntax (quotes, backslashes of an exotic
          // file name). No shell is involved — execFile, not exec.
          const uri = pathToFileURL(path).href;
          const literal = `["${uri.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
          try {
            await execFileAsync('gdbus', [
              'call', '--session',
              '--dest', 'org.freedesktop.FileManager1',
              '--object-path', '/org/freedesktop/FileManager1',
              '--method', 'org.freedesktop.FileManager1.ShowItems',
              literal, '',
            ], { env, timeout: 10_000 });
            return 'filemanager1';
          } catch {
            /* no manager on the bus → parent folder fallback */
          }
        }
        const dir = isDir ? path : dirname(path);
        try {
          await execFileAsync('xdg-open', [dir], { env, timeout: 10_000 });
        } catch (err) {
          throw new Error(`could not open the desktop file manager: ${(err as Error).message}`);
        }
        return 'xdg-open';
      },
    } : undefined,
  };
}
