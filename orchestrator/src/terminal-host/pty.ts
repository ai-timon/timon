/**
 * node-pty, loaded lazily so a host where the native module is missing only
 * loses the web terminal, not the process that loads it.
 */
import { chmodSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { Pty, PtySpawnOptions, PtySpawner } from './sessions.js';

type NodePtyOptions = {
  name: string; cols: number; rows: number; cwd: string; env: Record<string, string>;
  useConptyDll?: boolean;
};

type NodePty = {
  spawn(file: string, args: string[], opts: NodePtyOptions): Pty;
};

let nodePty: NodePty | null | undefined;

/**
 * node-pty's macOS prebuild ships `spawn-helper` without its executable bit
 * (npm extracts it 0644), and every spawn then fails with "posix_spawnp
 * failed". Packages are fixed at build time (`desktop/scripts/pty-helper.mjs`);
 * this covers an install from a checkout. Best effort: a read-only location
 * keeps the original error.
 */
export function ensureSpawnHelperExecutable(moduleDir: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): boolean {
  if (platform !== 'darwin') return false;
  const helper = join(moduleDir, 'prebuilds', `${platform}-${arch}`, 'spawn-helper');
  try {
    if (!existsSync(helper) || (statSync(helper).mode & 0o111) === 0o111) return false;
    chmodSync(helper, 0o755);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why node-pty's own build did not load, when it exists. node-pty tries
 * `build/Release` first, then its prebuilds, and reports only the last
 * failure: on Linux, where the build is the artefact, the message then names
 * a missing prebuild while the real cause (a glibc too old for the binary,
 * an ABI mismatch) stays hidden.
 */
export function builtArtefactFailure(moduleDir: string, load: (file: string) => unknown): string | null {
  const built = join(moduleDir, 'build', 'Release', 'pty.node');
  if (!existsSync(built)) return null;
  try {
    load(built);
    return null;
  } catch (err) {
    return `${built}: ${(err as Error).message}`;
  }
}

/** node-pty, or null when its native binary does not load on this host. */
export function loadNodePty(): NodePty | null {
  if (nodePty !== undefined) return nodePty;
  const req = createRequire(import.meta.url);
  let moduleDir: string | null = null;
  try {
    moduleDir = dirname(req.resolve('node-pty/package.json'));
    ensureSpawnHelperExecutable(moduleDir);
    nodePty = req('node-pty') as NodePty;
  } catch (err) {
    const built = moduleDir ? builtArtefactFailure(moduleDir, (file) => req(file)) : null;
    console.warn('[terminal-web] node-pty unavailable:', built ?? (err as Error).message);
    nodePty = null;
  }
  return nodePty;
}

/**
 * Options handed to node-pty for one terminal.
 *
 * Windows uses the ConPTY that node-pty ships (`prebuilds/<platform>-<arch>/
 * conpty/{conpty.dll,OpenConsole.exe}`), not the one of the OS. With the OS
 * one, node-pty 1.1.0's `kill()` forks `conpty_console_list_agent.js` to list
 * the console's processes; under the service (no attachable console, or a
 * shell already gone) it dies on "AttachConsole failed" and prints a stack
 * into daemon.log at every terminal closed (TODO #440). The shipped ConPTY
 * closes the session without that agent.
 */
export function ptySpawnOptions(opts: PtySpawnOptions, platform: NodeJS.Platform = process.platform): NodePtyOptions {
  return {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env,
    ...(platform === 'win32' ? { useConptyDll: true } : {}),
  };
}

export const nodePtySpawner: PtySpawner = (opts) => {
  const pty = loadNodePty();
  if (!pty) throw new Error('pty_unavailable');
  return pty.spawn(opts.shell, opts.args, ptySpawnOptions(opts));
};
