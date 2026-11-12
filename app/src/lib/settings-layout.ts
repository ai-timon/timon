/**
 * Layout of the Settings dialog: 9 categories, each split into horizontal
 * tabs. The daemon groups (`Memory — injection`, `Infra`…) are storage
 * buckets, too fine and too mixed to be shown as-is; this table files each
 * row, graft slot and plugin pane into a (category, tab) pair.
 *
 * Placement of a native row, first match wins:
 *   1. its key (`KEY_PLACEMENT`) — e.g. the Obsidian vault out of `Misc`;
 *   2. its owner plugin when that plugin has a home (`OWNER_PLACEMENT`);
 *   3. any other owner → its own tab under Plugins;
 *   4. its group (`GROUP_PLACEMENT`);
 *   5. System › Diagnostics, so a group added tomorrow never vanishes.
 *
 * Group names and graft slots are untouched: `settings.<group>` stays the
 * contract plugins graft into.
 */
import type { SettingsPluginOrigin } from './settings-plugin-categories';

export type SettingsCategoryId =
  | 'instructions'
  | 'interface'
  | 'models'
  | 'missions'
  | 'resources'
  | 'memory'
  | 'network'
  | 'system'
  | 'secrets'
  | 'plugins';

export const SETTINGS_CATEGORY_IDS: readonly SettingsCategoryId[] = [
  'interface', 'models', 'instructions', 'missions', 'resources', 'memory', 'network', 'system', 'secrets', 'plugins',
];

/** Device-local panes: no row in the settings table. */
export type NativePaneId = 'language' | 'push' | 'voice' | 'webui' | 'desktop' | 'installation' | 'instructions' | 'preamble' | 'fallback' | 'secrets' | 'connections' | 'accounts' | 'devices' | 'developer';

type Placement = { category: SettingsCategoryId; tab: string };

type StaticTab =
  | { id: string; kind: 'rows' }
  | { id: string; kind: 'native'; pane: NativePaneId }
  | { id: string; kind: 'plugin'; pluginId: string };

/** Static tabs, in display order. Plugin-owned tabs are appended at runtime. */
export const STATIC_TABS: Readonly<Record<SettingsCategoryId, readonly StaticTab[]>> = {
  instructions: [
    { id: 'preamble', kind: 'native', pane: 'preamble' },
    { id: 'global', kind: 'native', pane: 'instructions' },
  ],
  interface: [
    { id: 'appearance', kind: 'plugin', pluginId: '@timon/ui-theme' },
    { id: 'language', kind: 'native', pane: 'language' },
    { id: 'notifications', kind: 'native', pane: 'push' },
    { id: 'voice', kind: 'native', pane: 'voice' },
    { id: 'terminal', kind: 'rows' },
  ],
  models: [
    { id: 'backends', kind: 'plugin', pluginId: '@timon/backends' },
    // Per-account subscriptions (TODO #52): every signed-in user may own some.
    { id: 'accounts', kind: 'native', pane: 'accounts' },
    { id: 'fallback', kind: 'native', pane: 'fallback' },
    { id: 'breaker', kind: 'rows' },
    { id: 'quotas', kind: 'plugin', pluginId: 'quota-monitor' },
  ],
  missions: [
    { id: 'execution', kind: 'rows' },
    { id: 'permissions', kind: 'rows' },
    { id: 'cleanup', kind: 'rows' },
  ],
  resources: [
    { id: 'confinement', kind: 'rows' },
    { id: 'schedule', kind: 'rows' },
  ],
  memory: [
    { id: 'obsidian', kind: 'rows' },
    { id: 'injection', kind: 'rows' },
    { id: 'capture', kind: 'rows' },
    { id: 'synthesis', kind: 'rows' },
    { id: 'promotion', kind: 'rows' },
    { id: 'dreaming', kind: 'rows' },
    { id: 'scoring', kind: 'rows' },
  ],
  network: [
    { id: 'webui', kind: 'native', pane: 'webui' },
    // Devices paired with the signed-in account (multi-machine P2b): core, so
    // it exists on every daemon, with or without the Machines plugin.
    { id: 'devices', kind: 'native', pane: 'devices' },
    { id: 'urls', kind: 'rows' },
    { id: 'browser', kind: 'rows' },
  ],
  system: [
    // How Timon runs on the machine (TODO #333): superadmin only.
    { id: 'installation', kind: 'native', pane: 'installation' },
    // The safety net (TODO #476): nightly backup retention, and the agent
    // trash whose list the agents plugin grafts below the rows.
    { id: 'backup', kind: 'rows' },
    { id: 'diagnostics', kind: 'rows' },
    { id: 'desktop', kind: 'native', pane: 'desktop' },
    // Anonymous usage statistics: the telemetry module's own pane.
    { id: 'privacy', kind: 'plugin', pluginId: '@timon/telemetry' },
  ],
  secrets: [
    { id: 'vault', kind: 'native', pane: 'secrets' },
    // Per-account plugin connections: every signed-in user has some to manage.
    { id: 'connections', kind: 'native', pane: 'connections' },
  ],
  plugins: [
    // Developer mode, the door unsigned plugins go through: superadmin only,
    // like the installation itself.
    { id: 'developer', kind: 'native', pane: 'developer' },
  ],
};

