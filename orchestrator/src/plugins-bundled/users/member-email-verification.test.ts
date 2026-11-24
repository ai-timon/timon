/**
 * The address of a member account (invited, or created by an admin through the
 * account provider) and of a login moved by an email change: nobody proved
 * they read it, so the relay would refuse a reset code. The account is kept
 * unconfirmed, and its signed-in owner confirms it with a mailed code
 * (`docs/EMAIL-CODES.md`). Witness daemon and fake relay on 127.0.0.1:0.
 *
 * What matters: anonymous callers are refused; a wrong, expired or exhausted
 * code confirms nothing; a relay that cannot be reached, or cannot mail, is a
 * clear 503; the right code records the pair at the relay; a moved login asks
 * for its code again, mailed to the new address.
 */
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { TEST_ACCOUNT_PROVIDER_ID } from '../../../tests/helpers/accounts.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(join(process.env.TIMON_HOME!, 'timon.config.json'), JSON.stringify({ authThrottle: { maxAttempts: 1000 } }));

type RelayCall = { path: string; body: Record<string, string> };
const relayCalls: RelayCall[] = [];
let relayMode: 'ok' | 'down' = 'ok';
const relay = express();
relay.use(express.json());
relay.post('/api/v1/mail/code', (req, res) => {
  relayCalls.push({ path: req.path, body: req.body as Record<string, string> });
  if (relayMode === 'down') { res.status(503).json({ error: 'mail_unavailable' }); return; }
  res.status(202).json({ sent: true });
});
relay.post('/api/v1/mail/verified', (req, res) => {
  relayCalls.push({ path: req.path, body: req.body as Record<string, string> });
  res.status(204).end();
});
const relayServer = relay.listen(0, '127.0.0.1');
await once(relayServer, 'listening');
const relayBase = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`;

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { EmailCodeStore, EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_RESEND_MS, EMAIL_CODE_TTL_MS } = await import('../../users/email-code.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { dbApi } = await import('../../db.js');
const { createAccountProviderFacade } = await import('../../plugins/account-provider-facade.js');
type MailRelayOptions = import('../../users/mail-relay.js').MailRelayOptions;

const TOKEN = 'witness-daemon-token';
const clock = { now: Date.now() };
const store = new EmailCodeStore({ now: () => clock.now, originRequests: Infinity });
// Mutable on purpose: the offline test points it at a dead port.
const relayOptions: MailRelayOptions = { baseUrl: relayBase };
const daemon = express();
daemon.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
daemon.use(express.json());
registerRoutes(daemon, { setupPolicy: 'free', emailVerification: true, emailCodes: store, mailRelay: relayOptions });
const server = daemon.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); relayServer.close(); });

type Json = Record<string, unknown>;
async function call(method: string, path: string, body: unknown, cookie?: string): Promise<{ status: number; json: Json; res: Response }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(cookie)}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Json : {}, res };
}

function sessionCookie(res: Response): string {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return '';
}

function lastCode(): { email: string; code: string } {
  const sent = [...relayCalls].reverse().find((c) => c.path === '/api/v1/mail/code');
  assert.ok(sent, 'the relay received a code');
  return { email: sent.body.email!, code: sent.body.code! };
}

function wrong(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

const MEMBER = 'member@example.com';
const PASSWORD = 'member-password';
let memberId = '';
let cookie = '';

test('an account the provider creates keeps its address unconfirmed, and the app is told', async () => {
  const provider = createAccountProviderFacade({
    pluginId: TEST_ACCOUNT_PROVIDER_ID,
    assertPermission: () => {},
    trusted: true,
    onUnload: () => {},
  });
  const created = provider.provision({ email: MEMBER, name: 'Member', password: PASSWORD });
  memberId = created.id;
  assert.equal(dbApi.userEmailUnverified(memberId), true);
  // An invited account is created before its owner ever signs in: unconfirmed too.
  const invited = provider.provision({ email: 'invited@example.com', name: 'Invited', password: 'invite-placeholder', status: 'invited' });
  assert.equal(dbApi.userEmailUnverified(invited.id), true);

  const login = await call('POST', '/api/auth/login', { email: MEMBER, password: PASSWORD });
  assert.equal(login.status, 200);
  cookie = sessionCookie(login.res);
  assert.ok(cookie);
  const me = await call('GET', '/api/auth/me', undefined, cookie);
  assert.equal(me.json.emailUnverified, true);
});

test('an anonymous caller reaches none of the confirmation routes', async () => {
  for (const path of ['/api/auth/email-verification', '/api/auth/email-verification/resend', '/api/auth/email-verification/confirm']) {
    const anonymous = await call('POST', path, { challengeId: 'a'.repeat(32), code: '123456' });
    assert.equal(anonymous.status, 401, path);
  }
  assert.equal(dbApi.userEmailUnverified(memberId), true);
});

test('a relay that cannot be reached, or cannot mail, is a clear 503 and leaves the address waiting', async () => {
  relayMode = 'down';
  const down = await call('POST', '/api/auth/email-verification', {}, cookie);
  assert.equal(down.status, 503);
  assert.equal(down.json.code, 'email_service_unavailable');
  relayMode = 'ok';

  const deadServer = express().listen(0, '127.0.0.1');
  await once(deadServer, 'listening');
  const deadUrl = `http://127.0.0.1:${(deadServer.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => { deadServer.close(() => resolve()); });
  relayOptions.baseUrl = deadUrl;
  try {
    const offline = await call('POST', '/api/auth/email-verification', {}, cookie);
    assert.equal(offline.status, 503);
    assert.equal(offline.json.code, 'email_connection_required');
  } finally {
    relayOptions.baseUrl = relayBase;
  }
  assert.equal(dbApi.userEmailUnverified(memberId), true);
});

