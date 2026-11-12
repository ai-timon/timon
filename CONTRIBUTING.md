# Contributing to Timon

Thank you for helping. Bug reports, fixes, translations, plugins and
documentation are all welcome. Timon runs on Windows, macOS and Linux at
people's homes, so a change here reaches machines you do not have: the rules
below exist for that reason.

## Before you start

- **A bug?** Open an issue with your version and the output of `timon doctor`.
- **A change bigger than a fix?** Open an issue first and describe it. A pull
  request that changes the product's direction without a discussion may wait a
  long time.
- **A new surface (widget, page, theme, provider)?** It is probably a plugin,
  and a plugin does not need to live in this repository: see the
  [plugin guide](https://docs.timon-ai.com/plugins/quickstart).
- **A translation?** Follow [CONTRIBUTING-TRANSLATIONS.md](CONTRIBUTING-TRANSLATIONS.md):
  you edit JSON files, you never touch TypeScript.
- **A vulnerability?** Never in an issue: see [SECURITY.md](SECURITY.md).

Your first pull request asks you to sign the [Contributor Licence
Agreement](CLA.md), once, with a comment. [LICENSING.md](LICENSING.md)
explains why.

## Running Timon from source

[GETTING-STARTED.md](GETTING-STARTED.md) covers what you need (Node.js 22, git,
an agent CLI), how to build and how to run the daemon and the web app from a
checkout.

## Where things live

| Area | Path |
|---|---|
| Daemon: kernel, bundled plugins, CLI | `orchestrator/src/kernel/`, `orchestrator/src/plugins-bundled/`, `orchestrator/bin/` |
| Operating-system adapter (binaries, service, keyring) | `orchestrator/src/host/` |
| Web client | `app/src/`, its product surfaces in `app/src/plugins-client/` |
| Desktop app | `desktop/` |
| Plugin SDK | `packages/sdk/` |
| One plugin template per kind | `examples/` |
| User documentation (docs.timon-ai.com) | `public-docs/` |

Every feature is a plugin: the daemon side is a [Cordis](https://www.npmjs.com/package/@deepseek-ai/cordis)
plugin, the screen side a slot occupant. A new surface registers in a slot; it
is never wired into a component by hand.

## Checks

Run the tests through the package script, which caps their memory and duration:

```bash
cd orchestrator && npx tsc --noEmit && npm test -- src/the-file.test.ts
cd app && npm run typecheck && npm test -- src/lib/the-file.test.ts
node scripts/check-portability.mjs --changed
```

Run the whole suite (`npm test` with no file) once before you open the pull
request. Tests always use a temporary home: never point `TIMON_HOME` at your
real one. If your shell sets `NODE_ENV=production`, unset it for the tests.

A test killed by a limit (time, memory) is a bug to fix, not a command to
retry.

## Rules the review checks

**Three systems.** Build paths with `node:path`, never by concatenating `/`.
Do not call Unix commands (`which`, `chmod`, `ps`, `sed -i`) outside
`orchestrator/src/host/`, and do not assume the supervisor: go through
`timon service`. `check-portability.mjs` catches the common mistakes; a line
it flags on purpose carries `// portability: <reason>`. Say in the pull
request what you could not test on Windows or macOS.

**Security.** A new route declares its authentication explicitly. A secret
never goes in a query string, an error message or a log. Network input is
validated with zod before it reaches the database. An access check comes with
the test that proves an anonymous request is refused.

**Language.** Code, comments, CLI messages and daemon messages are in English.
Interface text goes through `t()` and the locale files (`app/src/locales/`),
English first. `english-messages.test.ts` and `english-comments.test.ts` check
the daemon; `orchestrator/src/english-tree.test.ts` checks every other tracked
script, stylesheet and configuration file (translations, Markdown, JSON and
tests aside). French kept on purpose (a pattern that detects the language, an
example of it, a proper name) carries `french-ok: <reason>` on its line or one
of the two above; a plugin's own `fr` translation table needs nothing.

**Interface.** No monospace font outside code, no horizontal separator lines
(`divide-y`, `border-t` between blocks, `<hr>`), no vertical line between two
side-by-side areas: areas are islands separated by spacing.
`app/src/lib/ui-style-rules.test.ts` checks it.

**Comments** explain why, not what. TypeScript is strict: no `any`.

**Dependencies.** A new npm dependency ships to every user and adds its
licence and its attack surface: justify it in the pull request.

## Commits and pull requests

- Commit messages follow Conventional Commits, in English:
  `fix(kanban): a task moved during a merge keeps its branch`. The body says
  why the change is needed.
- One commit per step. Moving code and changing it are two commits.
- A change a user can see gets a changelog fragment: one small file in
  `changes/`, written from the user's point of view (format in
  `changes/README.md`). Do not edit `CHANGELOG.md`: the release writes it from
  the fragments, and two pull requests then never conflict on it. A change that
  alters what users do also updates `public-docs/`.
- Do not bump versions: releases are cut by the maintainers.
- Every change reaches `main` through a pull request, the maintainers' own
  included: nobody pushes to `main`. Start your branch from an up-to-date
  `main`; a pull request is merged once the required checks are green.
- Licences, governance files (CI, code owners, these rules), the keys and
  addresses Timon trusts, the brand and the identity of the packages are
  maintained by the project: the list is `.github/protected-paths`. A pull
  request that changes one of them fails the "protected paths" check until a
  maintainer has reviewed and approved that change; if you need one, say why
  in the pull request or open an issue. Dependencies are among them: adding,
  removing or upgrading a package (a `package.json` dependency field or a
  lockfile) needs a maintainer's approval.
