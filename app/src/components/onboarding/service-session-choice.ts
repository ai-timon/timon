/**
 * The onboarding's answer to "keep Timon running once you log out?"
 * (`steps/background.tsx`), kept until the background install sends it with
 * `install-service` (`preparation.ts`). The daemon records it and decides
 * from it whether the service outlives the session (Linux lingering, macOS
 * LaunchDaemon, Windows boot task). Kept in the machine's session storage: the install runs a
 * step or two later, possibly after a reload.
 */
import type { ServiceStatusRead } from '@/lib/setup-plan';
import type { ServiceSessionMode } from '@/lib/system-info';

export const SESSION_CHOICE_KEY = 'timon.onboarding.serviceSessionMode';

type ChoiceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readSessionChoice(storage: ChoiceStorage | null): ServiceSessionMode | null {
  try {
    const value = storage?.getItem(SESSION_CHOICE_KEY);
    return value === 'session' || value === 'always' ? value : null;
  } catch {
    return null;
  }
}

export function keepSessionChoice(storage: ChoiceStorage | null, mode: ServiceSessionMode): void {
  try {
    storage?.setItem(SESSION_CHOICE_KEY, mode);
  } catch { /* a private window without storage: the install falls back to the session */ }
}

/**
 * Is there nothing to ask? The onboarding is over, a service is already
 * registered (the answer then lives in Settings › System), or the answer
 * changes nothing on this machine (a Linux without systemd). A
 * daemon that refuses to answer before the account is asked anyway: an
 * answer the daemon then ignores costs nothing.
 */
export function skipsSessionChoice(read: ServiceStatusRead): boolean {
  if (read.kind === 'closed') return true;
  if (read.kind !== 'answer') return false;
  return read.answer.installed === true || read.answer.sessionModeSupported === false;
}