const GROUP_PLACEMENT: Readonly<Record<string, Placement>> = {
  Missions: { category: 'missions', tab: 'execution' },
  Wake: { category: 'missions', tab: 'execution' },
  Permissions: { category: 'missions', tab: 'permissions' },
  Reaper: { category: 'missions', tab: 'cleanup' },
  Worktrees: { category: 'missions', tab: 'cleanup' },
  'LLM fallback': { category: 'models', tab: 'fallback' },
  Resources: { category: 'resources', tab: 'schedule' },
  'Memory — injection': { category: 'memory', tab: 'injection' },
  'Global digest': { category: 'memory', tab: 'injection' },
  'Memory — capture': { category: 'memory', tab: 'capture' },
  'Memory — synthesis': { category: 'memory', tab: 'synthesis' },
  'Memory — promotion': { category: 'memory', tab: 'promotion' },
  Dreaming: { category: 'memory', tab: 'dreaming' },
  Scoring: { category: 'memory', tab: 'scoring' },
  Terminal: { category: 'interface', tab: 'terminal' },
  Misc: { category: 'system', tab: 'diagnostics' },
  Infra: { category: 'system', tab: 'diagnostics' },
  Backup: { category: 'system', tab: 'backup' },
  'Agent trash': { category: 'system', tab: 'backup' },
};

const KEY_PLACEMENT: Readonly<Record<string, Placement>> = {
  TIMON_BRAIN_VAULT: { category: 'memory', tab: 'obsidian' },
  TIMON_VAULT_MCP_SERVER: { category: 'memory', tab: 'obsidian' },
  TIMON_PREAPPROVED_MCP_TOOLS: { category: 'missions', tab: 'permissions' },
  TIMON_RESOURCE_GUARD_ENABLED: { category: 'resources', tab: 'confinement' },
  TIMON_MISSION_MEM_MAX_GB: { category: 'resources', tab: 'confinement' },
  TIMON_RESOURCE_WATCH_MS: { category: 'resources', tab: 'confinement' },
  TIMON_ORCH_URL: { category: 'network', tab: 'urls' },
  TIMON_PUBLIC_API_URL: { category: 'network', tab: 'urls' },
  TIMON_PUBLIC_APP_URL: { category: 'network', tab: 'urls' },
  TIMON_TRAEFIK_HOST: { category: 'network', tab: 'urls' },
  TIMON_ALLOW_HTTP: { category: 'network', tab: 'urls' },
  // Painted by the Voice pane itself (GptLiveSettings), next to its key.
  TIMON_GPT_LIVE_ENABLED: { category: 'interface', tab: 'voice' },
  // Owned by routines / agents (hidden with them) but filed with the safety
  // net rather than under Plugins, where an owner would send them.
  TIMON_BACKUP_KEEP: { category: 'system', tab: 'backup' },
  TIMON_BACKUP_MAX_AGE_DAYS: { category: 'system', tab: 'backup' },
  TIMON_AGENT_TRASH_ENABLED: { category: 'system', tab: 'backup' },
  TIMON_AGENT_TRASH_RETENTION_DAYS: { category: 'system', tab: 'backup' },
};

