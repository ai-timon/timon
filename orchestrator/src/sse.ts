import type { Request, Response } from 'express';
import { bus, busEventListenerCount, type BusEvent } from './bus.js';
import { trackDeviceConnection } from './users/device-connections.js';
import { dbApi } from './db.js';
import { viewerFromRequest } from './users/identity.js';
import { viewerSeesAll } from './users/owned.js';
import { scopedDb } from './users/scoped-db.js';
import { filterGallery } from './users/surfaces.js';
import { apiError } from './api-error.js';
import { integrationVisibleTo } from './integration-visibility.js';

// Defence in depth: if for some unforeseen reason `seen` grew
// beyond the replay window, it is purged rather than left to leak.
const SEEN_HARD_CAP = 50_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// A per-mission stream used to replay the WHOLE history on every (re)connect:
// a long mission is thousands of rows and megabytes of payload, per open tab,
// per EventSource auto-reconnect. The chat already loads the full history from
// GET /api/missions/:id and dedups on ingest, so the stream only needs a tail
// wide enough to cover the gap between that fetch and the stream opening.
const replayLimit = () => envInt('TIMON_SSE_REPLAY_LIMIT', 500);
// Hard ceiling on simultaneous streams (each holds a bus listener, a timer and
// a socket). Past it we refuse loudly instead of leaking the daemon to an OOM.
const maxClients = () => envInt('TIMON_SSE_MAX_CLIENTS', 200);
// A stalled reader (dead proxy, paused tab) makes `res.write` queue in memory
// without bound. Crossing this backlog only arms a timer: one big event (a
// 22 MB pasted prompt) is queued whole by a synchronous write before the
// socket had a chance to drain, and dropping on that alone sent the client
// into a reconnect loop that never let a live event through.
const maxBufferedBytes = () => envInt('TIMON_SSE_MAX_BUFFERED_BYTES', 8 * 1024 * 1024);
// The backlog must still be above `maxBufferedBytes` this long after it
// crossed it, with no 'drain' in between, for the reader to count as stalled.
const stallMs = () => envInt('TIMON_SSE_STALL_MS', 30_000);
// Past this backlog the client is dropped at once: the grace period above must
// not let one tab pin the daemon's heap.
const hardMaxBufferedBytes = () => envInt('TIMON_SSE_HARD_MAX_BUFFERED_BYTES', 64 * 1024 * 1024);
// The hard ceiling always wins: a soft ceiling configured at or past it is
// clamped under it, so no setting can turn the grace period into a way around
// the heap guard.
const softMaxBufferedBytes = () => Math.min(maxBufferedBytes(), hardMaxBufferedBytes());
// The tail replay is also bounded in bytes: a row count says nothing about a
// row carrying base64 attachments.
const replayMaxBytes = () => envInt('TIMON_SSE_REPLAY_MAX_BYTES', 4 * 1024 * 1024);
// `setMaxListeners(0)` on the bus hides Node's leak warning, so we warn
// ourselves once the subscriber count is suspicious.
const listenerWarnAt = () => envInt('TIMON_SSE_LISTENER_WARN', 100);
const WARN_INTERVAL_MS = 60_000;
// Keep-alive cadence; it is also the clock of the unread-reader check below.
const pingMs = () => envInt('TIMON_SSE_PING_MS', 15_000);
// A reader that is alive reads: its backlog empties within milliseconds on a
// loopback socket. One whose backlog has not been empty at any ping for this
// long is not reading at all (a proxy that lost the response and never cancels
// it, a frozen renderer) — and, at a few bytes of ping per minute, it would
// take hours to reach the byte ceilings above. Dropping it frees the listener,
// the timer and the socket; EventSource reconnects if it was a live client.
const unreadEvictMs = () => envInt('TIMON_SSE_UNREAD_EVICT_MS', 5 * 60_000);
// A window names its streams (`?client=<id>`, one per scope): a reconnect or a
// reload replaces the stream it supersedes instead of stacking next to it.
const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

let activeClients = 0;
let lastGaugeWarnAt = 0;
// Live streams that named themselves, by viewer + client id + scope. The viewer
// is part of the key: an id is not a secret, so one user must not be able to
// close another's stream by sending its id.
const namedStreams = new Map<string, () => void>();

