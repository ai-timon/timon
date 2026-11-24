/**
 * Whether the process a mission runs in right now was launched inside the
 * mission fence (`resources.ts`, `wrapMissionLaunch`), for the code that
 * talks to that process afterwards and must not wait on what the fence
 * forbids.
 *
 * The ACP session driver is the reader: on `auth_required` it may ask the
 * agent to `authenticate`, and an agent's sign-in method can open a browser
 * and wait for its redirect (Antigravity). A fenced process reaches no
 * display, no browser and no keychain bus, so that wait never ends; the driver
 * reports the sign-in step at once instead.
 *
 * Kept in the daemon, by mission id, rather than in the session arguments: those
 * are the provider SDK's contract, and whether a launch is fenced is the
 * daemon's own business. One entry per mission, owned by the process that set
 * it, so the exit of a previous turn's process does not erase the next one's.
 *
 * The second reader is the move of a subscription account's keychain entry
 * (`ctx.provider.account.osCredential`, macOS). The entry is copied into the
 * account's folder, then deleted, so that a fenced CLI, which cannot update
 * the keychain, finds its sign-in in the folder alone. `security` has no
 * compare-and-delete: what makes the delete safe is that no process Timon
 * launched can write the entry meanwhile. A process on the account writes it
 * when it runs outside the fence, or inside a fence that leaves the keychain
 * writable (a `writable` exception). So every live process is kept here with
 * its account, and a launch being prepared says whether it will be fenced,
 * before its provider builds the command (`prepareMissionLaunch`): that is
 * when the move happens.
 */
import { splitBackendInstance } from './backends/instance-id.js';

type Live = {
  readonly missionId: string;
  readonly fenced: boolean;
  readonly account: string | null;
  /** It may write its account's entry in the OS credential store whenever it renews its sign-in. */
  readonly writesAccountCredential: boolean;
};

/** Every process Timon launched for a mission or a one-shot, until it closes. */
const processes = new Map<object, Live>();
/** The mission's current process, among `processes`. */
const latest = new Map<string, object>();

type Preparing = { readonly token: object; readonly account: string | null; readonly fenced: boolean };

/** Launches whose command is being built, by mission: what the fence will be for them. */
const preparing = new Map<string, Preparing>();

export type MissionFenceAccount = {
  /** The subscription account the process runs on (`splitBackendInstance`), null for none. */
  readonly account?: string | null;
  /** A fenced process whose fence leaves the OS credential store writable (`fenceWritesCredentialStore`). */
  readonly credentialStoreWritable?: boolean;
};

/** Records how `owner`, the process just launched for `missionId`, was launched. */
export function recordMissionFence(missionId: string, owner: object, fenced: boolean, on: MissionFenceAccount = {}): void {
  const account = on.account ?? null;
  processes.set(owner, {
    missionId, fenced, account,
    writesAccountCredential: account !== null && (!fenced || on.credentialStoreWritable === true),
  });
  latest.set(missionId, owner);
}

/** Forgets the record of `owner`, once it is gone; a newer launch's record stays. */
export function forgetMissionFence(missionId: string, owner: object): void {
  processes.delete(owner);
  if (latest.get(missionId) === owner) latest.delete(missionId);
}

/** The mission's current process runs inside the fence. False when unknown. */
export function missionFenced(missionId: string): boolean {
  const owner = latest.get(missionId);
  return owner ? processes.get(owner)?.fenced === true : false;
}

/**
 * A launch of `missionId` on `account` is being prepared, and will be fenced
 * against the OS credential store or not (`fenced`, as `missionFenceExpected`
 * predicts it). Held from before the provider builds the command until the
 * process is recorded or the launch failed; the release is idempotent and
 * leaves a newer launch's record alone.
 */
export function prepareMissionLaunch(missionId: string, launch: { account: string | null; fenced: boolean }): () => void {
  const token = {};
  preparing.set(missionId, { token, account: launch.account, fenced: launch.fenced });
  return () => {
    if (preparing.get(missionId)?.token === token) preparing.delete(missionId);
  };
}

/**
 * Why the keychain entry of `account` must not be deleted now, for the launch
 * of `missionId`; null when it may. `unfenced`: no fenced launch of that
 * mission on that account is being prepared, so its CLI updates the keychain
 * itself and nothing needs to move. `in-use`: another process Timon launched
 * runs on the account and may write the entry at any moment.
 *
 * Read in the same synchronous run as the delete (`provider-facade.ts`): a
 * process spawned outside the fence is recorded in the tick of its spawn, so
 * it is either seen here or starts after the delete.
 */
export function accountCredentialHold(account: string, missionId: string): 'unfenced' | 'in-use' | null {
  const launch = preparing.get(missionId);
  if (!launch || launch.account !== account || !launch.fenced) return 'unfenced';
  for (const live of processes.values()) {
    if (live.account === account && live.writesAccountCredential) return 'in-use';
  }
  return null;
}

/**
 * A one-shot prompt's process (`summary.ts`, `session-one-shot.ts`): never fenced, recorded
 * with its account in the tick of its spawn and forgotten when it closes.
 */
export function recordOneShotProcess(missionId: string, backendName: string, proc: { once(event: 'close', listener: () => void): unknown }): void {
  recordMissionFence(missionId, proc, false, { account: splitBackendInstance(backendName).accountId });
  proc.once('close', () => forgetMissionFence(missionId, proc));
}

/** For tests: forgets every record. */
export function resetMissionFenceState(): void {
  processes.clear();
  latest.clear();
  preparing.clear();
}
