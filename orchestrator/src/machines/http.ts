/**
 * HTTP side of the fleet of machines (multi-machine P2c, TODO #329), mounted
 * by the `@timon/machines` module.
 *
 *   GET    /api/machines                  the caller's fleet
 *   POST   /api/machines/pair             { url, code, name?, device_name? } → pairs with the remote
 *   PATCH  /api/machines/:id              { name } → rename
 *   DELETE /api/machines/:id              remove (and revoke this device on the remote, best effort)
 *   GET    /api/machines/:id/status       reachability, version, apiLevel, seen now
 *   GET    /api/machines/:id/credential   { id, url, token } — the app's relay ONLY
 *
 * Who: a person signed in to THIS daemon with a browser session, and only
 * over their own fleet (another account's machine is a 404, superadmin
 * included). The daemon-token (CLI, operator), a mission's api-token and a
 * paired device are refused: a device driving this daemon from elsewhere must
 * not be able to read the tokens of the other machines and hop on.
 *
 * `/credential` adds a second lock: the relay proof (`relay-proof.ts`). A
 * browser holding the session cookie gets a 403 from it, whatever it sends.
 * Its answer is `Cache-Control: no-store` and is neither logged nor audited
 * per call (the relay asks for it on every cache miss).
 */
import { hostname } from 'node:os';
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { ensureDaemonToken } from '../plugins-bundled/http/auth.js';
import { vaultEnabled } from '../secrets/availability.js';
import { SecretBoxError } from '../secrets/box.js';
import { SecretStoreError } from '../secrets/store.js';
import { auditRequest } from '../users/audit-actor.js';
import { forbidden } from '../users/identity.js';
import { checkThrottle, clearThrottle } from '../users/login-throttle.js';
import { noteAuthFailure, sendThrottled, throttleKeys } from '../users/throttle-http.js';
import { MachineRequestError, machineRequest, type MachineResponse } from './client.js';
import { fleetChanged } from './push-relay.js';
import { carriesBrowserMetadata, RELAY_PROOF_HEADER, verifyRelayProof } from './relay-proof.js';
import {
  countOwnedMachines,
  deleteMachine,
  findOwnedMachineByUrl,
  getOwnedMachine,
  listMachines,
  MACHINE_NAME_MAX,
  machineToken,
  MACHINES_PER_OWNER,
  recordMachineStatus,
  renameMachine,
  savePairedMachine,
  toPublicMachine,
  type MachineRow,
  type MachineStatus,
} from './store.js';
import { MACHINE_URL_MAX, parseMachineUrl, type MachineUrlProblem } from './url.js';
import { apiError, type ApiErrorBody } from '../api-error.js';

/** Short calls made while the person waits on a button. */
const PROBE_TIMEOUT_MS = 5_000;

const displayName = z.string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(MACHINE_NAME_MAX).regex(/^[^\p{Cc}]+$/u));

export const machinePairSchema = z.object({
  url: z.string().min(1).max(MACHINE_URL_MAX),
  code: z.string().min(1).max(64),
  /** How this fleet names the machine. Defaults to its host name. */
  name: displayName.optional(),
  /** How the remote lists this daemon among its devices. */
  device_name: displayName.optional(),
}).strict();

export const machineRenameSchema = z.object({ name: displayName }).strict();

/** The remote's `POST /api/devices/redeem` answer (`users/devices.ts` contract). */
const redeemAnswerSchema = z.object({
  device: z.object({ id: z.string().min(1).max(128) }).passthrough(),
  token: z.string().regex(/^tdev_[A-Za-z0-9_-]{20,128}$/),
  user: z.object({
    email: z.string().max(320),
    name: z.string().max(256),
    is_superadmin: z.boolean(),
  }).passthrough(),
}).passthrough();

const capabilitiesAnswerSchema = z.object({
  version: z.string().max(64).optional(),
  apiLevel: z.number().int().min(0).max(1_000_000).optional(),
}).passthrough();

