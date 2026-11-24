/**
 * The onboarding funnel of the setup's email code: what the routes announce
 * on the bus (`onboarding_step`, step `account`) when the relay sends the
 * code or not, and how the first account was made. Only closed words: never
 * the address, the code or the relay's text. Fake site relay and witness
 * daemon on 127.0.0.1:0, as `email-code-routes.test.ts`.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const home = mkdtempSync(join(tmpdir(), 'timon-email-code-funnel-'));
process.env.TIMON_HOME = home;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ authThrottle: { maxAttempts: 1000 } }));

let relayMode: 'ok' | 'down' | 'rate_limited' = 'ok';
let lastCode = '';
const relay = express();
relay.use(express.json());
relay.post('/api/v1/mail/code', (req, res) => {
  if (relayMode === 'down') { res.status(503).json({ error: 'mail_unavailable' }); return; }
  if (relayMode === 'rate_limited') { res.status(429).json({ error: 'rate_limited', retryAfter: 42 }); return; }
  lastCode = String((req.body as { code?: unknown }).code);
  res.status(202).json({ sent: true });
});
relay.post('/api/v1/mail/verified', (_req, res) => { res.status(204).end(); });
const relayServer = relay.listen(0, '127.0.0.1');
await once(relayServer, 'listening');
const relayBase = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`;

const { bus } = await import('../../bus.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { EmailCodeStore, EMAIL_CODE_RESEND_MS } = await import('../../users/email-code.js');
type BusEvent = import('../../bus.js').BusEvent;

const clock = { now: Date.now() };
const store = new EmailCodeStore({ now: () => clock.now, originRequests: Infinity });
const relayOptions = { baseUrl: relayBase };
const daemon = express();
daemon.use(createDaemonAuthMiddleware({ token: 'funnel-daemon-token', required: true }));
daemon.use(express.json());
registerRoutes(daemon, { setupPolicy: 'free', emailVerification: true, emailCodes: store, mailRelay: relayOptions });
const server = daemon.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const heard: Array<Extract<BusEvent, { kind: 'onboarding_step' }>> = [];
const listen = (ev: BusEvent): void => { if (ev.kind === 'onboarding_step') heard.push(ev); };
bus.on('event', listen);
test.after(() => { bus.off('event', listen); server.close(); relayServer.close(); });

type Json = Record<string, unknown>;
async function post(path: string, body: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Json : {} };
}

/** What the routes announced since `from`, without the bus kind. */
function since(from: number): Json[] {
  return heard.slice(from).map(({ kind: _kind, ...rest }) => rest);
}

const EMAIL = 'owner@example.com';

test('the relay down, rate limited or out of reach: code_failed with its reason, nothing personal', async () => {
  const from = heard.length;
  relayMode = 'down';
  assert.equal((await post('/api/auth/setup/email-code', { email: EMAIL })).status, 503);
  relayMode = 'rate_limited';
  assert.equal((await post('/api/auth/setup/email-code', { email: EMAIL })).status, 429);
  relayMode = 'ok';
  relayOptions.baseUrl = 'http://127.0.0.1:9';
  try {
    assert.equal((await post('/api/auth/setup/email-code', { email: EMAIL })).status, 503);
  } finally {
    relayOptions.baseUrl = relayBase;
  }
  assert.deepEqual(since(from), [
    { step: 'account', action: 'code_failed', reason: 'email_service_unavailable' },
    { step: 'account', action: 'code_failed', reason: 'email_rate_limited' },
    { step: 'account', action: 'code_failed', reason: 'email_connection_required' },
  ]);
  assert.equal(JSON.stringify(heard).includes(EMAIL), false);
});

let challengeId = '';
test('a code the relay accepts is code_sent, a first one', async () => {
  const from = heard.length;
  const sent = await post('/api/auth/setup/email-code', { email: EMAIL });
  assert.equal(sent.status, 202);
  challengeId = String(sent.json.challengeId);
  assert.deepEqual(since(from), [{ step: 'account', action: 'code_sent', resend: false }]);
});

test('a resend too soon is code_failed, a resend once allowed is code_sent with resend', async () => {
  const from = heard.length;
  assert.equal((await post('/api/auth/setup/email-code/resend', { challengeId })).status, 429);
  clock.now += EMAIL_CODE_RESEND_MS + 1;
  assert.equal((await post('/api/auth/setup/email-code/resend', { challengeId })).status, 202);
  assert.equal((await post('/api/auth/setup/email-code/resend', { challengeId: 'f'.repeat(32) })).status, 410);
  assert.deepEqual(since(from), [
    { step: 'account', action: 'code_failed', reason: 'email_code_too_soon' },
    { step: 'account', action: 'code_sent', resend: true },
    { step: 'account', action: 'code_failed', reason: 'email_code_expired' },
  ]);
});

test('the account made with its code is account / completed via code', async () => {
  const from = heard.length;
  const created = await post('/api/auth/setup', { email: EMAIL, name: 'Owner', password: 'first-password', challengeId, code: lastCode });
  assert.equal(created.status, 201);
  assert.deepEqual(since(from), [{ step: 'account', action: 'completed', via: 'code' }]);
});

test('a password reset code is not part of the onboarding funnel', async () => {
  const from = heard.length;
  assert.equal((await post('/api/auth/password-reset', { email: EMAIL })).status, 202);
  relayMode = 'down';
  try {
    assert.equal((await post('/api/auth/password-reset', { email: 'other@example.com' })).status, 503);
  } finally {
    relayMode = 'ok';
  }
  assert.deepEqual(since(from), []);
});
