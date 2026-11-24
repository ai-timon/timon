'use client';

import type { ComponentType } from 'react';
import type { IslandParams } from '@/lib/island-tree';
import { DICTATION_ENGINE_SLOT, dictationEngineProblem, type DictationEngine } from '@/lib/dictation/contract';
import { DICTATION_ENGINE_PERMISSION, clientPluginHolds } from './plugin-permissions';
import { MASCOT_PARTS_SLOT, MASCOT_PART_SLUG_RE, mascotPartProblem, type MascotPart } from '@/lib/mascot/parts-contract';
import { mascotPartDeclared } from '@/lib/mascot/parts-declarations';

export type SlotKind = 'single' | 'list' | 'keyed';
export type SlotChildren = Record<string, SlotKind>;

/**
 * What a widget registration says about itself to the placement host.
 *
 * A `*.widget` slot is a host zone: it lays the card, the handle, the cross
 * and the resize. Yet it needs three or four things only the widget's author
 * knows — what to call it, what height suits it, and whether it draws its own
 * frame. Without them, every card is named after its plugin and is 260 px.
 *
 * Everything is optional: a widget that declares none of it stays what it was
 * (`examples/plugin-widget`), framed by the host, at the default height.
 *
 * Copy of the SDK's `WidgetOptions` (the app cannot import `packages/`), held
 * to it by `app/sdk-guards/sdk-mirrors.ts`: a member added here and not
 * there, or the reverse, fails `sdk-mirrors.test.ts` unless it is host-only.
 */
export type WidgetOptions = {
  /** Card title. Failing that: the registration key, else the plugin id. */
  title?: string;
  /**
   * Zone of first placement, when the slot does not designate a single one
   * (the cockpit's two rails share `cockpit.widget`). A mere preference: a zone
   * nobody mounts leaves the card waiting for that zone.
   */
  zone?: string;
  /** Height in px as long as the user has not resized. */
  height?: number;
  /** Fill the remaining zone height by default; users can choose a fixed size. */
  heightMode?: 'fixed' | 'fill';
  /** Resize floor: below this height the widget no longer shows anything. */
  minHeight?: number;
  /**
   * `tile` (default): the host frames the component, which receives nothing.
   * `none`: the component paints its own frame and receives as props the
   * handle and the rail's classes (`WidgetProps`) — that is what the product's
   * tiles do, whose header carries a live subtitle.
   */
  frame?: 'tile' | 'none';
  /**
   * The widget can also paint itself flat, on one line: it is admitted into
   * the horizontal zones (the top bar). Without this flag, a horizontal zone
   * refuses it — a 300 px card has nothing to do in a 36 px bar.
   */
  bar?: boolean;
  /**
   * Laid in `zone` on every view that has neither placed nor removed it yet,
   * instead of waiting in the palette. Reserved for a surface that was already
   * on screen before becoming a widget: without it, it would vanish from every
   * layout already saved.
   */
  placedByDefault?: boolean;
  /**
   * Keys this widget used to register under: a place saved under one of them
   * comes back to it, rather than putting it back in its default zone under the
   * eyes of whoever had moved it elsewhere. `''` designates the registration
   * without a key (placement id `plugin:<id>`).
   */
  formerKeys?: readonly string[];
  /**
   * Routes on which this card, shown docked alone in an island
   * (`@timon/ui-layout:widget-card`), takes the whole island without its
   * header: the view is built around it, so it is neither moved nor closed
   * there. Elsewhere the island keeps its header like any other.
   */
  bareIslandOn?: readonly string[];
  /**
   * Product-internal, not part of the SDK: full placement ids a bundled
   * widget had under ANOTHER module (`plugin:@timon/kanban-code:Git` before
   * `@timon/git`, TODO #275). Honoured only for an `@timon/` registration —
   * a third-party plugin cannot claim a product card's place.
   */
  formerIds?: readonly string[];
  /**
   * The name on the widget's tab when it is stacked, where `title` would not
   * fit ("PR" for "Pull requests"). The widget window and a card alone keep
   * `title`; the tab's tooltip still shows it.
   */
  tabTitle?: string;
  /**
   * The widget publishes a count (`useWidgetCount`) or a dot
   * (`useWidgetAttention`) for its tab. In a stack the host keeps it mounted,
   * hidden, behind the tab in front, so its tab stays true; it must then keep
   * quiet until it comes to the front (`useWidgetInFront`).
   */
  liveCount?: boolean;
  /**
   * One sentence on what the widget does, shown under its name in the widget
   * window. Say what it shows or lets you do, not how it is built.
   */
  description?: string;
  /**
   * What the widget window calls it, when `title` is the user's own (one chat
   * card per agent): "Agent chat" rather than the agent's name.
   */
  catalogTitle?: string;
  /**
   * Picto shown on the widget's card in the widget window: SVG markup
   * (`<svg …>`) or the URL of an SVG. Painted as a mask in the theme's text
   * colour, so only its shape counts — a 24×24 line drawing reads best.
   */
  icon?: string;
};

