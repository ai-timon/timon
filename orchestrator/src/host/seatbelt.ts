/**
 * The mission fence on macOS: a Seatbelt profile (SBPL) rendered from the
 * fence policy (`host/isolation.ts`, `resolveFence`), applied by
 * `/usr/bin/sandbox-exec`, which then exec()s the backend CLI. The pid stays
 * the CLI's, so every kill path of `agent.ts` is unchanged (measured on macOS
 * 14.6: the pid `spawn` returns is the payload's).
 *
 * This module is pure: strings in, strings out, on macOS (POSIX) paths whatever
 * the platform the tests run on. `host/darwin.ts` resolves the paths on disk,
 * writes the profile and probes the OS.
 *
 * WHAT WAS MEASURED, AND SHAPES THE RENDERING
 * -------------------------------------------
 * - Seatbelt matches the RESOLVED path. A rule on `/tmp/x` or on a symbolic
 *   link does not match an access through it (`/private/tmp/x`, the target):
 *   a refusal written on the unresolved path is simply not applied. The
 *   caller hands the renderer the resolved spellings (`canonicalPaths`).
 * - Refusing `file-read*` under the Timon home breaks git, which `stat`s every
 *   parent of the worktree; refusing `file-read-data` keeps metadata readable
 *   and still refuses reading a file and listing a folder.
 * - The last matching rule wins. With every rule written on a whole subtree,
 *   emitting them from the shallowest path to the deepest reproduces the
 *   semantics of `fenceAccess`: the deepest listed ancestor decides.
 * - Strings are Scheme strings: `\"`, `\\` and `\n` escapes are honoured, and
 *   an unknown operation or filter makes the whole profile fail to compile
 *   (exit 65), so only names measured on the OS are emitted.
 * - A sandboxed process cannot sandbox itself again (`sandbox_apply:
 *   Operation not permitted`, exit 71): a CLI's own Seatbelt sandbox (codex)
 *   fails inside the fence, and a daemon that is itself sandboxed cannot fence.
 */
import { posix } from 'node:path';
import type { FencePolicy } from './isolation.js';

/** Shipped with macOS, never looked up on PATH: a planted `sandbox-exec` would run unfenced. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'; // portability: macOS system binary, used on darwin only

/** The smallest profile: compiles and confines nothing. What the probe applies. */
export const SEATBELT_PROBE_PROFILE = '(version 1)(allow default)';

/** The DNS resolver's socket: name resolution goes through it, so it stays reachable when Unix sockets are refused. */
export const MDNS_RESPONDER_SOCKET = '/private/var/run/mDNSResponder'; // portability: macOS system socket

/** `sandbox-exec` exit status when it cannot apply a profile (sysexits EX_OSERR). */
export const SANDBOX_EXEC_APPLY_FAILED = 71;

/** `sandbox-exec` exit status when the profile does not compile (sysexits EX_DATAERR). */
export const SANDBOX_EXEC_BAD_PROFILE = 65;

export class SeatbeltRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeatbeltRenderError';
  }
}

const ESCAPES: Readonly<Record<string, string>> = Object.freeze({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\r': '\\r' });

/**
 * A path as an SBPL string literal. Backslash and double quote are escaped,
 * the three whitespace controls use their Scheme escape, and any other control
 * character is refused rather than guessed: a path the profile would spell
 * differently from the kernel is a rule that silently matches nothing.
 */
export function sbplString(value: string): string {
  let out = '"';
  for (const char of value) {
    const escaped = ESCAPES[char];
    if (escaped) {
      out += escaped;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new SeatbeltRenderError(`a fence path holds a control character (U+${code.toString(16).padStart(4, '0')}) the profile cannot spell`);
    }
    out += char;
  }
  return `${out}"`;
}

/**
 * Every spelling of `path` Seatbelt may see: the path as given, and the path
 * with its deepest existing ancestor resolved (`/tmp` → `/private/tmp`, a
 * symbolic link → its target). The part that does not exist yet is kept as is.
 * `realpath` throws for a missing path, like `fs.realpathSync`.
 */
export function canonicalPaths(path: string, realpath: (path: string) => string): string[] {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      const full = posix.join(realpath(current), ...missing.reverse());
      return full === path ? [path] : [path, full];
    } catch {
      const parent = posix.dirname(current);
      if (parent === current) return [path];
      missing.push(posix.basename(current));
      current = parent;
    }
  }
}

/** `parent` is `child` or one of its ancestors. Pure path arithmetic, on macOS paths whatever the test host. */
function within(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = posix.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel);
}

type Level = 'rw' | 'ro' | 'none';

/** On the very same path the most restrictive level wins: it is emitted last. */
const TIE_ORDER: Readonly<Record<Level, number>> = Object.freeze({ rw: 0, ro: 1, none: 2 });

const FILE_RULES: Readonly<Record<Level, (path: string) => string[]>> = Object.freeze({
  rw: (p: string) => [`(allow file-read-data file-write* (subpath ${p}))`],
  ro: (p: string) => [`(allow file-read-data (subpath ${p}))`, `(deny file-write* (subpath ${p}))`],
  none: (p: string) => [`(deny file-read-data file-write* (subpath ${p}))`],
});

export type SeatbeltRenderOptions = {
  /** Spellings of a path to write a rule for; the identity by default. See `canonicalPaths`. */
  spellings?: (path: string) => readonly string[];
};

