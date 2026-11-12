# Cursor provider (third-party, on the SDK alone)

Runs Timon missions on [Cursor](https://cursor.com)'s agent, with **your Cursor sign-in** (a subscription, never an API
billed per token). It is written the way an outside developer would write it: a plugin that imports only `@timon-ai/sdk`,
that Timon treats as a stranger. Read it as the worked example of an ACP provider — the whole agent is the one row in
[`lib/cursor.js`](lib/cursor.js) handed to `ctx.provider.runtime.acp.defineProvider`.

> **Not verified against a real Cursor.** It was written from Cursor's public documentation
> ([ACP](https://cursor.com/docs/cli/acp), [installation](https://cursor.com/docs/cli/installation)), without a
> `cursor-agent` binary or an account. The test fixtures are *reconstructed*, not recorded. See "Known limits".

## How it works

`cursor-agent acp` speaks the [Agent Client Protocol](https://agentclientprotocol.com) over stdio. The daemon owns the
protocol (transport, session driver, event mapping, the Allow/Deny card and the classifier for every tool use, `session/load`
to resume); this plugin brings what is Cursor's: the command line, the binary, the folders Cursor keeps its sign-in in, the
sentence to show when you are signed out, and the `cursor_login` method to try once before giving up.

Three more things are Cursor's, and [`lib/extensions.js`](lib/extensions.js) and `lib/cursor.js` hold them:

- **Cursor's own questions and plans.** `cursor/ask_question` opens Timon's question card (Cursor's question and option
  ids travel through it), and `cursor/create_plan` puts the plan to you with *Approve the plan* / *Reject the plan* and a
  remark (`extensionRequests`). Cursor's answer has no field for words: when you type a remark beside a pick, the whole
  answer goes back as `skipped` with your words as the reason. On a mission nobody watches, no card opens: Cursor is told
  why (a question is `skipped`, a plan `rejected`).
- **Its program, checked.** When you authorize the program, before a mission starts it, and before the model probe, Timon
  runs `cursor-agent --version` and expects a dated version (`2026.10.16…`, `binary.identity`, written in `lib/cursor.js`
  and, identical, in `package.json`). Another program at that path is refused, and you read what it printed.
- **What is not verified, said.** `declares.unverified` lists five subjects; the model picker shows an **Unverified** chip on
  Cursor with these sentences.

Cursor's models are asked of Cursor itself (the first time, and then every 12 hours, which leaves an empty session in your
Cursor history). None is written in this plugin.

## Install

The package is **unsigned**, so loading it needs developer mode, `developer.unsignedPlugins: true` in
`timon.config.json` (see the [testing guide](../../public-docs/docs/plugins/testing.md)). Then, from a terminal:

```bash
timon plugin add ./examples/plugin-provider-cursor
```

and confirm the permission it asks for (`backends:register`). Authorize the program as below. The install loop itself has not
been exercised end to end on a real installation: the tests load the package through the plugin context, not through the
CLI. To *develop* the plugin (run its tests), add the SDK to your project's development dependencies from your developer
distribution; it is not on the public npm registry.

Install Cursor's CLI and sign in **first**, in a terminal on the machine that runs the daemon:

```bash
curl https://cursor.com/install -fsS | bash      # macOS, Linux, WSL
cursor-agent login
```

On native Windows, Cursor documents `irm 'https://cursor.com/install?win32=true' | iex`.

## Authorize the program

A third-party plugin cannot start a program on its own. The manifest names `cursor-agent`, and `agent` as its alias; when
a superadmin installs the plugin from the gallery, Timon resolves the first name it finds on the machine and shows the
**resolved path** with a tick-box (off by default). On the click, Timon runs that program with `--version`: a program that
does not print Cursor's dated version (grok's `agent`, which lives in the same `~/.local/bin`) is refused with what it
printed, and nothing is authorized. Otherwise exactly that path is added to `pluginPolicy.exec.allow`. **Read the path**
anyway: it must be Cursor's. The same
sheet is available later in **Settings → AI models → LLM backends → Providers** (after moving the binary, for instance).
Until the program is authorized the plugin does not register, and nothing of it can run.

What it can never have, authorized or not: the mission's token, your vault, and the daemon's environment. The Cursor process
gets the system variables plus the identity pointers of the mission, nothing else. Timon's own MCP tools reach the agent
through the session, with the token carried as a reference the daemon swaps on the pipe (`docs/SECURITY.md` § 6.4.1).

Folders `~/.cursor` and `~/.config/cursor` are declared as Cursor's sign-in folders: a Cursor mission keeps them, every other
backend has them masked.

## Known limits

- **The fixtures are reconstructed from the documentation.** Green tests mean the provider speaks ACP as documented, not that
  `cursor-agent` behaves as documented. To replace them with a real session, see "Recording a real session".
- **Timon's tools may be missing in a Cursor mission.** The plugin declares `timon` and `timon_ask` in `session/new.mcpServers`.
  Cursor's ACP page only documents MCP servers from `.cursor/mcp.json`, and its sample client sends none. If Cursor ignores
  the session's list, the agent runs without Timon's tools (no task closing, no questions, no forms). The plugin never writes a
  `.cursor/mcp.json` in your repository. Unverified.
- **`agent` is declared, behind the identity check.** Cursor's documentation calls the program `agent`, and its installer
  provides both names; grok installs an `agent` too. `cursor-agent` is preferred when both exist; an install that has only
  `agent` launches `agent`. The version banner is what tells the two apart, so a Cursor whose banner is not dated (see
  below) cannot be authorized either.
- **The version banner is a guess.** The dated `--version` is inferred from Cursor's release names (its ACP registry entry is
  `2026.10.16`), not read from a real install. If your `cursor-agent` prints something else, every Cursor mission is
  refused with what it printed: adjust `binary.identity.pattern` in `lib/cursor.js` and the identical
  `timon.provider.binaries[0].identity.pattern` in `package.json` together.