// The bus hands the same object to every listener, so a frame serialised for
// the first client serves all the others: 177 streams used to mean 177
// `JSON.stringify` of the same event on the thread that also serves the API.
const sharedJson = new WeakMap<object, string>();
function jsonOf(body: object, shared: boolean): string {
  if (!shared) return JSON.stringify(body);
  let json = sharedJson.get(body);
  if (json === undefined) {
    json = JSON.stringify(body);
    sharedJson.set(body, json);
  }
  return json;
}


/**
 * One stamp per turn, shared by every open stream. Computed per connection, it
 * gave each window its own `at`, so the clients' sound key differed and two
 * windows both played the "turn done" sound. The bus hands the same event
 * object to every listener, which is what the map is keyed on.
 */
const turnDoneStamps = new WeakMap<object, number>();
export function turnDoneStamp(ev: object): number {
  let at = turnDoneStamps.get(ev);
  if (at === undefined) { at = Date.now(); turnDoneStamps.set(ev, at); }
  return at;
}

/**
 * Permission cards travel in an `event` frame, which the agent views do not
 * parse: they listen for these names to refetch an agent's state at once,
 * instead of waiting for their next poll. Same body for every stream, so the
 * alias is cached on the bus event like the frame it echoes.
 */
const PERMISSION_STATE_TYPES: ReadonlySet<string> = new Set(['permission_request', 'permission_resolved', 'permission_expired']);
const permissionAliases = new WeakMap<object, object>();
function permissionAlias(ev: { type: string; missionId: string }): object {
  let alias = permissionAliases.get(ev);
  if (!alias) { alias = { kind: ev.type, missionId: ev.missionId }; permissionAliases.set(ev, alias); }
  return alias;
}

export function sseGauge(): { clients: number; busEventListeners: number } {
  return { clients: activeClients, busEventListeners: busEventListenerCount() };
}

function warnOnListenerGrowth(): void {
  const g = sseGauge();
  if (g.busEventListeners < listenerWarnAt()) return;
  const now = Date.now();
  if (now - lastGaugeWarnAt < WARN_INTERVAL_MS) return;
  lastGaugeWarnAt = now;
  process.stderr.write(
    `[sse] bus 'event' listeners=${g.busEventListeners} sse_clients=${g.clients} — ` +
      `a gap between the two means a subscriber is leaking\n`,
  );
}