/**
 * What a content of the island workspace (`island.content`) says about
 * itself (`docs/ISLAND-WORKSPACE.md` §5). Its type id is `<pluginId>:<key>`,
 * computed by the host: two plugins may both use the key `view`.
 */
/**
 * One param of a content type, as an agent reads it (`islands_get`) and the
 * daemon checks a proposal against it. Declarative only — no regular
 * expression: the declaration travels to the daemon, `parseParams` stays the
 * last word in the browser.
 */
export type IslandParamSpec = {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  nullable?: boolean;
  /** What the param means, for an agent composing a layout. */
  description?: string;
  enum?: readonly string[];
  maxLength?: number;
  min?: number;
  max?: number;
};

export type IslandContentOptions = {
  /** What the tab and its menus show until the content sets its own title. */
  title: string;
  /** SVG markup, same rules as `WidgetOptions.icon`: the picto at the left of the tab. */
  icon?: string;
  /**
   * Draws the tab's picto from its params instead of `icon` — an agent's chat
   * wears that agent's avatar. Rendered at 16 px; it must fill `className`.
   */
  tabIcon?: ComponentType<{ params: IslandParams; className?: string }>;
  /**
   * Validates and cleans params read from storage or handed by another
   * plugin. `null` = refused. Mandatory: a stored value is opaque.
   */
  parseParams: (raw: unknown) => IslandParams | null;
  /**
   * The params `parseParams` accepts, described for an agent. Absent: an agent
   * may still open the type, and `parseParams` alone decides.
   */
  params?: Readonly<Record<string, IslandParamSpec>>;
  /** Params that are a day's state, dropped from a named preset (§4). */
  volatileParams?: readonly string[];
  /**
   * At most one live tab per value of this param (a terminal session, a browser
   * profile), or per combination of these params (a file: its agent and path).
   * Absent: one tab per identical set of params.
   */
  singletonBy?: string | readonly string[];
  /** Stays mounted, hidden, while its tab is not the visible one. Default: unmounted. */
  keepMounted?: boolean;
  /**
   * Group of contents of which only ONE instance is primary at a time — the
   * chat's widget zones (Q10). The workspace picks it (`useIslandContent().primary`):
   * the focused one, else the previous, else the route's page if the host
   * enrolled it. Absent = always primary.
   */
  exclusive?: string;
  /**
   * Docked alone in an island, the tab paints no header: no title, tab bar,
   * menu, move handle nor close — the content is the whole island. `route` is
   * the path of the view the workspace shows. Never applied to a popup, which
   * needs its handle to be moved back. Absent = a header, as every island.
   * Product-internal: not published in the SDK.
   */
  bare?: (params: IslandParams, view: { route: string }) => boolean;
  /** px, default 280. */
  minWidth?: number;
  /** px, default 160. */
  minHeight?: number;
  /** Reopens this content in its own window ("Detach"). Absent = no Detach. */
  detach?: (params: IslandParams) => void;
  /**
   * A param naming what tabs of this type belong to (a terminal's scope):
   * opening one lands in the island that already holds a tab of the type with
   * the same value, rather than in a new one.
   */
  groupBy?: string;
  /** The "+" of the island's tab bar: makes the params of one more tab, or `null` to refuse. Absent = no "+". */
  newTab?: (params: IslandParams) => Promise<IslandParams | null>;
  /**
   * The user asks to close the tab (its ×, middle click, Delete, menu, or its
   * island's close): `false` keeps it open — unsaved changes the user chose to
   * keep. A promise may ask first; one that throws or rejects keeps the tab
   * too. Agreeing is not closing: an island asks each of its tabs in turn and
   * any later one may still keep them all, so drop state in `onClose`, never
   * here. Not called when the tab moves, nor when the content or the host
   * closes it itself. An arrangement replacing the tab (a recall, a preset
   * applied to every project, an agent's card) asks too, and a refusal cancels
   * the whole arrangement — also on a page not on screen, where the tab is not
   * mounted (`lib/island-release.ts`).
   */
  beforeClose?: (params: IslandParams, tabId: string) => boolean | Promise<boolean>;
  /**
   * The tab closed, whoever closed it: end what it held (kill a shell, drop a
   * draft). Not called when the tab moves. May run while the tab is not
   * mounted (an arrangement written over a page not on screen).
   */
  onClose?: (params: IslandParams, tabId: string) => void;
};

