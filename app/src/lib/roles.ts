import {
  BookOpen,
  ChefHat,
  Code2,
  GitMerge,
  ScanSearch,
  Telescope,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * SINGLE SOURCE OF TRUTH for how an agent role / task type is shown anywhere
 * in the UI — missions rail, kanban tasks, agents canvas, agent-edit dropdown,
 * chat header. One picto + one colour per role.
 *
 * Built-ins (below) are hardcoded so `resolveRole` stays SYNC and SSR-safe.
 * CUSTOM roles (defined by the user via the UI, persisted server-side) are
 * hydrated into a module cache by <RolesProvider> at runtime — still resolved
 * synchronously, just from data. No async resolveRole (would flicker / break
 * hydration). Custom roles carry a lucide `iconName`, drawn with its component
 * once the icon set has loaded, and an `iconSvg` captured at pick time, kept
 * to plain shapes and used as the fallback and by the D3 canvas.
 */

export type RoleKey =
  | 'coder'
  | 'reviewer'
  | 'merger'
  | 'librarian'
  | 'ops'
  | 'research'
  | 'orchestrator';

export type RoleVisual = {
  key: string;
  label: string;
  color: string;
  /** React component: built-ins, and custom roles whose lucide `iconName`
   *  is known once the icon set has loaded. */
  icon?: LucideIcon;
  /** Inner SVG (24×24, stroke-based). Built-ins + custom. Used by the canvas,
   *  and by custom-role badges whose icon name is not a known lucide icon. */
  iconSvg?: string;
};

const BUILTIN: Record<RoleKey, { label: string; color: string; icon: LucideIcon }> = {
  coder:        { label: 'coder',        color: '#3b82f6', icon: Code2 },
  reviewer:     { label: 'reviewer',     color: '#8b5cf6', icon: ScanSearch },
  merger:       { label: 'merger',       color: '#10b981', icon: GitMerge },
  librarian:    { label: 'librarian',    color: '#ec4899', icon: BookOpen },
  ops:          { label: 'ops',          color: '#f97316', icon: Wrench },
  research:     { label: 'research',     color: '#06b6d4', icon: Telescope },
  orchestrator: { label: 'orch',         color: '#64748b', icon: ChefHat },
};

/** Inner SVG markup of each built-in icon (lucide-react v0.460), verbatim. */
const BUILTIN_SVG: Record<RoleKey, string> = {
  coder: '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
  reviewer:
    '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/>',
  merger:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  librarian:
    '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  ops:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  research:
    '<path d="m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44"/><path d="m13.56 11.747 4.332-.924"/><path d="m16 21-3.105-6.21"/><path d="M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z"/><path d="m6.158 8.633 1.114 4.456"/><path d="m8 21 3.105-6.21"/><circle cx="12" cy="13" r="2"/>',
  orchestrator:
    '<path d="M17 21a1 1 0 0 0 1-1v-5.35c0-.457.316-.844.727-1.041a4 4 0 0 0-2.134-7.589 5 5 0 0 0-9.186 0 4 4 0 0 0-2.134 7.588c.411.198.727.585.727 1.041V20a1 1 0 0 0 1 1Z"/><path d="M6 17h12"/>',
};

/** Aliases → canonical built-in key: role ids, task types, agent-name suffix. */
const ALIAS: Record<string, RoleKey> = {
  coder: 'coder', reviewer: 'reviewer', merger: 'merger', librarian: 'librarian',
  ops: 'ops', research: 'research', orchestrator: 'orchestrator',
  code: 'coder', review: 'reviewer', merge: 'merger', doc: 'librarian', chore: 'ops',
  main: 'orchestrator',
};

/* ── Role icon markup: the daemon's closed grammar, enforced again here ── */

/**
 * A custom role's icon arrives as markup from the daemon, which already
 * refuses anything but plain shapes (`roleIconSvgProblem` in
 * `orchestrator/src/agent-roles.ts`). The client does not take that on trust:
 * it parses the same grammar into a tree and draws the tree with React or
 * `createElementNS`, so no string from the server ever reaches the DOM as
 * HTML. A pure parser rather than `DOMParser`: it runs during server rendering
 * and in tests, and leaves no gap between what is checked and what is drawn.
 */
export const ROLE_SVG_MAX_LENGTH = 4096;
export type RoleSvgTag = 'path' | 'circle' | 'rect' | 'line' | 'polyline' | 'polygon' | 'ellipse' | 'g';
export type RoleSvgNode = { tag: RoleSvgTag; attrs: Record<string, string>; children: RoleSvgNode[] };

const SVG_TAGS: ReadonlySet<string> = new Set<RoleSvgTag>(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'g']);
const SVG_ATTRS: ReadonlySet<string> = new Set([
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'width', 'height', 'points', 'transform',
]);
const SVG_VALUE_RE = /^[0-9a-zA-Z .,\-#()]*$/;
const SVG_OPEN_RE = /^<([a-zA-Z][a-zA-Z0-9:_-]*)((?:\s+[^\s=/>]+\s*=\s*"[^"]*")*)\s*(\/?)>/;
const SVG_CLOSE_RE = /^<\/([a-zA-Z][a-zA-Z0-9:_-]*)\s*>/;
const SVG_ATTR_RE = /\s+([^\s=/>]+)\s*=\s*"([^"]*)"/g;
const SVG_MAX_DEPTH = 8;

