/**
 * The agency offer's routes: an anonymous caller is refused, so are a mission,
 * an API token and the CLI's daemon token (a consent is its owner's); only an
 * `agency` account may ask; a bad address is refused without being echoed;
 * the person reads and withdraws their own, never another account's.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

await import('../../../tests/helpers/paid-license.js');
const { registerPartnerLeadRoutes } = await import('./partner-lead-routes.js');
const { PartnerLeads } = await import('./partner-lead.js');
const { writeUsageKind } = await import('../../onboarding-usage-kind.js');
const { dbApi } = await import('../../db.js');

const agency = createTestAccount(dbApi, { email: 'l-agency@example.com', name: 'agency', passwordHash: 'x', isSuperadmin: true });
const solo = createTestAccount(dbApi, { email: 'l-solo@example.com', name: 'solo', passwordHash: 'x', isSuperadmin: true });
writeUsageKind(agency.id, 'agency');
writeUsageKind(solo.id, 'solo');
dbApi.createMission('l-mission', 'acme.main', 'help me', undefined, agency.id);

const posted: unknown[] = [];
const leads = new PartnerLeads({
  file: join(mkdtempSync(join(tmpdir(), 'timon-lead-routes-')), 'partner-leads.json'),
  destination: () => 'http://127.0.0.1:9/api/partners/leads',
  fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posted.push({ method: init?.method, body });
    return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ withdrawToken: 'tok' }, { status: 201 });
  }) as typeof fetch,
  log: () => undefined,
});

type Fake = { kind: 'daemon-token' | 'session' | 'api-token'; userId?: string; missionId?: string | null };
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  const raw = req.header('x-test-auth');
  if (raw) {
    const fake = JSON.parse(raw) as Fake;
    const user = fake.userId ? dbApi.getUserById(fake.userId) ?? null : null;
    req.auth = {
      kind: fake.kind, user,
      isSuperadmin: fake.kind === 'daemon-token' || !!user?.is_superadmin,
      missionId: fake.missionId ?? null,
      ...(fake.kind === 'api-token' ? { permissions: [] } : {}),
    };
  }
  next();
});
registerPartnerLeadRoutes(app, () => leads);
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const asAgency: Fake = { kind: 'session', userId: agency.id };
const asSolo: Fake = { kind: 'session', userId: solo.id };

async function call(method: string, who: Fake | null, body?: unknown): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/partners/lead`, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-auth': JSON.stringify(who) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

const OFFER = { email: 'Boss@Agency.example', locale: 'fr-FR' };

test('an anonymous caller is refused on every route', async () => {
  assert.equal((await call('GET', null)).status, 401);
  assert.equal((await call('POST', null, OFFER)).status, 401);
  assert.equal((await call('DELETE', null)).status, 401);
  assert.equal(posted.length, 0);
});

test('a mission, an API token and the CLI token never subscribe anyone', async () => {
  for (const who of [
    { kind: 'api-token', userId: agency.id, missionId: 'l-mission' },
    { kind: 'api-token', userId: agency.id },
    { kind: 'daemon-token', userId: agency.id },
  ] satisfies Fake[]) {
    assert.equal((await call('POST', who, OFFER)).status, 403, who.kind);
    assert.equal((await call('GET', who)).status, 403, who.kind);
    assert.equal((await call('DELETE', who)).status, 403, who.kind);
  }
  assert.equal(posted.length, 0);
});

test('only an agency account may ask; a bad address is refused without being echoed', async () => {
  assert.equal((await call('POST', asSolo, OFFER)).status, 409);
  const bad = await call('POST', asAgency, { email: 'not-an-address-zz9', locale: 'fr' });
  assert.equal(bad.status, 400);
  assert.doesNotMatch(bad.text, /zz9/);
  assert.equal((await call('POST', asAgency, { ...OFFER, locale: 'klingon-xx' })).status, 400);
  assert.equal((await call('POST', asAgency, { ...OFFER, extra: 1 })).status, 400);
  assert.equal(posted.length, 0);
});

test('the person subscribes, reads their own state, and withdraws; another account sees nothing', async () => {
  const subscribed = await call('POST', asAgency, OFFER);
  assert.equal(subscribed.status, 200);
  assert.equal(subscribed.json.state, 'subscribed');
  assert.equal(subscribed.json.email, 'boss@agency.example');
  assert.equal((await call('GET', asSolo)).json.state, 'none');
  assert.equal((await call('GET', asAgency)).json.state, 'subscribed');
  assert.equal(JSON.stringify((await call('GET', asAgency)).json).includes('tok'), false, 'the withdrawal token never leaves the daemon');
  const withdrawn = await call('DELETE', asAgency);
  assert.equal(withdrawn.json.state, 'none');
  assert.deepEqual(posted.map((p) => (p as { method: string }).method), ['POST', 'DELETE']);
});
