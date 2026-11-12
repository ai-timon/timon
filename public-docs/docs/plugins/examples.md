---
title: Example cookbook
sidebar_position: 18
---

39 supplied packages demonstrate the public contract. Commentary is written for this guide; code excerpts are copied verbatim from the named files. Some original strings are French. Regenerate excerpts with `node scripts/gen-examples.mjs`.

Obtain the example tree with your developer distribution. There is no public repository link. Use a licensed test instance and follow [Testing](testing.md) before installing third-party code.

## Content in a workspace tab or split {#island}

Source: `examples/plugin-island`. Manifest ID: `example-island`. Minimum API: **8**.

Client API 8. Registers example-island:board in island.content. Ask an agent to open it with id demo through islands_propose; its button opens or drags another board. The host owns tabs and resize controls. No host entry or permissions.

Permissions: none. Read the [related guide](island.md).

`timon plugin add ./examples/plugin-island` installs this package on the target instance.

From `examples/plugin-island/lib/client.js`, line 30 (excerpt):

```js
export function apply(ctx) {
  function Board() {
    const { params, setTitle, close } = useIslandContent()
    const [error, setError] = React.useState(false)
    const title = t('board', { id: String(params.id) })
    React.useEffect(() => { setTitle(title) }, [setTitle, title])
    const nextId = params.id === 'demo' ? 'archive' : 'demo'
    const content = { type: `${ctx.id}:board`, params: { id: nextId } }
    return React.createElement('section', { style: { padding: 16, height: '100%', overflow: 'auto' } },
      React.createElement('h2', { style: { fontWeight: 600 } }, title),
      React.createElement('p', { style: { marginTop: 8 } }, t('description')),
      React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 } },
        React.createElement(Button, {
          type: 'button',
          draggable: true,
          onDragStart: (event) => startIslandDrag(event, content, { label: t('board', { id: nextId }) }),
          onClick: () => setError(!openInIsland(content, { edge: 'right' })),
        }, t('open', { id: nextId })),
        React.createElement(Button, { type: 'button', variant: 'ghost', onClick: close }, t('close'))),
      error ? React.createElement('p', { role: 'status', style: { marginTop: 8 } }, t('refused')) : null)
  }

  return ctx.slots.register({
    slot: 'island.content',
    key: 'board',
    island: {
      title: t('board', { id: 'demo' }),
      parseParams,
      params: { id: { type: 'string', required: true, maxLength: 40, description: 'Board slug (lowercase letters, digits, hyphens).' } },
      singletonBy: 'id',
      minWidth: 280,
      minHeight: 160,
    },
  }, Board)
}
```

## A movable card {#widget}

Source: `examples/plugin-widget`. Manifest ID: `example-widget`. Minimum API: **1**.

Use this for a browser-only card. React comes from the platform; the returned slot disposer releases the card when the plugin unloads.

Permissions: none. Read the [related guide](widget.md).

`timon plugin add ./examples/plugin-widget` installs this package on the target instance.

From `examples/plugin-widget/lib/client.js`, line 11 (excerpt):

```js
export function apply(ctx) {
  function ExampleWidget() {
    return React.createElement(
      'section',
      { style: { margin: 12, padding: 16, border: '1px solid currentColor', borderRadius: 12 } },
      React.createElement('strong', null, 'Example widget'),
      React.createElement('p', null, `plugin ${ctx.id}`),
    )
  }

  // `icon`: the card's picto in the widget window (SVG markup or the URL of
  // an SVG), painted in the theme's text colour — only its shape counts.
  return ctx.slots.register(
    { slot: 'cockpit.widget', widget: { title: 'Example widget', icon: ICON } },
    ExampleWidget,
  )
}
```

## A card in the reader's language {#i18n}

Source: `examples/plugin-i18n`. Manifest ID: `example-i18n`. Minimum API: **15**.

API 15. One file per language in the package, `locales/<tag>.json`, named by its BCP 47 tag. English is the one to ship complete; the others may be partial (`de` has no `widget.language`, so a German reader sees that line in English). Messages are ICU MessageFormat, like Timon's own: a plural lives in one message, with the categories of its language (Polish: `one`, `few`, `many`, `other`). `src/client.js` imports the files and builds its translator with `createTranslator` from `@timon/ui`; `npm run build` bundles them into `lib/client.js`, the only file the daemon serves. The reader's language is negotiated among the plugin's own languages (`de-AT` reads `de`), key by key, then `en`, then the key.

Permissions: none. Read the [related guide](ui-kit.md).

`timon plugin add ./examples/plugin-i18n` installs this package on the target instance.

From `examples/plugin-i18n/src/client.js`, line 1 (excerpt):

```js
import React from 'react'
import { createTranslator, getLocale } from '@timon/ui'
// One file per language, in the package. The build inlines them in
// `lib/client.js`: the daemon serves that single file, nothing beside it.
import en from '../locales/en.json' with { type: 'json' }
import fr from '../locales/fr.json' with { type: 'json' }
import de from '../locales/de.json' with { type: 'json' }
import pl from '../locales/pl.json' with { type: 'json' }

// The reader's language, negotiated among these four (`de-AT` reads `de`),
// key by key, then `en`, then the key: `de` has no `widget.language`, so a
// German reader sees that line in English.
const t = createTranslator({ en, fr, de, pl })

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  function I18nWidget() {
    const [count, setCount] = React.useState(0)
    return React.createElement(
      'section',
      { style: { margin: 12, padding: 16, display: 'grid', gap: 8 } },
      React.createElement('strong', null, t('widget.greeting', { name: ctx.id })),
      // One message, every plural form of the language: `{count, plural, …}`.
      React.createElement('p', null, t('widget.notes', { count })),
      React.createElement('button', { type: 'button', onClick: () => setCount((n) => n + 1) }, t('widget.add')),
      React.createElement('small', null, t('widget.language', { tag: getLocale() })),
    )
  }

  return ctx.slots.register(
    { slot: 'cockpit.widget', widget: { title: t('widget.title') } },
    I18nWidget,
  )
}
```

From `examples/plugin-i18n/locales/pl.json`, line 1:

```json
{
  "widget": {
    "title": "Cześć w twoim języku",
    "greeting": "Cześć, {name}!",
    "notes": "{count, plural, =0 {Brak notatek} one {# notatka} few {# notatki} many {# notatek} other {# notatki}}",
    "add": "Dodaj notatkę",
    "language": "Wyświetlane w języku {tag}"
  }
}
```

## A route and two UI insertions {#hello}

Source: `examples/plugin-hello`. Manifest ID: `plugin-hello`. Minimum API: **1**.

The host serves a greeting from a setting. The browser calls its own plugin route with ctx.api and registers navigation plus a widget. The original French strings are preserved in these verbatim source excerpts.

Permissions: `settings`. Read the [related guide](manifest.md).

`timon plugin add ./examples/plugin-hello` installs this package on the target instance.

From `examples/plugin-hello/lib/index.js`, line 1 (excerpt):

```js
export const name = 'plugin-hello'
export const inject = ['settings']

/** @param {import('@timon-ai/sdk').PluginContext} ctx */
export function apply(ctx) {
  const router = ctx.router()
  router.get('/hello', (_request, response) => {
    response.json({
      plugin: ctx.id,
      greeting: ctx.settings.get('greeting') ?? 'Bonjour depuis un plugin',
    })
  })
}
```

From `examples/plugin-hello/lib/client.js`, line 16 (excerpt):

```js
export function apply(ctx) {
  function HelloWidget() {
    const [message, setMessage] = React.useState('Chargement…')
    React.useEffect(() => {
      let active = true
      ctx.api('hello')
        .then((response) => response.json())
        .then((body) => { if (active) setMessage(String(body.greeting)) })
        .catch(() => { if (active) setMessage('Plugin indisponible') })
      return () => { active = false }
    }, [])
    return React.createElement(
      'section',
      { style: { margin: 12, padding: 16, border: '1px solid currentColor', borderRadius: 12 } },
      React.createElement('strong', null, 'Plugin Hello'),
      React.createElement('p', null, message),
    )
  }

  const disposeNav = ctx.slots.register({ slot: 'nav.item' }, HelloNav)
  const disposeWidget = ctx.slots.register({ slot: 'cockpit.widget' }, HelloWidget)
  return () => {
    disposeWidget()
    disposeNav()
  }
}
```

## A page with a child slot {#page}

Source: `examples/plugin-page`. Manifest ID: `example-page`. Minimum API: **1**.

Open /example after installation. The route key and manifest route agree; the child slot is rendered by the page, not merely declared.

Permissions: none. Read the [related guide](page.md).

`timon plugin add ./examples/plugin-page` installs this package on the target instance.

From `examples/plugin-page/lib/client.js`, line 10 (excerpt):

```js
export function apply(ctx) {
  function ExamplePage() {
    return React.createElement(
      'main',
      { style: { padding: 24 } },
      React.createElement('h1', null, 'Example page'),
      React.createElement(Slot, { name: 'example.widget' }),
    )
  }

  return ctx.slots.register(
    { slot: 'page', key: '/example', children: { 'example.widget': 'list' } },
    ExamplePage,
  )
}
```

## A card and an in-app overlay {#overlay}

Source: `examples/plugin-overlay`. Manifest ID: `example-overlay`. Minimum API: **1**.

Install once to obtain both surfaces. Each registration gets a disposer, and unloading releases both. The overlay positions itself inside the browser window.

Permissions: none. Read the [related guide](overlay.md).

`timon plugin add ./examples/plugin-overlay` installs this package on the target instance.

From `examples/plugin-overlay/lib/client.js`, line 7 (excerpt):

```js
function Body() {
  return React.createElement('strong', null, 'Example overlay')
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  const disposeWidget = ctx.slots.register(
    { slot: 'cockpit.widget' },
    function OverlayCard() {
      return React.createElement(
        'section',
        { style: { margin: 12, padding: 16, border: '1px solid currentColor', borderRadius: 12 } },
        React.createElement(Body),
      )
    },
  )

  const disposeOverlay = ctx.slots.register(
    { slot: 'overlay' },
    function OverlayMascot() {
      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            right: 16,
            bottom: 16,
            zIndex: 40,
            padding: 12,
            borderRadius: 16,
            border: '1px solid currentColor',
          },
        },
        React.createElement(Body),
      )
    },
  )

  return () => {
    disposeOverlay()
    disposeWidget()
  }
}
```

## A token palette {#theme}

Source: `examples/plugin-theme`. Manifest ID: `example-theme`. Minimum API: **1**.

Select this installed theme in Appearance. TOKENS contains the dark and light palettes; this excerpt shows how a React-owned style is mounted and removed. The old template comment about missing tokens predates the runtime theme floor; see the theme guide for partial palettes.

Permissions: none. Read the [related guide](theme.md).

`timon plugin add ./examples/plugin-theme` installs this package on the target instance.

From `examples/plugin-theme/lib/client.js`, line 167 (excerpt):

```js
export function apply(ctx) {
  // No `fallback: true`: the product theme owns that role. Claiming the slot
  // is what makes the palette visible, and disposing restores the product's.
  return ctx.slots.register({ slot: 'theme' }, function ExampleTheme() {
    return React.createElement('style', {
      id: 'example-theme-tokens',
      dangerouslySetInnerHTML: { __html: TOKENS },
    })
  })
}
```

## A minimal root layout {#blank-layout}

Source: `examples/plugin-blank-layout`. Manifest ID: `blank-layout`. Minimum API: **1**.

This replaces the chrome with the reserved Next page tree. It declares only page, so other layout-owned regions are absent. Test it on a separate instance and retain a way to restore the product layout.

Permissions: none. Read the [related guide](page.md).

`timon plugin add ./examples/plugin-blank-layout` installs this package on the target instance.

From `examples/plugin-blank-layout/client.js`, line 4 (excerpt):

```js
export function apply(ctx) {
  return ctx.slots.register(
    // `page` is keyed by route: a layout paints the Next tree's reserved
    // key, never the whole slot — every plugin page would stack up.
    { slot: 'root', children: { page: 'keyed' } },
    function BlankLayout() { return React.createElement(SlotKeyed, { name: 'page', entryKey: 'next-router' }); },
  );
}
```

## Native and custom settings {#settings}

Source: `examples/plugin-settings`. Manifest ID: `example-settings`. Minimum API: **1**.

The first registration adds a row in Missions. The second supplies the plugin category and opens a child slot for other extensions. Both registrations are disposed together.

Permissions: none. Read the [related guide](settings.md).

