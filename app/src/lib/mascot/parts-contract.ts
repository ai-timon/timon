/**
 * The mascot pack contract (client API 15), as the browser half of the product
 * reads it: the parts a plugin registers in `mascot.parts` and the guards
 * they pass before anything draws them (docs/AGENT-MASCOT.md, "Mascot packs").
 *
 * The types mirror `@timon-ai/sdk` (`packages/sdk/src/index.ts`) instead of
 * importing it: the app is built on its own, like `dictation/contract.ts`.
 * `app/sdk-guards/sdk-mirrors.ts` holds the copies to the SDK.
 *
 * A part is data: a skull is four numbers, a fur a colour, eyes are
 * outlines, an accessory is SVG markup. The markup is read by the strict
 * reader below, which keeps a short list of shapes and presentation
 * attributes and refuses everything else — scripts, event handlers, links,
 * styles, external references. What it keeps becomes React elements: no
 * markup string is ever put in the page as HTML.
 *
 * One exception is code: a shape may carry a `head` component instead of a
 * skull. It is the pack's own browser code, which already runs in the page
 * (like an `agent.mascot` occupant), so there is nothing to sanitise: the
 * host only draws it for the agents that wear that shape, inside an error
 * boundary, and Timon's head comes back when it throws or its pack leaves.
 */

export const MASCOT_PARTS_SLOT = 'mascot.parts';

export const MASCOT_PART_TYPES = ['shape', 'color', 'eyes', 'acc'] as const;
export type MascotPartType = typeof MASCOT_PART_TYPES[number];

/** A part's slug, as its manifest declares it (`timon.mascot`): the id is `<pluginId>:<slug>`. */
export const MASCOT_PART_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The id a look stores; same rule as the daemon's `MASCOT_PART_ID_RE`. */
export const MASCOT_PART_ID_RE = /^[a-z0-9-]{3,40}:[a-z0-9][a-z0-9-]{0,39}$/;
export type MascotPartId = `${string}:${string}`;

export function isMascotPartId(value: unknown): value is MascotPartId {
  return typeof value === 'string' && MASCOT_PART_ID_RE.test(value);
}

/** A name for the pickers: one string, or one per language tag (`{ en: 'Cap', fr: 'Casquette' }`). */
export type MascotPartLabel = string | Readonly<Record<string, string>>;

/** A point of an eye outline, in eye units: the screen is 29 high, an eye about 12. */
export type MascotPoint = readonly [number, number];

/** The bounds of a skull, so that ears, mask, screen and accessory still land on it. */
export const SKULL_BOUNDS = {
  top: [56, 96],
  bottom: [56, 96],
  height: [48, 84],
  radius: [4, 40],
} as const satisfies Record<string, readonly [number, number]>;

/** An eye point stays within this distance of the eye's centre, or it leaves the screen. */
export const EYE_EXTENT = 9;
export const EYE_MIN_POINTS = 3;
export const EYE_MAX_POINTS = 128;
export const MAX_ACC_SVG_LENGTH = 16_384;
export const MAX_ACC_ELEMENTS = 200;
export const MAX_ACC_DEPTH = 12;
export const MAX_LABEL_LENGTH = 40;

/** A head a pack draws itself: no props, it reads `useAgentMascot()` like an `agent.mascot` occupant. */
export type MascotHeadComponent = (props: Record<string, never>) => unknown;

export type MascotPart =
  | {
    type: 'shape';
    label: MascotPartLabel;
    /** Top width, bottom width, height and corner radius, in the 100×100 box whose head sits on y = 92. */
    skull: { top: number; bottom: number; height: number; radius: number };
    head?: never;
  }
  | {
    type: 'shape';
    label: MascotPartLabel;
    /** The whole head of an agent wearing this shape, drawn by the pack instead of Timon. */
    head: MascotHeadComponent;
    skull?: never;
  }
  | {
    type: 'color';
    label: MascotPartLabel;
    /** `#rrggbb`; blended into fur like every dyed colour, so the head stays a plush. */
    hex: string;
  }
  | {
    type: 'eyes';
    label: MascotPartLabel;
    /** The left eye, a closed outline centred on (0, 0). */
    left: readonly MascotPoint[];
    /** The right eye; absent: the left one mirrored. */
    right?: readonly MascotPoint[];
    /** A glyph between the eyes (`code`'s slash); absent: none. */
    middle?: readonly MascotPoint[];
    /** `false`: drawn or closed eyes, which never blink. Default `true`. */
    blink?: boolean;
  }
  | {
    type: 'acc';
    label: MascotPartLabel;
    /** SVG shapes drawn around (0, 0) in a box of about 32 × 32 — no `<svg>` root. */
    svg: string;
    /** Degrees the tool is tilted by in the paw, -90 to 90. Default 0. */
    tilt?: number;
  };

/* ---------- The SVG reader ---------- */

/** One element the reader kept, its attributes already React props. */
export type MascotSvgNode = { tag: MascotSvgTag; props: Readonly<Record<string, string>>; children: readonly MascotSvgNode[] };

