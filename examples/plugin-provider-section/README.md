# A provider with a section of its own

A declarative provider pack — one backend, Acme Gateway, reached through an
OpenAI Responses endpoint by the installed `codex` CLI dialect — with a browser
half that adds a section to **its own page** in Settings › AI models ›
Providers. The address and the models are placeholders (`example.com`): copy
the folder and put your gateway's.

The page of a provider is made of the product's common sections (Connection,
API key, Models, Program, own settings) and of the sections its plugin
registers in the `settings.provider.section` slot. A plugin's section is painted
on the pages of the providers it brings only: its `pluginId` is the provider's.

- The component takes no props: it reads `useProviderPage()` from `@timon/ui`
  (`provider`, `status`, `defaultBackend`, `refresh()`, `back()`), client API 16.
- It draws itself as the product's sections do, so the page reads as one: a
  `ProviderSection` (a short label over a card) holding `ProviderSettingRow`s —
  a title and one status line at the left, one main action at the right, the
  others in the row's "…" menu. No paragraph under the label, no field shown in
  permanence.
- `key: 'settings'` puts it in place of the common "own settings" section, on
  this provider's page only. Without a key it is added; `order` places it (the
  common sections are 100 to 400).

Install with `timon plugin add ./examples/plugin-provider-section`. An unsigned
local copy needs the operator's `developer.unsignedPlugins` setting. The
contract is in [Providers](../../public-docs/docs/plugins/providers.md) and
[Slots](../../public-docs/docs/plugins/slots.md), under
`settings.provider.section`.
