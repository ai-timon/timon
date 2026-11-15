import React from 'react'
import { createTranslator, useProviderPage, ProviderSection, ProviderSettingRow, Button, DropdownMenuItem } from '@timon/ui'

const h = React.createElement

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: {
    title: 'Acme Gateway',
    gateway: 'Gateway',
    models: '{count, plural, one {# model offered} other {# models offered}}',
    console: 'Open the console',
    refresh: 'Check again',
  },
  fr: {
    title: 'Acme Gateway',
    gateway: 'Passerelle',
    models: '{count, plural, one {# modèle proposé} other {# modèles proposés}}',
    console: 'Ouvrir la console',
    refresh: 'Vérifier à nouveau',
  },
})

const GATEWAY = 'https://gateway.example.com/v1'
const CONSOLE = 'https://console.example.com'

/**
 * The section this provider adds to its own page in Settings › AI models ›
 * Providers.
 *
 * `settings.provider.section` is a list slot declared at boot. The page paints
 * the product's common sections (Connection, API key, Models, Program, own
 * settings) and, on the page of a provider this plugin brings, the sections this
 * plugin registered — never on another provider's page.
 *
 * The component receives no props: it reads `useProviderPage()`, the provider
 * on screen as the daemon describes it. Registered with `key: 'settings'`, it
 * takes the place of the common "own settings" section on this provider's page;
 * without a key it would be added last, after own settings, or where `order`
 * puts it (Connection 100, API key 200, Models 250, Program 300, own settings
 * 400).
 *
 * What a section must respect:
 *   - draw itself as the product's do: a `ProviderSection` (a short label over
 *     a card) holding `ProviderSettingRow`s — a title and one status line at
 *     the left, ONE main action at the right, the others in the row's "…"
 *     menu. No paragraph of explanation, no field shown in permanence: a form
 *     opens after a click, in a dialog or under the row (`children`);
 *   - render nothing when it has nothing to say (`return null`): the page
 *     leaves no gap for it;
 *   - after a change it made itself, call `refresh()` so the header and the
 *     other sections read the provider again;
 *   - never show a secret: the provider record holds vault entry names only.
 */
function AcmeGatewaySection() {
  const page = useProviderPage()
  if (!page) return null
  const { provider, refresh } = page
  return h(ProviderSection, { title: t('title') },
    h(ProviderSettingRow, {
      title: t('gateway'),
      status: h('span', { className: 'tabular-nums' }, `${new URL(GATEWAY).host} · ${t('models', { count: provider.modelCount })}`),
      action: h(Button, { size: 'sm', variant: 'outline', asChild: true },
        h('a', { href: CONSOLE, target: '_blank', rel: 'noreferrer' }, t('console'))),
      menu: h(DropdownMenuItem, { onSelect: () => void refresh() }, t('refresh')),
    }))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'settings.provider.section', key: 'settings', order: 400 }, AcmeGatewaySection)
}
