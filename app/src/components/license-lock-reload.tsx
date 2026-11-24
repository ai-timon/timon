'use client';

import { useEffect } from 'react';
import { betaLock, useLicense } from '@/lib/license';
import { machineScopedStorage } from '@/lib/machines/machine-storage';

const RELOAD_KEY = 'timon-lock-reload';

/**
 * Paints nothing. What remains of the former licence banner: the licence's
 * messages are notice cards now (`components/notices/license-notices.tsx`),
 * but the lock of a beta build is a whole screen, chosen by the server layout.
 */
export function LicenseLockReload(): null {
  const license = useLicense();
  // The build ended or the licence was revoked while the cockpit was open: the
  // lock screen is chosen by the server layout, so it takes a reload to get it.
  // Once per 10 s at most, so a layout that cannot read the state never loops.
  const locked = betaLock(license) !== null;
  useEffect(() => {
    if (!locked) return;
    try {
      const last = Number(machineScopedStorage(window.sessionStorage).getItem(RELOAD_KEY) ?? 0);
      if (Date.now() - last < 10_000) return;
      machineScopedStorage(window.sessionStorage).setItem(RELOAD_KEY, String(Date.now()));
    } catch { /* storage refused: a single reload attempt is not worth a loop */ return; }
    window.location.reload();
  }, [locked]);
  return null;
}
