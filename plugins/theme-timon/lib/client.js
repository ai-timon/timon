import React from 'react'

/**
 * The Timon theme: the brand palette, dark and light.
 *
 * A built-in plugin (`orchestrator/builtin-plugins.json`), written like any
 * third-party theme (`docs/PLUGINS.md`, its section on themes): it registers in
 * the `theme` slot, and the loader only mounts it for an account that chose
 * it — the default of every account made from 0.1.7 on. Being a package, it
 * reloads hot: editing this file takes effect without rebuilding the app.
 *
 * Dark: the website's violet-tinted night (266°), on the product's steps so
 * the frame, the islands and the cards read apart: frame 4.5%, islands
 * 10.5%, cards 13.5%, menus 18.5%, hover 22%, borders 25.5% (the site's
 * `#16131a`, 8.8%, sits between the frame and the islands). Peach champagne
 * `#F9BB91` as the primary, warm ivory text.
 * Light: a beige canvas instead of neutral grey, a copper apricot primary
 * (the peach cannot carry text on light), obsidian text.
 *
 * The app paints a copy of TOKENS in its floor before hydration, so the page
 * never shows the product palette first
 * (`app/src/plugins-client/theme-timon-floor.ts`); a test keeps the two equal.
 * Tokens left out (agenda hues, syntax palette but its background, success,
 * warning, info) come from the product floor.
 */
const TOKENS = `
:root {
    --font-sans: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;

    --surface-0: 266 15% 10.5%;
    --surface-1: 268 13% 13.5%;
    --surface-2: 270 12% 16%;
    --surface-3: 271 11% 18.5%;
    --surface-4: 272 10% 22%;
    --surface-sunken: 266 18% 7.5%;
    --chrome: 266 22% 4.5%;
    --surface-chip: var(--surface-3);

    --shadow-1: 0 1px 2px hsl(266 40% 2% / 0.5);
    --shadow-2: 0 6px 18px -6px hsl(266 40% 2% / 0.62), 0 2px 6px -2px hsl(266 40% 2% / 0.42);
    --shadow-3: 0 18px 44px -12px hsl(266 40% 2% / 0.78), 0 6px 14px -6px hsl(266 40% 2% / 0.5);

    --background: var(--surface-0);
    --foreground: 30 50% 93.7%;
    --card: var(--surface-1);
    --card-foreground: 30 50% 93.7%;
    --popover: var(--surface-3);
    --popover-foreground: 30 50% 93.7%;
    --primary: 24 90% 77.3%;
    --primary-foreground: 266 15% 10.5%;
    --secondary: var(--surface-4);
    --secondary-foreground: 30 50% 93.7%;
    --muted: var(--surface-2);
    --muted-foreground: 20 15% 69%;
    --accent: var(--primary);
    --accent-foreground: 266 15% 10.5%;
    --border: 268 10% 25.5%;
    --input: 268 10% 25.5%;
    --ring: var(--primary);
    --radius: 0.75rem;

    --salmon: var(--primary);
    --salmon-2: var(--primary);
    --salmon-3: var(--primary);
    --salmon-soft: var(--primary) / 0.12;

    --bubble-user: color-mix(in srgb, hsl(var(--primary)) 14%, hsl(var(--card)));
    --bubble-user-border: color-mix(in srgb, hsl(var(--primary)) 30%, hsl(var(--card)));

    --timon-scrollbar-thumb: hsl(var(--primary) / 0.26);
    --timon-scrollbar-thumb-hover: hsl(var(--primary) / 0.45);

    --hl-bg: #110e15;
}

:root.light {
    --surface-0: 33 32% 93.2%;
    --surface-1: 35 38% 97.6%;
    --surface-2: 33 30% 91.4%;
    --surface-3: 35 40% 98.8%;
    --surface-4: 32 30% 88.4%;
    --surface-sunken: 33 30% 91.4%;
    --chrome: 32 24% 87.8%;
    --surface-chip: var(--surface-2);

    --shadow-1: 0 1px 2px hsl(15 30% 20% / 0.08);
    --shadow-2: 0 6px 18px -6px hsl(15 30% 20% / 0.14), 0 2px 6px -2px hsl(15 30% 20% / 0.08);
    --shadow-3: 0 18px 44px -12px hsl(15 30% 20% / 0.2), 0 6px 14px -6px hsl(15 30% 20% / 0.12);

    --background: var(--surface-0);
    --foreground: 345 12% 13%;
    --card: var(--surface-1);
    --card-foreground: 345 12% 13%;
    --popover: var(--surface-3);
    --popover-foreground: 345 12% 13%;
    --primary: 21 48% 47.8%;
    --primary-foreground: 30 60% 97.5%;
    --secondary: var(--surface-4);
    --secondary-foreground: 345 12% 13%;
    --muted: var(--surface-2);
    --muted-foreground: 18 10% 30%;
    --accent: var(--primary);
    --accent-foreground: 30 60% 97.5%;
    --border: 30 24% 81.5%;
    --input: 30 24% 81.5%;
    --ring: var(--primary);

    --salmon: var(--primary);
    --salmon-2: var(--primary);
    --salmon-3: var(--primary);
    --salmon-soft: var(--primary) / 0.12;

    --bubble-user: color-mix(in srgb, hsl(var(--primary)) 3%, hsl(var(--surface-2)));
    --bubble-user-border: color-mix(in srgb, hsl(var(--primary)) 14%, hsl(var(--surface-2)));

    --timon-scrollbar-thumb: hsl(var(--primary) / 0.28);
    --timon-scrollbar-thumb-hover: hsl(var(--primary) / 0.48);

    --hl-bg: #efe7de;
}
`

/**
 * Two wide, indirect lights on the page (copper/apricot, upper right and
 * lower left, a few percent): islands and cards are opaque, so they only
 * show in the gutters. Never in the floor.
 */
const GLOW = `
body {
    background-image:
        radial-gradient(1100px 640px at 88% -10%, hsl(24 90% 77% / 0.05), transparent 62%),
        radial-gradient(900px 560px at -8% 110%, hsl(15 45% 45% / 0.045), transparent 60%);
    background-attachment: fixed;
}
:root.light body {
    background-image:
        radial-gradient(1100px 640px at 88% -10%, hsl(24 90% 70% / 0.08), transparent 62%),
        radial-gradient(900px 560px at -8% 110%, hsl(21 48% 48% / 0.04), transparent 60%);
}
`

function TimonTheme() {
  return React.createElement('style', {
    id: 'timon-theme-timon',
    dangerouslySetInnerHTML: { __html: TOKENS + GLOW },
  })
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'theme' }, TimonTheme)
}
