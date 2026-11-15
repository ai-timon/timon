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
 */

type Entry = { readonly owner: object; readonly fenced: boolean };

const launches = new Map<string, Entry>();

/** Records how `owner`, the process just launched for `missionId`, was launched. */
export function recordMissionFence(missionId: string, owner: object, fenced: boolean): void {
  launches.set(missionId, { owner, fenced });
}

/** Forgets the record of `owner`, once it is gone; a newer launch's record stays. */
export function forgetMissionFence(missionId: string, owner: object): void {
  if (launches.get(missionId)?.owner === owner) launches.delete(missionId);
}

/** The mission's current process runs inside the fence. False when unknown. */
export function missionFenced(missionId: string): boolean {
  return launches.get(missionId)?.fenced === true;
}