/** Bundled plugins whose settings belong to a functional category. */
const OWNER_PLACEMENT: Readonly<Record<string, Placement>> = {
  '@timon/browser-embedded': { category: 'network', tab: 'browser' },
  '@timon/browser-recording': { category: 'network', tab: 'browser' },
  '@timon/browser-annotations': { category: 'network', tab: 'browser' },
  '@timon/web-push': { category: 'network', tab: 'urls' },
  '@timon/terminal-native': { category: 'interface', tab: 'terminal' },
  '@timon/dreams': { category: 'memory', tab: 'dreaming' },
};

/** Graft slot of each native group → the tab that paints it. */
const GRAFT_PLACEMENT: Readonly<Record<string, Placement>> = {
  ...GROUP_PLACEMENT,
  Resources: { category: 'resources', tab: 'confinement' },
  Push: { category: 'interface', tab: 'notifications' },
  // `settings.voice` was declared without a tab to paint it: a graft there never showed.
  Voice: { category: 'interface', tab: 'voice' },
};

/** `LLM fallback` holds two features: the quota switch and the breaker. The
 *  replays of a dropped turn (TODO #459) sit with the breaker: the native
 *  fallback pane paints no generic row, and both decide what a failing
 *  backend gets next. */
function splitFallback(key: string): Placement | null {
  return key.startsWith('TIMON_BREAKER_') || key.startsWith('TIMON_TURN_RETR')
    ? { category: 'models', tab: 'breaker' } : null;
}

export type SettingsRowLike = {
  key: string;
  group: string;
  advanced: boolean;
  owner?: string | null;
};

export function placeSetting(row: SettingsRowLike): Placement {
  const byKey = KEY_PLACEMENT[row.key];
  if (byKey) return byKey;
  if (row.owner) return OWNER_PLACEMENT[row.owner] ?? { category: 'plugins', tab: row.owner };
  if (row.group === 'LLM fallback') return splitFallback(row.key) ?? GROUP_PLACEMENT[row.group]!;
  return GROUP_PLACEMENT[row.group] ?? { category: 'system', tab: 'diagnostics' };
}

export type SettingsTab =
  | { id: string; kind: 'rows'; keys: string[]; grafts: string[]; ownerLabel?: string }
  | { id: string; kind: 'native'; pane: NativePaneId; grafts: string[] }
  | { id: string; kind: 'plugin'; pluginId: string; origin: SettingsPluginOrigin; label: string };

export type SettingsCategory = { id: SettingsCategoryId; tabs: SettingsTab[] };

export type SettingsPluginEntry = {
  id: string;
  origin: SettingsPluginOrigin;
  label: string;
};

export type SettingsLayoutInput = {
  rows: readonly SettingsRowLike[];
  /** False only under a preset that hides the `settings.advanced` zone. */
  includeAdvanced: boolean;
  /** Plugin id → state, from `/api/ui/plugins`. Unknown id = shown. */
  pluginStates: ReadonlyMap<string, string>;
  /** Plugin id → display label, for owner tabs under Plugins. */
  pluginLabels: ReadonlyMap<string, string>;
  /** Plugin panes (slot occupants + manifest-declared settings). */
  plugins: readonly SettingsPluginEntry[];
  /** Graft groups with at least one occupant. */
  graftedGroups: ReadonlySet<string>;
  desktop: boolean;
  /** The secrets module is running and the viewer may open it. */
  secrets?: boolean;
  /** The viewer is the superadmin: the machine's installation is theirs alone. */
  superadmin?: boolean;
};

