# Third-party notices

| file | font | upstream | licence |
|---|---|---|---|
| `SymbolsNerdFontMono-Regular.woff2` | Symbols Nerd Font Mono 3.5.1 | https://github.com/ryanoasis/nerd-fonts (`NerdFontsSymbolsOnly.tar.xz`, release v3.5.1) | MIT — `LICENSE-nerd-fonts` |

The upstream file is `SymbolsNerdFontMono-Regular.ttf` (sha256 `fe471e538392f51910faab985fa8e192a39dd3426125edd15b71b3680df0e749`),
converted to WOFF2 with fontTools without any other change. Its glyphs come
from the icon sets Nerd Fonts aggregates (Font Awesome, Devicons, Octicons,
Material Design Icons…), each redistributed upstream under a permissive licence.

The copyright line is repeated in a `/*! … */` comment of `globals.css`, which
CSS minification keeps, so the notice travels with the built stylesheet.

| file | font | upstream | licence |
|---|---|---|---|
| `InterVariable.woff2` | Inter 4.1 (variable, roman) | https://github.com/rsms/inter (release v4.1, `InterVariable.ttf`) | SIL Open Font License 1.1 — `LICENSE-inter` |

The upstream file is `InterVariable.ttf` (sha256 `4989b125924991b90d05b2d16e0e388c48f7d5bb8b30539bbf9c755278d0ccaf`),
subset with fontTools `pyftsubset` to Latin, Latin Extended, Greek, Cyrillic,
punctuation, currency, arrows and the keyboard symbols, keeping the `kern`,
`liga`, `calt`, `ccmp`, `locl`, `mark`, `mkmk`, `tnum` and `cv11` features,
and written as WOFF2. Inter declares no Reserved Font Name, so the subset keeps
its name. Every system gets the same face: without it, a Linux machine with no
Inter installed fell back on whatever sans-serif it had (often DejaVu Sans),
and the interface looked like a different product there.