export type MachineRoutesOptions = {
  /** Test seam; the daemon reads its own token file. */
  daemonToken?: () => string;
};

/** The person who owns the fleet being touched, or `null` once refused. */
function fleetOwner(req: Request, res: Response): string | null {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  if (auth.kind !== 'session') {
    forbidden(req, res, {
      kind: 'scope',
      reason: 'the fleet of machines is managed from a browser session on this machine',
      hint: 'Open Settings → Machines on this machine.',
    });
    return null;
  }
  if (!auth.user) {
    forbidden(req, res, { kind: 'account_required' });
    return null;
  }
  return auth.user.id;
}

function ownedOr404(req: Request, res: Response, owner: string): MachineRow | null {
  const row = getOwnedMachine(owner, String(req.params.id));
  if (!row) {
    res.status(404).json(apiError('machine_unknown', 'machine not found'));
    return null;
  }
  return row;
}

function vaultOr503(res: Response): boolean {
  if (vaultEnabled()) return true;
  res.status(503).json(apiError('vault_unavailable', 'the secrets vault is switched off: machine tokens cannot be kept'));
  return false;
}

function sendVaultFailure(res: Response): void {
  res.status(503).json(apiError('vault_unavailable', 'the secrets vault cannot open machine tokens'));
}

/** A transport failure, as the interface shows it. Never the remote's own words. */
function sendTransportError(res: Response, err: MachineRequestError): void {
  // One literal per code: the translation check reads them.
  switch (err.code) {
    case 'blocked_address': res.status(400).json(apiError('blocked_address', err.message)); return;
    case 'invalid_url': res.status(400).json(apiError('invalid_url', err.message)); return;
    case 'too_large': res.status(502).json(apiError('machine_bad_response', err.message)); return;
    case 'tls_error': res.status(502).json(apiError('machine_tls_error', err.message)); return;
    case 'redirect': res.status(502).json(apiError('machine_redirect', err.message)); return;
    default: res.status(502).json(apiError('machine_unreachable', err.message));
  }
}

/** Why an address cannot be a machine of the fleet. */
function urlRefusal(problem: MachineUrlProblem): ApiErrorBody {
  switch (problem) {
    case 'https_required': return apiError('https_required', 'a machine is reached over HTTPS, plain HTTP only on this computer');
    case 'credentials_in_url': return apiError('credentials_in_url', 'a machine address carries no login');
    case 'query_in_url': return apiError('query_in_url', 'a machine address carries no query or fragment');
    case 'blocked_address': return apiError('blocked_address', 'this address cannot be a machine of the fleet');
    default: return apiError('invalid_url', 'invalid machine URL');
  }
}

function statusOfFailure(err: unknown): MachineStatus {
  return err instanceof MachineRequestError && err.code === 'tls_error' ? 'tls_error' : 'unreachable';
}

function retryAfter(answer: MachineResponse): string | null {
  const raw = answer.headers['retry-after'];
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(value) && value > 0 && value < 86_400 ? String(value) : null;
}

/** What the machine says about itself, recorded on the row. */
async function probe(row: MachineRow, token: string): Promise<{ status: MachineStatus; version: string | null; apiLevel: number | null }> {
  try {
    const answer = await machineRequest(row.url, { method: 'GET', path: '/api/capabilities', token, timeoutMs: PROBE_TIMEOUT_MS });
    if (answer.status === 200) {
      const caps = capabilitiesAnswerSchema.safeParse(answer.json);
      // A daemon from before the contract answers without the fields: online,
      // version unknown — the interface warns, it does not block.
      const seen = {
        status: 'online' as const,
        version: caps.success ? caps.data.version ?? null : null,
        apiLevel: caps.success ? caps.data.apiLevel ?? null : null,
      };
      recordMachineStatus(row.id, seen);
      return seen;
    }
    const status: MachineStatus = answer.status === 401 ? 'unauthorized' : 'error';
    recordMachineStatus(row.id, { status });
    return { status, version: row.version, apiLevel: row.api_level };
  } catch (err) {
    const status = statusOfFailure(err);
    recordMachineStatus(row.id, { status });
    return { status, version: row.version, apiLevel: row.api_level };
  }
}

