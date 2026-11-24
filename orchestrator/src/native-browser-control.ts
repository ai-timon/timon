import { NativeBrowserError } from './native-browser-provider.js';
import { apiError } from './api-error.js';

export type BrowserActor = { id: string; kind: 'human' | 'agent' };
type Lease = BrowserActor & { expiresAt: number };
const LEASE_MS = 60_000;

/** One controller per profile; spectators never resize or send input. */
export function browserControls(now: () => number = Date.now) {
  const leases = new Map<string, Lease>();
  const live = (profile: string) => {
    const lease = leases.get(profile);
    if (lease && lease.expiresAt > now()) return lease;
    leases.delete(profile);
    return undefined;
  };
  return {
    status(profile: string, actor?: BrowserActor | null) {
      const lease = live(profile);
      return { holder: lease ? (lease.id === actor?.id ? 'you' : 'other') : null, kind: lease?.kind ?? null };
    },
    acquire(profile: string, actor: BrowserActor, force = false) {
      const lease = live(profile);
      if (lease && lease.id !== actor.id && !force) throw new NativeBrowserError(apiError('browser_control_taken', 'Another controller is using this browser. Take control to interact.'), 409);
      const changed = lease?.id !== actor.id;
      leases.set(profile, { ...actor, expiresAt: now() + LEASE_MS });
      return changed;
    },
    renew(profile: string, actor: BrowserActor) {
      const lease = live(profile);
      if (lease?.id === actor.id) leases.set(profile, { ...lease, expiresAt: now() + LEASE_MS });
    },
    release(profile: string, actor: BrowserActor) {
      const lease = live(profile);
      if (lease && lease.id !== actor.id) throw new NativeBrowserError(apiError('browser_control_not_holder', 'Only the current controller can release this browser.'), 409);
      leases.delete(profile);
    },
  };
}