test('an expired code confirms nothing', async () => {
  const asked = await call('POST', '/api/auth/email-verification', { locale: 'fr' }, cookie);
  assert.equal(asked.status, 202);
  const sent = lastCode();
  assert.equal(sent.email, MEMBER);
  clock.now += EMAIL_CODE_TTL_MS + 1;
  const late = await call('POST', '/api/auth/email-verification/confirm', { challengeId: asked.json.challengeId, code: sent.code }, cookie);
  assert.equal(late.status, 410);
  assert.equal(late.json.code, 'email_code_expired');
  assert.equal(dbApi.userEmailUnverified(memberId), true);
});

test('wrong codes burn the challenge: five per code, ten over its resends, then start over', async () => {
  const asked = await call('POST', '/api/auth/email-verification', {}, cookie);
  assert.equal(asked.status, 202);
  const challengeId = String(asked.json.challengeId);
  for (let round = 0; round < 2; round += 1) {
    const { code } = lastCode();
    for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i += 1) {
      const refused = await call('POST', '/api/auth/email-verification/confirm', { challengeId, code: wrong(code) }, cookie);
      assert.equal(refused.status, 400);
      assert.equal(refused.json.code, i === EMAIL_CODE_MAX_ATTEMPTS - 1 ? 'email_code_exhausted' : 'email_code_invalid');
    }
    const burnt = await call('POST', '/api/auth/email-verification/confirm', { challengeId, code }, cookie);
    assert.equal(burnt.status, 400);
    assert.equal(burnt.json.code, 'email_code_exhausted', 'the right code comes too late');
    clock.now += EMAIL_CODE_RESEND_MS + 1;
    const resent = await call('POST', '/api/auth/email-verification/resend', { challengeId }, cookie);
    if (round === 0) assert.equal(resent.status, 202);
    else {
      assert.equal(resent.status, 429);
      assert.equal(resent.json.code, 'email_code_send_limit');
    }
  }
  assert.equal(dbApi.userEmailUnverified(memberId), true);
});

test('the right code confirms the address and the relay records it', async () => {
  clock.now += EMAIL_CODE_RESEND_MS + 1;
  const asked = await call('POST', '/api/auth/email-verification', {}, cookie);
  assert.equal(asked.status, 202);
  const { code } = lastCode();
  const ok = await call('POST', '/api/auth/email-verification/confirm', { challengeId: asked.json.challengeId, code }, cookie);
  assert.equal(ok.status, 200);
  assert.equal(dbApi.userEmailUnverified(memberId), false);
  const recorded = relayCalls.filter((c) => c.path === '/api/v1/mail/verified').at(-1);
  assert.equal(recorded?.body.email, MEMBER);
});

test('a moved login asks for its code again, mailed to the new address', async () => {
  const NEW = 'member.new@example.com';
  const requested = await call('POST', '/api/auth/email', { email: NEW, current_password: PASSWORD }, cookie);
  assert.equal(requested.status, 201);
  // Still the old address, confirmed, until the link is followed.
  assert.equal(dbApi.userEmailUnverified(memberId), false);
  const moved = await call('POST', '/api/auth/email/confirm', { token: requested.json.token });
  assert.equal(moved.status, 200);
  assert.equal(dbApi.getUserById(memberId)?.email, NEW);
  assert.equal(dbApi.userEmailUnverified(memberId), true);

  const asked = await call('POST', '/api/auth/email-verification', {}, cookie);
  assert.equal(asked.status, 202);
  assert.equal(asked.json.email, NEW);
  const sent = lastCode();
  assert.equal(sent.email, NEW);
  const ok = await call('POST', '/api/auth/email-verification/confirm', { challengeId: asked.json.challengeId, code: sent.code }, cookie);
  assert.equal(ok.status, 200);
  assert.equal(dbApi.userEmailUnverified(memberId), false);
  assert.equal(relayCalls.filter((c) => c.path === '/api/v1/mail/verified').at(-1)?.body.email, NEW);
});
