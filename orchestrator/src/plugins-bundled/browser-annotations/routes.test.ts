import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { dbApi } from '../../db.js';
import { createBrowserProfile } from '../../browser-profiles.js';
import { issueMissionApiToken } from '../../users/api-tokens.js';
import { hashSessionToken, SESSION_COOKIE } from '../../users/session.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';
import { registerBrowserAnnotationRoutes } from './routes.js';
import { agentDir } from '../../paths.js';
import { resolveMasterKey } from '../../secrets/key.js';

resolveMasterKey({ keyring: null });
const cwd = mkdtempSync(join(tmpdir(), 'ann-routes-'));
mkdirSync(join(cwd, 'src'));
writeFileSync(join(cwd, 'src', 'Cart.tsx'), 'export {}');
for (const agent of ['ann-dev', 'ann-other']) mkdirSync(agentDir(agent), { recursive: true });
writeFileSync(join(agentDir('ann-dev'), 'config.json'), JSON.stringify({ name: 'ann-dev', cwd }));

const alice = createTestAccount(dbApi, { email: 'ar-alice@example.test', name: 'Alice', passwordHash: 'unused' });
const bob = createTestAccount(dbApi, { email: 'ar-bob@example.test', name: 'Bob', passwordHash: 'unused' });
const cookies = { alice: randomUUID(), bob: randomUUID() };
dbApi.createSession({ tokenHash: hashSessionToken(cookies.alice), userId: alice.id, expiresAt: Date.now() + 60_000 });
dbApi.createSession({ tokenHash: hashSessionToken(cookies.bob), userId: bob.id, expiresAt: Date.now() + 60_000 });
const profile = createBrowserProfile({ name: 'Alice browser', owner_user_id: alice.id });
const otherProfile = createBrowserProfile({ name: 'Alice second browser', owner_user_id: alice.id });

function mission(agent: string, owner: string, profileId: string | null, source?: { channel: string; meta: unknown }): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'test', source, owner);
  if (profileId) dbApi.setMissionBrowserProfile(id, profileId);
  tokens[id] = issueMissionApiToken(id);
  return id;
}
const tokens: Record<string, string> = {};
const missions = {
  // The one the batch is sent to.
  target: mission('ann-dev', alice.id, profile.id),
  // Same agent, same profile, not addressed.
  sibling: mission('ann-dev', alice.id, profile.id),
  // Another agent on the same profile.
  stranger: mission('ann-other', alice.id, profile.id),
  // Addressed agent, but driving another browser profile.
  otherProfile: mission('ann-dev', alice.id, otherProfile.id),
  // The conversion mission of a recording (#467): its token reaches a closed list of routes.
  conversion: mission('ann-dev', alice.id, profile.id, { channel: 'chat', meta: { browser_recording_id: 'br-00000000-0000-4000-8000-000000000468' } }),
  bobs: mission('ann-dev', bob.id, null),
};

const COMMENT = 'make-it-bigger-marker';
const PAGE = 'cart-page-text-marker';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 3)]).toString('base64');
const capture = (url = 'http://localhost:5173/cart') => ({
  version: 1, id: 'd1', capturedAt: new Date().toISOString(), tabId: 't', url, title: 'Cart',
  point: { x: 1, y: 1 }, rect: { x: 0, y: 0, width: 50, height: 20 }, viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0 },
  target: { selector: '#buy', xpath: '/html[1]/body[1]/button[1]', tag: 'button', role: 'button', name: 'Buy', text: PAGE, inputType: '', id: 'buy', classes: [], locators: [] },
  outerHtml: `<button>${PAGE}</button>`, outerHtmlTruncated: false,
  source: { detected: true, framework: 'react', via: 'debugSource', file: join(cwd, 'src', 'Cart.tsx'), line: 4, component: 'Cart' },
  thumbnail: { mimeType: 'image/jpeg', data: JPEG, width: 50, height: 20 },
});
const reached: Record<string, unknown>[] = [];
const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: 'ar-daemon' }));
app.use(express.json());
registerBrowserAnnotationRoutes(app, {
  call: async (_id, command) => {
    reached.push(command);
    if (command.action === 'annotateStart') return { running: true, annotation: { active: true, pending: 0 } };
    if (command.action === 'annotatePick') return command.preview ? { hover: { rect: { x: 0, y: 0, width: 5, height: 5 }, tag: 'div' } } : { annotation: capture() };
    if (command.action === 'annotatePins') {
      const [first, second] = command.ids as string[];
      // One followed element, one gone, and what a confused desktop could add: none of it passes.
      return { pins: [
        { id: first, rect: { x: 10, y: -40, width: 50, height: -3 }, text: PAGE },
        { id: second, rect: null },
        { id: 'ba-00000000-0000-4000-8000-0000000000ff', rect: { x: 1, y: 1, width: 1, height: 1 } },
        { id: first, rect: { x: 'NaN', y: 0, width: 1, height: 1 } },
      ], page: PAGE };
    }
    return { annotation: { active: command.action !== 'annotateStop', pending: 0, picks: [capture(), capture('https://shop.example/cart')] } };
  },
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/native-browser`;

async function http(method: string, path: string, who: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who === 'alice' || who === 'bob') headers.cookie = `${SESSION_COOKIE}=${cookies[who]}`;
  else if (who === 'daemon') headers.authorization = 'Bearer ar-daemon';
  else if (who !== 'anonymous') headers.authorization = `Bearer ${tokens[missions[who as keyof typeof missions]]}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, any>, cache: res.headers.get('cache-control') };
}

