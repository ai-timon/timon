import type { TimonConfig } from '../config/schema.js';
import { config } from '../config/load.js';
import { createGenericHost } from './generic.js';
import { createLinuxHost } from './linux.js';
import { hasSystemd } from './systemd.js';
import type { ExecOpts, Host } from './types.js';

export type { Capability, ExecOpts, ExecResult, Host, RevealVia, SpawnOpts } from './types.js';
export { chooseRevealLane, type RevealLane } from './reveal.js';
export type { DesktopSession } from './desktop-session.js';
export { isDirectoryLink, linkDirectory, removeDirectoryLink } from './directory-link.js';
export { createGenericHost } from './generic.js';
export { createLinuxHost } from './linux.js';
export { hasSystemd, systemctlCallCount } from './systemd.js';

let current: Host | undefined;

export function createHost(cfg: TimonConfig): Host {
  // Pins are read from the live config, not from `cfg`: the adapter lives as
  // long as the daemon, and `host.binaries` can change under it (TODO #413).
  const pins = () => config().host.binaries;
  const host = process.platform === 'linux' && hasSystemd()
    ? createLinuxHost(cfg, pins)
    : createGenericHost(cfg, {}, pins);
  current = host;
  // On stderr, not stdout: `getHost()` is lazy, so this line also comes out
  // from the CLI (`timon doctor --json`, `timon module list --json`) where it would
  // mix into the JSON and make it unparsable. The systemd journal
  // captures both streams, the daemon loses nothing.
  console.error(`[host] profile=${cfg.profile} capabilities=[${host.capabilities().join(', ')}]`);
  return host;
}

/** Singleton set by `createHost`. Lazy-init via `config()` so that the
 *  original wrappers (`wrapMissionLaunch`, etc.) work before 2.3
 *  (`boot.ts` provide). */
export function getHost(): Host {
  if (!current) createHost(config());
  return current!;
}

/**
 * Contract of `promisify(execFile)` carried by the adapter: resolves
 * `{ stdout, stderr }`, rejects if the exit code is not 0.
 *
 * Exists to switch the ~20 `git` callers (git.ts, worktree*.ts,
 * verification-loop.ts, merge-integrity.ts) without rewriting their error
 * handling: they read `err.stderr` or `err.message`, both provided here.
 */
export async function execFileHost(
  name: string,
  args: string[],
  opts: ExecOpts = {},
): Promise<{ stdout: string; stderr: string }> {
  const r = await getHost().execAsync(name, args, opts);
  if (r.code !== 0) {
    const err = new Error(
      `${name} failed (code ${r.code})${r.stderr.trim() ? ` : ${r.stderr.trim()}` : ''}`,
    ) as Error & { code: number; stdout: string; stderr: string; timedOut?: boolean };
    err.code = r.code;
    err.stdout = r.stdout;
    err.stderr = r.stderr;
    if (r.timedOut) err.timedOut = true;
    throw err;
  }
  return { stdout: r.stdout, stderr: r.stderr };
}
