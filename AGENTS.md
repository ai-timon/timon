# Timon — instructions for coding agents

Timon is a modular agent platform that runs on the user's own machine: a
headless daemon, a web app, a desktop app (Electron) and a CLI, extended by
signed plugins. People install it on Windows, macOS and Linux. A change made
here reaches machines you cannot test on: work accordingly.

**Maintainers:** if `docs/AGENTS.local.md` exists, read it now, before
anything else. It holds the rules of the maintainers' own setup and takes
precedence over this file.

## Read before you change anything

- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to run the checks, and the rules a
  review looks at. Everything below assumes it.
- [`LICENSING.md`](LICENSING.md): the code is AGPL-3.0 with a plugin exception;
  the SDK and `examples/` are MIT. Do not copy code whose licence is not
  compatible.
- The user documentation, at <https://docs.timon-ai.com>, comes from
  `public-docs/`. Plugin authors start from
  <https://docs.timon-ai.com/plugins/quickstart>.

## Architecture

- The kernel is [Cordis](https://www.npmjs.com/package/@deepseek-ai/cordis)
  4.x. Every feature is a plugin: a bundled Cordis plugin on the daemon side
  (`orchestrator/src/plugins-bundled/<name>/`), a slot occupant on the screen
  side (`app/src/plugins-client/`). There is no other plugin framework: do not
  add a registry, and do not wire a new surface into a component by hand.
- Third-party plugins are npm packages with a host half and a browser half,
  installed under the Timon home and signed with Ed25519. Their contract is the
  SDK (`packages/sdk/`).
- Configuration is `~/.timon/timon.config.json`, validated with zod. A setting
  resolves as environment, then config file, then the settings table, then its
  default.
- The operating system is reached only through `orchestrator/src/host/`:
  binaries, the service, isolation, the keyring.
- The brand lives in `orchestrator/src/brand.ts` (copied in
  `app/src/lib/brand.ts`). The internal identifier is `timon`: home `~/.timon`,
  keys `TIMON_*`, binary `timon`.
- An agent's role is a field (`config.role`), never read from its name.

## Hard rules

1. **Do not stop the daemon you run under.** Do not run `systemctl`,
   `launchctl`, `docker compose` or `npm run build` against a live install:
   `orchestrator/dist/` is what the running daemon executes.
2. **Never test against a real home.** Tests and experiments use a temporary
   home (`TIMON_HOME` set to a fresh temporary folder); `paths.ts` refuses the
   real one under the test runner.
3. **Run tests through the package script**, `npm test -- <file>`, never
   `node --test` or `tsx` by hand: the script caps memory and duration. A test
   killed by a limit is a bug to fix, not a command to retry.
4. **Three systems.** `node:path` for every path, no Unix command outside
   `orchestrator/src/host/`, no assumption about the supervisor.
   `node scripts/check-portability.mjs --changed` must stay clean; a deliberate
   exception carries `// portability: <reason>` on its line.
5. **Security.** Every new route declares its authentication. The daemon token
   is for the CLI, the MCP servers and the agents, never for a browser request.
   No secret in a query string, an error or a log. Network input goes through a
   zod schema. Listen on loopback by default. An access check ships with the
   test that proves an anonymous request is refused.
6. **Language.** Code, comments, CLI output and daemon messages are in English.
   Interface text goes through `t(key, vars?)` and `app/src/locales/<tag>/`,
   English first. `english-messages.test.ts` and `english-comments.test.ts`
   guard the daemon, `english-tree.test.ts` the whole public tree. French kept
   on purpose carries `french-ok: <reason>` on its line or one of the two above.
7. **Interface.** No monospace font outside code (mark a legitimate one with
   `code-font: <reason>`), no horizontal separator line, no vertical line
   between side-by-side areas: separate with spacing, grouping and surface
   contrast. `app/src/lib/ui-style-rules.test.ts` guards it.
8. **One commit per step**, `type(scope): subject` in English, the body saying
   why. Moving code and changing it are separate commits. A daemon step and an
   interface step are separate commits.
9. **A visible change** gets a changelog fragment in `changes/` (one small file,
   format in `changes/README.md`; never an edit of `CHANGELOG.md`, which the
   release writes), from the user's point of view, and its documentation in
   `public-docs/`. Internal work (refactor, tests) gets no fragment.
10. **No version bump, no new npm dependency** without a maintainer's request.
11. TypeScript strict, no `any`. Comments explain why.
12. **Everything reaches `main` through a pull request.** Nobody pushes to
    `main`, maintainers and agents included. Branch from an up-to-date
    `origin/main`, commit there, run the checks, push the branch, open the pull
    request, and merge it once the required checks are green. A pushed branch
    is public at once, even if it is never merged: check it before you push.

## Where things live

| Area | Path |
|---|---|
| Kernel, bundled plugins, CLI | `orchestrator/src/kernel/`, `orchestrator/src/plugins-bundled/`, `orchestrator/bin/` |
| OS adapter | `orchestrator/src/host/` |
| Licences and signatures | `orchestrator/src/license/` |
| Web client | `app/src/` |
| Product surfaces (client plugins) | `app/src/plugins-client/`, `app/src/components/widget-host/` |
| Desktop app and packaging | `desktop/` |
| Plugin SDK | `packages/sdk/` |
| One plugin template per kind | `examples/` |
| User documentation | `public-docs/` |
