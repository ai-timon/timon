/**
 * The first account made from a terminal (`timon user create-admin`) for a
 * machine that cannot reach the mail relay, then its address confirmed from
 * the owner's first signed-in session. Witness daemon and fake relay on
 * 127.0.0.1:0.
 *
 * What matters: only the daemon token creates it (anonymous and browser
 * session refused), never a second account, the address is kept unconfirmed,
 * and only its signed-in owner confirms it with the mailed code.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const home = mkdtempSync(join(tmpdir(), 'timon-first-admin-'));
process.env.TIMON_HOME = home;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ authThrottle: { maxAttempts: 1000 } }));

type RelayCall = { path: string; body: Record<string, string> };
const relayCalls: RelayCall[] = [];
let relayDown = false;
const relay = express();
relay.use(express.json());
relay.post('/api/v1/mail/code', (req, res) => {
  relayCalls.push({ path: req.path, body: req.body as Record<string, string> });
  res.status(202).json({ sent: true });
});
relay.post('/api/v1/mail/verified', (req, res) => {
  relayCalls.push({ path: req.path, body: req.body as Record<string, string> });
  if (relayDown) { res.status(503).json({ error: 'unavailable' }); return; }
  res.status(204).end();
});
const relayServer = relay.listen(0, '127.0.0.1');
await once(relayServer, 'listening');
const relayBase = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`;

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { EmailCodeStore } = await import('../../users/email-code.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { dbApi } = await import('../../db.js');

const TOKEN = 'witness-daemon-token';
const store = new EmailCodeStore({ originRequests: Infinity });
const daemon = express();
daemon.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
daemon.use(express.json());
registerRoutes(daemon, { setupPolicy: 'free', emailVerification: true, emailCodes: store, mailRelay: { baseUrl: relayBase } });
const server = daemon.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); relayServer.close(); });

type Json = Record<string, unknown>;
type Caller = { token?: string; cookie?: string };
async function call(method: string, path: string, body: unknown, who: Caller = {}): Promise<{ status: number; json: Json; res: Response }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who.token) headers.authorization = `Bearer ${who.token}`;
  if (who.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(who.cookie)}`;
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

function lastCode(): string {
  const sent = [...relayCalls].reverse().find((c) => c.path === '/api/v1/mail/code');
  assert.ok(sent, 'the relay received a code');
  return sent.body.code!;
}

const EMAIL = 'owner@example.com';
const PASSWORD = 'offline-password';
const account = { email: EMAIL, name: 'Owner', password: PASSWORD };
const operator: Caller = { token: TOKEN };

test('an anonymous caller cannot create the first account from the operator route', async () => {
  const anonymous = await call('POST', '/api/users/first-admin', account);
  assert.equal(anonymous.status, 401);
  const wrongToken = await call('POST', '/api/users/first-admin', account, { token: 'not-the-token' });
  assert.equal(wrongToken.status, 401);
  assert.equal(dbApi.countUsers(), 0);
});

test('the operator route checks its fields and never answers the password back', async () => {
  const short = await call('POST', '/api/users/first-admin', { ...account, password: 'short' }, operator);
  assert.equal(short.status, 400);
  assert.equal(short.json.code, 'setup_fields_required');
  const noEmail = await call('POST', '/api/users/first-admin', { ...account, email: 'nope' }, operator);
  assert.equal(noEmail.status, 400);
  assert.equal(dbApi.countUsers(), 0);
});

let ownerCookie = '';

test('the daemon token creates the first superadmin, no code asked, the address kept unconfirmed', async () => {
  const before = relayCalls.length;
  const { bus } = await import('../../bus.js');
  const heard: unknown[] = [];
  const listen = (ev: { kind: string }): void => { if (ev.kind === 'onboarding_step') heard.push(ev); };
  bus.on('event', listen);
  const created = await call('POST', '/api/users/first-admin', { ...account, email: ' Owner@Example.com ' }, operator);
  bus.off('event', listen);
  assert.equal(created.status, 201);
  assert.deepEqual(heard, [{ kind: 'onboarding_step', step: 'account', action: 'completed', via: 'operator' }]);
  const user = created.json.user as Json;
  assert.equal(user.email, EMAIL);
  assert.equal(user.is_superadmin, true);
  assert.equal(created.json.emailUnverified, true);
  assert.equal(JSON.stringify(created.json).includes(PASSWORD), false);
  assert.equal(sessionCookie(created.res), '', 'no session is opened for the terminal');
  assert.equal(relayCalls.length, before, 'the relay is never called');
  assert.equal(dbApi.userEmailUnverified(String(user.id)), true);

  const login = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  assert.equal(login.status, 200);
  ownerCookie = sessionCookie(login.res);
  assert.ok(ownerCookie);
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(ownerCookie)}` } });
  assert.equal((await me.json() as Json).emailUnverified, true);
});

test('once an account exists the route refuses, and points at reset-password', async () => {
  const again = await call('POST', '/api/users/first-admin', { ...account, email: 'second@example.com' }, operator);
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'already_set_up');
  assert.match(String(again.json.error), /reset-password/);
  assert.equal(dbApi.countUsers(), 1);
});

test('a browser session, even the superadmin\'s, is refused by the operator route', async () => {
  const fromBrowser = await call('POST', '/api/users/first-admin', { ...account, email: 'third@example.com' }, { cookie: ownerCookie });
  assert.equal(fromBrowser.status, 404);
  assert.equal(dbApi.countUsers(), 1);
});

test('confirming the address needs the owner\'s browser session', async () => {
  const anonymous = await call('POST', '/api/auth/email-verification', {});
  assert.equal(anonymous.status, 401);
  const terminal = await call('POST', '/api/auth/email-verification', {}, operator);
  assert.equal(terminal.status, 403);
  assert.equal(terminal.json.code, 'session_required');
});

test('the owner confirms the address with the mailed code; a relay that does not record it keeps the code', async () => {
  const asked = await call('POST', '/api/auth/email-verification', { locale: 'en' }, { cookie: ownerCookie });
  assert.equal(asked.status, 202);
  assert.equal(asked.json.email, EMAIL);
  const challengeId = String(asked.json.challengeId);
  const code = lastCode();
  assert.equal(JSON.stringify(asked.json).includes(code), false, 'the code never comes back');

  const wrong = await call('POST', '/api/auth/email-verification/confirm', { challengeId, code: code === '000000' ? '111111' : '000000' }, { cookie: ownerCookie });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.code, 'email_code_invalid');

  relayDown = true;
  const down = await call('POST', '/api/auth/email-verification/confirm', { challengeId, code }, { cookie: ownerCookie });
  assert.equal(down.status, 503);
  assert.equal(down.json.code, 'email_service_unavailable');
  relayDown = false;

  const ok = await call('POST', '/api/auth/email-verification/confirm', { challengeId, code }, { cookie: ownerCookie });
  assert.equal(ok.status, 200);
  const owner = dbApi.getUserByEmail(EMAIL)!;
  assert.equal(dbApi.userEmailUnverified(owner.id), false);
  const recorded = relayCalls.filter((c) => c.path === '/api/v1/mail/verified');
  assert.equal(recorded.at(-1)?.body.email, EMAIL);

  const twice = await call('POST', '/api/auth/email-verification', {}, { cookie: ownerCookie });
  assert.equal(twice.status, 409);
  assert.equal(twice.json.code, 'email_already_confirmed');
});
