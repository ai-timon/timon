/**
 * Types of the platform modules a plugin BUNDLE imports (`@timon/ui`, …).
 *
 * These modules exist only in the browser, served by the daemon
 * (`/api/ui/plugin-modules/*`); nothing resolves them at build time, hence
 * ambient declarations rather than real files.
 *
 * Components are typed loosely on purpose: this package has no React
 * dependency (it is types-only and must stay installable next to any React
 * version). A plugin written in TypeScript with React installed can narrow
 * them itself:
 *
 *     import { Button } from '@timon/ui'
 *     const B = Button as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>
 *
 * The list is frozen by `app/src/lib/plugin-host/contract-surface.json`: an
 * export may be added, never removed (see `docs/SDK-COMPAT.md`).
 */

declare module '@timon/ui' {
  /** A component the product owns, rendered by the host's React. */
  export type PlatformComponent = (props: Record<string, unknown>) => unknown;

  /** Renders whatever plugins registered in a slot this surface declares. */
  export const Slot: PlatformComponent;
  /** Same, for a `keyed` slot: `<SlotKeyed name="page" k="/acme" />`. */
  export const SlotKeyed: PlatformComponent;

  /** Theme-aware cockpit surface classes; treat the value as opaque. */
  export const HUD_SURFACE: string;

  export const Dialog: PlatformComponent;
  export const DialogPortal: PlatformComponent;
  export const DialogOverlay: PlatformComponent;
  export const DialogTrigger: PlatformComponent;
  export const DialogClose: PlatformComponent;
  export const DialogContent: PlatformComponent;
  export const DialogHeader: PlatformComponent;
  export const DialogFooter: PlatformComponent;
  export const DialogTitle: PlatformComponent;
  export const DialogDescription: PlatformComponent;
  export const Select: PlatformComponent;
  export const SelectGroup: PlatformComponent;
  export const SelectValue: PlatformComponent;
  export const SelectTrigger: PlatformComponent;
  export const SelectContent: PlatformComponent;
  export const SelectLabel: PlatformComponent;
  export const SelectItem: PlatformComponent;
  export const SelectSeparator: PlatformComponent;
  export const SelectScrollUpButton: PlatformComponent;
  export const SelectScrollDownButton: PlatformComponent;

  export const Tile: PlatformComponent;
  /**
   * The logo of a provider or a model: `icon` (the user's picto) wins, then
   * `brand`, then a guess from `slug`, then `fallbackIcon` / `fallbackBrand`
   * (the provider's). An unknown brand degrades to a dot with an initial.
   * Props: `{ brand?, slug?, icon?, fallbackIcon?, fallbackBrand?, className? }`.
   */
  export const BrandMark: PlatformComponent;
  export const Button: PlatformComponent;
  export const Input: PlatformComponent;
  export const Label: PlatformComponent;
  export const Separator: PlatformComponent;
  export const Switch: PlatformComponent;

  export const DropdownMenu: PlatformComponent;
  export const DropdownMenuTrigger: PlatformComponent;
  export const DropdownMenuContent: PlatformComponent;
  export const DropdownMenuItem: PlatformComponent;
  export const DropdownMenuCheckboxItem: PlatformComponent;
  export const DropdownMenuLabel: PlatformComponent;
  export const DropdownMenuSeparator: PlatformComponent;

  export const Tooltip: PlatformComponent;
  export const TooltipTrigger: PlatformComponent;
  export const TooltipContent: PlatformComponent;
  export const TooltipProvider: PlatformComponent;

  /**
   * A panel anchored to a button and kept inside the window: flipped or
   * clamped at the viewport's edges, its height capped by the room left on
   * screen, scrolling inside. What a compact widget (`compact` prop) opens
   * from its icon. Controlled — props:
   * `open`, `onClose()`, `anchorRef` (a React ref to the button),
   * `placement` (`'below'` on a line, `'beside'` in a column — falls back to
   * below when no side has room), `width` (px, default 352), `maxHeight` (px,
   * default 512), `label`, `id`, `className`, `children`. Escape closes and
   * refocuses the anchor; a press outside the panel and the anchor closes.
   * Client API 6: a plugin importing it declares `"apiVersion": 6`.
   */
  export const AnchoredPopover: PlatformComponent;

  /**
   * For a floating surface you mount yourself (your own portal, Radix or
   * hand-written). In the desktop app the built-in browser is a native view
   * painted above the whole page: no z-index reaches over it. While at least
   * one of these is mounted, the browser steps aside and shows its last capture.
   * `DialogContent`, `SelectContent`, `DropdownMenuContent` and `AnchoredPopover`
   * already hold one; `DialogPortal` with your own content does not.
   *
   * Takes no props, paints nothing. Put it inside the surface's content, mounted
   * only while the surface is open: left mounted, it keeps the browser frozen.
   * Not for a tooltip, a toast or a persistent overlay. Does nothing outside the
   * desktop app. Client API 14: a plugin importing it declares `"apiVersion": 14`.
   */
  export const NativeViewCover: PlatformComponent;

  /**
   * The card of a Kanban item, a TO DO idea or a task (client API 15, TODO #837):
   * the product's own tiles are laid out with it. Presentation only — every zone
   * is a node you pass, and an absent zone paints nothing. Props: `density`
   * (`'card'`, a board tile, or `'row'`, a compact list line), `as` (`'article'`,
   * `'li'` or `'div'`), `identity` (avatar and name), `corner` (`#209`, `P3`),
   * `leading` (a checkbox before the title, in `row`), `title`, `badges`,
   * `context` (a banner: validation required, block reason), `meta` (dates,
   * counts), `actions` (a click on them never opens the card), `onOpen` (the
   * title becomes a button named by it, which the keyboard and screen readers
   * reach — a span with the button role on a `draggable` card, since Firefox
   * starts no drag from a button; a click elsewhere on the card opens it too, except on a control of
   * its own — keep the title free of links and buttons), `muted` (done: struck through), `tone`
   * (`'default' | 'running' | 'blocked'`), `dragging`, and any HTML attribute
   * of the root (`draggable`, `onDragStart`, `data-*`).
   */
  export const BoardCard: PlatformComponent;
  /**
   * The inside of a Kanban item's popup (client API 15): `header` (the title,
   * carrying the id the frame names, and its badges), `children` (the body),
   * `rail` + `railLabel` (links, dependencies, dates), `attachments` +
   * `attachmentsLabel`, `footer` (secondary gestures left, the main one right).
   * Body, attachments and rail are islands on the frame's fill. Meant to sit in
   * a `DetailFrame`, or in the frame a `task.form` / `todo.form` host already draws.
   */
  export const DetailShell: PlatformComponent;
  /**
   * The modal frame of a Kanban popup (client API 15): the veil, the focus held
   * inside and given back on close, Escape, a click on the veil, the page behind
   * that does not scroll. Props: `labelledBy` (the id of your title), `onClose`
   * (keep it stable), `children`. A `task.form` or `todo.form` occupant is
   * already painted inside one: it never draws its own.
   */
  export const DetailFrame: PlatformComponent;

  /** Merges Tailwind class lists the way the product does. */
  export function cn(...classes: unknown[]): string;
  /** Product strings (`t('cockpit.title')`). For a plugin's OWN strings, use
   *  `createTranslator` — a plugin never writes into the product dictionary. */
  export function t(key: string, vars?: Record<string, string | number>): string;
  /**
   * The reader's language, a canonical BCP 47 tag (`en`, `fr`, `pt-BR`, `ja`…)
   * of a language the product ships. Any language may come: client API 15
   * widened it from `'en' | 'fr'` (a `=== 'fr'` test still works). For dates
   * and numbers, hand it to `Intl` rather than branching on it.
   */
  export function getLocale(): string;
  /**
   * A plugin's messages for one language, as its `locales/<tag>.json` holds
   * them: nested objects (`{ "files": { "selected": "…" } }`, read as
   * `files.selected`) or flat dotted keys (`{ "files.selected": "…" }`).
   */
  export type TranslatorMessages = { readonly [key: string]: string | TranslatorMessages };
  /** A plugin's messages by BCP 47 tag: `{ en, fr, de, 'pt-BR' }`. English is the one to ship. */
  export type TranslatorLocales = { readonly [tag: string]: TranslatorMessages | undefined };
  /**
   * Translator scoped to this plugin's own messages, never the product's.
   * Messages are ICU MessageFormat: `{name}`, and plurals or selects inside one
   * message — `{count, plural, one {# file} other {# files}}` — by the rules of
   * the language the message comes from. Reads the reader's language as the
   * product negotiates it (`pt-PT` finds the plugin's `pt-BR`), key by key,
   * then the plugin's `en`, then the key itself. Since client API 15 (any
   * language, ICU); before, `en` and `fr` with `{name}` only, which still read
   * the same.
   */
  export function createTranslator(
    messages: TranslatorLocales,
  ): (key: string, vars?: Record<string, string | number>) => string;

  /** An idea of the TO DO notebook, as the browser holds it. */
  export type TodoItem = {
    id: number;
    text: string;
    project: string | null;
    author: string | null;
    status: 'open' | 'done' | 'promoted';
    notes: string | null;
    created_at: number;
    updated_at: number;
    done_at: number | null;
    urgency: string | null;
    progress: string | null;
    /** Tickets the idea is tied to elsewhere (`ctx.kanban.todos.links`). */
    links?: { provider: string; ref: string; url: string | null; label: string | null; plugin_id: string | null; created_at: number }[];
    /** Files attached to the idea; absent from a host older than client API 15. */
    attachment_count?: number;
  };
  /**
   * The idea a `kanban.todo.badge` occupant is rendered for; `null` outside
   * that slot. Read it from here, never from props: the entry is registered
   * once and rendered on every line.
   */
  export function useTodoItem(): TodoItem | null;
  /**
   * The idea the detail dialog shows, for a `kanban.todo.detail` occupant,
   * with `saved()` to call once the plugin saved its own data so the notebook
   * re-reads the idea. `null` outside that slot.
   */
  export function useTodoDetail(): { item: TodoItem; saved: () => void | Promise<void> } | null;

