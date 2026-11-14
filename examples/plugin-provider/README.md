# Provider plugin with code

This template adds a compatible provider profile and a dialect for a fictitious
JSON-speaking CLI. Start with the [public provider guide](../../public-docs/docs/plugins/providers.md).
For a shareable provider that only needs endpoint, model and secret-setting
configuration, use `plugin-provider-pack` instead: it needs no JavaScript.

## Credentials

Register the profile unconditionally. Its `env` function reads the plugin's
secret setting at every mission launch and during availability probes. Throwing
keeps the profile out of menus and dispatch until the key is supplied; the
daemon never relays the error message. Refresh short-lived tokens here, and
make repeated probes safe. Do not read `process.env` or freeze a key at load.
`envFrom`, `requiredEnv` and vault reference objects are refused for code
profiles; use `ctx.secrets` inside the resolver if needed and permitted.

## Custom dialect

The daemon launches the process. The manifest is `kind: "provider"` and names
the program in `provider.binaries` (a bare name, never a path). When the
superadmin installs the plugin from the gallery, Timon resolves that name on the
machine and shows the resulting path: accepting it adds the path to
`pluginPolicy.exec.allow`, so nobody edits `timon.config.json`. Reusing a product
dialect's binary needs no authorization. All registrations are removed on
unload, and a new version of the plugin replaces the old one without a restart
(the backend stays dispatchable during the swap).

The `echo` dialect is a protocol template, **not the operating system's echo
command and not a working AI backend**. On a test installation with a matching
CLI installed, the install screen would show its resolved path to accept.

Without that authorization the example catches the registration error and leaves
its compatible profile available. Provider endpoints and model IDs are example
data, not current catalogue recommendations.

## Permission modes

A CLI that cannot ask for an approval in the middle of a turn may honour only
some of the agent's permission modes. A provider registered with
`ctx.provider.registerProvider` says so in its definition:

```js
permission: { model: 'sandbox', supportedModes: ['plan', 'bypassPermissions'] },
```

The list is optional, must not be empty, may only name known modes
(`PERMISSION_MODES` in `@timon-ai/sdk/provider`) and must include `plan`. Timon
then offers only these modes in its screens, and runs every other one in `plan`,
never higher: `launch` receives the resolved mode, and the permission ceiling
judges it. Apply the same rule in your own mapping, so the plugin stays
read-only on a daemon that does not resolve the mode. Leave the field out when
the CLI honours every mode.

## Testing

`test/conformance.test.mjs` runs the conformance bench of `@timon-ai/sdk/testing`
on the dialect: the checks Timon applies to its own providers, on a recorded turn
(`test/fixtures/turn.jsonl`). No CLI, no account, no network. The SDK is not on the
public npm registry: add it to your project's development dependencies from your
developer distribution, then:

```bash
node --test test/conformance.test.mjs
```

The test runs the plugin's own `apply(ctx)` against `createProviderContext()`, a
stand-in `ctx` that carries a copy of the daemon's runtime, and tests the dialect
it registered. The dialect is built from `ctx.provider.runtime` (codecs, event
vocabulary): it declares `"apiVersion": 12`, the contract `ctx.provider` belongs
to, and `registerDialect` then also checks that its declarations agree with each
other. See the public guide's "Test your dialect with the conformance bench".