`timon plugin add ./examples/plugin-settings` installs this package on the target instance.

From `examples/plugin-settings/lib/client.js`, line 36 (excerpt):

```js
  const disposeGraft = ctx.slots.register({ slot: 'settings.missions' }, MissionsGraft)
  const disposeSection = ctx.slots.register(
    { slot: 'settings.section', children: { 'settings.acme': 'list' } },
    OwnCategory,
  )
  return () => {
    disposeSection()
    disposeGraft()
  }
}
```

## Install a page and widget together {#bundle}

Source: `examples/plugin-bundle`. Manifest ID: `example-bundle`. Minimum API: **1**.

The manifest contains two child IDs, while npm dependencies resolve their packages. The sibling file paths are for the local example tree, not a published registry package. Its host apply intentionally does nothing.

Permissions: none. Read the [related guide](bundle.md).

`timon plugin add ./examples/plugin-bundle` installs this package on the target instance.

From `examples/plugin-bundle/package.json`, line 1:

```json
{
  "name": "@timon-ai/plugin-bundle",
  "version": "0.1.0",
  "license": "MIT",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "dependencies": {
    "@timon-ai/plugin-page": "file:../plugin-page",
    "@timon-ai/plugin-widget": "file:../plugin-widget"
  },
  "files": ["lib", "README.md", "SIGNATURE"],
  "timon": {
    "id": "example-bundle",
    "apiVersion": 1,
    "kind": "bundle",
    "label": "Example board",
    "description": "Installs the example page and its widget. Each child stays a plugin of its own.",
    "contains": ["example-page", "example-widget"],
    "permissions": [],
    "settings": [],
    "license": { "required": false }
  }
}
```

From `examples/plugin-bundle/lib/index.js`, line 2 (excerpt):

```js
export const name = 'example-bundle'
export const inject = []

export function apply() {}
```

## A provider pack without code {#provider-pack}

Source: `examples/plugin-provider-pack`. Manifest ID: `provider-pack-example`. Minimum API: **2**.

Two declarative profiles reuse installed CLI dialects. Replace the example endpoints and model IDs, then enter the key in the plugin settings. The manifest contains no main and no JavaScript is loaded. Signature and licence rules still apply.

Permissions: `backends:register`. Read the [related guide](providers.md).

`timon plugin add ./examples/plugin-provider-pack` installs this package on the target instance.

From `examples/plugin-provider-pack/package.json`, line 1:

```json
{
  "name": "@timon-ai/plugin-provider-pack",
  "version": "0.1.0",
  "license": "MIT",
  "private": true,
  "type": "module",
  "files": ["README.md", "SIGNATURE"],
  "timon": {
    "id": "provider-pack-example",
    "apiVersion": 2,
    "kind": "provider",
    "label": "Example provider pack",
    "description": "Two declarative providers using existing CLI dialects.",
    "author": "Timon",
    "permissions": [
      "backends:register"
    ],
    "settings": [
      {
        "key": "apiKey",
        "type": "secret",
        "label": "Provider API key"
      }
    ],
    "backends": [
      {
        "id": "pack-anthropic",
        "dialect": "claude",
        "label": "Example Anthropic endpoint",
        "env": {
          "ANTHROPIC_BASE_URL": "https://anthropic.example.test",
          "ANTHROPIC_AUTH_TOKEN": {
            "setting": "apiKey"
          }
        },
        "defaultModel": "example-model",
        "models": [
          {
            "slug": "example-model",
            "label": "Example model"
          }
        ]
      },
      {
        "id": "pack-responses",
        "dialect": "codex",
        "label": "Example Responses endpoint",
        "env": {
          "EXAMPLE_API_KEY": {
            "setting": "apiKey"
          }
        },
        "providerConfig": {
          "id": "example",
          "name": "Example Responses",
          "baseUrl": "https://responses.example.test/v1",
          "envKey": "EXAMPLE_API_KEY",
          "wireApi": "responses"
        },
        "defaultModel": "example-model",
        "models": [
          {
            "slug": "example-model",
            "label": "Example model"
          }
        ]
      }
    ],
    "license": {
      "required": false
    }
  }
}
```

## A ready-to-install OpenRouter pack {#provider-openrouter}

Source: `examples/plugin-provider-openrouter`. Manifest ID: `provider-openrouter-example`. Minimum API: **2**.

One declarative profile for OpenRouter, a provider with a fixed OpenAI Responses endpoint, run by the installed codex dialect. Enter the OpenRouter key in the plugin settings: the backend turns active without a restart. The model list is not in the manifest: modelsEndpoint points at OpenRouter's public listing, read in the background. The backend ID is openrouter-pack, so it does not collide with an openrouter backend written by hand from [Add a provider](../usage/add-a-provider.md). No main, no JavaScript; signature and licence rules still apply.

Permissions: `backends:register`. Read the [related guide](providers.md).

`timon plugin add ./examples/plugin-provider-openrouter` installs this package on the target instance.

From `examples/plugin-provider-openrouter/package.json`, line 1:

```json
{
  "name": "@timon-ai/plugin-provider-openrouter",
  "version": "0.1.0",
  "license": "MIT",
  "private": true,
  "type": "module",
  "files": ["README.md", "SIGNATURE"],
  "timon": {
    "id": "provider-openrouter-example",
    "apiVersion": 2,
    "kind": "provider",
    "label": "OpenRouter",
    "description": "OpenRouter through its OpenAI Responses endpoint, with its live model list.",
    "author": "Timon",
    "permissions": [
      "backends:register"
    ],
    "settings": [
      {
        "key": "apiKey",
        "type": "secret",
        "label": "OpenRouter API key"
      }
    ],
    "backends": [
      {
        "id": "openrouter-pack",
        "dialect": "codex",
        "label": "OpenRouter",
        "vendor": "OpenRouter",
        "env": {
          "BACKEND_OPENROUTER_API_KEY": {
            "setting": "apiKey"
          }
        },
        "providerConfig": {
          "id": "openrouter-pack",
          "name": "OpenRouter",
          "baseUrl": "https://openrouter.ai/api/v1",
          "envKey": "BACKEND_OPENROUTER_API_KEY",
          "wireApi": "responses"
        },
        "defaultModel": null,
        "models": [],
        "modelsEndpoint": {
          "url": "https://openrouter.ai/api/v1/models",
          "format": "openai"
        }
      }
    ],
    "license": {
      "required": false
    }
  }
}
```

## Replace the AI tool cards {#provider-cards}

Source: `examples/plugin-provider-cards`. Manifest ID: `example-provider-cards`. Minimum API: **14**.

API 14. One registration in the single providers.cli slot replaces the AI tool cards of the first-run Your AIs step and of Settings › AI models › Providers with one compact list. The component reads everything from useProviderCliCards(): the tools, their install jobs and four actions. Timon runs the installer and the sign-in command; the plugin only names a tool. Offer Install only for a tool marked installable and link its installDocs otherwise.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-provider-cards` installs this package on the target instance.

From `examples/plugin-provider-cards/lib/client.js`, line 63 (excerpt):

```js
export function apply(ctx) {
  ctx.slots.register({ slot: 'providers.cli' }, CompactProviderCards)
}
```

## Replace the task form {#task-form}

Source: `examples/plugin-task-form`. Manifest ID: `example-task-form`. Minimum API: **14**.

API 14. One registration in the single task.form slot replaces the task form opened from the Kanban board, the Agents page and the agents grid with a one-screen quick form. The component reads everything from useTaskForm(): the edited task (or none), the agents, submit, the attachment actions, finish and close. Timon keeps the window around it (focus, Escape) and makes the calls. A replacement puts titleId on its heading and sends back the fields it does not show as the task holds them, so saving never wipes them. Remove the plugin and Timon's own form comes back.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-task-form` installs this package on the target instance.

From `examples/plugin-task-form/lib/client.js`, line 36 (excerpt):

```js
function QuickTaskForm() {
  const host = useTaskForm()
  const task = host?.task ?? null
  const [title, setTitle] = React.useState(task?.title ?? '')
  const [description, setDescription] = React.useState(task?.description ?? '')
  const [agent, setAgent] = React.useState(task?.agent_name ?? host?.defaultAgent ?? host?.agents[0]?.name ?? '')
  const [priority, setPriority] = React.useState(task?.priority ?? 3)
  const [error, setError] = React.useState(null)
  if (!host) return null

  const save = async (event) => {
    event.preventDefault()
    if (!title.trim() || !agent) return
    const result = await host.submit({
      title: title.trim(),
      description,
      agent_name: agent,
      priority,
      type: task?.type ?? 'chore',
      deps: list(task?.deps),
      scheduled_at: task?.scheduled_at ?? null,
      backend_override: task?.backend_override ?? null,
      model_override: task?.model_override ?? null,
      fallback_backend_override: task?.fallback_backend_override ?? null,
      fallback_model_override: task?.fallback_model_override ?? null,
      permission_mode_override: task?.permission_mode_override ?? null,
      extra_skills: list(task?.extra_skills),
      extra_mcp_servers: list(task?.extra_mcp_servers),
      extra_allowed_tools: list(task?.extra_allowed_tools),
      todo_id: task?.todo_id ?? null,
    })
    if (result.ok) host.finish()
    else setError(t('failed', { error: result.error }))
  }

  return React.createElement('form', { onSubmit: save, className: 'flex flex-1 flex-col gap-4 p-6' },
    React.createElement('h2', { id: host.titleId, className: 'text-base font-semibold' }, host.mode === 'edit' ? t('edit') : t('create')),
    React.createElement(Input, { 'aria-label': t('title'), placeholder: t('title'), value: title, autoFocus: true, onChange: (e) => setTitle(e.target.value) }),
    React.createElement('textarea', {
      'aria-label': t('description'), placeholder: t('description'), value: description, rows: 8,
      onChange: (e) => setDescription(e.target.value),
      className: 'rounded-md bg-muted/50 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
    }),
    React.createElement('div', { className: 'flex flex-wrap items-center gap-3' },
      React.createElement('select', {
        'aria-label': t('agent'), value: agent, onChange: (e) => setAgent(e.target.value),
        className: 'h-9 rounded-md bg-muted/50 px-2 text-sm',
      }, host.agents.map((a) => React.createElement('option', { key: a.name, value: a.name }, a.name))),
      React.createElement('select', {
        'aria-label': t('priority'), value: String(priority), onChange: (e) => setPriority(Number(e.target.value)),
        className: 'h-9 rounded-md bg-muted/50 px-2 text-sm tabular-nums',
      }, [5, 4, 3, 2, 1].map((p) => React.createElement('option', { key: p, value: String(p) }, `P${p}`)))),
    error && React.createElement('p', { role: 'alert', className: 'text-sm text-destructive' }, error),
    React.createElement('div', { className: 'mt-auto flex justify-end gap-2' },
      React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', onClick: host.close }, t('cancel')),
      React.createElement(Button, { type: 'submit', size: 'sm', 'data-quick-save': '' }, t('save'))))
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  ctx.slots.register({ slot: 'task.form' }, QuickTaskForm)
}
```

## Replace the folder browser {#directory-picker}

Source: `examples/plugin-directory-picker`. Manifest ID: `example-directory-picker`. Minimum API: **15**.