  /** A mission, as a `mission.card.badge` occupant reads it. */
  export type MissionItem = {
    id: string;
    agent_name: string | null;
    /** The database status: `running` only says the row is open. */
    status: string;
    /** The daemon holds the agent process. */
    running: boolean;
    turn_active: boolean;
    turn_complete: boolean;
    /** `working` process alive in a turn · `turn_done` alive, turn over ·
     *  `open` row open, nothing running · `interrupted` cut (see
     *  `interrupted_reason`) · `ended`. `null` from a daemon that predates it. */
    liveness: 'working' | 'turn_done' | 'open' | 'interrupted' | 'ended' | null;
    /** Why it was cut: `rate_limit`, `exhausted`, `killed`, `stopped`, `crash`… */
    interrupted_reason: string | null;
    /** Messages in the agent's inbox still to be read. */
    pending_messages: number;
    /** Requests received and not yet answered. */
    open_deliveries: number;
  };
  /**
   * The mission a `mission.card.badge` occupant is rendered for; `null` outside
   * that slot. Read it from here, never from props: the entry is registered
   * once and rendered on every row.
   */
  export function useMissionItem(): MissionItem | null;

  /** The agent a menu was opened on, as an `agent.menu.item` occupant reads it. */
  export type AgentMenuItem = {
    name: string;
    role: string | null;
  };
  /**
   * The agent an `agent.menu.item` occupant is rendered for (the "…" or the
   * right click on a row of the bots rail); `null` outside that slot. Read it
   * from here, never from props: the entry is registered once and rendered in
   * every agent's menu. Paint a `DropdownMenuItem`. Client API 15.
   */
  export function useAgentMenuItem(): AgentMenuItem | null;

  /** A connection type, as the `settings.connection.form` slot receives it. */
  export type ConnectionTypeInfo = {
    /** Qualified id `<plugin>:<name>@<version>`, the slot key. */
    id: string;
    pluginId: string;
    label: string;
    description: string | null;
    fields: { key: string; label: string; required?: boolean; placeholder?: string }[];
    secrets: { name: string; label: string; required?: boolean }[];
    customTest: boolean;
  };
  export type ConnectionFormInput = {
    label: string;
    url: string;
    /** Loopback, LAN and Tailscale addresses need this, and the approver sees it. */
    allowPrivateNetwork?: boolean;
    config?: Record<string, unknown>;
    /** Values go to the vault; the browser never gets them back. */
    secrets?: Record<string, string>;
  };
  /** A connection of the signed-in account, as an edit form opens on it: secret NAMES only, never a value. */
  export type ConnectionInfo = {
    id: string;
    type: string;
    label: string;
    url: string;
    allowPrivateNetwork: boolean;
    config: Record<string, unknown>;
    /** Names of the stored secrets; the values never reach the browser. */
    secrets: string[];
    approval: 'pending' | 'approved' | 'rejected';
    enabled: boolean;
    revision: number;
  };
  /**
   * For a plugin's own connection form (`settings.connection.form`, keyed by
   * the type id, apiVersion 7): the type, `submit` to save, `cancel` to close
   * the form. `null` elsewhere.
   *
   * The same form serves to add and to edit. In `edit`, prefill from
   * `initial` and leave the secret fields empty: `submit` sends only what
   * differs from `initial`, and a secret left empty (or absent) keeps the
   * stored one. A form that ignores `mode` keeps working as a create form.
   * `mode`, `initial` and `approvalRequired` are absent on a host that
   * predates editing: read a missing `mode` as `create`.
   */
  export function useConnectionForm(): {
    type: ConnectionTypeInfo;
    mode?: 'create' | 'edit';
    /** The connection being edited; `null` in `create`. */
    initial?: ConnectionInfo | null;
    /**
     * Whether saving waits for an administrator: a new connection, or an edit
     * that changes the origin or `allowPrivateNetwork`. False for an
     * administrator and under the operator's `owner` approval policy.
     */
    approvalRequired?: boolean;
    submit(input: ConnectionFormInput): Promise<{ ok: true; connection: { id: string; approval: 'pending' | 'approved' | 'rejected' } } | { ok: false; error: string }>;
    cancel(): void;
  } | null;

  /** Params of an island content: flat, at most 1 KiB once serialised. */
  export type IslandParams = Record<string, string | number | boolean | null>;
  /** A content of the island workspace: `<pluginId>:<key>` and its params. */
  export type IslandContent = { type: string; params: IslandParams };
  /** Where a content opens against the focused island; `center` is a tab of it. */
  export type IslandOpenEdge = 'left' | 'right' | 'top' | 'bottom' | 'center';
  export type StartIslandDragOptions = {
    /** Shown while dragging. */
    label?: string;
    /** Called once the workspace accepted the drop. */
    onDropped?: () => void;
    /**
     * The element the drag starts in, when it has drop targets of its own:
     * the workspace's layer only rises while the pointer is outside it.
     */
    hold?: Element | null;
  };
  /**
   * What a content registered in `island.content` knows of its place
   * (client API 8). The component receives no props and reads this. Throws
   * outside a content of the island workspace.
   */
  export function useIslandContent(): {
    islandId: string;
    tabId: string;
    type: string;
    params: IslandParams;
    /** Goes through the type's `parseParams` before it is stored; refused params change nothing, with a console warning and a notice. */
    setParams(next: IslandParams): void;
    /** What the tab shows; `null` goes back to the registered title. */
    setTitle(title: string | null): void;
    /** Closes this tab, not the island (unless it was its last tab). */
    close(): void;
    /** Its island is the focused one. */
    focused: boolean;
    /** Its tab is the visible one of its island (an inactive tab is unmounted unless `keepMounted`). */
    active: boolean;
    /** The primary instance of its `exclusive` group; always `true` without one. */
    primary: boolean;
  };
  /**
   * Drags `content` into the island workspace of the view on screen (client
   * API 8). Call it from the source's `onDragStart`, after setting the
   * source's own `dataTransfer` types if it has any. The params go through
   * the type's `parseParams` on drop.
   */
  export function startIslandDrag(
    event: { dataTransfer: DataTransfer | null },
    content: IslandContent,
    options?: StartIslandDragOptions,
  ): void;
  /**
   * Opens `content` in the island workspace of the view on screen, against
   * `edge` of the focused island (default `right`), or as a tab of it
   * (`center`). An open content whose `singletonBy` value matches is
   * activated instead. `false` when no workspace is on screen or when it
   * refused (unknown type, params refused, a ceiling reached). Client API 8.
   */
  export function openInIsland(content: IslandContent, options?: { edge?: IslandOpenEdge }): boolean;

  /** An HTML document of a conversation, as the `chat.document` slot receives it (client API 9). */
  export type UiDocumentBlock = {
    id: string;
    /** Text, never HTML. */
    title: string;
    status: 'shown' | 'pending' | 'answered' | 'dismissed' | 'expired';
    origin: { kind: 'agent' | 'user' | 'plugin'; id: string | null };
    bridge: 'timon' | 'raw';
    /** The creator's hint for the first paint, 80–2000; null = the default. */
    height: number | null;
    expectsReply: boolean;
    createdAt: number | null;
    resolvedAt?: number | null;
  };
  /**
   * The document a `chat.document` occupant is rendered for; `null` outside
   * that slot (client API 9). `src` is the URL the daemon serves it from: an
   * occupant loads nothing else.
   */
  export function useUiDocument(): { document: UiDocumentBlock; missionId: string; src: string; bridge: 'timon' | 'raw' } | null;
  /**
   * The document itself: the sandboxed iframe (`allow-scripts allow-forms`,
   * never `allow-same-origin`), its MCP Apps bridge, its height and its focus
   * rule. Render it inside your own card to change the dressing without
   * rewriting the security. Reads `useUiDocument()`; takes no props. Client API 9.
   */
  export const UiDocumentFrame: PlatformComponent;
  /** Where the daemon serves a document's HTML, on the Timon origin. Client API 9. */
  export function uiDocumentUrl(id: string): string;

  /** A secret an agent asks its user for, as the `chat.secret` slot receives it (client API 15). Never a value. */
  export type SecretRequestView = {
    id: string;
    missionId: string;
    agent: string;
    /** An environment-variable identifier, e.g. `SHOP_API_KEY`. */
    name: string;
    reason: string;
    lifetime: 'once' | 'mission' | 'persistent';
    /** Hosts Timon may send it to for the agent; null = a page origin or the agent's environment. */
    hosts: string[] | null;
    header: string | null;
    /** The exact page origin the built-in browser may fill it into; null = hosts or the environment. */
    origin: string | null;
    project: string | null;
    missionTitle: string;
    status: 'pending' | 'provided' | 'refused' | 'expired';
    createdAt: number;
    expiresAt: number;
    resolvedAt: number | null;
  };
  /**
   * The request a `chat.secret` occupant is rendered for, and its two
   * gestures; `null` outside that slot (client API 15). `provide(value)` sends
   * the value straight to the vault and resolves `true` once stored — keep it
   * in your input only, and empty the input once sent: nothing else needs it.
   */
  export function useSecretRequest(): {
    request: SecretRequestView;
    expired: boolean;
    busy: boolean;
    highlighted: boolean;
    provide(value: string): Promise<boolean>;
    refuse(): Promise<boolean>;
  } | null;

  /** One installer of a published Timon version (client API 15). `key` is `<os>-<arch>-<format>`. */
  export type UpdateArtifact = {
    key: string;
    os: 'linux' | 'mac' | 'win';
    arch: 'x64' | 'arm64' | 'universal';
    format: 'appimage' | 'deb' | 'pkg' | 'dmg' | 'nsis';
    name: string;
    url: string;
    /** Bytes. */
    size: number;
  };
  /**
   * A newer Timon the daemon verified against the signed release list, as the
   * `updates.banner` slot receives it (client API 15). `null` outside that
   * slot; the host only paints the slot while such a version exists and the
   * person has not put it off. `offer.notes` is plain text: render it as text,
   * never as HTML. `installers` are the ones for this browser's system, the
   * first to download first; empty on a phone or an unknown system — link
   * `offer.notesUrl` then. `later()` hides this version only. While
   * `buildExpiresAt` is set the build-expiry notice is hidden in favour of the
   * banner: say when the build stops. `download` is set in the desktop app
   * only: the shell downloads and verifies the installer for this machine
   * itself (its URL, size and sha256 come from the daemon, never from the
   * page) — show its `state` and offer its gestures instead of the link.
   */
  export function useUpdateStatus(): {
    installed: string;
    channel: 'beta' | 'stable' | 'dev';
    offer: { version: string; publishedAt: string; notes: string; notesUrl: string; artifacts: UpdateArtifact[] };
    installers: UpdateArtifact[];
    buildExpiresAt: string | null;
    later(): void;
    download: UpdateDownloadControl | null;
  } | null;