let ids: string[] = [];
let batchId = '';

test('the owner annotates: commands reach the desktop as human, picks are sealed, the answer holds metadata only', async () => {
  const started = await http('POST', `${profile.id}/annotation/start`, 'alice', {});
  assert.equal(started.status, 200, started.text);
  assert.equal(started.cache, 'no-store');
  assert.deepEqual(reached.at(-1), { action: 'annotateStart', commandActor: 'human' });
  const preview = await http('POST', `${profile.id}/annotation/pick`, 'alice', { x: 3, y: 4, preview: true });
  assert.equal(preview.json.hover.tag, 'div');
  assert.deepEqual(reached.at(-1), { action: 'annotatePick', commandActor: 'human', x: 3, y: 4, preview: true });
  const picked = await http('POST', `${profile.id}/annotation/pick`, 'alice', { x: 3, y: 4 });
  assert.equal(picked.json.annotations.length, 1);
  const stopped = await http('POST', `${profile.id}/annotation/stop`, 'alice', {});
  assert.equal(stopped.status, 200, stopped.text);
  assert.equal(stopped.json.annotations.length, 2);
  assert.equal(stopped.json.annotation.active, false);
  assert.equal(stopped.json.annotation.picks, undefined);
  for (const answer of [picked, stopped]) assert.ok(!answer.text.includes(PAGE), 'no page text in the answer');
  ids = [...picked.json.annotations, ...stopped.json.annotations].map((meta: { id: string }) => meta.id);
  const listed = await http('GET', `${profile.id}/annotations`, 'alice');
  assert.equal(listed.json.annotations.length, 3);
  const detail = await http('GET', `annotations/${ids[0]}`, 'alice');
  assert.equal(detail.json.page.target.text, PAGE);
  assert.equal(detail.json.source.file, null, 'no path before it is checked against a cwd');
  assert.equal((await http('GET', `annotations/${ids[0]}/thumbnail`, 'alice')).json.thumbnail.data, JPEG);
  const commented = await http('PATCH', `annotations/${ids[0]}`, 'alice', { comment: COMMENT });
  assert.equal(commented.status, 200, commented.text);
});

test('anonymous, daemon token, another owner and a mission never act as the owner', async () => {
  const ownerRoutes: Array<[string, string, unknown?]> = [
    ['POST', `${profile.id}/annotation/start`, {}], ['POST', `${profile.id}/annotation/stop`, {}],
    ['POST', `${profile.id}/annotation/collect`, {}], ['POST', `${profile.id}/annotation/pick`, { x: 1, y: 1 }],
    ['POST', `${profile.id}/annotation/pins`, { ids: [ids[0]] }],
    ['GET', `${profile.id}/annotations`], ['GET', 'annotations'], ['GET', `annotations/${ids[0]}`], ['GET', `annotations/${ids[0]}/thumbnail`],
    ['PATCH', `annotations/${ids[0]}`, { comment: 'x' }], ['DELETE', `annotations/${ids[0]}`],
    ['POST', 'annotations/send', { ids: [ids[0]], missionId: missions.target }],
    ['POST', `annotations/${ids[0]}/resolve`, { status: 'dismissed', reason: 'no' }],
  ];
  const before = reached.length;
  for (const [method, path, body] of ownerRoutes) {
    assert.equal((await http(method, path, 'anonymous', body)).status, 401, `anonymous ${method} ${path}`);
    for (const who of ['daemon', 'bob', 'target']) {
      const res = await http(method, path, who, body);
      // Bob lists his own annotations and a mission what it was sent: nothing of Alice's either way.
      if (who !== 'daemon' && method === 'GET' && path === 'annotations') { assert.deepEqual(res.json.annotations, []); continue; }
      assert.ok([403, 404].includes(res.status), `${who} ${method} ${path}: ${res.status} ${res.text}`);
      assert.ok(!res.text.includes(PAGE));
    }
  }
  assert.equal(reached.length, before, 'nothing reached the desktop');
  assert.equal((await http('GET', `annotations/${ids[0]}`, 'alice')).status, 200, 'still there');
});