API 15. One registration in the single directory.picker slot replaces the folder browser that Browse… opens in Settings, a project or an agent when the window drives another machine, or in a web browser. The component reads everything from useDirectoryBrowser(): the folder the form holds, opening and read (one level of that machine's disk, every path built by its daemon), choose and cancel. Timon keeps the window around it (its name, focus, Escape) and makes the calls. A replacement hands back a path the daemon served, never one it put together. The same slot answers the file pickers (a plugin archive, a CLI binary): mode is then file, each level carries files, and a click on one chooses it. On this computer in the desktop app, the system dialog opens instead. Remove the plugin and Timon's own browser comes back.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-directory-picker` installs this package on the target instance.

From `examples/plugin-directory-picker/lib/client.js`, line 34 (excerpt):

```js
function BreadcrumbPicker() {
  const host = useDirectoryBrowser()
  const [listing, setListing] = React.useState(null)
  const [error, setError] = React.useState(null)

  const land = React.useCallback(async (read) => {
    const out = await read()
    if (out.ok) { setListing(out.listing); setError(null) } else setError(out.error)
  }, [])
  const opening = host?.opening
  React.useEffect(() => { if (opening) void land(opening) }, [opening, land])
  if (!host) return null

  const go = (path) => void land(() => host.read(path))
  const fileMode = host.mode === 'file'
  const visible = listing ? listing.entries.filter((entry) => !entry.hidden) : []
  // Already filtered by the daemon with the form's endings (`host.accept`).
  const files = fileMode && listing ? (listing.files ?? []).filter((file) => !file.hidden) : []

  return React.createElement(React.Fragment, null,
    React.createElement('p', { className: 'text-sm font-semibold' }, t(fileMode ? 'headingFile' : 'heading')),
    React.createElement('div', { className: 'flex items-center gap-2' },
      React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: !listing?.parent, onClick: () => go(listing.parent) }, t('up')),
      React.createElement('span', { className: 'truncate text-sm', 'data-breadcrumb': '' }, listing?.path ?? '')),
    error && React.createElement('p', { role: 'alert', className: 'text-sm text-destructive' }, t('error', { error })),
    React.createElement('ul', { className: 'flex max-h-72 flex-col gap-0.5 overflow-y-auto' },
      visible.length === 0 && files.length === 0 && listing && React.createElement('li', { className: 'px-2 py-3 text-sm text-muted-foreground' }, t('empty')),
      visible.map((entry) => React.createElement('li', { key: entry.path },
        React.createElement('button', {
          type: 'button', 'data-folder': entry.name, onClick: () => go(entry.path),
          className: 'w-full rounded px-2 py-1 text-left text-sm hover:bg-muted/70',
        }, entry.name))),
      files.map((file) => React.createElement('li', { key: file.path },
        React.createElement('button', {
          type: 'button', 'data-file': file.name, onClick: () => host.choose(file.path),
          className: 'w-full rounded px-2 py-1 text-left text-sm italic hover:bg-muted/70',
        }, file.name)))),
    React.createElement(DialogFooter, { className: 'gap-2' },
      React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', onClick: host.cancel }, t('cancel')),
      // A folder answers a folder request only; in file mode a click on a file chooses.
      !fileMode && React.createElement(Button, {
        type: 'button', size: 'sm', 'data-breadcrumb-choose': '', disabled: !listing,
        onClick: () => { if (listing) host.choose(listing.path) },
      }, t('choose', { path: listing?.path ?? '' }))))
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  ctx.slots.register({ slot: 'directory.picker' }, BreadcrumbPicker)
}
```

## A source for the agent import {#agent-import-source}

Source: `examples/plugin-agent-import-source`. Manifest ID: `example-agent-import-source`. Minimum API: **15**.

API 15. Adds a made-up tool, Acme Bots, to the agent import assistant. Registered in the agentimport.source list socket, which the built-in Agent import plugin opens while it is on, the component reads the assistant with useAgentImport(). It converts the picked acme-bots.json in the browser into a timon-agent-import v1 manifest (a pure function), packs that manifest alone in a zip and hands it to submitFile(): the import then shows its usual preview, and nothing is written before the user confirms. A secret travels by name only. No permission is needed.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-agent-import-source` installs this package on the target instance.

From `examples/plugin-agent-import-source/lib/client.js`, line 70 (excerpt):

```js
export function toManifest(source) {
  let data
  try {
    data = JSON.parse(source)
  } catch {
    throw new Error('not a JSON file')
  }
  if (!data || data.format !== 'acme-bots') throw new Error('format is not acme-bots')
  if (data.version !== 1) throw new Error('version is not 1')
  if (!Array.isArray(data.bots) || data.bots.length === 0) throw new Error('bots is empty')
  if (data.bots.length > 100) throw new Error('bots holds more than 100 entries')

  const warnings = []
  const keys = new Set()
  const timezone = typeof data.timezone === 'string' ? data.timezone.slice(0, 64) : null
  const agents = data.bots.map((bot, i) => {
    const at = `bots[${i}]`
    if (!bot || typeof bot !== 'object') throw new Error(`${at} is not an object`)
    const name = text(bot.name, `${at}.name`, 100)
    if (!name) throw new Error(`${at}.name is missing`)
    const base = slugKey(bot.id ?? name) || 'bot'
    let key = base
    for (let n = 2; keys.has(key); n += 1) key = `${base.slice(0, 60)}-${n}`
    keys.add(key)

    const memories = []
    for (const note of Array.isArray(bot.notes) ? bot.notes : []) {
      const value = text(note, `${at}.notes`, 4000)
      if (value) memories.push({ text: value, kind: 'preference' })
    }
    const routines = []
    for (const job of Array.isArray(bot.jobs) ? bot.jobs : []) {
      const time = typeof job?.dailyAt === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(job.dailyAt) ? job.dailyAt : null
      const instruction = text(job?.task, `${at}.jobs.task`, 100000)
      // What Timon cannot schedule is said, never guessed.
      if (!time || !instruction) {
        warnings.push(`${name}: the job "${String(job?.title ?? '?').slice(0, 80)}" has no daily time or no task, it is left out.`)
        continue
      }
      routines.push({
        name: text(job.title, `${at}.jobs.title`, 80) ?? 'Acme job',
        instruction,
        schedule: { kind: 'daily', time },
        timezone,
        enabledInSource: job.enabled !== false,
      })
    }
    // The preview already says history is not imported: flag it, no warning of our own.
    const hasHistory = Array.isArray(bot.history) && bot.history.length > 0
    // A secret travels by NAME only: the value field, if any, is never read.
    const secretNames = typeof bot.apiKeyName === 'string' && bot.apiKeyName ? [bot.apiKeyName.slice(0, 100)] : []

    const title = text(bot.role, `${at}.role`, 120)
    return {
      key,
      displayName: name,
      ...(title ? { title } : {}),
      soul: text(bot.persona, `${at}.persona`, 200000),
      instructions: text(bot.prompt, `${at}.prompt`, 200000),
      memories: memories.slice(0, 256),
      routines: routines.slice(0, 64),
      hints: { ...(secretNames.length > 0 ? { secretNames } : {}), hasHistory },
      // Stable at the source: a second import of the same file updates these agents.
      sourceRef: `acme-bots:${key}`,
    }
  })

  const manifest = {
    format: 'timon-agent-import',
    version: 1,
    source: { app: 'acme-bots', exportedAt: null },
    agents,
    ...(warnings.length > 0 ? { warnings: warnings.slice(0, 200) } : {}),
  }
  return { manifest, warnings }
}
```

From `examples/plugin-agent-import-source/lib/client.js`, line 217 (excerpt):

```js
export async function importFile(assistant, file) {
  let built
  try {
    built = toManifest(await file.text())
  } catch (err) {
    return err instanceof Error ? err.message : 'unreadable file'
  }
  const json = new TextEncoder().encode(JSON.stringify(built.manifest))
  const zip = new Blob([zipOne('timon-agent-import.json', json)], { type: 'application/zip' })
  await assistant.submitFile(SOURCE_ID, zip)
  return null
}
```

## Replace the confirmation dialog {#confirm-dialog}

Source: `examples/plugin-confirm-dialog`. Manifest ID: `example-confirm-dialog`. Minimum API: **15**.

API 15. One registration in the single confirm.dialog slot replaces every confirmation of the interface: stopping a mission, deleting a task, a secret or an agent. The component reads the open question from useConfirmDialog(): title, description, the two button labels already translated, whether the answer destroys something, and confirm and cancel. Timon keeps the window around it (named with the question, focus, Escape and a click outside answering no) and answers the caller. This template asks for a second click before a destructive yes. A plugin that needs a confirmation of its own calls confirmAction() from @timon/ui, never the browser's confirm(). Remove the plugin and Timon's own dialog comes back.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-confirm-dialog` installs this package on the target instance.

From `examples/plugin-confirm-dialog/lib/client.js`, line 29 (excerpt):

```js
function TwoStepConfirm() {
  const question = useConfirmDialog()
  const [armed, setArmed] = React.useState(false)
  if (!question) return null

  const yes = () => {
    if (question.destructive && !armed) setArmed(true)
    else question.confirm()
  }

  return React.createElement(React.Fragment, null,
    React.createElement('div', { 'aria-hidden': true, className: 'flex flex-col gap-1.5' },
      React.createElement('p', { className: 'm-0 text-base font-semibold', 'data-two-step-title': '' }, question.title),
      question.description && React.createElement('p', { className: 'm-0 text-sm text-muted-foreground' }, question.description),
      question.destructive && React.createElement('p', { className: 'm-0 text-sm text-destructive' }, t('warning'))),
    React.createElement(DialogFooter, { className: 'gap-2' },
      React.createElement(Button, { type: 'button', variant: 'outline', autoFocus: true, onClick: question.cancel, 'data-two-step-cancel': '' }, question.cancelLabel),
      React.createElement(Button, {
        type: 'button',
        variant: question.destructive ? 'destructive' : 'default',
        onClick: yes,
        'data-two-step-confirm': armed ? 'armed' : '',
      }, armed ? t('again', { label: question.confirmLabel }) : question.confirmLabel)))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'confirm.dialog' }, TwoStepConfirm)
}
```

## Replace the new-version banner {#update-banner}

Source: `examples/plugin-update-banner`. Manifest ID: `example-update-banner`. Minimum API: **15**.

API 15. One registration in the single updates.banner slot replaces the banner that announces a newer Timon with one compact line. Timon paints the slot only while a newer version is published for the build's channel and the person has not put it off. The component reads everything from useUpdateStatus(): the installed version, the offer with its plain-text notes, the installers for this browser's system (the first one to download first) and later(), which hides that version only. While it is shown, Timon's own build-expiry notice steps aside, so the banner says when the build stops. Remove the plugin and Timon's own banner comes back.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-update-banner` installs this package on the target instance.

From `examples/plugin-update-banner/lib/client.js`, line 29 (excerpt):

```js
function CompactUpdateBanner() {
  const update = useUpdateStatus()
  if (!update) return null
  const target = update.installers[0]
  const ends = update.buildExpiresAt ? ` (${new Date(update.buildExpiresAt).toLocaleDateString()})` : ''
  return React.createElement('div', { role: 'status', className: 'flex shrink-0 items-center justify-center gap-3 bg-muted px-3 py-1 text-xs', 'data-compact-update': update.offer.version },
    React.createElement('span', { className: 'font-semibold' }, t('line', { version: update.offer.version }) + ends),
    React.createElement('a', {
      className: 'underline', href: target ? target.url : update.offer.notesUrl, target: '_blank', rel: 'noopener noreferrer',
      'data-compact-download': target ? target.key : '',
    }, target ? t('download') : t('page')),
    React.createElement('button', { type: 'button', className: 'underline', onClick: update.later, 'data-compact-later': '' }, t('later')))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'updates.banner' }, CompactUpdateBanner)
}
```

## A button under chat messages {#message-action}

Source: `examples/plugin-message-action`. Manifest ID: `example-message-action`. Minimum API: **15**.

API 15. One registration in the chat.message.action list slot adds a button under each chat message, after Copy, Copy as Markdown, Reply and Read aloud: here, one that copies the message's reference (its conversation and event id). The component reads the message with useChatMessage(): its role, its event id (null when no stored event backs it), its conversation, its Markdown and its rendered text; it returns null on the messages it has nothing to do with. MessageActionButton draws Timon's own icon button with its tooltip. useComposerReply() arms a reply from a button exactly as Reply does. Remove the plugin and the button goes; Timon's own actions stay.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-message-action` installs this package on the target instance.

From `examples/plugin-message-action/lib/client.js`, line 24 (excerpt):

```js
function CopyReference() {
  const message = useChatMessage()
  const [copied, setCopied] = React.useState(false)
  if (!message || message.eventId === null || !message.missionId) return null
  const reference = `${message.missionId}#${message.eventId}`
  const onClick = () => {
    void navigator.clipboard?.writeText(reference).then(() => setCopied(true), () => {})
  }
  return React.createElement(MessageActionButton, { label: copied ? t('copied') : t('copy'), onClick },
    React.createElement('span', { 'aria-hidden': true, className: 'text-[11px] font-semibold', 'data-message-reference': reference }, '#'))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'chat.message.action' }, CopyReference)
}
```

## Replace the connector cards {#app-card}

Source: `examples/plugin-app-card`. Manifest ID: `example-app-card`. Minimum API: **15**.

API 15. One registration in the single apps.card slot replaces every card of the official connectors (Connectors tab of Capabilities) with one compact row per connector, drawing the publisher's logo from its path data. The component reads its app from useAppCard(): the texts already in the user's language, the sign-in type, the links, the state (available, connecting, consent, connected, blocked), and two actions, connect and disconnect. Timon creates the MCP server on the reviewed address, opens the publisher's sign-in page and keeps a key in the vault; the card never calls the daemon and never chooses an address. An app that needs a key gets a masked field, whose value goes to connect(key). Remove the plugin and Timon's own cards come back.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-app-card` installs this package on the target instance.

