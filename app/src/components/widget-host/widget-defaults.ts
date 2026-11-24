import { MAIN_AGENT_WIDGET_ID } from '@/lib/main-agent-card';
import { ADD_WIDGET_IDS } from './add-widget';
import { mergeLayout, inheritedPlacement, inheritedSource, type WidgetConstraints, type WidgetLayout } from './widget-layout';

/**
 * What a view looks like before anyone has touched it.
 *
 * A starter is a full placement and not just a rail: the shipped cockpit and
 * the shipped chat are an arrangement that was built by hand, then captured
 * (frameless cards, stacked tabs, shares of the free height). Reducing it to
 * `[rail, rank, height]` would have lost exactly what makes it look composed.
 *
 * Only VISIBLE cards belong here. Absence IS removal below, so a starter
 * table that listed every widget would put back on screen the ones the
 * arrangement deliberately leaves in the palette.
 *
 * Starters sharing a `group` open as one stack of tabs, the one marked
 * `activeTab` in front. The group also names the stack for the views stored
 * before one of its widgets existed: that widget joins the stack wherever
 * the person moved it (`joinedStarterStack`).
 */
type Starter = Omit<WidgetLayout, 'id' | 'removed'>;

const [ADD_WIDGET, ADD_WIDGET_2] = ADD_WIDGET_IDS as [string, string];

/**
 * The "Git" stack: one card, one tab per widget, Branches in front. Each
 * widget stays its plugin's own (`@timon/git`, `@timon/kanban`, and Issues,
 * the browser half of the built-in `github-issues` plugin, which any plugin's
 * widget could be): the stack is an arrangement, not a merge, and any of them
 * can be moved out or removed like any widget. A widget added to this list
 * later joins the stack as its last tab on the views stored before it
 * (`joinedStarterStack`); one whose plugin is off simply never registers.
 */
const GIT_STACK = [
  'plugin:@timon/git:branches',
  'plugin:@timon/git:graph',
  'plugin:@timon/git:publish',
  'plugin:@timon/kanban:pull-requests',
  'plugin:@timon/kanban:landings',
  'plugin:github-issues:issues',
] as const;

function gitStack(rail: string, from: number): Record<string, Starter> {
  return Object.fromEntries(GIT_STACK.map((id, i) => [id, {
    rail, rang: from + i, hauteur: 320, heightMode: 'fill', fillPercent: 66, group: 'stack:git', ...(i === 0 ? { activeTab: true } : {}),
  } satisfies Starter]));
}

/**
 * A fresh install's arrangements, kept short on purpose (the maintainer's request of
 * 05/11/2026): a few cards that say what each view is for, and a dashed
 * "Your widget here" (`add-widget.ts`) where the person's own will go.
 */
const STARTERS: Record<string, Record<string, Starter>> = {
  '/': {
    'plugin:@timon/agents:notifications': { rail: 'gauche', rang: 0, hauteur: 520, heightMode: 'fill', fillPercent: 66, borderless: true, transparent: true },
    [ADD_WIDGET]: { rail: 'gauche', rang: 1, hauteur: 160, heightMode: 'fill', fillPercent: 34 },
    [MAIN_AGENT_WIDGET_ID]: { rail: 'centre', rang: 0, hauteur: 520, heightMode: 'fill', borderless: true, transparent: true },
    'plugin:@timon/kanban:todo': { rail: 'droite', rang: 0, hauteur: 320, heightMode: 'fill', fillPercent: 50, borderless: true, transparent: true },
    'plugin:@timon/agents:tasks': { rail: 'droite', rang: 1, hauteur: 400, heightMode: 'fill', fillPercent: 50, borderless: true, transparent: true },
  },
  // The agents canvas starts bare: one "Your widget here" at the foot of
  // each column, at its own height (`widget-zone.tsx`, `docked`).
  '/agents': {
    [ADD_WIDGET]: { rail: 'agents.left.widget', rang: 0, hauteur: 160 },
    [ADD_WIDGET_2]: { rail: 'agents.right.widget', rang: 0, hauteur: 160 },
  },
  // A project's chat: its missions and files on the left; on the right, the
  // "Git" stack and the containers. A card whose module is off on this
  // install simply never registers, and the column shares its height among
  // the rest; a stack left with one widget shows it as a lone card.
  '/chat': {
    'plugin:@timon/missions:Missions': { rail: 'chat.left.widget', rang: 0, hauteur: 300, heightMode: 'fill', fillPercent: 50 },
    'plugin:@timon/files-widget:Files': { rail: 'chat.left.widget', rang: 1, hauteur: 300, heightMode: 'fill', fillPercent: 50 },
    ...gitStack('chat.right.widget', 0),
    'plugin:@timon/docker-supervision:docker': { rail: 'chat.right.widget', rang: GIT_STACK.length, hauteur: 260, heightMode: 'fill', fillPercent: 34 },
  },
};