/**
 * What a page (`page` slot) asks of the island workspace that paints it.
 * Host-only: the product's own views read as native pages; nothing here is
 * promised to a third party yet.
 */
export type PageOptions = {
  /**
   * `false`: a click in an island of this view does not ring the island it
   * lands in. The view reads as one page, not a set of panes to pick from;
   * the keyboard focus stays drawn on the element that holds it.
   */
  focusRing?: boolean;
  /**
   * The route's island paints no tab bar while it holds this page alone: the
   * view reads as a page of the app, not as a tab of the workspace. A second
   * tab dropped in it brings the bar back, to pick and close tabs with.
   */
  bareRoute?: boolean;
};

export type SlotEntry = {
  id: string;
  pluginId: string;
  key?: string;
  widget?: WidgetOptions;
  island?: IslandContentOptions;
  /** See `RegisterOptions.page`. */
  page?: PageOptions;
  /** The engine of a `dictation.engine` entry; see `RegisterOptions.dictation`. */
  dictation?: DictationEngine;
  /** The part of a `mascot.parts` entry, checked; see `RegisterOptions.mascotPart`. */
  mascotPart?: MascotPart;
  /** See `RegisterOptions.fallback`. */
  fallback?: boolean;
  /** Sort rank inside a list slot. See `RegisterOptions.order`. */
  order: number;
  /** Registration rank, used to break ties between equal orders. */
  seq: number;
  Component: ComponentType;
};

type Slot = { kind: SlotKind; owner: string; entries: Map<string, SlotEntry> };
type Registration = {
  id: string;
  slot: string;
  childSlots: string[];
  disposed: boolean;
};

const slots = new Map<string, Slot>();
const registrations = new Map<string, Registration>();
const listeners = new Set<() => void>();
let sequence = 0;
let version = 0;

function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function declareSlot(name: string, kind: SlotKind, owner = 'runtime'): () => void {
  if (slots.has(name)) throw new Error(`Slot already declared: ${name}`);
  slots.set(name, { kind, owner, entries: new Map() });
  publish();
  return () => collapseSlot(name, owner);
}

function collapseSlot(name: string, owner: string): void {
  const slot = slots.get(name);
  if (!slot || slot.owner !== owner) return;
  for (const entry of [...slot.entries.values()]) disposeRegistration(entry.id);
  slots.delete(name);
  publish();
}

export type RegisterOptions = {
  slot: string;
  pluginId: string;
  key?: string;
  /** Read by the placement host when the slot is of `widget` nature. */
  widget?: WidgetOptions;
  /** Read by the island workspace when the slot is `island.content`. */
  island?: IslandContentOptions;
  /** Read by the island workspace for the `page` entry of the route on screen. */
  page?: PageOptions;
  /**
   * The speech-to-text engine of a `dictation.engine` entry (client API 14);
   * the component is its settings panel. Mandatory there, refused anywhere
   * else, and only for a plugin that holds `dictation:engine`.
   */
  dictation?: DictationEngine;
  /**
   * A part of a mascot pack (client API 15): a skull, a fur, eyes or an
   * accessory, as data. Read for `mascot.parts` only, where it is mandatory
   * with a `key` — the part's slug, which the plugin's manifest must declare
   * for that type (`timon.mascot`). Its entry is keyed `<pluginId>:<key>`, the
   * id a look stores. The component is not painted there and may be left out.
   */
  mascotPart?: MascotPart;
  /**
   * Where the entry sits in a list slot. Lower comes first.
   *
   * A nav rail is a list whose ORDER carries meaning — Cockpit above Brain,
   * the secondary group below the divider — and registration order cannot
   * carry it: a bundled half registers synchronously while a third-party
   * bundle lands after an async import, so the painted order would depend on
   * the network. An entry that says nothing sorts last, which keeps the rule
   * every zone had until now: what the product ships, then what plugins add.
   */
  order?: number;
  /**
   * Default occupant of a `single` slot: it paints while nobody claims the
   * slot, and steps aside the moment somebody does.
   *
   * A `single` slot is the shape of a surface there can only be one of — the
   * composer, the chrome. Without a default, the product would have to occupy
   * it itself, and a plugin declaring it would be refused for the only reason
   * that the product got there first: replacing the composer would mean
   * switching the chat off. The registry therefore holds at most two entries,
   * and paints the claimed one; the default returns as soon as the plugin is
   * disposed.
   */
  fallback?: boolean;
  children?: SlotChildren;
};

