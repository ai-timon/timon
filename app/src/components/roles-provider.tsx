'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { hydrateCustomRoles, loadLucideIconSet } from '@/lib/roles';

type CustomRole = { id: string; label: string; color: string; builtin?: boolean; iconName?: string; iconSvg?: string };

/**
 * Hydrates user-defined custom roles into the (sync) module cache of
 * `@/lib/roles` once on mount, then bumps a version so subscribed components
 * (RoleBadge via useRolesVersion) re-render to pick them up. Built-in roles
 * resolve synchronously without this; only custom roles depend on it.
 */
const RolesVersionContext = createContext(0);

export function useRolesVersion(): number {
  return useContext(RolesVersionContext);
}

export function RolesProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/ui/agent-roles', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { roles: [] }))
      .then((j) => {
        if (cancelled) return;
        const roles: CustomRole[] = j.roles || [];
        const custom = roles.filter((r) => r.builtin === false && (r.iconSvg || r.iconName));
        if (!custom.length) return;
        // Draw the stored shapes now, then the real lucide icons once loaded.
        hydrateCustomRoles(custom);
        setVersion((v) => v + 1);
        return loadLucideIconSet().then((icons) => {
          if (cancelled) return;
          hydrateCustomRoles(custom, icons);
          setVersion((v) => v + 1);
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <RolesVersionContext.Provider value={version}>{children}</RolesVersionContext.Provider>
  );
}