const TAGS = ['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'] as const;
export type MascotSvgTag = typeof TAGS[number];

/** Presentation and geometry only; `style`, `href`, `class`, `id` and every `on*` are not here. */
const ATTRIBUTES: Readonly<Record<string, string>> = {
  d: 'd', x: 'x', y: 'y', width: 'width', height: 'height', rx: 'rx', ry: 'ry', cx: 'cx', cy: 'cy', r: 'r',
  x1: 'x1', y1: 'y1', x2: 'x2', y2: 'y2', points: 'points', transform: 'transform',
  fill: 'fill', stroke: 'stroke', opacity: 'opacity',
  'fill-opacity': 'fillOpacity', 'stroke-opacity': 'strokeOpacity', 'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap', 'stroke-linejoin': 'strokeLinejoin', 'stroke-dasharray': 'strokeDasharray',
  'stroke-miterlimit': 'strokeMiterlimit', 'fill-rule': 'fillRule', 'clip-rule': 'clipRule',
};

/**
 * A value may only draw: numbers, path commands, colours, a transform. Any
 * reference out of the attribute — `url(…)`, a scheme, an entity, a quote —
 * is refused, so a part can neither fetch nor point at anything.
 */
const SAFE_VALUE = /^[a-zA-Z0-9#.,\s%+\-()]*$/;
const FUNCTION_IN_VALUE = /([a-zA-Z-]+)\s*\(/g;
const ALLOWED_FUNCTIONS = new Set(['matrix', 'translate', 'rotate', 'scale', 'skewx', 'skewy', 'rgb', 'rgba', 'hsl', 'hsla']);

export type SvgReadResult = { ok: true; nodes: MascotSvgNode[] } | { ok: false; reason: string };

class Refused extends Error {}

/**
 * Reads the markup of a pack's accessory. A whitelist: anything this does not
 * know how to read is refused with its reason, never skipped — a skipped
 * `<script>` would be a sanitiser that guesses.
 */
export function readMascotSvg(markup: string): SvgReadResult {
  if (typeof markup !== 'string') return { ok: false, reason: 'svg must be a string' };
  if (markup.length > MAX_ACC_SVG_LENGTH) return { ok: false, reason: `svg is longer than ${MAX_ACC_SVG_LENGTH} characters` };
  let i = 0;
  let count = 0;
  function fail(reason: string): never { throw new Refused(reason); }
  const skipSpaceAndComments = (): void => {
    for (;;) {
      while (i < markup.length && /\s/.test(markup[i]!)) i += 1;
      if (markup.startsWith('<!--', i)) {
        const end = markup.indexOf('-->', i + 4);
        if (end < 0) fail('unterminated comment');
        i = end + 3;
        continue;
      }
      return;
    }
  };
  const name = (): string => {
    const m = /^[a-zA-Z][a-zA-Z0-9:_-]*/.exec(markup.slice(i, i + 64));
    if (!m) fail(`expected a name at ${i}`);
    i += m[0].length;
    return m[0];
  };
  const element = (depth: number): MascotSvgNode => {
    if (depth > MAX_ACC_DEPTH) fail(`elements nested deeper than ${MAX_ACC_DEPTH}`);
    count += 1;
    if (count > MAX_ACC_ELEMENTS) fail(`more than ${MAX_ACC_ELEMENTS} elements`);
    i += 1; // '<'
    const tag = name();
    if (!(TAGS as readonly string[]).includes(tag)) fail(`<${tag}> is not allowed (allowed: ${TAGS.join(', ')})`);
    const props: Record<string, string> = {};
    for (;;) {
      const before = i;
      while (i < markup.length && /\s/.test(markup[i]!)) i += 1;
      if (markup.startsWith('/>', i)) { i += 2; return { tag: tag as MascotSvgTag, props, children: [] }; }
      if (markup[i] === '>') { i += 1; break; }
      if (i === before) fail(`expected an attribute or the end of <${tag}> at ${i}`);
      const attr = name();
      const prop = ATTRIBUTES[attr];
      if (!prop) fail(`attribute ${attr} is not allowed on <${tag}>`);
      while (/\s/.test(markup[i] ?? '')) i += 1;
      if (markup[i] !== '=') fail(`attribute ${attr} has no value`);
      i += 1;
      while (/\s/.test(markup[i] ?? '')) i += 1;
      const quote = markup[i];
      if (quote !== '"' && quote !== '\'') fail(`attribute ${attr} must be quoted`);
      const end = markup.indexOf(quote!, i + 1);
      if (end < 0) fail(`attribute ${attr} is not closed`);
      const value = markup.slice(i + 1, end);
      i = end + 1;
      if (!SAFE_VALUE.test(value)) fail(`attribute ${attr} holds a character a drawing does not need`);
      for (const call of value.matchAll(FUNCTION_IN_VALUE)) {
        if (!ALLOWED_FUNCTIONS.has(call[1]!.toLowerCase())) fail(`attribute ${attr} calls ${call[1]}(), which is not allowed`);
      }
      if (prop in props) fail(`attribute ${attr} is repeated on <${tag}>`);
      props[prop] = value;
    }
    const children = content(depth + 1);
    if (!markup.startsWith('</', i)) fail(`<${tag}> is not closed`);
    i += 2;
    const closing = name();
    if (closing !== tag) fail(`</${closing}> closes <${tag}>`);
    while (/\s/.test(markup[i] ?? '')) i += 1;
    if (markup[i] !== '>') fail(`</${tag}> is not closed`);
    i += 1;
    return { tag: tag as MascotSvgTag, props, children };
  };
  const content = (depth: number): MascotSvgNode[] => {
    const nodes: MascotSvgNode[] = [];
    for (;;) {
      skipSpaceAndComments();
      if (i >= markup.length || markup.startsWith('</', i)) return nodes;
      if (markup[i] !== '<') fail('text is not allowed in a mascot accessory');
      if (markup.startsWith('<!', i) || markup.startsWith('<?', i)) fail('declarations, CDATA and processing instructions are not allowed');
      nodes.push(element(depth));
    }
  };
  try {
    const nodes = content(0);
    if (i < markup.length) fail(`unexpected ${markup.slice(i, i + 12)}`);
    if (!nodes.length) fail('svg draws nothing');
    return { ok: true, nodes };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.message };
    throw err;
  }
}

/* ---------- The part guard ---------- */

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function labelProblem(label: unknown): string | null {
  const ok = (s: unknown): boolean => typeof s === 'string' && s.trim().length > 0 && s.length <= MAX_LABEL_LENGTH;
  if (typeof label === 'string') return ok(label) ? null : `label must be 1 to ${MAX_LABEL_LENGTH} characters`;
  if (typeof label !== 'object' || label === null || Array.isArray(label)) return 'label must be a string or { [languageTag]: string }';
  const values = Object.values(label);
  if (!values.length || !values.every(ok)) return `each label must be 1 to ${MAX_LABEL_LENGTH} characters`;
  return null;
}

function outlineProblem(name: string, outline: unknown): string | null {
  if (!Array.isArray(outline)) return `${name} must be a list of [x, y] points`;
  if (outline.length < EYE_MIN_POINTS || outline.length > EYE_MAX_POINTS) {
    return `${name} must have ${EYE_MIN_POINTS} to ${EYE_MAX_POINTS} points`;
  }
  for (const p of outline) {
    if (!Array.isArray(p) || p.length !== 2 || !finite(p[0]) || !finite(p[1])) return `${name} must be a list of [x, y] points`;
    if (Math.abs(p[0]) > EYE_EXTENT || Math.abs(p[1]) > EYE_EXTENT) return `${name} leaves the eye: keep x and y within ±${EYE_EXTENT}`;
  }
  return null;
}

/** Why a part cannot be drawn, or `null`. The registry refuses it with this reason. */
export function mascotPartProblem(part: unknown): string | null {
  if (typeof part !== 'object' || part === null) return 'a mascot part must be an object';
  const p = part as Record<string, unknown>;
  const label = labelProblem(p.label);
  if (label) return label;
  switch (p.type) {
    case 'shape': {
      // Either the pack draws the head itself, or Timon draws it from four numbers: never both, so what shows is never ambiguous.
      if (p.head !== undefined) {
        if (typeof p.head !== 'function') return 'head must be a component (a function)';
        return p.skull === undefined ? null : 'a shape has either skull or head, not both';
      }
      const skull = p.skull as Record<string, unknown> | undefined;
      if (typeof skull !== 'object' || skull === null) return 'a shape needs skull { top, bottom, height, radius }';
      for (const [key, [min, max]] of Object.entries(SKULL_BOUNDS)) {
        const v = skull[key];
        if (!finite(v) || v < min || v > max) return `skull.${key} must be a number from ${min} to ${max}`;
      }
      return null;
    }
    case 'color':
      return typeof p.hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.hex) ? null : 'a color needs hex: "#rrggbb"';
    case 'eyes':
      return outlineProblem('left', p.left)
        ?? (p.right === undefined ? null : outlineProblem('right', p.right))
        ?? (p.middle === undefined ? null : outlineProblem('middle', p.middle))
        ?? (p.blink === undefined || typeof p.blink === 'boolean' ? null : 'blink must be a boolean');
    case 'acc': {
      if (p.tilt !== undefined && (!finite(p.tilt) || Math.abs(p.tilt) > 90)) return 'tilt must be a number from -90 to 90';
      const read = readMascotSvg(p.svg as string);
      return read.ok ? null : `svg refused: ${read.reason}`;
    }
    default:
      return `type must be one of ${MASCOT_PART_TYPES.join(', ')}`;
  }
}

/** The label in `locale`, then its language, then English, then any; `fallback` when none. */
export function mascotPartLabel(label: MascotPartLabel, locale: string, fallback: string): string {
  if (typeof label === 'string') return label;
  const language = locale.split('-')[0] ?? locale;
  return label[locale] ?? label[language] ?? label.en ?? Object.values(label)[0] ?? fallback;
}