/** Best effort: the device this daemon holds on the remote is revoked there. */
async function revokeRemoteDevice(url: string, token: string, deviceId: string): Promise<boolean> {
  try {
    const answer = await machineRequest(url, {
      method: 'DELETE', path: `/api/devices/${encodeURIComponent(deviceId)}`, token, timeoutMs: PROBE_TIMEOUT_MS,
    });
    return answer.status === 200;
  } catch {
    return false;
  }
}

export function registerMachineRoutes(app: Router, opts: MachineRoutesOptions = {}): void {
  const daemonToken = opts.daemonToken ?? (() => ensureDaemonToken());

  app.get('/api/machines', (req, res) => {
    const owner = fleetOwner(req, res);
    if (!owner) return;
    res.json({ machines: listMachines(owner).map(toPublicMachine) });
  });

  app.post('/api/machines/pair', async (req, res) => {
    const owner = fleetOwner(req, res);
    if (!owner) return;
    const body = machinePairSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json(apiError('invalid_request', 'invalid_request'));
      return;
    }
    const parsed = parseMachineUrl(body.data.url);
    if (!parsed.ok) {
      res.status(400).json(urlRefusal(parsed.problem));
      return;
    }
    const url = parsed.value.url;
    if (!vaultOr503(res)) return;
    const known = findOwnedMachineByUrl(owner, url);
    if (!known && countOwnedMachines(owner) >= MACHINES_PER_OWNER) {
      res.status(409).json(apiError('too_many_machines', `a fleet holds at most ${MACHINES_PER_OWNER} machines`, { max: MACHINES_PER_OWNER }));
      return;
    }
    // Every failed pairing counts: a session must not turn this route into a
    // scanner of HTTPS hosts, nor into a code guesser against a remote.
    const keys = throttleKeys(req, 'machine-pair', owner);
    const verdict = checkThrottle(keys);
    if (!verdict.allowed) {
      sendThrottled(res, verdict);
      return;
    }
    const deviceName = body.data.device_name ?? `Timon — ${hostname()}`.slice(0, MACHINE_NAME_MAX);
    let answer: MachineResponse;
    try {
      answer = await machineRequest(url, {
        method: 'POST', path: '/api/devices/redeem', body: { code: body.data.code, name: deviceName }, timeoutMs: 10_000,
      });
    } catch (err) {
      noteAuthFailure(req, keys);
      sendTransportError(res, err instanceof MachineRequestError
        ? err
        : new MachineRequestError('unreachable', 'the machine could not be reached'));
      return;
    }
    if (answer.status !== 200) {
      noteAuthFailure(req, keys);
      const remoteError = (answer.json as { error?: unknown } | null)?.error;
      if (answer.status === 401) {
        res.status(422).json(apiError('invalid_code', 'the machine refused this pairing code: wrong, expired or already used'));
      } else if (answer.status === 429) {
        const after = retryAfter(answer);
        if (after) res.setHeader('Retry-After', after);
        res.status(429).json(apiError('machine_throttled', 'the machine refuses more attempts for now'));
      } else if (answer.status === 403 && remoteError === 'device_requires_tls') {
        res.status(502).json(apiError('machine_requires_tls', 'the machine does not see this connection as HTTPS (check its reverse proxy)'));
      } else if (answer.status === 404) {
        res.status(502).json(apiError('not_a_timon_machine', 'no Timon pairing endpoint at this address'));
      } else {
        res.status(502).json(apiError('machine_bad_response', 'the machine answered something unexpected'));
      }
      return;
    }
    const redeemed = redeemAnswerSchema.safeParse(answer.json);
    if (!redeemed.success) {
      noteAuthFailure(req, keys);
      res.status(502).json(apiError('machine_bad_response', 'the machine answered something unexpected'));
      return;
    }
    clearThrottle(keys);
    const { token, device, user } = redeemed.data;
    let saved: ReturnType<typeof savePairedMachine>;
    try {
      saved = savePairedMachine({
        ownerUserId: owner,
        name: body.data.name ?? new URL(url).hostname,
        url,
        token,
        remoteDeviceId: device.id,
        remoteUser: { email: user.email, name: user.name, is_superadmin: user.is_superadmin },
      });
    } catch (err) {
      // The remote device exists but cannot be kept: do not leave it behind.
      await revokeRemoteDevice(url, token, device.id);
      if (err instanceof SecretStoreError || err instanceof SecretBoxError) sendVaultFailure(res);
      else res.status(500).json(apiError('machine_not_saved', 'the machine could not be saved'));
      return;
    }
    if (saved.replacedDeviceId) await revokeRemoteDevice(url, token, saved.replacedDeviceId);
    auditRequest(req, saved.created ? 'machine.pair' : 'machine.repair', `machine:${saved.row.id}`);
    fleetChanged();
    await probe(saved.row, token);
    res.status(saved.created ? 201 : 200).json({ machine: toPublicMachine(getOwnedMachine(owner, saved.row.id)!), created: saved.created });
  });

  app.patch('/api/machines/:id', (req, res) => {
    const owner = fleetOwner(req, res);
    if (!owner) return;
    const row = ownedOr404(req, res, owner);
    if (!row) return;
    const body = machineRenameSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json(apiError('invalid_request', 'invalid_request'));
      return;
    }
    const renamed = renameMachine(owner, row.id, body.data.name)!;
    auditRequest(req, 'machine.rename', `machine:${row.id}`);
    fleetChanged();
    res.json({ machine: toPublicMachine(renamed) });
  });

  app.delete('/api/machines/:id', async (req, res) => {
    const owner = fleetOwner(req, res);
    if (!owner) return;
    const row = ownedOr404(req, res, owner);
    if (!row) return;
    let remoteRevoked = false;
    try {
      remoteRevoked = await revokeRemoteDevice(row.url, machineToken(row), row.remote_device_id);
    } catch {
      // A token the vault cannot open is a token nobody can use: remove anyway.
    }
    deleteMachine(owner, row.id);
    auditRequest(req, 'machine.remove', `machine:${row.id}`);
    fleetChanged();
    res.json({ removed: true, remote_revoked: remoteRevoked });
  });

  app.get('/api/machines/:id/status', async (req, res) => {
    const owner = fleetOwner(req, res);
    if (!owner) return;
    const row = ownedOr404(req, res, owner);
    if (!row) return;
    let token: string;
    try {
      token = machineToken(row);
    } catch {
      sendVaultFailure(res);
      return;
    }
    const seen = await probe(row, token);
    res.json({
      machine: toPublicMachine(getOwnedMachine(owner, row.id)!),
      reachable: seen.status === 'online',
      version: seen.version,
      apiLevel: seen.apiLevel,
    });
  });

  app.get('/api/machines/:id/credential', (req, res) => {
    const owner = fleetOwner(req, res);
    if (!owner) return;
    const id = String(req.params.id);
    // The relay proof is checked before the row is looked up: a caller
    // without it learns nothing, not even whether the machine exists.
    if (carriesBrowserMetadata(req.headers) || !verifyRelayProof(req.headers[RELAY_PROOF_HEADER], daemonToken(), id)) {
      forbidden(req, res, {
        kind: 'scope',
        reason: 'a machine credential is handed to the app relay only, never to a browser',
      });
      return;
    }
    const row = ownedOr404(req, res, owner);
    if (!row) return;
    if (!vaultOr503(res)) return;
    let token: string;
    try {
      token = machineToken(row);
    } catch {
      sendVaultFailure(res);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.json({ id: row.id, url: row.url, token, version: row.version, api_level: row.api_level });
  });
}
