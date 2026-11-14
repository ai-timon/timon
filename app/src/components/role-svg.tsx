import { createElement, useMemo, type ReactNode } from 'react';
import { lucideIconByName, parseRoleSvg, type RoleSvgNode } from '@/lib/roles';
import { useRolesVersion } from '@/components/roles-provider';

function renderNodes(nodes: RoleSvgNode[], prefix: string): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${prefix}${i}`;
    return createElement(n.tag, { key, ...n.attrs }, ...renderNodes(n.children, `${key}.`));
  });
}

/**
 * A role icon (24×24, stroke-based). A known lucide `iconName` is drawn with
 * its component; otherwise the stored markup is drawn from its parsed shapes,
 * so it never reaches the DOM as HTML. Markup outside the grammar draws an
 * empty frame.
 */
export function RoleSvg({
  svg,
  iconName,
  className,
  size,
}: {
  svg: string | undefined;
  iconName?: string;
  className?: string;
  size?: number;
}) {
  // The lucide set loads after the first render: re-render when it lands.
  useRolesVersion();
  const nodes = useMemo(() => parseRoleSvg(svg ?? '') ?? [], [svg]);
  const Icon = lucideIconByName(iconName);
  if (Icon) return <Icon size={size} className={className} aria-hidden />;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {renderNodes(nodes, '')}
    </svg>
  );
}