  /** Where the desktop shell's download stands (client API 15). `failed.resumable`: the bytes are kept, `start()` resumes. */
  export type UpdateDownloadState =
    | { phase: 'idle' }
    | { phase: 'downloading'; version: string; name: string; format: UpdateArtifact['format']; received: number; total: number }
    | { phase: 'verifying'; version: string; name: string; format: UpdateArtifact['format']; total: number }
    | { phase: 'ready'; version: string; name: string; format: UpdateArtifact['format']; total: number }
    | {
      phase: 'failed'; version: string | null; name: string | null; resumable: boolean;
      code: 'no_offer' | 'daemon' | 'network' | 'http' | 'insecure_redirect' | 'too_many_redirects' | 'size' | 'integrity' | 'disk_full' | 'filesystem';
    };
  /**
   * The desktop shell's download of the offered version (client API 15). Every
   * gesture takes nothing: the shell picks the installer. `openInstaller()`
   * answers `unsupported` for an AppImage (show the folder instead).
   * `install(confirmed?)` installs the verified file the system's way; it
   * answers `missions` (nothing done) while missions would stop, until called
   * with `true`; `unsupported` on a desktop that cannot install (open the
   * installer instead).
   */
  export type UpdateDownloadControl = {
    state: UpdateDownloadState;
    start(): void;
    cancel(): void;
    openFolder(): Promise<{ status: 'opened' | 'none' | 'unsupported' } | { status: 'failed'; message: string | null }>;
    openInstaller(): Promise<{ status: 'opened' | 'none' | 'unsupported' } | { status: 'failed'; message: string | null }>;
    install(confirmed?: boolean): Promise<UpdateInstallOutcome>;
  };
  /**
   * What `install()` did (client API 15). `restarting`: the AppImage was
   * replaced and Timon restarts; `closing`: the Windows installer is open and
   * Timon quits; `opened`: the macOS installer is open; `guided`: a `.deb`,
   * with the command that installs it; `not_writable`: the AppImage's folder
   * cannot be written, the file stays in Timon's data folder; `none`: no
   * verified installer is left on disk, nothing was tried — offer `start()`
   * again.
   */
  export type UpdateInstallOutcome =
    | { status: 'missions'; count: number }
    | { status: 'restarting' | 'not_writable' | 'opened' | 'closing' | 'none' | 'unsupported' }
    | { status: 'guided'; command: string; opened: boolean }
    | { status: 'failed'; message: string | null };

  /** `older` = ↑, `newer` = ↓ (client API 12). */
  export type PromptHistoryDirection = 'older' | 'newer';
  /**
   * The prompts already sent to an agent, the same list the product's composer
   * recalls with ↑ / ↓ (client API 12). Kept in this browser only, 50 per
   * agent, newest first. `agentId` null = no conversation: the calls do nothing.
   */
  export function usePromptHistory(agentId: string | null): {
    /** Stores a sent prompt (trimmed; blank or a repeat of the last one is skipped) and leaves the browsing. */
    record(text: string): void;
    /** The text to show for one step, or `null` when there is nowhere to go —
     *  leave the key to the browser then. Past the newest entry, gives back the
     *  draft that was in the field when browsing started. */
    step(direction: PromptHistoryDirection, current: string): string | null;
    /** Leaves the browsing: call it when the user edits the field. */
    reset(): void;
  };
  /**
   * Whether an arrow key should browse the history rather than move the caret:
   * never with a selection; on a text shown on several lines (line breaks, or
   * `wrapped` = the field wraps it), ↑ only from its start and ↓ only from its
   * end. Client API 12.
   */
  export function canRecallPrompt(
    direction: PromptHistoryDirection,
    value: string,
    selectionStart: number,
    selectionEnd: number,
    wrapped?: boolean,
  ): boolean;
  /** Whether a textarea shows more than one line, line breaks or not — the
   *  `wrapped` argument of `canRecallPrompt`. Client API 12. */
  export function isTextareaWrapped(el: HTMLTextAreaElement): boolean;

  /** The bubble a `chat.message.action` occupant sits under (client API 15). */
  export type ChatMessageView = {
    role: 'agent' | 'user';
    /** The stored event the bubble was drawn from; null when no row backs it
     *  (nothing can reply to it then). */
    eventId: number | null;
    missionId: string | null;
    /** The agent's Markdown source, or what the human typed. */
    markdown: string;
    /** The text as the bubble renders it (sanitized HTML). */
    html: string;
  };
  /** The bubble a `chat.message.action` occupant is painted under; null elsewhere. Client API 15. */
  export function useChatMessage(): ChatMessageView | null;
  /** The earlier message the next turn answers. */
  export type ComposerReply = { eventId: number; role: 'agent' | 'user'; excerpt: string };
  /**
   * The reply the composer is about to send (client API 15): set it from a
   * message action, read it from a `chat.composer` replacement and send its
   * `eventId` as `reply_to: { event_id }`. Outside a chat, `setReply` does nothing.
   */
  export function useComposerReply(): {
    reply: ComposerReply | null;
    setReply(reply: ComposerReply | null): void;
  };
  /** The product's icon button under a bubble, with its tooltip, so a
   *  plugin's action looks like Copy and Reply. Props: `label` (also the
   *  tooltip), `onClick`, `pressed?`, `active?`, `children` (the icon).
   *  Client API 15. */
  export const MessageActionButton: PlatformComponent;

  /** The built-in browser's state, as a `browser.toolbar` / `browser.drawer` occupant reads it. */
  export type BrowserChromeStatus = {
    running: boolean;
    profileId: string;
    tabs: { id: string; url: string; title: string }[];
    activeTabId: string | null;
    width: number;
    height: number;
    mobile?: boolean;
    /** `you`: this client holds the control lease; `other`: another device does. */
    control?: { holder: 'you' | 'other' | null; kind: 'human' | 'agent' | null };
    /** Fields this declaration does not list may appear: read them defensively. */
    [field: string]: unknown;
  };
  /**
   * The browser a `browser.toolbar` / `browser.drawer` occupant is painted in
   * (client API 13); `null` outside those slots. Read it from here, never from
   * props: an entry is registered once and painted in every open browser.
   */
  export function useBrowserChrome(): {
    /** The profile this browser shows; `null` while none is bound. */
    profileId: string | null;
    status: BrowserChromeStatus | null;
    /** This client holds the control lease: input and navigation go through. */
    controlled: boolean;
    /**
     * The conversation this browser is open for: its agent, and its mission when it has one. It
     * follows the chat of that agent when one is on screen; `fresh` is that chat on "New conversation".
     */
    conversation: { agent: string; mission: string | null; fresh?: boolean };
    /**
     * A command on this profile, under this client's lease; the status is re-read after it. Rejects with the engine's message.
     * Needs `browser:control` in the plugin's `timon.permissions` (sensitive): without it, it rejects without running
     * anything, with an `Error` named `BrowserControlDenied`. The other fields need no permission.
     */
    command<T = unknown>(action: string, data?: Record<string, unknown>): Promise<T>;
    /** The `browser.drawer` key open in this browser, or `null`. */
    drawer: string | null;
    /** Opens the `browser.drawer` entry registered under `key`; nothing happens without one. */
    openDrawer(key: string): void;
    closeDrawer(): void;
  } | null;

  /** The recording state the browser status reports, to every viewer of the profile. */
  export type BrowserRecordingLive = { active: boolean; steps: number; stoppedReason?: string };
  /** A saved recording, metadata only. */
  export type BrowserRecordingMeta = {
    id: string;
    profileId: string;
    title: string;
    startUrl: string;
    steps: number;
    /** Steps the secret detector flagged that the review has not settled; Learn waits for 0. */
    flagged: number;
    truncated: boolean;
    stoppedReason: string;
    createdAt: number;
    updatedAt: number;
    status: 'draft' | 'reviewed' | 'learned';
    learnMissionId: string | null;
    /** The one `browser-*` skill the conversion mission created, once it has (#466). */
    learnedSkillId?: string | null;
    stepsAvailable: boolean;
    [field: string]: unknown;
  };
  /** One recorded step, after the daemon's masking pass. */
  export type BrowserRecordedStep = {
    n: number;
    t: number;
    type: 'click' | 'input' | 'secret' | 'enter' | 'navigate' | 'newTab' | 'switchTab' | 'closeTab' | 'credential';
    tabId: string;
    name?: string;
    text?: string;
    value?: string;
    url?: string;
    origin?: string;
    selector?: string;
    flagged?: string;
    param?: string;
    [field: string]: unknown;
  };
  /** A review operation: `mask` overwrites the value for good. */
  export type BrowserRecordingOp =
    | { op: 'mask' | 'unmask' | 'drop'; step: number }
    | { op: 'param'; step: number; name: string }
    | { op: 'rename'; step: number; name: string }
    | { op: 'rename'; title: string };
  /**
   * The recording of the built-in browser a `browser.toolbar` / `browser.drawer`
   * occupant is painted in (client API 13); `null` outside those slots. `live`
   * and `owner` are free to read; every action goes through the recording
   * routes, which admit the profile's owner only, and needs `browser:control`
   * in `timon.permissions`, like `command()`: without it, it rejects with an
   * `Error` named `BrowserControlDenied` and sends nothing.
   */
  export function useBrowserRecording(): {
    profileId: string | null;
    live: BrowserRecordingLive | null;
    /** The signed-in user owns the profile; `null` until known. */
    owner: boolean | null;
    /** This client holds the control lease: a recording starts here only. */
    controlled: boolean;
    canStart: boolean;
    recordings: BrowserRecordingMeta[];
    /** The recording the product's review drawer shows, `null` for its list. */
    selectedId: string | null;
    /** The last Stop found that recording already saved (it had ended on its own). */
    alreadySaved: boolean;
    busy: boolean;
    error: string | null;
    start(): Promise<void>;
    /** Stops, or collects a recording that ended on its own, and opens the product's review drawer on it. */
    stop(): Promise<{ recording: BrowserRecordingMeta; alreadySaved?: boolean }>;
    openReview(id?: string | null): void;
    refresh(): Promise<void>;
    read(id: string): Promise<{ recording: BrowserRecordingMeta; steps: BrowserRecordedStep[] | null }>;
    patch(id: string, ops: BrowserRecordingOp[]): Promise<{ recording: BrowserRecordingMeta; steps: BrowserRecordedStep[] }>;
    remove(id: string): Promise<void>;
    /** Starts the conversion mission; `autoSubmit` lets the learned skill submit the final step without asking. */
    /** `agent`: one whose backend runs without a shell and file writes; absent, the main agent. */
    learn(id: string, options: { autoSubmit: boolean; agent?: string }): Promise<{ recording: BrowserRecordingMeta; missionId: string }>;
  } | null;

