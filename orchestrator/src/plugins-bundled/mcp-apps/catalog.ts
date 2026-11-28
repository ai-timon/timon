/**
 * The Apps catalogue: the reviewed entries of `catalog/`, validated once at
 * load. Imported rather than read from disk so that the compiler ships the
 * files next to this module and the release inventory signs them with it.
 *
 * Adding a publisher (docs/MCP-APPS.md §5): its JSON file in `catalog/`, one
 * import line here — `catalog.test.ts` refuses a file left out.
 */
import airtable from './catalog/airtable.json' with { type: 'json' };
import atlassian from './catalog/atlassian.json' with { type: 'json' };
import canva from './catalog/canva.json' with { type: 'json' };
import cloudflare from './catalog/cloudflare.json' with { type: 'json' };
import context7 from './catalog/context7.json' with { type: 'json' };
import github from './catalog/github.json' with { type: 'json' };
import gitlab from './catalog/gitlab.json' with { type: 'json' };
import huggingface from './catalog/huggingface.json' with { type: 'json' };
import linear from './catalog/linear.json' with { type: 'json' };
import miro from './catalog/miro.json' with { type: 'json' };
import monday from './catalog/monday.json' with { type: 'json' };
import neon from './catalog/neon.json' with { type: 'json' };
import notion from './catalog/notion.json' with { type: 'json' };
import parallel from './catalog/parallel.json' with { type: 'json' };
import paypal from './catalog/paypal.json' with { type: 'json' };
import posthog from './catalog/posthog.json' with { type: 'json' };
import sentry from './catalog/sentry.json' with { type: 'json' };
import stripe from './catalog/stripe.json' with { type: 'json' };
import supabase from './catalog/supabase.json' with { type: 'json' };
import vercel from './catalog/vercel.json' with { type: 'json' };
import webflow from './catalog/webflow.json' with { type: 'json' };
import { appEntrySchema, type AppEntry } from './schema.js';

const RAW: readonly unknown[] = [airtable, atlassian, canva, cloudflare, context7, github, gitlab, huggingface, linear, miro, monday, neon, notion, parallel, paypal, posthog, sentry, stripe, supabase, vercel, webflow];

function load(raw: readonly unknown[]): readonly AppEntry[] {
  const seen = new Set<string>();
  const out: AppEntry[] = [];
  for (const item of raw) {
    const entry = appEntrySchema.parse(item);
    if (seen.has(entry.slug)) throw new Error(`mcp-apps: duplicate slug ${entry.slug}`);
    seen.add(entry.slug);
    out.push(Object.freeze(entry));
  }
  return Object.freeze(out.sort((a, b) => a.name.localeCompare(b.name)));
}

export const APP_CATALOG: readonly AppEntry[] = load(RAW);

export function appEntry(slug: string): AppEntry | undefined {
  return APP_CATALOG.find((entry) => entry.slug === slug);
}

/** The MCP server id an app is connected under: `app-<slug>`. */
export function appServerId(slug: string): string {
  return `app-${slug}`;
}
