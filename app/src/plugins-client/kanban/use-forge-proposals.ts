'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { sseOn } from '@/lib/sse-stream';
import { isPending, listProposals, type ForgeProposal } from './forge-proposals-api';

/**
 * The proposals waiting for a person, per project, read once for the whole
 * page: the Jobs and PR widgets, their tabs and every TO DO row linked to an
 * issue ask for the same list, and a row each would ask the daemon as many
 * times. The daemon raises a notification with each proposal and closes it
 * once published or discarded, so `notifications_changed` is the signal to
 * read them again. A project the reader may not manage answers a refusal: it
 * simply has none here.
 *
 * A project nobody on the page asks for any more is forgotten, so the next
 * one to ask reads it fresh.
 */
type Entry = { pending: ForgeProposal[]; readers: number; ask: number };

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
let stopSignal: (() => void) | null = null;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function read(slug: string): void {
  const entry = entries.get(slug);
  if (!entry) return;
  const ask = ++entry.ask;
  void listProposals(slug).then((out) => {
    const current = entries.get(slug);
    // A later read, or a project forgotten meanwhile, wins over this answer.
    if (current !== entry || ask !== entry.ask) return;
    entry.pending = out.ok ? out.value.filter(isPending) : [];
    changed();
  });
}

function hold(slugs: readonly string[]): () => void {
  for (const slug of slugs) {
    const entry = entries.get(slug);
    if (entry) { entry.readers += 1; continue; }
    entries.set(slug, { pending: [], readers: 1, ask: 0 });
    read(slug);
  }
  stopSignal ??= sseOn('notifications_changed', () => { for (const slug of entries.keys()) read(slug); });
  return () => {
    for (const slug of slugs) {
      const entry = entries.get(slug);
      if (entry && --entry.readers <= 0) entries.delete(slug);
    }
    if (entries.size === 0 && stopSignal) { stopSignal(); stopSignal = null; }
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => version;

export function useForgeProposals(projects: readonly string[]): { pending: ForgeProposal[]; reload: () => void } {
  const key = [...new Set(projects.filter(Boolean))].sort().join('\n');
  const at = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => (key ? hold(key.split('\n')) : undefined), [key]);
  const pending = useMemo(
    () => (key ? key.split('\n').flatMap((slug) => entries.get(slug)?.pending ?? []) : []),
    // `at` moves with every answer the store keeps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, at],
  );
  const reload = useCallback(() => { if (key) for (const slug of key.split('\n')) read(slug); }, [key]);
  return { pending, reload };
}
