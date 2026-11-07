/**
 * The Timon theme's palette for the first paint, as data — no React, no `'use client'`.
 *
 * The 2026 brand system's colours (NEW DA, `06_DESIGN_TOKENS/brand-system-v2.json`),
 * converted to the HSL triples the tokens carry:
 *
 * | Brand name       | HEX       | Dark role                      |
 * |------------------|-----------|--------------------------------|
 * | Peach champagne  | `#F9BB91` | primary (dark)                 |
 * | Warm ivory       | `#F7EFE7` | text (dark)                    |
 * | Muted warm gray  | `#BCACA4` | secondary text (dark)          |
 * | Obsidian         | `#1E1618` | text (light)                   |
 *
 * The dark surfaces are the website's night, not the kit's browns: the maintainer found
 * the kit's cacao "a touch too chocolate" next to timon-ai.com (05/11/2026),
 * so they take its hue (266°, `#16131a`), on the product's steps: with the
 * frame at 6.9% and the islands at 8.8% nothing stood apart, so the frame is
 * 4.5%, the islands 10.5%, the cards 13.5%, the menus 18.5%, the hover 22%. The light canvas leans beige, never neutral grey. In light the
 * peach cannot carry text, so the primary turns to a copper apricot.
 *
 * A COPY of the tokens of the built-in theme plugin
 * (`plugins/theme-timon/lib/client.js`, the source of truth, which reloads
 * hot). The shell's floor (`plugin-host/theme-floor.tsx`) paints it in its
 * cascade layer before hydration when Timon is the account's theme: the
 * plugin bundle is fetched after the first paint, and without the copy every
 * page would show the product palette for a moment first. The plugin's own
 * `<style>` is unlayered and wins as soon as it mounts. `theme-timon.test.ts`
 * fails when the two drift apart.
 */
export const TIMON_THEME_PLUGIN = 'theme-timon';

export const TIMON_THEME_TOKENS_CSS = `
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
    --muted-foreground: 18 10% 34%;
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
`;

