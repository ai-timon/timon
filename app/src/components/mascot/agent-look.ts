/**
 * The look of an agent's mascot (`AgentLook`): a skull, a fur, a pair of eyes
 * and a job accessory. No React: the onboarding, the agent creation, the chat
 * and the daemon's agent config share this one schema (docs/AGENT-MASCOT.md).
 *
 * Each field holds a product id, or a part a mascot pack registered
 * (`<pluginId>:<slug>`, `mascot-parts.ts`): a part counts while its plugin is
 * here, and reads as the default once it is gone.
 */
import { isMascotPartId, type MascotPartId } from '@/lib/mascot/parts-contract';
import { isRegisteredPart, mascotPartOf } from './mascot-parts';

/** The seven skulls, in picker order. */
export const SHAPES = ['squircle', 'tri', 'gem', 'round', 'bean', 'cloud', 'hex'] as const;
export type MascotShape = typeof SHAPES[number];

/**
 * The natural pelts. The drawing takes any `#rrggbb` and paints it as is, in
 * 2D (`furOf`) as in 3D. A look carries a colour of `LOOK_COLORS` (the named
 * furs, in the daemon's order: `orchestrator/src/agent-look.ts`) or any other
 * `#rrggbb` mixed with the configurator's colour picker.
 */
export const NATURAL_FURS = ['#d4a373', '#b8743d', '#e6c9a2', '#8a5a3b', '#c98e5a', '#a8826a', '#d9b48a', '#7a4f35', '#e0b07a'] as const;
/**
 * The furs the configurator offers before its colour picker: two browns, then
 * the base colours. Any other colour, the older pelts included, stays a valid
 * fur (the picker's `#rrggbb`).
 */
export const FURS = [
  '#b8743d', '#7a4f35', '#ffc233', '#ff8a2a', '#e5484d', '#ff5fbf', '#a35bff', '#3fa9ff', '#2ec4b6', '#7ed957', '#f2efe9', '#8e8e93', '#2b2b2b',
] as const;
/** Colours of the default looks by mission (`MLOOK`) that the picker does not offer. */
export const MISSION_COLORS = ['#ffc233', '#ff8a2a', '#a35bff'] as const;
/** The named colours, in the daemon's order (`AGENT_LOOK_COLORS`); a look may also carry any `#rrggbb`. */
export const LOOK_COLORS = [...NATURAL_FURS, '#ff5fbf', '#3fa9ff', '#7ed957', ...MISSION_COLORS] as const;
export type MascotColor = typeof LOOK_COLORS[number];
/** A fur off the lists, mixed with the colour picker: `#rrggbb`, lower case once stored. */
export type CustomFurColor = `#${string}`;
/** Same pattern as the daemon's `AGENT_LOOK_CUSTOM_COLOR_RE`. */
export const CUSTOM_FUR_RE = /^#[0-9a-fA-F]{6}$/;

const FUR_NAMES: Readonly<Record<string, string>> = {
  '#d4a373': 'sand', '#b8743d': 'cinnamon', '#e6c9a2': 'cream', '#8a5a3b': 'cocoa', '#c98e5a': 'caramel',
  '#a8826a': 'taupe', '#d9b48a': 'honey', '#7a4f35': 'bark', '#e0b07a': 'wheat',
  '#ff5fbf': 'pink', '#3fa9ff': 'blue', '#7ed957': 'green',
  '#ffc233': 'yellow', '#ff8a2a': 'orange', '#a35bff': 'purple',
  '#e5484d': 'red', '#2ec4b6': 'teal', '#f2efe9': 'white', '#8e8e93': 'grey', '#2b2b2b': 'black',
};

/** The eyes a picker offers. The mascot shows more expressions (`MascotExpression`), driven by its states. */
export const EYES = ['pill', 'big', 'happy', 'wink', 'surprised', 'squint', 'sleepy', 'heart', 'star', 'code'] as const;
export type MascotEyes = typeof EYES[number];

/** The job accessories, `none` first: a hand tool held at the bottom right of the head. */
export const ACC = [
  'none', 'loupe', 'pen', 'quill', 'hammer', 'wrench', 'baton', 'telescope', 'envelope', 'calendar',
  'clipboard', 'hourglass', 'teacher', 'calculator', 'chart', 'brush', 'globe', 'megaphone', 'shield', 'coffee',
  'whip', 'wizard', 'chef', 'crown', 'idea', 'rocket', 'chemist', 'gamer', 'photographer', 'gardener', 'musician',
] as const;
export type MascotAccessory = typeof ACC[number];

