'use client';

/**
 * `integration_changed`: the daemon's word that a job's landing moved (its
 * branch recorded, its pull request opened, merged or closed, its checks read
 * anew, its landing replayed). The stream only carries it to a reader who may
 * see the job, with its ids and state; each surface reads the job again
 * through its own scoped route.
 *
 * Several changes come in a burst (a merge, then its landing; a poll that
 * reads several pull requests), so they are gathered: a surface reloads once
 * after a short quiet window, and a steady trickle still reloads it within
 * `LANDING_MAX_WAIT_MS`. A slow poll stays behind it, for what a stream that
 * was reconnecting did not hear.
 */

import { useEffect, useRef } from 'react';
import { sseOn } from '@/lib/sse-stream';

export const LANDING_EVENT = 'integration_changed';

export type LandingChangeKind = 'created' | 'state' | 'pull_request' | 'checks' | 'landed';

export type LandingChange = {
  integrationId: string;
  project: string | null;
  seriesId: string | null;
  state: string;
  changed: LandingChangeKind[];
};

/** Quiet window after the last change of a burst. */
export const LANDING_COALESCE_MS = 400;
/** Longest a steady trickle of changes holds a reload back. */
export const LANDING_MAX_WAIT_MS = 2_000;
/** The slow poll behind the stream. */
export const LANDING_FALLBACK_POLL_MS = 5 * 60_000;

const KINDS: ReadonlySet<string> = new Set(['created', 'state', 'pull_request', 'checks', 'landed']);

/** The event's body, or null for anything that is not one. */
export function parseLandingChange(data: unknown): LandingChange | null {
  let body: unknown = data;
  if (typeof data === 'string') {
    try { body = JSON.parse(data); } catch { return null; }
  }
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.integrationId !== 'string' || typeof b.state !== 'string' || !Array.isArray(b.changed)) return null;
  const optional = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    integrationId: b.integrationId,
    project: optional(b.project),
    seriesId: optional(b.seriesId),
    state: b.state,
    changed: b.changed.filter((c): c is LandingChangeKind => typeof c === 'string' && KINDS.has(c)),
  };
}

/** A change an idea's landing badge shows: its checks are not on it. */
export function movesTodoLanding(change: LandingChange): boolean {
  return change.changed.some((c) => c !== 'checks');
}

/** A change of `project`'s jobs; every project's when none is picked. */
export function inProject(project: string | null): (change: LandingChange) => boolean {
  return (change) => project === null || change.project === project;
}

type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
  now: () => number;
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export type LandingSubscriptionOptions = {
  /** Which changes matter to the surface; all of them by default. */
  filter?: (change: LandingChange) => boolean;
  /** Stand-ins for the stream and the clock: tests drive them. */
  on?: (type: string, fn: (event: MessageEvent) => void) => () => void;
  timers?: Timers;
};

/**
 * Calls `onBatch` once per burst with the changes the filter kept. Returns the
 * unsubscription, which also drops a batch still waiting.
 */
export function subscribeLandingChanges(
  onBatch: (changes: LandingChange[]) => void,
  options: LandingSubscriptionOptions = {},
): () => void {
  const timers = options.timers ?? realTimers;
  const filter = options.filter ?? (() => true);
  let batch: LandingChange[] = [];
  let timer: unknown = null;
  let firstAt = 0;
  let stopped = false;

  const flush = () => {
    timer = null;
    const out = batch;
    batch = [];
    if (!stopped && out.length > 0) onBatch(out);
  };

  const stop = (options.on ?? sseOn)(LANDING_EVENT, (event) => {
    const change = parseLandingChange(event.data);
    if (!change || !filter(change)) return;
    const now = timers.now();
    if (batch.length === 0) firstAt = now;
    batch.push(change);
    if (timer !== null) timers.clear(timer);
    const wait = Math.max(0, Math.min(LANDING_COALESCE_MS, firstAt + LANDING_MAX_WAIT_MS - now));
    timer = timers.set(flush, wait);
  });

  return () => {
    stopped = true;
    stop();
    if (timer !== null) timers.clear(timer);
    timer = null;
    batch = [];
  };
}

/**
 * `subscribeLandingChanges` for a component. The latest `onBatch` and `filter`
 * are read when a burst ends, so a re-render does not resubscribe; `key`
 * (a project, say) drops a burst gathered for the previous one.
 */
export function useLandingChanges(
  onBatch: (changes: LandingChange[]) => void,
  filter?: (change: LandingChange) => boolean,
  key: string | null = null,
): void {
  const latest = useRef({ onBatch, filter });
  latest.current = { onBatch, filter };
  useEffect(() => subscribeLandingChanges(
    (changes) => latest.current.onBatch(changes),
    { filter: (change) => latest.current.filter?.(change) ?? true },
  ), [key]);
}

/** Reads again every `LANDING_FALLBACK_POLL_MS` while the page is in front. */
export function useLandingFallbackPoll(reload: () => void, everyMs: number = LANDING_FALLBACK_POLL_MS): void {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      latest.current();
    }, everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
}