test('the PWA\'s pins: where their elements are now, for the ids asked, rectangles only', async () => {
  const [first, second] = ids as [string, string];
  const pins = await http('POST', `${profile.id}/annotation/pins`, 'alice', { ids: [first, second, first] });
  assert.equal(pins.status, 200, pins.text);
  assert.equal(pins.cache, 'no-store');
  assert.deepEqual(reached.at(-1), { action: 'annotatePins', commandActor: 'human', ids: [first, second] });
  assert.deepEqual(pins.json, { pins: [{ id: first, rect: { x: 10, y: -40, width: 50, height: 0 } }, { id: second, rect: null }] });
  assert.ok(!pins.text.includes(PAGE), 'no page text in the answer');
  // An empty list stops following.
  assert.deepEqual((await http('POST', `${profile.id}/annotation/pins`, 'alice', { ids: [] })).json, { pins: [] });
});

test('requests are validated before anything runs', async () => {
  const before = reached.length;
  assert.equal((await http('POST', `${profile.id}/annotation/pins`, 'alice', { ids: ['../x'] })).status, 400);
  assert.equal((await http('POST', `${profile.id}/annotation/pins`, 'alice', { ids: Array.from({ length: 22 }, () => ids[0]) })).status, 400, 'bounded');
  const missing = await http('POST', `${profile.id}/annotation/pins`, 'alice', {});
  assert.equal(missing.status, 400);
  // The webview translates the code and quotes the schema's reason.
  assert.equal(missing.json.code, 'invalid_detail');
  assert.deepEqual(missing.json.params, { detail: missing.json.error });
  assert.equal(reached.length, before, 'nothing reached the desktop');
  assert.equal((await http('POST', `${profile.id}/annotation/pick`, 'alice', { x: -1, y: 1 })).status, 400);
  assert.equal((await http('POST', `${profile.id}/annotation/start`, 'alice', { action: 'navigate' })).status, 400);
  assert.equal((await http('PATCH', `annotations/${ids[0]}`, 'alice', { comment: 1 })).status, 400);
  assert.equal((await http('GET', `${profile.id}/annotations?status=open`, 'alice')).status, 400);
  assert.equal((await http('POST', 'annotations/send', 'alice', { ids: [ids[0]] })).status, 400, 'no destination');
  assert.equal((await http('POST', 'annotations/send', 'alice', { ids: [ids[0]], missionId: missions.target, agent: 'ann-dev' })).status, 400, 'two destinations');
  assert.equal((await http('POST', 'annotations/send', 'alice', { ids: [ids[0]], missionId: missions.bobs })).status, 404, 'another owner\'s mission');
  assert.equal((await http('POST', 'annotations/send', 'alice', { ids: [ids[0]], missionId: missions.otherProfile })).status, 409, 'a mission on another browser');
  assert.equal((await http('POST', 'annotations/send', 'alice', { ids: [ids[0]], agent: 'ann-missing' })).status, 404);
});

