/**
 * What a bundled module IS, in the same vocabulary as a third-party
 * manifest (`kind`, `slots`, `route`, `declares`).
 *
 * A bundled module has no `timon` field — its identity used to be inferred
 * from an empty slot list, which is always `behavior`. That is why the
 * gallery painted thirty identical "behavior (plugs into nothing)" cards.
 * This table is the missing half of the contract: the catalog decides who
 * boots, this file says what each one is on screen.
 *
 * `kind` stays in PLUGIN_KINDS (`behavior` included). The gallery translates
 * `behavior` to "Backend" — a host-only module, not a missing surface.
 */
import { BRAND } from '../brand.js';
import type { PluginKind } from './manifest.js';

export type SlotMode = 'single' | 'list' | 'keyed';

export type BundledIdentity = {
  kind: PluginKind[];
  slots: readonly string[];
  route: string | null;
  declares: Record<string, SlotMode>;
};

/**
 * Graft slots into native settings groups. Mirrors
 * `app/src/lib/plugin-host/settings-slots.ts` — do not slugify a group name
 * (`LLM fallback` is `settings.llmfallback`, never `llm-fallback`).
 */
const SETTINGS_GRAFT_DECLARES: Record<string, SlotMode> = {
  'settings.missions': 'list',
  'settings.llmfallback': 'list',
  'settings.resources': 'list',
  'settings.reaper': 'list',
  'settings.worktrees': 'list',
  'settings.permissions': 'list',
  'settings.wake': 'list',
  'settings.memoryinjection': 'list',
  'settings.memorycapture': 'list',
  'settings.memorysynthesis': 'list',
  'settings.memorypromotion': 'list',
  'settings.digest': 'list',
  'settings.scoring': 'list',
  'settings.dreaming': 'list',
  'settings.terminal': 'list',
  'settings.misc': 'list',
  'settings.infra': 'list',
  'settings.backlog': 'list',
  'settings.voice': 'list',
  'settings.backup': 'list',
  'settings.agenttrash': 'list',
  'settings.notifications': 'list',
};

/**
 * Mirrors the app's `UI_LAYOUT_CHILD_SLOTS` (`app/src/lib/plugin-host/ui-layout.tsx`)
 * key for key; `bundled-identity.test.ts` reads that file and fails on drift.
 */
const LAYOUT_DECLARES: Record<string, SlotMode> = {
  page: 'keyed',
  'nav.item': 'list',
  // The foot of the nav (the Machines switcher, TODO #329).
  'nav.footer': 'list',
  'topbar.item': 'list',
  'cockpit.widget': 'list',
  'agents.view': 'keyed',
  'agents.left.widget': 'list',
  'agents.right.widget': 'list',
  // Agents/Bots action bar and onboarding's agent step (agent import, volet 7).
  'agents.toolbar': 'list',
  // Foot of the `/bots` rail and the menu of one agent (mirror of `UI_LAYOUT_CHILD_SLOTS`).
  'bots.rail.action': 'list',
  'agent.menu.item': 'list',
  'onboarding.agent': 'list',
  'chat.composer.action': 'list',
  'chat.message.action': 'list',
  'settings.section': 'keyed',
  'settings.connection.form': 'keyed',
  // Sections of the page of one provider (client API 16).
  'settings.provider.section': 'list',
  ...SETTINGS_GRAFT_DECLARES,
  'kanban.column': 'list',
  'kanban.todo.detail': 'list',
  'kanban.todo.badge': 'list',
  // Head of the MCP tab of Capabilities (the official connectors).
  'mcp.featured': 'list',
  // The built-in browser's chrome (TODO #461).
  'browser.toolbar': 'list',
  'browser.drawer': 'keyed',
  'browser.surface': 'list',
  'mission.card.action': 'list',
  'mission.card.badge': 'list',
  'sidebar.left.widget': 'list',
  'sidebar.right.widget': 'list',
  // The top bar's line of widgets (bell, quota ring). Mirrors the app's
  // `UI_LAYOUT_CHILD_SLOTS`; admission there also asks for a flat form.
  'topbar.widget': 'list',
  overlay: 'list',
  'island.content': 'list',
  // Speech-to-text engines, keyed by engine (`kind: dictation`, API 14, TODO #484).
  // Declared at boot: an engine registers long before anyone dictates.
  'dictation.engine': 'keyed',
};

