/**
 * The product palette, as data — no React, no `'use client'`.
 *
 * Two consumers, one source: the `theme` slot occupant next door paints it
 * unlayered (`ui-theme.tsx`), and the app shell paints the SAME string inside
 * a cascade layer as a floor (`plugin-host/theme-floor.tsx`). Duplicating the
 * 125 tokens into `globals.css` would have been one drift away from a palette
 * that disagrees with itself.
 */
/**
 * Copied verbatim from the historical `globals.css` `:root` / `.light`
 * blocks (T.3). Infrastructure measures (`--timon-topbar-h`, `--timon-nav-w`,
 * `--timon-browser-w`) stay in `globals.css`: they are runtime layout, not a
 * theme.
 */
export const THEME_TOKENS_CSS = `
:root {
    /* Product fonts live on the theme so a third-party occupant can
     * replace them. System stack: no next/font, no hosted files.
     * code-font: the face of code blocks, editors and terminals. */
    --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Cascadia Code", "JetBrains Mono", "DejaVu Sans Mono", "Liberation Mono", monospace;

    /* Opaque neutral surfaces: canvas, panels, fields, menus, controls. */
    --surface-0: 220 12% 11%;
    --surface-1: 220 10% 13.5%;
    --surface-2: 220 9% 16.5%;
    --surface-3: 220 9% 18.5%;
    --surface-4: 220 8% 22.5%;
    /* Two surfaces outside the scale, for what sinks instead of rising.
     * In dark they go below the canvas, in light they rise towards
     * grey — a code block must be recessed in both cases, which a
     * single step of the scale cannot express. */
    --surface-sunken: 220 12% 8.5%;       /* code block, tool output */
    /* The frame (topbar + rail): no border, so it is told from the page by
     * its own colour — darker than the canvas here, greyer than it in light. */
    --chrome: 220 12% 3.5%;
    --surface-chip: var(--surface-3); /* inline code, chip */

    /* Drop shadows per level. In dark, a shadow does not "darken" enough
     * to lift a surface: it mostly puts a halo around floating elements,
     * hence the generous radii and the high opacities. */
    --shadow-1: 0 1px 2px hsl(0 0% 0% / 0.45);
    --shadow-2: 0 6px 18px -6px hsl(0 0% 0% / 0.6), 0 2px 6px -2px hsl(0 0% 0% / 0.4);
    --shadow-3: 0 18px 44px -12px hsl(0 0% 0% / 0.75), 0 6px 14px -6px hsl(0 0% 0% / 0.5);

    /* shadcn (dark) */
    --background: var(--surface-0);
    --foreground: 0 0% 92%;
    --card: var(--surface-1);
    --card-foreground: 0 0% 92%;
    --popover: var(--surface-3);
    --popover-foreground: 0 0% 92%;
    --primary: 13 67% 63%;            /* salmon #E07A5F */
    --primary-foreground: 0 0% 8%;
    --secondary: var(--surface-4);
    --secondary-foreground: 0 0% 92%;
    --muted: var(--surface-2);
    --muted-foreground: 220 8% 70%;    /* raised from 54 %: the caption
                                          * grey became unreadable once
                                          * placed on the lightened
                                          * surfaces above. */
    --accent: var(--primary);
    --accent-foreground: 0 0% 8%;
    --destructive: 0 64% 68%;         /* #e07a7a */
    --destructive-foreground: 0 0% 98%;
    --border: 220 8% 24%;              /* must stay above
                                          * --surface-4: otherwise borders
                                          * would vanish on secondary
                                          * buttons. */
    --input: 220 8% 24%;
    --ring: var(--primary);
    --radius: 0.5rem;

    /* TIMON extras */
    --salmon: var(--primary);
    --salmon-2: var(--primary);           /* #f0a48f */
    --salmon-3: var(--primary);           /* #f6c7b8 */
    --salmon-soft: var(--primary) / 0.12;
    --success: 128 49% 66%;           /* #7dd28a */
    --warning: 34 67% 63%;            /* #e0b15f */
    --info: 212 62% 68%;              /* #7aa7e0 */

    /* Six-hue accent palette (charts, avatars, origin badges). The name
       is historical (the first cockpit tile that used it), and themes
       already define it. Declared as tokens rather than hard-coded in the
       components so the light theme can darken them: the same hues read
       on white turn fluorescent. */
    --agenda-1: 13 67% 63%;
    --agenda-2: 212 62% 68%;
    --agenda-3: 128 42% 62%;
    --agenda-4: 34 67% 63%;
    --agenda-5: 272 52% 72%;
    --agenda-6: 178 45% 56%;

    /* canvas dotted-grid colour, used by .timon-canvas */
    --timon-grid: transparent;

    /* Shape of the chat avatars — the SAME for the human and the agents.
     * A theme that wants square thumbnails sets a radius here, and both
     * sides of the conversation follow it together. These tokens are
     * outside the .light block: geometry does not depend on lightness. */
    --avatar-radius: 9999px;

    /* The human's bubble: OPAQUE by default. A translucent gradient let
     * the page background show through the text. The mix keeps the active
     * theme's accent hue without bringing alpha back (color-mix), and a
     * theme can redefine both tokens in one block. */
    --bubble-user: color-mix(in srgb, hsl(var(--primary)) 18%, hsl(var(--card)));
    --bubble-user-border: color-mix(in srgb, hsl(var(--primary)) 38%, hsl(var(--card)));

    /* Global scrollbar — primary hue, see .scrollbar-thin further down. */
    --timon-scrollbar-thumb: hsl(var(--primary) / 0.32);
    --timon-scrollbar-thumb-hover: hsl(var(--primary) / 0.52);

    /* Syntax-highlighting palette (dark default). Tokens are mapped onto
     * highlight.js classes further down so the .hljs-* selectors don't
     * have to be repeated for the light theme — only the values change. */
    --hl-bg: #0d1117;
    --hl-fg: #c9d1d9;
    --hl-comment: #8b949e;
    --hl-keyword: #ff7b72;
    --hl-string: #a5d6ff;
    --hl-number: #79c0ff;
    --hl-function: #d2a8ff;
    --hl-variable: #ffa657;
    --hl-type: #79c0ff;
    --hl-builtin: #7ee787;
    --hl-deletion-bg: #67060c;
    --hl-addition-bg: #033a16;
}

:root.light {
    /* Light mode uses neutral white panels and a quiet grey canvas. */
    --surface-0: 220 14% 97%;
    --surface-1: 0 0% 100%;
    --surface-2: 220 12% 94%;
    --surface-3: 0 0% 100%;
    --surface-4: 220 11% 91%;
    --surface-sunken: 220 12% 94%;
    --chrome: 220 12% 89%;
    --surface-chip: 220 12% 94%;

    --shadow-1: 0 1px 2px hsl(40 10% 20% / 0.08);
    --shadow-2: 0 6px 18px -6px hsl(40 10% 20% / 0.14), 0 2px 6px -2px hsl(40 10% 20% / 0.08);
    --shadow-3: 0 18px 44px -12px hsl(40 10% 20% / 0.2), 0 6px 14px -6px hsl(40 10% 20% / 0.12);

    --background: var(--surface-0);
    --foreground: 0 0% 9%;            /* #181818 */
    --card: var(--surface-1);
    --card-foreground: 0 0% 9%;
    --popover: var(--surface-3);
    --popover-foreground: 0 0% 9%;
    --primary: 11 58% 52%;            /* #c95a3f */
    --primary-foreground: 0 0% 100%;
    --secondary: var(--surface-4);
    --secondary-foreground: 0 0% 9%;
    --muted: var(--surface-2);
    --muted-foreground: 220 8% 40%;     /* #4a4a4a */
    --accent: var(--primary);
    --accent-foreground: 0 0% 100%;
    --destructive: 4 62% 45%;         /* #b8362c */
    --destructive-foreground: 0 0% 100%;
    --border: 220 10% 83%;
    --input: 220 10% 83%;
    --ring: var(--primary);

    --salmon: var(--primary);
    --salmon-2: var(--primary);
    --salmon-3: var(--primary);
    --salmon-soft: var(--primary) / 0.12;
    --success: 144 50% 36%;           /* #2e8a52 */
    --warning: 39 100% 32%;           /* #a36a00 */
    --info: 212 60% 41%;              /* #2864a8 */

    --agenda-1: 11 58% 48%;
    --agenda-2: 212 60% 41%;
    --agenda-3: 144 50% 30%;
    --agenda-4: 32 78% 34%;
    --agenda-5: 272 45% 46%;
    --agenda-6: 184 62% 27%;

    --timon-grid: transparent;

    --timon-scrollbar-thumb: hsl(var(--primary) / 0.32);
    --timon-scrollbar-thumb-hover: hsl(var(--primary) / 0.52);

    /* GitHub-light flavoured syntax palette — high enough contrast on
     * the soft cream chat-bubble background, no eye-strain. */
    --hl-bg: #f2f4f7;
    --hl-fg: #1f2328;
    --hl-comment: #6e7781;
    --hl-keyword: #cf222e;
    --hl-string: #1a7f37;
    --hl-number: #0550ae;
    --hl-function: #8250df;
    --hl-variable: #953800;
    --hl-type: #0550ae;
    --hl-builtin: #116329;
    --hl-deletion-bg: #ffebe9;
    --hl-addition-bg: #dafbe1;
}
`;