test('a batch sent to a mission reaches that mission only, which reads and resolves it', async () => {
  const sent = await http('POST', 'annotations/send', 'alice', { ids, missionId: missions.target });
  assert.equal(sent.status, 200, sent.text);
  batchId = sent.json.batchId;
  // The composer's turn: the agent's own read, formatted by the daemon, the page text fenced.
  const turn: string = sent.json.handoff.markdown;
  assert.match(turn, new RegExp(`batch \`${batchId}\``));
  assert.match(turn, new RegExp(`> ${COMMENT}`));
  assert.match(turn, new RegExp(`\`\`\`untrusted-page-data\n[^\`]*${PAGE}[^\`]*\n\`\`\``));
  assert.match(turn, /source: react component Cart, src\/Cart\.tsx:4/);
  assert.match(turn, /not on a local or LAN address/);
  assert.deepEqual(sent.json.handoff.images, [], 'no image unless the composer attaches them');
  assert.doesNotMatch(turn, /is attached to this message/);
  assert.equal((await http('PATCH', `annotations/${ids[0]}`, 'alice', { comment: 'changed' })).status, 409);

  for (const who of ['sibling', 'stranger', 'otherProfile', 'bobs']) {
    assert.deepEqual((await http('GET', 'annotations', who)).json.annotations, [], who);
    assert.equal((await http('GET', `annotations/${ids[0]}`, who)).status, 404, who);
    assert.equal((await http('POST', `annotations/${ids[0]}/resolve`, who, { status: 'resolved', summary: 'x' })).status, 404, who);
  }

  const list = await http('GET', 'annotations', 'target');
  assert.equal(list.status, 200, list.text);
  assert.equal(list.cache, 'no-store');
  assert.match(list.json.notice, /untrusted/);
  assert.equal(list.json.annotations.length, 3);
  // The same block as the composer's turn: one writer for both.
  assert.equal(list.json.markdown, turn);
  // The page's words live in the fenced block only, never in a JSON field beside it.
  assert.ok(!JSON.stringify({ ...list.json, markdown: '' }).includes(PAGE));
  const first = list.json.annotations.find((row: { id: string }) => row.id === ids[0]);
  assert.deepEqual(Object.keys(first).sort(), ['batchId', 'capturedAt', 'hasThumbnail', 'id', 'resolution', 'status']);
  assert.equal(first.batchId, batchId);
  const blocks = (list.json.markdown as string).split(/^## /m).slice(1);
  const foreign = blocks.find((block) => block.includes('https://shop.example'))!;
  assert.match(foreign, /text, title and markup are withheld/);
  assert.ok(!foreign.includes(PAGE));
  assert.equal(JSON.stringify(list.json).includes(JPEG.slice(8, 40)), false, 'no thumbnail for a mission');
  const one = await http('GET', `annotations/${ids[0]}`, 'target');
  assert.equal(one.json.annotation.id, ids[0]);
  assert.match(one.json.markdown, /Annotation 1 of 1/);
  assert.match(one.json.markdown, new RegExp(`> ${COMMENT}`));
  assert.equal((await http('GET', `annotations/${ids[0]}/thumbnail`, 'target')).status, 403);

  const resolved = await http('POST', `annotations/${ids[0]}/resolve`, 'target', { status: 'resolved', summary: 'Padding doubled in Cart.tsx' });
  assert.equal(resolved.status, 200, resolved.text);
  assert.deepEqual(resolved.json.annotation.resolvedBy, { kind: 'agent', id: 'ann-dev' });
  assert.equal((await http('POST', `annotations/${ids[0]}/resolve`, 'target', { status: 'dismissed', reason: 'x' })).status, 409);
  assert.equal((await http('POST', `annotations/${ids[1]}/resolve`, 'target', { status: 'resolved', reason: 'mixed' })).status, 400);
  assert.equal((await http('POST', `annotations/${ids[1]}/resolve`, 'target', { status: 'dismissed', reason: '  ' })).status, 400, 'a reason is required');
  const dismissed = await http('POST', `annotations/${ids[1]}/resolve`, 'target', { status: 'dismissed', reason: 'Cannot reproduce' });
  assert.equal(dismissed.json.annotation.status, 'dismissed');
  assert.deepEqual((await http('GET', 'annotations', 'target')).json.annotations.map((row: { id: string }) => row.id), [ids[2]], 'open ones by default');
  assert.equal((await http('GET', `annotations?batch=${batchId}`, 'target')).json.annotations.length, 3);
  const owner = await http('GET', `annotations/${ids[0]}`, 'alice');
  assert.deepEqual(owner.json.resolution, { status: 'resolved', summary: 'Padding doubled in Cart.tsx' });
  assert.equal(owner.json.source.file, 'src/Cart.tsx');
});

test('a batch sent to an agent reaches its missions on the annotated browser only', async () => {
  const collected = await http('POST', `${profile.id}/annotation/collect`, 'alice', {});
  const fresh = collected.json.annotations.map((meta: { id: string }) => meta.id);
  const sent = await http('POST', 'annotations/send', 'alice', { ids: fresh, agent: 'ann-dev', withImages: true });
  assert.equal(sent.status, 200, sent.text);
  // The thumbnails ride with the composer's turn, and the block says so.
  assert.deepEqual(sent.json.handoff.images.map((image: { annotationId: string }) => image.annotationId), fresh);
  assert.equal(sent.json.handoff.images[0].base64, JPEG);
  assert.equal((sent.json.handoff.markdown as string).match(/is attached to this message/g)?.length, 2);
  assert.equal((await http('GET', `annotations?batch=${sent.json.batchId}`, 'sibling')).json.annotations.length, 2);
  assert.equal((await http('GET', `annotations?batch=${sent.json.batchId}`, 'stranger')).json.annotations.length, 0);
  assert.equal((await http('GET', `annotations?batch=${sent.json.batchId}`, 'otherProfile')).json.annotations.length, 0);
});

test('the conversion mission of a recording is refused by its route list (#467)', async () => {
  for (const [method, path, body] of [['GET', 'annotations'], ['GET', `annotations/${ids[2]}`],
    ['POST', `annotations/${ids[2]}/resolve`, { status: 'resolved', summary: 'x' }]] as const) {
    const res = await http(method, path, 'conversion', body);
    assert.equal(res.status, 403, `${method} ${path}: ${res.text}`);
    assert.ok(!res.text.includes(PAGE));
  }
});

test('the owner deletes an annotation', async () => {
  assert.equal((await http('DELETE', `annotations/${ids[2]}`, 'alice')).json.deleted, true);
  assert.equal((await http('GET', `annotations/${ids[2]}`, 'alice')).status, 404);
});