/**
 * What a view shows, given what is known of its stored placement.
 *
 * `known` is the whole point: `raw === null` says "nothing stored" AND "not
 * read yet", and the two call for opposite paintings. Serving the STARTERS
 * before the scope has answered shows an arrangement that belongs to nobody
 * — factory cards, at factory heights — and replaces it a second later with
 * the user's own. An empty board for the length of one read is the honest
 * state: nothing is known, so nothing is claimed.
 */
export function workspaceWidgets(
  raw: unknown,
  known: boolean,
  constraints: readonly WidgetConstraints[],
  view: string,
  chatZonesMounted = false,
): WidgetLayout[] {
  return known ? mergeWorkspaceWidgets(raw, constraints, view, chatZonesMounted) : [];
}

const CHAT_VIEW = '/chat';
const CHAT_ZONES = ['chat.left.widget', 'chat.right.widget'];

/** A chat column, or one of its tabs (`<column>#<suffix>`, `chat-columns.ts`). */
export function isChatZone(zone: unknown): boolean {
  return typeof zone === 'string' && CHAT_ZONES.some((z) => zone === z || zone.startsWith(`${z}#`));
}

/**
 * Where the chat's cards start on a view that is not `/chat`, once a chat is
 * open there (ISLAND-WORKSPACE.md §7, Q14): the places of `/chat`, then the
 * view's own. Nothing is borrowed from `/chat`'s row — the host keeps one
 * source of layout — and only while a chat zone is mounted, or the first
 * gesture on a view without a chat would write chat places into its row.
 */
function chatStartersFor(view: string, chatZonesMounted: boolean): Record<string, Starter> {
  return chatZonesMounted && view !== CHAT_VIEW ? STARTERS[CHAT_VIEW] ?? {} : {};
}

/**
 * A stored card the chat's places apply to: taken out without ever having
 * been in a chat column of this view — the default of a card the view did not
 * place. One the user removed FROM a chat column keeps that column as its
 * rail, and stays out.
 */
function reseedFromChat(item: unknown, chatStarters: Record<string, Starter>): unknown {
  if (typeof item !== 'object' || item === null) return item;
  const entry = item as Partial<WidgetLayout>;
  const starter = typeof entry.id === 'string' ? chatStarters[entry.id] : undefined;
  if (!starter || entry.removed !== true || isChatZone(entry.rail)) return item;
  const { removed: _removed, ...rest } = entry;
  return { ...rest, ...starter };
}

/**
 * The places handed down by former ids (`formerIds`), one per heir.
 *
 * A card split into several widgets hands its place to each of them: they
 * open as ONE stack where the card stood, at its height, rather than as cards
 * piled on the same rank. The stack is the card's own when it was a tab of
 * one (its siblings keep it), else the group the starters give the heirs,
 * else a group named after the card. Only one heir is in front: the first,
 * or none when the card was a background tab of its stack.
 */
function inheritedPlaces(
  raw: unknown,
  fresh: readonly WidgetLayout[],
  byId: ReadonlyMap<string, WidgetConstraints>,
  templates: Readonly<Record<string, Starter>>,
): Map<string, WidgetLayout> {
  const bySource = new Map<string, WidgetLayout[]>();
  for (const widget of fresh) {
    const hit = inheritedSource(raw, byId.get(widget.id)?.formerIds ?? [], widget.id);
    if (!hit) continue;
    const heirs = bySource.get(hit.from) ?? [];
    heirs.push(hit.entry);
    bySource.set(hit.from, heirs);
  }
  const places = new Map<string, WidgetLayout>();
  for (const [from, heirs] of bySource) {
    if (heirs.length === 1) { places.set(heirs[0]!.id, heirs[0]!); continue; }
    const order = (w: WidgetLayout) => templates[w.id]?.rang ?? Number.MAX_SAFE_INTEGER;
    heirs.sort((a, b) => order(a) - order(b));
    const source = heirs[0]!;
    const group = source.group ?? templates[source.id]?.group ?? `stack:${encodeURIComponent(from)}:1`;
    const front = source.group ? source.activeTab === true : true;
    heirs.forEach((heir, i) => {
      const { activeTab: _activeTab, ...rest } = heir;
      places.set(heir.id, { ...rest, group, ...(i === 0 && front ? { activeTab: true } : {}) });
    });
  }
  return places;
}

