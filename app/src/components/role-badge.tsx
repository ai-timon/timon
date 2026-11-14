'use client';

import { cn } from '@/lib/utils';
import { resolveRole } from '@/lib/roles';
import { useRolesVersion } from '@/components/roles-provider';
import { RoleSvg } from '@/components/role-svg';

type Size = 'xs' | 'sm' | 'md';

const SIZE: Record<Size, string> = {
  xs: 'text-[9.5px] px-1 py-0 gap-0.5',
  sm: 'text-[10.5px] px-1.5 py-0.5 gap-1',
  md: 'text-[12px] px-2 py-1 gap-1.5',
};

const ICON: Record<Size, string> = {
  xs: 'size-2.5',
  sm: 'size-3',
  md: 'size-3.5',
};

/**
 * Canonical role/type chip — one picto + one colour per role, sourced from
 * `@/lib/roles`. Use EVERYWHERE a role or task type is shown so the visual
 * never diverges again. Pass a role id (`coder`), a task type (`code`), or an
 * agent-name suffix (`main`) — all resolve to the same visual.
 *
 * `label` overrides the displayed text (defaults to the passed role string so
 * a task chip can read `code` while still using the coder visual). Renders
 * nothing for an unknown role, so callers can drop it in unconditionally.
 */
export function RoleBadge({
  role,
  size = 'sm',
  label,
  withLabel = true,
  uppercase = true,
  className,
}: {
  role: string | null | undefined;
  size?: Size;
  label?: string;
  withLabel?: boolean;
  uppercase?: boolean;
  className?: string;
}) {
  useRolesVersion(); // re-render once custom roles hydrate into the cache
  const visual = resolveRole(role);
  if (!visual) return null;
  const Icon = visual.icon;
  // Default text is the raw role/type string (so task chips read "code",
  // "review", …). Orchestrator is the exception: always its short label
  // "orch" — the raw "main" suffix next to an icon read like a git branch ref.
  const text =
    label ?? (visual.key === 'orchestrator' ? visual.label : role ?? visual.label);
  const c = visual.color;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md border font-medium whitespace-nowrap lowercase',
        uppercase && 'uppercase tracking-wide',
        SIZE[size],
        className,
      )}
      style={{ color: c, borderColor: `${c}66`, background: `${c}14` }}
      title={`role · ${visual.key}`}
    >
      {Icon ? (
        <Icon className={ICON[size]} />
      ) : visual.iconSvg ? (
        <RoleSvg svg={visual.iconSvg} className={ICON[size]} />
      ) : null}
      {withLabel && text}
    </span>
  );
}
