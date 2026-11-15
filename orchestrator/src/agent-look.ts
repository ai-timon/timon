/**
 * An agent's mascot look — `{ shape, color, eyes, acc }` in its config.json —
 * and the avatar mode that says which head it shows (`avatar`).
 *
 * The daemon only stores and checks it; the app draws it (`AgentMascot`). The
 * lists are the ones the mascot offers, plus the parts the mascot packs
 * installed and enabled declare (`<pluginId>:<part>`), so a value the app
 * cannot draw never reaches the disk: a caller learns it at once, with the
 * accepted values, instead of finding a default head on screen later.
 *
 * Kept free of any other daemon import at run time (types aside): the config
 * type, the routes, the plugin facade and the tests all read it.
 */
import { z } from 'zod';
import type { PluginAgentAvatarMode, PluginAgentLook } from './plugins/contract/agents.js';
import type { Assert, Equals } from './type-equality.js';

/** Head silhouettes. */
export const AGENT_LOOK_SHAPES = ['squircle', 'tri', 'gem', 'round', 'bean', 'cloud', 'hex'] as const;

/** The fur palette, then the three bright colours the colour picker adds after it. */
export const AGENT_LOOK_FURS = [
  '#d4a373', '#b8743d', '#e6c9a2', '#8a5a3b', '#c98e5a', '#a8826a', '#d9b48a', '#7a4f35', '#e0b07a',
] as const;
export const AGENT_LOOK_EXTRA_COLORS = ['#ff5fbf', '#3fa9ff', '#7ed957'] as const;
/**
 * The colours of the default looks by mission (`defaultLookFor` in the app,
 * the mockup's `MLOOK`) that the picker does not offer: an agent created with
 * its default look must be storable.
 */
export const AGENT_LOOK_MISSION_COLORS = ['#ffc233', '#ff8a2a', '#a35bff'] as const;
export const AGENT_LOOK_COLORS = [...AGENT_LOOK_FURS, ...AGENT_LOOK_EXTRA_COLORS, ...AGENT_LOOK_MISSION_COLORS] as const;
/**
 * Any other fur the colour picker can mix: `#rrggbb`, stored lower case. The
 * palette above stays the set of named furs; this only widens what is stored.
 */
export const AGENT_LOOK_CUSTOM_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Resting eye expressions a user can pick. */
export const AGENT_LOOK_EYES = [
  'pill', 'big', 'happy', 'wink', 'surprised', 'squint', 'sleepy', 'heart', 'star', 'code',
] as const;

/** Job accessories, `none` included. */
export const AGENT_LOOK_ACCESSORIES = [
  'none', 'loupe', 'pen', 'quill', 'hammer', 'wrench', 'baton', 'telescope', 'envelope', 'calendar',
  'clipboard', 'hourglass', 'teacher', 'calculator', 'chart', 'brush', 'globe', 'megaphone', 'shield', 'coffee',
  'whip', 'wizard', 'chef', 'crown', 'idea', 'rocket', 'chemist', 'gamer', 'photographer', 'gardener', 'musician',
] as const;

export type AgentLookShape = typeof AGENT_LOOK_SHAPES[number];
export type AgentLookColor = typeof AGENT_LOOK_COLORS[number];
type HexDigit =
  | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
  | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
/**
 * A fur off the palette, `#rrggbb` (`AGENT_LOOK_CUSTOM_COLOR_RE`), stored lower
 * case. The type can only check the `#` and the first and last digits: the
 * regular expression is what counts the six.
 */
export type AgentLookCustomColor = `#${HexDigit}${string}${HexDigit}`;
// What the type tells a plugin author at compilation: a mixed fur fits, a colour name or a bare `#` does not.
type _CustomColorTakesHex = Assert<'#a1B2c3' extends AgentLookCustomColor ? true : false>;
type _CustomColorRefusesName = Assert<'#red' extends AgentLookCustomColor ? false : true>;
type _CustomColorRefusesBare = Assert<'#' extends AgentLookCustomColor ? false : true>;
export type AgentLookEyes = typeof AGENT_LOOK_EYES[number];
export type AgentLookAccessory = typeof AGENT_LOOK_ACCESSORIES[number];

/**
 * A part a mascot pack adds: `<pluginId>:<part>`. The product's ids stay bare,
 * so the colon is what tells the two apart, and a plugin can only name parts
 * in its own namespace (its manifest's `mascot` block).
 */
export type MascotPartId = `${string}:${string}`;

