/**
 * `PluginPublic` (what `/api/plugins` returns) → `PluginCardData` (what the
 * gallery card renders). Plan §10.12.
 *
 * A module of its own, and not two lines inside the page, for one reason: the
 * card is shared with the future marketplace, so what the LOCAL source means
 * has to be written down once. Three translations happen here, and each one is
 * a decision:
 *
 *  - `enabled` is `state !== 'disabled'`. `disabled` is the only state the user
 *    caused; `skipped`/`failed` are refusals by the daemon.
 *  - a refusal becomes `blockedReason`, which greys the toggle out. Flipping on
 *    an unsigned or unlicensed plugin would write the config, change nothing,
 *    and flip back at the next reconcile — indistinguishable from a bug.
 *  - the cover URL is rebuilt against the Next proxy, keeping only the `rev`
 *    query. The daemon path (`/plugins/<id>/cover`) is not reachable from the
 *    browser; the same detour already exists for bundles.
 *
 * A fourth one since the gallery also lists the modules of the product
 * (`source: 'bundled'`): their switch follows `wanted`, the config, and not
 * `state`, the running tree. The two agree again within the same request now
 * that a bundled module is recomposed on the spot, but the wish is still what
 * the user just expressed, and a daemon that refuses it (licence, missing host
 * capability) must not silently flip the switch back. `core` takes the switch
 * away entirely — turning the kernel off from a gallery bricks the daemon.
 *
 * Amended 25/10/2026: a licence that does not include a bundled module is the
 * one daemon refusal no switch can lift. Kept lit on the wish, the card read
 * as a module turned on that did nothing (the maintainer, with Machines skipped for its
 * licence and no word anywhere). It now reads as a refusal: switch off and
 * greyed, "Not included in your licence". The wish stays in the config.
 */
import type { PluginCardData } from '@/components/plugin-card';
import { t } from '@/lib/i18n';
import { declarationLines, readDictationDecl } from '@/lib/dictation/destination';
import { activationErrorMessage } from '@/lib/license';
import { moduleOffCause } from '@/lib/module-off-reason';
import { PRODUCT_THEME_PLUGIN } from '@/lib/plugin-host/loader';

export type PluginPublic = {
  id: string;
  pkg: string;
  version: string;
  /** `bundled` = a module of the product, `third-party` = a package installed here. */
  source: 'bundled' | 'third-party';
  /** Bundled only: `core` is what forbids the toggle. */
  tier: 'core' | 'std' | 'dev' | 'opt' | null;
  /** Bundled only: what the config asks for, which is what the switch shows. */
  wanted: boolean | 'auto' | null;
  state: 'active' | 'failed' | 'disabled' | 'skipped';
  reason: string | null;
  /** Bundled only: running, but a missing host capability takes part of it away. */
  warning?: string;
  error: string | null;
  kind: string[];
  label: string | null;
  description: string | null;
  author: string | null;
  /** `null` for bundled (the catalogue is the trust). Third-party: Ed25519 admission. */
  signed: boolean | null;
  /** The admitted signature (P4c); absent from older daemons. */
  signature?: { hash: string; keyId: string } | null;
  /** A package shipped with the product: disable-only. Absent from older daemons. */
  builtin?: boolean;
  screenshots: string[];
  cover: string | null;
  /** Picto: served URL for a package, `data:` URL for a bundled module. Absent from older daemons. */
  icon?: string | null;
  slots: string[];
  route: string | null;
  declares: Record<string, 'single' | 'list' | 'keyed'>;
  modifies: string[];
  contains: string[];
  client: { url: string; rev: string; digest?: string; slots: string[] } | null;
  settings: { key: string; type: string; label: string }[];
  /** `kind: dictation` only: where each engine sends the voice. Absent from older daemons. */
  dictation?: unknown;
};

/** `/plugins/<id>/cover?rev=x` → `/api/ui/plugin-covers/<id>?rev=x`. */
export function coverProxyUrl(id: string, cover: string | null): string | null {
  if (!cover) return null;
  // Base only needed to parse a relative URL; the origin is thrown away.
  const query = new URL(cover, 'http://timon.invalid').search;
  return `/api/ui/plugin-covers/${encodeURIComponent(id)}${query}`;
}

