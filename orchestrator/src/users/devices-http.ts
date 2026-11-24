/**
 * HTTP side of device pairing (`users/devices.ts`, multi-machine P2a).
 *
 *   POST   /api/devices/pairing-codes   session or operator → a one-time code
 *   POST   /api/devices/redeem          PUBLIC → a device token (contract in devices.ts)
 *   GET    /api/devices                 own devices; superadmin: all
 *   PATCH  /api/devices/:id             rename
 *   DELETE /api/devices/:id             revoke, effective on the next request
 *   POST   /api/devices/reachable       superadmin on this machine → publish the daemon on the tailnet
 *   GET    /api/devices/tailscale       superadmin on this machine → Tailscale state + the running setup job
 *   POST   /api/devices/tailscale/install   … → official installer (host/tailscale-install.ts)
 *   POST   /api/devices/tailscale/install/report … → the desktop app says how the installer it opened ended
 *   POST   /api/devices/tailscale/connect   … → `tailscale up`, sign-in URL
 *   POST   /api/devices/tailscale/operator  … → Linux: `tailscale set --operator` through pkexec
 *
 * A mission's api-token never reaches any of them: pairing a machine is a
 * person's gesture. A device may manage devices (it holds the account's
 * rights) but may not mint a code: a stolen device token must not be able to
 * plant a second one that survives its own revocation.
 */
import { daemonMessage } from '../daemon-message.js';
import type { IncomingHttpHeaders } from 'node:http';
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { config } from '../config/load.js';
import { dbApi } from '../db.js';
import { createNotification } from '../notifications.js';
import { auditIp, auditRequest, type AuditSource } from './audit-actor.js';
import { forbidden, requireSuperadmin } from './identity.js';
import { checkThrottle, clearThrottle } from './login-throttle.js';
import { noteAuthFailure, sendThrottled, throttleKeys } from './throttle-http.js';
import { publishThisDaemon, type TailnetPublishResult } from '../tailnet-publish.js';
import { tailscaleSetup, type InstallerReport, type TailscaleSetup, type TailscaleSetupStatus } from '../tailscale-setup.js';
import {
  DEVICE_IDLE_TTL_MS,
  deviceRedeemRequestSchema,
  deviceRenameSchema,
  formatPairingCode,
  getDevice,
  issuePairingCode,
  listDevices,
  pairingCodeRequestSchema,
  PairingCodeLimitError,
  redeemPairingCode,
  renameDevice,
  revokeDevice,
  toPublicDevice,
  touchDevice,
  type DeviceRedeemResponse,
  type DeviceRow,
} from './devices.js';
import { apiError } from '../api-error.js';

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const plain = address.replace(/^::ffff:/i, '');
  return plain === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain);
}

