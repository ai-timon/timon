/**
 * Boot check of the backend CLIs.
 *
 * A backend whose binary cannot be resolved is a backend whose every mission
 * dies at spawn, before writing a single byte. The daemon knew it all along
 * (`[agent] could not resolve binary …`), but nothing said so outside its own
 * log: on a beta tester's Mac, three missions came back empty and the only
 * trace was in a file they never opened (20/09/2026).
 *
 * So the check is done ONCE, at boot, and its verdict leaves the log: a line
 * for the daemon, a non-urgent notification for the human, naming what to
 * install or what to pin. It is a report, never a gate — a machine with one
 * usable CLI out of three must still boot, and a backend can be installed
 * while the daemon runs.
 */
import { config } from '../config/load.js';
import {
  findExecutableBinary, resolvePinnedBinary, type BinarySearchOptions,
} from '../host/binary-path.js';
import { installCommandFor, linuxRelease, readOsRelease } from '../host/machine.js';
import { activeProfiles } from './registry.js';
import { isRemoteDialect } from './types.js';
import { baseBackendId } from './instance-id.js';

export type BackendBinaryStatus = {
  /** Binary the profiles will spawn (`profile.cmd`, else the dialect's). */
  cmd: string;
  /** Backend ids served by it — a custom profile may reuse a first-party CLI. */
  backends: string[];
  /** Resolved path, `null` when nothing usable was found. */
  path: string | null;
  /** True when the resolution went through `host.binaries.<cmd>`. */
  pinned: boolean;
};

/**
 * State of each backend CLI, resolved exactly as a spawn would resolve it
 * (`host.binaries` pin first, detection next). Grouped by binary: two profiles
 * on the same CLI share one verdict, and must not raise the alert twice.
 */
export function checkBackendBinaries(options: BinarySearchOptions = {}): BackendBinaryStatus[] {
  const pins = config().host.binaries;
  const byCmd = new Map<string, BackendBinaryStatus>();
  for (const { profile, dialect } of activeProfiles()) {
    // Nothing to install for an agent reached over the network.
    if (isRemoteDialect(dialect)) continue;
    const cmd = profile.cmd ?? dialect.defaultCmd;
    const known = byCmd.get(cmd);
    if (known) {
      known.backends.push(profile.id);
      continue;
    }
    // Resolved like `doctor`'s `whichBin`, deliberately re-stated here rather
    // than imported: `doctor.ts` pulls in `agent.ts`, and this module is read
    // by the backends module at boot — a cycle for three lines of lookup.
    const { path, pinned } = resolveCmd(cmd, pins, options);
    byCmd.set(cmd, { cmd, backends: [profile.id], path, pinned });
  }
  return [...byCmd.values()];
}

function resolveCmd(
  cmd: string,
  pins: Record<string, unknown>,
  options: BinarySearchOptions,
): { path: string | null; pinned: boolean } {
  const pin = pins[cmd];
  const pinned = typeof pin === 'string' && pin.length > 0;
  return { path: pinned ? resolvePinnedBinary(cmd, pin, options) : findExecutableBinary(cmd, options), pinned };
}

/** A verdict is reused this long: on Windows a miss asks npm for its prefix,
 *  a process per call, and a fallback cascade asks several times in a row. */
const AVAILABILITY_TTL_MS = 30_000;
const availability = new Map<string, { at: number; ok: boolean }>();
let availabilityOverride: ((backend: string) => boolean) | null = null;

/**
 * False when `backend` runs a local CLI that cannot be resolved right now —
 * a fallback onto it would die at spawn (`spawn claude ENOENT`, tester's Mac,
 * 2026-10-18). Resolved at call time, not at boot: a CLI installed while the
 * daemon runs counts within `AVAILABILITY_TTL_MS`. A backend this module does
 * not know (remote, inactive profile) is not its call: true.
 */
export function backendBinaryAvailable(backend: string): boolean {
  if (availabilityOverride) return availabilityOverride(backend);
  const id = baseBackendId(backend);
  const entry = activeProfiles().find(({ profile }) => profile.id === id);
  if (!entry || isRemoteDialect(entry.dialect)) return true;
  const cmd = entry.profile.cmd ?? entry.dialect.defaultCmd;
  const cached = availability.get(cmd);
  if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) return cached.ok;
  const ok = resolveCmd(cmd, config().host.binaries, {}).path !== null;
  availability.set(cmd, { at: Date.now(), ok });
  return ok;
}

/** Forgets the cached verdicts: a pin just written or removed must count for
 *  the next fallback decision, not 30 seconds later. */
export function invalidateBackendBinaryAvailability(): void {
  availability.clear();
}

/** Test seam: fixes the verdict of `backendBinaryAvailable`; `null` restores
 *  the real lookup. Fallback tests must not depend on the CLIs of the machine
 *  that runs them. */
export function setBackendBinaryAvailabilityForTest(fn: ((backend: string) => boolean) | null): void {
  availabilityOverride = fn;
  availability.clear();
}

/** Anchor of the notification raised for one binary — stable across reboots so
 *  the previous warning is dismissed instead of piling up. */
