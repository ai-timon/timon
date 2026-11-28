/**
 * Runs one shell command for the daemon itself, outside the fence of any
 * mission: what "Allow" does on a command card (`terminal_propose`). A mission
 * under Landlock or Seatbelt cannot write to its own worktree's `.git`, so a
 * command it was only told to run fails there; the daemon runs it instead.
 *
 * The OS differences stay here: which shell, how a process tree is ended, how a
 * folder is compared. Callers decide WHAT may run (the folder, the
 * environment) and what to do with the answer.
 */
import { realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { getHost } from './index.js';
import { stopProcessGroup } from './kill-tree.js';
import { findPwsh } from './powershell.js';

export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const MAX_RUN_TIMEOUT_MS = 600_000;
/** Characters of output kept; the END is kept, where a failure usually says why. */
export const MAX_RUN_OUTPUT_CHARS = 20_000;

export type CommandRunResult = {
  /** The exit code; null when the command was killed (timeout) or never started. */
  exitCode: number | null;
  timedOut: boolean;
  /** stdout and stderr interleaved as they came, truncated to the last `MAX_RUN_OUTPUT_CHARS`. */
  output: string;
  truncated: boolean;
  durationMs: number;
  /** The command never ran (no shell, refused folder): `output` says why. */
  failedToStart: boolean;
};

export function clampRunTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return DEFAULT_RUN_TIMEOUT_MS;
  return Math.min(Math.floor(ms), MAX_RUN_TIMEOUT_MS);
}

/**
 * The shell that runs a one-line command. The user's login shell on Linux and
 * macOS (a service's PATH is minimal; the profile restores the user's tools),
 * PowerShell on Windows, 7 when installed since only it parses `&&`.
 */
export function commandShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
  opts: { override?: string; pwsh?: () => string | null; envShell?: string | undefined; passwdShell?: () => string } = {},
): { shell: string; args: string[] } {
  const override = opts.override?.trim();
  if (platform === 'win32') {
    const shell = override || (opts.pwsh ?? findPwsh)() || 'powershell.exe';
    return { shell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] };
  }
  let shell = override || (opts.envShell ?? process.env.SHELL)?.trim() || '';
  if (!shell) {
    try { shell = (opts.passwdShell ?? (() => userInfo().shell ?? ''))(); } catch { shell = ''; }
  }
  // portability: POSIX-only branch (win32 returned above); /bin/sh exists on Linux and macOS.
  return { shell: shell || '/bin/sh', args: ['-lc', command] };
}

export type CwdCheck = { ok: true; cwd: string } | { ok: false; reason: 'missing' | 'not_directory' | 'outside' };

function real(path: string): string | null {
  try { return realpathSync(resolve(path)); } catch { return null; }
}

function inside(root: string, path: string, platform: NodeJS.Platform): boolean {
  const from = platform === 'win32' ? root.toLowerCase() : root;
  const to = platform === 'win32' ? path.toLowerCase() : path;
  const rel = relative(from, to);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * `cwd` must exist, be a folder, and — once every link and `..` is resolved —
 * be one of `roots` or lie under one. A symlink that leaves them resolves to
 * its target, which is then outside. A root that does not exist grants nothing.
 */
export function confineRunCwd(cwd: string, roots: readonly string[], platform: NodeJS.Platform = process.platform): CwdCheck {
  if (!cwd || cwd.includes('\0')) return { ok: false, reason: 'missing' };
  const target = real(cwd);
  if (!target) return { ok: false, reason: 'missing' };
  try {
    if (!statSync(target).isDirectory()) return { ok: false, reason: 'not_directory' };
  } catch {
    return { ok: false, reason: 'missing' };
  }
  for (const root of roots) {
    const r = real(root);
    if (r && inside(r, target, platform)) return { ok: true, cwd: target };
  }
  return { ok: false, reason: 'outside' };
}

export type RunOptions = {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Tests stand in for the shell. */
  shell?: { shell: string; args: string[] };
};

/**
 * Runs `command` once and resolves with how it ended. Never rejects. The
 * program starts in its own process group (POSIX), so the timeout ends it and
 * what it started; on Windows the tree is taken through `taskkill`.
 */
export function runShellCommand(opts: RunOptions): Promise<CommandRunResult> {
  const startedAt = Date.now();
  const timeoutMs = clampRunTimeout(opts.timeoutMs);
  const cap = Math.max(1, opts.maxOutputChars ?? MAX_RUN_OUTPUT_CHARS);
  const fail = (why: string): CommandRunResult => ({
    exitCode: null, timedOut: false, output: why, truncated: false, durationMs: Date.now() - startedAt, failedToStart: true,
  });
  return new Promise((done) => {
    let host: ReturnType<typeof getHost>;
    let child: ReturnType<ReturnType<typeof getHost>['spawn']>;
    const { shell, args } = opts.shell ?? commandShell(opts.command);
    try {
      host = getHost();
      host.bin(shell);
      child = host.spawn(shell, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Its own group on POSIX, so the timeout reaches everything it started.
        detached: host.platform !== 'win32',
      });
    } catch (err) {
      done(fail(`could not start the shell: ${(err as Error).message}`));
      return;
    }
    // Only the tail is kept: a long build prints its error last.
    let tail = '';
    let truncated = false;
    const take = (chunk: Buffer | string): void => {
      tail += chunk.toString();
      if (tail.length > cap * 2) { tail = tail.slice(-cap); truncated = true; }
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (spawnError) { done(fail(`could not start the shell: ${spawnError}`)); return; }
      if (tail.length > cap) { tail = tail.slice(-cap); truncated = true; }
      done({ exitCode: timedOut ? null : exitCode, timedOut, output: tail, truncated, durationMs: Date.now() - startedAt, failedToStart: false });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopProcessGroup(child, 'SIGKILL');
      // A holder of the pipes that survived must not keep the answer waiting.
      const grace = setTimeout(() => finish(null), 1_000);
      grace.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (err) => finish(null, err.message));
    child.once('close', (code) => finish(code));
  });
}