/** Same id rule as a plugin manifest, then a part slug of the same alphabet. */
export const MASCOT_PART_ID_RE = /^[a-z0-9-]{3,40}:[a-z0-9][a-z0-9-]{0,39}$/;

export type AgentLook = {
  shape: AgentLookShape | MascotPartId;
  color: AgentLookColor | AgentLookCustomColor | MascotPartId;
  eyes: AgentLookEyes | MascotPartId;
  acc: AgentLookAccessory | MascotPartId;
};

// The plugin contract spells the look out by hand (it cannot import this module): both must say the same.
type _AgentLookMatchesContract = Assert<Equals<AgentLook, PluginAgentLook>>;

export const MASCOT_PART_TYPES = ['shape', 'color', 'eyes', 'acc'] as const;
export type MascotPartType = typeof MASCOT_PART_TYPES[number];

/** The pack ids each look field accepts on top of the product's: those of the plugins installed and enabled now. */
export type MascotPartCatalog = Readonly<Record<MascotPartType, ReadonlySet<string>>>;

const EMPTY_CATALOG: MascotPartCatalog = Object.freeze({
  shape: new Set<string>(), color: new Set<string>(), eyes: new Set<string>(), acc: new Set<string>(),
});

/**
 * Where the declared parts come from. Set by the daemon once the plugin loader
 * exists (`kernel-boot.ts`) and read at every write, so a pack switched off a
 * second ago is refused at once. Injected rather than imported: this module
 * stays free of the loader, which the CLI-side readers do not have.
 */
let catalogSource: () => MascotPartCatalog = () => EMPTY_CATALOG;

export function setMascotPartSource(source: (() => MascotPartCatalog) | null): void {
  catalogSource = source ?? (() => EMPTY_CATALOG);
}

/** The pack parts a write may name right now. Never throws: a broken source means no pack. */
export function mascotPartCatalog(): MascotPartCatalog {
  try {
    return catalogSource();
  } catch {
    return EMPTY_CATALOG;
  }
}

/** A catalog built from `[pluginId, { shape?, color?, eyes?, acc? }]` pairs (the manifests of the active plugins). */
export function mascotCatalogOf(
  packs: Iterable<readonly [string, Partial<Record<MascotPartType, readonly string[]>>]>,
): MascotPartCatalog {
  const out: Record<MascotPartType, Set<string>> = { shape: new Set(), color: new Set(), eyes: new Set(), acc: new Set() };
  for (const [pluginId, parts] of packs) {
    for (const type of MASCOT_PART_TYPES) {
      for (const part of parts[type] ?? []) out[type].add(`${pluginId}:${part}`);
    }
  }
  return out;
}

/**
 * The catalog for a write over an agent that already wears `stored`: its pack
 * parts stay accepted in their own field even when their plugin is off now.
 * Without it, a save that only keeps the look — the agent editor sends it
 * back whole, a rewrite carries it over — would fail for an agent whose pack
 * was switched off, or overwrite the part with a default. A NEW pack id still
 * needs a pack that runs.
 */
export function catalogKeeping(catalog: MascotPartCatalog, stored: unknown): MascotPartCatalog {
  if (typeof stored !== 'object' || stored === null) return catalog;
  const kept = stored as Record<string, unknown>;
  const out = {} as Record<MascotPartType, ReadonlySet<string>>;
  let changed = false;
  for (const type of MASCOT_PART_TYPES) {
    const value = kept[type];
    if (isPartId(value) && !catalog[type].has(value)) {
      out[type] = new Set([...catalog[type], value]);
      changed = true;
    } else {
      out[type] = catalog[type];
    }
  }
  return changed ? out : catalog;
}

const ACCEPTED: Record<keyof AgentLook, readonly string[]> = {
  shape: AGENT_LOOK_SHAPES,
  color: AGENT_LOOK_COLORS,
  eyes: AGENT_LOOK_EYES,
  acc: AGENT_LOOK_ACCESSORIES,
};
const FIELDS = ['shape', 'color', 'eyes', 'acc'] as const;

function describe(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : value === undefined ? 'nothing' : typeof value;
}

const isPartId = (value: unknown): value is MascotPartId => typeof value === 'string' && MASCOT_PART_ID_RE.test(value);

/** The product's value, compared the way it is stored (a colour in lower case), or `null`. */
function productValue(field: keyof AgentLook, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = field === 'color' ? value.toLowerCase() : value;
  if (field === 'color' && AGENT_LOOK_CUSTOM_COLOR_RE.test(v)) return v;
  return ACCEPTED[field].includes(v) ? v : null;
}

