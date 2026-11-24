/**
 * Routes of the HTML documents (ADR-MCPUI D3, D4). The refusals matter most:
 * anonymous, the daemon token, another mission's token and another account
 * are all turned away, the HTML leaves to a session only, under the host's
 * CSP, and the reply never leaves to someone who may not read it (D8).
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';

await import('../../../tests/helpers/paid-license.js');
const { registerRoutes } = await import('./routes.js');
const { createUiDocument, MAX_HTML_BYTES, MAX_DOCUMENTS_PER_MISSION, UI_DOCUMENT_EVENT } = await import('./model.js');
const { purgeUiDocumentsOnce } = await import('./index.js');
const { db, dbApi } = await import('../../db.js');
const { setRedactionSource } = await import('../../secrets/redact.js');
const { scopedDb } = await import('../../users/scoped-db.js');

const owner = createTestAccount(dbApi, { email: 'owner@example.com', name: 'owner', passwordHash: 'x', isSuperadmin: false });
const stranger = createTestAccount(dbApi, { email: 'other@example.com', name: 'other', passwordHash: 'x', isSuperadmin: false });
const admin = createTestAccount(dbApi, { email: 'admin@example.com', name: 'admin', passwordHash: 'x', isSuperadmin: true });
for (const id of ['m-a', 'm-b', 'm-cap', 'm-path', 'm-secret', 'm-d8']) dbApi.createMission(id, 'timon.coder', 'work', undefined, owner.id);
dbApi.createMission('m-orphan', 'timon.coder', 'work', undefined, null);
dbApi.createMission('m-other', 'timon.coder', 'work', undefined, stranger.id);

type Fake = { kind: 'daemon-token' | 'session' | 'api-token'; userId?: string; missionId?: string | null };
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use((req, _res, next) => {
  const raw = req.header('x-test-auth');
  if (raw) {
    const fake = JSON.parse(raw) as Fake;
    const user = fake.userId ? dbApi.getUserById(fake.userId) ?? null : null;
    req.auth = { kind: fake.kind, user, isSuperadmin: fake.kind === 'daemon-token' || !!user?.is_superadmin, missionId: fake.missionId ?? null };
  }
  next();
});
// No test here waits for an answer: `requests.test.ts` covers the wait.
registerRoutes(app, { waitMs: () => 0, deliverLate: () => undefined });
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ui-documents`;

function send(method: string, path: string, auth: Fake | null, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { 'x-test-auth': JSON.stringify(auth) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const agentOf = (missionId: string): Fake => ({ kind: 'api-token', userId: owner.id, missionId });
const ownerSession: Fake = { kind: 'session', userId: owner.id };
const strangerSession: Fake = { kind: 'session', userId: stranger.id };
const daemon: Fake = { kind: 'daemon-token' };
const HTML = '<!doctype html><html><body><script>document.body.dataset.x = "1"</script><p>Pick</p></body></html>';

async function show(missionId: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await send('POST', '', agentOf(missionId), { title: 'Pick one', html: HTML, ...body });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { id: string }).id;
}

test.describe('ui documents', { concurrency: false }, () => {
  test('anonymous is refused everywhere', async () => {
    const id = await show('m-a');
    assert.equal((await send('POST', '', null, { title: 't', html: HTML })).status, 401);
    assert.equal((await send('GET', '?mission_id=m-a', null)).status, 401);
    assert.equal((await send('GET', `/${id}`, null)).status, 401);
    assert.equal((await send('GET', `/${id}/document`, null)).status, 401);
  });

  test('the daemon token neither creates nor opens a document', async () => {
    const id = await show('m-a');
    assert.equal((await send('POST', '', daemon, { title: 't', html: HTML, mission_id: 'm-a' })).status, 403);
    assert.equal((await send('GET', `/${id}/document`, daemon)).status, 403);
    assert.equal((await send('GET', `/${id}`, daemon)).status, 403);
    assert.equal((await send('GET', '?mission_id=m-a', daemon)).status, 403);
    assert.equal((await send('POST', '', { kind: 'api-token', userId: owner.id, missionId: null }, { title: 't', html: HTML, mission_id: 'm-a' })).status, 403, 'a token with no mission');
  });

  test('an agent shows a document in its own mission only', async () => {
    const res = await send('POST', '', agentOf('m-a'), { title: 'Pick one', html: HTML });
    assert.equal(res.status, 201);
    const out = await res.json() as { id: string; status: string; document: Record<string, unknown> };
    assert.equal(out.status, 'shown');
    assert.deepEqual(out.document.origin, { kind: 'agent', id: 'timon.coder' });
    assert.ok(!('html' in out.document));
    assert.equal((await send('POST', '', agentOf('m-a'), { title: 't', html: HTML, mission_id: 'm-b' })).status, 403);
    const events = dbApi.listEvents('m-a').filter((e) => e.type === UI_DOCUMENT_EVENT);
    assert.ok(events.some((e) => JSON.parse(e.payload).id === out.id), 'the card is in the conversation');
    assert.ok(!events.some((e) => e.payload.includes('<p>Pick</p>')), 'without the HTML');
  });

  test('another mission\'s token and another account get a 404', async () => {
    const id = await show('m-a');
    assert.equal((await send('GET', `/${id}`, agentOf('m-b'))).status, 404);
    assert.equal((await send('GET', '?mission_id=m-a', agentOf('m-b'))).status, 404);
    assert.equal((await send('GET', `/${id}`, strangerSession)).status, 404);
    assert.equal((await send('GET', `/${id}/document`, strangerSession)).status, 404);
    assert.equal((await send('GET', '?mission_id=m-a', strangerSession)).status, 404);
    assert.equal((await send('POST', '', strangerSession, { title: 't', html: HTML, mission_id: 'm-a' })).status, 404);
    assert.equal((await send('GET', `/${randomUUID()}`, ownerSession)).status, 404);
  });

  test('a mission\'s token does not open the HTML; the reader\'s session does, under the host\'s CSP', async () => {
    const id = await show('m-a');
    assert.equal((await send('GET', `/${id}/document`, agentOf('m-a'))).status, 403);
    const res = await send('GET', `/${id}/document`, ownerSession);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.startsWith('sandbox allow-scripts allow-forms;'), csp);
    assert.ok(!csp.includes('allow-same-origin'));
    assert.ok(csp.includes("frame-ancestors 'self'"));
    assert.ok(csp.includes("default-src 'none'"));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-type') ?? '', /^text\/html; charset=utf-8/);
    const body = await res.text();
    assert.ok(body.startsWith('<!doctype html><script>'), 'the bootstrap right after the doctype');
    assert.ok(body.indexOf('ui/initialize') < body.indexOf('document.body.dataset.x'), 'before the document\'s first script');
    // A superadmin session reads it too: it reads the mission.
    assert.equal((await send('GET', `/${id}/document`, { kind: 'session', userId: admin.id })).status, 200);
  });

  test('the owner\'s session shows a document; a reader who is not the owner does not', async () => {
    const res = await send('POST', '', ownerSession, { title: 'Preview', html: HTML, mission_id: 'm-b' });
    assert.equal(res.status, 201);
    assert.deepEqual(((await res.json()) as { document: { origin: unknown } }).document.origin, { kind: 'user', id: owner.id });
    assert.equal((await send('POST', '', { kind: 'session', userId: admin.id }, { title: 't', html: HTML, mission_id: 'm-b' })).status, 403);
    assert.equal((await send('POST', '', ownerSession, { title: 't', html: HTML })).status, 400, 'mission_id required');
  });

  test('bounds: size, count, reply, title, exactly one source, an owner', async () => {
    const big = `<p>${'x'.repeat(MAX_HTML_BYTES)}</p>`;
    assert.equal((await send('POST', '', agentOf('m-a'), { title: 't', html: big })).status, 413);
    // Multi-byte characters count in bytes, not in UTF-16 units.
    assert.equal((await send('POST', '', agentOf('m-a'), { title: 't', html: 'é'.repeat(MAX_HTML_BYTES / 2 + 1) })).status, 413); // french-ok: a two-byte letter that doubles the UTF-8 size
    const reply = await send('POST', '', ownerSession, { mission_id: 'm-a', title: 't', html: HTML, reply: true });
    assert.equal(reply.status, 400, 'a document shown by its owner is display only');
    assert.equal((await send('POST', '', agentOf('m-a'), { title: 'x'.repeat(121), html: HTML })).status, 400);
    assert.equal((await send('POST', '', agentOf('m-a'), { title: 'a\nb', html: HTML })).status, 400);
    assert.equal((await send('POST', '', agentOf('m-a'), { title: 't', html: HTML, path: '/x.html' })).status, 400);
    assert.equal((await send('POST', '', agentOf('m-a'), { title: 't' })).status, 400);
    assert.equal((await send('POST', '', agentOf('m-a'), { title: 't', html: HTML, extra: 1 })).status, 400);
    assert.equal((await send('POST', '', agentOf('m-a'), { title: 't', html: HTML, height: 10 })).status, 400);
    // An ownerless mission is nobody's to read: its token reaches nothing.
    assert.equal((await send('POST', '', agentOf('m-orphan'), { title: 't', html: HTML })).status, 404);
    for (let i = dbApi.countUiDocuments('m-cap').total; i < MAX_DOCUMENTS_PER_MISSION; i++) await show('m-cap');
    const over = await send('POST', '', agentOf('m-cap'), { title: 't', html: HTML });
    assert.equal(over.status, 429);
    assert.equal(((await over.json()) as { error: string }).error, 'too_many_documents');
  });

  test('a file is read under the mission\'s directory only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-doc-root-'));
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, 'page.html'), HTML);
    writeFileSync(join(root, '.hidden', 'page.html'), HTML);
    writeFileSync(join(root, 'bin.html'), Buffer.from([0xff, 0xfe, 0x00, 0xc3]));
    const outside = mkdtempSync(join(tmpdir(), 'ui-doc-out-'));
    writeFileSync(join(outside, 'page.html'), HTML);
    dbApi.setMissionCwdOverride('m-path', root);
    const ok = await send('POST', '', agentOf('m-path'), { title: 'From a file', path: join(root, 'page.html') });
    assert.equal(ok.status, 201);
    assert.equal((await send('POST', '', agentOf('m-path'), { title: 't', path: join(outside, 'page.html') })).status, 404);
    assert.equal((await send('POST', '', agentOf('m-path'), { title: 't', path: join(root, '.hidden', 'page.html') })).status, 404);
    assert.equal((await send('POST', '', agentOf('m-path'), { title: 't', path: join(root, 'missing.html') })).status, 404);
    assert.equal((await send('POST', '', agentOf('m-path'), { title: 't', path: join(root, 'bin.html') })).status, 415);
    assert.equal((await send('POST', '', agentOf('m-path'), { title: 't', path: 'page.html' })).status, 400, 'a relative path');
    writeFileSync(join(root, 'big.html'), 'x'.repeat(MAX_HTML_BYTES + 1));
    assert.equal((await send('POST', '', agentOf('m-path'), { title: 't', path: join(root, 'big.html') })).status, 413);
  });

  test('a secret in the HTML or the title is masked before it is served', async () => {
    const SECRET = 'sk-live-ui-doc-route-secret-77';
    const previous = setRedactionSource(() => [SECRET]);
    try {
      const id = await show('m-secret', { title: `token ${SECRET}`, html: `<p>${SECRET}</p>` });
      const body = await (await send('GET', `/${id}/document`, ownerSession)).text();
      assert.ok(!body.includes(SECRET));
      const view = await (await send('GET', `/${id}`, ownerSession)).text();
      assert.ok(!view.includes(SECRET));
      assert.ok(!dbApi.listEvents('m-secret').some((e) => e.payload.includes(SECRET)));
    } finally {
      setRedactionSource(previous);
    }
  });

  test('the reply leaves to its readers only (D8)', async () => {
    const SENTINEL = `REPLY-SENTINEL-${randomUUID()}`;
    const mission = dbApi.getMission('m-d8')!;
    const seed = (origin: { kind: 'agent' | 'plugin'; id: string }): string => {
      const out = createUiDocument({ id: randomUUID(), mission, origin, title: 'q', html: HTML, expectsReply: true });
      assert.ok(out.ok);
      assert.ok(dbApi.settleUiDocument(out.row.id, { status: 'answered', reply: JSON.stringify({ answer: SENTINEL }), resolvedByKind: 'user', resolvedById: owner.id }));
      return out.row.id;
    };
    const agentDoc = seed({ kind: 'agent', id: 'timon.coder' });
    const pluginDoc = seed({ kind: 'plugin', id: 'plugin-a' });
    const view = async (id: string, auth: Fake) => ((await (await send('GET', `/${id}`, auth)).json()) as { document: Record<string, unknown> }).document;
    assert.ok('reply' in await view(agentDoc, agentOf('m-d8')), 'the creating mission reads its answer');
    assert.ok(!('reply' in await view(pluginDoc, agentOf('m-d8'))), 'not the answer to a plugin\'s document');
    assert.ok('reply' in await view(pluginDoc, ownerSession), 'the reading session does');
    const list = await (await send('GET', '?mission_id=m-d8', agentOf('m-d8'))).json() as { documents: Array<Record<string, unknown>> };
    assert.deepEqual(list.documents.filter((d) => 'reply' in d).map((d) => d.id), [agentDoc]);
    assert.ok(!dbApi.listEvents('m-d8').some((e) => e.payload.includes(SENTINEL)), 'never in the conversation\'s events');
    assert.ok(!JSON.stringify(dbApi.listAuditLog(500)).includes(SENTINEL), 'never in the audit');
    assert.ok(!JSON.stringify(scopedDb({ id: owner.id, isSuperadmin: false, permissions: [] }).getMission('m-d8')).includes(SENTINEL), 'never in the mission row');
  });

  test('the purge spares a live mission and takes a long-finished one', async () => {
    dbApi.createMission('m-live', 'timon.coder', 'work', undefined, owner.id);
    dbApi.createMission('m-old', 'timon.coder', 'work', undefined, owner.id);
    dbApi.createMission('m-recent', 'timon.coder', 'work', undefined, owner.id);
    const live = await show('m-live');
    const old = await show('m-old');
    const recent = await show('m-recent');
    const now = Date.now();
    db.prepare(`UPDATE missions SET status = 'completed', ended_at = ? WHERE id = ?`).run(now - 40 * 86_400_000, 'm-old');
    db.prepare(`UPDATE missions SET status = 'completed', ended_at = ? WHERE id = ?`).run(now - 86_400_000, 'm-recent');
    // A long-running live mission is never touched, whatever its age.
    db.prepare(`UPDATE missions SET started_at = ? WHERE id = ?`).run(now - 90 * 86_400_000, 'm-live');
    purgeUiDocumentsOnce(now);
    assert.ok(dbApi.getUiDocument(live));
    assert.ok(dbApi.getUiDocument(recent));
    assert.equal(dbApi.getUiDocument(old), undefined);
    assert.equal((await send('GET', `/${old}`, ownerSession)).status, 404, 'the card then reads as expired');
  });
});