/** First `X-Forwarded-Proto` value, lowercased; `undefined` when absent. */
function forwardedProto(headers: IncomingHttpHeaders | undefined): string | undefined {
  const raw = headers?.['x-forwarded-proto'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const first = value?.split(',')[0]?.trim().toLowerCase();
  return first || undefined;
}

/**
 * A device credential only travels over TLS (the maintainer's arbitration: HTTPS with no
 * exception for a remote machine). The daemon speaks plain HTTP itself, so the
 * TLS hop is either a peer on this very host (`tailscale serve`, a local
 * proxy, the local app), or a reverse proxy declared by
 * `daemon.behindTlsProxy` that SAYS the client came over HTTPS
 * (`X-Forwarded-Proto: https`).
 *
 * The flag alone is not enough: a daemon declared behind a proxy but also
 * reachable in clear on the LAN would otherwise take a token sent over plain
 * HTTP. And a proxy that says the hop was clear (`X-Forwarded-Proto: http`)
 * is believed, even from the loopback. The header is the client's word when
 * no proxy stands in front: it protects against an accidental clear
 * transport, not against a client exposing its own token on purpose.
 */
export function deviceTransportAllowed(req: {
  headers?: IncomingHttpHeaders;
  socket: { remoteAddress?: string | undefined };
}): boolean {
  const proto = forwardedProto(req.headers);
  if (proto !== undefined && proto !== 'https') return false;
  if (isLoopbackAddress(req.socket.remoteAddress)) return true;
  return config().daemon.behindTlsProxy && proto === 'https';
}

export function sendDeviceRequiresTls(res: Response): void {
  res.status(403).json({ error: 'device_requires_tls', message: 'a device connects over HTTPS only' });
}

/** Audit row of a device's own request: the owner, and which device. */
function auditDevice(req: AuditSource, device: DeviceRow, action: string): void {
  dbApi.insertAuditLog({
    userId: device.user_id,
    actor: `device:${device.id}`,
    action,
    target: `device:${device.id}`,
    ip: auditIp(req),
  });
}

/**
 * A revoked device that keeps calling is worth one line per hour, not one per
 * request: the relay on the other side may retry every few seconds.
 */
const deadUseAudited = new Map<string, number>();
const DEAD_USE_AUDIT_GAP_MS = 60 * 60 * 1000;

export function auditDeadDeviceUse(req: AuditSource, device: DeviceRow, now: number = Date.now()): void {
  const last = deadUseAudited.get(device.id);
  if (last !== undefined && now - last < DEAD_USE_AUDIT_GAP_MS) return;
  deadUseAudited.set(device.id, now);
  if (deadUseAudited.size > 10_000) deadUseAudited.delete(deadUseAudited.keys().next().value!);
  auditDevice(req, device, 'device.use.denied');
}

/**
 * Called once a device token has been accepted: by the auth middleware, and by
 * the WebSocket upgrades that never go through it (`terminal-web/access.ts`).
 */
export function noteDeviceUse(req: AuditSource, device: DeviceRow): void {
  if (touchDevice(device, auditIp(req))) auditDevice(req, device, 'device.use');
}

/** Who issues a pairing code: a signed-in person, or the operator on the host. */
function pairingIssuer(req: Request, res: Response): { userId: string; isSuperadmin: boolean } | null {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  if (auth.kind === 'api-token' || auth.kind === 'device') {
    forbidden(req, res, {
      kind: 'scope',
      reason: 'a pairing code is issued by a person signed in to this machine',
      hint: 'Open Settings → Access & network → Devices on this machine, or run `timon device pair` on its host.',
    });
    return null;
  }
  if (!auth.user) {
    forbidden(req, res, { kind: 'account_required' });
    return null;
  }
  return { userId: auth.user.id, isSuperadmin: auth.isSuperadmin };
}

/** Who lists, renames or revokes devices. */
function deviceManager(req: Request, res: Response): { userId: string | null; isSuperadmin: boolean } | null {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  if (auth.kind === 'api-token') {
    forbidden(req, res, { kind: 'scope', reason: 'devices are managed by a person, not by a mission' });
    return null;
  }
  return { userId: auth.user?.id ?? null, isSuperadmin: auth.isSuperadmin };
}

/** Someone else's device is answered 404, like one that does not exist. */
function visibleDevice(req: Request, res: Response, manager: { userId: string | null; isSuperadmin: boolean }): DeviceRow | null {
  const device = getDevice(String(req.params.id));
  if (!device || (!manager.isSuperadmin && device.user_id !== manager.userId)) {
    res.status(404).json(apiError('device_not_found', 'device not found'));
    return null;
  }
  return device;
}

function publicWithCurrent(req: Request, device: DeviceRow): ReturnType<typeof toPublicDevice> & { current: boolean } {
  return { ...toPublicDevice(device), current: req.auth?.deviceId === device.id };
}

/** Nothing to choose: the port is picked by the daemon, the target is the daemon itself. */
const reachableRequestSchema = z.object({}).strict();

/**
 * Who may publish this daemon on the tailnet: a superadmin signed in on THIS
 * machine — a browser session, or the operator's CLI on the host. Not a
 * mission, and not a device: exposing a machine is decided by someone sitting
 * at it, the same rule as issuing a pairing code.
 */
function localSuperadmin(req: Request, res: Response): boolean {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  if (auth.kind === 'api-token' || auth.kind === 'device') {
    forbidden(req, res, {
      kind: 'scope',
      reason: 'a machine is made reachable by a person signed in to it',
      hint: 'Open Settings → Access & network → Devices on this machine.',
    });
    return false;
  }
  if (!auth.user) {
    forbidden(req, res, { kind: 'account_required' });
    return false;
  }
  return requireSuperadmin(req, res) !== null;
}

export type DeviceRoutesOptions = {
  /** Tests swap the real `tailscale serve` for a double. */
  publishDaemon?: () => Promise<TailnetPublishResult>;
  /** Tests swap the installer, `tailscale up` and pkexec for doubles. */
  tailscaleSetup?: () => Pick<TailscaleSetup, 'status' | 'install' | 'connect' | 'allowOperator' | 'reportInstaller'>;
};

/** Nothing to choose either: which installer, which URL, which account are the daemon's. */
const tailscaleSetupRequestSchema = z.object({}).strict();
/** The one thing the install request may say: it comes from the desktop app, which can open the installer. */
const tailscaleInstallRequestSchema = z.object({ client: z.literal('desktop').optional() }).strict();
/** How the installer the desktop app opened ended. The sha256 names the package, nothing names a path. */
const tailscaleInstallerReportSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(['installed', 'cancelled', 'failed']),
  code: z.number().int().min(-2_147_483_648).max(4_294_967_295).optional(),
}).strict();