export function sseHandler(req: Request, res: Response): void {
  const missionId = req.params.id;
  const filter = typeof missionId === 'string' && missionId.length > 0 ? missionId : null;
  const viewer = viewerFromRequest(req);
  const scope = scopedDb(viewer);

  // Per-mission stream: a signed-in non-owner must not learn that the
  // mission exists (404, not 403). Superadmin / :all / anonymous loopback
  // keep the historical open stream — same rule as the other read routes.
  if (filter && viewer && !viewerSeesAll(viewer, 'missions')) {
    if (!scope.getMission(filter)) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
  }

  // Replace before counting: a window re-opening its stream must never be
  // refused because its own stale stream still holds the slot.
  // `?topics=notifications`: the global stream reduced to the notification
  // signal — what another daemon's push relay listens to, over a WAN link.
  const notificationsOnly = !filter && req.query?.topics === 'notifications';
  const clientParam = req.query?.client;
  const clientId = typeof clientParam === 'string' && CLIENT_ID.test(clientParam) ? clientParam : null;
  const streamKey = clientId ? `${viewer?.id ?? ''}|${clientId}|${filter ?? '*'}` : null;
  if (streamKey) namedStreams.get(streamKey)?.();

  if (activeClients >= maxClients()) {
    process.stderr.write(`[sse] refused: ${activeClients} clients already connected (cap ${maxClients()})\n`);
    res.set('Retry-After', '5');
    res.status(503).json({ error: 'too many event streams', limit: maxClients() });
    return;
  }
  activeClients += 1;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let ping: ReturnType<typeof setInterval> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let cleanedUp = false;
  // First ping at which the backlog was found non-empty, and still has not
  // been found empty since.
  let unreadSince: number | null = null;
  const clearStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  };
  const onDrain = () => {
    clearStall();
    unreadSince = null;
  };
  let untrackDevice: (() => void) | null = null;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    activeClients -= 1;
    if (ping) clearInterval(ping);
    clearStall();
    res.off('drain', onDrain);
    bus.off('event', send);
    if (streamKey && namedStreams.get(streamKey) === evict) namedStreams.delete(streamKey);
    untrackDevice?.();
  };
  res.on('drain', onDrain);

  const queued = (): number => (typeof res.writableLength === 'number' ? res.writableLength : 0);
  // `destroy`, not `end`: `end` waits for the backlog to drain before closing,
  // and a reader that is not reading never drains it — the socket would stay
  // open after its slot and listener were released.
  const evict = () => {
    cleanup();
    res.destroy();
  };
  const drop = (why: string) => {
    process.stderr.write(`[sse] dropping ${why} client (${queued()} bytes queued)\n`);
    evict();
  };
  if (streamKey) namedStreams.set(streamKey, evict);
  // A paired device's stream ends with the device (revoked, expired).
  if (req.auth?.kind === 'device' && req.auth.deviceId) {
    untrackDevice = trackDeviceConnection(req.auth.deviceId, 'events', evict);
  }

  // `shared`: `body` is the bus event itself, identical for every client.
  const writeEvent = (kind: string, body: object, shared = false): boolean => {
    if (cleanedUp) return false;
    try {
      res.write(`event: ${kind}\n`);
      res.write(`data: ${jsonOf(body, shared)}\n\n`);
      const backlog = queued();
      if (backlog > hardMaxBufferedBytes()) {
        drop('overflowing');
        return false;
      }
      if (backlog > softMaxBufferedBytes() && !stallTimer) {
        stallTimer = setTimeout(() => {
          stallTimer = null;
          if (!cleanedUp && queued() > softMaxBufferedBytes()) drop('stalled');
        }, stallMs());
        stallTimer.unref?.();
      }
      return true;
    } catch {
      // dead socket (proxy cut, tab closed without a reliable `close`): release.
      cleanup();
      return false;
    }
  };

  // (type, timestamp) dedup key — handleLine publishes events with the same
  // timestamp it just persisted, so we can match replay rows against live bus
  // hits without needing a sequence id.
  //
  // `seen` is used ONLY for per-mission streams, and ONLY to
  // deduplicate the DB replay against the live events falling within the replay
  // window. It therefore stays bounded by the number of replayed rows. On a
  // global stream (`filter === null`) there is no replay: it is never touched,
  // otherwise it would grow forever with the system's total event throughput.
  const seen = new Set<string>();
  const key = (type: string, ts: number) => `${type}@${ts}`;
  // Highest timestamp replayed from the DB. Only live events whose
  // timestamp is <= this bound can duplicate a row already replayed;
  // any strictly more recent event is written directly, without entering `seen`.
  let replayHighWater = -Infinity;
  // Disabled outright on the global stream, and disabled once the replay
  // window is passed (no duplicate possible any more).
  let dedupActive = filter !== null;

  // Buffer live events that arrive while we're still replaying, then drain
  // them in order. After draining we switch to direct write.
  const buffer: BusEvent[] = [];
  let draining = true;

  // Ownership memo for the life of this connection. The global stream
  // (`/api/stream`) sees every bus event; a getMission per push would
  // hammer sqlite from every open tab. `mission_start` drops the entry
  // so a row created after we first saw the id is re-checked.
  const owned = new Map<string, boolean>();
  const missionVisible = (id: string, invalidate = false): boolean => {
    if (!viewer || viewerSeesAll(viewer, 'missions')) return true;
    if (invalidate) owned.delete(id);
    const cached = owned.get(id);
    if (cached !== undefined) return cached;
    const ok = Boolean(scope.getMission(id));
    owned.set(id, ok);
    return ok;
  };

  const send = (ev: BusEvent) => {
    if (notificationsOnly && ev.kind !== 'notifications_changed') return;
    if (ev.kind === 'ui_navigate') {
      // The owner's own screen: no `:all` view lets another account's browser follow it.
      if (filter !== null || !viewer || viewer.id !== ev.ownerUserId) return;
      writeEvent('ui_navigate', { path: ev.path, params: ev.params });
      return;
    }
    if (ev.kind === 'plugin_realtime') {
      if (filter !== null || !viewer || viewer.id !== ev.ownerUserId) return;
      writeEvent(`plugin:${ev.pluginId}:${ev.topic}`, {
        plugin: ev.pluginId, topic: ev.topic, payload: ev.payload,
      });
      return;
    }
    // notifications_changed has no missionId: relevant only for the
    // global stream (no mission filter) that feeds the notification column.
    if (ev.kind === 'notifications_changed') {
      if (filter) return;
      if (viewer && !viewerSeesAll(viewer, 'notifications')) {
        if (ev.ownerUserId !== viewer.id) return;
      }
      writeEvent('notifications_changed', ev, true);
      return;
    }
    // plugins_changed has no missionId: the front listens to it on the
    // global stream to recompose the slots, not on a mission's chat.
    if (ev.kind === 'plugins_changed') {
      if (filter) return;
      writeEvent('plugins_changed', { ...ev, plugins: filterGallery(ev.plugins, viewer) });
      return;
    }
    // backends_changed: global stream only, like plugins_changed. The
    // catalogue itself stays behind its endpoint — the event only says
    // "read it again", it carries no provider data.
    if (ev.kind === 'backends_changed') {
      if (filter) return;
      writeEvent('backends_changed', ev, true);
      return;
    }
    // license_changed : flux global uniquement, comme plugins_changed.
    if (ev.kind === 'license_changed') {
      if (filter) return;
      writeEvent('license_changed', ev, true);
      return;
    }
    // update_available: global stream only. It carries a public version and
    // channel, nothing more; the offer stays behind `GET /api/updates`.
    if (ev.kind === 'update_available') {
      if (filter) return;
      writeEvent('update_available', ev, true);
      return;
    }
    // A task closure reaches the global stream only, and only for a viewer
    // who can read the task. The body is the id alone: the blocking reason
    // stays behind the task route, the sound and badge clients need nothing
    // more than "it closed".
    if (ev.kind === 'task_done' || ev.kind === 'task_blocked') {
      if (filter) return;
      if (viewer && !viewerSeesAll(viewer, 'tasks') && !scope.getTask(ev.taskId)) return;
      writeEvent(ev.kind, { kind: ev.kind, taskId: ev.taskId });
      return;
    }
    // A job's landing moved: global stream only, for a viewer who may read the
    // job through its routes (same rule, re-read now: a job's series may have
    // changed hands since the stream opened). The event carries ids and the
    // state alone; the screens read the job again behind its scoped route.
    if (ev.kind === 'integration_changed') {
      if (filter) return;
      const row = dbApi.getIntegrationById(ev.integrationId);
      if (!row || !integrationVisibleTo(viewer, row)) return;
      writeEvent('integration_changed', ev, true);
      return;
    }
    // A task's first start, for its opt-in sound and toast: the owner's own
    // tasks only — an admin who reads every task does not hear another
    // account's work begin. An unowned (system) task goes to whoever reads all
    // tasks. Follow-ups (review, merge, doc, iteration) stay silent: one
    // feature would otherwise announce itself four times. The title travels,
    // for the toast: the viewer passed the read check.
    if (ev.kind === 'task_started') {
      if (filter || ev.followUp) return;
      // The scoped read already hides an unowned task from a viewer without `tasks:all`.
      const task = scope.getTask(ev.taskId);
      if (!task) return;
      if (viewer && task.owner_user_id && task.owner_user_id !== viewer.id) return;
      writeEvent('task_started', { kind: 'task_started', taskId: ev.taskId, title: task.title });
      return;
    }
    // task_unblocked has no missionId.
    if (!('missionId' in ev)) return;
    // Partial text: reserved for the stream of ONE mission, that of the open chat. The
    // global stream (/events page, notifications column) shows none of it —
    // pushing it there would send thousands of fragments per turn and per open
    // tab, for nothing.
    if (!filter && ev.kind === 'event_delta') return;
    if (filter && ev.missionId !== filter) return;
    const started = ev.kind === 'event' && ev.type === 'mission_start';
    if (!filter && !missionVisible(ev.missionId, started)) return;
    if (draining) {
      buffer.push(ev);
      return;
    }
    if (ev.kind === 'event' && dedupActive) {
      if (ev.timestamp <= replayHighWater) {
        // Within the replay window: may duplicate a row already replayed.
        const k = key(ev.type, ev.timestamp);
        if (seen.has(k)) return;
        seen.add(k);
        if (seen.size > SEEN_HARD_CAP) {
          seen.clear();
          dedupActive = false;
        }
      } else {
        // Strictly more recent than everything replayed: no duplicate
        // possible here or after. Purge and switch dedup off for good.
        seen.clear();
        dedupActive = false;
      }
    }
    writeEvent(ev.kind, ev, true);
    if (!filter && ev.kind === 'event' && PERMISSION_STATE_TYPES.has(ev.type)) {
      writeEvent(ev.type, permissionAlias(ev), true);
    }
    // "The agent finished its turn", for the sound of the same name: only a
    // conversation someone started — a Kanban task's mission already has its
    // own done/blocked sound — and only a turn that did not fail. A name of its
    // own, since `turn_complete` carries no task and its body is shared.
    if (!filter && ev.kind === 'turn_complete' && ev.outcome !== 'failed' && ev.outcome !== 'cancelled') {
      const mission = scope.getMission(ev.missionId);
      if (mission && !mission.task_id) {
        writeEvent('mission_turn_done', { kind: 'mission_turn_done', missionId: ev.missionId, at: turnDoneStamp(ev) });
      }
    }
  };
  bus.on('event', send);
  warnOnListenerGrowth();

  // Replay the tail of what we have so far for this mission. Without this the
  // chat client races: it opens the stream AFTER the POST returns, but claude
  // may have already emitted assistant + result events between spawn and
  // reply, leaving the UI stuck on "thinking…".
  if (filter) {
    try {
      const rows = dbApi.listEventsTail(filter, replayLimit());
      // Newest rows first, until the byte budget is spent. A row larger than
      // the whole budget is skipped rather than ending the replay: the chat
      // already holds it from GET /api/missions/:id.
      const budget = replayMaxBytes();
      let spent = 0;
      let skipped = 0;
      const kept: typeof rows = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (!row) continue;
        const size = Buffer.byteLength(row.payload);
        if (size > budget) {
          skipped += 1;
          continue;
        }
        if (spent + size > budget) break;
        spent += size;
        kept.push(row);
      }
      kept.reverse();
      if (kept.length < rows.length) {
        process.stderr.write(
          `[sse] replay of ${filter} trimmed to ${kept.length}/${rows.length} rows, ${spent} bytes ` +
            `(${skipped} oversized rows skipped)\n`,
        );
      }
      for (const row of kept) {
        let payload: unknown = null;
        try {
          payload = JSON.parse(row.payload);
        } catch {}
        seen.add(key(row.type, row.timestamp));
        if (row.timestamp > replayHighWater) replayHighWater = row.timestamp;
        writeEvent('event', {
          kind: 'event',
          missionId: filter,
          type: row.type,
          timestamp: row.timestamp,
          payload,
          id: row.id,
        });
      }
      const mission = scope.getMission(filter);
      if (mission && mission.status !== 'running') {
        writeEvent('mission_complete', {
          kind: 'mission_complete',
          missionId: filter,
          status: mission.status,
          exitCode: mission.exit_code,
        });
      }
    } catch (err) {
      process.stderr.write(`[sse] replay failed: ${(err as Error).message}\n`);
    }
  }

  // Drain anything that hit the bus while we were replaying.
  draining = false;
  for (const ev of buffer) send(ev);
  buffer.length = 0;
  // A client dropped during the replay is already cleaned up: a timer armed
  // now would never be cleared.
  if (cleanedUp) return;
  ping = setInterval(() => {
    const backlog = queued();
    if (backlog === 0) {
      unreadSince = null;
    } else {
      const now = Date.now();
      unreadSince ??= now;
      if (now - unreadSince >= unreadEvictMs()) {
        drop('unread');
        return;
      }
    }
    // A failing ping = dead socket behind a proxy that did not propagate
    // the `close`. We trigger the cleanup ourselves.
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, pingMs());

  // `req.on('close')` is not reliable behind the Next.js proxy + EventSource
  // auto-reconnection: the guards are doubled on the `res` side. cleanup() is idempotent.
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}
