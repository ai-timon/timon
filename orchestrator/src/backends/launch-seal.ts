/**
 * What a provider plugin is handed IN PLACE of a secret (`docs/SECURITY.md` § 6.4.1,
 * `docs/PROVIDERS-SDK.md` § 8).
 *
 * A provider declares Timon's MCP servers to its agent, so it has to put an
 * identity — the mission's token, and the credentials of the user's own servers —
 * into a file or a request. It must do so without ever holding the value: the
 * daemon gives it a REFERENCE (`timon-seal-<random>`), the plugin writes the
 * reference wherever the value belongs, and the daemon swaps it back at the points
 * where the data reaches the agent's MCP servers and nothing else:
 *
 *   - the stdin payload of a launch (`SpawnResult.initialStdin`);
 *   - the pipe of a session driver (`mission-token-seal.ts`);
 *   - a file written through `ctx.provider.scratch`.
 *
 * Never the command line, never the environment. The arguments of a process are
 * readable by any account (`/proc/<pid>/cmdline`, the process list); the
 * environment is inherited by every child of the CLI — the shell the model drives
 * included, where a plain `env` would print the token. A reference found in `args`
 * or in `env` makes the launch fail instead of being swapped (`SealedArgvError`,
 * `SealedEnvError`).
 *
 * A seal belongs to ONE launch of ONE mission. A reference is random, worthless on
 * its own, and unknown to any other launch: written anywhere the daemon does not
 * swap, it authenticates nothing. The seal itself is never given to a plugin — it
 * holds the values — only the references it mints.
 */

import { randomBytes } from 'node:crypto';
import type { BuildSpawnOpts } from './types.js';

const REF_PREFIX = 'timon-seal-';

export type SealEscape = 'none' | 'json';

export class LaunchSeal {
  readonly missionId: string;
  /** The backend (profile id) the launch is for. */
  readonly backend: string;
  /** What the daemon asked the provider to build — the plugin is given it, but a service answers from THIS copy, so a plugin cannot widen the question. Null for a seal minted for a single pipe. */
  readonly spawn: BuildSpawnOpts | null;
  /** Host-owned provenance for discovery, not a globally reserved server name. */
  readonly injectedMcpServers = new Set<string>();

  readonly #resolvers = new Map<string, () => string>();
  readonly #resolved = new Map<string, string>();
  readonly #refByKey = new Map<string, string>();

  constructor(missionId: string, backend: string, spawn: BuildSpawnOpts | null) {
    this.missionId = missionId;
    this.backend = backend;
    this.spawn = spawn;
  }

  /** The reference standing for `value`. The same value always gets the same reference. */
  protect(value: string): string {
    return this.protectLazy(`v:${value}`, () => value);
  }

  /**
   * A reference for a value that is not known yet — the mission's token, which the
   * daemon issues at most once per launch (issuing revokes the previous one). `key`
   * names it, so asking twice gives the same reference.
   */
  protectLazy(key: string, resolve: () => string): string {
    const known = this.#refByKey.get(key);
    if (known) return known;
    const ref = `${REF_PREFIX}${randomBytes(16).toString('hex')}`;
    this.#refByKey.set(key, ref);
    this.#resolvers.set(ref, resolve);
    return ref;
  }

  #valueOf(ref: string): string {
    let value = this.#resolved.get(ref);
    if (value === undefined) {
      value = this.#resolvers.get(ref)!();
      this.#resolved.set(ref, value);
    }
    return value;
  }

  /** Whether `text` carries one of this seal's references. */
  has(text: string): boolean {
    for (const ref of this.#resolvers.keys()) if (text.includes(ref)) return true;
    return false;
  }

  /** `text` with every reference replaced by its value; `json` escapes it for the inside of a JSON or TOML string. */
  swap(text: string, escape: SealEscape = 'none'): string {
    let out = text;
    for (const ref of this.#resolvers.keys()) {
      if (!out.includes(ref)) continue;
      const value = this.#valueOf(ref);
      out = out.split(ref).join(escape === 'json' ? JSON.stringify(value).slice(1, -1) : value);
    }
    return out;
  }

  /**
   * Longest suffix of `text` that is the start of a reference cut by a chunk
   * boundary: a stream must hold it back until the next chunk says what it is.
   */
  heldTail(text: string): number {
    let longest = 0;
    for (const ref of this.#resolvers.keys()) {
      const max = Math.min(text.length, ref.length - 1);
      for (let n = max; n > longest; n--) {
        if (ref.startsWith(text.slice(text.length - n))) { longest = n; break; }
      }
    }
    return longest;
  }

  /** The mission's token, issued on first use. Daemon code only: the value is the one thing a plugin must not hold. */
  resolve(ref: string): string | undefined {
    return this.#resolvers.has(ref) ? this.#valueOf(ref) : undefined;
  }

  /** The reference of the mission's token, once something asked for it. */
  tokenRef(): string | undefined {
    return this.#refByKey.get('token');
  }
}

/* ── One seal per launch, found by mission ──────────────────────────────── */

const live = new Map<string, LaunchSeal>();

/**
 * Opens the seal of a launch. `issueToken` is called at most once, when something
 * first needs the value — a file written through `ctx.provider.scratch` while
 * `buildSpawn` still runs, the environment of the process, the session's pipe.
 */
export function openLaunchSeal(
  missionId: string, backend: string, spawn: BuildSpawnOpts, issueToken: () => string,
): LaunchSeal & { token(): string } {
  const seal = new LaunchSeal(missionId, backend, spawn);
  const ref = seal.protectLazy('token', issueToken);
  live.set(missionId, seal);
  return Object.assign(seal, { token: () => seal.resolve(ref)! });
}

/** The seal of the launch in progress for `missionId`, if the backend is a plugin's. */
export function sealFor(missionId: string): LaunchSeal | undefined {
  return live.get(missionId);
}

/** The launch is over (its process closed): its references stop meaning anything. */
export function closeLaunchSeal(seal: LaunchSeal): void {
  if (live.get(seal.missionId) === seal) live.delete(seal.missionId);
}

export class SealedArgvError extends Error {
  constructor(readonly backend: string) {
    super(`backend ${backend}: the launch puts a secret reference in the command line, which any account can read `
      + '(process list). Pass it through the environment or a file written with ctx.provider.scratch.');
    this.name = 'SealedArgvError';
  }
}

export class SealedEnvError extends Error {
  constructor(readonly backend: string) {
    super(`backend ${backend}: the launch puts a secret reference in the process environment, which every program the CLI starts inherits `
      + '(a shell the model drives would print it). Write the MCP configuration to a file with ctx.provider.scratch.writeFile, or send it on stdin.');
    this.name = 'SealedEnvError';
  }
}
