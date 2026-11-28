/**
 * The accessibility tree, the first way an agent reads and drives a window: elements and actions,
 * with no pixel, no mouse and no keyboard. One backend per OS (`computer-use-a11y-<os>.ts`) reads
 * the native tree and acts on an element; what is the same everywhere lives here: the roles, the
 * ids, the query filter, the limits and the conversion of the bounds.
 *
 * Nothing here is spliced into a script. A backend runs through the injected executor (no shell,
 * its arguments travel as JSON), so nothing the agent sends can be interpreted as code.
 */
import { frameTransform, type DisplayInfo, type Frame } from './computer-use-geometry.js';
import type { Exec } from './computer-use-windows.js';

/** The roles every OS maps its own onto: anything else is `other`. */
export const A11Y_ROLES = [
  'button', 'textfield', 'textarea', 'checkbox', 'radio', 'combobox', 'list', 'listitem', 'menu', 'menuitem', 'menubar',
  'tab', 'tablist', 'link', 'image', 'text', 'group', 'window', 'toolbar', 'table', 'row', 'cell', 'slider', 'scrollbar', 'other',
] as const;
export type A11yRole = typeof A11Y_ROLES[number];

export const A11Y_ACTIONS = ['press', 'focus', 'set_value', 'select', 'expand', 'collapse', 'show_menu', 'scroll_into_view'] as const;
export type A11yAction = typeof A11Y_ACTIONS[number];

export const A11Y_DEFAULT_MAX_DEPTH = 15;
export const A11Y_MAX_DEPTH = 15;
export const A11Y_DEFAULT_MAX_NODES = 400;
export const A11Y_MAX_NODES = 1500;
export const A11Y_MAX_VALUE = 2000;
export const A11Y_MAX_QUERY = 200;
/** What an element keeps of its name and of its value in a tree: the rest only costs tokens. */
const TEXT_CAP = 200;

export type A11yCheck = 'ok' | 'missing' | 'unsupported';

/** Why a backend refused: the element is gone, or it cannot do that. */
export class A11yError extends Error {
  constructor(readonly kind: 'stale' | 'unsupported' | 'failed', message: string, readonly actions: readonly A11yAction[] = []) {
    super(message);
  }
}

/** A rectangle: screen points in a backend's answer, pixels of the last capture in the agent's. */
export interface A11yBounds { x: number; y: number; width: number; height: number }

/**
 * What a backend reads. `path` is the index path from the window element, dot-joined: the window
 * itself is "0", its second child "0.1", that child's first child "0.1.0". Parents come before
 * their children (pre-order). Bounds are in screen points, origin at the top left of the primary display.
 */
export interface A11yRawNode {
  path: string;
  role: string;
  name: string;
  value?: string;
  enabled: boolean;
  focused?: boolean;
  bounds?: A11yBounds;
  actions: string[];
}

export interface A11yRawTree { truncated: boolean; nodes: A11yRawNode[] }

export interface A11yTreeArgs {
  windowId: string;
  maxDepth: number;
  maxNodes: number;
  /** Already lower-cased. A backend may use it to read less; the service filters anyway. */
  query?: string;
}

export interface A11yActArgs {
  windowId: string;
  /** The element's index path, as in `A11yRawNode.path`. */
  path: string;
  action: A11yAction;
  value?: string;
  /** Accessibility only: no fallback may use the keyboard or move the focus (the agent works in the background). */
  background?: boolean;
}

export interface A11yBackend {
  probe(): Promise<A11yCheck>;
  tree(args: A11yTreeArgs): Promise<A11yRawTree>;
  /** Rejects with `A11yError('stale')` when the path leads nowhere, `A11yError('unsupported', …, possible)` when the element cannot do the action. */
  act(args: A11yActArgs): Promise<void>;
}

/** The tree as an agent reads it. */
export interface A11yNode {
  id: string;
  parent: string | null;
  depth: number;
  role: A11yRole;
  name: string;
  value?: string;
  enabled: boolean;
  focused?: boolean;
  bounds?: A11yBounds;
  actions: string[];
}

export interface A11yTree {
  window: { id: string; title: string; app: string };
  truncated: boolean;
  nodes: A11yNode[];
}

// ── Ids ────────────────────────────────────────────────────────────────────

const PATH = /^\d{1,4}(\.\d{1,4}){0,14}$/;
const WINDOW_ID = /^[A-Za-z0-9:_.-]{1,64}$/;

/** An element id: the window id, then `#`, then the index path. Opaque to the agent. */
export function elementId(windowId: string, path: string): string { return `${windowId}#${path}`; }