function isRoleSvgTag(tag: string): tag is RoleSvgTag {
  return SVG_TAGS.has(tag);
}

/**
 * The shapes of a role icon, or null when the markup leaves the grammar.
 * `dropOtherAttributes` is for markup this page rendered itself (the icon
 * picker): an attribute outside the list is left out instead of failing, so
 * the daemon receives geometry only. Elements and values stay strict.
 */
export function parseRoleSvg(raw: unknown, { dropOtherAttributes = false } = {}): RoleSvgNode[] | null {
  if (typeof raw !== 'string' || raw.length > ROLE_SVG_MAX_LENGTH) return null;
  const root: RoleSvgNode[] = [];
  const stack: RoleSvgNode[] = [];
  let rest = raw;
  while (rest.length > 0) {
    const lt = rest.indexOf('<');
    const text = lt < 0 ? rest : rest.slice(0, lt);
    if (text.trim() !== '') return null;
    if (lt < 0) break;
    rest = rest.slice(lt);
    const close = SVG_CLOSE_RE.exec(rest);
    if (close) {
      if (stack.pop()?.tag !== close[1]) return null;
      rest = rest.slice(close[0].length);
      continue;
    }
    const open = SVG_OPEN_RE.exec(rest);
    if (!open) return null;
    const tag = open[1] ?? '';
    if (!isRoleSvgTag(tag)) return null;
    const attrs: Record<string, string> = {};
    for (const attr of (open[2] ?? '').matchAll(SVG_ATTR_RE)) {
      const name = attr[1] ?? '';
      const value = attr[2] ?? '';
      if (!SVG_ATTRS.has(name)) {
        if (dropOtherAttributes) continue;
        return null;
      }
      if (Object.hasOwn(attrs, name) || !SVG_VALUE_RE.test(value)) return null;
      attrs[name] = value;
    }
    const parent = stack[stack.length - 1];
    if (parent && parent.tag !== 'g') return null;
    const node: RoleSvgNode = { tag, attrs, children: [] };
    (parent ? parent.children : root).push(node);
    if (open[3] !== '/') {
      if (stack.length >= SVG_MAX_DEPTH) return null;
      stack.push(node);
    }
    rest = rest.slice(open[0].length);
  }
  return stack.length === 0 ? root : null;
}

function serializeRoleSvg(nodes: RoleSvgNode[]): string {
  return nodes.map((n) => {
    // Values are limited to a charset without quotes or brackets: no escaping needed.
    const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
    return n.children.length ? `<${n.tag}${attrs}>${serializeRoleSvg(n.children)}</${n.tag}>` : `<${n.tag}${attrs}/>`;
  }).join('');
}

/** The role icon rebuilt from its parsed shapes, or '' when it leaves the grammar. */
export function sanitizeRoleSvg(raw: unknown): string {
  const nodes = parseRoleSvg(raw);
  return nodes ? serializeRoleSvg(nodes) : '';
}