  /** Where the page's picture sits, for a `browser.surface` layer (client API 13). */
  export type BrowserSurface = {
    /** The native view is painted above the DOM: a layer is neither seen nor reached. */
    native: boolean;
    /** A drawer, a dialog or a missing picture covers the page: a layer stands aside. */
    blocked: boolean;
    viewport: { width: number; height: number };
    /** A point of the window in page CSS pixels; `null` off the picture. */
    toPage(clientX: number, clientY: number): { x: number; y: number } | null;
    /** A page rectangle in pixels of the surface, for an absolutely positioned layer; `null` off the picture. */
    toSurface(rect: { x: number; y: number; width: number; height: number }): { left: number; top: number; width: number; height: number } | null;
  };
  /**
   * The picture a `browser.surface` occupant is layered on (client API 13); `null` outside that
   * slot. The slot's frame lets pointer events through: a layer takes them where it paints
   * something that does, and calls `preventDefault()` on an event it handles — the surface then
   * sends nothing of it to the page.
   */
  export function useBrowserSurface(): BrowserSurface | null;

  export type BrowserAnnotationStatus = 'draft' | 'pending' | 'resolved' | 'dismissed';
  /** The annotate state the browser status reports, to every viewer of the profile. */
  /** `queued`: the annotations in the desktop's bubble queue, sealed as drafts as they are added (absent from older desktops: 0); `queuedIds`: their ids, in order. */
  export type BrowserAnnotationLive = { active: boolean; pending: number; queued: number; queuedIds: string[]; capturing: number; stoppedReason?: string };
  export type BrowserAnnotationRect = { x: number; y: number; width: number; height: number };
  /** A saved annotation, metadata only. */
  export type BrowserAnnotationMeta = {
    id: string;
    profileId: string;
    status: BrowserAnnotationStatus;
    createdAt: number;
    updatedAt: number;
    capturedAt: number;
    hasThumbnail: boolean;
    sourceDetected: boolean;
    delivery: { batchId: string; missionId: string | null; agentName: string | null; sentAt: number } | null;
    resolvedAt: number | null;
    [field: string]: unknown;
  };
  /** The owner's read of one annotation. `page` and `source` are what the page said: untrusted, show them as text. */
  export type BrowserAnnotationDetail = {
    annotation: BrowserAnnotationMeta;
    comment: string;
    page: {
      url: string;
      title: string;
      target: { selector: string; tag: string; role: string; name: string; text: string; id: string; classes: string[]; [field: string]: unknown };
      rect: BrowserAnnotationRect;
      viewport: { width: number; height: number };
      [field: string]: unknown;
    };
    source: { detected: false } | { detected: true; framework: string; component?: string; file: string | null; line?: number; [field: string]: unknown };
    resolution: { status: 'resolved'; summary: string | null } | { status: 'dismissed'; reason: string | null } | null;
  };
  /**
   * The annotations of the built-in browser a `browser.toolbar` / `browser.drawer` /
   * `browser.surface` occupant is painted in (client API 13); `null` outside those slots. `live`
   * and `owner` are free to read. `annotations`, `details`, `selectedId`, `refresh` and `read`
   * need `browser:annotations:read` or `browser:control` in `timon.permissions`: without either,
   * the list and the details stay empty and `refresh`/`read` reject with an `Error` named
   * `BrowserAnnotationsReadDenied`, sending nothing. Every action goes through the annotation
   * routes, which admit the profile's owner only, and needs `browser:control`, like `command()`:
   * without it, it rejects with an `Error` named `BrowserControlDenied` and sends nothing. `post` posts the queue as one user turn of `target` (the thread shows a card, the
   * agent reads the daemon's block); the older `send` hands that block to the composer instead.
   */
  export function useBrowserAnnotations(): {
    profileId: string | null;
    live: BrowserAnnotationLive | null;
    /** The signed-in user owns the profile; `null` until known. */
    owner: boolean | null;
    /** This plugin may read `annotations` and `details` (`browser:annotations:read` or `browser:control`). Optional: an older host does not set it. */
    readable?: boolean;
    controlled: boolean;
    canStart: boolean;
    /** Where `post` goes: the conversation this browser is open for; `fresh` is the chat's "New conversation". */
    target: { agent: string; mission: string | null; fresh?: boolean } | null;
    /** Newest first. */
    annotations: BrowserAnnotationMeta[];
    /** How many annotations `post()` sends: `queueIds.length`. Without `readable`, the desktop bubble's count (`live.queued` at least). */
    queue: number;
    /**
     * The current queue, in order: what the desktop's bubble queued and what was picked here, until
     * sent or deleted. A draft left from an earlier session is not in it: `post({ ids })` sends it by name.
     * Without `readable`, the bubble's ids only (`live.queuedIds`).
     */
    queueIds: string[];
    details: Readonly<Record<string, BrowserAnnotationDetail>>;
    /** The annotation the product's drawer shows, `null` for its list. */
    selectedId: string | null;
    /** The element under the PWA pointer, and the one a re-highlight found, in page CSS pixels. */
    hover: BrowserAnnotationRect | null;
    highlight: BrowserAnnotationRect | null;
    busy: boolean;
    error: string | null;
    notice: string | null;
    start(): Promise<void>;
    stop(): Promise<void>;
    /** Picks at a point of the page (CSS pixels), the PWA's way; the native view picks by itself. */
    pick(x: number, y: number): Promise<{ annotations: BrowserAnnotationMeta[]; refused: number; thumbnailsDropped: number }>;
    /** What lies at a point, for a layer's own highlight; nothing is stored. */
    preview(x: number, y: number): Promise<BrowserAnnotationRect | null>;
    /** Opens the product's drawer, on an annotation or on the list. */
    open(id?: string | null): void;
    refresh(): Promise<void>;
    read(id: string): Promise<BrowserAnnotationDetail>;
    thumbnail(id: string): Promise<{ mimeType: 'image/jpeg'; data: string; width: number; height: number } | null>;
    /** Drafts only: once sent, the agent may already have read the comment. */
    comment(id: string, comment: string): Promise<BrowserAnnotationMeta>;
    remove(id: string): Promise<void>;
    /** Shows the element again by its stored selector; starts annotate mode when needed. */
    highlightAgain(id: string): Promise<boolean>;
    /**
     * A `browser.surface` layer's pins: the annotated tab follows the elements of these annotations
     * (picked with `pick`) and the answer says where they are now, in page CSS pixels (`null`: gone
     * from the page). Read it again as the page scrolls; an empty list stops following.
     */
    follow(ids: string[]): Promise<Array<{ id: string; rect: BrowserAnnotationRect | null }>>;
    /** Legacy: sends drafts as one batch to `target` and deposits the daemon's block in its composer. */
    send(ids: string[], options?: { withImages?: boolean }): Promise<{ batchId: string; box: string; deposited: boolean; images: number }>;
    /** Posts the current queue (or `ids`) to `target` as one user turn; the pins of what was posted leave the page. */
    post(options?: { ids?: string[]; message?: string }): Promise<{ ok: true; missionId: string; spawned: boolean; batchId: string; annotations: BrowserAnnotationMeta[]; images: number }>;
  } | null;

