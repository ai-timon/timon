/**
 * The sections of a provider page (`settings.provider.section`, a `list` slot)
 * and which of them a given provider shows.
 *
 * The product's common sections are entries of `@timon/backends` registered as
 * `fallback`, each under a `key` and an `order`. A provider plugin adds its own
 * sections, and only to the page of the providers it brings: an entry is shown
 * when its plugin id is the provider's. An entry of that plugin under the key of
 * a common section takes the common one's place, on that page only.
 */
import type { SlotEntry } from '@/lib/plugin-host/slots';

export const PROVIDER_SECTION_SLOT = 'settings.provider.section';

/** The common sections, in page order. */
export const PROVIDER_SECTION_KEYS = ['connection', 'apiKey', 'models', 'program', 'settings'] as const;
export type ProviderSectionKey = typeof PROVIDER_SECTION_KEYS[number];

/**
 * Their ranks, with room between them. Models comes right under how the
 * provider is reached (Connection, then the API key that goes with it), at 250
 * so that Program and own settings keep the ranks plugins already target. A
 * plugin's section without an `order` lands last, after own settings; one with
 * `order: 450` right after own settings.
 */
export const PROVIDER_SECTION_ORDER: Readonly<Record<ProviderSectionKey, number>> = {
  connection: 100,
  apiKey: 200,
  models: 250,
  program: 300,
  settings: 400,
};

/** Product modules register under this prefix; a third-party id never starts with it. */
const PRODUCT_PREFIX = '@timon/';

/**
 * A common section: registered by the product AND as a default. Both are
 * required — a plugin's half spreads its options into the registry, so the
 * flag alone would let it onto every provider's page.
 */
function isCommon(entry: SlotEntry): boolean {
  return entry.fallback === true && entry.pluginId.startsWith(PRODUCT_PREFIX);
}

/** The entries one provider's page paints, in order. `pluginId`: the plugin that brings it, if any. */
export function sectionsFor(entries: readonly SlotEntry[], pluginId: string | null): SlotEntry[] {
  const own = pluginId === null ? [] : entries.filter((entry) => !isCommon(entry) && entry.pluginId === pluginId);
  const taken = new Set(own.flatMap((entry) => (entry.key === undefined ? [] : [entry.key])));
  const common = entries.filter((entry) => isCommon(entry) && !(entry.key !== undefined && taken.has(entry.key)));
  // The registry sorts a default last (a `single` slot paints its first entry); here it keeps its rank.
  return [...common, ...own].sort((a, b) => (a.order === b.order ? a.seq - b.seq : a.order - b.order));
}