/**
 * A widget the stored row never named, whose starter puts it in a stack that
 * the row already shows (a sibling placed in a stack): it joins that stack as
 * a background tab, at its end, wherever the person moved it. A sibling taken
 * out of every stack is the person's choice of a lone card, and makes no new
 * stack around it.
 */
function joinedStarterStack(
  widget: WidgetLayout,
  templates: Readonly<Record<string, Starter>>,
  placed: readonly WidgetLayout[],
): WidgetLayout | null {
  const group = templates[widget.id]?.group;
  if (!group) return null;
  const siblings = new Set(Object.entries(templates).filter(([id, s]) => id !== widget.id && s.group === group).map(([id]) => id));
  const anchor = placed.find((w) => siblings.has(w.id) && !w.removed && w.group);
  if (!anchor) return null;
  const members = placed.filter((w) => !w.removed && w.rail === anchor.rail && w.group === anchor.group);
  const last = Math.max(...members.map((w) => w.rang));
  return {
    ...widget,
    rail: anchor.rail,
    group: anchor.group,
    rang: last + 0.5,
    hauteur: anchor.hauteur,
    ...(anchor.heightMode ? { heightMode: anchor.heightMode } : {}),
    ...(anchor.fillPercent !== undefined ? { fillPercent: anchor.fillPercent } : {}),
  };
}

/**
 * Existing placements win. New registrations remain available in the palette,
 * except a widget `placedByDefault`: it was on screen before it was a widget
 * (the top bar's bell), so it lands in its zone on every view that has not
 * placed or removed it yet — stored layout or not, starter or not. A widget
 * renamed since takes over the place its former id had; several widgets split
 * out of one card take it over together, as a stack. A widget its starter
 * stacks with others joins that stack when the stored row already shows it.
 */
export function mergeWorkspaceWidgets(
  raw: unknown,
  constraints: readonly WidgetConstraints[],
  view: string,
  chatZonesMounted = false,
): WidgetLayout[] {
  const chatStarters = chatStartersFor(view, chatZonesMounted);
  if (Array.isArray(raw) && Object.keys(chatStarters).length > 0) raw = raw.map((item) => reseedFromChat(item, chatStarters));
  const existing = Array.isArray(raw);
  const known = new Set(existing ? (raw as unknown[]).map(item => (item as { id?: unknown } | null)?.id) : []);
  const starters = STARTERS[view] ?? {};
  const templates = { ...chatStarters, ...starters };
  const byId = new Map(constraints.map(c => [c.id, c]));
  const fresh = mergeLayout(null, constraints).filter(widget => !known.has(widget.id));
  const heirs = inheritedPlaces(raw, fresh, byId, templates);
  // What the row shows, before the newcomers: its own places, read back
  // through the registry, then the places just handed down.
  const shown = existing
    ? [...[...known].flatMap((id) => (typeof id === 'string' ? [inheritedPlacement(raw, [id], id)] : [])).filter((w): w is WidgetLayout => w !== null), ...heirs.values()]
    : [];
  const additions = fresh.map(widget => {
    const inherited = heirs.get(widget.id);
    if (inherited) return inherited;
    const joined = existing ? joinedStarterStack(widget, templates, shown) : null;
    if (joined) return joined;
    const initial = (!existing ? starters[widget.id] : undefined) ?? chatStarters[widget.id];
    const constraint = byId.get(widget.id);
    if (!initial) return constraint?.placedByDefault ? widget : { ...widget, removed: true };
    return { ...widget, ...initial, hauteur: Math.max(initial.hauteur, constraint?.minHeight ?? 0) };
  });
  return mergeLayout(existing ? [...(raw as unknown[]), ...additions] : additions, constraints);
}
