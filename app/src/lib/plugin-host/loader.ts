'use client';

import type { ComponentType } from 'react';
import { register, type IslandContentOptions, type SlotChildren, type WidgetOptions } from './slots';
import { isSlotAdmissible, slotAdmissionError } from './slot-compat';
import { fetchCapabilities } from '@/lib/capabilities';
import { sharedGet } from '@/lib/shared-read';
import { sseOn } from '@/lib/sse-stream';
import type { UsageEntry } from './usage-types';
import type { DictationEngine } from '@/lib/dictation/contract';
import { recordDictationDeclarations } from '@/lib/dictation/destination';
import type { MascotPart } from '@/lib/mascot/parts-contract';
import { recordMascotDeclarations } from '@/lib/mascot/parts-declarations';
import { createClientRealtime } from './realtime';
import { isSubscribableKind, PLUGIN_EVENT_KINDS, TRANSCRIPT_EVENT_KIND, TRANSCRIPT_PERMISSION } from './event-kinds';
import { mountableOnRemote } from './remote-plugins';
import { activeMachineId } from '@/lib/machines/machine-storage';
import { LOCAL_MACHINE_ID } from '@/lib/machines/machine-id';
import { grantClientPermissions } from './plugin-permissions';
import { typedBinaryInit } from './plugin-api-body';

export type PublicPlugin = {
  id: string;
  state: string;
  kind?: readonly string[];
  /** Third-party only; what a remote machine's copy is compared on (P4d). */
  version?: string;
  signature?: { hash: string; keyId: string } | null;
  /** Shipped with the product: its twin needs no signature (`remote-plugins.ts`). */
  builtin?: boolean;
  label?: string | null;
  /** `kind: dictation` only: where each engine sends the voice (`lib/dictation/destination.ts`). */
  dictation?: unknown;
  /** A mascot pack's parts, by look field (`timon.mascot`): what its drawings are admitted against. */
  mascot?: unknown;
  /** `digest`: line-ending-blind code identity, absent from older daemons (`remote-plugins.ts`). */
  client: { url: string; rev: string; digest?: string; slots: string[]; permissions?: string[] } | null;
};
type ClientModule = { apply(context: ClientContext): void | (() => void) | Promise<void | (() => void)> };
/** Inferred, not imported from the SDK: `app/sdk-guards/sdk-mirrors.ts` holds it to `ClientContext`. */
type ClientContext = ReturnType<typeof clientContext>;
type LoadClientModule = (url: string) => Promise<ClientModule>;

/**
 * Product fallback occupants of the `theme` / `root` slots.
 * Must stay aligned with `DEFAULT_USER_PREFS` in `orchestrator/src/db.ts`
 * and `app/src/lib/auth.ts` — the packages do not import each other.
 */
export const PRODUCT_THEME_PLUGIN = '@timon/ui-theme';
export const PRODUCT_LAYOUT_PLUGIN = '@timon/ui-layout';

export type ChromePrefs = { theme: string; layout: string };

/** What the daemon answers for an account without a row: the built-in Timon theme since 0.1.7. */
export const DEFAULT_THEME_PLUGIN = 'theme-timon';

export const DEFAULT_CHROME_PREFS: ChromePrefs = {
  theme: DEFAULT_THEME_PLUGIN,
  layout: PRODUCT_LAYOUT_PLUGIN,
};

const loaded = new Map<string, { rev: string; dispose: () => void }>();
let syncEpoch = 0;
let syncChain: Promise<void> = Promise.resolve();

/**
 * Whether a first pass of `syncClientPlugins` has finished.
 *
 * A host that paints "nothing here" when a key is free needs this: plugin
 * bundles are fetched and imported asynchronously, so a page plugin claims
 * its route a few hundred milliseconds after the first render. Without the
 * signal, every visit to a plugin route would flash "unknown route" first.
 */
let synced = false;
const syncListeners = new Set<() => void>();

export function pluginsSynced(): boolean { return synced; }

export function subscribePluginSync(listener: () => void): () => void {
  syncListeners.add(listener);
  return () => { syncListeners.delete(listener); };
}

function markSynced(): void {
  if (synced) return;
  synced = true;
  for (const listener of syncListeners) listener();
}

