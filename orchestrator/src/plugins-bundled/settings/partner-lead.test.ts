/**
 * The agency offer against a simulated site (a loopback HTTP server), never
 * the real one: the contract's body, the token kept and replaced, the retries
 * (offline, 429) that wait for their turn, the refusals (400, 413) that are
 * never retried, and the withdrawal (204, 404, offline). Neither the address
 * nor the token ever reaches a log line.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  CONSENT_VERSION, PARTNER_LEADS_URL, PartnerLeads, RETRY_BASE_MS, normalizeLocale, partnersDestination, partnersServerOverride,
} = await import('./partner-lead.js');

type Hit = { method: string; url: string; body: Record<string, unknown> };
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** The site, simulated: records each request and answers with the next scripted reply. */
async function fakeSite(): Promise<{ hits: Hit[]; replies: Reply[]; url: string; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const replies: Reply[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) as Record<string, unknown> : {} });
      const reply = replies.shift() ?? { status: 500 };
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    hits, replies,
    url: `http://127.0.0.1:${port}/api/partners/leads`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** A port nobody listens on: what an offline machine sees. */
async function deadUrl(): Promise<string> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/api/partners/leads`;
}

const EMAIL = '  Boss@Agency.Example ';
const NORMALIZED = 'boss@agency.example';

function setup(destination: () => string | null): { leads: InstanceType<typeof PartnerLeads>; file: string; logs: string[]; clock: { now: number } } {
  const file = join(mkdtempSync(join(tmpdir(), 'timon-leads-')), 'partner-leads.json');
  const logs: string[] = [];
  const clock = { now: 1_000_000 };
  const leads = new PartnerLeads({
    file, destination, now: () => clock.now, appVersion: () => '0.1.8-rc.2', timeoutMs: 2_000, log: (line) => logs.push(line),
  });
  return { leads, file, logs, clock };
}

test('a lead is POSTed on the exact contract and its token kept, 0600, never logged', async () => {
  const site = await fakeSite();
  try {
    const { leads, file, logs } = setup(() => site.url);
    site.replies.push({ status: 201, body: { withdrawToken: 'tok-1' } });
    const view = await leads.subscribe('u1', EMAIL, 'fr-FR');
    assert.equal(view.state, 'subscribed');
    assert.equal(view.email, NORMALIZED);
    assert.deepEqual(site.hits, [{
      method: 'POST', url: '/api/partners/leads',
      body: { email: NORMALIZED, usageKind: 'agency', locale: 'fr-FR', appVersion: '0.1.8-rc.2', consentVersion: CONSENT_VERSION },
    }]);
    assert.equal(CONSENT_VERSION, '2026-11-15');
    assert.match(readFileSync(file, 'utf8'), /tok-1/);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(logs, []);
  } finally {
    await site.close();
  }
});

test('a new POST replaces the token: the latest one is kept and withdraws', async () => {
  const site = await fakeSite();
  try {
    const { leads, file } = setup(() => site.url);
    site.replies.push({ status: 201, body: { withdrawToken: 'tok-old' } }, { status: 201, body: { withdrawToken: 'tok-new' } }, { status: 204 });
    await leads.subscribe('u1', EMAIL, 'fr');
    await leads.subscribe('u1', 'other@agency.example', 'fr');
    assert.doesNotMatch(readFileSync(file, 'utf8'), /tok-old/);
    const view = await leads.withdraw('u1');
    assert.equal(view.state, 'none');
    assert.deepEqual(site.hits[2], { method: 'DELETE', url: '/api/partners/leads', body: { withdrawToken: 'tok-new' } });
    assert.doesNotMatch(readFileSync(file, 'utf8'), /tok-new|agency\.example/, 'nothing of the lead is left on the machine');
  } finally {
    await site.close();
  }
});

test('429: the lead waits for its turn (Retry-After), no tight loop, then goes', async () => {
  const site = await fakeSite();
  try {
    const { leads, clock, logs } = setup(() => site.url);
    site.replies.push({ status: 429, headers: { 'retry-after': '600' } });
    const view = await leads.subscribe('u1', EMAIL, 'pt-BR');
    assert.equal(view.state, 'pending');
    assert.equal(view.error, 'rate_limited');
    await leads.tick();
    await leads.tick();
    assert.equal(site.hits.length, 1, 'nothing is due yet');
    clock.now += 599_000;
    await leads.tick();
    assert.equal(site.hits.length, 1, 'Retry-After is honoured');
    clock.now += 2_000;
    site.replies.push({ status: 201, body: { withdrawToken: 'tok' } });
    await leads.tick();
    assert.equal(site.hits.length, 2);
    assert.equal(leads.view('u1').state, 'subscribed');
    assert.ok(logs.every((line) => !line.includes('agency.example') && !line.includes('tok')), 'no address nor token in a log');
  } finally {
    await site.close();
  }
});

test('offline: the lead stays pending on a growing delay, and goes at the next start once online', async () => {
  let url = await deadUrl();
  const { leads, clock, logs } = setup(() => url);
  const view = await leads.subscribe('u1', EMAIL, 'fr');
  assert.equal(view.state, 'pending');
  assert.equal(view.error, 'unreachable');
  clock.now += RETRY_BASE_MS;
  await leads.tick();
  clock.now += RETRY_BASE_MS;
  await leads.tick();
  assert.equal(leads.view('u1').state, 'pending', 'second retry not due yet: the delay doubled');
  assert.equal(logs.length, 1, 'one line per kind of failure, not one per attempt');
  const site = await fakeSite();
  try {
    url = site.url;
    site.replies.push({ status: 201, body: { withdrawToken: 'tok' } });
    leads.resetSchedule();
    await leads.tick();
    assert.equal(site.hits.length, 1);
    assert.equal(leads.view('u1').state, 'subscribed');
  } finally {
    await site.close();
  }
});

test('400 and 413 are never retried and read as an error', async () => {
  const site = await fakeSite();
  try {
    const { leads, clock } = setup(() => site.url);
    site.replies.push({ status: 400, body: { error: 'invalid email boss@agency.example' } });
    const invalid = await leads.subscribe('u1', EMAIL, 'fr');
    assert.deepEqual([invalid.state, invalid.error], ['rejected', 'invalid']);
    site.replies.push({ status: 413 });
    const large = await leads.subscribe('u2', EMAIL, 'fr');
    assert.deepEqual([large.state, large.error], ['rejected', 'too_large']);
    clock.now += 24 * 3_600_000;
    leads.resetSchedule();
    await leads.tick();
    assert.equal(site.hits.length, 2, 'a refusal is not tried again, even at the next start');
  } finally {
    await site.close();
  }
});

test('withdrawal: 404 counts as done and erases the token; offline it waits and is sent later', async () => {
  const site = await fakeSite();
  try {
    const { leads, file, clock } = setup(() => site.url);
    site.replies.push({ status: 201, body: { withdrawToken: 'tok-a' } }, { status: 404 });
    await leads.subscribe('u1', EMAIL, 'fr');
    assert.equal((await leads.withdraw('u1')).state, 'none');
    assert.doesNotMatch(readFileSync(file, 'utf8'), /tok-a/);

    site.replies.push({ status: 201, body: { withdrawToken: 'tok-b' } }, { status: 503 }, { status: 204 });
    await leads.subscribe('u2', EMAIL, 'fr');
    assert.equal((await leads.withdraw('u2')).state, 'withdrawing');
    clock.now += RETRY_BASE_MS;
    await leads.tick();
    assert.equal(leads.view('u2').state, 'none');
    assert.deepEqual(site.hits.at(-1), { method: 'DELETE', url: '/api/partners/leads', body: { withdrawToken: 'tok-b' } });
  } finally {
    await site.close();
  }
});

test('a lead never sent is withdrawn on the spot; without a destination nothing is attempted', async () => {
  const { leads } = setup(() => null);
  const view = await leads.subscribe('u1', EMAIL, 'fr');
  assert.deepEqual([view.state, view.error], ['pending', 'unavailable']);
  assert.equal((await leads.withdraw('u1')).state, 'none');
});

test('the destination: the real site from any daemon, a loopback stand-in first, never under a test', () => {
  assert.equal(PARTNER_LEADS_URL, 'https://timon-ai.com/api/partners/leads');
  assert.equal(partnersDestination({}, false), PARTNER_LEADS_URL, 'packaged or from source, outside a test');
  assert.equal(partnersDestination({}), null, 'this suite runs under the runner: read from the process, not only the env passed');
  assert.equal(partnersDestination({ NODE_ENV: 'test' }), null);
  assert.equal(partnersDestination({ NODE_TEST_CONTEXT: 'child' }, true), null);
  assert.equal(partnersDestination({ TIMON_PARTNERS_SERVER: 'http://127.0.0.1:9' }, false), 'http://127.0.0.1:9/api/partners/leads', 'the stand-in comes first');
  assert.equal(partnersDestination({ TIMON_PARTNERS_SERVER: 'http://127.0.0.1:9' }), 'http://127.0.0.1:9/api/partners/leads');
  assert.equal(partnersDestination({ TIMON_PARTNERS_SERVER: 'https://evil.example' }, false), PARTNER_LEADS_URL, 'a non-loopback stand-in is ignored');
  assert.equal(partnersServerOverride('https://evil.example'), null);
  assert.equal(partnersServerOverride('http://user:pw@127.0.0.1:9'), null);
});

test('a daemon under test never reaches timon-ai.com, whatever its environment says', async () => {
  const saved = process.env.TIMON_PARTNERS_SERVER;
  delete process.env.TIMON_PARTNERS_SERVER;
  const urls: string[] = [];
  try {
    const leads = new PartnerLeads({
      file: join(mkdtempSync(join(tmpdir(), 'timon-leads-prod-')), 'partner-leads.json'),
      // The default destination, as the daemon builds it.
      fetch: (async (url: string | URL | Request) => { urls.push(String(url)); return Response.json({ withdrawToken: 'x' }, { status: 201 }); }) as typeof fetch,
      log: () => undefined,
    });
    const view = await leads.subscribe('u1', EMAIL, 'fr');
    await leads.tick();
    assert.deepEqual(urls, [], 'no request at all');
    assert.deepEqual([view.state, view.error], ['pending', 'unavailable']);
  } finally {
    if (saved !== undefined) process.env.TIMON_PARTNERS_SERVER = saved;
  }
});

test('locales take the contract\'s three shapes', () => {
  assert.equal(normalizeLocale('fr'), 'fr');
  assert.equal(normalizeLocale('fr-fr'), 'fr-FR');
  assert.equal(normalizeLocale('pt_BR'), 'pt-BR');
  assert.equal(normalizeLocale('zh-Hans-CN'), null);
  assert.equal(normalizeLocale('english'), null);
});