  /** A model of the catalogue, as the product's model picker reads it (client API 13). */
  export type CatalogModel = {
    /** Passed as is to the CLI's `--model`. */
    slug: string;
    label: string;
    /** Short name the product prefers when set ("Opus" for `claude-opus-…`). */
    presetLabel?: string;
    /** Order within the provider, most capable first; `byPower` reads it. */
    presetRank?: number;
    /** Absent when unknown from a safe source: show nothing rather than a guess. */
    contextWindow?: number;
    addedAt?: number;
    brand?: string;
    icon?: string;
    /** Fields this declaration does not list may appear: read them defensively. */
    [field: string]: unknown;
  };
  /** A catalogue entry: a provider, or one subscription account of it (`claude@<id>`). Client API 13. */
  export type CatalogBackend = {
    /** Exact id a pick carries, account instance included. */
    id: string;
    label: string;
    vendor?: string;
    brand?: string;
    icon?: string;
    models: CatalogModel[];
    defaultModel: string | null;
    /** Set on an account instance: the provider it belongs to. */
    instanceOf?: string;
    account?: { id: string; name: string; state?: 'active' | 'cooldown' | 'reauth' };
    [field: string]: unknown;
  };
  export type BackendCatalog = {
    backends: CatalogBackend[];
    defaultBackend: string;
    [field: string]: unknown;
  };
  /** What a model picker holds and hands back. Client API 13. */
  export type ModelPick = { backend: string; model: string };
  /**
   * The picker a `model.picker` occupant is painted for (client API 13);
   * `null` outside that slot. Read it from here, never from props: one entry
   * is painted by every picker on screen, each with its own host.
   */
  export function useModelPicker(): {
    /** `panel`: flat in a form. `popover`: the product keeps the trigger, the anchoring, the focus and the closing; paint the content only. */
    mode: 'panel' | 'popover';
    /** `null` = the inherit entry (or nothing chosen). A value whose entry left the catalogue stays shown, selected and disabled. */
    value: ModelPick | null;
    /**
     * Hands a pick back. In a popover it closes it and refocuses the trigger.
     * Refused (nothing happens) while `disabled`, for an account that cannot
     * run (`isPickable`), a model `filter` rejects, `null` without `inherit`,
     * and a slug the catalogue does not list unless `allowCustomSlug`.
     */
    onChange(pick: ModelPick | null): void;
    /** Offer an entry that hands back `null`, labelled `label`. */
    inherit?: { label: string; hint?: string };
    allowCustomSlug: boolean;
    /** Restricts the catalogue: apply it to the rail, the lists, the favourites and the search. */
    filter?: (backend: CatalogBackend, model: CatalogModel) => boolean;
    /**
     * The mission this picker chooses for (`null` or absent: the whole inventory).
     * `useBackendCatalog()` already reads for it, and `onChange` refuses a backend
     * it does not list; only for wording. Absent on a host older than 31 October 2026.
     */
    target?: { project?: string | null; agent?: string | null } | null;
    /** The surface's own settings, to render under the list (a React node). */
    footer?: unknown;
    disabled: boolean;
    autoFocusSearch: boolean;
    /** Size of your root element: put it on the outer element. */
    className: string;
    /** Accessible name of the picker. */
    label: string;
    /** `keepOpenOnPick`: the surface keeps the popover open after a pick (a confirmation in its `footer`); `onChange` does not close it then. */
    popover: { align: 'start' | 'end'; side: 'below' | 'beside'; close(): void; keepOpenOnPick: boolean } | null;
  } | null;
  /**
   * The model catalogue of the active machine, cached and shared (client API 13).
   * Empty until read. Inside a `model.picker` occupant: the catalogue of that
   * picker's mission, without a backend whose reserved key it would not receive.
   */
  export function useBackendCatalog(): BackendCatalog;
  /** "Anthropic · KRZDIGITAL": the vendor, then the account, so two entries never read the same. Client API 13. */
  export function vendorLabel(backend: CatalogBackend): string;
  /** Whether an entry's account can run now (`false` for `reauth` / `cooldown`). Client API 13. */
  export function isPickable(backend: CatalogBackend | null | undefined): boolean;
  /** Why an entry cannot run (or nobody is signed in), for a `title`; `null` when nothing to say. Client API 13. */
  export function accountStateHint(backend: CatalogBackend | null | undefined): string | null;
  /** A provider's models, most capable first (new models lead). Client API 13. */
  export function byPower(models: CatalogModel[]): CatalogModel[];
  /** The product's search: name, slug, provider label and vendor. `query` must already be trimmed and lower-cased. Client API 13. */
  export function matchesQuery(backend: CatalogBackend, model: CatalogModel, query: string): boolean;
  /** "1 M", "200 k". Client API 13. */
  export function formatWindow(tokens: number): string;
  /** Added to the catalogue less than a week ago: the product's rows show a "new" badge. Client API 13. */
  export function isNewModel(model: { addedAt?: number }, now?: number): boolean;
  /** What a provider declared it cannot do: work in Timon's folder (`worktree`, a remote agent), Timon's tools, attachments. Client API 13. */
  export function backendLimits(catalog: BackendCatalog, backend: string): Array<'worktree' | 'timonMcp' | 'attachments'>;
  /** The product's "Remote" / "Limited" chip for those limits, the list in its tooltip; nothing when there are none. Props: `{ catalog, backend, className? }`. Client API 13. */
  export const BackendLimitsBadge: PlatformComponent;
  /** The product's chip for an account to sign in again or cooling down, its reason in the tooltip; nothing when it can run. Props: `{ backend, className? }`. Client API 13. */
  export const AccountStateBadge: PlatformComponent;
  /**
   * The signed-in account's favourite models, shared by every picker on
   * screen (client API 13). A favourite is an exact `(backend, model)` pair;
   * one the catalogue no longer lists is hidden, never dropped. `toggle` is
   * optimistic and put back if the daemon refuses; until `ready` it does nothing.
   */
  export function useModelFavorites(): {
    favorites: readonly ModelPick[];
    ready: boolean;
    isFavorite(pick: ModelPick): boolean;
    toggle(pick: ModelPick): void;
    setFavorites(next: readonly ModelPick[]): void;
  };
  /** One AI CLI of the product's providers on the daemon's machine, as a provider card shows it. Client API 14. */
  export type ProviderCli = {
    /** Canonical binary name: what `install` is given. */
    name: string;
    label: string;
    brand: string | null;
    /** Where the daemon finds it, `null` when it does not. */
    path: string | null;
    /** The build a desktop app ships: signing it in is enough. */
    bundled: boolean;
    /** `false` only when the daemon KNOWS it is signed out; `null`: the provider cannot tell. */
    signedIn: boolean | null;
    /** The vendor gives an installer for this OS, which `install` runs. */
    installable: boolean;
    /** The vendor's installer as a line to paste, `null` without one here. */
    installCommand: string | null;
    /** The vendor's installation page, for a CLI that cannot be installed from Timon here. */
    installDocs: string | null;
    /** What signs in, built on the path the daemon resolved. */
    signInCommand: string;
    /** What to type once it runs (`/login`), when the CLI needs it. */
    signInThen: string | null;
    /** The onboarding's chat can start on it. */
    seedsMainAgent: boolean;
    /** Installed version of the binary at `path`, `null` when unknown. */
    version: string | null;
    /** Newest published version, `null` when unknown or the check is off. */
    latest: string | null;
    updateAvailable: boolean;
    /** The installed binary is a major version the provider does not support: neither Install nor Update is offered over it. */
    unsupportedVersion: boolean;
    [field: string]: unknown;
  };
  /** An install job: the vendor's installer running, or the last one that ended. Client API 14. */
  export type ProviderCliInstallJob = {
    name: string;
    /** The line being run, as a person would paste it. */
    command: string;
    state: 'running' | 'succeeded' | 'failed';
    startedAt: number;
    finishedAt: number | null;
    /** The installer's console, oldest first, without colours or progress-bar redraws. */
    lines: string[];
    /** Lines dropped from the head of a long console. */
    dropped: number;
    result: { ok: boolean; command: string | null; reason: string | null } | null;
  };
  /**
   * The host a `providers.cli` occupant is painted for (client API 14): the
   * onboarding's "Your AIs" step (`mode: 'onboarding'`) and its "cannot start"
   * screen (`recovery`); `settings` is no longer painted, each provider's page
   * shows its program instead, and stays for older plugins. `null` outside
   * that slot. The host owns the data and the gestures: it starts an install,
   * follows its console and reads the cards again when it ends.
   */
  export function useProviderCliCards(): {
    mode: 'onboarding' | 'settings' | 'recovery';
    /** `null` until the daemon answered. */
    backends: ProviderCli[] | null;
    /** The daemon refused the list (not a superadmin) or could not be reached. */
    unavailable: boolean;
    jobs: Readonly<Record<string, ProviderCliInstallJob>>;
    /** `false` when update checks are off: show no "Update available". */
    updateCheck: boolean;
    /** A refresh or a check is under way. */
    busy: boolean;
    /** Nothing may be started. */
    disabled: boolean;
    /** Runs the vendor's installer of `name` (an update is the same gesture). Only for a CLI with `installable`. */
    install(name: string): Promise<void>;
    /** "Try again": asks every installed CLI again whether it is signed in. */
    refresh(): Promise<void>;
    /** Asks the vendors for their newest version now. */
    checkUpdates(): Promise<void>;
    /**
     * "Sign in": types the CLI's `signInCommand` (never followed by Enter) in Timon's terminal
     * when the view has one (`terminal`), else copies it (`copied`); `failed` when neither worked.
     */
    signIn(name: string): Promise<'terminal' | 'copied' | 'failed'>;
  } | null;

  /** A Kanban task's type, priority 1 (someday) to 5 (urgent). Client API 14. */
  export type TaskFormType = 'code' | 'review' | 'merge' | 'research' | 'doc' | 'chore';
  /** The task a `task.form` occupant edits, as the daemon stores it (lists are JSON text). Client API 14. */
  export type TaskFormTask = {
    id: string;
    title: string;
    description?: string | null;
    agent_name: string;
    status?: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED';
    priority: number;
    /** JSON array of task ids. */
    deps: string;
    scheduled_at?: number | null;
    type?: TaskFormType;
    backend_override?: string | null;
    model_override?: string | null;
    fallback_backend_override?: string | null;
    fallback_model_override?: string | null;
    permission_mode_override?: string | null;
    extra_skills?: string | null;
    extra_mcp_servers?: string | null;
    extra_allowed_tools?: string | null;
    pipeline?: string | null;
    todo_id?: number | null;
    effective_backend?: string | null;
    effective_model?: string | null;
    attachment_count?: number;
    /** The report the agent closed the task with. */
    done_comment?: string | null;
    [field: string]: unknown;
  };
  /** What `submit` sends to the daemon. Client API 14. */
  export type TaskFormBody = {
    title: string;
    description: string;
    agent_name: string;
    priority: number;
    type: TaskFormType;
    deps: string[];
    /** Epoch milliseconds; `null` on an edited task clears its date. */
    scheduled_at: number | null;
    backend_override: string | null;
    model_override: string | null;
    /** `'none'`: this task never moves to another backend on its own. */
    fallback_backend_override: string | null;
    fallback_model_override: string | null;
    permission_mode_override: string | null;
    /** Edition only: erase both fallback halves, or restore the agent's mode. Null alone keeps them. */
    clear_fallback?: boolean;
    clear_permission_mode?: boolean;
    extra_skills: string[];
    extra_mcp_servers: string[];
    extra_allowed_tools: string[];
    /** Creation only (ignored on an edited task). */
    pipeline?: 'full' | 'code-self' | 'code-group' | null;
    todo_id: number | null;
  };
  /** A file attached to a task; `task_id` is the task that owns it (an iteration inherits its root's). Client API 14. */
  export type TaskFormAttachment = {
    id: string;
    task_id: string;
    name: string;
    size: number;
    mime: string;
    kind: 'image' | 'document';
    created_at: number;
  };
  /** Why a file was not attached: the daemon's `code` (`attachment_too_large`, `attachment_type_refused`…) and text. */
  export type TaskFormAttachmentRefusal = { code: string; message: string | null };
  /**
   * The host a `task.form` occupant is painted for (client API 14): the
   * creation or edition of a task, from the Kanban board, the Agents page or
   * the agents grid. `null` outside that slot. The host keeps the modal frame
   * (focus held and given back, Escape) and the daemon's calls; the occupant
   * paints the fields inside it.
   */
  export function useTaskForm(): {
    mode: 'create' | 'edit';
    /** The edited task; `null` for a new one. */
    task: TaskFormTask | null;
    defaultAgent: string | null;
    /** The agents the screen already holds (a name at least); `/api/ui/agents` gives the full list. */
    agents: readonly { name: string; project?: string | null; role?: string | null; backend?: string | null; model?: string | null }[];
    /** Creates or updates the task and hands back its id; does not close. */
    submit(body: TaskFormBody): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    attachments: {
      list(taskId: string): Promise<TaskFormAttachment[]>;
      upload(taskId: string, file: File): Promise<{ ok: true; attachment: TaskFormAttachment } | { ok: false; refusal: TaskFormAttachmentRefusal }>;
      remove(attachment: TaskFormAttachment): Promise<{ ok: true } | { ok: false; refusal: TaskFormAttachmentRefusal }>;
      /** Where the file is served (inline for an image or a PDF); `download` asks for a download. */
      url(attachment: TaskFormAttachment, download?: boolean): string;
    };
    /** The work is saved: the screen re-reads its tasks and the form closes. */
    finish(): void;
    /** Closes without saving. */
    close(): void;
    /** Deletes the edited task (the host confirms) and closes once it is gone; `null` where the screen offers no deletion. */
    remove: (() => Promise<void>) | null;
    /** Put it on the form's heading: it names the dialog. */
    titleId: string;
  } | null;

