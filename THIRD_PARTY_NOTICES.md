# Third-party notices

Timon is built on open-source software. This file lists the third-party code
this repository carries itself, and the licences of the dependencies that ask
for a notice. The npm dependencies keep their own licence files in their
packages; the installed app ships them with the code.

## Code committed in this repository

| Path | Component | Licence | Notice |
|---|---|---|---|
| `app/src/vendor/vault-graph/` | Sigma.js, graphology | MIT | [NOTICE.md](app/src/vendor/vault-graph/NOTICE.md) |
| `app/src/styles/fonts/SymbolsNerdFontMono-Regular.woff2` | Symbols Nerd Font Mono 3.5.1 | MIT | [NOTICE.md](app/src/styles/fonts/NOTICE.md), [LICENSE-nerd-fonts](app/src/styles/fonts/LICENSE-nerd-fonts) |
| `app/src/styles/fonts/InterVariable.woff2` | Inter 4.1 | OFL-1.1 | [NOTICE.md](app/src/styles/fonts/NOTICE.md), [LICENSE-inter](app/src/styles/fonts/LICENSE-inter) |
| `plugins/hermes-gateway/` | run handling ported from Hermes Web UI (`api/gateway_chat.py`) | MIT | [NOTICE](plugins/hermes-gateway/NOTICE) |

## Dependencies that call for a notice

Most dependencies are under MIT, ISC, BSD or Apache-2.0. These ones carry an
extra condition:

| Package | Licence | What it asks |
|---|---|---|
| `web-push` | MPL-2.0 | Its source files stay under MPL-2.0 and available; Timon uses them unmodified, from npm |
| `dompurify` | MPL-2.0 OR Apache-2.0 | Used under Apache-2.0 |
| `caniuse-lite` | CC-BY-4.0 | Attribution: browser support data by the [caniuse.com](https://caniuse.com) project |
| `argparse` | Python-2.0 | Keep its copyright notice |

## Runtime components of the desktop app

The desktop app bundles Electron (MIT), which includes Chromium and its
third-party components (credited in the `LICENSES.chromium.html` file next to
the app), and a Node.js runtime (MIT, with the notices of its own dependencies
in its `LICENSE` file).

## Logos in the README

The provider logos under `.github/assets/logos/` are recoloured
copies from [Simple Icons](https://simpleicons.org) (CC0-1.0) and, for Codex, Grok and
Hermes, from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT,
Copyright (c) 2023 LobeHub). They name the tools Timon works with; each mark
belongs to its owner and implies no endorsement.