/**
 * Why a `dictation.engine` registration is refused, or null. Checked here and
 * not in the loader alone: a bundled half registers through the same call,
 * and holds the permission only if its `BundledClientPlugin` declares it.
 */
function dictationRefusal(options: RegisterOptions, slot: Slot): string | null {
  if (options.slot !== DICTATION_ENGINE_SLOT) {
    return options.dictation === undefined ? null : `\`dictation\` is read for \`${DICTATION_ENGINE_SLOT}\` only (slot: ${options.slot})`;
  }
  if (!clientPluginHolds(options.pluginId, DICTATION_ENGINE_PERMISSION)) {
    return `plugin \`${options.pluginId}\` needs the \`${DICTATION_ENGINE_PERMISSION}\` permission in its manifest (timon.permissions) to register a dictation engine`;
  }
  const engine = options.dictation;
  const problem = dictationEngineProblem(engine);
  if (problem || !engine) return `plugin \`${options.pluginId}\`: invalid dictation engine — ${problem}`;
  // The route names an engine by its id (`engine:<id>`): two of them would be one route.
  if ([...slot.entries.values()].some((entry) => entry.dictation?.id === engine.id)) {
    return `dictation engine \`${engine.id}\` is already registered`;
  }
  return null;
}

/**
 * Why a `mascot.parts` registration is refused, or null. A part is drawn in
 * every agent's head that wears it: its data is checked here, once, and its
 * markup read by the strict SVG reader (`parts-contract.ts`).
 */
function mascotPartRefusal(options: RegisterOptions): string | null {
  if (options.slot !== MASCOT_PARTS_SLOT) {
    return options.mascotPart === undefined ? null : `\`mascotPart\` is read for \`${MASCOT_PARTS_SLOT}\` only (slot: ${options.slot})`;
  }
  const key = options.key;
  if (typeof key !== 'string' || !MASCOT_PART_SLUG_RE.test(key)) {
    return `plugin \`${options.pluginId}\`: a mascot part needs a \`key\`, its slug (a-z, 0-9 and \`-\`, up to 40 characters)`;
  }
  const problem = mascotPartProblem(options.mascotPart);
  if (problem) return `plugin \`${options.pluginId}\`: mascot part \`${key}\` refused — ${problem}`;
  const type = options.mascotPart!.type;
  if (!mascotPartDeclared(options.pluginId, type, key)) {
    return `plugin \`${options.pluginId}\`: mascot part \`${key}\` is not declared as \`${type}\` in its manifest (timon.mascot.${type}), so the daemon would refuse it in a look`;
  }
  return null;
}

/** A component for an entry that is data only (a mascot part): it is never painted. */
const NOTHING: ComponentType = () => null;

export function register(options: RegisterOptions, Component: ComponentType = NOTHING): () => void {
  const slot = slots.get(options.slot);
  if (!slot) throw new Error(`Slot not declared: ${options.slot}`);
  const refusal = dictationRefusal(options, slot) ?? mascotPartRefusal(options);
  if (refusal) throw new Error(refusal);
  warnDeprecatedSlot(options);
  const id = `${options.pluginId}:${++sequence}`;
  // Two packs may both call a part `cap`: the id a look stores is namespaced.
  const entryKey = options.slot === MASCOT_PARTS_SLOT
    ? `${options.pluginId}:${options.key}`
    : slot.kind === 'keyed' ? options.key ?? options.pluginId : id;
  if (slot.kind === 'single') {
    const rival = [...slot.entries.values()].some((e) => !!e.fallback === !!options.fallback);
    if (rival) {
      throw new Error(options.fallback
        ? `Default occupant already registered: ${options.slot}`
        : `Single slot already taken: ${options.slot}`);
    }
  }
  if (slot.kind === 'keyed' && slot.entries.has(entryKey)) {
    throw new Error(`Key already taken in ${options.slot}: ${entryKey}`);
  }

  const childSlots: string[] = [];
  try {
    for (const [name, kind] of Object.entries(options.children ?? {})) {
      const existing = slotKind(name);
      // The host already declared layout children (`page`, …) when the
      // product chrome is on. A chosen layout that names the same slots
      // must still occupy `root`; taking ownership would throw and leave
      // it unmounted (MULTI-THEME.md T.4). Skip, do not collapse later.
      if (existing === kind) continue;
      declareSlot(name, kind, id);
      childSlots.push(name);
    }
  } catch (error) {
    for (const name of childSlots.reverse()) collapseSlot(name, id);
    throw error;
  }

  slot.entries.set(entryKey, {
    id, pluginId: options.pluginId, key: options.key, Component,
    widget: options.widget, island: options.island, page: options.page, dictation: options.dictation, mascotPart: options.mascotPart, fallback: options.fallback,
    order: options.order ?? Number.POSITIVE_INFINITY, seq: sequence,
  });
  registrations.set(id, { id, slot: options.slot, childSlots, disposed: false });
  publish();
  return () => disposeRegistration(id);
}