  /**
   * "Open in a new window" (client API 14, multi-window V5): in the desktop
   * app, a function that opens `route` (a path of the app such as
   * `/kanban` or `/acme?tab=2`; the page on screen by default) in one more
   * window on the machine this window shows, resolving to `true` once the
   * window is opened. `null` on the web, in the PWA and in an older desktop:
   * hide the control then. A URL, another origin, sign-in, setup or `/api`
   * resolve to `false` without opening anything.
   */
  export function useOpenInNewWindow(): ((route?: string) => Promise<boolean>) | null;

  /**
   * A `nav.item` entry drawn like the product's own (client API 15). Props:
   * `href` (the route, the same as the registration's `key`), `label` (shown as
   * given), `icon` (a component taking `className`, painted at the size of the
   * product's icons). It follows the rail folded (icon only, the label as a
   * tooltip) or unfolded, lights on its active route, and shows inert in the menu
   * editor. Render it as the whole entry: `ctx.slots.register({ slot: 'nav.item',
   * key: '/acme' }, () => h(NavLink, { href: '/acme', label: 'Acme', icon: AcmeIcon }))`.
   */
  export const NavLink: PlatformComponent;

  /** A folder (or, in file mode, a file) inside a listed level; `path` is built by the daemon. Client API 15. */
  export type DirectoryEntry = { name: string; path: string; hidden: boolean };
  /**
   * One level of the active machine's disk (client API 15). `parent` is
   * `null` at a root; `roots` lists the drives present on Windows (`/` elsewhere);
   * `truncated` says the level holds more folders (or files) than were sent (1000).
   * File mode only: `files`, the level's files that pass the form's endings,
   * and `selected`, the file the read named when it passes them — `path` is
   * then its folder (a file out of the endings opens its folder unselected).
   */
  export type DirectoryListing = {
    path: string;
    parent: string | null;
    entries: DirectoryEntry[];
    truncated: boolean;
    home: string;
    roots: string[];
    files?: DirectoryEntry[];
    selected?: string;
    [field: string]: unknown;
  };
  /**
   * Why a level could not be read. `forbidden`: this account may not list the
   * machine's folders. `outdated`: the machine runs a Timon without this route —
   * let the person type the path. Client API 15.
   */
  export type DirectoryListError = 'not_found' | 'not_a_directory' | 'relative_path' | 'unreadable' | 'forbidden' | 'outdated' | 'failed';
  export type DirectoryRead = { ok: true; listing: DirectoryListing } | { ok: false; error: DirectoryListError };
  /**
   * The host a `directory.picker` occupant is painted for (client API 15): one
   * request for a folder of the machine the window drives, from Settings, a
   * project or an agent — or, in file mode, for a file the daemon reads (a
   * plugin archive, a CLI binary). `null` outside that slot. The host keeps the dialog
   * frame (named for assistive technology, focus held and given back, Escape)
   * and the daemon's calls; the occupant paints the levels inside it. On this
   * computer's own daemon in the desktop app, the OS dialog opens instead and
   * the slot is not painted.
   */
  export function useDirectoryBrowser(): {
    /**
     * `directory`: the form wants a folder. `file`: it wants a file, listed in
     * `listing.files` (the daemon serves them to a superadmin only).
     */
    mode: 'directory' | 'file';
    /** File mode: the endings the form takes (`.tgz`…), already applied by the daemon; `[]` for any file. */
    accept: readonly string[];
    /** The folder (or, in file mode, the file) the form holds; `''` when it holds none. */
    initialPath: string;
    /** The first level to show: `initialPath` when the daemon can read it, otherwise its home. */
    opening(): Promise<DirectoryRead>;
    /** One level of the active machine's disk; `null` asks for the daemon's home. */
    read(path: string | null): Promise<DirectoryRead>;
    /**
     * Hands a path the daemon served back to the form, and closes. In file
     * mode only a served file (`listing.files[].path`, `listing.selected`) is
     * taken; any other path, a folder included, is ignored.
     */
    choose(path: string): void;
    /** Closes without changing the form. */
    cancel(): void;
  } | null;

  /** A confirmation asked with `confirmAction` (client API 15). A bare string is the title. */
  export type ConfirmRequest = {
    /** The question itself, short. */
    title: string;
    /** What the answer changes, when the title alone does not say it. */
    description?: string;
    /** Label of the yes button; "Confirm" by default. */
    confirmLabel?: string;
    /** Label of the no button; "Cancel" by default. */
    cancelLabel?: string;
    /** The yes destroys or stops something: painted as a danger, and Enter does not reach it. */
    destructive?: boolean;
  };
  /**
   * Asks the user to confirm in Timon's own dialog — never the browser's
   * `confirm()` (client API 15). Resolves `true` on an explicit yes, `false`
   * on no, Escape or a click outside. Questions asked while one is open wait
   * in line. Without the app's host on the page, nothing is asked and the
   * answer is `false`.
   */
  export function confirmAction(request: ConfirmRequest | string): Promise<boolean>;
  /**
   * The question a `confirm.dialog` occupant is painted for (client API 15);
   * `null` outside that slot. The host keeps the frame (an `alertdialog` named
   * for assistive technology with `title` and `description`, focus held and
   * given back, Escape and a click outside answering no) and settles the
   * caller; the occupant paints the question and its two buttons inside.
   * Labels arrive translated, defaults filled in.
   */
  export function useConfirmDialog(): {
    title: string;
    /** `null` when the caller gave none. */
    description: string | null;
    confirmLabel: string;
    cancelLabel: string;
    destructive: boolean;
    /** Answers yes and closes. */
    confirm(): void;
    /** Answers no and closes. */
    cancel(): void;
  } | null;

  /**
   * Where the frosted glass sits for the calling component (client API 15),
   * so a widget can match it: `'island'` — its island is one frosted plate and
   * the widget draws no blur of its own, only a light surface; `'widgets'` —
   * the island is clear (the wallpaper shows) and each widget is a frosted
   * card; `'both'` — the island is a frosted plate and each widget is frosted
   * again on top; `null` while the glass is off. The island's own choice (its menu)
   * wins over the Appearance setting. Live: it changes without a reload.
   */
  export function useGlassScope(): 'island' | 'widgets' | 'both' | null;

  /*
   * Formatters in the reader's language (client API 15): the product's own, so
   * a plugin's dates and numbers read like the screens around it, in every
   * language the product ships, without a branch on `getLocale()`. Each takes
   * an optional BCP 47 `locale` last; omitted, the reader's language. The time
   * zone is the system's unless the options name one. An unreadable date gives ''.
   */
  /** A calendar date: `'medium'` by default ("4 nov. 2026", "Nov 4, 2026"), a style or `Intl` options. */
  export function formatDate(
    value: Date | number | string,
    style?: 'short' | 'medium' | 'long' | 'full' | Intl.DateTimeFormatOptions,
    locale?: string,
  ): string;
  /** A time of day; two-digit hour and minute by default ("14:05", "02:05 PM"). */
  export function formatTime(value: Date | number | string, options?: Intl.DateTimeFormatOptions, locale?: string): string;
  /** A date and its time; by default what `toLocaleString()` prints, in the reader's language. */
  export function formatDateTime(value: Date | number | string, options?: Intl.DateTimeFormatOptions, locale?: string): string;
  /** A number with the language's separators ("1 234,5", "1,234.5"). */
  export function formatNumber(n: number, options?: Intl.NumberFormatOptions, locale?: string): string;
  /** A ratio as a percentage: 0.42 → "42 %", "42%". */
  export function formatPercent(ratio: number, options?: Intl.NumberFormatOptions, locale?: string): string;
  /** A byte count in decimal units and the language's unit words ("1.2 MB", "1,2 Mo"). */
  export function formatBytes(bytes: number, locale?: string): string;
  /** How far `value` is from `now` (default: now): "il y a 3 min", "in 2 days", "now" under a minute. */
  export function formatRelativeTime(
    value: Date | number | string,
    now?: number,
    style?: 'long' | 'short' | 'narrow',
    locale?: string,
  ): string;
  /** An elapsed time in milliseconds, in its narrowest units, for a line of metadata (`12m`, `3h`, "3j"). */
  export function formatAgeShort(ms: number, locale?: string): string;
  /** A list joined the language's way: "a, b, and c", "a, b et c"; `'or'` for a choice. */
  export function formatList(items: readonly string[], type?: 'and' | 'or', locale?: string): string;
  /** The language's text order, for `array.sort((a, b) => compareText(a, b))`. */
  export function compareText(a: string, b: string, locale?: string): number;
  /** An entry of the Apps catalogue, its texts in the viewer's language. Client API 15. */
  export type AppCardApp = {
    slug: string;
    name: string;
    publisher: string;
    category: 'code' | 'data' | 'design' | 'productivity' | 'business';
    tagline: string;
    description: string;
    examples: readonly string[];
    /** The publisher's MCP endpoint. */
    url: string;
    /** `key`: a token the user pastes (`label` names it, `helpUrl` is where the publisher issues it). */
    auth: { type: 'oauth' } | { type: 'key'; label: string; helpUrl: string } | { type: 'none' };
    links: { website: string; privacy: string; terms: string };
    /**
     * The brand tile: `color` is its background. `logo` (since 4 November 2026) is the
     * publisher's mark as SVG path data in `viewBox`; a path without `fill` takes the ink
     * that reads on `color`. Without `logo`, paint `monogram`.
     */
    icon: {
      monogram: string;
      color: string;
      logo?: { viewBox: string; paths: readonly { d: string; fill?: string }[] };
    };
    /** The MCP server it is connected under (`app-<slug>`). */
    mcpId: string;
  };
  /**
   * The card an `apps.card` occupant is painted for (client API 15): one app of
   * the Apps page, each card with its own; `null` outside that slot. The host
   * owns the data and the gestures — it creates the MCP server, opens the
   * publisher's consent page, keeps a key in the vault — and has already said
   * why when a gesture answers `false`.
   */
  /**
   * The MCP tab of Capabilities around an `mcp.featured` occupant (client API 15): what
   * the user typed in its search field, to filter a section with; `null` outside that slot.
   */
  export function useMcpTab(): { query: string } | null;
  export function useAppCard(): {
    app: AppCardApp;
    /** `consent`: the server exists, the publisher's sign-in is not given yet; `blocked`: a server of the same id was added by hand. */
    status: 'available' | 'connecting' | 'consent' | 'connected' | 'blocked';
    /** The consent page last opened, to open again when the browser blocked the tab. */
    consentUrl: string | null;
    /** The secrets vault is off: an app of type `key` cannot be connected. */
    vaultOff: boolean;
    /** `key` is required for `auth.type === 'key'`, refused otherwise; an `oauth` app opens its consent page. */
    connect(key?: string): Promise<boolean>;
    /** Asks for confirmation, then removes the server and its key. */
    disconnect(): Promise<boolean>;
  } | null;