From `examples/plugin-app-card/lib/client.js`, line 26 (excerpt):

```js
function CompactAppCard() {
  const card = useAppCard()
  const [key, setKey] = React.useState('')
  if (!card) return null
  const { app, status } = card
  const busy = status === 'connecting'
  const needsKey = app.auth.type === 'key' && status !== 'connected' && status !== 'blocked'

  let action = null
  if (status === 'connected') {
    action = React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: () => card.disconnect(), 'data-app-card-action': 'disconnect' }, t('disconnect'))
  } else if (status === 'blocked') {
    action = React.createElement('span', { className: 'text-xs text-muted-foreground' }, t('blocked'))
  } else if (!needsKey) {
    action = React.createElement(Button, { size: 'sm', disabled: busy, onClick: () => card.connect(), 'data-app-card-action': 'connect' }, status === 'consent' ? t('finish') : t('connect'))
  }

  return React.createElement('div', { className: 'flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-2', 'data-app-card': app.slug },
    React.createElement('div', { className: 'flex items-center gap-2.5' },
      React.createElement('span', {
        'aria-hidden': true,
        className: 'inline-flex size-7 items-center justify-center rounded-md text-xs font-semibold text-white',
        style: { backgroundColor: app.icon.color },
      }, app.icon.logo
        // The publisher's mark is path data: draw it, never inject markup.
        ? React.createElement('svg', { viewBox: app.icon.logo.viewBox, className: 'size-4' },
          ...app.icon.logo.paths.map((p, i) => React.createElement('path', { key: i, d: p.d, fill: p.fill || 'currentColor' })))
        : app.icon.monogram),
      React.createElement('div', { className: 'min-w-0 flex-1' },
        React.createElement('div', { className: 'truncate text-sm font-medium' }, app.name),
        React.createElement('div', { className: 'truncate text-xs text-muted-foreground' }, status === 'connected' ? t('connected') : app.tagline)),
      action),
    needsKey && React.createElement('form', {
      className: 'flex items-center gap-2',
      onSubmit: async (e) => { e.preventDefault(); if (key.trim() && await card.connect(key.trim())) setKey('') },
    },
      React.createElement(Input, { type: 'password', autoComplete: 'off', placeholder: app.auth.type === 'key' ? app.auth.label : '', value: key, onChange: (e) => setKey(e.target.value), disabled: busy || card.vaultOff, className: 'h-8' }),
      React.createElement(Button, { size: 'sm', type: 'submit', disabled: busy || card.vaultOff || !key.trim() }, t('save'))),
    status === 'consent' && card.consentUrl && React.createElement('a', { href: card.consentUrl, target: '_blank', rel: 'noopener noreferrer', className: 'text-xs underline' }, t('reopen')))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'apps.card' }, CompactAppCard)
}
```

## Replace the table of contents {#page-toc}

Source: `examples/plugin-page-toc`. Manifest ID: `example-page-toc`. Minimum API: **15**.

API 15. One registration in the single page.toc slot replaces the table of contents of the long list pages (the Skills and Connectors tabs of Capabilities) with a numbered list, sub-sections numbered under their section. The component reads usePageToc(): the entries in reading order with their level and count, the section in view, and go(id), which scrolls the page; the table never scrolls by itself. Remove the plugin and Timon's own table comes back.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-page-toc` installs this package on the target instance.

From `examples/plugin-page-toc/lib/client.js`, line 26 (excerpt):

```js
function NumberedPageToc() {
  const toc = usePageToc()
  if (!toc || toc.entries.length === 0) return null
  let section = 0
  let sub = 0
  const items = toc.entries.map((entry) => {
    if (entry.level === 1) { section += 1; sub = 0 } else sub += 1
    const number = entry.level === 1 ? `${section}` : `${section}.${sub}`
    const on = entry.id === toc.active
    return React.createElement('li', { key: entry.id },
      React.createElement('button', {
        type: 'button',
        onClick: () => toc.go(entry.id),
        'aria-current': on ? 'location' : undefined,
        'data-page-toc-entry': entry.id,
        className: `flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted/50 ${on ? 'font-semibold text-foreground' : 'text-muted-foreground'}`,
      },
      React.createElement('span', { className: 'tabular-nums' }, number),
      React.createElement('span', { className: 'min-w-0 flex-1 truncate' }, entry.label)))
  })
  return React.createElement('nav', { 'aria-label': t('label') }, React.createElement('ol', { className: 'flex flex-col gap-0.5' }, ...items))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'page.toc' }, NumberedPageToc)
}
```

## Replace the agent mascot {#mascot}

Source: `examples/plugin-mascot`. Manifest ID: `example-mascot`. Minimum API: **15**.

API 15. One registration in the single agent.mascot slot replaces every agent's mascot with a flat pixel face in the agent's colour, whose eyes follow its state. The component reads useAgentMascot(): the look, the size, the state, whether to keep inside the box, the accessible name, and live, already off when the person asked for reduced motion. Screens adopt the slot one by one; in this version none shows it yet. Remove the plugin and Timon's meerkat comes back.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-mascot` installs this package on the target instance.

From `examples/plugin-mascot/lib/client.js`, line 32 (excerpt):

```js
function PixelMascot() {
  const m = useAgentMascot()
  if (!m) return null
  const rows = EYES[STATE_EYES[m.state] || (m.look.eyes === 'happy' ? 'happy' : 'open')]
  const cells = []
  rows.forEach((row, y) => row.split('').forEach((c, x) => {
    if (c === '#') cells.push(React.createElement('rect', { key: `${x}-${y}`, x: 25 + x * 10, y: 40 + y * 10, width: 9, height: 9, fill: '#fff4e6' }))
  }))
  const a11y = m.label ? { role: 'img', 'aria-label': m.label } : { 'aria-hidden': true }
  return React.createElement('svg', {
    viewBox: '0 0 100 100', width: m.size, height: m.size, 'data-pixel-mascot': m.state || 'still', ...a11y,
  },
  // `fur`: the colour as `#rrggbb`, a mascot pack's fur included (`look.color` may be a pack id).
  React.createElement('rect', { x: 6, y: 6, width: 88, height: 88, rx: 18, fill: m.fur || m.look.color }),
  React.createElement('rect', { x: 18, y: 30, width: 64, height: 40, rx: 8, fill: '#0b0b0c' }),
  ...cells)
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'agent.mascot' }, PixelMascot)
}
```

## A mascot pack {#mascot-pack}

Source: `examples/plugin-mascot-pack`. Manifest ID: `example-mascot-pack`. Minimum API: **15**.

API 15. Adds a woolly hat, a scarf, a midnight fur and snowflake eyes to the mascot configurator, in their own group under the pack's name. Two halves say the same ids: the manifest declares each part's slug by look field (timon.mascot), so Timon accepts `example-mascot-pack:<slug>` in an agent's look while the plugin is enabled; the browser half registers each part's drawing in the mascot.parts slot, as data — a fur colour, eye outlines, accessory SVG read by a strict whitelist. Remove the plugin and an agent that wore a part shows its job's default for it until the pack is back.

Permissions: none. Read the [related guide](mascot-pack.md).

`timon plugin add ./examples/plugin-mascot-pack` installs this package on the target instance.

From `examples/plugin-mascot-pack/package.json`, line 21 (excerpt):

```json
"mascot": {
      "acc": ["beanie", "scarf"],
      "color": ["midnight"],
      "eyes": ["snowflake"]
    },
```

From `examples/plugin-mascot-pack/lib/client.js`, line 22 (excerpt):

```js
const PARTS = {
  beanie: {
    type: 'acc',
    label: { en: 'Woolly hat', fr: 'Bonnet' },
    tilt: -12,
    svg: `
      <path d="M-11 4 C -11 -9, 11 -9, 11 4 Z" fill="#d94b4b"/>
      <path d="M-6 -4 L -6 3 M 0 -6 L 0 3 M 6 -4 L 6 3" stroke="#b83a3a" stroke-width="1.4" stroke-linecap="round"/>
      <rect x="-12.5" y="2" width="25" height="6" rx="3" fill="#f2efe8"/>
      <circle cx="0" cy="-9" r="3.6" fill="#f2efe8"/>`,
  },
  scarf: {
    type: 'acc',
    label: { en: 'Scarf', fr: 'Écharpe' },
    tilt: 8,
    svg: `
      <rect x="-13" y="-5" width="26" height="8" rx="4" fill="#3fa9ff"/>
      <rect x="3" y="0" width="7" height="15" rx="2.5" fill="#2b86d6"/>
      <path d="M4 15 L 4 18 M 6.5 15 L 6.5 18 M 9 15 L 9 18" stroke="#2b86d6" stroke-width="1.2" stroke-linecap="round"/>
      <path d="M-9 -1 L 9 -1" stroke="#fff" stroke-opacity=".35" stroke-width="1.2" stroke-dasharray="2 2"/>`,
  },
  midnight: {
    type: 'color',
    label: { en: 'Midnight', fr: 'Minuit' },
    hex: '#2b3a67',
  },
  snowflake: {
    type: 'eyes',
    label: { en: 'Snowflakes', fr: 'Flocons' },
    // Drawn eyes: they do not blink. The right eye mirrors this one.
    blink: false,
    left: Array.from({ length: 12 }, (_, i) => {
      const a = -Math.PI / 2 + (i * Math.PI) / 6
      const r = i % 2 ? 2.6 : 6.4
      return [Math.round(r * Math.cos(a) * 100) / 100, Math.round(r * Math.sin(a) * 100) / 100]
    }),
  },
}

export function apply(ctx) {
  const disposers = Object.entries(PARTS).map(([key, mascotPart]) =>
    ctx.slots.register({ slot: 'mascot.parts', key, mascotPart }))
  return () => { for (const dispose of disposers) dispose() }
}
```

## Replace the code screen {#email-code}

Source: `examples/plugin-email-code`. Manifest ID: `example-email-code`. Minimum API: **15**.

API 15. One registration in the single email.code slot replaces the screen where a person types the 6-digit code an email brought them: the confirmation of the first account during onboarding, and a forgotten password on the sign-in screen. This template shows one plain field instead of six boxes. The component reads useEmailCode(): the purpose (verify or reset), the address, the digits typed, the state, the tries left, the refusal already worded in the reader's language with its wait counted down, and the seconds before Resend opens. It passes what was typed to input() and never calls Timon itself: Timon checks a complete code. Remove the plugin and Timon's own boxes come back.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-email-code` installs this package on the target instance.

From `examples/plugin-email-code/lib/client.js`, line 25 (excerpt):

```js
function SingleFieldCode() {
  const code = useEmailCode()
  if (!code) return null
  const busy = code.state === 'checking' || code.state === 'ok'
  const status = code.state === 'checking' ? t('checking')
    : code.state === 'ok' ? t('ok')
      : code.state === 'sent' ? t('sent')
        : code.message
  return React.createElement('div', { 'data-example-email-code': '', className: 'flex w-full max-w-sm flex-col items-center gap-3 text-center' },
    React.createElement('h1', { className: 'text-2xl font-bold' }, t('title')),
    React.createElement('p', { className: 'text-sm text-muted-foreground' }, t('to', { email: code.email })),
    React.createElement('input', {
      autoFocus: true,
      value: code.digits,
      onChange: (e) => code.input(e.target.value),
      inputMode: 'numeric',
      autoComplete: 'one-time-code',
      'aria-label': t('label'),
      disabled: busy,
      maxLength: code.length + 4,
      className: 'h-12 w-48 rounded-lg bg-muted/40 text-center text-2xl tracking-[0.4em] tabular-nums ring-1 ring-inset ring-border',
    }),
    React.createElement('p', { role: 'status', className: 'min-h-5 text-xs text-muted-foreground' }, status),
    React.createElement('div', { className: 'flex gap-5 text-sm text-muted-foreground' },
      React.createElement('button', { type: 'button', onClick: code.changeEmail }, t('change')),
      React.createElement('button', {
        type: 'button',
        'data-example-resend': '',
        disabled: code.resendIn > 0 || code.resending || busy,
        onClick: code.resend,
      }, code.resendIn > 0 ? t('wait', { s: code.resendIn }) : t('resend'))))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'email.code' }, SingleFieldCode)
}
```

## Replace the mascot configurator {#look-styler}

Source: `examples/plugin-look-styler`. Manifest ID: `example-look-styler`. Minimum API: **15**.

