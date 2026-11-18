import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import type { DetachedResult, DetachedSpec } from './detached.js';
import type { FencePolicy, IsolationTarget, LauncherKind } from './isolation.js';
import type { ListenPortState } from './listen-port.js';
import type { DesktopSession } from './desktop-session.js';

export type Capability = 'systemd' | 'containers' | 'traefik' | 'gui' | 'git' | 'grepai' | 'uvx' | 'keyring';

/** The lane a reveal actually took — what the UI can tell a user when nothing opened. */
export type RevealVia = 'filemanager1' | 'xdg-open' | 'explorer' | 'finder';

export type ExecOpts = Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'>;
export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** `execAsync` only: the `timeout` stopped the command, so `code` is not its
   *  answer. A caller that reads a failure as a fact needs the difference. */
  timedOut?: boolean;
};
export type SpawnOpts = SpawnOptions;

/**
 * OS keyring, under a single service name (`timon`). Optional on purpose: the
 * Secret Service is locked as long as no graphical session is unlocked and does
 * not exist at all on a VPS, so a headless daemon must work without it
 * (`docs/SECRETS-VAULT.md` §4.3). It shelters the master key, never the secrets.
 */
export interface Keyring {
  /** The stored value, or `undefined` when the account holds nothing. Throws
   *  when the keyring answers an actual error — an unreadable keyring must not
   *  look like an empty one. */
  get(account: string): string | undefined;
  set(account: string, value: string): void;
  del(account: string): void;
}

export type FenceMechanism = 'seatbelt' | 'landlock';

export type HostFenceProbe = {
  available: boolean;
  /** Why missions cannot be fenced here, in English, for doctor and the logs. */
  reason?: string;
  /** The kernel interface version, where the mechanism has one (Landlock ABI). */
  abi?: number;
  /**
   * The release ships a fence that is no longer usable (launcher missing,
   * replaced, not executable): a sign the package was altered, worded apart
   * from a machine that lacks the mechanism (`host/fence.ts`).
   */
  tampered?: boolean;
  /**
   * The fence is built from user, mount and pid namespaces: the kernel has no
   * Landlock (`host/namespace-fence.ts`). Linux only.
   */
  fallback?: 'namespaces';
  /**
   * The kernel offers no mechanism at all (Linux without Landlock nor
   * unprivileged user namespaces): a launch is refused even in `auto`.
   */
  noMechanism?: boolean;
};

/**
 * Applies a fence policy to one mission launch. The wrapper it returns is the
 * INNERMOST layer of the launch chain and exec()s the command, so the pid the
 * daemon spawns stays the backend CLI's; resource wrappers go around it.
 */
export interface HostFence {
  readonly mechanism: FenceMechanism;
  /**
   * Asked before every fenced launch. An adapter whose answer cannot change
   * while the daemon runs caches it (Seatbelt); one whose launcher ships with
   * the package asks again, so an alteration shows at the next launch (Landlock).
   */
  probe(): HostFenceProbe;
  /**
   * Writes what the launcher reads to `policyFile` — a path no mission can
   * write — and returns the wrapped command. Throws when the policy cannot be
   * rendered faithfully; the caller then decides between `auto` and `enforce`.
   */
  wrap(policy: FencePolicy, cmd: string, args: readonly string[], policyFile: string): { cmd: string; args: string[] };
  /**
   * Runs the launcher once more on `policyFile`, with a system command that
   * prints nothing and exits 0 in place of the CLI. What it reports is the
   * launcher's own doing: a mission's CLI can print the launcher's words and
   * exit with its codes, so a launch that looks like a launcher failure is
   * only believed once this witness fails the same way.
   */
  witness(policyFile: string): Promise<HostFenceWitness>;
}

/** One witness run of the fence launcher (`HostFence.witness`). */
export type HostFenceWitness =
  | { readonly ran: true; readonly status: number | null; readonly stderr: string }
  /**
   * The launcher could not be started, or gave no answer in time. `code` is
   * the spawn error's errno code (`ENOENT`, `EAGAIN`…) when there was one: it
   * tells a launcher that is not there from a machine short of resources.
   */
  | { readonly ran: false; readonly reason: string; readonly timedOut: boolean; readonly code?: string };

export interface Host {
  inspectPort?: (address: string, port: number) => ListenPortState | Promise<ListenPortState>;
  platform: 'linux' | 'darwin' | 'win32';
  capabilities(): Capability[];
  bin(name: string): string;
  exec(name: string, args: string[], opts?: ExecOpts): ExecResult;
  execAsync(name: string, args: string[], opts?: ExecOpts): Promise<ExecResult>;
  spawn(name: string, args: string[], opts?: SpawnOpts): ChildProcess;
  /** Wraps a mission command in a resource-capped, optionally filesystem-masked
   *  launcher. `target` says which paths must stay reachable (mission `cwd`,
   *  backend credentials); omitting it only costs masking, never correctness. */
  confine(
    cmd: string,
    args: string[],
    unit: string,
    target?: IsolationTarget,
  ): { cmd: string; args: string[] };
  services: {
    start(unit: string, cmd: string, args: string[], cwd: string): void;
    stop(unit: string): void;
    status(unit: string): 'running' | 'stopped';
    self(): { status: string; since?: number };
    selfRestart(): void;
  };
  containers?: { cli(args: string[], timeoutMs?: number): ExecResult };
  /**
   * How far this host can confine a mission's filesystem, and the hook for the
   * boundary that would actually hold (audit finding #4, `docs/SECURITY.md`
   * §9.1).
   *
   * `launcher` is the unit kind missions are wrapped in: only a kind systemd
   * itself executes carries the `Exec*` masking directives, and a `scope` does
   * not. `runAs` is declared and NOT implemented — running a mission under a
   * dedicated OS account or in a namespace needs a privileged helper Timon does
   * not ship; the field exists so the extension point has one name across
   * platforms rather than being invented three times.
   */
  isolation?: {
    launcher: LauncherKind;
    /** Paths this host will mask for such a launch; empty when it masks none. */
    masked(target?: IsolationTarget): readonly string[];
    runAs?: (user: string) => never;
  };
  /** `openTerminal` is absent where the OS can show a file manager but this
   *  adapter cannot open a terminal (Windows, macOS): `terminalStatus()` then
   *  answers `no_gui` instead of offering an action that can only fail. */
  gui?: {
    openTerminal?(cwd: string): void;
    reveal(path: string): Promise<RevealVia>;
    /** Absent where `gui` exists only because a display was probed (Linux): the
     *  session is then known to be graphical. Windows and macOS always carry
     *  `gui` — the daemon may run in a service session with no desktop — and
     *  answer here. */
    desktopSession?(): Promise<DesktopSession>;
  };
  keyring?: Keyring;
  /**
   * The mission fence this OS can apply (`host/isolation.ts`, `resolveFence`):
   * Seatbelt on macOS (`host/darwin.ts`), Landlock on Linux. Absent where the
   * adapter has no mechanism at all (Windows); present but not `available`
   * when the OS refuses it on this machine.
   */
  fence?: HostFence;
  /**
   * Starts a process that outlives the daemon AND the service manager
   * stopping it — the terminal host keeps the web shells across a restart.
   * How each OS escapes its supervisor: `host/detached.ts`.
   */
  spawnDetached?(spec: DetachedSpec): Promise<DetachedResult>;
}