- **`cursor-agent acp` is a hidden command** (absent from `--help`); Cursor can change it without notice.
- **Cursor's own requests follow the documentation.** `cursor/ask_question` and `cursor/create_plan` are answered in the
  shapes Cursor documents (read 30/10/2026); no real `cursor-agent` sent them. A question with more than four options, or
  more than four questions, cannot be shown: Cursor gets `skipped` with the reason. The other extension messages
  (`cursor/update_todos`, `cursor/task`, `cursor/generate_image`) are notifications and are ignored.
- **No usage gauge.** Cursor documents no signal for quota or usage in ACP. Limits show as text in the reply.
- **Sign-in is `cursor-agent login`.** Timon never starts a browser flow. `CURSOR_API_KEY` is not passed on (a plugin gets no
  credential from the daemon's environment); sign in with the CLI.
- **Windows and macOS are untested.** A report from 2026 says `agent acp` stays silent under WSL. The credential folder
  `~/.config/cursor` is a guess for Linux; native Windows keeps its configuration elsewhere. They are on the list in
  `docs/A-TESTER-MULTI-OS.md`.
- Cursor's registry entry for the ACP carries no checksum: the binary's integrity is that of Cursor's own download.

## Recording a real session

The fixtures in `test/fixtures/*.jsonl` are the agent's side of a conversation, one JSON object per line, keyed by the request
that triggers it (`{"on":"session/prompt","send":[…],"reply":{…}}`). With a signed-in `cursor-agent`, capture the lines it
writes on stdout during one `initialize` → `session/new` → `session/prompt` (with a tool use that asks permission), turn them
into steps, replace the files, and delete the "reconstructed" header only when they are real. Then run:

```bash
node --test test/conformance.test.mjs
```

## Tests

`test/conformance.test.mjs` runs the SDK's conformance bench (`@timon-ai/sdk/testing`) on the provider, then the ACP checks —
`loadAcpScript`, `createAcpReplayPeer`, `acpSessionChecks` — which play the fixtures as a scripted Cursor over in-memory pipes:
launch line, session and the MCP servers it declares, a turn, the permission round trip (with and without option kinds),
the sign-in message, `authenticate`, the model probe, and Cursor's two blocking requests through a card
(`session-ask-question.jsonl`, `session-create-plan.jsonl`). No Cursor, no account, no network. It runs from the repository's test suite
(through `packages/sdk/scripts/verify-consumer.mjs`, against the built SDK package, as an outside author would).