API 15. One registration in the single agent.lookstyler slot replaces the mascot configurator of the onboarding's Customise panel and of the Avatar tab of the agent editor, both at once. This template shows three short lists and a row of colour swatches instead of the preview and its grids. The component reads useLookStyler(): the look being edited, onChange to hand back a whole look, the agent's name and role, the lists in choices (mascot packs' parts included, grouped in packs), and random() for a whole look drawn from them. Offer only what choices holds: a value off the lists keeps the current one. The panel or tab around it, its title and Done stay Timon's. Remove the plugin and Timon's own configurator comes back.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-look-styler` installs this package on the target instance.

From `examples/plugin-look-styler/lib/client.js`, line 36 (excerpt):

```js
function CompactLookStyler() {
  const s = useLookStyler()
  if (!s) return null
  const set = (field) => (value) => s.onChange({ ...s.look, [field]: value })
  return React.createElement('div', { 'data-compact-styler': s.name, style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 8 } },
    React.createElement(List, { name: 'shape', label: t('skull'), value: s.look.shape, options: s.choices.shapes, onPick: set('shape') }),
    React.createElement(List, { name: 'eyes', label: t('eyes'), value: s.look.eyes, options: s.choices.eyes, onPick: set('eyes') }),
    React.createElement(List, { name: 'acc', label: t('accessory'), value: s.look.acc, options: s.choices.accessories, onPick: set('acc') }),
    React.createElement('div', { role: 'group', 'aria-label': t('fur'), style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
      // Swatches only for the product's `#rrggbb` colours: a mascot pack's fur is an id (`acme-pack:midnight`),
      // which this compact picker leaves out rather than paint a blank dot (`packs` names them).
      s.choices.colors.filter((color) => color.startsWith('#')).map((color) => React.createElement('button', {
        key: color,
        type: 'button',
        'data-compact-fur': color,
        'aria-label': color,
        'aria-pressed': s.look.color === color,
        onClick: () => set('color')(color),
        style: {
          width: 24, height: 24, borderRadius: 12, background: color, cursor: 'pointer',
          border: s.look.color === color ? '2px solid currentColor' : '2px solid transparent',
        },
      }))),
    React.createElement('button', { type: 'button', 'data-compact-random': true, onClick: () => s.onChange(s.random()), style: { alignSelf: 'flex-start', padding: '4px 10px', borderRadius: 8 } }, t('random')))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'agent.lookstyler' }, CompactLookStyler)
}
```

## Replace the Kanban tiles {#kanban-card}

Source: `examples/plugin-kanban-card`. Manifest ID: `example-kanban-card`. Minimum API: **15**.

API 15. One registration in the single kanban.card slot replaces every tile of the Kanban — the TO DO ideas and the tasks of the board, and the idea lines of the TO DO widgets — with plain cards laid out on BoardCard from @timon/ui. The component reads its item from useKanbanCard(), a union on kind: an idea comes with the widget's display options and the checkbox and deletion where the screen offers them, a task with its agent, the whole board, drag and stop. Timon keeps the data and the calls; the card calls the gestures it is handed and spreads drag on a task's root, or the board cannot move it. Remove the plugin and Timon's own tiles come back.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-kanban-card` installs this package on the target instance.

From `examples/plugin-kanban-card/lib/client.js`, line 15 (excerpt):

```js
function IdeaCard({ card }) {
  const { item, show } = card
  const done = item.status === 'done'
  const leading = card.toggleDone && React.createElement('input', {
    type: 'checkbox', checked: done, onChange: card.toggleDone,
    'aria-label': done ? t('reopen') : t('markDone'), className: 'size-3.5 accent-primary',
  })
  return React.createElement(BoardCard, {
    density: card.density,
    as: card.density === 'row' ? 'li' : 'article',
    'data-plain-card': 'todo',
    corner: show.id ? `#${item.id}` : null,
    leading,
    title: item.text,
    muted: done,
    badges: item.urgency ? badge(item.urgency) : null,
    meta: [show.project && item.project, show.author && item.author].filter(Boolean).join(' · ') || null,
    actions: card.remove && React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: card.remove, 'aria-label': t('remove') }, '×'),
    onOpen: card.open,
  })
}

/** A task of the board: its agent, its priority, its state, and Stop while it runs. */
function TaskCard({ card }) {
  const { task } = card
  const running = task.status === 'IN_PROGRESS'
  return React.createElement(BoardCard, {
    ...card.drag,
    density: card.density,
    'data-plain-card': 'task',
    identity: React.createElement('span', { className: 'truncate text-[13px] font-semibold', style: { color: card.agent.accent } }, task.agent_name),
    corner: `P${task.priority}`,
    title: task.title,
    badges: badge(t(STATUS[task.status] ?? 'waiting')),
    context: task.blocked_reason && React.createElement('div', { className: 'rounded-md bg-destructive/10 px-2 py-1 text-[11.5px] text-destructive' }, task.blocked_reason),
    actions: running && task.mission_id && React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: card.stop }, t('stop')),
    tone: running ? 'running' : task.status === 'BLOCKED' ? 'blocked' : 'default',
    dragging: card.dragging,
    onOpen: card.open,
  })
}

/**
 * A replacement of every Kanban tile, ideas and tasks alike.
 *
 * `kanban.card` is a `single` slot declared at boot, whose default occupant is
 * the product's tiles (`fallback`). Registering here claims every tile of the
 * board and of the TO DO widgets at once; removing the plugin gives the
 * product's tiles back.
 *
 * The component receives no props: it reads its item with `useKanbanCard()`,
 * a union on `kind`. What a replacement must respect:
 *   - call the gestures it is handed (`open`, `toggleDone`, `stop`…), never
 *     the daemon: the host knows the routes and asks before stopping;
 *   - a gesture set to `null` is one the host does not offer there: hide it;
 *   - spread `drag` on a task card's root, or the board cannot move it.
 */
function PlainKanbanCard() {
  const card = useKanbanCard()
  if (!card) return null
  return card.kind === 'todo'
    ? React.createElement(IdeaCard, { card })
    : React.createElement(TaskCard, { card })
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  return ctx.slots.register({ slot: 'kanban.card' }, PlainKanbanCard)
}
```

## Replace the TO DO idea form {#todo-form}

Source: `examples/plugin-todo-form`. Manifest ID: `example-todo-form`. Minimum API: **15**.

API 15. One registration in the single todo.form slot, the twin of task.form, replaces the window that creates or edits a TO DO idea with a plain form laid out on DetailShell from @timon/ui. The component reads everything from useTodoForm(): the idea (or none), the default project, submit, handoff to the project's orchestrator, finish and close. Timon keeps the window around it (focus, Escape) and makes the calls; the form puts titleId on its heading and draws no window of its own. Remove the plugin and Timon's own form comes back.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-todo-form` installs this package on the target instance.

From `examples/plugin-todo-form/lib/client.js`, line 39 (excerpt):

```js
function PlainTodoForm() {
  const host = useTodoForm()
  const item = host?.item ?? null
  const [text, setText] = React.useState(item?.text ?? '')
  const [notes, setNotes] = React.useState(item?.notes ?? '')
  const [project, setProject] = React.useState(item?.project ?? host?.defaultProject ?? '')
  const [urgency, setUrgency] = React.useState(item?.urgency ?? '')
  const [progress, setProgress] = React.useState(item?.progress ?? 'todo')
  const [message, setMessage] = React.useState(null)
  if (!host) return null

  const save = async (event) => {
    event.preventDefault()
    if (!text.trim()) return
    const result = await host.submit({
      text: text.trim(), project: project.trim() || null, notes: notes || null, urgency: urgency || null, progress,
    })
    if (result.ok) host.finish()
    else setMessage(t('failed', { error: result.error }))
  }
  const handoff = async () => {
    const result = await host.handoff?.()
    if (result) setMessage(result.ok ? t('handedOff', { agent: result.agent }) : result.error)
  }

  return React.createElement('form', { onSubmit: save, className: 'flex min-h-0 flex-1 flex-col' },
    React.createElement(DetailShell, {
      header: React.createElement(React.Fragment, null,
        React.createElement('h2', { id: host.titleId, className: 'text-[13px] text-muted-foreground tabular-nums' }, item ? t('edit', { id: item.id }) : t('create')),
        React.createElement(Input, { 'aria-label': t('title'), placeholder: t('title'), value: text, autoFocus: true, onChange: (e) => setText(e.target.value) })),
      rail: React.createElement(React.Fragment, null,
        field(t('project'), React.createElement(Input, { value: project, onChange: (e) => setProject(e.target.value) })),
        field(t('type'), select(t('type'), urgency, [['', t('untyped')], ...URGENCIES.map((u) => [u, u])], setUrgency)),
        field(t('progress'), select(t('progress'), progress, PROGRESSES.map((p) => [p, p]), setProgress))),
      railLabel: t('about'),
      footer: React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'flex items-center gap-2' },
          host.handoff && React.createElement(Button, { type: 'button', variant: 'secondary', size: 'sm', onClick: handoff, 'data-plain-handoff': '' }, t('handoff')),
          message && React.createElement('span', { role: 'status', className: 'text-[12px] text-muted-foreground' }, message)),
        React.createElement('div', { className: 'flex items-center gap-2' },
          React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', onClick: host.close }, t('cancel')),
          React.createElement(Button, { type: 'submit', size: 'sm', 'data-plain-save': '' }, t('save')))),
    },
    React.createElement('textarea', {
      'aria-label': t('description'), placeholder: t('description'), value: notes, rows: 12,
      onChange: (e) => setNotes(e.target.value),
      className: 'min-h-[12rem] flex-1 rounded-md bg-muted/40 px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring',
    })))
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  return ctx.slots.register({ slot: 'todo.form' }, PlainTodoForm)
}
```

## Profiles and dialects {#provider}

Source: `examples/plugin-provider`. Manifest ID: `provider-example`. Minimum API: **12**.

This demonstration registers its profile unconditionally: the env function throws while the secret setting is empty, which keeps the backend out of the menus and out of dispatch until a key is saved. It also includes an echo dialect describing a fictitious JSON-speaking executable, not the operating system echo command. It is a protocol template, not a working AI backend. Provider endpoints and model IDs below are literal example data, not current catalogue recommendations.

Permissions: `backends:register`, `settings`. Read the [related guide](providers.md).

`timon plugin add ./examples/plugin-provider` installs this package on the target instance.

From `examples/plugin-provider/lib/index.js`, line 17 (excerpt):

```js
  ctx.backends.registerProfile({
    id: 'ollama-cloud-example',
    dialect: 'codex',
    label: 'Ollama Cloud (example)',
    vendor: 'Ollama Cloud',
    brand: 'ollama',
    custom: true,
    // Resolve on every mission launch, including short-lived token refresh.
    // The daemon never relays the error message; keep credentials out of it.
    env: () => {
      const apiKey = String(ctx.settings.get('apiKey') ?? '')
      if (!apiKey) throw new Error('apiKey setting is empty')
      return { OLLAMA_API_KEY: apiKey }
    },
    providerConfig: {
      id: 'ollama-cloud-example',
      name: 'Ollama Cloud (example)',
      baseUrl: 'https://ollama.com/v1',
      envKey: 'OLLAMA_API_KEY',
      wireApi: 'responses',
    },
    defaultModel: 'gpt-oss:120b',
    models: [
      { slug: 'gpt-oss:120b', label: 'gpt-oss:120b', contextWindow: 128_000 },
      { slug: 'gpt-oss:20b', label: 'gpt-oss:20b', contextWindow: 32_000 },
    ],
  })
```

From `examples/plugin-provider/lib/echo-dialect.js`, line 41 (excerpt):

```js
  async buildSpawn(opts, profile) {
      const args = ['--model', opts.cfg.model ?? 'echo-1', '--system', opts.systemPrompt]
      if (opts.resumeSession) args.push('--resume', opts.resumeSession)
      args.push(opts.message)
      return {
        cmd: profile.cmd,
        args,
        // Use the resolved profile environment, never process.env.
        env: { ...profile.env },
        cwd: opts.cfg.cwd,
        initialStdin: null,
      }
    },
```

## A third-party ACP provider (Cursor) {#provider-cursor}

Source: `examples/plugin-provider-cursor`. Manifest ID: `provider-cursor`. Minimum API: **12**.