export type SeatbeltProfile = {
  /** The profile text, for `sandbox-exec -f`. */
  text: string;
  /** Grants left out because, once resolved, they land on a refused entry of the Timon home. */
  dropped: ReadonlyArray<{ path: string; reason: string }>;
};

/**
 * The profile of one mission. Everything is allowed, then:
 * - each listed path gets the rules of its level, shallowest first, so the
 *   deepest listed ancestor decides, as `fenceAccess` defines it;
 * - executing is allowed under the `exec` roots and refused under the refused
 *   paths, with the same ordering;
 * - Unix sockets are refused, but the DNS resolver's, unless the policy allows them;
 * - a few doors out of the fence are shut whatever the policy: `launchctl`
 *   (launchd already refuses a sandboxed `submit`, measured), opening an app
 *   through LaunchServices, which starts it unconfined, and Apple Events,
 *   which drive an app that is.
 */
export function renderSeatbeltProfile(policy: FencePolicy, options: SeatbeltRenderOptions = {}): SeatbeltProfile {
  if (!policy.enabled) throw new SeatbeltRenderError('a disabled fence has no profile');
  const spell = options.spellings ?? ((path: string) => [path]);
  const dropped: Array<{ path: string; reason: string }> = [];

  for (const path of [...policy.ro, ...policy.rw, ...policy.exec, ...policy.deny, ...policy.denyUnderTimonHome]) {
    if (!posix.isAbsolute(path)) throw new SeatbeltRenderError(`fence paths must be absolute: ${path}`);
  }

  const refused = [...policy.deny, ...policy.denyUnderTimonHome];
  // Resolution may carry a grant somewhere the policy never meant (a working
  // folder that is a link into the Timon home): the named private entries win.
  const privateEntries = policy.denyUnderTimonHome.flatMap((path) => [...spell(path)]);
  const grantable = (path: string): boolean => {
    const hit = privateEntries.find((entry) => within(entry, path));
    if (hit === undefined) return true;
    if (!dropped.some((d) => d.path === path)) dropped.push({ path, reason: `resolves under ${hit}, which a mission never reaches` });
    return false;
  };

  const files: Array<{ path: string; level: Level }> = [];
  const add = (paths: readonly string[], level: Level) => {
    for (const path of paths) {
      for (const spelled of spell(path)) {
        if (level !== 'none' && !grantable(spelled)) continue;
        files.push({ path: spelled, level });
      }
    }
  };
  add(policy.rw, 'rw');
  add(policy.ro, 'ro');
  add(refused, 'none');

  const execs: Array<{ path: string; allow: boolean }> = [];
  for (const path of policy.exec) {
    for (const spelled of spell(path)) if (grantable(spelled)) execs.push({ path: spelled, allow: true });
  }
  for (const path of refused) for (const spelled of spell(path)) execs.push({ path: spelled, allow: false });

  // Length orders an ancestor before its descendants; unrelated paths never
  // match the same file, so their relative order does not matter.
  files.sort((a, b) => a.path.length - b.path.length || TIE_ORDER[a.level] - TIE_ORDER[b.level]);
  execs.sort((a, b) => a.path.length - b.path.length || Number(b.allow) - Number(a.allow));

  const lines: string[] = [
    ';; Timon mission fence, generated: do not edit.',
    '(version 1)',
    '(allow default)',
  ];
  const seen = new Set<string>();
  const emit = (rule: string) => {
    if (seen.has(rule)) return;
    seen.add(rule);
    lines.push(rule);
  };
  for (const { path, level } of files) for (const rule of FILE_RULES[level](sbplString(path))) emit(rule);
  for (const { path, allow } of execs) emit(`(${allow ? 'allow' : 'deny'} process-exec* (subpath ${sbplString(path)}))`);
  if (policy.unixSockets === 'deny') {
    lines.push('(deny network-outbound (remote unix-socket))');
    lines.push(`(allow network-outbound (remote unix-socket (path-literal ${sbplString(MDNS_RESPONDER_SOCKET)})))`);
  }
  lines.push('(deny process-exec* (literal "/bin/launchctl"))'); // portability: macOS system binary
  lines.push('(deny lsopen)');
  lines.push('(deny appleevent-send)');
  return { text: `${lines.join('\n')}\n`, dropped };
}

/** The launch through `sandbox-exec`, innermost in the chain: it exec()s the command. */
export function seatbeltLaunch(profileFile: string, cmd: string, args: readonly string[]): { cmd: string; args: string[] } {
  return { cmd: SANDBOX_EXEC, args: ['-f', profileFile, '--', cmd, ...args] };
}

export type SeatbeltProbe = {
  available: boolean;
  /** Why the fence cannot be applied, in English, for doctor and the logs. */
  reason?: string;
};

/**
 * Reads the probe `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`.
 * `error` is the spawn error, when `sandbox-exec` could not be started at all.
 */
export function parseSeatbeltProbe(status: number | null, stderr: string, error?: Error): SeatbeltProbe {
  if (error) return { available: false, reason: `sandbox-exec cannot run (${error.message})` };
  if (status === 0) return { available: true };
  if (status === SANDBOX_EXEC_APPLY_FAILED || /sandbox_apply/.test(stderr)) {
    return { available: false, reason: 'the daemon already runs inside a sandbox, which cannot be nested' };
  }
  const detail = stderr.trim().split('\n')[0];
  return { available: false, reason: `sandbox-exec failed (${detail || `exit ${status ?? 'signal'}`})` };
}
