/**
 * `/api/secrets` — the write-only surface of the vault, the broker, and the
 * access journal (SECRETS-VAULT.md §9.1, §6.2, §8).
 *
 * Write-only is the contract of the CRUD: list/get/create/update never return
 * a value, not even the sealed envelope — what comes out is `toPublicSecret`
 * and nothing else. The HTTP broker returns a status and a body; the journal
 * returns facts of use. Two exceptions, each narrow on purpose: the git
 * credential route, whose whole purpose is to answer git's protocol (read the
 * honesty note on `brokerGitCredential`), and `POST /:id/reveal`, the human
 * gesture of looking at a value again. Amended on 16/10/2026 at the maintainer's request —
 * an operator who cannot re-read a secret ends up keeping a copy elsewhere,
 * which is worse. Reveal is a session-only, superadmin-only, password-
 * re-checked, throttled and journalled route, never reachable by an agent.
 *
 * The whole router sits behind `secrets:manage` (posed once on `/api/secrets`,
 * so a future route is denied by default). Grants and rekey then tighten to
 * superadmin: holding `secrets:manage` is not enough to decide which agent (or
 * plugin) receives a secret — through `/:id/grants` or through the grants a
 * create/update carries — or to rotate the vault key.
 *
 * Route order is load-bearing. Anything that is not `:id` (`rekey`,
 * `import-env`, `broker/http`, `broker/git`) must be registered before
 * `/api/secrets/:id`, or Express reads the verb as an id.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { dbApi } from '../../db.js';
import { BrokerDeniedError, brokerGitCredential, brokerHttpCall } from '../../secrets/broker.js';
import {
  SecretStoreError,
  createSecret,
  deleteSecret,
  getSecret,
  grantSecret,
  grantsAddedBy,
  liftsBackendReservation,
  revokeLiftsBackendReservation,
  importSecretsEnv,
  listSecrets,
  parseSecretScope,
  provisionSecret,
  readSecretValue,
  rekeyVault,
  revokeSecret,
  updateSecret,
  type PublicSecret,
} from '../../secrets/store.js';
import { PLUGIN_AGENT_PREFIX, type SecretGrant } from '../../secrets/resolve.js';
import { clearGlobalOnlySecret } from '../../secrets/plugins.js';
import { rejectIfDenied, rejectUnlessAny, requireSuperadmin, isPersonAuth } from '../../users/identity.js';
import { GENERATE_ALPHABETS, GENERATE_MAX_LENGTH, GENERATE_MIN_LENGTH } from '../../secrets/generate.js';
import { callerFromRequest } from './caller.js';
import { checkThrottle, clearThrottle } from '../../users/login-throttle.js';
import { noteAuthFailure, sendThrottled, testCredential, throttleKeys } from '../../users/throttle-http.js';
import { verifyAccountPassword } from '../../users/password.js';
import { auditRequest } from '../../users/audit-actor.js';
import { ProvideBody, provideSecretRequest, raiseSecretRequest, refuseSecretRequest, type Deliver } from './requests.js';
import { apiError, type ApiErrorBody } from '../../api-error.js';

/**
 * Store failures map to a status, never to a stack trace: an error body that
 * echoed the input could carry back the value the caller just posted.
 */
function fail(res: Response, e: unknown): void {
  if (e instanceof SecretStoreError) {
    // One literal per code: the translation check reads them.
    switch (e.code) {
      case 'not-found': res.status(404).json(apiError('secret_unknown', e.message)); return;
      case 'unavailable': res.status(503).json(apiError('vault_unavailable', e.message)); return;
      case 'duplicate': res.status(409).json(apiError('secret_duplicate', e.message)); return;
      case 'invalid-name': res.status(400).json(apiError('secret_name_invalid', e.message)); return;
      case 'invalid-mode': res.status(400).json(apiError('secret_mode_invalid', e.message)); return;
      case 'invalid-scope': res.status(400).json(apiError('secret_scope_invalid', e.message)); return;
      case 'broker-spec-required': res.status(400).json(apiError('secret_broker_spec_required', e.message)); return;
      default: res.status(400).json(apiError('secret_value_required', e.message)); return;
    }
  }
  res.status(400).json(apiError('secret_refused', (e as Error).message, { detail: (e as Error).message }));
}