API 12. Cursor's agent over the Agent Client Protocol (`cursor-agent acp`), written as an outside developer would: it imports only `@timon-ai/sdk`, and Timon treats it as a stranger — its program starts only after the superadmin authorizes the path Timon resolved, and it never receives the mission token, the vault or the daemon's environment. The agent is one row of data handed to the daemon's ACP runtime. Cursor's own multiple-choice questions and plans are answered with Timon's cards (`extensionRequests`), its program is checked by its version banner when the superadmin authorizes it and before it runs (`binary.identity`, in the code and the manifest alike), which makes its generic alias `agent` safe to declare, and what was never seen work is declared (`unverified`): the model picker shows it as an Unverified chip. Read the template's README before installing: it was written from Cursor's documentation and has not been run against a real Cursor, and Timon's own tools may not reach a Cursor mission.

Permissions: `backends:register`. Read the [related guide](providers.md).

`timon plugin add ./examples/plugin-provider-cursor` installs this package on the target instance.

From `examples/plugin-provider-cursor/lib/cursor.js`, line 20 (excerpt):

```js
export const CURSOR = Object.freeze({
  id: 'cursor',
  // `cursor-agent acp`: documented as "advanced", absent from `--help`. The whole CLI speaks ACP behind that subcommand.
  args: ['acp'],
  // Cursor sends `session/request_permission` ("If your client does not answer permission requests, tool execution can block"):
  // Timon arbitrates every tool use, through the card and the classifier.
  permissionsByAgent: false,
  // Which models an account offers is Cursor's to say, not this file's. The probe leaves an empty session in Cursor's history.
  modelProbe: 'session-new',
  // The one method Cursor announces. Tried ONCE, only if `session/new` answers `auth_required`: it reuses the sign-in
  // `cursor-agent login` stored and opens nothing by itself.
  authenticateWith: 'cursor_login',
  signIn: { byMethod: { cursor_login: SIGN_IN }, fallback: SIGN_IN },
  binary: {
    // The canonical name, then `agent`, which Cursor's documentation also uses. `agent` alone proves nothing (grok installs
    // one in the same folder): the identity below, mirrored in package.json, refuses a namesake on the authorization click
    // and before every launch. `index.js` puts first the name this machine resolves.
    names: ['cursor-agent', 'agent'],
    install: {
      any: { kind: /** @type {'script'} */ ('script'), posix: 'curl https://cursor.com/install -fsS | bash', windows: "irm 'https://cursor.com/install?win32=true' | iex" },
    },
    // Checked on the authorization click (the copy in package.json, which must stay identical), before a mission starts the
    // program and before the model probe: a program that does not print a dated version (Cursor's builds are named by
    // date, `2026.10.16-…`) is refused, saying what it printed.
    identity: { args: ['--version'], pattern: '\\b20\\d{2}\\.\\d{1,2}\\.\\d{1,2}\\b', expected: "Cursor's agent CLI, a dated version such as 2026.10.16" },
  },
  // Cursor's own blocking requests: its multiple-choice questions and its plans, put to the person as Timon cards.
  extensionRequests: CURSOR_EXTENSIONS,
  // The folders `cursor-agent` keeps its sign-in and configuration in. Spared from the mission's mask for a Cursor mission only,
  // masked from every other backend. `.config/cursor` is a guess for Linux: confirm on a real install (A-TESTER).
  declares: {
    credentialDirs: ['.cursor', '.config/cursor'],
    // Shown with the backend (an Unverified chip in the model picker): what this plugin has never seen work.
    unverified: /** @type {ProviderUnverified[]} */ ([
      { subject: 'session', note: 'Written from Cursor\'s ACP documentation; its tests replay reconstructed sessions, not recorded ones.' },
      { subject: 'mcp', note: 'Timon\'s tools are declared through the session; Cursor documents only .cursor/mcp.json, so they may be missing.' },
      { subject: 'extension-requests', note: 'Questions and plans follow the shapes Cursor documents; never answered by a real cursor-agent.' },
      { subject: 'credential-dirs', note: '~/.config/cursor is a guess for Linux; native Windows keeps its configuration elsewhere.' },
      { subject: 'binary-identity', note: 'The dated version banner is inferred from Cursor\'s release names, not read from a real install.' },
    ]),
  },
});
```

From `examples/plugin-provider-cursor/lib/extensions.js`, line 29 (excerpt):

```js
export async function askQuestion(params, cards) {
  const p = record(params)
  const raw = Array.isArray(p?.questions) ? p.questions : []
  /** @type {AcpCardQuestion[]} */
  const questions = []
  for (const item of raw) {
    const q = record(item)
    const id = text(q?.id)
    const prompt = text(q?.prompt)
    if (!q || !id || !prompt) return skipped('the question could not be read')
    const options = (Array.isArray(q.options) ? q.options : []).map(record)
    if (options.some((o) => !o || !text(o.id) || !text(o.label))) return skipped('an option could not be read')
    questions.push({
      id,
      question: prompt,
      ...(questions.length === 0 && text(p?.title) ? { header: /** @type {string} */ (p?.title).slice(0, 40) } : {}),
      options: options.map((o) => ({ id: /** @type {string} */ (o?.id), label: /** @type {string} */ (o?.label) })),
      ...(q.allowMultiple === true ? { multiSelect: true } : {}),
    })
  }
  if (questions.length === 0) return skipped('no question was sent')

  const got = await cards.ask(questions, { id: text(p?.toolCallId) })
  if (got.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } }
  if (got.outcome === 'unanswered') return skipped(got.reason)
  const answers = questions.map((q) => ({ questionId: q.id, selectedOptionIds: [...(got.value[q.id]?.selected ?? [])] }))
  const typed = questions.filter((q) => got.value[q.id]?.text)
  if (typed.length === 0) return { outcome: { outcome: 'answered', answers } }
  const words = questions.map((q) => {
    const answer = got.value[q.id]
    const picked = (q.options ?? []).filter((o) => answer?.selected.includes(o.id)).map((o) => o.label)
    return `${q.question} — ${[picked.length ? `picked ${picked.join(', ')}` : 'nothing picked', answer?.text ? `wrote: ${answer.text}` : ''].filter(Boolean).join('; ')}`
  })
  return skipped(`The person answered in their own words. ${words.join(' | ')}`)
}

/**
 * `cursor/create_plan`: `{ toolCallId, name?, overview?, plan, todos: [{ id, content, status }], phases? }`
 * → `{ outcome: { outcome: 'accepted' } | { outcome: 'rejected', reason? } | { outcome: 'cancelled' } }`.
 * Nobody to ask (an unattended mission) is a rejection whose reason tells the agent what to do instead.
 * @type {AcpExtensionHandler}
 */
```

From `examples/plugin-provider-cursor/lib/index.js`, line 27 (excerpt):

```js
export async function apply(ctx) {
  const program = await installedName(ctx)
  // The daemon launches, and the operator authorized, the first name: the one that resolved.
  const names = [program, ...CURSOR.binary.names.filter((name) => name !== program)]
  // Refused here, naming the program, until the operator authorizes it: nothing below runs without that.
  ctx.provider.registerProvider(ctx.provider.runtime.acp.defineProvider(ctx.provider, { ...CURSOR, binary: { ...CURSOR.binary, names } }))

  // The profile on that provider: what the agent editor and the LLM selector list. Models come from Cursor itself
  // (`modelProbe`), so none is written here. No `fallbackRank`: a provider of unknown calibre is never chosen automatically.
  ctx.backends.registerProfile({
    id: 'cursor',
    dialect: 'cursor',
    label: 'Cursor',
    vendor: 'Cursor',
    brand: 'cursor',
    custom: true,
    ...(program === CURSOR.binary.names[0] ? {} : { cmd: program }),
    requiredBinary: program,
    models: [],
    defaultModel: null,
  })
}
```

## A remote backend with no process {#remote-backend}

Source: `examples/plugin-remote-backend`. Manifest ID: `remote-backend-example`. Minimum API: **12**.

This template registers a remote dialect: the agent is reached through a session driver, and the daemon spawns nothing, so no executable policy entry is needed. Its agent lives in memory and answers with an echo of the message, with no network and no server. It is a protocol template, not a working AI backend: a real plugin replaces each marked step with a call to its agent's API through ctx.fetch.

Permissions: `backends:register`, `settings`. Read the [related guide](providers.md).

`timon plugin add ./examples/plugin-remote-backend` installs this package on the target instance.

From `examples/plugin-remote-backend/lib/memory-dialect.js`, line 40 (excerpt):

```js
export function createMemoryDialect(runtime) {
  const { events } = runtime

  const initEvent = (sessionId) => events.systemInitEvent({ sessionId })

  const assistantEvent = (text) => events.assistantTextEvent(text, randomUUID())

  /** A turn that ended. The factory knows `success` and `error`; a cancellation is
   *  a success that says it stopped early. */
  function resultEvent(stopReason, text) {
    const base = events.resultSuccessEvent()
    return {
      type: 'result',
      payload: {
        ...(/** @type {Record<string, unknown>} */ (base.payload)),
        ...(stopReason === 'cancelled' ? { subtype: 'cancelled' } : {}),
        ...(text ? { result: text } : {}),
        stop_reason: stopReason,
      },
    }
  }

  /** Server side: log an event and push it to the connected driver, if any. */
  function publish(session, event) {
    const entry = { seq: session.log.length + 1, event }
    session.log.push(entry)
    session.listener?.(entry)
  }

  /** Server side: the turn runs whether or not a driver is connected. */
  function runTurn(session, text, delay) {
    session.turn = setTimeout(() => {
      session.turn = null
      const reply = `Echo: ${text}`
      publish(session, assistantEvent(reply))
      publish(session, resultEvent('end_turn', reply))
    }, delay)
  }

  function stopTurn(session) {
    if (!session.turn) return false
    clearTimeout(session.turn)
    session.turn = null
    publish(session, resultEvent('cancelled'))
    return true
  }

  /**
   * The driver of one session. `env` is the profile's environment, resolved for
   * this launch: a real driver reads its address and key from it. `resume` is
   * there only when the daemon restarted under a live mission: the state this
   * driver saved with host.saveResume, and whether a turn was running.
   *
   * The fictitious agent replies `Echo: <message>` after a short delay. A few
   * variables make it misbehave on purpose, the way a real server can:
   *   MEMORY_AGENT_DELAY_MS     time before each reply (default 10)
   *   MEMORY_AGENT_FAIL         'start' refuses the handshake, 'prompt' drops the turn
   *   MEMORY_AGENT_END_AFTER    after this many turns the agent closes the session…
   *   MEMORY_AGENT_END          …this way: 'completed' (default), 'failed' or 'cancelled'
   *
   * @param {import('@timon-ai/sdk/provider').RemoteSessionOpenArgs} args
   */
  function createDriver({ spawn, host, env, resume }) {
    const delay = Number(env.MEMORY_AGENT_DELAY_MS ?? 10)
    const endAfter = Number(env.MEMORY_AGENT_END_AFTER ?? 0)
    let info = null
    let closed = false
    let turns = 0
    let session = null
    /** The prompt in flight, settled when its result comes back. */
    let current = null

    /** What the server pushes: into the thread, then into the resume state. */
    const deliver = (entry) => {
      if (closed) return
      host.emit(entry.event)
      // Right after the emit: a daemon restarted from here resumes after it.
      // Never the key: it comes back from env at every launch.
      host.saveResume({ sessionId: session.id, lastSeq: entry.seq })
      if (entry.event.type !== 'result') return
      const stopReason = entry.event.payload.stop_reason
      const settle = current
      current = null
      settle?.resolve({ stopReason })
      if (stopReason !== 'end_turn') return
      turns += 1
      if (endAfter > 0 && turns >= endAfter) {
        const reason = /** @type {'completed' | 'failed' | 'cancelled'} */ (env.MEMORY_AGENT_END ?? 'completed')
        setTimeout(() => {
          if (closed) return
          host.end(reason === 'failed'
            ? { reason, message: 'the agent closed the session for maintenance' }
            : { reason })
        }, 0)
      }
    }

    return {
      get info() { return info },

      async start() {
        // Real driver: authenticate and open (or reopen) the remote session here,
        // never in openSession. A rejection is shown in the mission's thread.
        if (env.MEMORY_AGENT_FAIL === 'start') throw new Error('the agent refused the API key')
        if (resume) {
          // Real driver: reconnect to the run the saved state names, and ask
          // for the events after lastSeq — the `result` of a turn that ended
          // while the daemon was down included.
          const known = typeof resume.state.sessionId === 'string' ? sessions.get(resume.state.sessionId) : undefined
          if (!known) throw new Error('the agent no longer knows this session')
          session = known
          const lastSeq = Number(resume.state.lastSeq) || 0
          info = { sessionId: session.id, capabilities: CAPABILITIES, resumed: true }
          // Takes over from the driver of the daemon that died.
          session.listener = deliver
          for (const entry of session.log.slice(lastSeq)) deliver(entry)
          return info
        }
        session = serverSession(spawn.resumeSession ?? `memory-${randomUUID()}`)
        session.listener = deliver
        info = { sessionId: session.id, capabilities: CAPABILITIES, resumed: Boolean(spawn.resumeSession) }
        // Real driver: send spawn.systemPrompt with the session request.
        host.emit(initEvent(session.id))
        // From now on a restarted daemon can find this session again, even in
        // the middle of the first turn.
        host.saveResume({ sessionId: session.id, lastSeq: session.log.length })
        return info
      },

      prompt(text) {
        if (closed) return Promise.reject(new Error('the session is closed'))
        if (!info) return Promise.reject(new Error('the session is not started'))
        if (current || session.turn) return Promise.reject(new Error('a turn is already running'))
        return new Promise((resolve, reject) => {
          const turn = { resolve, reject }
          current = turn
          if (env.MEMORY_AGENT_FAIL === 'prompt') {
            setTimeout(() => {
              if (current !== turn) return
              current = null
              reject(new Error('the agent dropped the turn (HTTP 502)'))
            }, delay)
            return
          }
          // Real driver: post the message; the events come back on the stream
          // (SSE, WebSocket) and go through deliver, the result last.
          runTurn(session, text, delay)
        })
      },

      async cancel() {
        // Real driver: ask the server to stop the run, then let its stream end.
        if (session && stopTurn(session)) return
        if (!current) return
        const { resolve } = current
        current = null
        host.emit(resultEvent('cancelled'))
        resolve({ stopReason: 'cancelled' })
      },

      close() {
        // Real driver: abort the open requests and cancel the remote run — a
        // close is a stop. A daemon that dies closes nothing, which is what
        // lets the next one reattach. Nothing is emitted afterwards.
        if (closed) return
        closed = true
        if (session && session.listener === deliver) {
          session.listener = null
          if (session.turn) clearTimeout(session.turn)
          sessions.delete(session.id)
        }
        if (current) {
          current.reject(new Error('the session was closed'))
          current = null
        }
      },
    }
  }

  /** @type {import('@timon-ai/sdk/provider').RemoteDialect} */
  const memoryDialect = {
    id: 'memory-remote',
    /** No process: the session is all there is. */
    transport: 'remote',
    /** A session id given back reopens the conversation. */
    sessionResumable: true,
    sessionStore: 'global',
    /** This fictitious agent runs no tools, so it asks nothing. A real agent
     *  that asks should declare 'protocol' and call host.requestPermission. */
    permissionModel: 'none',
    rateLimitReporting: 'none',
    hostedConnectors: false,

    openSession(args) {
      return createDriver(args)
    },
```