export function parseElementId(id: string): { windowId: string; path: string } | null {
  const at = id.indexOf('#');
  if (at < 0) return null;
  const windowId = id.slice(0, at);
  const path = id.slice(at + 1);
  return WINDOW_ID.test(windowId) && PATH.test(path) ? { windowId, path } : null;
}

// ── Reading ────────────────────────────────────────────────────────────────

const ROLE_SET: ReadonlySet<string> = new Set(A11Y_ROLES);
const normalizeRole = (role: string): A11yRole => {
  const lower = role.toLowerCase();
  return ROLE_SET.has(lower) ? lower as A11yRole : 'other';
};
const cap = (text: string): string => text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text;
const parentPath = (path: string): string | null => path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : null;

/**
 * Keeps the elements whose name, value or role contains `query` (case does not matter) and all
 * their ancestors, so a hit is still read in its place.
 */
export function filterByQuery(nodes: readonly A11yRawNode[], query: string | undefined): A11yRawNode[] {
  const wanted = query?.trim().toLowerCase();
  if (!wanted) return [...nodes];
  const keep = new Set<string>();
  for (const node of nodes) {
    if (![node.name, node.value ?? '', node.role].some((text) => text.toLowerCase().includes(wanted))) continue;
    for (let path: string | null = node.path; path !== null; path = parentPath(path)) keep.add(path);
  }
  return nodes.filter((node) => keep.has(node.path));
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Screen points → pixels of the last capture: the conversion the clicks use, the other way round. */
function toFrame(bounds: A11yBounds | undefined, display: DisplayInfo, frame: Frame): A11yBounds | undefined {
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(finite)) return undefined;
  const { x, y, sx, sy } = frameTransform(display, frame);
  return {
    x: Math.round((bounds.x - x) * sx), y: Math.round((bounds.y - y) * sy),
    width: Math.round(bounds.width * sx), height: Math.round(bounds.height * sy),
  };
}

/**
 * A backend's answer turned into the contract's: ids, parents and depths from the paths, roles from
 * the closed list, text capped, bounds in the frame of the last capture, limits enforced again.
 * A node whose parent was not read is dropped: an orphan has no place in the tree.
 */
export function buildTree(
  window: A11yTree['window'], raw: A11yRawTree, args: Pick<A11yTreeArgs, 'maxDepth' | 'maxNodes' | 'query'>,
  display: DisplayInfo, frame: Frame,
): A11yTree {
  let truncated = raw.truncated;
  const present = new Set<string>();
  const nodes: A11yNode[] = [];
  for (const node of filterByQuery(raw.nodes, args.query)) {
    if (!PATH.test(node.path)) continue;
    const parent = parentPath(node.path);
    const depth = node.path.split('.').length - 1;
    if (depth >= args.maxDepth) { truncated = true; continue; }
    if (parent !== null && !present.has(parent)) continue;
    if (nodes.length >= args.maxNodes) { truncated = true; break; }
    present.add(node.path);
    const out: A11yNode = {
      id: elementId(window.id, node.path), parent: parent === null ? null : elementId(window.id, parent), depth,
      role: normalizeRole(node.role), name: cap(node.name), enabled: node.enabled !== false,
      actions: node.actions.filter((action): action is A11yAction => (A11Y_ACTIONS as readonly string[]).includes(action)),
    };
    if (node.value !== undefined && node.value !== '') out.value = cap(node.value);
    if (node.focused) out.focused = true;
    const bounds = toFrame(node.bounds, display, frame);
    if (bounds) out.bounds = bounds;
    nodes.push(out);
  }
  return { window, truncated, nodes };
}

/** Whether an application is worth driving from the background: how rich its accessibility tree is. */
export type A11yVerdict = 'rich' | 'poor' | 'empty';
export const A11Y_PROBE_MAX_NODES = 200;
/** Actionable elements needed to call a tree rich. */
export const A11Y_RICH_MIN_ACTIONABLE = 3;

/**
 * Judges a window's tree. `empty`: nothing but the window itself (games and canvas applications);
 * `rich`: at least three elements that accept an action; `poor`: something in between.
 */
export function probeVerdict(nodes: readonly Pick<A11yNode, 'actions' | 'depth'>[]): { nodes: number; actionable: number; verdict: A11yVerdict } {
  const actionable = nodes.filter((node) => node.depth > 0 && node.actions.length > 0).length;
  const verdict: A11yVerdict = nodes.length <= 1 ? 'empty' : actionable >= A11Y_RICH_MIN_ACTIONABLE ? 'rich' : 'poor';
  return { nodes: nodes.length, actionable, verdict };
}