/** A refused answer to a secret request, as the card reads it. */
function answerRefusal(out: { error: string; message?: string }): ApiErrorBody {
  switch (out.error) {
    case 'not_found': return apiError('secret_request_not_found', 'this secret request does not exist');
    case 'already_decided': return apiError('secret_request_decided', 'this secret request was already answered');
    case 'expired': return apiError('secret_request_expired', 'this secret request expired');
    case 'duplicate': return apiError('secret_request_duplicate', out.message ?? 'duplicate');
    default: return apiError('secret_request_not_stored', 'the value could not be stored in the vault');
  }
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

/** A scope arrives either as `"project:initech"` or as `{scope_kind, scope_ref}`. */
function scopeOf(value: unknown): SecretGrant | string {
  if (typeof value === 'string') return value;
  const raw = (value ?? {}) as { scope_kind?: unknown; scope_ref?: unknown };
  return {
    scope_kind: raw.scope_kind as SecretGrant['scope_kind'],
    scope_ref: typeof raw.scope_ref === 'string' ? raw.scope_ref : null,
  };
}

function grantsOf(value: unknown): (SecretGrant | string)[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new SecretStoreError('invalid-scope', 'grants must be an array');
  return value.map(scopeOf);
}

/**
 * A grant that names a plugin answers its consent card now (`plugin-secret:…`,
 * TODO #597), not at the plugin's next read — which may be an hour away, or
 * never if the operator granted it from the card before the plugin retried.
 */
function answerPluginCards(name: string, grants: readonly SecretGrant[]): void {
  for (const grant of grants) {
    if (grant.scope_kind === 'agent' && grant.scope_ref?.startsWith(PLUGIN_AGENT_PREFIX)) {
      clearGlobalOnlySecret(grant.scope_ref.slice(PLUGIN_AGENT_PREFIX.length), name);
    }
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isStringMap(value: unknown): value is Record<string, string> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}

/** Exactly one of `value` / `generate`: an agent either supplies the value or asks the daemon to mint it. */
const PROVISION_BODY = z.object({
  name: z.string().min(1).max(128),
  value: z.string().min(1).max(4096).optional(),
  generate: z.object({
    length: z.number().int().min(GENERATE_MIN_LENGTH).max(GENERATE_MAX_LENGTH).optional(),
    alphabet: z.enum(Object.keys(GENERATE_ALPHABETS) as [keyof typeof GENERATE_ALPHABETS, ...(keyof typeof GENERATE_ALPHABETS)[]]).optional(),
  }).optional(),
  note: z.string().max(200).optional(),
}).refine((b) => (b.value === undefined) !== (b.generate === undefined), {
  message: 'pass exactly one of value or generate',
});

const REVEAL_BODY = z.object({ password: z.string().min(1).max(1024) });

/** Refusals the agent caused map to 4xx; anything else is ours to own. */
const BROKER_STATUS: Record<string, number> = {
  'unknown-identity': 404,
  'no-grant': 403,
  'host-denied': 403,
  'policy-denied': 403,
  'wrong-type': 400,
  'bad-request': 400,
  'bad-spec': 500,
};

const RequestId = z.string().regex(/^[0-9a-f-]{36}$/i);

export type SecretRouteOptions = {
  /** Where the answer to a `secret_request` goes; tests stand in for the agent. */
  deliver?: Deliver;
};

/**
 * The browser of a signed-in person, or a refusal already sent. A token —
 * the daemon's or a mission's — never answers a secret request: the value
 * would then come from a program, and the program would hold it.
 */
function sessionUserId(req: Request, res: Response): string | null {
  if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return null; }
  if (!isPersonAuth(req.auth) || !req.auth.user) {
    res.status(403).json(apiError('secret_request_session_required', 'a secret request is answered from a browser session'));
    return null;
  }
  return req.auth.user.id;
}

export function registerRoutes(router: Router, opts: SecretRouteOptions = {}): void {
  // The broker is deliberately NOT behind `secrets:manage` (audit CLI/MCP P2-6): a mission
  // granted a brokered identity must be able to call it without being able to
  // read/create/delete the vault. It sits on its own `secrets:broker`
  // permission (in the mission cap), with `secrets:manage` still opening it
  // too — managing secrets implies brokering them. These two routes are
  // registered BEFORE the router-wide `secrets:manage` guard below (which would
  // otherwise close them), and before `/api/secrets/:id` so Express never reads
  // `broker` as an id.
  router.post('/api/secrets/broker/http', (req, res) => {
    if (rejectUnlessAny(req, res, ['secrets:broker', 'secrets:manage'])) return;
    void (async () => {
      const b = body(req);
      const identity = typeof b['identity'] === 'string' ? b['identity'] : '';
      const path = typeof b['path'] === 'string' ? b['path'] : '';
      if (!identity || !path) {
        res.status(400).json({ error: 'identity and path are required' });
        return;
      }
      try {
        const result = await brokerHttpCall(
          {
            identity,
            path,
            method: typeof b['method'] === 'string' ? b['method'] : undefined,
            host: typeof b['host'] === 'string' ? b['host'] : undefined,
            headers: isStringMap(b['headers']) ? b['headers'] : undefined,
            body: b['body'],
          },
          callerFromRequest(req),
        );
        res.json(result);
      } catch (e) {
        if (e instanceof BrokerDeniedError) {
          res.status(BROKER_STATUS[e.code] ?? 400).json({ error: e.message, code: e.code });
          return;
        }
        // Never echo an unknown error verbatim: it may have been built by a
        // library out of something we handed it, value included.
        console.error(`[secrets] broker call failed: ${(e as Error).name}`);
        res.status(500).json({ error: 'broker call failed' });
      }
    })();
  });

  /**
   * The one route that hands a value back — to `timon git-credential`, which
   * git spawned, and only for a host a `git` identity covers. Its narrowness is
   * the whole point: no listing, no lookup by name, no way to ask "give me
   * secret X". See `brokerGitCredential` for what this does and does not buy.
   */
  router.post('/api/secrets/broker/git', (req, res) => {
    if (rejectUnlessAny(req, res, ['secrets:broker', 'secrets:manage'])) return;
    const host = typeof body(req)['host'] === 'string' ? String(body(req)['host']).trim() : '';
    if (!host) {
      res.status(400).json({ error: 'host is required' });
      return;
    }
    try {
      res.json(brokerGitCredential(host, callerFromRequest(req)));
    } catch (e) {
      if (e instanceof BrokerDeniedError) {
        res.status(BROKER_STATUS[e.code] ?? 400).json({ error: e.message, code: e.code });
        return;
      }
      console.error(`[secrets] git credential failed: ${(e as Error).name}`);
      res.status(500).json({ error: 'git credential failed' });
    }
  });

  /**
   * An agent deposits a NEW secret — generated by the daemon (the agent never
   * sees the value) or supplied by the agent. Like the broker it sits BEFORE the
   * router-wide `secrets:manage` guard, on its own `secrets:create` permission
   * (in the mission cap): a mission may deposit, never list, read, replace or
   * delete. `provisionSecret` refuses any existing name, grants nothing and the
   * answer never carries the value. A value the agent supplies did cross its
   * context — it made it; the daemon-generated path is the one that does not.
   */
  router.post('/api/secrets/provision', (req, res) => {
    if (rejectUnlessAny(req, res, ['secrets:create', 'secrets:manage'])) return;
    const parsed = PROVISION_BODY.safeParse(req.body ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message ?? 'invalid body';
      res.status(400).json(apiError('invalid_detail', detail, { detail }));
      return;
    }
    const caller = callerFromRequest(req);
    try {
      const { secret, generated } = provisionSecret({
        ...parsed.data,
        by: { agent: caller.agent ?? null, missionId: caller.missionId ?? null },
      });
      auditRequest(req, 'secret.provision', `secret:${secret.id}`);
      res.status(201).json({ secret, generated });
    } catch (e) { fail(res, e); }
  });

  /**
   * `secret_request` (§9.5): an agent asks its user for a value it will never
   * see. Raised by the mission's own token only, on `secrets:create` like a
   * deposit; answered by the mission owner's browser session only. These sit
   * before the `secrets:manage` guard, as the deposit does.
   */
  router.post('/api/secrets/requests', (req, res) => {
    if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (req.auth.kind !== 'api-token' || !req.auth.missionId) {
      res.status(403).json({ error: 'forbidden', code: 'mission_only', message: 'only an agent mission can request a secret from its user' });
      return;
    }
    if (rejectUnlessAny(req, res, ['secrets:create', 'secrets:manage'])) return;
    const out = raiseSecretRequest(req.auth.missionId, req.body);
    if (out.status === 202 && typeof out.body['id'] === 'string') auditRequest(req, 'secret.request', `secret-request:${out.body['id']}`);
    res.status(out.status).json(out.body);
  });

  router.post('/api/secrets/requests/:id/provide', (req, res) => {
    // Set before anything else: no answer of this route, refusals included, belongs in a cache.
    res.setHeader('Cache-Control', 'no-store');
    const userId = sessionUserId(req, res);
    if (!userId) return;
    const id = RequestId.safeParse(req.params['id']);
    const parsed = ProvideBody.safeParse(req.body ?? {});
    if (!id.success || !parsed.success) {
      // Never the zod issue: it may quote the input.
      res.status(400).json(apiError('secret_request_value_invalid', 'expected { value } (1 to 16384 characters)'));
      return;
    }
    const out = provideSecretRequest(id.data.toLowerCase(), userId, parsed.data.value, opts.deliver);
    if (!out.ok) { res.status(out.status).json(answerRefusal(out)); return; }
    auditRequest(req, 'secret.request.provide', `secret-request:${out.request.id}`);
    res.json({ ok: true, request: out.request });
  });

  router.post('/api/secrets/requests/:id/refuse', (req, res) => {
    const userId = sessionUserId(req, res);
    if (!userId) return;
    const id = RequestId.safeParse(req.params['id']);
    if (!id.success) { res.status(400).json(apiError('invalid_request', 'invalid_request')); return; }
    const out = refuseSecretRequest(id.data.toLowerCase(), userId, opts.deliver);
    if (!out.ok) { res.status(out.status).json(answerRefusal(out)); return; }
    auditRequest(req, 'secret.request.refuse', `secret-request:${out.request.id}`);
    res.json({ ok: true, request: out.request });
  });

  // One guard for the REST of the vault — not per route — so a path added later
  // is closed by default. grants / rekey then refuse non-superadmins below.
  router.use('/api/secrets', (req, res, next) => {
    if (rejectIfDenied(req, res, 'secrets:manage')) return;
    next();
  });

  // Before `/api/secrets/:id`: these are verbs on the vault as a whole, and
  // Express would otherwise read `rekey` as an id.
  router.post('/api/secrets/rekey', (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    try {
      res.json({ ok: true, ...rekeyVault() });
    } catch (e) { fail(res, e); }
  });

  router.post('/api/secrets/import-env', (req, res) => {
    try {
      const deleteSource = body(req)['deleteSource'] === true;
      const result = importSecretsEnv({ deleteSource });
      res.json({ ok: true, ...result });
    } catch (e) { fail(res, e); }
  });

  router.get('/api/secrets', (req, res) => {
    const agent = str(req.query['agent']);
    const project = str(req.query['project']);
    try {
      res.json({ secrets: listSecrets(agent || project ? { agent, project } : undefined) });
    } catch (e) { fail(res, e); }
  });

  router.get('/api/secrets/:id', (req, res) => {
    const secret = getSecret(String(req.params['id'] ?? ''));
    if (!secret) return void res.status(404).json(apiError('secret_unknown', 'unknown secret'));
    res.json(secret);
  });

  // Create and update carry grants too. Deciding who receives a secret is
  // superadmin-only on `/:id/grants`; without the same check here, a
  // `secrets:manage` holder would grant through the editor's PUT what the
  // grant route refuses them (TODO #597). Resending the grants a secret
  // already has, or dropping some, is not a decision and stays open — except
  // lifting a reservation to a backend, which widens the key (TODO #600).
  router.post('/api/secrets', (req, res) => {
    const b = body(req);
    try {
      const grants = grantsOf(b['grants']);
      const added = grants ? grantsAddedBy(null, grants) : [];
      if (added.length > 0 && !requireSuperadmin(req, res)) return;
      const secret: PublicSecret = createSecret({
        name: String(b['name'] ?? ''),
        value: str(b['value']) ?? '',
        mode: b['mode'] === undefined ? undefined : (b['mode'] as PublicSecret['mode']),
        broker_spec: b['broker_spec'],
        note: str(b['note']) ?? null,
        grants,
      });
      answerPluginCards(secret.name, added);
      res.status(201).json(secret);
    } catch (e) { fail(res, e); }
  });

  router.put('/api/secrets/:id', (req, res) => {
    const b = body(req);
    const id = String(req.params['id'] ?? '');
    try {
      const grants = grantsOf(b['grants']);
      const added = grants ? grantsAddedBy(id, grants) : [];
      const widens = added.length > 0 || (!!grants && liftsBackendReservation(id, grants));
      if (widens && !requireSuperadmin(req, res)) return;
      const secret = updateSecret(id, {
        ...(b['value'] === undefined ? {} : { value: str(b['value']) ?? '' }),
        ...(b['name'] === undefined ? {} : { name: String(b['name']) }),
        ...(b['mode'] === undefined ? {} : { mode: b['mode'] as PublicSecret['mode'] }),
        ...(b['broker_spec'] === undefined ? {} : { broker_spec: b['broker_spec'] }),
        ...(b['note'] === undefined ? {} : { note: str(b['note']) ?? null }),
        ...(grants === undefined ? {} : { grants }),
      });
      answerPluginCards(secret.name, added);
      res.json(secret);
    } catch (e) { fail(res, e); }
  });

  router.delete('/api/secrets/:id', (req, res) => {
    res.json({ ok: deleteSecret(String(req.params['id'] ?? '')) });
  });

  /**
   * Re-display a stored value (amendment of the write-only contract, see the
   * header). The gate is deliberately stricter than the rest of the vault:
   * - a browser SESSION only — the daemon-token and any mission api-token are
   *   refused even when they hold `secrets:manage`, so no agent can ever read
   *   a secret through here;
   * - superadmin, like granting (deciding who sees a value is at least as
   *   sensitive as deciding who receives it);
   * - the account password again, throttled like a login: a stolen cookie
   *   alone must not be enough to read the vault.
   * Every attempt leaves an audit row and a journal line, with no value in it.
   */
  router.post('/api/secrets/:id/reveal', async (req, res) => {
    if (!isPersonAuth(req.auth) || !req.auth.user) {
      res.status(403).json(apiError('secret_reveal_session_required', 'a signed-in session is required'));
      return;
    }
    if (!requireSuperadmin(req, res)) return;
    const session = req.auth.user;
    const keys = throttleKeys(req, 'reveal', session.email);
    const verdict = checkThrottle(keys);
    if (!verdict.allowed) {
      sendThrottled(res, verdict);
      return;
    }
    const parsed = REVEAL_BODY.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(apiError('password_required', 'password required'));
      return;
    }
    const id = String(req.params['id'] ?? '');
    const secret = getSecret(id);
    const journal = (outcome: 'ok' | 'denied', detail: string): void => {
      auditRequest(req, outcome === 'ok' ? 'secret.reveal' : 'secret.reveal.denied', `secret:${id}`);
      dbApi.recordSecretAccess({
        secret_id: id,
        name: secret?.name ?? id,
        kind: 'reveal',
        outcome,
        detail: `${detail} (user ${session.id})`,
      });
    };
    const user = dbApi.getUserById(session.id);
    if (!user || !(await testCredential(keys, () => verifyAccountPassword(parsed.data.password, user)))) {
      noteAuthFailure(req, keys);
      journal('denied', 'wrong password');
      res.status(401).json(apiError('invalid_credentials', 'invalid credentials'));
      return;
    }
    clearThrottle(keys);
    if (!secret) {
      res.status(404).json(apiError('secret_unknown', 'unknown secret'));
      return;
    }
    try {
      const value = readSecretValue(id);
      journal('ok', 'revealed');
      res.setHeader('Cache-Control', 'no-store');
      res.json({ value });
    } catch (e) { fail(res, e); }
  });

  router.post('/api/secrets/:id/grants', (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    try {
      const scope = scopeOf(body(req)['scope'] ?? body(req));
      const secret = grantSecret(String(req.params['id'] ?? ''), scope);
      answerPluginCards(secret.name, [typeof scope === 'string' ? parseSecretScope(scope) : scope]);
      res.json(secret);
    } catch (e) { fail(res, e); }
  });

  router.delete('/api/secrets/:id/grants', (req, res) => {
    try {
      const scope = req.query['scope'] !== undefined ? String(req.query['scope']) : scopeOf(body(req)['scope'] ?? body(req));
      const id = String(req.params['id'] ?? '');
      if (revokeLiftsBackendReservation(id, scope) && !requireSuperadmin(req, res)) return;
      res.json(revokeSecret(id, scope));
    } catch (e) { fail(res, e); }
  });

  /**
   * Access journal (§8). A journal is readable even once its secret is gone —
   * that is the point of an audit trail, so no 404 on a missing secret here.
   * The S.5 stub answered `{ access: [] }` so the UI never reported "no such
   * secret" for a secret that exists; this is the same shape, filled.
   */
  router.get('/api/secrets/:id/access', (req, res) => {
    const id = String(req.params['id'] ?? '');
    const limit = Number.parseInt(String(req.query['limit'] ?? ''), 10);
    res.json({ access: dbApi.listSecretAccess(id, Number.isFinite(limit) ? limit : 200) });
  });
}
