/**
 * Web terminal — REST routes (status, list, create, kill) and the WebSocket
 * upgrade that carries the stream.
 *
 *   GET    /api/terminal/web                    status, persistence (host / in-process / not-started), the caller's sessions
 *   POST   /api/terminal/web/sessions           { cwd?, cols?, rows? }
 *   DELETE /api/terminal/web/sessions/:id
 *   POST   /api/terminal/web/proposals          an agent proposes a command (proposals.ts)
 *   GET    /api/terminal/web/sessions/:id/ws    WebSocket upgrade
 *
 * Wire protocol (JSON text frames):
 *   client → server  { type: 'input', data } | { type: 'resize', cols, rows }
 *   server → client  { type: 'output', data } | { type: 'exit', code }
 */
import type { IncomingMessage } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import type { Request, Router } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { dbApi } from '../../db.js';
import { getAgent } from '../../agent.js';
import { readMeta } from '../../projects.js';
import { isKnownCwd } from '../../terminal.js';
import { auditRequest } from '../../users/audit-actor.js';
import { trackDeviceConnection } from '../../users/device-connections.js';
import { decideAccess, denialBody, denialStatus, isSameOriginUpgrade } from './access.js';
import type { RequestAuth } from '../../users/identity.js';
import type { UpgradeRoute } from '../../kernel/http-service.js';
import { TerminalLimitError, type ServerMessage } from '../../terminal-host/sessions.js';
import { loadNodePty } from '../../terminal-host/pty.js';
import { defaultCwd, resolveShell, shellEnv } from './shell.js';
import { registerProposalRoute } from './proposals.js';
import type { AttachHandle, SessionStore } from './store.js';
import { apiError } from '../../api-error.js';

/** Same shapes as a project slug and an agent name elsewhere in the daemon. */
const ScopeBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project'), slug: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/) }),
  z.object({ kind: z.literal('agent'), name: z.string().min(1).max(128) }),
]);

const CreateBody = z.object({
  cwd: z.string().max(4096).optional(),
  scope: ScopeBody.optional(),
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
}).strict();

const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(65_536) }),
  z.object({ type: z.literal('resize'), cols: z.number(), rows: z.number() }),
]);

/** Matches the stream path; the id is a UUID, nothing else is accepted. */
const WS_PATH_RE = /^\/api\/terminal\/web\/sessions\/([0-9a-f-]{36})\/ws(?:\?.*)?$/i;

export function matchTerminalWsPath(url: string | undefined): string | null {
  if (!url) return null;
  const m = WS_PATH_RE.exec(url);
  return m ? m[1]!.toLowerCase() : null;
}

/** Heartbeat: a phone that vanished without a FIN must detach, or the idle reap never starts. */
const PING_MS = 30_000;

export function registerRoutes(app: Router, sessions: SessionStore): void {
  registerProposalRoute(app);
  app.get('/api/terminal/web', async (req, res) => {
    if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    const access = decideAccess(req.auth);
    if ('denied' in access) {
      res.json({ enabled: false, reason: access.denied, sessions: [] });
      return;
    }
    if (!loadNodePty()) {
      res.json({ enabled: false, reason: 'pty_unavailable', sessions: [] });
      return;
    }
    try {
      // `persistence` tells whether the shells survive a daemon restart.
      const persistence = await sessions.persistence();
      res.json({ enabled: true, persistence, sessions: await sessions.list(access.user.id) });
    } catch (err) {
      console.warn('[terminal-web] status failed:', (err as Error).message);
      res.status(500).json(apiError('terminal_status_failed', 'terminal status unavailable'));
    }
  });

  app.post('/api/terminal/web/sessions', async (req, res) => {
    const access = decideAccess(req.auth);
    if ('denied' in access) { res.status(denialStatus(access.denied)).json(denialBody(access.denied)); return; }
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json(apiError('invalid_request', 'invalid body')); return; }
    const requested = parsed.data.cwd?.trim();
    const scope = parsed.data.scope ?? null;
    let cwd = scope ? scopeCwd(scope) ?? defaultCwd() : defaultCwd();
    if (requested) {
      // The path comes from the client: only folders Timon already knows.
      if (!isKnownCwd(requested) || !isDirectory(requested)) {
        res.status(400).json(apiError('path_unknown', 'path unknown to Timon (neither an agent cwd nor a task worktree)'));
        return;
      }
      cwd = requested;
    }
    const { shell, args } = resolveShell();
    try {
      const session = await sessions.create(access.user.id, {
        shell, args, cwd, env: shellEnv(), cols: parsed.data.cols, rows: parsed.data.rows,
        scope: scope ? scopeKey(scope) : null,
      });
      auditRequest(req, 'terminal.open', session.id);
      res.status(201).json({ session });
    } catch (err) {
      if (err instanceof TerminalLimitError) { res.status(429).json(apiError('terminal_limit', err.message, { detail: err.message })); return; }
      const message = (err as Error).message;
      if (message === 'pty_unavailable') res.status(501).json(apiError('pty_unavailable', message));
      else res.status(500).json(apiError('terminal_start_failed', 'could not start the shell'));
    }
  });

  app.delete('/api/terminal/web/sessions/:id', async (req: Request<{ id: string }>, res) => {
    const access = decideAccess(req.auth);
    if ('denied' in access) { res.status(denialStatus(access.denied)).json(denialBody(access.denied)); return; }
    if (!(await sessions.kill(access.user.id, req.params.id))) { res.status(404).json(apiError('not_found', 'not found')); return; }
    auditRequest(req, 'terminal.close', req.params.id);
    res.json({ ok: true });
  });
}