function ownerActive(owner: string | null | undefined, states: ReadonlyMap<string, string>): boolean {
  if (!owner) return true;
  const state = states.get(owner);
  return state === undefined || state === 'active';
}

/** Whether a row is on screen at all: the search lists exactly what the tabs do. */
export function isRowListed(
  row: SettingsRowLike,
  input: Pick<SettingsLayoutInput, 'includeAdvanced' | 'pluginStates'>,
): boolean {
  if (row.advanced && !input.includeAdvanced) return false;
  return ownerActive(row.owner, input.pluginStates);
}

/**
 * Categories with their visible tabs. A category without any visible tab is
 * dropped, so Plugins disappears on an install with no plugin settings.
 */
export function buildSettingsLayout(input: SettingsLayoutInput): SettingsCategory[] {
  const rowsByTab = new Map<string, string[]>();
  for (const row of input.rows) {
    if (!isRowListed(row, input)) continue;
    const place = placeSetting(row);
    const tabKey = `${place.category}/${place.tab}`;
    rowsByTab.set(tabKey, [...(rowsByTab.get(tabKey) ?? []), row.key]);
  }

  const graftsByTab = new Map<string, string[]>();
  for (const [group, place] of Object.entries(GRAFT_PLACEMENT)) {
    const tabKey = `${place.category}/${place.tab}`;
    graftsByTab.set(tabKey, [...(graftsByTab.get(tabKey) ?? []), group]);
  }

  const pluginById = new Map(input.plugins.map((p) => [p.id, p]));
  const placedPlugins = new Set<string>();

  const categories: SettingsCategory[] = [];
  for (const id of SETTINGS_CATEGORY_IDS) {
    const tabs: SettingsTab[] = [];
    for (const tab of STATIC_TABS[id]) {
      const tabKey = `${id}/${tab.id}`;
      const grafts = graftsByTab.get(tabKey) ?? [];
      if (tab.kind === 'rows') {
        const keys = rowsByTab.get(tabKey) ?? [];
        // A graft alone can keep a tab alive: a plugin may extend a native
        // group whose own rows are all advanced.
        if (keys.length === 0 && !grafts.some((g) => input.graftedGroups.has(g))) continue;
        tabs.push({ id: tab.id, kind: 'rows', keys, grafts });
      } else if (tab.kind === 'native') {
        if (tab.pane === 'desktop' && !input.desktop) continue;
        if (tab.pane === 'secrets' && !input.secrets) continue;
        if ((tab.pane === 'installation' || tab.pane === 'developer') && !input.superadmin) continue;
        tabs.push({ id: tab.id, kind: 'native', pane: tab.pane, grafts });
      } else {
        const plugin = pluginById.get(tab.pluginId);
        if (!plugin) continue;
        placedPlugins.add(plugin.id);
        tabs.push({ id: tab.id, kind: 'plugin', pluginId: plugin.id, origin: plugin.origin, label: plugin.label });
      }
    }
    if (id === 'plugins') {
      for (const [tabKey, keys] of rowsByTab) {
        if (!tabKey.startsWith('plugins/')) continue;
        const owner = tabKey.slice('plugins/'.length);
        tabs.push({
          id: owner,
          kind: 'rows',
          keys,
          grafts: [],
          ownerLabel: input.pluginLabels.get(owner) ?? owner,
        });
      }
      for (const plugin of input.plugins) {
        // One tab per id: a bundled plugin with both owned rows and a pane
        // keeps its rows tab (rare, and the rows are the settings a user
        // came for).
        if (placedPlugins.has(plugin.id) || tabs.some((t) => t.id === plugin.id)) continue;
        tabs.push({ id: plugin.id, kind: 'plugin', pluginId: plugin.id, origin: plugin.origin, label: plugin.label });
      }
    }
    if (tabs.length > 0) categories.push({ id, tabs });
  }
  return categories;
}