## Replace the model selector {#model-picker}

Source: `examples/plugin-model-picker`. Manifest ID: `example-model-picker`. Minimum API: **13**.

API 13. One registration in the single model.picker slot replaces the model selector of the whole interface: the chat composer, the task form and the agent editor. The component receives no props; it reads the value, onChange, the inherit entry and the mode from useModelPicker(), and the models from useBackendCatalog(). It keeps the three rules Timon enforces: an account that cannot run is shown but not choosable, the inherit entry hands back null, and a value whose provider left the catalogue stays shown and disabled. Remove the plugin and Timon's own picker comes back.

Permissions: none. Read the [related guide](slots.md).

`timon plugin add ./examples/plugin-model-picker` installs this package on the target instance.

From `examples/plugin-model-picker/lib/client.js`, line 110 (excerpt):

```js
export function apply(ctx) {
  ctx.slots.register({ slot: 'model.picker' }, FlatModelPicker)
}
```

## Usage without fabricated zeroes {#quota-monitor}

Source: `examples/plugin-quota-monitor`. Manifest ID: `quota-monitor`. Minimum API: **6**.

The monitor combines host storage/settings with topbar, widget and settings surfaces. This function computes risk only from known finite measurements. Unknown usage remains null. The full template also preserves the last known reading during transient failures. Timon ships this package built in and enabled, so an installed copy with the same manifest ID is ignored: to experiment, copy the folder and change `timon.id` first.

Permissions: `usage:read`, `storage`, `settings`. Read the [related guide](ui-kit.md).

`timon plugin add ./examples/plugin-quota-monitor` installs this package on the target instance.

From `examples/plugin-quota-monitor/lib/index.js`, line 27 (excerpt):

```js
export function usageRisk(usage) {
  if (!usage) return null
  const values = Object.values(usage.windows ?? {})
    .filter((window) => window && Number.isFinite(window.utilization))
    .map((window) => window.utilization)
  if (usage.extra?.is_enabled && Number.isFinite(usage.extra.utilization)) values.push(usage.extra.utilization)
  return values.length ? Math.max(...values) : null
}
```

## A speech-to-text engine {#dictation}

Source: `examples/plugin-dictation`. Manifest ID: `example-dictation`. Minimum API: **14**.

API 14. Two stand-in engines in the dictation.engine slot, one per runtime a third party may use: example-page runs in the window and sends the voice nowhere (`egress: none`); example-daemon sends blocks of audio to the plugin's own routes through ctx.api (`egress: daemon`) and returns the text when the user stops. Neither recognises a word: each reports how much voiced audio it heard. Timon opens the microphone, picks the language and owns the draft; an engine only receives 16 kHz mono samples and reports events. The install sheet lists where each engine sends the voice, and both engines then appear under Settings › Interface › Voice dictation. `dictation-models.json` is a pack with one real model for Timon's own engine, offered under **From plugins** in the same settings. The folder also carries a conformance test built on `@timon-ai/sdk/testing`; `files` keeps it out of the package.

Permissions: `dictation:engine`. Read the [related guide](dictation.md).

`timon plugin add ./examples/plugin-dictation` installs this package on the target instance.

From `examples/plugin-dictation/lib/client.js`, line 31 (excerpt):

```js
export function createPageEngine() {
  return {
    id: 'example-page',
    label: 'Example engine (in this window)',
    languages: { codes: ['en', 'fr'], mode: 'forced' },
    interim: 'live',
    async availability() {
      // A real engine answers `needs-setup` until its model is downloaded, with a reason the user can act on.
      return { state: 'ready' }
    },
    async start({ language, signal, onEvent }) {
      let voicedMs = 0
      let ended = false
      const end = () => {
        ended = true
        signal.removeEventListener('abort', onAbort)
        onEvent({ type: 'stopped' })
      }
      const onAbort = () => { if (!ended) end() }
      signal.addEventListener('abort', onAbort)
      return {
        feed(pcm) {
          if (ended) return
          // Your model: hand it the samples, report what it has so far.
          if (rms(pcm) > VOICED_RMS) {
            voicedMs += (pcm.length / SAMPLE_RATE) * 1000
            onEvent({ type: 'partial', text: exampleTranscript(voicedMs, language) })
          }
        },
        async stop() {
          if (ended) return
          const text = exampleTranscript(voicedMs, language)
          if (text) onEvent({ type: 'final', text })
          end()
        },
        cancel() {
          if (!ended) end()
        },
      }
    },
  }
}
```

From `examples/plugin-dictation/lib/index.js`, line 35 (excerpt):

```js
export function apply(ctx) {
  /** id → { owner, recognizer, samples, touched } */
  const sessions = new Map()
  const router = ctx.router()

  // Required even on an installation without accounts: the voice is personal.
  router.use((_request, response, next) => {
    if (!ctx.user()) return response.status(401).json({ error: 'Authentication required' })
    next()
  })

  const sweep = (now) => {
    for (const [id, session] of sessions) if (now - session.touched > SESSION_IDLE_MS) sessions.delete(id)
  }
  /** The caller's own dictation, or null: another account's id answers 404, like an unknown one. */
  const own = (request) => {
    const session = sessions.get(String(request.params.id))
    return session && session.owner === ctx.user()?.id ? session : null
  }

  router.get('/status', (_request, response) => {
    response.json({ ready: true })
  })
```

## Owner-only live updates {#realtime}

Source: `examples/plugin-realtime`. Manifest ID: `example-realtime`. Minimum API: **4**.

API 4. An authenticated route increments a per-account counter and publishes changed to that account only. The widget subscribes, groups bursts with a 100 ms debounce, reloads through its own API and unsubscribes on unmount. Open two tabs as the same account to see both update; another account receives nothing. The counter is in memory and resets when the plugin unloads.

Permissions: `realtime:publish`. Read the [related guide](realtime.md).

`timon plugin add ./examples/plugin-realtime` installs this package on the target instance.

From `examples/plugin-realtime/lib/index.js`, line 16 (excerpt):

```js
  router.post('/increment', (_request, response) => {
    const ownerUserId = ctx.user()?.id
    if (!ownerUserId) return response.status(401).json({ error: 'Authentication required' })
    const count = (counts.get(ownerUserId) ?? 0) + 1
    counts.set(ownerUserId, count)
    ctx.realtime.publish('changed', { count }, { ownerUserId })
    response.json({ count })
  })
```

From `examples/plugin-realtime/lib/client.js`, line 23 (excerpt):

```js
      const unsubscribe = clientCtx.realtime.subscribe('changed', () => {
        clearTimeout(timer)
        timer = setTimeout(() => { void reload() }, 100)
      })
      void reload()
      return () => { active = false; clearTimeout(timer); unsubscribe() }
    }, [])
```

## Agents created from an external system {#agent-sync}

Source: `examples/plugin-agent-sync`. Manifest ID: `agent-sync-example`. Minimum API: **7**.

API 7. One Timon agent per profile of another system, created through ctx.agents: the call runs with the rights of the account that makes it, so the plugin's own permission is not a way around the account's. create never overwrites a name already taken, and update only reaches the agents this plugin created.

Permissions: `agents:manage`. Read the [related guide](permissions.md).

`timon plugin add ./examples/plugin-agent-sync` installs this package on the target instance.

From `examples/plugin-agent-sync/lib/index.js`, line 20 (excerpt):

```js
export async function syncAgents(ctx, profiles, defaults = {}) {
  const prefix = defaults.prefix ?? 'sync';
  const known = new Map((await ctx.agents.list()).map((a) => [a.name.toLowerCase(), a]));
  /** @type {{ created: string[], updated: string[], skipped: string[] }} */
  const report = { created: [], updated: [], skipped: [] };
  for (const profile of profiles) {
    const name = agentName(prefix, profile.id);
    const fields = {
      systemPrompt: profile.prompt,
      role: defaults.role ?? 'research',
      ...(defaults.backend ? { backend: defaults.backend } : {}),
      ...(defaults.model ? { model: defaults.model } : {}),
      // The mascot drawn for the agent; a value off the daemon's lists is `invalid`.
      ...(profile.look ? { look: profile.look } : {}),
    };
    const existing = known.get(name.toLowerCase());
    if (!existing) {
      await ctx.agents.create({ name, ...fields });
      report.created.push(name);
    } else if (existing.mine) {
      await ctx.agents.update(existing.name, fields);
      report.updated.push(existing.name);
    } else {
      report.skipped.push(existing.name);
    }
  }
  return report;
}

const STATUS = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409 };

/** @param {import('@timon-ai/sdk').PluginContext} ctx */
```

## A TO DO connector (GitHub Issues) {#todo-connector}

Source: `examples/plugin-todo-connector`. Manifest ID: `todo-connector-github`. Minimum API: **8**.

API 8. Keeps the TO DO notebook and an issue tracker in step: a webhook in, and a durable, ordered, credentialed call out when an idea is done. It is a template of about sixty lines: copy the folder, change the manifest ID, then adapt the handlers. The manifest declares `"auth": "github"`, so GitHub calls the plugin directly and Timon checks its `X-Hub-Signature-256` signature; no relay.

To connect a repository:

