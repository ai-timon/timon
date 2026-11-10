/**
 * Small chat formatters, shared between the page and its extracted panels.
 *
 * Moved as is from `chat-client.tsx`: the missions rail uses them, the page
 * too, and an extracted panel cannot import them back from the page without
 * creating a cycle.
 */

import { contextWindowFor, declaredContextWindowFor, type BackendCatalog, type BackendName } from '@/lib/backends';
import { formatAgeShort } from '@/lib/intl';

/** First line of an agent prompt looks like `TASK_ID: <uuid>` for missions
 *  spawned by the Kanban dispatcher. Strip that preamble so the rail never
 *  shows the raw id when no `task_title` came back from the API. */
export function stripTaskIdPreamble(s: string): string {
  return s.replace(/^TASK_ID:\s*[0-9a-f-]{8,}\s*\n+/i, '').trim();
}

export function paletteFor(name: string) {
  const c = [
    'hsl(var(--primary))',
    'hsl(var(--agenda-2))',
    'hsl(var(--agenda-3))',
    'hsl(var(--agenda-4))',
    'hsl(var(--agenda-5))',
    'hsl(var(--agenda-6))',
    'hsl(var(--salmon-2))',
    'hsl(var(--success))',
  ];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return c[h % c.length]!;
}

/** How old an event is, in the narrowest units of the language (`12m`, `3h`, `3j`). */
export function fmtRelativeShort(ms: number): string {
  return formatAgeShort(Math.max(0, Date.now() - ms));
}

export function fmtSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** Short form of a model slug: `claude-opus-5-20260601` → `opus-5`.
 *  Used to match the runtime's versioned id with the bare id that
 *  `system:init` may return, without a lookup table. */
export function shortModelSlug(slug: string): string {
  return slug.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/**
 * Context window of the model that will produce the NEXT turn, or `null`
 * when no one knows it from a reliable source.
 *
 * Resolution order, most to least reliable:
 *   0. a window the user typed by hand in Settings → AI models → Providers. It exists
 *      because the automatic figure was wrong for them (TODO #175: a runtime
 *      or a catalogue that does not know their plan), so it wins over both;
 *   1. `reported` — what the RUNTIME said (`result.modelUsage[*].contextWindow`).
 *      Correct by construction, even for a model released after this build;
 *   2. the orchestrator's catalog (the profiles' declared windows), the only fallback for
 *      backends whose stream carries no window — verified for codex, whose
 *      `turn.completed.usage` only reports token counters.
 *
 * No third tier: a blind `?? 200_000` displays a made-up denominator, which
 * is exactly the bug being removed here. Unknown → `null`, and the caller
 * displays the tokens with no denominator.
 *
 * `model` is the alias selected for the mission (what the user chose),
 * `observed` the full id reported by the CLI. We try `model` first, so the
 * limit follows a switch EVEN BEFORE the new model's first turn; `observed`
 * takes over when the alias isn't resolvable (`opus-5` isn't `opus`).
 */
export function contextLimitFor(
  catalog: BackendCatalog,
  backend: BackendName,
  model: string | null,
  observed: string | null,
  reported: Record<string, number>,
): number | null {
  for (const slug of [model, observed]) {
    if (!slug) continue;
    const declared = declaredContextWindowFor(catalog, backend, slug);
    if (declared) return declared;
    const fromRuntime = reported[slug] ?? reported[shortModelSlug(slug)];
    if (fromRuntime) return fromRuntime;
    const fromCatalog = contextWindowFor(catalog, backend, slug);
    if (fromCatalog) return fromCatalog;
  }
  return null;
}

/** Share of the context window the compaction nudge reads, or `null` while it
 *  cannot be trusted. The chat mounts with a placeholder agent whose model is the
 *  backend default, not the agent's own: a window sized on it (200k for an Opus
 *  mission at 1M) fires the one-shot nudge at a made-up percentage before the
 *  agent's details land, and the gauge corrects itself right after. */
export function contextNudgePct(ctxUsed: number, configured: number | null, agentSettled: boolean): number | null {
  if (!agentSettled || !ctxUsed || !configured) return null;
  const limit = ctxUsed > configured ? nextStandardLimit(ctxUsed) : configured;
  return Math.min(100, (ctxUsed / limit) * 100);
}

/** Round up to the next standard context-window tier. A safety net AFTER a
 *  KNOWN limit that observed usage already exceeds (stale catalog) —
 *  otherwise the status line would stay stuck at 100%. Never called when no
 *  limit is known: it would produce a made-up denominator. */
export function nextStandardLimit(observed: number): number {
  const tiers = [200_000, 400_000, 500_000, 1_000_000, 2_000_000, 5_000_000];
  for (const t of tiers) if (t >= observed) return t;
  return Math.ceil(observed / 1_000_000) * 1_000_000;
}
