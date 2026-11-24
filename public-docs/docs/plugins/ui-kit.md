---
title: UI kit
sidebar_position: 15
---

Import shared components from `@timon/ui` so your plugin uses the same React instance, controls and theme tokens as Timon.

Timon serves these modules to the browser; nothing installs them. To type-check a browser half against them, add `"types": ["@timon-ai/sdk/ui"]` to your `tsconfig.json` (or `/// <reference types="@timon-ai/sdk/ui" />` at the top of a file): `@timon-ai/sdk/ui` declares `@timon/ui`, `@timon/api`, `@timon/theme` and `@timon/navigate`. The components are typed loosely (the SDK does not depend on React); narrow them in your own code if you need to.

| Export | Use |
| --- | --- |
| `Slot`, `SlotKeyed` | Render extension points your component declares |
| `Tile` | Frame for a widget using `frame: 'none'` |
| `BrandMark` | Backend brand mark using a catalogue brand or model slug; unknown brands get a fallback |
| `Button`, `Input`, `Label`, `Switch`, `Separator` | Form primitives |
| `DropdownMenu*`, `Tooltip*` | Menus and tooltips |
| `AnchoredPopover` | Panel anchored to a button and kept inside the window — what a compact widget opens on click (see below). Requires `"apiVersion": 6` |
| `NativeViewCover` | Brings a portal you mount yourself above the desktop's built-in browser (API 14; see [below](#nativeviewcover)) |
| `useOpenInNewWindow` | Opens a page of the app in a new desktop window on the same machine; `null` outside the desktop app (API 14; see [below](#useopeninnewwindow)) |
| `NavLink` | A `nav.item` entry drawn like the product's own: `href`, `label`, `icon` (a component taking `className`). It folds to its icon with the rail, lights on its route and stays inert while the menu is being customized (API 15) |
| `useAgentMenuItem` | The agent an `agent.menu.item` entry is rendered for: `{ name, role }`, or `null` outside that slot (API 15) |
| `useGlassScope` | Where the frosted glass sits for your widget: `'island'`, `'widgets'`, `'both'`, or `null` when it is off (API 15; see [below](#useglassscope)) |
| `Dialog`, `DialogPortal`, `DialogOverlay`, `DialogTrigger`, `DialogClose`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription` | Dialog composition |
| `Select`, `SelectGroup`, `SelectValue`, `SelectTrigger`, `SelectContent`, `SelectLabel`, `SelectItem`, `SelectSeparator`, `SelectScrollUpButton`, `SelectScrollDownButton` | Select composition |
| `HUD_SURFACE` | Theme-aware cockpit surface classes; opaque string for `cn(HUD_SURFACE, className)` |
| `cn` | Merge class names |
| `t`, `getLocale` | Product translations, and the reader's language as a BCP 47 tag (`en`, `fr`, `pt-BR`…) |
| `createTranslator` | Translations shipped by your own plugin, in any language (API 15 for ICU plurals; see [below](#plugin-languages)) |
| `formatDate`, `formatTime`, `formatDateTime`, `formatNumber`, `formatPercent`, `formatBytes`, `formatRelativeTime`, `formatAgeShort`, `formatList`, `compareText` | Dates, numbers, sizes, relative times, lists and sort order in the reader's language: the formatters Timon itself uses (API 15) |
| `apiErrorMessage`, `parseApiError` | The message of a route error in the reader's language (API 15, see below) |
| `useIslandContent`, `openInIsland`, `startIslandDrag` | Island tab context, opening and drag sources (API 8; see [Island content](island.md)) |
| `useUiDocument`, `UiDocumentFrame`, `uiDocumentUrl` | The `chat.document` card: the document on screen, its sandboxed frame with bridge and focus guard, and the only URL to load (API 9; see [HTML documents in a conversation](ui-documents.md)) |
| `usePromptHistory`, `canRecallPrompt`, `isTextareaWrapped` | The per-agent prompt history the chat input recalls with ↑ / ↓ (API 12; see [Composer](composer.md#prompt-history)) |
| `useModelPicker` | The `model.picker` occupant's host: value, `onChange`, `inherit`, `filter`, `target`, `footer`, `disabled`, `mode` (API 13; see [Slots](slots.md#special-surfaces)) |
| `useProviderCliCards` | The `providers.cli` occupant's host: the AI CLI cards, their install jobs and console, and `install`, `refresh`, `checkUpdates`, `signIn` (API 14; see [Slots](slots.md#special-surfaces)) |
| `useTaskForm` | The `task.form` occupant's host: the task (or none), the agents, `submit`, the attachment actions, `finish`, `close`, `titleId` (API 14; see [Slots](slots.md#special-surfaces)) |
| `useDirectoryBrowser` | The `directory.picker` occupant's host: `mode` (`directory` or `file`), `accept`, `initialPath`, `opening`, `read` (one level of the active machine's disk), `choose`, `cancel` (API 15; see [Slots](slots.md#special-surfaces)) |
| `useConfirmDialog` | The `confirm.dialog` occupant's host: `title`, `description`, `confirmLabel`, `cancelLabel`, `destructive`, `confirm`, `cancel` (API 15; see [Slots](slots.md#special-surfaces)) |
| `useUpdateStatus` | Deprecated since API 17: answers `null`, the `updates.banner` slot is no longer painted (see [Slots](slots.md#special-surfaces)) |
| `useAppCard` | The `apps.card` occupant's host: `app`, `status`, `consentUrl`, `vaultOff`, `connect`, `disconnect` (API 15; see [Slots](slots.md#special-surfaces)) |
| `useMcpTab` | The Connectors tab around an `mcp.featured` section: `{ query }`, its search (API 15; see [Slots](slots.md#special-surfaces)) |
| `usePageToc` | The `page.toc` occupant's host: `entries` (`id`, `label`, `level`, `count`), `active`, `go(id)` (API 15; see [Slots](slots.md#special-surfaces)) |
| `useAgentMascot` | The `agent.mascot` occupant's host: `look` (`shape`, `color`, `eyes`, `acc`), `size`, `live`, `state`, `fit`, `shadow`, `label`, `reducedMotion` (API 15; see [Slots](slots.md#special-surfaces)) |
| `useEmailCode` | The `email.code` occupant's host: `purpose`, `email`, `length`, `digits`, `input`, `state`, `attemptsLeft`, `message`, `resendIn`, `resending`, `resend`, `changeEmail` (API 15; see [Slots](slots.md#special-surfaces)) |
| `useLookStyler` | The `agent.lookstyler` occupant's host: `look`, `onChange`, `name`, `role`, `states`, `choices` (`shapes`, `colors`, `eyes`, `accessories`), `random` (API 15; see [Slots](slots.md#special-surfaces)) |
| `useProviderPage`, `ProviderSection`, `ProviderSettingRow` | The page of one provider a `settings.provider.section` occupant is painted on: `provider`, `status`, `defaultBackend`, `refresh`, `back`; the frame of Timon's own sections, a short label over a card (`title`, `description`, `actions`, children); and the card's row (`title`, `status`, `leading`, one `action`, a `menu` of `DropdownMenuItem`s, `children` unfolded under it) (API 16; see [Providers](providers.md#add-a-section-to-your-providers-page)) |
| `useProviderRow`, `ProviderRow` | One provider's row a `providers.row` occupant is painted for: `mode`, `provider`, `status`, `open`, `action`; and the host that paints a row for a `provider` (`onOpen`, `action`, `mode`) (API 16; see [Slots](slots.md#special-surfaces)) |
| `useNotices`, `useNotice` | The bottom-left cards: what a `notices` entry pushes with (`notices`, `push`, `remove`), and the card a `notices.card` occupant paints (`notice`, `dismiss`, `act`) (API 17; see [Slots](slots.md#special-surfaces)) |
| `useUpdateDialog` | The update window an `updates.dialog` occupant paints: `version`, `publishedAt`, `highlights`, `notesUrl`, `download`, `step`, `line`, `command`, `alert`, `actions`, `close` (API 17; see [Slots](slots.md#special-surfaces)) |
| `useKanbanCard` | The `kanban.card` occupant's item: a TO DO idea (`kind: 'todo'`) or a task (`kind: 'task'`), its `density` and the gestures the host offers (API 15; see [Slots](slots.md#special-surfaces)) |
| `useTodoForm` | The `todo.form` occupant's host: `mode`, the idea (or none), `defaultProject`, `submit`, `handoff`, `refresh`, `finish`, `close`, `remove`, `titleId`, `attachments` (API 15; see [Slots](slots.md#special-surfaces)) |
| `useJobDialog` | The job a `kanban.job.dialog` occupant paints: `landing` (the job, its `links` and `repairs` included), `close`, `openTodo`, `openMission`, and Timon's gestures `refresh`, `repair(kind)` and `busy` (API 19; see [Slots](slots.md#special-surfaces)) |
| `useGitStackProject` | The project a widget of the **Git** stack shows: `{ project, inChat }`, the chat's project in a chat's column, else the one picked once for the whole stack (API 19) |
| `GitStackProjectPicker` | The stack's project picker for a widget's header (props `none`, `label`, `className?`); paints nothing in a chat's column (API 19) |
| `useTodoOpener` | `{ openTodo(id), todoModal }`: opens a TO DO idea in Timon's idea form, read again with the reader's rights; paint `todoModal` where it stays mounted (API 19) |
| `useProjectSettings` | The project a `project.settings` row is painted for: `{ project }` (API 19; see [Slots](slots.md#special-surfaces)) |
| `useWidgetCount`, `useWidgetAttention`, `useWidgetMenu`, `useWidgetInFront` | What a widget hands its tab in a stack: a count, a dot while something waits, header actions moved to the widget's menu, and whether it is in view (API 19; see [Widget](widget.md#in-a-stack-of-tabs)) |
| `usePublishDialog` | The **Publish on GitHub** window a `forge.publish.dialog` occupant paints: `project`, `proposal`, `loading`, `repo`, `target`, `account`, `body`, `setBody`, `editable`, `problem`, `busy`, `error`, and Timon's gestures `publish`, `save`, `discard`, `close` (API 19; see [Slots](slots.md#special-surfaces)) |
| `BoardCard` | The tile of a Kanban item, the one Timon's own tiles are laid out with: `identity`, `corner`, `leading`, `title`, `badges`, `context`, `meta`, `actions`, `onOpen`, `muted`, `tone`, `dragging`, `density` (`card` or `row`), `as`. A zone you leave out paints nothing. With `onOpen`, the title becomes a button named after it, so the keyboard and screen readers reach it (on a `draggable` card, an element with the button role, so the card can still be dragged by its title in Firefox); a click elsewhere on the card opens it too, except on one of its own controls (`actions`, `leading`, a link in a badge). Keep links and buttons out of `title` (API 15) |
| `DetailShell` | The inside of a Kanban item's window: `header`, the body as children, `rail` and `railLabel`, `attachments` and `attachmentsLabel`, `footer` (API 15) |
| `DetailFrame` | The window around it: veil, focus kept inside and given back, Escape, a click outside. Props `labelledBy`, `onClose`, children. A `task.form` or `todo.form` occupant is already inside one (API 15) |
| `confirmAction` | Asks a confirmation in Timon's own dialog, from anywhere: `await confirmAction({ title, description?, confirmLabel?, cancelLabel?, destructive? })` resolves `true` only on an explicit yes. Use it instead of the browser's `confirm()` (API 15) |
| `useBackendCatalog`, `vendorLabel`, `isPickable`, `accountStateHint`, `byPower`, `matchesQuery`, `formatWindow` | The model catalogue and the helpers Timon's own picker uses: provider and account label, whether an account can run and why not, models most capable first, the search (pass a trimmed, lower-cased query), « 1 M » / « 200 k » (API 13) |
| `useModelFavorites` | The signed-in account's favourite models, shared by every picker on screen: `favorites`, `ready`, `isFavorite`, `toggle` (API 13) |
| `isNewModel`, `backendLimits`, `BackendLimitsBadge`, `AccountStateBadge` | What Timon's picker shows beyond the names: the « new » badge of a model added this week, the « Remote » / « Limited » chip of a provider, the chip of an account to sign in again (API 13) |

`Separator`, `SelectSeparator` and `DropdownMenuSeparator` leave a blank gap and draw no line.

Plugin-owned translations avoid collisions with product keys (see [Plugin languages](#plugin-languages)). Ship your interface icons yourself; provider logos should use `BrandMark` so the app can keep them consistent.

:::warning Plugin source is not scanned by Tailwind
The app's stylesheet is compiled before a third-party package is installed. Arbitrary classes such as `text-[10px]` or a generated conic-gradient class may not exist and silently do nothing. Use inline styles for precise values and SVG for drawings. Do not assume every standard Tailwind utility is present either; only compiled classes are available.
:::

Theme custom properties remain usable in inline styles, for example `hsl(var(--muted))` or `hsl(var(--primary))`. The supplied quota monitor demonstrates SVG usage rings without depending on plugin-specific stylesheet compilation.


Use the existing `WidgetChromeProps` type from `@timon-ai/sdk` for a
custom widget frame (`widget: { frame: 'none' }`). Forward `className`
to the root, render `handle` in the header actions, and use `editing`
to show configuration controls. The SDK keeps `handle` typed as `unknown`
to avoid a React dependency; narrow it to `React.ReactNode` when rendering.
`handle` is given from `"apiVersion": 17`; `poignee`, its former name,
still holds the same controls and is deprecated.

`DialogContent` includes its portal, overlay and close button. Set
`hideClose` only when supplying your own accessible close control.
`SelectContent` includes its portal and scroll buttons. Compose it with
`SelectItem` children and give the trigger an accessible label.
`HUD_SURFACE` reuses compiled theme classes; do not depend on its literal
value or copy arbitrary Tailwind values into your plugin.

## Plugin languages

Your strings travel with your package and never enter Timon's dictionary, so no key can collide with Timon's or another plugin's. Template: [`examples/plugin-i18n`](examples.md#i18n).

- **One file per language**, `locales/<tag>.json`, named by its BCP 47 tag: `en`, `fr`, `de`, `ja`, `pt-BR`. Nest keys (`{ "files": { "selected": "…" } }`, read as `files.selected`) or write them flat (`{ "files.selected": "…" }`).
- **Ship English complete.** Any other language may be partial: what it lacks is read in English, key by key.
- **Messages are ICU MessageFormat**, like Timon's own: `{name}`, and plurals or selects inside one message, with the plural categories of the language — `{count, plural, one {# file} other {# files}}`; Polish uses `one`, `few`, `many`, `other`; Japanese and Korean `other` alone; `=0 {…}` covers « none ». `#` is written the way the language writes numbers. Put a literal brace between apostrophes (`'{'`). No markup: build a link around two keys.
- **Bundle the files into your browser half.** Timon serves `client.js` alone; a JSON file beside it is out of the browser's reach.

```js
import { createTranslator } from '@timon/ui'
import en from '../locales/en.json' with { type: 'json' }
import fr from '../locales/fr.json' with { type: 'json' }
import pl from '../locales/pl.json' with { type: 'json' }

const t = createTranslator({ en, fr, pl })
t('files.selected', { count: 3 }) // "3 pliki" for a Polish reader
```

The translator reads the reader's language, matched the way Timon matches it but among your languages only (`de-AT` reads your `de`, `pt-PT` your `pt-BR`), then the languages Timon falls back on for it, then your `en`, then the key itself: a missing string shows its key, never an empty label. A plural follows the rules of the language the message comes from. Timon reloads the page when the reader switches language.

The object you pass is read at each call, not copied: you may create the translator over `{}` and add a language to it later, even once an asynchronous load resolves (`MESSAGES.fr = await …`), or replace a language's object. The next call reads it; a widget already on screen shows the new text at its next render, so re-render it yourself when a language arrives late.

`getLocale()` returns the tag of any language Timon ships: never compare it with `'fr'`. For a date, a number, a size or a "3 min ago", import Timon's own formatters from `@timon/ui` (API 15); they read the reader's language and render like the screens around your widget:

```js
import { formatDate, formatRelativeTime, formatBytes } from '@timon/ui'
formatDate(item.createdAt)          // "Nov 4, 2026", « 4 nov. 2026 », "04.11.2026"
formatRelativeTime(item.updatedAt)  // "3 min ago", « il y a 3 min », "vor 3 Min."
formatBytes(file.size)              // "1.2 MB", « 1,2 Mo »
```

Each takes an optional BCP 47 `locale` as its last argument. Times are in the computer's time zone unless the options name one; an unreadable date gives an empty string.

**Route errors.** When a route of your plugin refuses a request, answer `{ error, code, params }` with `apiError` from `@timon-ai/sdk`: `error` is the English sentence command-line tools and agents read, `code` a stable snake_case name, `params` the values your message needs. In the browser, `apiErrorMessage(body, { status: res.status })` shows Timon's own translation when the code is one of Timon's (`not_found`, `invalid_request`…), otherwise your English; for your own codes, read them with `parseApiError(body)` and pass `code` and `params` to your translator.

```js
// host half
import { apiError } from '@timon-ai/sdk'
res.status(404).json(apiError('feed_not_found', `feed ${id} not found`, { id }))

// browser half
import { parseApiError } from '@timon/ui'
const failure = parseApiError(await res.json().catch(() => null))
const message = failure?.code ? t(`errors.${failure.code}`, failure.params) : t('errors.generic')
```

:::note API 15
A plugin that ships ICU plurals, or a language other than `en` and `fr`, declares `"apiVersion": 15`: an older Timon refuses it instead of showing `{count, plural, …}` as raw text. A translator written for earlier versions (`{ en, fr }`, flat keys, `{name}`) reads the same; a message that is not valid ICU keeps the plain `{name}` substitution. One difference: an ASCII apostrophe right before a brace (`l'{name}`) opens an ICU quote and shows `l{name}` — write `l’{name}` or `l''{name}`.
:::

## AnchoredPopover

Requires `"apiVersion": 6` in the manifest: an older Timon does not export it, so a plugin declaring less would load there and fail in the browser.

A controlled panel anchored to a button: `open`, `onClose()`, `anchorRef` (a React ref to the button), `placement` (`'below'` on a line, `'beside'` in a column — it falls back to below when neither side has room, as on a phone), `width` (px, default 352), `maxHeight` (px, default 512), `label`, `id`, `className`, `sheet`, `children`. It is flipped or clamped at the edges of the visible screen (above a phone's keyboard when it is open), its height is capped by the room left there and its content scrolls inside. With `sheet: true`, a touch screen or a screen under 640px wide gets it as a sheet across the bottom of the visible screen instead, which suits a panel with a field to type in; older Timon versions ignore the prop. `className` styles the panel itself: leave its position (`fixed`, `z-*`, offsets) to the component. Escape closes it and gives the focus back to the button; a press outside the panel and the button closes it. Toggle `open` from the button's own click.

```js
const [open, setOpen] = React.useState(false)
const anchor = React.useRef(null)
return h(React.Fragment, null,
  h('button', { ref: anchor, 'aria-expanded': open, onClick: () => setOpen((v) => !v) }, h(StatusIcon)),
  h(AnchoredPopover, { open, onClose: () => setOpen(false), anchorRef: anchor, placement: 'beside', label: 'Status' },
    h(StatusDetails)))
```

## NativeViewCover

Requires `"apiVersion": 14` in the manifest: an older Timon does not export it, so a plugin declaring less would load there and fail in the browser.

In the desktop app, the built-in browser is a native view painted above the whole page: no `z-index` reaches over it. While a `NativeViewCover` is mounted, the browser steps aside and shows its last capture; it comes back when the last one is gone. In a web browser it changes nothing, since the page is part of the document there.

`DialogContent`, `SelectContent`, `DropdownMenuContent` and `AnchoredPopover` already hold one, so most plugins never need it. You need it when you mount a surface yourself: your own Radix portal, a hand-written `createPortal`, or `DialogPortal` with your own content.

It takes no props and paints nothing. Put it inside the surface's content:

```js
import { createPortal } from 'react-dom'
import { NativeViewCover } from '@timon/ui'

function Panel({ open, children }) {
  if (!open) return null
  return createPortal(h('div', { role: 'dialog', className: 'fixed inset-0' }, h(NativeViewCover), children), document.body)
}
```

Mount it only while the surface is open: left mounted, it keeps the browser frozen on its capture, including for a surface you keep mounted and merely hide. Leave it out of tooltips, toasts and a persistent [overlay](overlay.md): they would freeze the browser for as long as they show. It is released on unmount, so unloading your plugin gives the browser back.

## useOpenInNewWindow

Requires `"apiVersion": 14` in the manifest.

In the desktop app, Shift+click or a middle click on a menu entry opens that page in a new window. Offer the same gesture for your own page or view with the product's hook:

```js
import { useOpenInNewWindow } from '@timon/ui'

function Detach() {
  const openWindow = useOpenInNewWindow()
  if (!openWindow) return null // web browser, installed web app, older desktop app
  return h(Button, { onClick: () => openWindow('/acme?tab=2') }, 'New window')
}
```

`openWindow(route)` opens `route` (the page on screen when left out) in one more window, on the machine the current window shows, and resolves to `true` once it is open. The route is a path of the app: a URL, another site, the sign-in and setup pages or `/api` resolve to `false` and open nothing. The hook returns `null` outside the desktop app and at the first render: hide your control then. No permission is needed; the new window shows the same interface, with the same session.

## useGlassScope

Requires `"apiVersion": 15` in the manifest.

With frosted glass on (Settings → Appearance), the glass sits either on the **whole island** — the island is one frosted plate and a widget's frame has no blur of its own, only a slightly lighter surface — on the **widgets** — the island is clear and shows the wallpaper, and each widget is a frosted card — or on **both** — the island is a frosted plate and each widget is frosted again on top. Each island can choose for itself from its menu. The widget's frame already follows; a widget that paints its own surface (a plot area, a canvas) can match it:

```js
import { useGlassScope } from '@timon/ui'

function Plot() {
  const glass = useGlassScope() // 'island' | 'widgets' | 'both' | null
  const fill = glass === 'island' ? 'bg-transparent' : glass ? 'bg-card/40' : 'bg-card'
  return h('div', { className: cn('rounded-md', fill) }, '…')
}
```

The island's own choice wins over the Appearance setting, and the value follows both live. No permission is needed. Treat a value you do not know as `'widgets'`: more places for the glass may come.

## Reading usage

Both host and client contexts expose `ctx.usage.list()` with `usage:read`. Render all returned provider-defined windows rather than a fixed list of window names.

| Entry | Display |
| --- | --- |
| `available: true` | Real measurements |
| `available: false`, no error | No probe available; omit the gauge |
| `available: false`, with error | Unavailable state; never substitute zero |

The list follows the user who made the request. Next to each provider, it holds that user's [subscription accounts](../usage/subscription-accounts.md) that are signed in, each as its own entry (`backend` is `claude@<account id>`, `label` is `Claude · <name>`). Another user's accounts are never listed, and a host call made outside a request (a job, an effect) gets no account at all. Your plugin storage is shared by every user: key what you keep by `backend`, and only send back what matches the entries of the current list.

The host half also has `ctx.usage.get(backend)`, which returns one entry of that list, or `null` when the backend is unknown or not visible to the caller.

Probes keep their readings in a short cache, a recent failure included. When a person presses your refresh button, pass `{ force: true }` (`ctx.usage.list({ force: true })`, or `ctx.usage.get(backend, { force: true })` on the host) so the probes ask the provider again. Never pass it from a polling loop: Timon honours it at most once every few seconds per provider and serves the cached reading otherwise.

A host plugin can register a probe with `usage:collect`: `ctx.usage.registerCollector(backend, collect)`, where `collect` returns the account's usage, `null` when it does not apply, or throws when it is temporarily unavailable. `collect` receives `{ force: true }` on a refresh asked by a person: skip any cache of your own then. It is removed when the plugin unloads, cannot displace a native probe and cannot duplicate another plugin's collector for the same backend.

## Backend extensions

With `backends:register`, prefer a profile on an existing dialect when its protocol matches. Write a dialect only for a genuinely different CLI protocol. The daemon owns process launch and checks plugin-chosen binaries against the operator policy.

Resolve credentials through secret settings or the vault and pass values to the profile. Plugins cannot use `envFrom` or `requiredEnv` to read the daemon's ambient environment. Unloading unregisters the backend and updates the catalogue. See the real provider template for both registration paths.