async function defaultLoadClientModule(url: string): Promise<ClientModule> {
  return import(/* webpackIgnore: true */ url) as Promise<ClientModule>;
}

let loadClientModule: LoadClientModule = defaultLoadClientModule;

/** Test seam: replace the dynamic import so `apply` can be observed. */
export function setLoadClientModuleForTests(fn: LoadClientModule | null): void {
  loadClientModule = fn ?? defaultLoadClientModule;
}

export function resetClientPluginsForTests(): void {
  syncEpoch += 1;
  syncChain = Promise.resolve();
  for (const plugin of loaded.values()) plugin.dispose();
  loaded.clear();
  synced = false;
}

function kindsOf(plugin: PublicPlugin): readonly string[] {
  return Array.isArray(plugin.kind) ? plugin.kind : [];
}

/** Asks for the whole interface: a layout, or a half naming the `root` slot. */
function requestsRoot(plugin: PublicPlugin): boolean {
  return kindsOf(plugin).includes('layout') || (plugin.client?.slots.includes('root') ?? false);
}

/**
 * May this half occupy `root`? Only a layout, and any layout other than the
 * product's only under a licence that includes White Label (`whitelabel` in
 * the capabilities). The daemon already refuses it otherwise; this is the
 * second barrier, for a daemon that would not (an older remote machine).
 * `builtin` grants nothing here: the daemon sets it for any package found in
 * a built-in location, even one the release manifest does not vouch for, so
 * a layout dropped there would otherwise take `root` without the right.
 */
export function rootAllowed(plugin: PublicPlugin, whitelabel: boolean): boolean {
  if (!kindsOf(plugin).includes('layout')) return false;
  return plugin.id === PRODUCT_LAYOUT_PLUGIN || whitelabel;
}

/**
 * Active client halves that this tab should import.
 *
 * Widgets, pages, overlays, behaviors: every active half (M.4 already hid
 * unauthorized bundles). Themes and layouts: only the product fallback if
 * it is active, plus the chosen plugin if it differs, is active, and has
 * the matching kind. An invalid choice is silent — the fallback stays.
 * MULTI-THEME.md §5 / T.4. A half that asks for `root` without the right
 * to it is never imported, chosen or not: `prefs.layout` keeps the choice
 * for the day the right comes back.
 */
export function isClientPluginWanted(plugin: PublicPlugin, prefs: ChromePrefs, whitelabel = false): boolean {
  if (plugin.state !== 'active' || !plugin.client) return false;
  if (requestsRoot(plugin) && !rootAllowed(plugin, whitelabel)) return false;
  const kinds = kindsOf(plugin);
  const isTheme = kinds.includes('theme');
  const isLayout = kinds.includes('layout');
  if (!isTheme && !isLayout) return true;
  if (isTheme && (plugin.id === PRODUCT_THEME_PLUGIN || plugin.id === prefs.theme)) return true;
  if (isLayout && (plugin.id === PRODUCT_LAYOUT_PLUGIN || plugin.id === prefs.layout)) return true;
  return false;
}

export function selectClientPlugins(plugins: readonly PublicPlugin[], prefs: ChromePrefs, whitelabel = false): PublicPlugin[] {
  return plugins.filter((plugin) => isClientPluginWanted(plugin, prefs, whitelabel));
}

function chromePrefsFromBody(body: unknown): ChromePrefs {
  const prefs = body && typeof body === 'object' ? (body as { prefs?: unknown }).prefs : undefined;
  const row = prefs && typeof prefs === 'object' ? prefs as { theme?: unknown; layout?: unknown } : {};
  return {
    theme: typeof row.theme === 'string' && row.theme ? row.theme : DEFAULT_CHROME_PREFS.theme,
    layout: typeof row.layout === 'string' && row.layout ? row.layout : DEFAULT_CHROME_PREFS.layout,
  };
}

async function readChromePrefs(response: Response | null): Promise<ChromePrefs> {
  if (!response?.ok) return { ...DEFAULT_CHROME_PREFS };
  try {
    return chromePrefsFromBody(await response.json());
  } catch {
    return { ...DEFAULT_CHROME_PREFS };
  }
}