  /*
   * Route errors (client API 15). A route answers `{ error, code, params? }`
   * (`apiError` of `@timon-ai/sdk`): `error` in English, `code` a stable
   * snake_case name, `params` what its message interpolates.
   */
  /** What a failed body says: `null` when it carries neither `error` nor a valid `code`. */
  export function parseApiError(body: unknown): {
    message: string;
    code: string | null;
    params: Record<string, string | number>;
  } | null;
  /**
   * The message to show: the product's `apiErrors.<code>` in the reader's
   * language when it has one, else the route's English `error`, else
   * `fallback` (a sentence, or `{ status }` for "HTTP 502"). A plugin's own
   * codes go through its translator: `parseApiError` then `t(code, params)`.
   */
  export function apiErrorMessage(body: unknown, fallback?: string | { status: number }): string;

  /** A task as a `kanban.card` occupant reads it (client API 15): the stored row, lists as JSON text. */
  export type KanbanCardTask = TaskFormTask & {
    status: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED';
    created_at: number;
    updated_at: number;
    /** The task's mission, once one ran. */
    mission_id?: string | null;
    /** First start by the dispatcher: the running time is counted from it. */
    started_at?: number | null;
    blocked_reason?: string | null;
    /** System cause of an interruption (`rate_limit`, `killed`, `timeout`, `crash`); `null` for a block the agent decided. */
    interrupted_reason?: string | null;
    /** The series the task belongs to; `null` when isolated. */
    series_id?: string | null;
    /** Tasks waiting on this one: its `deps` (`dep`) and the verification chain it heads (`chain`). */
    dependents?: { id: string; kind: 'dep' | 'chain' }[];
  };
  /** What the product knows of the agent a task is assigned to, ready to paint (client API 15). */
  export type KanbanCardAgent = {
    name: string;
    /** Accent colour: the agent's, else its project's, else a hashed palette entry. */
    accent: string;
    iconUrl: string | null;
    /** Emoji or initials, when there is no icon. */
    fallback: string;
    roleKey: string | null;
    /** `false` for the daemon's pseudo senders (`orchestrator`, `cockpit`…). */
    known: boolean;
  };
  /**
   * The item a `kanban.card` occupant paints (client API 15): one TO DO idea
   * (`kind: 'todo'`) or one task (`kind: 'task'`), in a board column
   * (`density: 'card'`) or a TO DO widget's list (`'row'`). `null` outside
   * that slot. The host owns the data and the gestures; a replacement paints
   * and calls them, it never calls the daemon for them.
   */
  export function useKanbanCard(): ({
    density: 'card' | 'row';
    /** Opens the item's popup. */
    open(): void;
  } & ({
    kind: 'todo';
    item: TodoItem & { promoted_task_id: string | null };
    /** What the tile shows besides the title and tags: a widget's display options. */
    show: { id: boolean; author: boolean; project: boolean };
    /** Ticks the idea done or opens it again; `null` where the host offers no checkbox. */
    toggleDone: (() => void) | null;
    /** Hands the idea to its project's orchestrator (the host reports how it went); `null` for an idea without a project. */
    handoff: (() => void) | null;
    /** Deletes the idea; `null` where the host offers no deletion. */
    remove: (() => void) | null;
  } | {
    kind: 'task';
    task: KanbanCardTask;
    /** The whole board, unfiltered, by id: a filter must not change what a task waits on. */
    board: ReadonlyMap<string, KanbanCardTask>;
    /** The board's clock (ms), ticked for running times. */
    now: number;
    agent: KanbanCardAgent;
    /** The role on the agent's sheet, as its label. */
    agentRole: string | null;
    /** The idea the task carries out (`todo_id`), when the board holds it. */
    todo: (TodoItem & { promoted_task_id: string | null }) | null;
    /** The running mission waits for a validation. */
    needsAction: boolean;
    dragging: boolean;
    /** Where the model catalogue of the task's parameters is read for. */
    modelTarget: { project?: string | null; agent?: string | null };
    /** Spread it on the card's root: the board moves the task when it is dropped on a column. */
    drag: { draggable: boolean; onDragStart(): void; onDragEnd(): void };
    /** Stops the running mission; the board asks first. */
    stop(): void;
    /** Opens the "mark as merged" dialog of a DONE code task. */
    markMerged(): void;
    /** Opens the series graph centred on `focusId`. */
    openGraph(focusId: string | null): void;
    /** The task changed from the card: the board reads it again. */
    refresh(): void | Promise<void>;
  })) | null;

  /** What a `todo.form` occupant's `submit` sends: the whole idea, as the form holds it. Client API 15. */
  export type TodoFormBody = {
    text: string;
    project: string | null;
    /** Markdown. */
    notes: string | null;
    urgency: 'critical' | 'bug' | 'minor' | 'idea' | null;
    progress: 'todo' | 'analyzed' | 'partial' | 'to_test' | 'done';
  };
  /** A file attached to a TO DO idea. Client API 15. */
  export type TodoFormAttachment = {
    id: string;
    todo_id: number;
    name: string;
    size: number;
    mime: string;
    kind: 'image' | 'document';
    created_at: number;
  };
  /**
   * The host a `todo.form` occupant is painted for (client API 15), the twin of
   * `useTaskForm`: the creation or edition of a TO DO idea, from the Kanban
   * column or a TO DO widget. `null` outside that slot. The host keeps the
   * modal frame (focus held and given back, Escape) and the daemon's calls;
   * the occupant paints the fields inside it.
   */
  export function useTodoForm(): {
    mode: 'create' | 'edit';
    /** The edited idea; `null` for a new one. */
    item: (TodoItem & { promoted_task_id: string | null }) | null;
    /** The project the screen opened the form on; the field stays editable. */
    defaultProject: string | null;
    /** Creates or updates the idea and hands back its id; does not close. Upload a new idea's files with that id, then `finish()`. */
    submit(body: TodoFormBody): Promise<{ ok: true; id: number } | { ok: false; error: string }>;
    /**
     * The idea's files, the same gestures as `useTaskForm().attachments`: 15 MB per file, 20 files or 100 MB per
     * idea, images, PDF, text and office documents. A change is read again by the screen when the form closes.
     */
    attachments: {
      list(todoId: number): Promise<TodoFormAttachment[]>;
      upload(todoId: number, file: File): Promise<{ ok: true; attachment: TodoFormAttachment } | { ok: false; refusal: TaskFormAttachmentRefusal }>;
      remove(attachment: TodoFormAttachment): Promise<{ ok: true } | { ok: false; refusal: TaskFormAttachmentRefusal }>;
      /** Where the file is served (inline for an image or a PDF); `download` asks for a download. */
      url(attachment: TodoFormAttachment, download?: boolean): string;
    };
    /** Hands the idea to its project's orchestrator (the way from an idea to a task); `null` for a new idea or one without a project. */
    handoff: (() => Promise<{ ok: true; agent: string } | { ok: false; error: string }>) | null;
    /** The screen reads the idea again; the form stays open. */
    refresh(): Promise<void>;
    /** The work is saved: the screen reads its ideas again and the form closes. */
    finish(): void;
    /** Closes without saving. */
    close(): void;
    /** Deletes the edited idea (the host confirms) and closes; `null` where the screen offers no deletion. */
    remove: (() => Promise<void>) | null;
    /** Put it on the form's heading: it names the dialog. */
    titleId: string;
  } | null;

  /** A heading of a list page, as the `page.toc` occupant lists it. Client API 15. */
  export type PageTocEntry = {
    /** The heading's `id`, also its anchor. */
    id: string;
    label: string;
    /** 1: a section; 2: a sub-section of the section above it. */
    level: 1 | 2;
    /** The number of items the section holds, when the page says it. */
    count: number | null;
  };
  /**
   * The table of contents a `page.toc` occupant is painted for (client API 15):
   * the sticky column on the left of a long list page (the Skills and MCP tabs
   * of Capabilities). `null` outside that slot. The host reads the headings and
   * follows the one in view; a section of a plugin enters the table by its
   * markup alone — an element with an `id` and `data-toc="<label>"`, optionally
   * `data-toc-level="2"` and `data-toc-count="<n>"`.
   */
  export function usePageToc(): {
    /** In reading order; they follow the page's search filter. */
    entries: readonly PageTocEntry[];
    /** The section in view; `null` before the page has any. */
    active: string | null;
    /** Scrolls the page to that heading. */
    go(id: string): void;
  } | null;