export type AgentLook = {
  shape: MascotShape | MascotPartId;
  /** One of `LOOK_COLORS` or any other `#rrggbb`, lower case, or a pack's fur. */
  color: MascotColor | CustomFurColor | MascotPartId;
  eyes: MascotEyes | MascotPartId;
  acc: MascotAccessory | MascotPartId;
};

export type { MascotPartId };

/** The look of an agent nobody styled: the classic skull, a bark pelt, plain eyes, empty paws. */
export const DEFAULT_LOOK: AgentLook = Object.freeze({ shape: 'squircle', color: '#7a4f35', eyes: 'pill', acc: 'none' } as const);

export function isMascotShape(value: unknown): value is MascotShape {
  return typeof value === 'string' && (SHAPES as readonly string[]).includes(value);
}
export function isMascotEyes(value: unknown): value is MascotEyes {
  return typeof value === 'string' && (EYES as readonly string[]).includes(value);
}
export function isMascotAccessory(value: unknown): value is MascotAccessory {
  return typeof value === 'string' && (ACC as readonly string[]).includes(value);
}
/** A colour of `LOOK_COLORS` or any other `#rrggbb`, whatever its case (`#D4A373` is the same fur). */
export function isLookColor(value: unknown): value is string {
  return typeof value === 'string' && ((LOOK_COLORS as readonly string[]).includes(value.toLowerCase()) || CUSTOM_FUR_RE.test(value));
}

/** A product skull, or a pack's skull registered now. */
export const isLookShape = (value: unknown): value is AgentLook['shape'] => isMascotShape(value) || isRegisteredPart('shape', value);
export const isLookEyes = (value: unknown): value is AgentLook['eyes'] => isMascotEyes(value) || isRegisteredPart('eyes', value);
export const isLookAccessory = (value: unknown): value is AgentLook['acc'] => isMascotAccessory(value) || isRegisteredPart('acc', value);
/** A colour of `LOOK_COLORS` or any `#rrggbb` (any case), or a pack's fur registered now. */
export const isLookFur = (value: unknown): value is string => isLookColor(value) || isRegisteredPart('color', value);

export function isAgentLook(value: unknown): value is AgentLook {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const color = typeof v.color === 'string' && ((LOOK_COLORS as readonly string[]).includes(v.color) || CUSTOM_FUR_RE.test(v.color) || isRegisteredPart('color', v.color));
  return isLookShape(v.shape) && color && isLookEyes(v.eyes) && isLookAccessory(v.acc);
}

/**
 * A look read from somewhere that may be older, newer or hand-edited (an agent
 * config, a plugin): each field that is not valid falls back to `base`, field
 * by field, so an unknown accessory never costs the agent its skull. A pack's
 * part whose plugin is gone is one of those: the agent wears `base`'s instead
 * (the job's default, `defaultLookFor`) until the pack comes back.
 */
export function normalizeAgentLook(value: unknown, base: AgentLook = DEFAULT_LOOK, options: { keepPackIds?: boolean } = {}): AgentLook {
  const v = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  // `keepPackIds`: a pack id passes whether its pack is here or not — a row
  // read before the plugins load, or one the editor sends back whole, keeps
  // the agent's part; the drawing (`AgentMascotHost`) falls back, live.
  const pack = (type: 'shape' | 'color' | 'eyes' | 'acc', x: unknown): x is MascotPartId => (options.keepPackIds ? isMascotPartId(x) : isRegisteredPart(type, x));
  return {
    shape: isMascotShape(v.shape) || pack('shape', v.shape) ? v.shape as AgentLook['shape'] : base.shape,
    color: isLookColor(v.color) ? v.color.toLowerCase() as AgentLook['color'] : pack('color', v.color) ? v.color : base.color,
    eyes: isMascotEyes(v.eyes) || pack('eyes', v.eyes) ? v.eyes as AgentLook['eyes'] : base.eyes,
    acc: isMascotAccessory(v.acc) || pack('acc', v.acc) ? v.acc as AgentLook['acc'] : base.acc,
  };
}

/**
 * The `#rrggbb` a look's colour paints: the colour itself, or a pack fur's
 * hex. A fur whose pack is gone paints the default bark.
 */
export function lookFurHex(color: string): string {
  const fur = mascotPartOf('color', color);
  if (fur) return fur.hex.toLowerCase();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_LOOK.color;
}

