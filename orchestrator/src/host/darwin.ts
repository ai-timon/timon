/**
 * macOS adapter: the generic adapter, plus the mission fence through Seatbelt.
 *
 * `sandbox-exec` ships with macOS and is what codex and Claude Code's own
 * sandbox run on; Apple marks it deprecated without a replacement for a
 * command-line tool. It is probed once per daemon, and a missing or refused
 * Seatbelt is reported, never assumed (`HostFence.probe`).
 *
 * The rendering is pure and lives in `host/seatbelt.ts`; this file holds what
 * touches the machine: resolving paths on disk (Seatbelt matches resolved
 * paths only), writing the profile, running the probe.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TimonConfig } from '../config/schema.js';
import { runFenceWitness } from './fence.js';
import { createGenericHost, type BinaryPins } from './generic.js';
import {
  canonicalPaths, parseSeatbeltProbe, renderSeatbeltProfile, SANDBOX_EXEC, SEATBELT_PROBE_PROFILE, seatbeltLaunch,
} from './seatbelt.js';
import type { Host, HostFence, HostFenceProbe, HostFenceWitness } from './types.js';

/** `/usr/bin/true`, the payload of the probe. */
const TRUE_BINARY = '/usr/bin/true'; // portability: macOS system binary, used on darwin only

export type SeatbeltFenceDeps = {
  /** Runs the probe; `spawnSync` by default. */
  run?: (file: string, args: string[]) => { status: number | null; stderr: string; error?: Error };
  /** Resolves an existing path; `fs.realpathSync.native` by default. */
  realpath?: (path: string) => string;
  /** Writes the profile where the launcher reads it. */
  writeProfile?: (file: string, text: string) => void;
  /** Where a dropped grant is reported. */
  warn?: (line: string) => void;
  /** Runs the witness; `runFenceWitness` by default. */
  runWitness?: (file: string, args: readonly string[]) => Promise<HostFenceWitness>;
};

function runProbe(file: string, args: string[]): { status: number | null; stderr: string; error?: Error } {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'ignore', 'pipe'] });
  return { status: result.status, stderr: result.stderr ?? '', ...(result.error ? { error: result.error } : {}) };
}

/** Owner-only, like every file the daemon keeps under its home; rewritten whole at each launch. */
function writeProfileFile(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function createSeatbeltFence(deps: SeatbeltFenceDeps = {}): HostFence {
  const run = deps.run ?? runProbe;
  const realpath = deps.realpath ?? ((path: string) => realpathSync.native(path));
  const writeProfile = deps.writeProfile ?? writeProfileFile;
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const runWitness = deps.runWitness ?? ((file: string, args: readonly string[]) => runFenceWitness(file, args));
  let probed: HostFenceProbe | undefined;
  return {
    mechanism: 'seatbelt',
    probe() {
      if (!probed) {
        const result = run(SANDBOX_EXEC, ['-p', SEATBELT_PROBE_PROFILE, TRUE_BINARY]);
        probed = parseSeatbeltProbe(result.status, result.stderr, result.error);
      }
      return probed;
    },
    wrap(policy, cmd, args, policyFile) {
      const profile = renderSeatbeltProfile(policy, { spellings: (path) => canonicalPaths(path, realpath) });
      for (const { path, reason } of profile.dropped) warn(`[host] mission fence: grant on ${path} dropped: ${reason}`);
      writeProfile(policyFile, profile.text);
      return seatbeltLaunch(policyFile, cmd, args);
    },
    witness(policyFile) {
      // The launch's own profile, so that one this macOS cannot compile fails here too.
      const launch = seatbeltLaunch(policyFile, TRUE_BINARY, []);
      return runWitness(launch.cmd, launch.args);
    },
  };
}

export function createDarwinHost(config: TimonConfig, pins?: BinaryPins): Host {
  const base = createGenericHost(config, {}, pins ?? (() => config.host.binaries));
  return { ...base, platform: 'darwin', fence: createSeatbeltFence() };
}