const FALLBACK: BundledIdentity = {
  kind: ['behavior'],
  slots: [],
  route: null,
  declares: {},
};

function identity(
  kind: PluginKind | readonly PluginKind[],
  extra: Partial<Omit<BundledIdentity, 'kind'>> = {},
): BundledIdentity {
  return {
    kind: Array.isArray(kind) ? [...kind] : [kind],
    slots: extra.slots ?? [],
    route: extra.route ?? null,
    declares: extra.declares ?? {},
  };
}

const page = (route: string, slots: readonly string[] = ['nav.item']): BundledIdentity =>
  identity('page', { route, slots });

const widget = (slots: readonly string[] = ['cockpit.widget']): BundledIdentity =>
  identity('widget', { slots });

/**
 * One entry per catalogue id. A test locks the two lists together so a new
 * module cannot ship as a nameless `behavior` by omission.
 */
export const BUNDLED_IDENTITY: Readonly<Record<string, BundledIdentity>> = Object.freeze({
  '@timon/db': identity('behavior'),
  // Also the default occupant of the folder browser, the confirmation dialog and the notice card,
  // and the source of the product's own notices (`notices`).
  '@timon/settings': page('/settings', ['nav.item', 'settings.resources', 'directory.picker', 'confirm.dialog', 'notices', 'notices.card']),
  '@timon/http': page('/dashboard'),
  '@timon/users': identity('behavior'),
  '@timon/plugins': page('/plugins'),
  '@timon/secrets-vault': page('/secrets', ['nav.item', 'chat.secret']),
  // The layout also paints the cockpit clock.
  '@timon/ui-layout': identity(['layout', 'widget'], { slots: ['root', 'cockpit.widget'], declares: LAYOUT_DECLARES }),
  '@timon/ui-theme': identity('theme', { slots: ['theme', 'settings.section'] }),
  '@timon/backends': identity('behavior', { slots: ['settings.section', 'settings.provider.section', 'model.picker', 'providers.cli', 'providers.row'] }),
  // No chat card left: Files, Skills and MCP are `@timon/files-widget`,
  // `@timon/skills-widget` and `@timon/mcp-widget` (TODO #356, #357), which
  // still read the routes served here.
  '@timon/agents': identity(['page', 'widget'], {
    route: '/agents',
    // `agent.mascot`: the meerkat, default occupant of the boot slot.
    // `agent.lookstyler`: its configurator, same footing.
    slots: ['nav.item', 'cockpit.widget', 'settings.agenttrash', 'agent.mascot', 'agent.lookstyler'],
  }),
  '@timon/company': page('/company', ['page', 'agents.view']),
  '@timon/agents-projects': page('/agents?view=projects', ['agents.view']),
  // The view and its rail of bots, a card `/bots` shows in an island of its
  // own and that can be dropped on any view.
  '@timon/bots': identity(['page', 'widget'], { route: '/bots', slots: ['nav.item', 'page', 'cockpit.widget'] }),
  // The chat's Files card, its own plugin so that `widget:files-widget` opens
  // it and nothing else does (TODO #356). `-widget`: a plugin that is only the
  // card of a rail, not the system it shows (`docs/PLUGINS.md`).
  '@timon/files-widget': widget(['chat.left.widget']),
  // The chat's Skills and MCP cards, same reasoning (TODO #357).
  '@timon/skills-widget': widget(['chat.right.widget']),
  '@timon/mcp-widget': widget(['chat.right.widget']),
  // The official connectors: a section at the head of the MCP tab, and the
  // `apps.card` slot its cards are painted by. `/apps` is gone (it redirects).
  '@timon/mcp-apps': identity('behavior', { slots: ['mcp.featured', 'apps.card'] }),
  '@timon/missions': identity(['page', 'widget'], { route: '/missions', slots: ['nav.item', 'cockpit.widget', 'chat.media'] }),
  '@timon/projects': identity(['page', 'widget'], { route: '/projects', slots: ['nav.item', 'cockpit.widget'] }),
  // The bell (top bar) and the same list as a movable card.
  '@timon/notifications': identity(['page', 'widget'], { route: '/notifications', slots: ['cockpit.widget'] }),
  '@timon/web-push': identity('behavior'),
  '@timon/memory': page('/memory'),
  // The "TO DO" column has been its own since volet 2/4: it occupies the
  // `kanban.column` socket it declares, as any plugin would. Volet
  // 4/4 adds the two tiles of the notebook — hence `widget` as a second
  // `kind`, and `cockpit.widget` among its sockets.
  '@timon/kanban': identity(['page', 'widget'], {
    route: '/kanban',
    slots: ['nav.item', 'kanban.column', 'cockpit.widget', 'task.form', 'kanban.card', 'todo.form', 'kanban.todo.landing', 'kanban.job.dialog', 'forge.publish.dialog', 'project.settings'],
  }),
  // Occupies the TO DO detail of the Kanban with the outcome block, nothing else.
  '@timon/todo-outcomes': identity('behavior', { slots: ['kanban.todo.detail'] }),
  // Worktrees, review and merge of code tasks: no surface left. Its `/git`
  // page is gone (c69d708b), its Git cards moved to `@timon/git` (TODO #275)
  // and its Files card to `@timon/files-widget` (TODO #311, #356).
  '@timon/kanban-code': identity('behavior'),
  // Git status and Git remote cards of the chat rails (TODO #275).
  '@timon/git': widget(['chat.left.widget', 'chat.right.widget']),
  // The Triggers page (TODO #216) is the former Routines page, renamed:
  // `/routines` stays a route (it redirects there), so a grant written for it
  // still names something, and the routines half stands in for the page when
  // `@timon/triggers` is off.
  '@timon/triggers': page('/triggers'),
  '@timon/routines': page('/routines'),
  '@timon/workflows': identity(['widget', 'page'], { route: '/workflows', slots: ['nav.item', 'cockpit.widget'] }),
  '@timon/dreams': identity(['widget', 'page'], { slots: ['nav.item', 'cockpit.widget'], route: '/dreams' }),
  '@timon/agent-chat': widget(),
  '@timon/resources-guard': identity('behavior'),
  '@timon/vault': identity(['widget', 'page'], { slots: ['nav.item', 'cockpit.widget'], route: '/brain' }),
  '@timon/grepai': widget(['chat.right.widget']),
  '@timon/docker-supervision': widget(['chat.right.widget']),
  '@timon/browser-embedded': identity('behavior'),
  // The record button and its pill in the browser's address bar, the review drawer over the page.
  '@timon/browser-recording': identity('behavior', { slots: ['browser.toolbar', 'browser.drawer'] }),
  // The ✎ button and its pill, the annotation drawer, and the layer that points and highlights on the PWA's picture.
  '@timon/browser-annotations': identity('behavior', { slots: ['browser.toolbar', 'browser.drawer', 'browser.surface'] }),
  '@timon/terminal-native': identity('behavior'),
  '@timon/terminal-web': identity('behavior'),
  // The chat card arrives with volet 3 of MCPUI: until then, routes and the ui_render tool only.
  '@timon/ui-documents': identity('behavior', { slots: ['chat.document'] }),
  '@timon/orchestrator-self': widget(['chat.right.widget']),
  '@timon/web-app': identity('behavior'),
  '@timon/telegram': identity('behavior'),
  '@timon/tts': identity('behavior'),
  '@timon/gpt-live': identity('behavior'),
  '@timon/video-factory': widget(['chat.right.widget']),
  // Its client half is a source of `notices`: a newer version and the end of this build, as one card;
  // and the default occupant of `updates.dialog`, the update window that card opens.
  '@timon/updates': identity('behavior', { slots: ['notices', 'updates.dialog'] }),
  // Its client half paints the Privacy pane of the settings.
  '@timon/telemetry': identity('behavior', { slots: ['settings.section'] }),
  // Host half only for now: the settings page and the switcher come with its client half (P3d).
  '@timon/machines': identity('behavior'),
});

export function bundledIdentity(id: string): BundledIdentity {
  return BUNDLED_IDENTITY[id] ?? FALLBACK;
}

/** Publisher shown on every bundled card. Third-party plugins carry their own. */
export const BUNDLED_AUTHOR = BRAND.displayName;