/** i18n keys of the pickers' labels (`app/src/locales/<tag>/mascot.json`). */
export const shapeLabelKey = (shape: MascotShape): string => `mascot.shape.${shape}`;
export const eyesLabelKey = (eyes: MascotEyes): string => `mascot.eyes.${eyes}`;
export const accessoryLabelKey = (acc: MascotAccessory): string => `mascot.acc.${acc}`;
/** A colour the lists do not name is "Custom". */
export const furLabelKey = (color: string): string => `mascot.fur.${FUR_NAMES[color.toLowerCase()] ?? 'custom'}`;

/* ---------- Default looks: what an agent wears before anyone styles it ---------- */

/** What an agent is for, as the onboarding asks it. */
export const MISSIONS = ['mail', 'agenda', 'code', 'watch', 'write', 'research'] as const;
export type MascotMission = typeof MISSIONS[number];

/** The developer roles (task types) the onboarding offers. */
export const ROLES = ['orchestrator', 'code', 'review', 'research', 'chore'] as const;
export type MascotRole = typeof ROLES[number];

/** Skull and colour by first mission. */
export const MLOOK: Readonly<Record<MascotMission, readonly [MascotShape, MascotColor]>> = {
  mail: ['squircle', '#ff5fbf'],
  agenda: ['round', '#3fa9ff'],
  code: ['tri', '#7ed957'],
  watch: ['hex', '#ffc233'],
  write: ['cloud', '#ff8a2a'],
  research: ['gem', '#a35bff'],
};
/** Accessory by first mission. */
export const MACC: Readonly<Record<MascotMission, MascotAccessory>> = {
  mail: 'envelope', agenda: 'calendar', code: 'coffee', watch: 'telescope', write: 'quill', research: 'loupe',
};
/** Accessory by developer role. */
export const DACC: Readonly<Record<MascotRole, MascotAccessory>> = {
  code: 'coffee', research: 'loupe', review: 'pen', orchestrator: 'baton', chore: 'hammer',
};
const ROLE_EYES: Readonly<Record<MascotRole, MascotEyes>> = {
  code: 'code', research: 'big', review: 'squint', orchestrator: 'pill', chore: 'pill',
};
/** The agent's `config.role` names (`app/src/lib/roles.ts`) that mean a developer role above. */
const ROLE_ALIASES: Readonly<Record<string, MascotRole>> = { coder: 'code', reviewer: 'review', ops: 'chore' };

const isMission = (value: string): value is MascotMission => (MISSIONS as readonly string[]).includes(value);

/** An assistant that handles both mail and agenda holds a clipboard; otherwise the first mission's tool. */
export function accFor(missions: readonly MascotMission[]): MascotAccessory {
  if (missions.includes('mail') && missions.includes('agenda')) return 'clipboard';
  const first = missions[0];
  return first ? MACC[first] : 'none';
}

function lookForMissions(input: readonly string[]): AgentLook {
  const missions = input.filter(isMission);
  const first = missions[0];
  const [shape, color] = first ? MLOOK[first] : ['squircle', '#a35bff'] as const;
  return { shape, color, eyes: first === 'code' ? 'code' : 'pill', acc: accFor(missions) };
}

function lookForRole(input: string): AgentLook {
  const role = (ROLES as readonly string[]).includes(input) ? input as MascotRole : ROLE_ALIASES[input];
  if (!role) return { ...DEFAULT_LOOK };
  // The coder alone gets its own skull and colour; the other roles keep the
  // default head and say their job with eyes and tool.
  const head: Pick<AgentLook, 'shape' | 'color'> = role === 'code' ? { shape: 'tri', color: '#7ed957' } : { shape: DEFAULT_LOOK.shape, color: DEFAULT_LOOK.color };
  return { ...head, eyes: ROLE_EYES[role], acc: DACC[role] };
}

/**
 * The look an agent gets before anyone styles it: from its developer role
 * (`'code'`, `'review'`… or the agent's `config.role` — `coder`, `reviewer`,
 * `ops`), or from the list of its missions (`['mail', 'agenda']`). Unknown
 * values fall back to a default look; never throws.
 */
export function defaultLookFor(roleOrMissions: string | readonly string[]): AgentLook {
  return typeof roleOrMissions === 'string' ? lookForRole(roleOrMissions) : lookForMissions(roleOrMissions);
}