/**
 * Picto as the browser loads it. A bundled module's `data:` URL is used as is;
 * a package's `/plugins/<id>/icon?rev=x` goes through the Next proxy, the
 * daemon path being unreachable from the browser. Anything else is dropped:
 * a mask must never fetch an address the daemon did not hand out.
 */
export function iconProxyUrl(id: string, icon: string | null | undefined): string | null {
  if (!icon) return null;
  if (icon.startsWith('data:image/svg+xml,')) return icon;
  if (!icon.startsWith('/plugins/')) return null;
  const query = new URL(icon, 'http://timon.invalid').search;
  return `/api/ui/plugin-icons/${encodeURIComponent(id)}${query}`;
}

/** `/plugins/<id>/still/0?rev=x` → `/api/ui/plugin-stills/<id>/0?rev=x`. */
export function stillProxyUrl(id: string, still: string): string {
  const parsed = new URL(still, 'http://timon.invalid');
  const parts = parsed.pathname.split('/');
  const index = parts[parts.length - 1] ?? '0';
  return `/api/ui/plugin-stills/${encodeURIComponent(id)}/${encodeURIComponent(index)}${parsed.search}`;
}

/** Locale copy if it exists, otherwise `fallback`. `t()` returns the key when missing. */
function copy(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

/**
 * Gallery label of a kind. `behavior` is shown as "Backend": a module with
 * no screen of its own, not a missing type. The stored kind stays `behavior`
 * so third-party manifests and the plan keep one vocabulary.
 */
export function kindLabel(kind: string): string {
  return copy(`pluginsPage.kind.${kind}`, kind);
}

function bundledCopy(plugin: PluginPublic, field: 'label' | 'description'): string | null {
  const key = `pluginsPage.modules.${plugin.id}.${field}`;
  const value = t(key);
  if (value !== key) return value;
  if (field === 'label') return plugin.label ?? plugin.id;
  return plugin.description;
}

/** Gallery title: locale copy for a bundled module, else `timon.label`, else the id. */
export function pluginGalleryLabel(plugin: {
  id: string;
  label: string | null;
  source?: 'bundled' | 'third-party';
  builtin?: boolean;
}): string {
  if (plugin.builtin || plugin.source === 'bundled' || plugin.id.startsWith('@timon/')) {
    const key = `pluginsPage.modules.${plugin.id}.label`;
    const value = t(key);
    if (value !== key) return value;
  }
  return plugin.label ?? plugin.id;
}

export function toCardData(plugin: PluginPublic): PluginCardData {
  const refused = plugin.state === 'skipped' || plugin.state === 'failed';
  const bundled = plugin.source === 'bundled';
  const active = plugin.state === 'active';
  const unlicensed = bundled && !active && plugin.tier !== 'core' && moduleOffCause(plugin.reason) === 'licence';
  return {
    id: plugin.id,
    pkg: plugin.pkg,
    label: pluginGalleryLabel(plugin),
    description: bundled || plugin.builtin ? bundledCopy(plugin, 'description') : plugin.description,
    author: plugin.author,
    signed: plugin.signed,
    builtin: plugin.builtin === true,
    coverUrl: coverProxyUrl(plugin.id, plugin.cover),
    iconUrl: iconProxyUrl(plugin.id, plugin.icon),
    screenshots: plugin.screenshots.map((url) => stillProxyUrl(plugin.id, url)),
    version: plugin.version || null,
    kinds: plugin.kind,
    slots: plugin.slots,
    route: plugin.route,
    declares: plugin.declares,
    modifies: plugin.modifies,
    contains: plugin.contains,
    settings: plugin.settings,
    voice: voiceLines(plugin),
    source: plugin.source,
    tier: plugin.tier,
    // A refused package reads OFF, not ON: the switch is greyed out anyway
    // (`blockedReason` disables it), so showing it lit told the user the
    // plugin was running while the daemon had never loaded it — an unsigned
    // theme "activated" that repainted nothing. The wish is not lost: it
    // stays in `timon.config.json`, and the card lights up again as soon as
    // the refusal is lifted.
    // An unlicensed bundled module reads OFF for the same reason.
    enabled: unlicensed ? false : bundled ? bundledEnabled(plugin, active) : (refused ? false : plugin.state !== 'disabled'),
    // A missing host capability explains why a bundled module is not running,
    // but the wish stays the user's to write. Only `core` — and the product
    // theme, which is the floor under every palette — take the switch away;
    // a licence that does not include the module is a refusal (below).
    locked: bundled && (plugin.tier === 'core' || plugin.id === PRODUCT_THEME_PLUGIN),
    note: bundled && !unlicensed ? bundledNote(plugin, active) : null,
    blockedReason: unlicensed ? t('pluginsPage.notInLicence') : !bundled && refused ? (plugin.error ?? plugin.reason) : null,
  };
}

/** "Where your voice goes", from the manifest the daemon read; empty for any other plugin. */
function voiceLines(plugin: PluginPublic): string[] {
  const decl = plugin.kind.includes('dictation') ? readDictationDecl(plugin.dictation) : null;
  return decl ? declarationLines(decl) : [];
}

/**
 * `auto` (the default) means "whatever the kernel decides", so the switch shows
 * what it decided. An explicit `true`/`false` overrides it, which is what keeps
 * the switch on a module the daemon refuses to run.
 */
function bundledEnabled(plugin: PluginPublic, active: boolean): boolean {
  // A `core` module ignores the config wish (`planEntries` does too), so a
  // hand-written `false` in the file must not show its switch off while the
  // module is in fact running. The API refuses to write it; a text editor does not.
  if (plugin.tier === 'core') return active;
  return plugin.wanted === 'auto' || plugin.wanted === null ? active : plugin.wanted;
}


/**
 * No restart is ever mentioned: the daemon recomposes the tree during the
 * toggle request, so `wanted` and `state` are back in agreement by the time the
 * gallery reloads. What remains worth saying is a refusal the user did not ask
 * for — a licence that does not cover the module, a host capability it needs
 * or, for a running module, one whose absence takes part of it away (the
 * Kanban without git, TODO #275).
 */
function bundledNote(plugin: PluginPublic, active: boolean): string | null {
  if (plugin.tier === 'core') return t('pluginsPage.coreLocked');
  if (plugin.id === PRODUCT_THEME_PLUGIN) return t('pluginsPage.themeLocked');
  if (!active && plugin.wanted !== false && plugin.reason) return plugin.reason;
  if (active && plugin.warning) return plugin.warning;
  return null;
}

/**
 * What the gallery must say when the daemon refuses a toggle.
 *
 * A separate, pure function because the wording is the fix: the page used to
 * drop every non-2xx answer on the floor (`if (!response.ok) return`), so a
 * refusal — `core` module, unknown id, expired session — looked exactly like a
 * broken switch. Nothing moved and nothing explained why. The daemon already
 * sends a usable sentence in `error`; when it does, that sentence is shown
 * verbatim rather than replaced by a generic one.
 */
export function toggleFailureMessage(status: number, body: unknown): string {
  const detail = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error.trim()
    : '';
  if (detail) return activationErrorMessage({ error: detail }, t);
  if (status === 401) return t('pluginsPage.toggleUnauthenticated');
  if (status === 403) return t('pluginsPage.toggleForbidden');
  if (status === 404) return t('pluginsPage.toggleUnknown');
  return t('pluginsPage.toggleFailedStatus', { status });
}

/** The two halves of the gallery, each sorted by `sortForGallery`. */
export function groupBySource(plugins: PluginPublic[]): { bundled: PluginPublic[]; thirdParty: PluginPublic[] } {
  return {
    bundled: sortForGallery(plugins.filter((p) => p.source === 'bundled')),
    thirdParty: sortForGallery(plugins.filter((p) => p.source !== 'bundled')),
  };
}

/** Plugged in first, then refused, then unplugged; alphabetical within a group. */
export function sortForGallery(plugins: PluginPublic[]): PluginPublic[] {
  const rank = (p: PluginPublic): number => (p.state === 'active' ? 0 : p.state === 'disabled' ? 2 : 1);
  return [...plugins].sort((a, b) => rank(a) - rank(b) || (a.label ?? a.id).localeCompare(b.label ?? b.id));
}

/**
 * Gallery family (the maintainer, 30/08, plan §10.14). Two of them, exclusive:
 *  - `timon` — what we wrote, recognised by the SCOPE of the id, whatever its
 *    tier. A `core` module sits there like the others; it only differs by its
 *    greyed-out switch.
 *  - `marketplace` — third-party packages. Each card carries a `verified` or
 *    `unverified` badge depending on its Ed25519 admission.
 *
 * `Verified` is therefore a property of the CARD, never a shelf of the shop,
 * and `tier: core` no longer makes a family either — it only forbids the toggle.
 */
export type PluginProvenance = 'timon' | 'marketplace';

/** Scope that tells our own plugins from third-party ones. */
const TIMON_SCOPE = '@timon/';

export const GALLERY_PROVENANCES: readonly PluginProvenance[] = ['timon', 'marketplace'];

/** Kind chips, same order as `PLUGIN_KINDS`. `behavior` displays as Backend. */
export const GALLERY_TYPES = [
  'widget', 'page', 'island', 'overlay', 'theme', 'composer', 'layout', 'behavior', 'provider', 'dictation', 'bundle',
] as const;
export type GalleryType = (typeof GALLERY_TYPES)[number];

export function provenanceOf(plugin: PluginPublic): PluginProvenance {
  // A built-in is ours even though its id carries no scope.
  return plugin.id.startsWith(TIMON_SCOPE) || plugin.builtin === true ? 'timon' : 'marketplace';
}

export type GalleryFilter = {
  provenance: PluginProvenance | 'all';
  /** Single kind, or `all`. Exclusive — stacking kinds made the bar unreadable. */
  type: GalleryType | 'all';
  query: string;
};

function haystack(plugin: PluginPublic): string {
  return [
    plugin.id, plugin.pkg, plugin.label ?? '', plugin.description ?? '',
    plugin.author ?? '', plugin.kind.join(' '), plugin.slots.join(' '),
    plugin.route ?? '',
  ].join('\n').toLowerCase();
}

export function matchesQuery(plugin: PluginPublic, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack(plugin).includes(q);
}

export function matchesFilter(plugin: PluginPublic, filter: GalleryFilter): boolean {
  if (filter.provenance !== 'all' && provenanceOf(plugin) !== filter.provenance) return false;
  if (filter.type !== 'all' && !plugin.kind.includes(filter.type)) return false;
  return matchesQuery(plugin, filter.query);
}

export function filterGallery(plugins: PluginPublic[], filter: GalleryFilter): PluginPublic[] {
  return sortForGallery(plugins.filter((p) => matchesFilter(p, filter)));
}

export function countByProvenance(plugins: PluginPublic[], filter: Omit<GalleryFilter, 'provenance'>): Record<PluginProvenance | 'all', number> {
  const scoped: GalleryFilter = { provenance: 'all', type: filter.type, query: filter.query };
  const matching = plugins.filter((p) => matchesFilter(p, scoped));
  const counts: Record<PluginProvenance | 'all', number> = { all: matching.length, timon: 0, marketplace: 0 };
  for (const p of matching) counts[provenanceOf(p)] += 1;
  return counts;
}

/**
 * Resolve a bundle's `contains` against the local catalogue. An id that is
 * not installed stays in the list as `plugin: null` — hiding it would make a
 * half-installed pack look complete.
 */
/** Cover first, then extra stills, de-duplicated — the dialog carousel. */
export function mediaSlides(plugin: { coverUrl: string | null; screenshots: readonly string[] }): string[] {
  const out: string[] = [];
  for (const url of [plugin.coverUrl, ...plugin.screenshots]) {
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

export function containedEntries<T extends { id: string }>(
  contains: readonly string[],
  catalog: readonly T[],
): { id: string; plugin: T | null }[] {
  return contains.map((id) => ({ id, plugin: catalog.find((p) => p.id === id) ?? null }));
}