1. On the plugin's install sheet, tick the `GITHUB_TOKEN` secret and the host `api.github.com`: both are granted to this plugin alone ([Secrets](secrets.md#what-the-administrator-sees-at-install)). If the vault has no `GITHUB_TOKEN` yet, create it from the sheet's link, then grant it from **Secrets**. Then open **Settings › Plugins › GitHub Issues connector (template)** and fill in **Repository** (`owner/name`); **Name of the vault entry holding the GitHub token** stays `GITHUB_TOKEN` unless you stored the token under another name, which you then grant yourself.
2. Under **Incoming webhooks**, copy the address of `issues` and click **Generate secret**. Copy the secret: it is shown once.
3. On GitHub, open the repository's **Settings › Webhooks › Add webhook**. Paste the address in **Payload URL**, choose **Content type: application/json**, paste the secret in **Secret**.
4. Choose **Let me select individual events**, tick **Issues** only, and save. GitHub sends a `ping` first: the handler ignores it and Timon answers `200`.
5. Open an issue on GitHub: it appears in the TO DO notebook, linked to the issue. Closing the idea in Timon closes the issue.

Permissions: `webhooks:receive`, `todos:read`, `todos:write`, `events:subscribe`, `http:outbound`, `secrets:read`, `settings`. Read the [related guide](webhooks.md).

`timon plugin add ./examples/plugin-todo-connector` installs this package on the target instance.

From `examples/plugin-todo-connector/lib/index.js`, line 20 (excerpt):

```js
export const name = 'todo-connector-github'

const PROVIDER = 'github'

/** @param {import('@timon-ai/sdk').PluginContext} ctx */
export function apply(ctx) {
  const repository = () => String(ctx.settings.get('repository') ?? '')
  const refOf = (issue) => `${repository()}#${issue.number}`

  // 1 + 2: a ticket opened on GitHub becomes an idea, once.
  ctx.webhooks.on('issues', async (request) => {
    // GitHub's first call is a `ping` with no issue: nothing to do.
    if (request.headers['x-github-event'] !== 'issues') return
    /** @type {{ action?: string, issue?: { number: number, title: string, body?: string | null, html_url: string } }} */
    const { action, issue } = request.json()
    if (!issue) return
    if (action === 'opened') {
      await ctx.kanban.todos.create(
        { text: `#${issue.number} · ${issue.title}`, notes: issue.body ?? null, author: PROVIDER },
        [{ provider: PROVIDER, ref: refOf(issue), url: issue.html_url, label: `#${issue.number}` }],
      )
    }
    // 5: a ticket closed on GitHub closes its idea.
    if (action === 'closed') {
      const idea = await ctx.kanban.todos.links.findByRef(PROVIDER, refOf(issue))
      if (idea) await ctx.kanban.todos.close(idea.id) // origin = this plugin
    }
  })

  // 3 + 4: an idea closed in Timon closes its issue on GitHub.
  ctx.events.on('todo_done', async (event) => {
    if (event.origin.kind === 'plugin' && event.origin.id === ctx.id) return // our own echo
    const link = event.todo.links.find((l) => l.provider === PROVIDER)
    if (!link) return
    const number = link.ref.slice(link.ref.lastIndexOf('#') + 1)
    await ctx.outbox.post(
      `https://api.github.com/repos/${repository()}/issues/${number}`,
      { state: 'closed' },
      {
        method: 'PATCH',
        key: `todo:${event.todo.id}`, // one lane per idea: outcome, then closure
        auth: { secret: String(ctx.settings.get('tokenSecret') ?? 'GITHUB_TOKEN') },
        headers: { accept: 'application/vnd.github+json' },
      },
    )
  })
}
```

## A shipped connector, written with the public SDK {#todo-connector-discord}

Source: `examples/plugin-todo-connector-discord`. Manifest ID: `todo-connector-discord`. Minimum API: **15**.

API 15. The Discord connector Timon ships (off by default): tickets and replies in, outcomes out, a tester's files attached to the idea after a magic-byte check (`ctx.kanban.todos.attachments`). It uses the public SDK only, so a GitHub, Jira or Slack connector can follow the same shape. Each ticket starts an investigation, which is a mission: the operator adds `todo-connector-discord` to `pluginPolicy.spawn.approved` ([Permissions](permissions.md)); until then the idea is created, an action card asks for the approval, the settings page names the ticket waiting, and the bot's next retry starts it. The excerpt shows the incoming handler and the registration.

Permissions: `webhooks:receive`, `todos:read`, `todos:write`, `events:subscribe`, `kanban:write`, `http:outbound`, `secrets:read`, `storage`, `settings`, `triggers:disable`. Read the [related guide](webhooks.md).

`timon plugin add ./examples/plugin-todo-connector-discord` installs this package on the target instance.

From `examples/plugin-todo-connector-discord/lib/index.js`, line 251 (excerpt):

```js
async function onWebhook(ctx, request) {
  await migrate(ctx)
  const event = parseInbound(request.text)
  await bump(ctx, (s) => ({ received: (s.received ?? 0) + 1, lastAt: Date.now(), lastType: event.type ?? event.kind }))
  if (event.kind === 'invalid') {
    ctx.log.warn(`webhook ${request.id} ignored: ${event.reason}`)
    return
  }
  if (event.kind === 'ignore') return
  if (event.kind === 'reply') await onReply(ctx, event)
  else await onCreated(ctx, event)
}

/** One outcome or closure for the bot, queued behind the idea's earlier ones. */
```

From `examples/plugin-todo-connector-discord/lib/index.js`, line 285 (excerpt):

```js
export function apply(ctx) {
  ctx.webhooks.on('events', (request) => onWebhook(ctx, request))
  void migrateAtStart(ctx)
  ctx.events.on('todo_resolved', (event) => send(ctx, event, resolvedBody(event, Date.now())))
  ctx.events.on('todo_done', (event) => send(ctx, event, doneBody(event, Date.now())))

  const router = ctx.router()

  router.get('/status', async (_request, response) => {
    const settings = settingsOf(ctx)
    const stats = await readStats(ctx)
    const last = stats.lastOutbox ? await ctx.outbox.get(stats.lastOutbox.id) : undefined
    response.json({
      outbound: { workerUrl: Boolean(settings.workerUrl) },
      // What the section's form shows: effective values, none of them a secret (`signingSecret` is a vault entry NAME).
      settings: {
        workerUrl: settings.workerUrl,
        signingSecret: settings.signingSecret,
        referencePattern: ctx.settings.get('referencePattern') ?? '',
        investigationAgent: settings.agent,
        project: settings.project,
        silentInvestigation: settings.silent,
      },
      received: stats.received ?? 0,
      lastAt: stats.lastAt ?? null,
      lastType: stats.lastType ?? null,
      awaitingApproval: stats.awaitingApproval ?? null,
      lastOutbox: last && stats.lastOutbox ? { kind: stats.lastOutbox.kind, state: last.state, attempts: last.attempts, error: last.last_error } : null,
      legacy: legacyTriggers(await ctx.triggers.list(), settings.workerUrl).map((t) => ({ id: t.id, name: t.name })),
    })
  })

  // Retires the hand-made triggers this plugin replaces. A gesture, not an
  // activation side effect: `discord-events` must keep receiving until the
  // owner has seen this path receive too, hence the refusal while nothing came in.
  router.post('/retire-legacy', async (request, response) => {
    const settings = settingsOf(ctx)
    const stats = await readStats(ctx)
    if (!((stats.received ?? 0) > 0) && request.query?.force !== '1') {
      response.status(409).json({ error: 'nothing has been received on the new path yet' })
      return
    }
    const retired = []
    for (const trigger of legacyTriggers(await ctx.triggers.list(), settings.workerUrl)) {
      if (await ctx.triggers.disable(trigger.id)) retired.push({ id: trigger.id, name: trigger.name })
    }
    ctx.log.info(`retired ${retired.length} hand-made trigger(s): ${retired.map((t) => t.name).join(', ')}`)
    response.json({ retired })
  })

  return () => { /* handlers and routes are released with the context */ }
}
```

## A per-user connection {#user-connection}

Source: `examples/plugin-user-connection`. Manifest ID: `user-connection-example`. Minimum API: **7**.

API 7. Each account registers its own service URL and key; the plugin reads that account's connection and calls the service once an administrator approved the address. The key lives in the daemon's vault and is never shown again.

Permissions: `connections:register`, `connections:users:read`, `http:outbound`. Read the [related guide](connections.md).

`timon plugin add ./examples/plugin-user-connection` installs this package on the target instance.

From `examples/plugin-user-connection/lib/index.js`, line 31 (excerpt):

```js
export function apply(ctx) {
  const type = `${ctx.id}:service@1`;

  ctx.connections.registerType({
    name: 'service', version: 1,
    label: 'Example service',
    description: 'An HTTP service reached with a bearer key.',
    configSchema,
    fields: [{ key: 'workspace', label: 'Workspace', placeholder: 'default' }],
    secrets: [{ name: 'apiKey', label: 'API key', required: true }],
    // The settings "Test" button. `context.fetch` stays on this connection's
    // origin and goes through the daemon's SSRF guard.
    async test(context) {
      const key = await context.secret('apiKey');
      const response = await context.fetch(endpoint(context.connection.url, 'health'), {
        headers: { authorization: `Bearer ${key}` }, signal: context.signal,
      });
      return { ok: response.ok, message: response.ok ? 'Service reachable' : `Service answered ${response.status}` };
    },
  });

  // GET /api/plugins/user-connection-example/status — for the CALLER only.
  const router = ctx.router();
  router.get('/status', async (_req, res) => {
    const user = ctx.user();
    if (!user) { res.status(401).json({ error: 'sign in' }); return; }
    const connections = await ctx.connections.forUser(user.id);
    const usable = connections.find((c) => c.type === type && c.enabled && c.approval === 'approved');
    if (!usable) { res.json({ connected: false, pending: connections.some((c) => c.approval === 'pending') }); return; }
    const key = await ctx.connections.userSecret(user.id, usable.id, 'apiKey');
    // Present only with `http:outbound` in the manifest.
    if (!ctx.fetch) { res.status(500).json({ error: 'http:outbound is not granted' }); return; }
    try {
      // Reachable because an approved connection opened this origin.
      const response = await ctx.fetch(endpoint(usable.url, 'health'), { headers: { authorization: `Bearer ${key}` } });
      res.json({ connected: true, status: response.status });
    } catch (error) {
      // A refusal names the rule, never the key.
      res.status(502).json({ connected: true, error: error instanceof Error ? error.message : 'unreachable' });
    }
  });
}
```

## Business events, workflows and messaging {#webhook-bridge}

Source: `examples/plugin-webhook-bridge`. Manifest ID: `webhook-bridge`. Minimum API: **3**.

API 3 registers a business event, an uppercase executor, a signal trigger and an authenticated transport. The receive handler verifies the timestamp and HMAC before accepting an external ID. The full send handler uses a per-fragment idempotency key and checkpoint. Configure connections with vault secret names and operator policy before sending traffic; no AI provider is needed for the uppercase executor.

Permissions: `transports:register`, `connections:read`, `connections:write`, `missions:spawn`, `missions:read`, `secrets:read`, `http:outbound`, `events:register`, `events:publish`, `workflows:triggers:register`, `workflows:executors:register`. Read the [related guide](permissions.md).

`timon plugin add ./examples/plugin-webhook-bridge` installs this package on the target instance.

From `examples/plugin-webhook-bridge/lib/index.js`, line 33 (excerpt):

```js
  ctx.businessEvents.register({ name: 'message.received', version: 1, payloadSchema: textSchema });
  ctx.workflows.registerExecutor({
    name: 'uppercase', version: 1, configSchema: emptySchema, outputPorts: ['out'],
    execute: ({ input }) => ({ output: { text: textSchema.parse(input).text.toUpperCase() }, port: 'out' }),
  });
  ctx.workflows.registerTrigger({
    name: 'signal', version: 1, configSchema: topicSchema,
    start(context) { signals.add(context); return () => { signals.delete(context); }; },
  });
```

From `examples/plugin-webhook-bridge/lib/index.js`, line 56 (excerpt):

```js
    async receive(context, request) {
      const stamp = request.headers['x-timon-timestamp'] ?? '';
      const signature = request.headers['x-timon-signature'] ?? '';
      if (!/^[0-9]{10}$/.test(stamp) || Math.abs(Date.now() / 1000 - Number(stamp)) > 300 || !/^[a-f0-9]{64}$/.test(signature)) {
        throw new Error('Invalid signature envelope');
      }
      const signing = await context.secret('signing');
      if (!signing || signing.length < 24) throw new Error('Signing secret unavailable');
      const expected = createHmac('sha256', signing).update(`${stamp}.`).update(request.body).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('Invalid signature');
      const message = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body)));
      if (message.room !== context.connection.config.room) throw new Error('Room not allowed');
      // Inbound URLs, credentials and identity fields never select the callback.
      return { externalId: text(message.id), text: text(message.text, 64_000), replyContext: { room: text(message.room) } };
    },
```