function disposeRegistration(id: string): void {
  const registration = registrations.get(id);
  if (!registration || registration.disposed) return;
  registration.disposed = true;
  for (const name of [...registration.childSlots].reverse()) collapseSlot(name, id);
  const slot = slots.get(registration.slot);
  if (slot) {
    for (const [key, entry] of slot.entries) {
      if (entry.id === id) slot.entries.delete(key);
    }
  }
  registrations.delete(id);
  publish();
}

export function slotEntries(name: string): readonly SlotEntry[] {
  return [...(slots.get(name)?.entries.values() ?? [])]
    .sort((a, b) => {
      // A default occupant always sorts last, whatever its rank: what paints a
      // `single` slot is its first entry, and the default is only there for
      // want of a claimant.
      if (!a.fallback !== !b.fallback) return a.fallback ? 1 : -1;
      return a.order === b.order ? a.seq - b.seq : a.order - b.order;
    });
}

/** The entry a keyed slot holds under `key`, or `null`. */
export function slotEntry(name: string, key: string): SlotEntry | null {
  const slot = slots.get(name);
  if (!slot || slot.kind !== 'keyed') return null;
  return slot.entries.get(key) ?? null;
}

/**
 * Slots declared at this instant.
 *
 * The registry is the source of truth of placement (§10.12): without an
 * enumeration, nobody can know which `*.widget` zones exist, and the widget
 * host would fall back on a hard-coded list — exactly the parallel table
 * being removed.
 */
export function slotNames(): string[] {
  return [...slots.keys()];
}

export function slotKind(name: string): SlotKind | null {
  return slots.get(name)?.kind ?? null;
}