type Scope = z.infer<typeof ScopeBody>;

export function scopeKey(scope: Scope): string {
  return scope.kind === 'project' ? `project:${scope.slug}` : `agent:${scope.name}`;
}

/**
 * The folder a shell of this scope starts in, resolved here rather than sent
 * by the browser: the project's folder, or the agent's working directory.
 * Null when it is unknown or gone — the shell then starts in the home folder.
 */
function scopeCwd(scope: Scope): string | null {
  try {
    const dir = scope.kind === 'project' ? readMeta(scope.slug).cwd : getAgent(scope.name)?.cwd;
    return dir && isDirectory(dir) ? dir : null;
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try { return existsSync(path) && statSync(path).isDirectory(); } catch { return false; }
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function peerIp(req: IncomingMessage): string | null {
  return req.socket.remoteAddress ?? null;
}

/**
 * The upgrade route for `@timon/http`. The kernel resolved the identity and
 * refused an anonymous upgrade already (`auth: 'required'`); every other
 * check happens here, BEFORE the WebSocket handshake completes: a refused
 * client gets a plain HTTP status and never a socket.
 */
export function createUpgradeHandler(sessions: SessionStore): UpgradeRoute & { close: () => void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

  const handle = (req: IncomingMessage, socket: Duplex, head: Buffer, auth: RequestAuth | undefined): void => {
    const id = matchTerminalWsPath(req.url);
    if (!id) { socket.destroy(); return; }
    if (!isSameOriginUpgrade(req)) { refuse(socket, 403, 'Forbidden'); return; }
    // Any identity is not enough for a shell: a person, with the permission,
    // and the setting on (`access.ts`).
    const access = decideAccess(auth);
    if ('denied' in access) {
      refuse(socket, denialStatus(access.denied), access.denied === 'unauthorized' ? 'Unauthorized' : 'Forbidden');
      return;
    }
    const ownerId = access.user.id;
    const deviceId = auth?.kind === 'device' ? auth.deviceId : undefined;
    // Claimed now, answered once the store has: the session may live in the terminal host.
    sessions.get(ownerId, id).then((found) => {
      if (!found) { refuse(socket, 404, 'Not Found'); return; }
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, (ws) => {
        // A shell opened by a paired device dies with the device.
        if (deviceId) {
          const untrack = trackDeviceConnection(deviceId, 'terminal', () => ws.close(1008, 'device revoked'));
          ws.once('close', untrack);
        }
        attachSocket(sessions, ownerId, id, ws);
        dbApi.insertAuditLog({ userId: ownerId, actor: null, action: 'terminal.attach', target: id, ip: peerIp(req) });
      });
    }, () => refuse(socket, 503, 'Service Unavailable'));
  };

  return {
    match: (req) => matchTerminalWsPath(req.url) !== null,
    auth: 'required',
    handle,
    close: () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

function attachSocket(sessions: SessionStore, ownerId: string, id: string, ws: WebSocket): void {
  const send = (message: ServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };
  // The attachment is asynchronous: keystrokes sent meanwhile wait for it.
  let handle: AttachHandle | null = null;
  let gone = false;
  const queued: Array<{ type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number }> = [];
  const apply = (msg: (typeof queued)[number]): void => {
    if (!handle) { queued.push(msg); return; }
    if (msg.type === 'input') handle.input(msg.data);
    else handle.resize(msg.cols, msg.rows);
  };
  sessions.attach(ownerId, id, { send, close: () => ws.close(1000, 'session closed') }).then((h) => {
    if (!h) { ws.close(1008, 'session not found'); return; }
    if (gone) { h.detach(); return; }
    handle = h;
    for (const msg of queued.splice(0)) apply(msg);
  }, () => ws.close(1011, 'terminal unavailable'));

  let alive = true;
  const ping = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }, PING_MS);
  ping.unref?.();
  ws.on('pong', () => { alive = true; });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let json: unknown;
    try { json = JSON.parse(raw.toString()); } catch { return; }
    const msg = ClientMessage.safeParse(json);
    if (!msg.success) return;
    apply(msg.data);
  });
  const done = (): void => {
    clearInterval(ping);
    gone = true;
    handle?.detach();
    handle = null;
  };
  ws.on('close', done);
  ws.on('error', done);
}