  /**
   * The look of an agent's mascot (client API 15): a skull, a fur, eyes and a
   * job accessory. The values are the product's lists, or a part of a mascot
   * pack installed and enabled (`<pluginId>:<slug>`, see `MascotPart`); a host
   * always hands a complete, valid look. Draw an id you do not know with a
   * default.
   */
  export type AgentLook = {
    shape: 'squircle' | 'tri' | 'gem' | 'round' | 'bean' | 'cloud' | 'hex' | `${string}:${string}`;
    /** `#rrggbb`, lower case, one of the product's fur and look colours — or a pack's fur id. */
    color: string;
    eyes: 'pill' | 'big' | 'happy' | 'wink' | 'surprised' | 'squint' | 'sleepy' | 'heart' | 'star' | 'code' | `${string}:${string}`;
    acc: 'none' | 'loupe' | 'pen' | 'quill' | 'hammer' | 'wrench' | 'baton' | 'telescope' | 'envelope' | 'calendar'
      | 'clipboard' | 'hourglass' | 'teacher' | 'calculator' | 'chart' | 'brush' | 'globe' | 'megaphone' | 'shield' | 'coffee'
      | 'whip' | 'wizard' | 'chef' | 'crown' | 'idea' | 'rocket' | 'chemist' | 'gamer' | 'photographer' | 'gardener' | 'musician'
      | `${string}:${string}`;
  };
  /** What an agent is doing (`idle`…`sleeping`) or how it reacts (`happy`…`coding`). Client API 15. */
  export type AgentMascotState =
    | 'idle' | 'listening' | 'thinking' | 'working' | 'searching' | 'waiting' | 'done' | 'error' | 'sleeping'
    | 'happy' | 'celebrate' | 'confused' | 'surprised' | 'sad' | 'angry' | 'love' | 'shy' | 'coding';
  /**
   * The mascot an `agent.mascot` occupant is painted for (client API 15): one
   * agent's head in the onboarding, the agent creation or the chat. `null`
   * outside that slot. Paint a square of `size` pixels; draw what overflows
   * (an accessory) only when `fit` is false.
   */
  export function useAgentMascot(): {
    look: AgentLook;
    /** The `#rrggbb` the look's colour paints: the colour itself, or a pack fur's. */
    fur: string;
    size: number;
    /** The screen wants it alive. Already `false` under `prefers-reduced-motion`. */
    live: boolean;
    state: AgentMascotState | null;
    /** Keep everything inside the box. */
    fit: boolean;
    shadow: boolean;
    /** Accessible name; `null`: decorative, mark it `aria-hidden`. */
    label: string | null;
    /** The user asked for reduced motion: paint a still mascot, no animation at all. */
    reducedMotion: boolean;
  } | null;

  /**
   * Where the code screen stands (client API 15): `idle` waiting for digits,
   * `checking` six digits sent, `ok` accepted (the screen moves on by itself),
   * `bad` a wrong code (`attemptsLeft`), `sent` a new code mailed, `failed` any
   * other refusal (`message`).
   */
  export type EmailCodeState = 'idle' | 'checking' | 'ok' | 'bad' | 'sent' | 'failed';
  /**
   * The code screen an `email.code` occupant is painted for (client API 15):
   * the six digits an email brought — the first account's confirmation in the
   * onboarding, a forgotten password on the login. `null` outside that slot.
   * The host keeps the digits, talks to the daemon and counts the waits down:
   * the occupant paints and calls `input`, `resend`, `changeEmail`.
   */
  export function useEmailCode(): {
    /** `verify`: the first account's address; `reset`: a forgotten password. */
    purpose: 'verify' | 'reset';
    /** Where the code went (for a reset: only if an account here holds it). */
    email: string;
    /** The number of digits (6). */
    length: number;
    /** Typed so far, digits only. */
    digits: string;
    /** Typed or pasted text; the host keeps the digits and checks a complete code. */
    input(value: string): void;
    state: EmailCodeState;
    attemptsLeft: number | null;
    /** The refusal in the reader's language, its wait counted down; `null` when none. */
    message: string | null;
    /** Seconds before `resend` opens; `0` when open. */
    resendIn: number;
    resending: boolean;
    resend(): void;
    /** Back to the form that asked for the code, filled as it was left. */
    changeEmail(): void;
  } | null;

  /**
   * The mascot configurator an `agent.lookstyler` occupant is painted for
   * (client API 15): one agent's look being edited, in the onboarding's side
   * panel and the agent editor's Avatar tab. `null` outside that slot. The
   * occupant paints the inside only (preview, choices, a random draw); the
   * panel or tab around it, its title and its "Done" are the screen's.
   */
  export function useLookStyler(): {
    /** Complete and valid: the host has normalised it. */
    look: AgentLook;
    /** Hands a new look to the screen; a field off the lists keeps its current value. */
    onChange(look: AgentLook): void;
    /** The agent's name as the screen shows it (a draft during the onboarding). */
    name: string;
    /** The agent's role (`coder`, `review`…); `null` when it has none. */
    role: string | null;
    /** The states the product's preview offers to try, in order. */
    states: readonly AgentMascotState[];
    /**
     * What a look is drawn from: the product's lists, then the parts of the
     * mascot packs installed and enabled. The daemon refuses anything else.
     */
    choices: {
      shapes: readonly AgentLook['shape'][];
      colors: readonly string[];
      eyes: readonly AgentLook['eyes'][];
      accessories: readonly AgentLook['acc'][];
    };
    /** The packs whose parts `choices` holds, to group them by pack; empty without any. */
    packs: readonly {
      pluginId: string;
      /** The plugin's name in the gallery, or its id. */
      label: string;
      parts: readonly { id: `${string}:${string}`; type: 'shape' | 'color' | 'eyes' | 'acc'; label: string }[];
    }[];
    /** A whole look drawn at random from `choices`, packs included. */
    random(): AgentLook;
  } | null;

  /**
   * A provider's one status line (client API 16), the same verdict on the list
   * and on its page: green `connected` / `available`, yellow `not-connected` /
   * `not-installed` / `needs-authorization`, red `blocked`, grey `disabled`.
   */
  export type ProviderStatus =
    | 'disabled' | 'blocked' | 'not-installed' | 'needs-authorization' | 'connected' | 'not-connected' | 'available';
  /**
   * One provider as the daemon groups it (client API 16): a provider plugin
   * (one per backend when it brings several), a backend added by hand
   * (`user:<id>`), an agent of the ACP registry (`catalog:<id>`) or a built-in
   * one. Open-ended: read what you need, a field may be added later. Never a
   * secret value: `secret.names` are vault entry names only.
   */
  export type ProviderOverview = {
    id: string;
    /** The name the model picker shows. */
    name: string;
    brand: string | null;
    /** A pictogram or a logo (`data:` URI); wins over `brand`. */
    icon: string | null;
    origin: 'built-in' | 'user' | 'catalog' | 'plugin';
    /** The plugin that brings it: your sections are painted on the pages whose `pluginId` is your plugin's id. */
    pluginId: string | null;
    enabled: boolean;
    /** It holds the instance's default backend. */
    isDefault: boolean;
    backends: readonly {
      id: string; label: string; active: boolean; disabled: boolean; reason: string | null;
      modelCount: number; defaultModel: string | null; isDefault: boolean; remote: boolean;
    }[];
    modelCount: number;
    /** Agents whose backend is one of its backends; absent from an older daemon. */
    agentCount?: number;
    connection: { signedIn: boolean | null; acceptsAccounts: boolean; [field: string]: unknown };
    secret: { required: boolean; present: boolean; names: readonly string[] };
    status: ProviderStatus;
    updateAvailable: boolean;
    [field: string]: unknown;
  };
  /**
   * The page of one provider a `settings.provider.section` occupant is painted
   * on (client API 16), in Settings › AI models › Providers. `null` outside it.
   * A section registered by a plugin is painted on the pages of the providers
   * that plugin brings only; registered with the `key` of a common section
   * (`connection`, `apiKey`, `models`, `program`, `settings`) it takes that
   * section's place there. `order` places it: the common ones are 100
   * (Connection), 200 (API key), 250 (Models), 300 (Program) and 400 (own
   * settings); without one it comes last.
   */
  export function useProviderPage(): {
    provider: ProviderOverview;
    status: ProviderStatus;
    /** The instance's default backend, `null` when none resolves. */
    defaultBackend: string | null;
    /** Reads the provider again: call it after your section changed something. */
    refresh(): Promise<void>;
    /** Back to the providers list. */
    back(): void;
  } | null;
  /**
   * The frame of a provider page's section (client API 16): a short `title`
   * above a card raised over the page, whose children are rows
   * (`ProviderSettingRow`). `description` folds behind an information mark
   * (no paragraph under the title); `actions` are small controls at the right
   * of the title.
   */
  export const ProviderSection: PlatformComponent;
  /**
   * One row of a `ProviderSection` card (client API 16): `title` and one
   * `status` line at the left (`leading` before them: a logo), ONE main
   * `action` at the right (a button, a switch), the secondary actions as
   * `DropdownMenuItem`s in `menu`, painted in a "…" menu (`menuLabel` names
   * it). `children` unfold under the row: what a gesture opens, never a form
   * shown in permanence. `data-*` attributes are passed through.
   */
  export const ProviderSettingRow: PlatformComponent;
  /**
   * The row a `providers.row` occupant is painted for (client API 16): one
   * provider in the providers list of Settings › AI models (`mode: 'settings'`)
   * or in the first-run "Your AIs" step (`mode: 'onboarding'`). `null` outside
   * a row. Show the provider's logo, name and one status line; offer `open`
   * when it is set (the list: the provider's page) and paint `action` at the
   * end when the surface hands one (the onboarding's install button).
   */
  export function useProviderRow(): {
    mode: 'settings' | 'onboarding';
    provider: ProviderOverview;
    status: ProviderStatus;
    /** Opens the provider's page; `null` where the row leads nowhere. */
    open: (() => void) | null;
    /** The surface's own control for this row, or `null`. */
    action: unknown;
  } | null;
  /**
   * The host of one provider's row (client API 16): paints the `providers.row`
   * occupant for `provider`, with `onOpen`, `action` and `mode` as
   * `useProviderRow()` reads them.
   */
  export const ProviderRow: PlatformComponent;
}

declare module '@timon/api' {
  /** Same-origin `fetch`, bound to the app window. */
  export const api: typeof fetch;
}

declare module '@timon/theme' {
  export const theme: { current(): 'light' | 'dark' };
}

declare module '@timon/navigate' {
  export function navigate(href: string): void;
}
