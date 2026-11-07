---
title: Add a provider
sidebar_position: 9
---

You can add a language-model provider yourself — no plugin, no restart. It works for any provider that speaks one of two protocols:

| Protocol | Runs through | Typical providers |
|---|---|---|
| **Anthropic** | the Claude Code CLI | DeepSeek, Moonshot (Kimi), Z.ai, a [LiteLLM proxy](#through-a-litellm-proxy), any Anthropic-compatible gateway |
| **OpenAI Responses** | the Codex CLI | OpenRouter, a vLLM or LM Studio server, a [LiteLLM proxy](#through-a-litellm-proxy), any endpoint that serves `/v1/responses` |

If your provider speaks neither, there are three ways forward:

- **It is an agent of the [ACP registry](../plugins/providers.md#agents-from-the-acp-registry)** (opencode, Hermes, Cursor… as listed there): open **Settings → AI models → LLM backends → Providers**, pick it, and Timon downloads, checks and runs it for you. No plugin to write.
- **Someone already wrote a provider plugin for it**: install it from the Plugins gallery. The install sheet shows the program it will launch, with the path Timon found on your machine, and one tick allows exactly that program.
- **You want to share your endpoint, or write a provider yourself**: [Write a provider](../plugins/providers.md) covers sharing a declarative pack with no code, and writing a provider for a CLI, an ACP agent or a remote service.

Adding or removing a backend is reserved to a superadmin, and to a person: a backend decides where the prompts of every mission run on it are sent, so an agent is refused even when its account is a superadmin's.

## From Settings

Open **Settings → AI models → LLM backends** and choose **Add a backend**.

| Field | What to enter |
|---|---|
| **Name** | How the backend appears in the model selectors. |
| **Protocol** | Anthropic or OpenAI Responses. |
| **Base URL** | For Anthropic, the address the provider documents for `ANTHROPIC_BASE_URL`, without `/v1`. For OpenAI Responses, the address ending in `/v1`. |
| **API key** | Stored in the secrets vault, never in a file, and never shown again. Leave it empty for a local server that asks for none. |

**Test** makes one call to the provider's model listing and tells you which of these is true:

- the endpoint answers and accepts the key — the models it lists are proposed alongside the ones you entered;
- the endpoint answers but refuses the key;
- nothing answers at this address;
- the endpoint answers with another status (often `404`: it has no model listing). The key could not be checked, which does not mean it is wrong.

Once saved, the backend is selectable immediately, in every place where you choose a model. Choose **Edit** to change its key, address, models or picture. Leave the key field empty to keep the saved key. Removing a backend also deletes its key from the vault.

The key is reserved to this backend: on the **Secrets** page it shows the grant *backend only*. Only the process of this backend receives it — not the other agents, whatever backend they run on, and not plugins. To limit it to some projects or agents, add those grants next to it: a mission then needs both, the right backend **and** one of those projects or agents. A model picker that chooses for an agent or a project (the composer, a task, an agent's sheet, a workflow node) does not offer a backend whose key that agent or project cannot use, and shows a model already set on one as unavailable. The series plan and the instance-wide settings list every backend: there, a mission that cannot use the key is refused when it starts. Removing *backend only* while other grants remain shares the key with those projects or agents on every backend, so only a superadmin can do it.

Keys saved by an earlier version were shared with every agent. Timon reserves them to their backend when it starts, as long as you had not changed their grants. If you had (for example, shared the key with a project), Timon leaves it as it is and shows a card with the two choices: reserve it to the backend, or keep sharing it.

You can also add models manually when the provider has no model listing. Enter the exact model ID, give it a label and choose which model should be the default. See [backend management](./settings.md#backend-and-fallback-choices) for disabling, reordering and editing built-in providers.

### Thinking setting of each model

Models do not all set their thinking the same way: some take **levels** (`low`, `high`, `max`…), some a **token budget**, some only an **on / off switch**, and some do not think at all. Most providers do not say which, so Timon detects it for each model of a backend you added:

1. from the provider itself, when its model listing reports the levels a model accepts (Anthropic's does, and **Test** reads them);
2. otherwise from a copy of the [models.dev](https://models.dev) catalogue built into Timon, matched on the model ID. No network call is made.

The thinking control in the agent editor, the chat bar and the model menu follows what was detected: a level slider, **low / medium / high** budget steps, or **off / on** buttons. A model with nothing to set shows none.

The catalogue describes the model, not your provider: a gateway may ignore a setting the model supports. To correct the detection, open **Edit**, then the brain button of the model. It shows what was detected and lets you choose instead:

| Choice | What the selectors show |
|---|---|
| **As detected** | The detected control (the default). |
| **Levels** | A slider over the level names you enter, lowest first, separated by commas. |
| **Token budget** | Low / medium / high steps. Enter a maximum if the provider sets one. |
| **On / off** | An off / on switch. |
| **Does not think** | Nothing. |

Your choice wins over the detection and is kept when you save the backend again or press **Test**. Choose **As detected** to go back. Token budgets and switches are offered for the Anthropic protocol; an OpenAI Responses provider takes levels only.

### When a backend is inactive

An inactive backend is listed with its reason, in Settings, in `timon backend list` and in `timon doctor`. For example:

- `vault entry … does not exist` — the key it refers to was deleted from the vault;
- `vault entry … has no grant` — the key exists but no mission may receive it; on the Secrets page, reserve it to the backend (scope **backend only**, or `timon secret grant <NAME> --scope backend:<id>`) or grant it to `global`;
- `vault entry … is reserved for another backend` — the key this file names belongs to another backend;
- `vault entry … is not granted to this mission` — at launch only: the key is limited to other projects or agents;
- `dialect … is not installed` — the file names a protocol that no installed plugin provides.

## From the command line

`timon backend` does the same as the form, from a terminal: a server without an open interface, or a script that sets up a team's machines.

```bash
timon backend add DeepSeek --base-url https://api.deepseek.com/anthropic --protocol anthropic --models deepseek-v4-pro
```

The command asks for the API key with the input hidden. **The key is never an argument**: a command line stays in your shell history and other local processes can read it, so `--key` does not exist and the command refuses anything that looks like one. At the prompt, Ctrl-C cancels, and so does Ctrl-D on an empty line; the command then exits with code 130. A script pipes it instead:

```bash
printf %s "$DEEPSEEK_KEY" | timon backend add DeepSeek --base-url https://api.deepseek.com/anthropic --protocol anthropic --key-from-stdin
```

In PowerShell:

```powershell
$env:DEEPSEEK_KEY | timon backend add DeepSeek --base-url https://api.deepseek.com/anthropic --protocol anthropic --key-from-stdin
```

Pass `--no-key` for a local server that asks for none. `--base-url` also refuses an address carrying a user, a password or a query string: give the plain address.

| Command | What it does |
|---|---|
| `timon backend add <name> --base-url URL --protocol anthropic\|openai-responses` | Adds the backend. Optional: `--key-from-stdin` or `--no-key`, `--id`, `--models A,B`, `--default-model`, `--brand`, `--icon`. |
| `timon backend list` | The backends you added, with their state and address. Never a key. |
| `timon backend test <id>` | The **Test** button: one call to the model listing, with the saved key and address. |
| `timon backend test --base-url URL --protocol … ` | The same before saving anything. Takes the key like `add`. |
| `timon backend rm <id>` | Removes the backend, and the key added with it. |

Each one takes `--json`. `test` exits with `0` only when the endpoint answers and accepts the key, and `1` otherwise; a route's refusal exits with `2`, a wrong command line with `64`.

Run from an agent, `add`, `test` and `rm` are refused with `operator_only`.

To change a saved key or address, use **Edit** in Settings.

### Checking your backends with `timon doctor`

`timon doctor` has a **Backend profiles** section, which never shows a key or an address:

```text
Backend profiles: 3 present, 2 testable, 1 in error
  deepseek                 active   testable     vault key
  local-box                disabled testable     no key
  broken                   ERROR    not testable no key
    not valid JSON
  Check one: timon backend test <id>
```

**Testable** means `timon backend test` can check it; `doctor` itself makes no call to the provider. When the service is not running, or the CLI targets another machine, `doctor` only reads the files in `backends/`: it says so, and reports which ones are readable. `timon doctor --json` carries the same under `backendProfiles`.

## From a file

Each backend is one file, `~/.timon/backends/<id>.json` (`%USERPROFILE%\.timon\backends\<id>.json` on Windows; see [Where Timon keeps its files](../installation/configuration.md#where-timon-keeps-its-files)). The form writes that file; you can also write it, or copy one from a README. The folder is watched: a file you add, edit or delete takes effect within a second.

```json
{
  "id": "deepseek",
  "dialect": "claude",
  "label": "DeepSeek",
  "vendor": "DeepSeek",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": { "secret": "BACKEND_DEEPSEEK_API_KEY" }
  },
  "defaultModel": "deepseek-v4-pro",
  "models": [
    { "slug": "deepseek-v4-pro", "label": "DeepSeek V4 Pro", "contextWindow": 128000 },
    { "slug": "deepseek-v4-flash", "label": "DeepSeek V4 Flash" }
  ]
}
```

An OpenAI Responses provider also declares how the Codex CLI reaches it:

```json
{
  "id": "openrouter",
  "dialect": "codex",
  "label": "OpenRouter",
  "env": { "BACKEND_OPENROUTER_API_KEY": { "secret": "OPENROUTER_API_KEY" } },
  "providerConfig": {
    "id": "timon-openrouter",
    "name": "OpenRouter",
    "baseUrl": "https://openrouter.ai/api/v1",
    "envKey": "BACKEND_OPENROUTER_API_KEY",
    "wireApi": "responses"
  },
  "defaultModel": null,
  "models": [],
  "modelsEndpoint": { "url": "https://openrouter.ai/api/v1/models", "format": "openai" }
}
```

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits and dashes. Must equal the file name. It cannot be the id of a built-in backend (`claude`, `codex`, …) or of one a plugin provides. |
| `dialect` | `claude` (Anthropic protocol) or `codex` (OpenAI Responses), or a dialect an installed plugin provides. |
| `label`, `vendor`, `brand` | Display name, vendor column and logo key in the selectors. |
| `env` | Environment of the mission process. A value is either a plain, non-secret string or a reference to a vault entry: `{ "secret": "NAME" }`. |
| `providerConfig` | `codex` dialect only. Choose an `id` that is not one of Codex's built-in providers (`openai`, `ollama`, …). `envKey` names the variable of `env` that holds the key. |
| `defaultModel`, `models` | Models offered in the selectors. `models` may be empty: the model field is then free text. |
| `models[].contextWindow` | Optional. The model's context window in tokens, used by the chat's context gauge. It wins over the window the CLI reports. You can also set it in the model's row in **Edit**. |
| `models[].supportedReasoningLevels` | Optional. The thinking levels the model accepts, lowest first, e.g. `["low", "medium", "high"]`. |
| `models[].reasoningControl` | Optional. A thinking setting that levels cannot express: `{ "type": "budget", "max": 16000 }` (`min` and `max` optional), `{ "type": "toggle" }` or `{ "type": "none" }`. Levels win if a model has both. |
| `modelsEndpoint` | Optional. A public, OpenAI-style model listing that replaces `models` while it answers. |

### Ollama Cloud and Kimi are built in

They need no backend of your own: create the key on the **Secrets** page, in *inject* mode, and **grant it to `global`**. Use `OLLAMA_API_KEY` for Ollama Cloud and `KIMI_API_KEY` for Kimi. The backend turns active without a restart.

### LLMTR is built in

LLMTR is a Chat Completions gateway, not an Anthropic or OpenAI Responses endpoint, so it is not added with the form above. It ships with Timon. Create an inject secret named `LLMTR_API_KEY` and grant it to `global`, or reserve it to the `llmtr` backend. The same variable in the daemon's environment is used when the vault has no entry yet. The backend turns active without a restart.

Missions send each model id exactly as it is written, including a vendor prefix. The suggested default is `minimax/minimax-m3.1-flash`. The model menu also reads the public list at `https://llmtr.com/v1/models` when that list answers. That request carries no key: a successful list does not mean the key is valid, and **Test** on a backend you added yourself is a different check. LLMTR does not use the Responses API. It runs no worktree and receives none of Timon's tools, so a task that has to edit files needs another backend.

### Keys belong in the vault

Create the key on the **Secrets** page in *inject* mode and reference it by name. Then reserve it to your backend, so that no other process receives it: on the same page, add the scope **backend only** and pick your backend, or run `timon secret grant <NAME> --scope backend:<id>`, where `<id>` is the file name without `.json`. Only an *inject* key can be reserved: the broker never serves a reserved key. A `global` grant works too, but hands the key to every agent. A key without a grant is never handed to a mission, and the backend stays inactive.

A key written directly in the file works, but the backend is flagged with a warning: the file is plain text, and it is included when you export your installation.

### What a file cannot do

A backend file is data. It chooses an address and a model list, nothing else, and these keys are refused:

- `cmd`, `requiredBinary` — a file never chooses a program to run;
- `requiredEnv`, `envFrom` — a file never reads the environment of the Timon service.

### What a file may set in `env`

Each protocol reads its own variables, and a file may only name those:

| Protocol (dialect) | Names a file may set |
| --- | --- |
| Anthropic (`claude`) | `ANTHROPIC_*` — e.g. `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` |
| OpenAI-Responses (`codex`) | `OPENAI_*` — e.g. `OPENAI_API_VERSION` for Azure — and `BACKEND_*` for the backend's own key, as in `BACKEND_OPENROUTER_API_KEY` above |

Any other name is refused, with the reason, and the backend stays inactive — a
file can never change what an agent runs, where it looks for it, or where it
reads its configuration. A protocol added by a plugin brings its own list.

A `codex` file written from an earlier version of this page, with
`OPENROUTER_API_KEY` in `env` and `envKey`, is now refused: rename that variable
`BACKEND_OPENROUTER_API_KEY` in both places. The vault entry it points at keeps
its name.

If your provider genuinely needs a variable this leaves out, tell us the
provider and the variable: the list is part of the product, and it grows with
real ones.

A file that is refused, malformed, or named differently from its `id` is listed in **Settings → AI models → LLM backends** with the reason. It never prevents Timon from starting.

## Through a LiteLLM proxy

[LiteLLM](https://docs.litellm.ai/) is a proxy you host yourself: it puts many providers behind one address and one key. Timon reaches it like any other provider, in either protocol, so you can keep the CLI you prefer and let the proxy route each model to its provider.

Because the address is your own, there is no pack to install: add the proxy from **Settings → AI models → LLM backends → Add a backend**, or write the file below. Use the address of the proxy as seen from the computer where Timon runs (`http://localhost:4000` when both are on the same computer, its `https://` address otherwise). Store a LiteLLM key — a virtual key, or the master key — in the vault as for any provider; leave the key empty only if your proxy asks for none.

Your LiteLLM version must serve the endpoint the protocol uses: `/v1/messages` for Anthropic, `/v1/responses` for OpenAI Responses. Check the LiteLLM documentation of the version you run.

### Anthropic protocol (`/v1/messages`)

Missions run on the Claude Code CLI. In the form, choose **Anthropic** and enter the proxy's root address, **without** `/v1`.

```json
{
  "id": "litellm",
  "dialect": "claude",
  "label": "LiteLLM",
  "vendor": "LiteLLM",
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4000",
    "ANTHROPIC_AUTH_TOKEN": { "secret": "BACKEND_LITELLM_API_KEY" }
  },
  "defaultModel": null,
  "models": []
}
```

Claude Code also calls a small model for background work. If your proxy serves none under the name Claude Code asks for, add `"ANTHROPIC_DEFAULT_HAIKU_MODEL": "<one of your model names>"` to `env`.

### OpenAI Responses protocol (`/v1/responses`)

Missions run on the Codex CLI. In the form, choose **OpenAI Responses** and enter the address ending in `/v1`.

```json
{
  "id": "litellm-responses",
  "dialect": "codex",
  "label": "LiteLLM (Responses)",
  "vendor": "LiteLLM",
  "env": { "BACKEND_LITELLM_API_KEY": { "secret": "BACKEND_LITELLM_API_KEY" } },
  "providerConfig": {
    "id": "timon-litellm",
    "name": "LiteLLM",
    "baseUrl": "http://localhost:4000/v1",
    "envKey": "BACKEND_LITELLM_API_KEY",
    "wireApi": "responses"
  },
  "defaultModel": null,
  "models": []
}
```

### The models of the proxy

The model IDs are the `model_name` entries of your LiteLLM configuration, not the upstream providers' IDs. **Test** reads the proxy's model listing with your key and proposes every model it serves: keep the ones you want and choose the default.

`modelsEndpoint` is read **without** a key, so it only helps when your proxy lists its models to anyone. If it does, add `"modelsEndpoint": { "url": "http://localhost:4000/v1/models", "format": "openai" }` and the list follows your LiteLLM configuration by itself; otherwise keep the models in the backend.