function tailscaleSetupBody(status: TailscaleSetupStatus): Record<string, unknown> {
  const job = status.job;
  return {
    platform: status.platform,
    state: status.state,
    error: status.error,
    job: job && {
      kind: job.kind,
      phase: job.phase,
      failure: job.failure,
      command: job.command,
      detail: job.detail,
      auth_url: job.authUrl,
      // Only while the desktop app has to open it.
      installer: job.phase === 'handoff' ? job.installer : null,
      started_at: job.startedAt,
    },
  };
}

export function registerDeviceRoutes(app: Router, opts: DeviceRoutesOptions = {}): void {
  const publishDaemon = opts.publishDaemon ?? (() => publishThisDaemon());
  const setup = opts.tailscaleSetup ?? tailscaleSetup;

  app.get('/api/devices/tailscale', async (req, res) => {
    if (!localSuperadmin(req, res)) return;
    try {
      res.json(tailscaleSetupBody(await setup().status()));
    } catch {
      res.status(500).json({ error: 'tailscale_status_failed' });
    }
  });

  // Same gate as publishing: installing software and signing the machine in
  // are decided by a person sitting at it, never by a mission or a relayed device.
  type Setup = ReturnType<typeof setup>;
  const steps = [
    ['install', 'daemon.tailscale.install', tailscaleInstallRequestSchema, (s: Setup, body: z.infer<typeof tailscaleInstallRequestSchema>) => s.install(body)],
    ['connect', 'daemon.tailscale.connect', tailscaleSetupRequestSchema, (s: Setup) => s.connect()],
    ['operator', 'daemon.tailscale.operator', tailscaleSetupRequestSchema, (s: Setup) => s.allowOperator()],
  ] as const;
  for (const [step, action, schema, run] of steps) {
    app.post(`/api/devices/tailscale/${step}`, async (req, res) => {
      if (!localSuperadmin(req, res)) return;
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json(apiError('invalid_request', 'invalid_request'));
        return;
      }
      let status: TailscaleSetupStatus;
      try {
        status = await run(setup(), parsed.data);
      } catch {
        res.status(500).json({ error: 'tailscale_setup_failed' });
        return;
      }
      auditRequest(req, action, `tailscale:${status.platform}`);
      res.status(202).json(tailscaleSetupBody(status));
    });
  }

  app.post('/api/devices/tailscale/install/report', async (req, res) => {
    if (!localSuperadmin(req, res)) return;
    const parsed = tailscaleInstallerReportSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(apiError('invalid_request', 'invalid_request'));
      return;
    }
    let status: TailscaleSetupStatus;
    try {
      status = await setup().reportInstaller(parsed.data satisfies InstallerReport);
    } catch {
      res.status(500).json({ error: 'tailscale_setup_failed' });
      return;
    }
    auditRequest(req, 'daemon.tailscale.install_report', `tailscale:${status.platform}:${parsed.data.outcome}`);
    res.json(tailscaleSetupBody(status));
  });

  app.post('/api/devices/reachable', async (req, res) => {
    if (!localSuperadmin(req, res)) return;
    if (!reachableRequestSchema.safeParse(req.body ?? {}).success) {
      res.status(400).json(apiError('invalid_request', 'invalid_request'));
      return;
    }
    let result: TailnetPublishResult;
    try {
      result = await publishDaemon();
    } catch {
      res.status(500).json({ error: 'publish_failed' });
      return;
    }
    if (!result.ok) {
      res.status(409).json({
        error: 'not_reachable',
        reason: result.reason,
        platform: result.platform,
        command: result.command,
        enable_url: result.enableUrl,
        detail: result.detail,
      });
      return;
    }
    if (!result.reused) auditRequest(req, 'daemon.tailnet.publish', `https:${result.port}`);
    res.json({ address: result.address, port: result.port, reused: result.reused });
  });

  app.post('/api/devices/pairing-codes', (req, res) => {
    const issuer = pairingIssuer(req, res);
    if (!issuer) return;
    const body = pairingCodeRequestSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json(apiError('invalid_request', 'invalid_request'));
      return;
    }
    let userId = issuer.userId;
    const target = body.data.user_id;
    if (target !== undefined && target !== issuer.userId) {
      if (!requireSuperadmin(req, res)) return;
      const user = dbApi.getUserById(target);
      if (!user || user.status !== 'active') {
        res.status(404).json(apiError('user_not_found', 'user not found'));
        return;
      }
      userId = user.id;
    }
    try {
      const { code, expiresAt } = issuePairingCode(userId);
      auditRequest(req, 'device.code.issue', `user:${userId}`);
      res.status(201).json({ code: formatPairingCode(code), expires_at: expiresAt, user_id: userId });
    } catch (err) {
      if (err instanceof PairingCodeLimitError) {
        res.status(409).json({ error: 'too_many_codes', message: 'too many pairing codes are pending for this account' });
        return;
      }
      throw err;
    }
  });

  app.post('/api/devices/redeem', (req, res) => {
    if (!deviceTransportAllowed(req)) {
      sendDeviceRequiresTls(res);
      return;
    }
    const keys = throttleKeys(req, 'device-redeem', null);
    const verdict = checkThrottle(keys);
    if (!verdict.allowed) {
      sendThrottled(res, verdict);
      return;
    }
    const body = deviceRedeemRequestSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json(apiError('invalid_request', 'invalid_request'));
      return;
    }
    const userAgent = req.header('user-agent') ?? null;
    const outcome = redeemPairingCode({ code: body.data.code, name: body.data.name, ip: auditIp(req), userAgent });
    if (outcome.kind !== 'ok') {
      noteAuthFailure(req, keys);
      if (outcome.kind === 'burnt') {
        dbApi.insertAuditLog({ userId: outcome.userId, action: 'device.code.burnt', target: `user:${outcome.userId}`, ip: auditIp(req) });
      }
      res.status(401).json({ error: 'invalid_code' });
      return;
    }
    clearThrottle(keys);
    const { device, token, user } = outcome;
    auditDevice(req, device, 'device.pair');
    createNotification({
      type: 'alert',
      title: 'New device connected',
      body: `"${device.name}" was paired with your account. If this was not you, revoke it in Settings → Access & network → Devices.`,
      ownerUserId: user.id,
      message: daemonMessage('device_paired', { name: device.name }),
    });
    const payload: DeviceRedeemResponse = {
      device: { id: device.id, name: device.name, created_at: device.created_at },
      token,
      user: { id: user.id, email: user.email, name: user.name, is_superadmin: user.is_superadmin },
      idle_ttl_ms: DEVICE_IDLE_TTL_MS,
    };
    // The token is in this body and nowhere else: no proxy may keep a copy.
    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
  });

  app.get('/api/devices', (req, res) => {
    const manager = deviceManager(req, res);
    if (!manager) return;
    const rows = listDevices(manager.isSuperadmin ? null : manager.userId);
    res.json({ devices: rows.map((row) => publicWithCurrent(req, row)) });
  });

  app.patch('/api/devices/:id', (req, res) => {
    const manager = deviceManager(req, res);
    if (!manager) return;
    const device = visibleDevice(req, res, manager);
    if (!device) return;
    const body = deviceRenameSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json(apiError('invalid_request', 'invalid_request'));
      return;
    }
    const renamed = renameDevice(device.id, body.data.name)!;
    auditRequest(req, 'device.rename', `device:${device.id}`);
    res.json({ device: publicWithCurrent(req, renamed) });
  });

  app.delete('/api/devices/:id', (req, res) => {
    const manager = deviceManager(req, res);
    if (!manager) return;
    const device = visibleDevice(req, res, manager);
    if (!device) return;
    const revoked = revokeDevice(device.id)!;
    if (device.revoked_at === null) auditRequest(req, 'device.revoke', `device:${device.id}`);
    res.json({ device: publicWithCurrent(req, revoked) });
  });
}