export type SettingsTarget = { category: SettingsCategoryId; tab: string | null };

function isCategory(value: string): value is SettingsCategoryId {
  return (SETTINGS_CATEGORY_IDS as readonly string[]).includes(value);
}

/**
 * `?settings=<category>[/<tab>]`. A plugin tab id carries its own `/`
 * (`@scope/name`), so only the first `/` separates the two.
 */
export function parseSettingsParam(raw: string | null): SettingsTarget | null {
  if (raw === null) return null;
  const cut = raw.indexOf('/');
  const category = cut === -1 ? raw : raw.slice(0, cut);
  const tab = cut === -1 ? null : raw.slice(cut + 1) || null;
  if (!isCategory(category)) return { category: 'interface', tab: null };
  return { category, tab };
}

/**
 * The account's own views, filed under the same parameter (`?settings=profile`)
 * but outside the categories: they are about the signed-in user, not about the
 * product's preferences, so they have no tab, no row and no search entry.
 */
export type SettingsAccountView = 'profile' | 'license';

export function parseSettingsAccountView(raw: string | null): SettingsAccountView | null {
  return raw === 'profile' || raw === 'license' ? raw : null;
}

export function formatSettingsParam(target: SettingsTarget): string {
  return target.tab ? `${target.category}/${target.tab}` : target.category;
}

/** Selected category and tab, falling back to the first visible ones. */
export function resolveSettingsTarget(
  target: SettingsTarget,
  layout: readonly SettingsCategory[],
): { category: SettingsCategory; tab: SettingsTab } | null {
  const category = layout.find((c) => c.id === target.category) ?? layout[0];
  if (!category) return null;
  const tab = category.tabs.find((t) => t.id === target.tab) ?? category.tabs[0]!;
  return { category, tab };
}

/** Legacy `/settings?group=<slug>` slugs (graft slot suffixes, panes, plugin ids). */
const LEGACY_SLUGS: Readonly<Record<string, SettingsTarget>> = {
  notifications: { category: 'interface', tab: 'notifications' },
  voice: { category: 'interface', tab: 'voice' },
  webui: { category: 'network', tab: 'webui' },
  devices: { category: 'network', tab: 'devices' },
  desktop: { category: 'system', tab: 'desktop' },
  missions: { category: 'missions', tab: 'execution' },
  wake: { category: 'missions', tab: 'execution' },
  permissions: { category: 'missions', tab: 'permissions' },
  reaper: { category: 'missions', tab: 'cleanup' },
  worktrees: { category: 'missions', tab: 'cleanup' },
  llmfallback: { category: 'models', tab: 'fallback' },
  accounts: { category: 'models', tab: 'accounts' },
  resources: { category: 'resources', tab: 'confinement' },
  memoryinjection: { category: 'memory', tab: 'injection' },
  digest: { category: 'memory', tab: 'injection' },
  memorycapture: { category: 'memory', tab: 'capture' },
  memorysynthesis: { category: 'memory', tab: 'synthesis' },
  memorypromotion: { category: 'memory', tab: 'promotion' },
  dreaming: { category: 'memory', tab: 'dreaming' },
  scoring: { category: 'memory', tab: 'scoring' },
  terminal: { category: 'interface', tab: 'terminal' },
  misc: { category: 'memory', tab: 'obsidian' },
  infra: { category: 'system', tab: 'diagnostics' },
};

export function legacyGroupTarget(slug: string): SettingsTarget {
  const known = LEGACY_SLUGS[slug];
  if (known) return known;
  for (const [category, tabs] of Object.entries(STATIC_TABS) as [SettingsCategoryId, readonly StaticTab[]][]) {
    const tab = tabs.find((t) => t.kind === 'plugin' && t.pluginId === slug);
    if (tab) return { category, tab: tab.id };
  }
  return { category: 'plugins', tab: slug };
}