/** The picker's rendered icon reduced to the geometry the daemon accepts. */
export function roleSvgFromRenderedIcon(markup: string): string {
  const nodes = parseRoleSvg(markup, { dropOtherAttributes: true });
  return nodes ? serializeRoleSvg(nodes) : '';
}

/* ── Lucide icons by name, for custom roles ── */

export type LucideIconSet = Readonly<Record<string, LucideIcon>>;

/**
 * The whole lucide set, fetched on demand. A static `import { icons }` defeats
 * the per-icon import Next applies to lucide-react and puts all ~1 500 icons
 * (1.4 MB of source) in the root layout (docs/BUNDLE-SIZE.md).
 */
let lucideSet: LucideIconSet | null = null;
let lucideSetLoad: Promise<LucideIconSet> | null = null;
export function loadLucideIconSet(): Promise<LucideIconSet> {
  lucideSetLoad ??= import('lucide-react').then((m) => {
    lucideSet = m.icons as LucideIconSet;
    return lucideSet;
  });
  return lucideSetLoad;
}

/** The lucide component named `name`, once the set has loaded. */
export function lucideIconByName(name: string | null | undefined, set: LucideIconSet | null = lucideSet): LucideIcon | undefined {
  return name && set && Object.hasOwn(set, name) ? set[name] : undefined;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Draws a role icon under `parent` (the D3 canvas) without going through HTML. */
export function appendRoleSvg(parent: Element, raw: string): void {
  const build = (nodes: RoleSvgNode[], into: Element) => {
    for (const n of nodes) {
      const el = into.ownerDocument.createElementNS(SVG_NS, n.tag);
      for (const [k, v] of Object.entries(n.attrs)) el.setAttribute(k, v);
      build(n.children, el);
      into.appendChild(el);
    }
  };
  build(parseRoleSvg(raw) ?? [], parent);
}

/** Custom roles hydrated at runtime by <RolesProvider> (keyed by lowercased id). */
const customCache = new Map<string, RoleVisual>();

/**
 * Populate the custom-role cache from GET /api/agent-roles (custom entries
 * only). A known lucide `iconName` gives the role its real component; the
 * stored markup is only a fallback, kept to the shape grammar.
 */
export function hydrateCustomRoles(
  roles: Array<{ id: string; label: string; color: string; iconName?: string; iconSvg?: string }>,
  icons: LucideIconSet | null = lucideSet,
): void {
  for (const r of roles) {
    customCache.set(r.id.toLowerCase(), {
      key: r.id,
      label: r.label,
      color: r.color,
      icon: lucideIconByName(r.iconName, icons),
      iconSvg: sanitizeRoleSvg(r.iconSvg),
    });
  }
}

/** Resolve a role id, task type, or agent-name suffix to its visual (sync). */
export function resolveRole(key: string | null | undefined): RoleVisual | null {
  if (!key) return null;
  const lc = key.toLowerCase();
  const canonical = ALIAS[lc];
  if (canonical) {
    const v = BUILTIN[canonical];
    return { key: canonical, label: v.label, color: v.color, icon: v.icon, iconSvg: BUILTIN_SVG[canonical] };
  }
  return customCache.get(lc) ?? null;
}

/**
 * THE SINGLE RULE for resolving an agent's role, so the same agent wears the
 * same icon everywhere (missions rail, chat header, canvas, editing).
 *
 * Only the config's role counts — it is the field the user edits and the
 * dispatcher reads. The name's suffix used to be a fallback: it forced a
 * reviewer to be called `<project>.reviewer`, and made two readings diverge
 * (the rail read the config, the header read the name, and one agent showed
 * `orch` on one side and `coder` on the other). Historical agents without a
 * role were stamped one last time on the daemon side
 * (`agent-role-backfill.ts`); the name is now only a label.
 */
export function agentRoleKey(role: string | null | undefined): string | null {
  return role && resolveRole(role) ? role : null;
}

/** Inner SVG of the role icon for a role id / task type / suffix, or ''. */
export function roleIconSvg(key: string | null | undefined): string {
  return resolveRole(key)?.iconSvg ?? '';
}
