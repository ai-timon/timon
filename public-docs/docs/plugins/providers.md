---
title: Write a provider
---

A provider is what lets Timon run missions on a model: a CLI such as Claude Code
or Codex, an agent that speaks the Agent Client Protocol, or a service reached
over the network. This guide takes you from "I have an agent" to a provider other
people can install, using this documentation and the SDK alone. You do not need
Timon's source code.

## Choose how much you have to write

Most providers need no code. Start at the top of this table and stop at the first
row that fits.

| You have | You write | Where |
| --- | --- | --- |
| An endpoint that speaks the Anthropic API or OpenAI Responses, for your own installation | Nothing: a form or a JSON file | [Add a provider](../usage/add-a-provider.md) |
| The same endpoint, to share with other users | A declarative pack: JSON, no code | [Share a declarative pack](#share-a-declarative-pack) |
| An agent that is in the official ACP registry | Nothing: install it from Settings | [Agents from the ACP registry](#agents-from-the-acp-registry) |
| An endpoint whose key must be refreshed, or looked up per user | A profile with a few lines of code | [Add code for dynamic credentials](#add-code-for-dynamic-credentials) |
| An agent that speaks ACP and is not in the registry | One row of data on the daemon's ACP engine | [Write it with the SDK's provider kit](#write-it-with-the-sdks-provider-kit) |
| A CLI that prints one JSON object per line | A provider definition: launch line and line parser | [Build a provider on the engine](#build-a-provider-on-the-engine) |
| An agent reached over HTTP or WebSocket, no local process | A remote provider | [Drive a remote agent](#drive-a-remote-agent-with-no-local-process) |

Every row from the declarative pack down is a plugin that needs the
`backends:register` permission, because a provider chooses where the prompts of
every mission run on it are sent. One that launches a program is a plugin of
`kind: "provider"`. Normal plugin installation, permission,
signature and licence requirements apply; see [Testing](testing.md) and
[Publishing](publishing.md).

## Providers shipped with Timon

Claude, Codex, Grok, Copilot, opencode, Hermes, Antigravity, Pi, Kimi, Ollama Cloud
and LLMTR are provided by official plugins shipped with the app. They appear in the Plugins
gallery with a **Built-in** badge, and they are written on the same
`ctx.provider` kit described below, so they are the reference for what a
provider can do. Kimi is a profile on the Claude provider; Ollama Cloud is a
profile on Codex's. LLMTR is its own remote provider: it calls Chat Completions
at `https://llmtr.com/v1` with the vault secret `LLMTR_API_KEY`, through
`ctx.fetch`, and only after the operator allows `llmtr.com` in
`pluginPolicy.http`. It does not use the Responses API. It runs no local tools. Switching off the underlying provider leaves a profile
that rides on it inactive until it is switched back on. Your saved model choices,
accounts and fallback rules keep their provider IDs.

A few helpers are kept for the providers shipped with Timon and refused to an
installed plugin: the sealed credential store of a legacy token, a legacy
`/api/backends/<name>` route, and a profile that names a secrets-vault entry.
A provider you write uses its own secret settings and plugin routes instead.

Claude keeps its subscription login, permission cards, thinking controls and
session resume. A macOS background service still uses the token saved through
`timon auth claude-token set` or Settings; upgrading does not require pasting it
again. Provider updates wait for running missions, including subscription
accounts and profiles using that provider's protocol.

## Start with the protocol

Does the endpoint speak the Anthropic API or OpenAI Responses? For your own
installation, you need **no plugin**: use the form or a local backend JSON file
in [Add a provider](../usage/add-a-provider.md). The corresponding CLI must be
installed. OpenAI Chat Completions alone is not the Responses protocol. This
covers gateways such as OpenRouter, vLLM or LM Studio.

To share endpoint and model configuration with other users, distribute a
**declarative provider pack**. Add host code only when you need dynamic
credentials or another CLI protocol.

## Share a declarative pack

A pack is an ESM npm package without `main`. Put providers in `timon.backends`.
Here is a complete `package.json`; replace the example endpoint and model ID
with values supported by your provider:

```json
{
  "name": "@acme/timon-provider",
  "version": "0.1.0",
  "type": "module",
  "timon": {
    "id": "acme-provider",
    "apiVersion": 2,
    "kind": "provider",
    "label": "Acme provider",
    "permissions": ["backends:register"],
    "settings": [
      { "key": "apiKey", "type": "secret", "label": "Provider API key" }
    ],
    "backends": [{
      "id": "acme-responses",
      "dialect": "codex",
      "label": "Acme Responses",
      "env": { "ACME_API_KEY": { "setting": "apiKey" } },
      "providerConfig": {
        "id": "acme",
        "name": "Acme",
        "baseUrl": "https://responses.example.test/v1",
        "envKey": "ACME_API_KEY",
        "wireApi": "responses"
      },
      "defaultModel": "example-model",
      "models": [{ "slug": "example-model", "label": "Example model" }]
    }],
    "license": { "required": false }
  }
}
```

Install the prepared package with `timon plugin add ./my-provider`, then enter
the key in its plugin settings. No JavaScript is loaded, even if an `index.js`
file exists. API 2 is the original backend-facade floor; declarative packs need
a Timon release supporting `timon.backends` (introduced on 18 September 2026).

For an Anthropic-compatible endpoint, use `dialect: "claude"` with
`ANTHROPIC_BASE_URL` as a literal URL and `ANTHROPIC_AUTH_TOKEN` as the setting
reference; omit `providerConfig`. The [cookbook](examples.md#provider-pack)
contains both complete profiles in one pack.

For a real provider to start from, the cookbook also has a
[ready-to-install OpenRouter pack](examples.md#provider-openrouter): a fixed
OpenAI Responses endpoint, the key in a secret setting, and the model list read
from OpenRouter's public `modelsEndpoint` instead of written in the manifest. A
pack suits an endpoint that is the same for every user; an address each user
hosts, such as a LiteLLM proxy, is added from Settings instead
([Add a provider](../usage/add-a-provider.md#through-a-litellm-proxy)).

`{ "setting": "apiKey" }` references only a `type: "secret"` setting declared
by **this plugin**. Its current value is read at each mission launch and its
availability is checked when the catalogue is consulted. Saving, replacing or
clearing it takes effect without reloading the plugin. A manifest secret
default is not used. Keep actual keys out of the package.

Alternatively, `{ "secret": "ACME_API_KEY" }` references a vault entry, subject
to the mission's normal secret grants. See [Secrets](secrets.md). TypeScript
authors can import `SettingRef`, `SecretRef` and `LocalBackendFile` from the SDK.
A setting reference is valid only in a plugin pack, not a standalone local file.

### What is refused

Entries use the same strict schema as local backend files:

- `main` together with `timon.backends`, or missing `backends:register`: the
  manifest is refused. Packs do not mix executable host code with declarations.
- `cmd`, `requiredBinary`, `envFrom`, `requiredEnv`, and unknown fields: data
  cannot select a binary or read inherited daemon credentials.
- An undeclared setting or one not typed `secret`: a pack cannot read arbitrary
  settings or another plugin's key.
- Environment names outside provider-data naming rules, or reserved runtime,
  loader and home variables: declarations must not alter process execution.
  Names must use uppercase snake case with a provider prefix and end in
  `_API_KEY`, `_AUTH_TOKEN`, `_TOKEN`, `_BASE_URL`, `_API_BASE`, `_API_VERSION`,
  `_ORGANIZATION`, `_PROJECT`, `_REGION` or `_MODEL`; reserved names remain
  forbidden even with these suffixes. This also applies to `providerConfig.envKey`.
- A duplicate backend ID: a pack cannot replace a built-in, local or plugin
  profile. Use a distinct lowercase letters/digits/dashes ID, at most 40 characters.

An invalid entry stays out of the registry with its reason in plugin status;
valid neighbours still load. A missing key or unavailable dialect keeps a
registered profile inactive. Disabling, removing or updating the pack removes
its registrations.


## Declare the programs a provider launches

A provider that runs a program on the machine (a CLI, an agent) is a plugin of
`kind: "provider"`. It names the program in the manifest, by bare name:

```json
{
  "timon": {
    "id": "acme-agent",
    "apiVersion": 12,
    "kind": "provider",
    "permissions": ["backends:register"],
    "provider": { "binaries": [{ "name": "acme-agent", "aliases": ["acme"] }] }
  }
}
```

Declare `apiVersion` 12 as soon as your code uses `ctx.provider`. The `provider`
key carries three lists, each of which the install sheet shows and each of which
the definition's `declares` must stay inside: `binaries` (the programs),
`credentialDirs` (the home folders holding the CLI's sign-in) and `osCredentials`
(the macOS keychain entries it reads). A `declares` entry or a keychain read that the
manifest does not list is refused at registration.

To write a name or a folder once, your code can read it from its own manifest instead
of repeating it: `package.json` ships with your package, so
`JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).timon.provider`
gives your host half (`lib/`) the lists the operator authorized. The providers Timon
ships build their `declares` that way.

`binaries` takes at most four entries, each a plain executable name (letters,
digits, `.`, `_`, `+`, `-`) with at most four aliases. A name containing a slash
or a drive letter is refused. A provider reached over the network launches no
program: leave `binaries` empty or omit `provider`.

You may see a fourth key, `backends`, in the manifests of the providers Timon
ships. It is read only for those: in your manifest it is checked and then
ignored, so leave it out.

You never ask the person to edit `timon.config.json`. When a superadmin installs
the plugin from the gallery, Timon looks the names up on **their** machine and
the install sheet shows:

- three plain lines: the provider *receives every instruction and every answer
  of the missions it serves*, *receives the credentials of its own profile*, and
  *launches* each program, with its full resolved path;
- a tick-box, off by default, to allow Timon to run those exact programs.

Without the tick the plugin installs but its program stays unauthorized; the same
sheet is available later in **Settings → AI models → LLM backends → Providers**.
Only the path Timon found is ever allowed, and if it changes between the sheet
and the click, nothing is installed and the sheet is shown again. `claude`,
`codex`, `timon`, shells, interpreters and package runners can never be
authorized for a plugin, whatever the manifest says.

Write the dialect's `defaultCmd` with the bare name; Timon launches the path the
person authorized.

What is authorized is the **file** the name leads to, links followed, and Timon checks
it again every time a mission starts your program — a first turn, a resumed
conversation, a relaunch. If the name now leads to another file (the program moved,
an update replaced the file a link points to) or the authorization was removed, the
mission is refused and says which file it found; a notification card opens the same
Providers sheet on your plugin, with the authorization dialog ready, and the person
authorizes it again there. A path your `launch` returns that was not authorized is
refused the same way, even when its file name matches. The file checked is also the
file started: replacing it, or retargeting a link to it, while a mission is starting
refuses that start.

### Tell your program from a namesake

A name is not an identity: two vendors can install a program with the same name
in the same folder, and the last installer wins. If your program can say who it is,
declare how in `declares.binary.identity`:

```js
binary: {
  names: ['acme-agent'],
  identity: { args: ['--version'], pattern: '\\bacme-agent \\d+\\.\\d+', expected: "Acme's agent CLI" },
},
```

Before a mission starts the program, and before `ctx.provider.binary` runs it
(a version, a probe, the model probe), Timon runs it with `args` (default
`--version`) and tests what it printed — standard output and error together —
against `pattern`, where `^` and `$` match a line. A program that does not match is
refused, and the person reads which file it was, the first line it printed and your
`expected` sentence. The answer is remembered per file until the file changes.
Keep the pattern simple: a test that runs past 250 ms (nested repetitions such as
`(a+)+` can backtrack without end) is stopped and the program refused, and a program
still running after 5 seconds is killed.
Choose arguments that only print: never one that signs in, opens a session or
writes.

Your code is not loaded yet when the person authorizes the path, so write the same
identity in your manifest, on the binary it describes:

```json
"provider": {
  "binaries": [{
    "name": "acme-agent",
    "aliases": ["acme"],
    "identity": { "args": ["--version"], "pattern": "\\bacme-agent \\d+\\.\\d+", "expected": "Acme's agent CLI" }
  }]
}
```

When the person ticks the box and confirms (never when the sheet is only shown),
Timon runs each program they accepted with those arguments. A program that does not
match is refused with the same sentence, nothing is allowed and nothing is installed:
the sheet stays open and the person installs the right program. Keep the two copies
identical — same `pattern`, `args` and `expected` — or the click and the launch will
not agree on what your program is. The manifest's `identity` is checked at install
like the rest of the manifest: a pattern of 1 to 200 characters that compiles, at most
four plain arguments, and an `expected` of one line.

With an identity, a generic alias becomes safe to declare: a namesake that answers
to it is refused on the click, and again before every launch.

### Updating a provider

Install a newer version of the same plugin and it replaces the running one,
without restarting Timon. The provider stays available during the swap, and a
mission already running keeps working. Two rules protect missions:

- if a mission is running on the provider, the update waits for it to end (the
  plugin shows *update pending* and keeps the version that runs);
- if the new version changes how missions talk to the provider (one process per
  turn versus a persistent one, remote versus local, or where sessions are
  stored), it is refused while Timon runs, and the current version stays. Restart
  the missions, or Timon, to apply it.

## Agents from the ACP registry

Timon can install any program-based agent of the official
[Agent Client Protocol registry](https://agentclientprotocol.com): open
**Settings → AI models → LLM backends → Providers → ACP registry**, pick an
agent, and Timon downloads it, checks it, and offers it as the backend
`acp-<agent>`. Only agents distributed as a downloadable program for your
operating system can be installed; those that need a package runner (`npx`,
`uvx`) or an archive format Timon cannot open are listed with the reason.

- **Checked download.** The registry publishes a `sha256` for some agents. When it
  does, a file that does not match is deleted and nothing is installed. When it
  does not (the row says *No published hash*), Timon asks you to confirm before
  downloading, and records the install as unverified.
- **Checked on every start.** Timon keeps a digest of the installed files and
  compares it each time it registers the agent. A file changed afterwards is
  never launched; the row shows *Files changed* and **Reinstall** repairs it.
- **Updates.** A newer version appears on the row; installing it keeps the
  working version until the new one is verified, then swaps them. The previous
  version is kept until the next update.
- **From unverified to verified.** An agent installed without a published hash
  is marked *Unverified*. When the registry later publishes a `sha256` for your
  machine's build, the row says so and offers **Install verified version**,
  even when the version number did not change. Nothing is replaced until you
  click it, and the swap is the same as for any update.
- **Signing in.** Timon never signs an agent in for you. **Sign-in methods** on
  an installed agent asks the agent how it signs in and lists its methods. The
  suggested one comes first, with the command to run in a terminal when the
  agent gives one. Methods billed per token (an API key, a pay-per-use cloud
  platform such as Vertex AI) are marked *Billed per token* and never
  suggested: Timon runs on subscriptions only. Telling them apart relies on
  the method's name, as the protocol does not say how a method is paid for.
  A mission that starts before the agent is signed in stops with the same
  advice.

## Add code for dynamic credentials

Use a host entry point when a token must be refreshed. Declare `main` in the
package, omit `timon.backends`, and keep `backends:register`, a secret setting,
and the `settings` permission. For example, `lib/index.ts`:

```ts
import type { PluginContext, RegisteredProfile, EnvResolver } from '@timon-ai/sdk';

export function apply(ctx: PluginContext) {
  const env: EnvResolver = () => {
    const apiKey = ctx.settings.get('apiKey');
    if (typeof apiKey !== 'string' || !apiKey) throw new Error('Missing provider key');
    return { ANTHROPIC_AUTH_TOKEN: apiKey };
  };
  const profile: RegisteredProfile = {
    id: 'acme-dynamic',
    dialect: 'claude',
    label: 'Acme dynamic credentials',
    env: async () => ({
      ...await env(),
      ANTHROPIC_BASE_URL: 'https://anthropic.example.test',
    }),
    defaultModel: 'example-model',
    models: [{ slug: 'example-model', label: 'Example model' }],
  };
  ctx.backends.registerProfile(profile);
}
```

Compile TypeScript to JavaScript and point `main` at that output before
packaging. Obtain `@timon-ai/sdk` with the developer distribution; public npm
availability is not assumed. The [code example](examples.md#provider) shows
an entire JavaScript host template.

`RegisteredProfile` requires `id`, `dialect`, `label`, `models` (possibly an
empty array) and `defaultModel` (possibly `null`). Optional display fields
include `vendor`, `brand` and `custom`; a Responses profile also supplies
`providerConfig`. The [type reference](api-reference/type-aliases/RegisteredProfile.md)
links to all inherited profile fields; `envFrom`, `requiredEnv` and the base
`env` shape are specifically excluded from code profiles.

The `env` resolver is called at **every mission launch**, and also for
availability probes. It may return a promise. Refresh a short-lived token
inside that function, reading its current inputs from settings or `ctx.secrets`
(with the corresponding permission and grants). Make repeated or concurrent
calls safe; a probe is not evidence that a mission will launch. Do not capture
a key once in `apply`, and do not conditionally skip registration when it is absent.

### Know who launches the mission

From API 7 the resolver receives one argument, a `BackendLaunchContext`. A
resolver written with no parameter keeps working unchanged.

| `kind` | When | Fields |
| --- | --- | --- |
| `'mission'` | a mission is starting | `missionId`, `ownerUserId`, `agentName`, `project` |
| `'probe'` | no mission behind the call: the availability probe, a usage probe, a summary the daemon runs itself | all `null` |

`ownerUserId` is the mission's owner as Timon recorded it: an account ID,
`plugin:<id>` for a mission a plugin started, or `null` for a Kanban task or a
routine with no owner. Pass an account ID to `ctx.connections.forUser` to find
the connection of the person who launched the mission.

```ts
const env: EnvResolver = async (launch) => {
  // A probe has no user: answer whether SOME account can be served.
  if (launch?.kind !== 'mission') return {};
  const owner = launch.ownerUserId;
  if (!owner || owner.startsWith('plugin:')) throw new Error('No account behind this mission');
  const [connection] = await ctx.connections.forUser(owner);
  if (!connection) throw new Error('No connection for this account');
  const key = await ctx.connections.userSecret(owner, connection.id, 'apiKey');
  if (!key) throw new Error('Connection has no key, or is not approved');
  return { ACME_URL: connection.url, ACME_KEY: key };
};
```

What the function returns on a probe is not always thrown away: the profile's
usage probe and the daemon's one-shot prompts (summaries, dreaming) start the
CLI with it. A **local** per-user profile that returns `{}` there will see those
prompts fail; return what you can serve with no user (a service account), or
accept that failure.

Availability does not depend on who is looking: only the `probe` answer
decides whether the profile is offered, to every account alike. Never require a
user there, or the backend disappears for everyone. An account without a
connection still sees the profile; its mission fails at launch, and that
failure does not hide the profile from the others.

Throwing or rejecting on a probe makes the profile inactive; on a mission it
fails that mission, and the daemon asks the probe again. The daemon never relays the
error's message; keep secrets out of errors and your own logs anyway. The next
successful resolution can restore availability. Code profiles accept literal
non-secret strings or an `EnvResolver`, **not** `{ secret }` / `{ setting }`
objects, `envFrom` or `requiredEnv`. Read credentials through the plugin context
inside the function instead.


### Put a profile on a provider Timon ships

Kimi is a profile on the Claude provider and Ollama Cloud a profile on Codex's:
they bring an endpoint, a key and a model list, and inherit everything else. You
can do the same. Register a profile whose `dialect` is `claude` or `codex` (the
IDs of those providers) and your endpoint gets the launch line, the event
decoding, the permission cards, session resume, usage-limit detection and the
thinking controls of the provider it rides on, with no protocol code of yours.

```ts
ctx.backends.registerProfile({
  id: 'acme-claude',
  dialect: 'claude',
  label: 'Acme (Anthropic API)',
  env: async () => ({ ANTHROPIC_BASE_URL: 'https://anthropic.example.test', ANTHROPIC_AUTH_TOKEN: await freshToken() }),
  defaultModel: 'example-model',
  models: [{ slug: 'example-model', label: 'Example model' }],
})
```

What to expect:

- **Your profile waits for its provider.** If the Claude or Codex provider is not
  loaded yet, or is switched off, your profile registers and stays inactive until
  it is back. A dialect that no provider supplies is refused with a reason, so a
  typo is not mistaken for a wait.
- **Updating the underlying provider waits for your missions.** A provider update
  is held while a mission runs on any profile that rides on it, yours included.
- **What stays out of reach.** A plugin's profile cannot name a secrets-vault
  entry (use its own secret settings), cannot declare `envFrom` or `requiredEnv`,
  and cannot choose the program to run: the provider you ride on launches its
  own CLI, and a provider you write yourself is refused if it launches `claude`,
  `codex`, `timon`, a shell or an interpreter. The subscription login of the underlying
  provider is not yours either: your profile authenticates with the credentials
  its `env` returns.
- **Fallback.** Give a profile a `fallbackRank` only if you want Timon to pick it
  automatically when a quota runs out; leave it out for a provider of unknown
  quality.

When the protocol is genuinely different from Claude's or Codex's, write a
provider of your own, below. Do not copy a shipped provider: describe yours, and
use the engine for the rest.



## Build a provider on the engine

You do not write a process manager. You **describe** a provider, and Timon's
engine runs it: the process, the session, the Allow/Deny cards, the stop button,
idle and stuck-turn cleanup, the trace and the mission's report. A description has
three parts:

- a **transport**: who owns the process, and for how long;
- a **codec**: how bytes become events, and how a prompt becomes bytes;
- **strategies**: everything else Timon needs to know, as small objects.

You register it with `ctx.provider.registerProvider(definition)`; Timon checks it
before accepting it (see [Capabilities are promises](#capabilities-are-promises)).
Your `id` is also the `dialect` of the profiles you register for it.

### Choose the transport and the codec

| Transport | Meaning | Typical use |
| --- | --- | --- |
| `stdio-persistent` | One process for the whole mission. Follow-up turns are written to its stdin. | Claude Code; every ACP agent |
| `process-per-turn` | One process per turn, started with the CLI's own resume mechanism. | Codex, Grok, Copilot |
| `remote` | No process. The session is a connection you open with `ctx.fetch`. | An HTTP or WebSocket agent |

| Codec | You provide | Allowed with |
| --- | --- | --- |
| `lines` | `parseLine(line)`, `extractSessionId(event)`, and `writeUserInput(io, text, images?)` when the process persists. The CLI prints one JSON object per line. | `stdio-persistent`, `process-per-turn` |
| `driver` | `openSession(args)`, which returns a session driver. Use it for a session protocol such as ACP, or a remote connection. | `stdio-persistent`, `remote` |

`remote` with `lines`, and `process-per-turn` with `driver`, are refused at
registration with the reason (a remote session has no lines to read; a driver
needs a process that outlives a turn).

Decide in this order:

1. **Does the agent speak ACP?** Describe it as one row with
   `ctx.provider.runtime.acp.defineProvider`. You write no transport, no driver
   and no permission code: the daemon's ACP client does. This is the cheapest path
   and the one the [Cursor template](examples.md#provider-cursor) takes.
2. **Does the CLI print JSON lines?** Use `lines`. Choose `stdio-persistent` if it
   reads follow-up turns on stdin, `process-per-turn` if each turn is a new launch
   that resumes the session by id.
3. **No process at all?** Use `remote` and [drive it with a session driver](#drive-a-remote-agent-with-no-local-process).

### Fill in the strategies

| Strategy | Required | Says |
| --- | --- | --- |
| `session` | yes | `store` (`global`: the CLI keeps the conversation in its own home; `per-mission`: Timon gives it a private folder), `resumable`, and optionally `notFound(stderr)` (this error means the session to resume is gone: Timon replays the turn on a new conversation and does not count it against the backend; declare it even when `resumable` is `false`, since the next turn of a mission still resumes), `maxPromptBytes`, `setModel` (switch the model of a live process) and `compact: { command }` (see below). A provider that reports no session id keeps no conversation: once a turn has ended without one, Timon starts each following turn from the user's message alone, whatever `resumable` says, and a single line in the chat tells the user. |
| `permission` | yes | `model`: `mcp-bridge` (the CLI asks an injected tool before each tool use), `sandbox` (privileges are frozen at launch from `permission_mode`; there is no card) or `protocol` (the agent asks through its protocol and the driver forwards it). `none` is an admission that the CLI runs everything unguarded; the interface says so. `byAgent` for an agent that decides alone; `appliesMode` for a `protocol` provider that enforces the agent's permission mode itself before it asks (the agent editor then says the mode applies). |
| `limits` | yes | `reporting`: `structured` (a typed rate-limit event), `textual` (a message to read) or `none`. It tells "no limit hit" from "we have no idea". |
| `mcp` | yes | `timon: true` if Timon's own MCP servers can be handed to the provider. |
| `launch(spawn, profile)` | when you own a process | Returns `cmd`, `args`, `initialStdin`, and optionally `env` and `cwd`. The daemon spawns it. |
| `usage` | no | The account's consumption gauge: [see below](#report-the-accounts-usage). Absent means "no gauge", never zero. |
| `models` | no | `discover(profile)`: the model IDs the CLI offers to the signed-in account. It rejects when the CLI cannot tell. |
| `reasoning` | no | `controls`: which thinking controls you can send for a custom model (`levels`, `budget`, `toggle`). |
| `lifecycle` | no | `dispose(missionId)` and `enrich(event, missionId)`. |
| `declares` | no | What the rest of Timon reads about the provider: [the table below](#register-a-provider-not-just-a-dialect). |

The shape of a line-oriented provider:

```js
export function apply(ctx) {
  const { events, jsonLines } = ctx.provider.runtime
  const definition = {
    id: 'acme',
    transport: { kind: 'process-per-turn' },
    codec: {
      kind: 'lines',
      parseLine(line) {
        const row = jsonLines.parseJsonObjectLine(line)
        if (!row) return []                       // never throw on a line
        // …translate the CLI's rows with `events.*`; unknown rows give []
        return []
      },
      extractSessionId: events.extractInitSessionId,
      writeUserInput() {},                        // one process per turn: nothing to write
    },
    session: { store: 'per-mission', resumable: true },
    permission: { model: 'sandbox' },
    limits: { reporting: 'textual' },
    mcp: { timon: true },
    async launch(spawn, profile) {
      // …build `args` from `spawn` and `profile`; the prompt goes to stdin or a file, never to argv when it can be long
      const resume = spawn.resumeSession ? ['--resume', spawn.resumeSession] : []
      return { cmd: 'acme', args: ['run', '--json', ...resume], initialStdin: spawn.message }
    },
    declares: { binary: { names: ['acme'] } },
  }
  const problems = ctx.provider.runtime.check.definitionProblems(definition)
  if (problems.length) throw new Error(problems.join('\n'))
  ctx.provider.registerProvider(definition)
}
```

This is the shape, not a working provider: your `parseLine` and `launch` are the
actual work. Keep the definition in a factory that takes the runtime (as in the
[kit section](#write-it-with-the-sdks-provider-kit)) so that your tests hand it
the same object.

### Let the agent compact its own session

When a conversation grows long, Timon compacts it. By default it summarizes the
transcript and continues in a new conversation. If your CLI can compact its own
session in place (Claude Code's `/compact`), declare the message that does it:

```js
session: { store: 'per-mission', resumable: true, compact: { command: '/compact' } },
```

Timon then sends `command` as the message of a turn in the same conversation,
when the user keeps its model. With a process per turn, that launch receives
`spawn.agentCommand === true`: if your CLI escapes a leading `/` by default, let
it through for this launch only. The compaction counts as done when the turn
emits a `system` event of subtype `compact_boundary` (Claude Code's format);
normalize your CLI's own signal to it in `parseLine`. Without that event, the
user is told the agent did not compact.


## Write it with the SDK's provider kit

A provider is written against **`ctx.provider`** ([reference](api-reference/provider/index.md); API 12, permission
`backends:register`; declare `"apiVersion": 12` in the manifest). Every member
refuses a plugin that declared an older version, and says which one it needs.

**The behaviour comes from Timon, not from your package.** `ctx.provider.runtime`
hands your plugin the codecs, the usage-limit detector, the session drivers, the
MCP serializers and the ACP client **as the daemon runs them**: a fix made in Timon
reaches your provider without you publishing again. `@timon-ai/sdk/provider`
keeps what has no behaviour — the types, the contract's constants and four guards —
and `@timon-ai/sdk/testing` builds a stand-in `ctx` that carries a copy of the
runtime for tests run outside Timon.

| You need | In `ctx.provider.runtime` |
| --- | --- |
| Read one JSON object per line, never throwing | `jsonLines.parseJsonObjectLine`, `parseJsonLine`, `encodeJsonLine`; `engine.createLineSplitter` |
| Write events in Timon's vocabulary | `events.systemInitEvent`, `assistantTextEvent`, `assistantThinkingEvent`, `toolUseEvent`, `toolResultEvent`, `resultSuccessEvent`, `resultErrorEvent`, `assistantDeltaEvent`, `providerRetryEvent`, `extractInitSessionId` |
| Say your CLI is retrying a request on its own | `events.providerRetryEvent({ attempt, max, cause, delayMs, status })` — one per attempt, never a `result` |
| Read a stream-json CLI | `streamJson.partialTextDelta`, `streamJsonUser` |
| Speak ACP (JSON-RPC over stdio) | `rpc.*`, and `acp.AcpTransport`, `AcpSessionDriver`, `AcpEventMapper` |
| Describe an ACP agent as data | `acp.defineProvider(ctx.provider, { id, args, binary, signIn?, modelProbe? })`: `signIn` is the command your agent's own CLI offers when it asks to sign in; `modelProbe: 'session-new'` lists the models by asking the agent itself (`session/new`, through your declared program, cached 12 h, because each probe leaves an empty session in the agent's own history) |
| Ask an ACP agent something of your own | `acp.transportOver(await ctx.provider.binary.converse(name, args))` — the protocol client over a conversation Timon opened; `acp.discoverModels({ open, command, profileId })` is the model probe on its own |
| Report a usage limit the way Timon reads it | `events.resultErrorEvent({ error, apiErrorStatus: 429 })`; `limits.rateLimitFromEvent` tells you what Timon will conclude |
| Report the account's consumption | `usage.usageWindow`, `percentOf`, `accountUsage`, and `usage.UsageNotSignedInError` when nobody is signed in |
| Declare Timon's MCP servers to your CLI | `mcp.serializeMcpJson`, `serializeCodexMcpToml`, `serializeGrokMcpToml`, `serializeAcpMcpServers` |
| Map `permission_mode` to a sandbox level | `permissions.sandboxLevelForPermissionMode` |
| Read a model list | `models.modelIdsFromList`, `modelIdsFromSessionNew`, `normalizeDiscoveredModels` |
| Check your own declarations | `check.dialectProblems`, `check.definitionProblems` |

Build your dialect from the runtime in a factory that `apply` calls, so that a test
hands it the same object:

```js
export function createAcmeDialect(runtime) {
  const { events, jsonLines } = runtime
  return { /* … */ parseLine: (line) => { const row = jsonLines.parseJsonObjectLine(line); /* … */ }, extractSessionId: events.extractInitSessionId }
}
export function apply(ctx) {
  ctx.backends.registerDialect('acme', createAcmeDialect(ctx.provider.runtime))
}
```

Recognise errors by their `code` (`usage.isUsageNotSignedInError`), never with
`instanceof`: the stand-in ctx of your tests carries a different copy of the class.
**Secret redaction is Timon's**: it is applied to what your provider emits; if you
want to mask something yourself, `ctx.provider.redact.text(...)` is the daemon's own
filter.

### Services of the daemon

Things your provider needs and must not rebuild, because they involve a privilege
only Timon holds:

| Service | What it gives you |
| --- | --- |
| `ctx.provider.mcp(spawn)` | Timon's MCP servers for the mission being launched (`timon`, the forms server, the project's `grepai` and browser, then the agent's own), neutral, plus the tools every agent may call without a card and the commands no agent may run. Serialize them with `runtime.mcp.*`. |
| `ctx.provider.env(spawn)` | The base environment of the mission's process (system variables, identity pointers, the variables you declared `passthroughEnv`). |
| `ctx.provider.scratch.mission(spawn)` | A private folder for this mission: `writeFile`, `link`, `resolve`, `has`, `remove`. Paths stay inside the folder; files are written 0600. It outlives a stopped or killed mission, which can still be resumed, so a CLI may keep its session store there; it is removed on a backend switch, or once the mission has been finished for the retention (30 days by default). |
| `ctx.provider.binary` | `resolve`, `version`, `probe`, `serve` and `converse` for the programs your manifest declares (`provider.binaries`) — and only those. `converse` asks a question over the program's pipes (a JSON-RPC exchange on stdin / stdout, as a CLI's `--acp` mode does) with a deadline of 20 s by default, 60 s at most, and stops the process when it is over. |
| `ctx.provider.media` | `adopt` the pictures your CLI wrote into a turn (`adoptSync` when you must answer at once, as the hook that completes a turn's result does); `allowShow` a folder to the agent. |
| `ctx.provider.git.writableRoots(cwd)` | The folders a sandboxed CLI has to be allowed to write for `git commit` to work in `cwd` (the git directory, the common one, the main working tree of a linked worktree). Timon runs `git` for you. |
| `ctx.provider.account.of(profile)` | The subscription account a launch runs on, for a provider that declared `accounts`. |
| `ctx.provider.osCredentials.read(service, account?)` | One entry of the macOS keychain, read-only, **only** if your manifest lists it in `provider.osCredentials` (the install sheet says so). |
| `ctx.provider.osCredentials.invalidate(service, account?)` | Forget a cached miss after a login or explicit usage refresh, for an entry the manifest declared. No credential is changed. |
| `ctx.provider.modelReasoning(profile, model)` | The controls of a custom profile’s model, resolved by Timon’s catalogue. The profile must belong to this provider. |
| `ctx.provider.redact` | Timon's own redaction, `text` and `deep`. |

`runtime.mcp.scriptPaths(root, overrides?)` resolves the two bundled MCP scripts.
The MCP plan also supplies excluded connector names as `excludedServers` so the
provider can apply its CLI’s exclusion syntax without reading other server data.

Three helpers are kept for the providers shipped with Timon and refused to an
installed plugin: `ctx.provider.credentialStore`, `ctx.router(prefix)` for a legacy
`/api/backends/<name>` route, and `ctx.provider.registerProductProfile`. Use your
plugin's own secret settings and its normal router prefix. Any HTTP handler you
register must declare its authentication and must never return a credential value.

**Your provider never holds the mission's token.** `mcp()` returns the identity as a
*reference* (`timon-seal-…`) and Timon swaps it for the real value where the data
reaches your CLI's MCP servers: the stdin payload of the launch, the session's pipe, and
files you write with `scratch`. Put the reference where the token belongs and it works.
A reference found on the **command line** or in the process **environment** fails the
launch — any account can read a process list, and every program your CLI starts, the
shell the model drives included, inherits its environment — so write the configuration
to a scratch file and pass its path instead. The same goes for every value of the
user's own MCP servers.

### Register a provider, not just a dialect

`ctx.provider.registerProvider(definition)` takes a `ProviderDefinition`: a transport
(`stdio-persistent`, `process-per-turn`, `remote`), a codec (`lines` or `driver`), the
strategies (`session`, `permission`, `limits`, `mcp`, `usage`, `models`, `reasoning`,
`lifecycle`), a `launch` function for a provider that owns a process, and
`declares` — what the rest of Timon reads about it instead of asking its name:

| `declares.` | Read by |
| --- | --- |
| `binary` — names, install plan per OS (`none` is an honest blank), folders to search (`~`, `${VARIABLE}`; `A\|B` lists alternatives, the first one that can be expanded wins), desktop-app builds | the host adapter: finding the program, installing it. The providers shipped with Timon are declared the same way |
| `credentialDirs` — folders (relative to the home) holding the CLI's sign-in; also listed in your manifest as `provider.credentialDirs` | missions of **other** backends cannot read them; the install screen shows them. Never `.ssh`, `.aws`, `.config`… (the user's own credential stores, their parents, bare containers) nor another built-in backend's folder |
| `passthroughEnv` — non-secret variables the CLI needs (its home or config folder) | copied into the process; a name that reads like a credential is refused |
| `modelCache` — `{ slugs(), levels() }`, two synchronous readers of the models the CLI lists for the signed-in account | the model catalogue (the profile's own list serves when they return `null`) |
| `protocols` — `'anthropic'`, `'openai-responses'` | the *Add a provider* form: an endpoint that speaks that protocol is reached through your CLI (only for a provider shipped with Timon) |
| `oneShot`, `authStatus` | the daemon's own tasks (the first active provider that declares `oneShot` is also the default backend), the sign-in status |
| `spans` — `'stream-json'` or a function | the trace |
| `accounts` — how the CLI signs in | several subscription accounts, signed in from the browser |
| `brand` — an inline SVG | the logo of the backend |

What a provider launches is checked again at **launch**, not only at registration: the program your `launch` returns must not be `claude`, `codex`, `timon`, a shell or an interpreter (`sh`, `node`, `python`, `env`…), whatever your manifest declares — ship your own binary or script. A provider that wants `node` runs a program of its own that starts it.

A definition is **checked before it is registered**: a capability declared without the
member that serves it (`permission.model: 'protocol'` without a session driver, `setModel`
on a process per turn, a persistent process whose session cannot be resumed…) is refused,
naming both. `binary.names` must be among your manifest's `provider.binaries`, and the
operator authorizes those at install. `ctx.provider.replaceProvider(definition)` swaps in
a new version in one step: the old one serves until the new is in place, a running mission
keeps what it holds, and a change of transport or session store is refused.

The older way — `registerDialect` with a `Dialect` — keeps working and is deprecated for
new providers.


### An ACP agent in one row

For an agent that speaks the Agent Client Protocol, `acp.defineProvider` turns one
row of data into a complete definition: the persistent process, the session
driver, the permission round trip through the Allow/Deny card, the event
mapping, and the MCP servers handed to `session/new`. Everything that is the
agent's own goes in the row. This is the whole of the
[Cursor template](examples.md#provider-cursor) apart from its profile:

```js
const ACME = Object.freeze({
  id: 'acme',
  args: ['acp'],                    // the arguments that put the program in ACP mode
  permissionsByAgent: false,        // Timon arbitrates tool uses; true if the agent decides alone
  modelProbe: 'session-new',        // ask the agent which models the account has
  authenticateWith: 'acme_login',   // tried ONCE, only after the agent answers auth_required
  signIn: { byMethod: { acme_login: 'run `acme login` in a terminal, then retry' }, fallback: 'run `acme login`, then retry' },
  binary: { names: ['acme-agent'] },
  declares: { credentialDirs: ['.acme'] },
})

export function apply(ctx) {
  ctx.provider.registerProvider(ctx.provider.runtime.acp.defineProvider(ctx.provider, ACME))
  ctx.backends.registerProfile({
    id: 'acme', dialect: 'acme', label: 'Acme', requiredBinary: 'acme-agent', models: [], defaultModel: null,
  })
}
```

The profile's `dialect` is the provider's `id`. `signIn` is the sentence the user
reads when the agent asks to sign in. `authenticateWith` must name a method the
agent announced, and is never tried ahead of time because a method can open a
browser. `modelProbe` costs an empty session in the agent's own history; Timon
caches the answer for 12 hours.

An agent that decides its tool uses alone (`permissionsByAgent: true`) never
asks Timon, so Timon cannot refuse anything to it. When Timon runs one of its
own short prompts on it (a compaction summary, a conversation title, a memory
pass), the conversation it reads may carry instructions written by a third
party. Give such an agent `oneShotEnv`: environment variables added to those
launches only, never to a mission, that switch off its tools. A value that
depends on the launch goes in `env(spawn)`, which sees `spawn.oneShot`.
opencode's row sets `OPENCODE_DISABLE_PROJECT_CONFIG`, so that opencode loads
no MCP server or plugin from the project, and builds an `OPENCODE_CONFIG_CONTENT`
that denies every tool but reading. Whatever such a launch keeps from a project
file is data a mission could have written: opencode's row carries only model
names and an address on this machine.

#### The agent's own questions and plans

Some agents send requests of their own outside the protocol and wait for the
answer: Cursor asks multiple-choice questions (`cursor/ask_question`) and submits
plans for approval (`cursor/create_plan`). Timon answers any request it does not
know with "method not found". To answer one, list it in `extensionRequests` and
translate it, both ways, with the cards Timon lends you:

```js
extensionRequests: {
  'acme/ask': async (params, cards) => {
    const got = await cards.ask(
      [{ id: 'q1', question: params.prompt, options: params.choices.map((c) => ({ id: c.key, label: c.text })) }],
      { id: params.callId },
    )
    if (got.outcome === 'answered') return { status: 'ok', keys: got.value.q1.selected }
    return got.outcome === 'cancelled' ? { status: 'cancelled' } : { status: 'skipped', reason: got.reason }
  },
  'acme/plan': async (params, cards) => {
    const got = await cards.approvePlan({ title: params.name, plan: params.body, steps: params.steps })
    if (got.outcome !== 'answered') return { status: 'rejected', reason: got.outcome === 'unanswered' ? got.reason : 'cancelled' }
    return got.value.approved ? { status: 'accepted' } : { status: 'rejected', reason: got.value.note ?? 'rejected' }
  },
},
```

- `cards.ask(questions, { id })` opens the same form as the `question` tool: 1 to 4
  questions, each with 2 to 4 options or none for a free-text answer. Use the
  agent's own ids for questions and options: the answer comes back by question id,
  as the ids of the options picked plus any text the person typed (`text`, or
  `null`).
- `cards.approvePlan({ title, plan, steps }, { id })` shows the plan, line breaks
  kept, with two choices — approve or reject — and a field for a remark. You get
  `{ approved, note }`.
- Every card ends one of three ways: `answered`; `unanswered`, with a sentence
  written for the agent (the person closed the card, or the mission runs unattended
  and must not ask a person — the sentence says who to ask instead); or `cancelled`
  (the turn was stopped). Answer the agent in every case, in its own shape.
- What your handler returns is the reply the agent receives. If it throws, the
  agent gets a generic error, never your message. `params` comes from the agent:
  check it before you use it.
- The protocol's own methods (`session/…`, `fs/…`, `terminal/…`, `initialize`,
  `authenticate`) cannot be taken over.



### Say what you have not verified

If you wrote your provider from the vendor's documentation, without the real
program, say so. `declares.unverified` lists what you have not seen work, each with
one sentence (200 characters at most):

```js
declares: {
  unverified: [
    { subject: 'mcp', note: "Timon's tools are declared through the session; the vendor documents only its own config file." },
    { subject: 'extension-requests', note: 'Built from the documented shapes; never answered by the real agent.' },
  ],
},
```

The subjects are `session`, `mcp`, `permissions`, `sign-in`, `models`,
`extension-requests`, `credential-dirs` and `binary-identity`, each at most once.
The person choosing a model sees an **Unverified** chip next to your provider, with
your sentences on hover. Remove an entry once a recorded session proves it.

### Capabilities are promises

A provider that promises something it cannot do fails mid-mission, far from you.
Timon refuses it up front instead, in two ways.

**A declaration needs the member that serves it.** `registerProvider` checks the
definition before accepting it and names both sides of a contradiction. Among
others:

- `permission.model: 'protocol'` without a session driver (`codec: driver`);
- `permission.byAgent` on anything but a session protocol, and `permission.appliesMode` on anything but a session protocol whose agent asks;
- `session.setModel` on a process per turn, where there is no live process to switch;
- `session.compact` without a non-empty `command`;
- a persistent process whose session is not resumable;
- `codec: driver` on a process per turn, or `codec: lines` on a remote provider;
- a provider that owns a process without a name in `declares.binary.names`, or a
  name that is not in your manifest's `provider.binaries`;
- `declares.spans` and a top-level `spans` at the same time.

`ctx.provider.runtime.check.definitionProblems(definition)` returns the same
sentences, so a test of yours can assert that the list is empty.

**Say what your agent cannot do.** An agent that runs somewhere else (a remote
gateway, a hosted service) sees neither the Timon folder nor the files a user
joins in the chat. Say so, and Timon respects it instead of failing later. In a
definition, `declares.capabilities`; on a dialect or a profile, `capabilities`.
Requires `"apiVersion": 7`; an older Timon ignores the key.

```js
ctx.provider.registerProvider({
  // …
  declares: { capabilities: { worktree: false, timonMcp: false, attachments: false, timonPreamble: false } },
})
```

| Capability | `false` means | What Timon does |
| --- | --- | --- |
| `worktree` | The agent does not work in Timon's folder. | A `code` or `merge` task assigned to it is blocked with a readable reason; the LLM pickers show it as **Remote**. |
| `timonMcp` | Timon's tools (Kanban, messages, memory) do not reach the agent. | Timon's MCP servers are not declared to the agent (`BuildSpawnOpts.timonMcp` is `false`, which your own launch can read). Listed among the backend's limits in the pickers and on the agent sheet. The skills catalogue does not mention `skill_get`. |
| `attachments` | No attached files other than images: the agent cannot open a path on Timon's disk. | The chat's attach button is disabled with an explanation, and a turn carrying files is refused before anything is saved. The skills catalogue does not mention a skill's file. With `timonMcp` also `false`, the agent has no way to read a skill on demand, so catalogue skills are pasted whole into its prompt, followed by the text files next to their `SKILL.md` (64 KB per skill); with `timonMcp`, those files are read with `skill_get` and its `file` argument. |
| `timonPreamble` | The agent brings its own identity and runs elsewhere: Timon's folders and tools mean nothing to it. | The system prompt Timon sends starts at the agent's own prompt (soul, role, system prompt, memory); the Timon runtime preamble and its "your backend" block are left out. Not shown as a limit. |

A key you leave out counts as `true`, so a backend that declares nothing keeps
working as before. A profile can only narrow its provider, never give back what
the provider declared it cannot do. An unknown key or a value that is not a
boolean is refused at registration. Declare a limit you are unsure about as
`false`: an honest "no" is better than a task that dies.

### Report the account's usage

If your CLI is signed in to a subscription with a quota, give Timon its
consumption and the usage gauge of the interface shows it. Add a `usage`
strategy (`accountUsage` on a dialect) that answers with an `AccountUsage`:

```js
const { usage } = ctx.provider.runtime
// …in the definition:
usage: {
  async probe(profile) {
    const quota = await readQuota()               // however your CLI exposes it
    if (quota === undefined) return null          // unknown is null, never zero
    return usage.accountUsage({
      five_hour: usage.usageWindow(quota.fiveHourPercent, quota.fiveHourResetsAt),
      weekly: usage.usageWindow(usage.percentOf(quota.weeklyUsed, quota.weeklyLimit), quota.weeklyResetsAt),
    })
  },
},
```

`probe` receives a second argument, `options`. `options.force` is `true` when a
person pressed the refresh button of the gauge: if your probe caches its answer
(and it should, a usage endpoint rarely likes to be polled), skip the cache,
a cached failure included. Timon only sets it on an explicit refresh, at most
once every few seconds per provider.

The four rules the helpers make easy, and the bench checks:

- `utilization` is a **percentage between 0 and 100**, not a 0..1 ratio. `usageWindow`
  returns `null` for a value outside that range, and `percentOf(used, limit)` clamps
  and returns `null` without a usable limit.
- `resets_at` is an **ISO 8601 instant**. `usageWindow` accepts a `Date`, an ISO
  string or epoch **milliseconds**; multiply epoch seconds first.
- **Unknown is `null`.** A window you cannot state is `null`; a probe that cannot
  answer at all resolves `null`. A zero would be drawn as an empty gauge, which
  tells the user they have a full quota.
- `extra` (billed overage past the subscription) is `null` when the provider has
  none; `accountUsage()` fills it for you. The names of `windows` are yours
  (`five_hour`, `weekly`…); the interface shows what it gets.

The probe receives the profile: return `null` when it does not apply, for example
a third-party endpoint behind the same CLI, which has no such quota. When nobody
is signed in, reject with `new usage.UsageNotSignedInError('…')` rather than a
generic error, so the interface can say "sign in" instead of "failed". Recognise
it with `usage.isUsageNotSignedInError(error)`, which reads its `code`, never with
`instanceof`: your tests run on a different copy of the class. Never put a
credential in an error message.

In the conformance bench, pass `checkUsage: true` after faking what the probe talks
to; it asserts a well-formed gauge, `null`, or the typed "not signed in" error.
`usage.accountUsageProblems(gauge)` is available for your own assertions. A
provider with no documented quota (Cursor, for one) simply has no `usage` strategy.


## The older way: a dialect

Before API 12, a provider was a `Dialect`: a launch line and a line parser registered
with `registerDialect`. It keeps working and is **deprecated for new providers**, which
should use [a provider definition](#build-a-provider-on-the-engine). Read this section
if you maintain a dialect or need the exact member contract.

A dialect describes how to speak to a CLI. It is justified when the CLI's
launch arguments, input or output protocol differ from existing dialects;
a different API endpoint or model list alone does not require one.

Import `Dialect` from the SDK. Register it with
`ctx.backends.registerDialect('acme-cli', dialect)`, then register a profile
whose `dialect` is `acme-cli`. The returned disposers allow early cleanup;
registrations are also removed automatically when the plugin unloads.

Set `dialect.id` to the identifier passed to `registerDialect`. For backward
compatibility, existing JavaScript plugins without `id` still register and
work, but emit a deprecation warning. A mismatched `id` also emits a warning
while registration continues under the identifier passed to `registerDialect`;
Timon does not rewrite the dialect object. Omission is deprecated; new plugins
should always supply matching identifiers.

The daemon **launches the process**. A dialect returns a spawn description;
it does not start its own process. A plugin-selected executable is checked
against the operator's `pluginPolicy.exec.allow`. Reusing a built-in dialect's
binary does not add an executable to that policy.

The required `Dialect` members are:

| Member | Contract |
| --- | --- |
| `id`, `defaultCmd` | Dialect identifier and default executable. |
| `persistentProcess`, `finishMissionOnExit` | Process lifetime and whether exit ends the mission. A one-shot process must leave the mission alive. |
| `sessionResumable`, `sessionStore` | Resume support and `global` or `per-mission` session storage. |
| `permissionModel` | `mcp-bridge`, `sandbox` or `none`, matching the CLI's actual tool controls. |
| `rateLimitReporting` | `structured`, `textual` or `none`, matching observable limit signals. |
| `hostedConnectors` | Whether the CLI supplies hosted account connectors. |
| `buildSpawn(opts, profile)` | Async function returning `cmd`, `args`, `initialStdin` and optional `env`/`cwd`. Use the resolved profile environment. |
| `writeUserInput(proc, text, images?)` | Write another turn to persistent stdin; a one-shot implementation does nothing. |
| `parseLine(line)` | Return normalized events; unusable lines produce `[]`, never an exception. |
| `extractSessionId(event)` | Return a non-empty session ID from `system:init`, otherwise `null`. |

Optional hooks include usage reporting, model discovery, trace spans, model
switching, session error detection and disposal; see
[Dialect](api-reference/interfaces/Dialect.md). `discoverModels(profile)`
returns the model IDs the CLI itself offers for the signed-in account (or
`{ slug, supportedReasoningLevels }` objects, when the CLI declares thinking
levels per model), when the
provider has no public model listing to put in `modelsEndpoint`; it rejects
when the CLI cannot tell, and Timon keeps the profile's `models` meanwhile.
Returning objects requires `"apiVersion": 6` in the manifest: an older Timon
reads every entry as a model ID, so a plugin that must also run there returns
plain strings.
Each model of the catalogue Timon serves also carries `reasoning`
([ModelReasoning](api-reference/type-aliases/ModelReasoning.md)): how its
thinking is set (`levels`, `budget` or `toggle`) and where that comes from —
the profile's own `supportedReasoningLevels`, the levels your dialect
discovered (or that an Anthropic endpoint reported, `reportedReasoningLevels`),
or, for custom providers only, the models.dev catalogue built into Timon. A
source that reports an empty list of levels is still an answer: the catalogue
does not override it, and `controls` is empty. An empty
`supportedReasoningLevels` counts as nothing declared. It is computed, not declared: keep declaring levels with
`supportedReasoningLevels`, which Timon never overwrites. What levels cannot
say is declared with `reasoningControl`
([DeclaredReasoningControl](api-reference/type-aliases/DeclaredReasoningControl.md)):
`{ "type": "budget", "max": 16000 }`, `{ "type": "toggle" }` or
`{ "type": "none" }` for a model that does not think. Declared levels win when
a model carries both. A dialect that can send a budget or a switch, and not
only a level, says so with `thinkingControls` (for example
`["levels", "budget", "toggle"]`); without it, Timon offers only levels for
the custom providers that use your dialect.
Set `maxPromptBytes` if the CLI has a prompt size limit. The
[echo template](examples.md#provider) illustrates the protocol, not a working
AI provider or the operating system's `echo` command.

## Test your provider with the conformance bench

`@timon-ai/sdk/testing` ([reference](api-reference/testing/index.md)) is the suite Timon runs on its own providers. Take the SDK
from your developer distribution (see the [overview](overview.md)) and add it to
your plugin's development dependencies. **Record one turn of the real CLI** as a
`.jsonl` file (its raw stdout, before any normalization), and bind your dialect:

```js
import { test } from 'node:test'
import { createProviderContext, defineConformanceTests, dialectConformance, loadTranscript } from '@timon-ai/sdk/testing'
import { apply } from '../lib/index.js'

// Run your plugin's own `apply` against the stand-in ctx, and test what it registered.
const ctx = createProviderContext({ settings: { apiKey: 'a-key-for-tests' } })
apply(ctx)

defineConformanceTests(test, dialectConformance(
  ctx.registered.dialect('acme'),
  { id: 'acme-llm', env: { ACME_API_KEY: 'a-key-for-tests' } },
  {
    transcript: loadTranscript('test/fixtures/turn.jsonl'),
    sessionId: 'the-session-id-in-that-recording',
    cmd: 'acme', model: 'acme-1', envKeys: ['ACME_API_KEY'],
  },
  { cwd: process.cwd() },
))
```

`createProviderContext` runs the daemon's own registration check, answers `ctx.provider.mcp()` and
`env()` with a reference and no secret, gives `scratch` a temporary folder (`ctx.cleanup()` removes
it), and lets you declare the programs, keychain entries and secrets your provider meets
(`binaries`, `osCredentials`, `secrets`). A provider registered with `registerProvider` is
recorded too, and `ctx.registered.dialect(id)` gives the form the bench takes.

No CLI is started, no account is used, nothing leaves the machine. The bench
checks, among others:

- the declarations agree with each other (what registration enforces);
- `buildSpawn`, fresh and resumed: the binary, string arguments, working
  directory and environment; the model, system prompt and message reach argv,
  stdin or a generated file (list the directories you write into as
  `scratchDirs`); the session id is passed on resume;
- the argument ceiling: with `maxPromptBytes` declared, a multibyte prompt at the
  limit stays under Linux's 131,072-byte argument limit; without it, the prompt
  must not travel in argv;
- `initialStdin` and `writeUserInput` agree with `persistentProcess`; a one-shot
  process declares `finishMissionOnExit: false`;
- `parseLine` turns the recording into the normalized vocabulary with exactly one
  `system:init`, results that say whether they failed, events that serialize;
  non-JSON lines give `[]`; **no line, however malformed, makes it throw**;
- on a persistent process, no `assistant` event after the `result`;
- `extractSessionId` reads the init and nothing else, never throws, never
  invents an id;
- a **replay**: the recording is fed to the engine the daemon runs, whole, line by
  line, one byte at a time (a multibyte character split across chunks) and with
  Windows line endings, and through a real process (a fake CLI); the events must
  equal what `parseLine` gives;
- `dispose` with no state on disk; the account gauge, when you pass
  `checkUsage: true` after faking what the probe talks to.

Add your own checks to the same file for what only you know: the arguments of a
tool call, your CLI's error messages, the usage-limit signal (`resultErrorEvent`
with an `apiErrorStatus` is read by `rateLimitFromEvent`). Separately exercise
unload, missing credentials and executable-policy refusal on a test installation
before distributing the plugin.

### Test an ACP provider: a recorded session

An ACP agent is a conversation, not a stream, so a transcript cannot carry it. Record the agent's side of one session as a
script — one JSON object per line, keyed by the request that triggers it — and play it with the same SDK:

```
{"on":"initialize","reply":{"protocolVersion":1,"agentCapabilities":{},"authMethods":[]}}
{"on":"session/new","reply":{"sessionId":"abc"}}
{"on":"session/prompt","send":[{"method":"session/update","params":{…}}],"reply":{"stopReason":"end_turn"}}
```

`send` is what the agent writes before it answers; an item with an `id` is a request to Timon (a permission question), and the
peer waits for the answer. `loadAcpScript` reads the file, `createAcpReplayPeer(script)` is the scripted agent over in-memory
pipes (`answer(id)` shows what Timon replied, `conversation()` serves it to the model probe), and `acpSessionChecks(provider,
expectation, { cwd })` runs the checks: launch line, the session and the MCP servers it declares, a turn, the permission round
trip, the sign-in message, and the agent's own requests (`extensions`: the request's `id` in the script, what the person
answers on the card, the reply the agent must get, and `unanswered`, the reply when nobody can be asked). The Cursor template (`examples/plugin-provider-cursor`, see the [cookbook](examples.md#provider-cursor))
is the worked example. **Record the script from the real agent**; a script written from its documentation proves only that
your provider speaks the protocol as documented.

## Drive a remote agent with no local process

For an agent reached over the network (an HTTP or WebSocket API) rather than a
CLI on the daemon's machine, register a **remote dialect**. It requires
`"apiVersion": 7` and the `backends:register` permission. Nothing is spawned,
so no `pluginPolicy.exec.allow` entry is needed; the driver reaches its agent
with `ctx.fetch`, which needs `http:outbound` and a host the operator allows in
`pluginPolicy.http.allow`, or for your plugin alone in `pluginPolicy.http.byPlugin`.

Import `RemoteDialect` from the SDK. It declares `transport: 'remote'`, the
same `sessionResumable`, `sessionStore`, `permissionModel`,
`rateLimitReporting`, `hostedConnectors` and `extractSessionId` members as a
process dialect, and `openSession(args)` instead of `defaultCmd`,
`buildSpawn` and `parseLine`. Register a profile on it as for any dialect: its
`env` function runs at every mission launch, and its result is handed to the
driver.

`openSession({ spawn, host, env, profileId, launch })` returns a `SessionDriver`.
`launch` is the same context the profile's `env` function received for this
launch (see [Know who launches the mission](#know-who-launches-the-mission)):

| Member | Contract |
| --- | --- |
| `start()` | Open, or reopen with `spawn.resumeSession`, the remote session and emit the `system:init` carrying its ID. Nothing goes on the network before it; its rejection message is shown in the mission. |
| `prompt(text, images?)` | Run one turn. Emit its events, `result` included, before resolving. A rejection ends the mission as failed, with its message. |
| `cancel()` | Stop the running turn (the chat's stop button). `prompt` resolves with `cancelled`; the session goes on. |
| `steer(text)` | Optional. Redirect the turn that is running: resolve `true` when the agent took the instruction, `false` when there is no running turn. Leave it out when the agent cannot be steered: Timon then refuses a steer request instead of queueing it as the next turn. |
| `close()` | Stop everything. Pending calls reject; nothing is emitted afterwards. Cancel the remote run here. |
| `info` | `null` until `start()` resolved, then the session ID and capabilities. |

`env` is the profile's environment for this launch: read the address and key
there, never from `process.env`, and never log them. `host.emit(event)` takes
the normalized events (`system`, `assistant`, `assistant_delta`, `user`,
`result`); `host.requestPermission(request)` shows an Allow/Deny card when the
dialect declares `permissionModel: 'protocol'`. If your agent remembers an
approval, list the wider answers it understands in `request.scopes`
(`'session'`, `'always'`): the card then offers them next to Allow, and the
answer carries `scope` back with `allow: true`. A scope you did not list is
never returned. When the agent closes the
session itself with no turn running, call `host.end({ reason })`:
`completed` completes the mission, `failed` (with a `message` the user reads)
fails it, `cancelled` stops it without counting as a failure.

Timon runs the mission like any other: events in the thread, permission cards,
the stop button, idle and stuck-turn cleanup, the mission's report. A remote
mission has no worktree and does not receive Timon's MCP tools. The daemon's
own one-shot prompts for such an agent (mission summaries, dreaming, memory
capture) run on the default local backend instead, with that backend's default
model. Test the
driver with an in-memory agent: a complete turn, a cancelled turn, a readable
failure, and `close()` during a turn. The
[remote backend template](examples.md#remote-backend) is such an agent.

### Survive a daemon restart

The remote agent keeps working while Timon restarts. To have Timon pick the
mission up again instead of ending it, save a small resume state right after
each event you emit, and once in `start()`:

```js
host.emit(event)
host.saveResume({ runId, sessionId, lastSeq })
```

The state is a plain JSON object of at most 4096 bytes, and it must never hold
a credential: the key comes back through `env` at every launch, and a state
that contains it is refused. When Timon starts again, it reopens every mission
that left a state: `openSession` receives `resume: { state, turnActive }`.
`start()` reconnects to that run without sending any prompt again; when
`turnActive` is true, the driver then emits what Timon missed since `lastSeq`,
the turn's `result` included, and the turn ends normally. If the state is no
longer usable, reject `start()` with a readable message: the mission ends as
failed with that message, and its task is held for a person rather than
started again. `close()` is still a stop: a daemon that shuts down calls
nothing, which is what leaves the run alive.

Test the driver with an in-memory agent. `remoteProviderChecks` of
`@timon-ai/sdk/testing` plays a complete turn, a cancelled turn, a readable
failure, `close()` during a turn and a reconnection from a saved state, against a
host that applies the daemon's own rules (a resume state naming a credential is
refused). Give it three profiles of your dialect: a normal one, a slow one and a
failing one. The [remote backend template](examples.md#remote-backend) is such
an agent, with its test.


## Pitfalls

Each of these was met by a provider that now ships, or by a tester. The first list
applies to any provider; the sections after it are what each CLI taught.

### Any provider

- **A line never throws.** `parseLine` returns `[]` for anything it cannot use:
  blank lines, banners, a half-written JSON object. The bench feeds it malformed
  input on purpose. A throw that escapes ends the stream of the whole mission.
- **Chunks are not lines.** A multibyte character can be split between two reads
  and Windows sends `\r\n`. Use `engine.createLineSplitter`; do not split on `\n`
  yourself.
- **Stop can arrive before the turn has begun.** A cancel that finds no running
  turn must not hang the next one: end the turn as cancelled, not as a failure.
- **A failed turn leaves nothing open.** Emit a `result` that says it failed
  (`events.resultErrorEvent`), and stop whatever the turn started. Work the CLI
  launches after the turn ends (a watcher, a sub-agent) is yours to close in
  `dispose`.
- **Nothing from the agent after the `result`.** On a process that outlives its
  turn, an `assistant` event after a `result` means your CLI went back to work by
  itself, and Timon opens a new turn. Put a turn's last words before its `result`,
  or the mission shows as working on a turn nobody is running until it is stopped
  as hung.
- **A retry is not a failure.** When your CLI retries a request on its own (dropped
  stream, closed websocket, 5xx, overloaded), emit `events.providerRetryEvent` for each
  attempt and keep the turn open: the chat shows a single "retrying (2/5)" line, and
  the agent waiting on the answer keeps waiting. Emit the failed `result` only once the
  CLI gives up.
- **A usage limit is not an error.** Report it with
  `events.resultErrorEvent({ error, apiErrorStatus: 429 })` and put the reopening
  time in the message; `limits.rateLimitFromEvent` shows what Timon will conclude.
  A status buried in the CLI's error list (a `402` for billing) must still reach
  `apiErrorStatus`, or the fallback never starts.
- **`default` is a sentinel in some CLIs.** If "default" means "let the CLI choose
  its model", leave the model flag out instead of passing the word.
- **Paths can be symlinks.** `/tmp` and `/var` on macOS resolve into `/private`;
  compare resolved paths, never prefixes, and build every path with `node:path`.
- **A long prompt does not belong on the command line.** Windows caps it at 32,767
  characters, Linux's argument limit is 131,072 bytes per argument. Use stdin or a
  file in `scratch`; declare `maxPromptBytes` if the prompt must travel in argv.
- **No secret on the command line or in the environment of a CLI.** A
  `timon-seal-…` reference found there fails the launch, because every program the
  CLI starts, the shell the model drives included, inherits it. Write a
  configuration file with `scratch.writeFile` and pass its path.
- **Your process gets only what you list.** The environment comes from
  `ctx.provider.env(spawn)` plus the names in `passthroughEnv`. If your CLI falls
  back to an API key it finds in its environment, make sure `launch` does not
  hand it one the user did not choose: Timon runs on subscriptions, not on an API
  billed per token.
- **On Windows, an npm-installed CLI is a `.cmd` shim.** Resolve and start it
  through `ctx.provider.binary`, never with a hand-written `spawn`. The bench's
  fake CLI writes a shim on Windows so you can test this.
- **A copy of a credential file does not follow a token refresh.** If you give a
  CLI a copy of its `auth.json` in a private folder, the CLI may refresh the token
  in the copy only. Prefer `scratch.link` (symlink, then hard link, then copy; a
  symlink needs a privilege on Windows) and re-link when the account changes.

### Claude Code

- Stream JSON in both directions over a persistent process; the first user
  message goes in on stdin, with content blocks for images.
- The system prompt goes in a file (`--append-system-prompt-file`), not on the
  command line. Permissions come through an injected MCP tool
  (`mcp-bridge`) that asks Timon before each tool use that is not pre-approved.
- The conversation lives in the CLI's home (`global`) and resumes with
  `--resume`; the CLI's stderr says when the session is gone.
- On macOS the sign-in is in the keychain: declare the entry in
  `provider.osCredentials`. A background service cannot read it, which is why a
  long-lived token (`timon auth claude-token set`) exists.
- A custom endpoint sets thinking by environment variables (budget or switch), not
  by `--effort`; declare `reasoning.controls` accordingly (`thinkingControls` on a dialect).

### Codex

- One process per turn (`codex exec --json`), with the prompt on stdin and images
  as `-i <file>`. The session lives in a per-mission home that outlives the
  process, a killed mission included: `codex exec resume` finds the thread again,
  so declare `resumable: true` with a `notFound` for a purged rollout.
- Permissions are a sandbox frozen at launch (`read-only`, `workspace-write`,
  `danger-full-access`). `git commit` inside a sandboxed worktree needs the git
  directories writable: ask `ctx.provider.git.writableRoots(cwd)`; you cannot run
  `git` yourself.
- MCP servers go in the mission's `config.toml`. The mission token reaches them by
  **name** (`env_vars = ["TIMON_API_TOKEN"]`), never as a value in the file:
  `serializeCodexMcpToml(servers, { forward })`.
- On Windows the sandbox needs `sandbox = "unelevated"`, and linking `auth.json`
  can fail without a privilege (see the credential note above).
- Pictures from an image tool arrive as files at the end of the turn: adopt them
  with `ctx.provider.media.adoptSync` from the synchronous completion hook.
- A custom Responses endpoint is declared in `config.toml` with
  `wire_api = "responses"`; `"chat"` makes the file fail to load, and a provider id
  that redeclares one of the CLI's built-ins (`openai`, `ollama`) is refused.

### Grok and Copilot

- Both run one process per turn and resume by id. Grok's stream is the same
  vocabulary as Claude's; Copilot prints the session id only in its final result.
- Neither can ask mid-turn, so permissions are a sandbox: Grok turns every mode
  but plan into bypass (an approval nobody can answer kills the turn) and relies
  on explicit deny rules; Copilot takes allow and deny lists of tools.
- Copilot's model list and quota come from the CLI's own protocol server, started
  on demand: use `ctx.provider.binary.converse` or `serve`, which stop the process
  and its children.

### ACP agents (opencode, Hermes, Cursor)

- **MCP servers go in `session/new`, and only stdio ones.** An agent may ignore
  them: then a mission has none of Timon's tools. Check on a real agent before
  you promise Timon's tools; the Cursor template says plainly that it is
  unverified.
- **The model probe is not free.** It opens a session that stays in the agent's
  own history. It is cached, and it runs only through the program your manifest
  declares.
- **Permission option ids differ between agents.** `allow_once` and `allow-once`
  both occur, and an option may carry no `kind`. Timon recognises both spellings;
  an agent that names its options another way needs a recorded session in your
  tests.
- **Sign-in comes as `auth_required`.** Try `authenticate` once, after that answer,
  with a method the agent announced. A method can open a browser, so never call it
  ahead of time; when it fails the user reads your `signIn` sentence.
- **Some agents replay their history when a session is loaded** (Hermes). That is
  the agent's behaviour: do not count the replayed turns as new ones.
- **A request Timon does not know is answered "method not found".** An agent that
  blocks on its own questions (Cursor's `cursor/ask_question` and
  `cursor/create_plan`) may stall: answer them with `extensionRequests`.
- **A program named `agent` is ambiguous.** Cursor's installer and Grok's both put
  an `agent` in the same folder. Declare the unambiguous name first
  (`cursor-agent`), the generic one as an alias, and an `identity` in both the
  manifest and `declares.binary`: Grok's `agent` is then refused on the
  authorization click. If the person has only the alias, launch the name that
  resolved (`ctx.provider.binary.resolve`), and put it first in `binary.names`.
- **A subcommand documented as hidden can move.** `cursor-agent acp` is absent
  from `--help`. Pin a minimum version when you can, and re-record your session
  when the agent updates.
- **Registry agents without a hash.** Roughly half of the registry publishes no
  `sha256`. Timon asks the user to confirm, and records the install as
  unverified. Do not hide this in your README.

## Before you publish

- [ ] `apiVersion: 12` (`"kind": "provider"`, `permissions: ["backends:register"]`); the definition is built by a factory that takes the runtime, so the test hands it the same object.
- [ ] `runtime.check.definitionProblems(definition)` is empty, and the conformance bench is green on **a transcript recorded from the real CLI** (or a recorded ACP session), including Windows line endings and the byte-by-byte replay.
- [ ] Every program you launch is in `provider.binaries`; every keychain entry in `provider.osCredentials`; every `declares.credentialDirs` folder in `provider.credentialDirs`. None is `.ssh`, `.aws`, `.config`, or another provider's folder.
- [ ] No secret on the command line; configuration through `scratch.writeFile`. `passthroughEnv` lists non-secret names only.
- [ ] A provider that declares `accounts` honours `ctx.provider.account.of(profile)`.
- [ ] The capabilities you cannot guarantee are declared `false`; a quota you cannot read has no `usage` strategy.
- [ ] You exercised, on a test installation, unload, a missing credential, and the refusal when the program is not yet authorized.
- [ ] You tried an update with a mission running (it waits) and an update that changes the transport (it is refused while Timon runs).
- [ ] Your README states what you recorded and what you only read in documentation.

Package, version and distribute it as any plugin: see [Publishing](publishing.md).
Whoever installs it sees the program it launches, with the path Timon found on
their machine, and ticks one box to allow exactly that program.