/** Where a value is refused: the field, what it got, and what it takes. */
function fieldRefusal(field: keyof AgentLook, value: unknown, catalog: MascotPartCatalog): string {
  const packs = [...catalog[field]];
  const custom = field === 'color' ? ', or any #rrggbb colour' : '';
  const more = `${custom}${packs.length ? `, or a part an enabled mascot pack declares: ${packs.join(', ')}` : ''}`;
  if (isPartId(value)) {
    return `look.${field}: ${JSON.stringify(value)} is not declared for this field by an installed and enabled mascot pack `
      + `(expected one of ${ACCEPTED[field].join(', ')}${more})`;
  }
  return `look.${field}: unknown value ${describe(value)} (expected one of ${ACCEPTED[field].join(', ')}${more})`;
}

/**
 * The look checked field by field, or one sentence naming the first wrong
 * field, what it got and what it takes. Any other key is refused, never dropped.
 */
function settle(input: unknown, catalog: MascotPartCatalog | null): { look: AgentLook } | { error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'look must be an object { shape, color, eyes, acc }, or null to clear it' };
  }
  const raw = input as Record<string, unknown>;
  const extra = Object.keys(raw).filter((key) => !(FIELDS as readonly string[]).includes(key));
  if (extra.length) return { error: `look has unknown field(s): ${extra.join(', ')} (expected shape, color, eyes, acc)` };
  const out: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = field === 'acc' && raw.acc === undefined ? 'none' : raw[field];
    const product = productValue(field, value);
    if (product) { out[field] = product; continue; }
    // `catalog` null = reading back: a pack id stays whatever its plugin's state.
    if (isPartId(value) && (catalog === null || catalog[field].has(value))) { out[field] = value; continue; }
    return { error: fieldRefusal(field, value, catalog ?? EMPTY_CATALOG) };
  }
  return { look: out as AgentLook };
}

/**
 * Checks a look sent by a caller. `null` means "clear it". A product id, or an
 * id `<plugin>:<part>` that a plugin installed and enabled right now declares
 * for that field (`catalog`, default: the live one). Throws an Error whose
 * message says which field is wrong and lists the accepted values.
 */
export function parseAgentLook(input: unknown, catalog: MascotPartCatalog = mascotPartCatalog()): AgentLook | null {
  if (input === null) return null;
  const result = settle(input, catalog);
  if ('error' in result) throw new Error(result.error);
  return result.look;
}

/**
 * The look as read back from disk. A config.json edited by hand with a value
 * nothing can draw reads as no look at all, rather than breaking the agent
 * listing for everyone. A pack id is kept as stored even when its plugin has
 * been removed or switched off: the app draws the job's default for that one
 * part (`normalizeAgentLook`), and the part comes back with its plugin.
 */
export function readAgentLook(stored: unknown): AgentLook | null {
  if (stored === undefined || stored === null) return null;
  const result = settle(stored, null);
  return 'look' in result ? result.look : null;
}

/**
 * Which head the agent shows: its emoji, its uploaded picture (`icon_url`) or
 * its mascot (`look`). Absent = the order every agent had before the choice
 * existed (picture, project logo, emoji, initial), which is how an existing
 * agent keeps its head. Picking one never erases the settings of the others,
 * so the user can come back to them.
 */
export const AGENT_AVATAR_MODES = ['emoji', 'image', 'mascot'] as const;

export type AgentAvatarMode = typeof AGENT_AVATAR_MODES[number];

type _AgentAvatarMatchesContract = Assert<Equals<AgentAvatarMode, PluginAgentAvatarMode>>;

const avatarModeSchema = z.enum(AGENT_AVATAR_MODES);

/**
 * Checks an avatar mode sent by a caller. `null` means "clear it" (back to the
 * historical order). Throws an Error naming the value and the accepted ones.
 */
export function parseAgentAvatar(input: unknown): AgentAvatarMode | null {
  if (input === null) return null;
  const parsed = avatarModeSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new Error(`avatar: unknown value ${describe(input)} (expected one of ${AGENT_AVATAR_MODES.join(', ')}, or null to clear it)`);
}

/** The mode as read back from disk; a value edited by hand that is not one reads as none. */
export function readAgentAvatar(stored: unknown): AgentAvatarMode | null {
  const parsed = avatarModeSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}