export function subscribeSlots(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function slotVersion(): number {
  return version;
}

/**
 * Slot of the HTML documents of a conversation (MCPUI, client API 9).
 *
 * A boot slot, like `root`: a plugin that replaces the document card
 * registers when the plugins load, long before any document is in a thread,
 * and the loader never applies it again. Declared by the cards themselves,
 * the slot did not exist yet at that moment — and collapsed with the last
 * card, taking the replacement with it for good.
 */
export const CHAT_DOCUMENT_SLOT = 'chat.document';

/**
 * Slot of the images and videos an agent shows (`chat_show_media`). A boot
 * slot for the same reason as `chat.document`: the cards used to declare it
 * with a counter and collapse it with the last one, so a replacement loaded
 * before any card failed on an undeclared slot, and one registered lost its
 * place when the last card left.
 */
export const CHAT_MEDIA_SLOT = 'chat.media';

/**
 * Slot of the model selector (`docs/MODEL-PICKER.md` §7): every
 * `ModelPickerPanel` / `ModelPickerPopover` of the UI paints its occupant. A
 * boot slot like `chat.document`: a replacement registers when the plugins
 * load, before any form with a picker is open, and keeps its place however
 * many pickers come and go — the composer of each conversation, a task form, a
 * card all mount and unmount theirs independently.
 */
export const MODEL_PICKER_SLOT = 'model.picker';

/**
 * Slot of the provider cards (TODO #251): the AI CLIs of the product's
 * providers, their installer, sign-in and updates. Painted by every
 * `ProviderCliCards` host — the onboarding's "Your AIs" step, its "cannot
 * start" screen and Settings › AI models. A boot slot like `model.picker`:
 * a replacement registers when the plugins load, before any host is on screen.
 */
export const PROVIDER_CLI_SLOT = 'providers.cli';

/**
 * Slot of one provider's row (client API 16): logo, name, its one status line,
 * "Update available" and the way to its page. Painted by every `ProviderRow`
 * host — the providers list of Settings › AI models and the onboarding's
 * "Your AIs" step — so a replacement changes the row on both at once. A boot
 * slot like `providers.cli`.
 */
export const PROVIDER_ROW_SLOT = 'providers.row';

/**
 * Slot of the task form: the creation and edition of a Kanban task, opened
 * from the board, the Agents page and the agents grid. Painted by every
 * `TaskFormModal` host. A boot slot like `model.picker`: a replacement
 * registers when the plugins load, before any form is open.
 */
export const TASK_FORM_SLOT = 'task.form';

/**
 * Slot of the folder browser (TIM-0136): the folders of the active machine's
 * daemon, opened by "Browse…" in Settings, a project or an agent whenever
 * this computer's OS dialog would pick the wrong disk. Painted by every
 * `useDirectoryPicker()` host. A boot slot like `task.form`: a replacement
 * registers when the plugins load, before any form is open.
 */
export const DIRECTORY_PICKER_SLOT = 'directory.picker';

/**
 * Slot of the confirmation dialog (TODO #781): every "Are you sure?" of the
 * app — stopping a mission, deleting a task, a secret, an agent — asked with
 * `confirmAction()` instead of the browser's `confirm()`. Painted by the one
 * host mounted in `app/layout.tsx`. A boot slot like `task.form`: a
 * replacement registers when the plugins load, before anything is asked.
 */
export const CONFIRM_DIALOG_SLOT = 'confirm.dialog';

/**
 * Slot of an app card of the Apps catalogue (`/apps`, TODO #832): every card
 * of the page paints its occupant, each with its own app. A boot slot like
 * `confirm.dialog`: a replacement registers when the plugins load, before the
 * page is open, and the product's card comes back when it leaves.
 */
export const APP_CARD_SLOT = 'apps.card';

/**
 * Slot of the secret requests of a conversation (`secret_request`): the card
 * with the masked field an agent's request opens. A boot slot like
 * `chat.document`: a replacement registers when the plugins load, before any
 * request is in a thread. The occupant reads `useSecretRequest()` and answers
 * through it — the value goes from there to the vault, never through the slot.
 */
export const CHAT_SECRET_REQUEST_SLOT = 'chat.secret';

/**
 * Slot of a Kanban item's tile (TODO #837): one TO DO idea or one task, in a
 * board column (`card`) or a TO DO widget's list (`row`). One slot for both
 * natures — the occupant reads `useKanbanCard()`, a union on `kind`. A boot
 * slot like `apps.card`: a replacement registers when the plugins load,
 * before the board is open, and the product's tiles come back when it leaves.
 */
export const KANBAN_CARD_SLOT = 'kanban.card';

/**
 * Slot of the TO DO idea form (TODO #837), the twin of `task.form`: the
 * creation and edition of an idea, opened from the Kanban column and the TO DO
 * widgets. Painted by every `TodoFormModal` host. A boot slot like
 * `task.form`: a replacement registers when the plugins load, before any form
 * is open.
 */
export const TODO_FORM_SLOT = 'todo.form';

/**
 * Slot of the landing badge of a TO DO idea (client API 19): where the branch
 * of its jobs stands — pull request not created, open, merged, closed — in
 * every place the idea's badges show. The occupant reads the idea, its
 * `landing` included, from `useTodoItem()`. A boot slot like `kanban.card`: a
 * replacement registers when the plugins load, and the product's badge comes
 * back when it leaves.
 */
export const TODO_LANDING_SLOT = 'kanban.todo.landing';

/**
 * Slot of a Kanban job's dialog: what the job brings (diff, commits,
 * pre-checks) and its links — the ideas it carries, their issues, the mission
 * that pilots it, its branch and target. Opened from the Jobs widget, the
 * landing badge of a TO DO idea and the Pull requests widget. The occupant
 * reads `useJobDialog()` (client API 19) and draws the whole window, closing
 * it through `close()`. A boot slot like `todo.form`: the product's dialog is
 * the fallback and comes back when a replacement leaves.
 */
export const JOB_DIALOG_SLOT = 'kanban.job.dialog';

/**
 * Slot of the "Publish on GitHub" dialog, the one way a text reaches the
 * forge (`docs/FORGE-FLOW-PLAN.md` §3.3): the exact text, editable, where it
 * goes and as which account, then Publish or Do not publish. Opened from a
 * job's row, a pull request's row and the notification card of a proposal.
 * The occupant reads `usePublishDialog()` (client API 19) and draws the
 * window; the host keeps the calls to the daemon, which publishes only for a
 * signed-in person. A boot slot like `todo.form`.
 */
export const PUBLISH_DIALOG_SLOT = 'forge.publish.dialog';

/**
 * Slot of the rows plugins add to a project's settings (client API 19), in the
 * project's window under "Integrations": one row each, a title and a status on
 * the left, one action on the right, the rest in a "…" menu. The occupant reads
 * the project from `useProjectSettings()`. A list: every plugin brings its own
 * row, and nothing is painted while none does.
 */
export const PROJECT_SETTINGS_SLOT = 'project.settings';

/**
 * Slot of the table of contents of a long list page (the Skills and MCP tabs
 * of Capabilities): the sticky column on the left that jumps to a section.
 * Every page that has one paints its occupant, which reads `usePageToc()`. A
 * boot slot like `apps.card`: a replacement registers when the plugins load,
 * before the page is open, and the product's table comes back when it leaves.
 */
export const PAGE_TOC_SLOT = 'page.toc';

/**
 * Deprecated since client API 17 (docs/SDK-COMPAT.md §115): the slot of the
 * former "new version" banner at the top of the page. A newer Timon is now a
 * notice card of `@timon/updates` (`notices`). Still declared, so a plugin
 * that registers here loads, but nothing paints it any more: its author is
 * told so once, in the console.
 */
export const UPDATES_BANNER_SLOT = 'updates.banner';

/** Slots still declared but no longer painted, with where their occupants went. */
const DEPRECATED_SLOTS: Readonly<Record<string, string>> = {
  [UPDATES_BANNER_SLOT]: 'a newer Timon is a notice card now: push your own with `ctx.notices`, or restyle every card through `notices.card`',
};
const deprecationTold = new Set<string>();

function warnDeprecatedSlot(options: RegisterOptions): void {
  const instead = DEPRECATED_SLOTS[options.slot];
  const told = `${options.pluginId}:${options.slot}`;
  if (!instead || deprecationTold.has(told)) return;
  deprecationTold.add(told);
  console.warn(`plugin \`${options.pluginId}\`: the \`${options.slot}\` slot is deprecated and no longer painted — ${instead}`);
}

/**
 * Slot of the notice sources (docs/NOTICES.md): the bottom-left cards of the
 * product — a new version, a build about to end, a GitHub star. Each entry is
 * mounted once by `NoticesHost`, paints nothing, and pushes its cards with
 * `useNotices()`; a rule that needs React state lives there. A plugin with
 * nothing to watch pushes from `apply` with `ctx.notices.push` instead. A
 * boot slot: a source registers when the plugins load.
 */
export const NOTICES_SLOT = 'notices';

/**
 * Slot of ONE notice card, painted by `NoticesHost` once per visible notice.
 * The occupant reads `useNotice()` — the notice, its gestures — and only
 * paints; the host decides which cards show, how many, and remembers the
 * closed ones. A boot slot like `confirm.dialog`: the product's card is the
 * fallback and comes back when a replacement leaves.
 */
export const NOTICE_CARD_SLOT = 'notices.card';

/**
 * Slot of the update window (docs/AUTO-UPDATE.md §10): "Timon x.y.z", the
 * release's highlights, the changelog link, the download and "Restart and
 * install". Opened by `openUpdateDialog()` — the update card, Settings ›
 * System › Updates. The occupant reads `useUpdateDialog()` and only paints;
 * the host keeps the dialog and the update flow. A boot slot like
 * `confirm.dialog`: the product's window (client half of `@timon/updates`)
 * is the fallback and comes back when a replacement leaves.
 */
export const UPDATE_DIALOG_SLOT = 'updates.dialog';

/**
 * Slot of the agent's mascot (docs/AGENT-MASCOT.md): the plush meerkat head
 * whose screen shows the agent's eyes, in the onboarding, the agent creation
 * and the chat. Painted by every `AgentMascotHost`; the occupant reads
 * `useAgentMascot()` — the look, the size, the state, whether it may move. A
 * boot slot like `apps.card`: a replacement registers when the plugins load,
 * before any mascot is on screen, and the product's drawing comes back when it
 * leaves.
 */
export const AGENT_MASCOT_SLOT = 'agent.mascot';

/**
 * Slot of the screen where the reader types the six digits an email brought
 * them (docs/EMAIL-CODE-UI.md): the first account's confirmation in the
 * onboarding, the forgotten password on the login. Painted by every
 * `EmailCodeHost`; the occupant reads `useEmailCode()` — the digits, the
 * state, the refusal and the resend countdown — and only paints. A boot slot
 * like `apps.card`: a replacement registers when the plugins load, before any
 * code screen is open, and the product's boxes come back when it leaves.
 */
export const EMAIL_CODE_SLOT = 'email.code';

/**
 * Slot of the agent's mascot configurator (docs/AGENT-AVATAR.md): the live
 * preview with its states to try, the skull, fur, eyes and accessory grids,
 * and "Surprise me". Painted by every `LookStylerHost` — the onboarding's
 * side panel and the Avatar tab of the agent editor — so a plugin that takes
 * it changes the configurator everywhere at once. The occupant reads
 * `useLookStyler()` and only paints; the panel or tab around it stays the
 * screen's. A boot slot like `agent.mascot`.
 */
export const AGENT_LOOK_STYLER_SLOT = 'agent.lookstyler';

/**
 * Slot of the parts mascot packs add (docs/AGENT-MASCOT.md, "Mascot packs"):
 * skulls, furs, eyes and accessories, as data, keyed `<pluginId>:<slug>`. Not
 * painted: the mascot and its configurator read it. A boot slot: a pack
 * registers when the plugins load, before any mascot is on screen.
 */
export { MASCOT_PARTS_SLOT };

function declareBootSlots(): void {
  declareSlot('root', 'single');
  // Tokens live on <html> (login, browser panel, PWA). Declared here, not by
  // ui-layout — turning the chrome off must not take the palette with it
  // (MULTI-THEME.md §1.3).
  declareSlot('theme', 'single');
  declareSlot(CHAT_DOCUMENT_SLOT, 'single');
  declareSlot(CHAT_MEDIA_SLOT, 'single');
  declareSlot(MODEL_PICKER_SLOT, 'single');
  declareSlot(PROVIDER_CLI_SLOT, 'single');
  declareSlot(PROVIDER_ROW_SLOT, 'single');
  declareSlot(TASK_FORM_SLOT, 'single');
  declareSlot(DIRECTORY_PICKER_SLOT, 'single');
  declareSlot(CONFIRM_DIALOG_SLOT, 'single');
  declareSlot(APP_CARD_SLOT, 'single');
  declareSlot(KANBAN_CARD_SLOT, 'single');
  declareSlot(TODO_FORM_SLOT, 'single');
  declareSlot(TODO_LANDING_SLOT, 'single');
  declareSlot(JOB_DIALOG_SLOT, 'single');
  declareSlot(PUBLISH_DIALOG_SLOT, 'single');
  declareSlot(PAGE_TOC_SLOT, 'single');
  declareSlot(PROJECT_SETTINGS_SLOT, 'list');
  declareSlot(CHAT_SECRET_REQUEST_SLOT, 'single');
  // Deprecated, never painted: declared so that its former occupants still load.
  declareSlot(UPDATES_BANNER_SLOT, 'single');
  declareSlot(NOTICES_SLOT, 'list');
  declareSlot(NOTICE_CARD_SLOT, 'single');
  declareSlot(UPDATE_DIALOG_SLOT, 'single');
  declareSlot(AGENT_MASCOT_SLOT, 'single');
  declareSlot(EMAIL_CODE_SLOT, 'single');
  declareSlot(AGENT_LOOK_STYLER_SLOT, 'single');
  declareSlot(MASCOT_PARTS_SLOT, 'keyed');
  // Also listed in `UI_LAYOUT_CHILD_SLOTS`, which is the daemon's contract
  // (`bundled-identity.ts`); declared here as well so that dictation does not
  // depend on the chrome: with `@timon/ui-layout` switched off, the desktop's
  // engine must still reach the composer. The layout host skips a slot that
  // already exists and never collapses it.
  declareSlot(DICTATION_ENGINE_SLOT, 'keyed');
}

export function resetSlotsForTests(): void {
  slots.clear();
  registrations.clear();
  sequence = 0;
  declareBootSlots();
}

declareBootSlots();