export function backendBinaryAnchor(cmd: string): string {
  return `backend-binary:${cmd}`;
}

export type BackendBinaryPresentation = {
  kind: 'backend-binary';
  cmd: string;
  backends: string[];
  pinned: boolean;
  installCommand: string | null;
};

function backendInstallCommand(cmd: string): string | null {
  const linux = process.platform === 'linux' ? linuxRelease(readOsRelease()) : null;
  return installCommandFor(cmd, {
    platform: process.platform, packageManager: linux?.packageManager ?? null,
  });
}

/** English remains the stored diagnostic for the daemon and non-UI channels. */
function binaryNotice(
  status: BackendBinaryStatus,
  install: string | null,
  legacyMarkdown = false,
): { title: string; body: string } {
  const backends = status.backends.join(', ');
  const settings = 'Settings › AI models › Providers › CLI binaries';
  const emphasize = (text: string) => legacyMarkdown ? `**${text}**` : text;
  const repair = status.pinned
    ? `The path pinned for \`${status.cmd}\` (\`host.binaries.${status.cmd}\`) does not point to an executable file. Fix it in ${emphasize(settings)}, or clear it to let Timon look for the CLI itself.`
    : `Install it, then click ${emphasize('Check again')} in ${emphasize(settings)} — or pin the full path of the \`${status.cmd}\` binary there (\`host.binaries.${status.cmd}\`).`;
  return {
    title: `Backend ${backends}: the \`${status.cmd}\` CLI was not found`,
    body: [
      `Timon cannot run \`${status.cmd}\` on this machine, so every mission on ${backends} fails as soon as it starts.`,
      '',
      `${emphasize('Action needed:')} ${repair}`,
      ...(install ? ['', `- Install command on this machine: \`${install}\``] : []),
    ].join('\n'),
  };
}

/** What the human is told, and how to repair it. */
export function backendBinaryNotice(status: BackendBinaryStatus): { title: string; body: string } {
  return binaryNotice(status, backendInstallCommand(status.cmd));
}

/** Only recognized daemon diagnostics get UI metadata. An anchor alone is not
 *  provenance: agents and users can also choose their notification's anchor.
 *  Exact canonical comparisons support stored pre-localization warnings without
 *  interpreting or rewriting arbitrary notification text. */
export function backendBinaryPresentation(
  notification: {
    type: string; title: string; body: string | null; anchor: string | null;
    source: string | null; task_id: string | null; mission_id: string | null;
    owner_user_id: string | null;
  },
  statuses: readonly BackendBinaryStatus[],
): BackendBinaryPresentation | undefined {
  // Ownership scopes visibility, not authorship: first-run attribution can
  // assign an existing daemon warning to the administrator.
  if (notification.type !== 'alert' || notification.source != null
    || notification.task_id != null || notification.mission_id != null) return undefined;
  const status = statuses.find((s) => backendBinaryAnchor(s.cmd) === notification.anchor);
  if (!status) return undefined;
  const install = backendInstallCommand(status.cmd);
  // The pin may have changed since this warning was stored; preserve the
  // diagnosis the card actually contains, even in the dismissed archive.
  for (const pinned of [status.pinned, !status.pinned]) {
    for (const installCommand of install ? [install, null] : [null]) {
      for (const legacyMarkdown of [false, true]) {
        const notice = binaryNotice({ ...status, pinned }, installCommand, legacyMarkdown);
        if (notification.title === notice.title && notification.body === notice.body) {
          return { kind: 'backend-binary', cmd: status.cmd, backends: status.backends, pinned, installCommand };
        }
      }
    }
  }
  return undefined;
}

/**
 * Runs the check and reports it. Called once at boot by the `@timon/backends`
 * module.
 *
 * The notification of a binary found again is dismissed on the way through:
 * the warning of a past boot must not survive the install that answered it.
 */
export function reportBackendBinaries(): BackendBinaryStatus[] {
  const statuses = checkBackendBinaries();
  const missing = statuses.filter((status) => status.path === null);
  console.log(
    `[backends] CLI binaries: ${statuses.length - missing.length}/${statuses.length} resolved`
    + (missing.length
      ? ` — unavailable: ${missing.map((s) => `${s.cmd} (${s.backends.join(', ')})`).join(', ')}`
      : ''),
  );
  void import('../notifications.js').then(async ({ createNotification }) => {
    const { dbApi } = await import('../db.js');
    for (const status of statuses) {
      // A warning raised by a past boot must not outlive the install that
      // answered it: the anchor is what lets us take it back.
      dbApi.dismissNotificationsByAnchor(backendBinaryAnchor(status.cmd), 'alert');
      if (status.path !== null) continue;
      const { title, body } = backendBinaryNotice(status);
      createNotification({
        type: 'alert',
        urgent: false,
        title,
        body,
        anchor: backendBinaryAnchor(status.cmd),
      });
    }
  }).catch((err: unknown) => {
    console.warn(`[backends] could not raise the missing-CLI alert: ${(err as Error).message}`);
  });
  return statuses;
}