export function clientContext(id: string, declaredSlots: readonly string[], subscribeSse: typeof sseOn = sseOn, permissions: readonly string[] = [], mayOccupyRoot = false) {
  // What the browser checks on its own (`browser:control`), for this load only.
  const effects: Array<() => void> = [grantClientPermissions(id, permissions)];
  const effect = (setup: () => void | (() => void)): void => {
    const dispose = setup();
    if (dispose) effects.push(dispose);
  };
  return {
    id,
    realtime: createClientRealtime(id, (dispose) => effects.push(dispose), subscribeSse),
    slots: {
      register(
        options: {
          slot: string;
          key?: string;
          widget?: WidgetOptions;
          island?: IslandContentOptions;
          /** API 14: read for `dictation.engine` only, refused without `dictation:engine`. */
          dictation?: DictationEngine;
          /** API 15: read for `mascot.parts` only, a part the manifest declares (`timon.mascot`). */
          mascotPart?: MascotPart;
          order?: number;
          children?: SlotChildren;
        },
        /** Not painted for a mascot part, which is data only: leave it out there. */
        Component?: ComponentType,
      ): () => void {
        if (!isSlotAdmissible(declaredSlots, options.slot)) throw slotAdmissionError(id, options.slot, declaredSlots);
        if (options.slot === 'root' && !mayOccupyRoot) {
          throw new Error(`Plugin ${id} is not allowed in slot root: replacing the whole interface is reserved to a layout, under a licence that includes White Label.`);
        }
        const dispose = register({ ...options, pluginId: id }, Component);
        effects.push(dispose);
        return dispose;
      },
    },
    api: async (path: string, init?: RequestInit) => fetch(`/api/ui/plugins/${encodeURIComponent(id)}/${path.replace(/^\//, '')}`, typedBinaryInit(init)),
    settings: {
      get: async () => fetch(`/api/ui/plugins/${encodeURIComponent(id)}/settings`, { cache: 'no-store' }).then((r) => r.json()),
      set: async (key: string, value: unknown) => fetch(`/api/ui/plugins/${encodeURIComponent(id)}/settings`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, value }),
      }),
    },
    events: {
      subscribe(kind: string, handler: (event: unknown) => void): () => void {
        if (!isSubscribableKind(kind, permissions)) {
          throw new Error(`plugin \`${id}\`: event \`${String(kind)}\` is not exposed to plugins `
            + `(allowed: ${PLUGIN_EVENT_KINDS.join(', ')}; \`${TRANSCRIPT_EVENT_KIND}\` with \`${TRANSCRIPT_PERMISSION}\`)`);
        }
        const dispose = subscribeSse(kind, (event) => handler(JSON.parse(event.data)));
        effects.push(dispose);
        return dispose;
      },
    },
    /**
     * Quotas of the LLM accounts (§10.15). Served by the platform segment
     * `/-/usage`, so a plugin with NO host half (a widget alone) can read them.
     * The daemon checks the plugin declared `usage:read`; a plugin that did
     * not gets a 403 here, never silent zeros. `{ force: true }` is a
     * person's ↻: the probes skip their cache (`?refresh=1`). A default
     * parameter, so the arity frozen by the surface snapshot stays 0.
     */
    usage: {
      list: async (options: { force?: boolean } = {}): Promise<UsageEntry[]> => {
        const query = options?.force === true ? '?refresh=1' : '';
        const response = await fetch(`/api/ui/plugins/${encodeURIComponent(id)}/-/usage${query}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`usage indisponible (${response.status})`);
        const body = await response.json() as { entries?: UsageEntry[] };
        return body.entries ?? [];
      },
    },
    theme: { current: () => document.documentElement.classList.contains('dark') ? 'dark' : 'light' },
    navigate: (href: string) => { window.location.assign(href); },
    effect,
    dispose: () => { for (const dispose of effects.splice(0).reverse()) { try { dispose(); } catch { /* plugin isolated */ } } },
  };
}

/** Boot, navigation and plugin events may all request a sync while an import
 * is pending. Serialize the passes so a keyed view is never applied twice;
 * each queued pass reads fresh state, including an uninstall during import. */
export function syncClientPlugins(): Promise<void> {
  const epoch = syncEpoch;
  const next = syncChain.catch(() => {}).then(() => epoch === syncEpoch ? syncClientPluginPass(epoch) : undefined);
  syncChain = next;
  return next;
}

async function syncClientPluginPass(epoch: number): Promise<void> {
  // A daemon that answers nothing is settled too: waiting forever would leave
  // a spinner where an "unknown route" is the truthful answer.
  const remote = activeMachineId() !== LOCAL_MACHINE_ID;
  const [response, meResponse, localResponse] = await Promise.all([
    sharedGet('/api/ui/plugins').catch(() => null),
    // Same source as GET /api/auth/me — the UI proxy. No prefs → product.
    sharedGet('/api/ui/auth/me').catch(() => null),
    // On a remote machine, this computer's plugins: the only browser halves
    // that may run here (`remote-plugins.ts`).
    remote ? sharedGet('/api/ui/plugins/local').catch(() => null) : Promise.resolve(null),
  ]);
  if (epoch !== syncEpoch) return;
  if (!response?.ok) { markSynced(); return; }
  const listed = (await response.json() as { plugins: PublicPlugin[] }).plugins;
  // No local list to compare with: no remote browser half at all.
  const plugins = remote ? mountableOnRemote(listed, await localPlugins(localResponse)) : listed;
  const prefs = await readChromePrefs(meResponse);
  if (epoch !== syncEpoch) return;
  // Before any browser half mounts: an engine registers knowing where its
  // plugin says the voice goes, or finds no destination and stays unused.
  recordDictationDeclarations(plugins);
  // Same for a mascot pack: its drawings are admitted against its manifest.
  recordMascotDeclarations(plugins);
  // Read fresh, and only when a half asks for the whole interface: when the
  // right comes back, the `plugins_changed` that brought this pass also left
  // the cached capabilities behind, and the layout would wait for their TTL.
  const whitelabel = plugins.some((p) => requestsRoot(p) && p.id !== PRODUCT_LAYOUT_PLUGIN)
    ? (await fetchCapabilities(true))?.whitelabel === true
    : false;
  if (epoch !== syncEpoch) return;
  const wanted = new Map(selectClientPlugins(plugins, prefs, whitelabel).map((p) => [p.id, p]));
  for (const [id, current] of loaded) {
    const next = wanted.get(id);
    if (!next?.client || next.client.rev !== current.rev) { current.dispose(); loaded.delete(id); }
  }
  for (const plugin of wanted.values()) {
    if (!plugin.client || loaded.has(plugin.id)) continue;
    const context = clientContext(plugin.id, plugin.client.slots, sseOn, plugin.client.permissions ?? [], rootAllowed(plugin, whitelabel));
    try {
      const url = `/api/ui/plugin-bundles/${encodeURIComponent(plugin.id)}?rev=${encodeURIComponent(plugin.client.rev)}`;
      const module = await loadClientModule(url);
      if (epoch !== syncEpoch) { context.dispose(); return; }
      const moduleDispose = await module.apply(context);
      if (epoch !== syncEpoch) {
        if (typeof moduleDispose === 'function') moduleDispose();
        context.dispose();
        return;
      }
      loaded.set(plugin.id, { rev: plugin.client.rev, dispose: () => { if (typeof moduleDispose === 'function') moduleDispose(); context.dispose(); } });
    } catch (error) {
      context.dispose();
      console.error(`[plugin:${plugin.id}] chargement client impossible`, error);
    }
  }
  markSynced();
}

async function localPlugins(response: Response | null): Promise<PublicPlugin[]> {
  if (!response?.ok) return [];
  try {
    const body = await response.json() as { plugins?: unknown };
    return Array.isArray(body.plugins) ? body.plugins as PublicPlugin[] : [];
  } catch {
    return [];
  }
}

export function watchClientPlugins(): () => void {
  void syncClientPlugins();
  const unsubscribe = sseOn('plugins_changed', () => {
    void syncClientPlugins();
    // The daemon publishes this event for BOTH halves of the gallery, and a
    // bundled module toggle only shows in the capabilities: without this
    // forced reread, the cockpit would keep the tile of a module the daemon
    // just unmounted, until the cache expires.
    void fetchCapabilities(true);
  });
  return () => { syncEpoch += 1; unsubscribe(); for (const plugin of loaded.values()) plugin.dispose(); loaded.clear(); };
}
