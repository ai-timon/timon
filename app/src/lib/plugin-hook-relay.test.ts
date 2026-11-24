import { test } from 'node:test';
import assert from 'node:assert/strict';

const route = import('../app/api/plugins/hooks/[plugin]/[name]/route');

type Seen = { url: string; headers: Headers; body: Buffer };

async function relay(plugin: string, name: string, body: string, headers: Record<string, string> = {}, answer?: () => Response) {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers), body: Buffer.from(init?.body as Uint8Array) });
    return answer ? answer() : Response.json({ status: 'received' });
  };
  try {
    const { POST } = await route;
    const res = await POST(new Request('http://app.test/api/plugins/hooks/x/y', { method: 'POST', body, headers }), { params: { plugin, name } });
    return { res, seen };
  } finally { globalThis.fetch = original; }
}

test('plugin hooks: the relay forwards the exact bytes and the Standard Webhooks headers, never a credential', async () => {
  const raw = '{"action":"closed","title":"é"}\n'; // french-ok: a non-ASCII payload, the UTF-8 relay under test
  const { res, seen } = await relay('timon-todo-connector-discord', 'issues', raw, {
    'content-type': 'application/json',
    'webhook-id': 'msg_1',
    'webhook-timestamp': '1700000000',
    'webhook-signature': 'v1,abc',
    cookie: 'timon_session=secret',
    authorization: 'Bearer daemon-token',
    'x-forwarded-for': '10.0.0.1',
  });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  const [call] = seen;
  assert.match(call!.url, /\/api\/plugins\/hooks\/timon-todo-connector-discord\/issues$/);
  assert.equal(call!.body.toString('utf8'), raw);
  for (const kept of ['webhook-id', 'webhook-timestamp', 'webhook-signature', 'content-type']) assert.ok(call!.headers.has(kept), kept);
  for (const dropped of ['cookie', 'authorization', 'x-forwarded-for']) assert.equal(call!.headers.has(dropped), false, dropped);
});

test('plugin hooks: a bad id or name is refused like an unknown webhook, before the daemon is asked', async () => {
  for (const [plugin, name] of [['..', 'issues'], ['-ab', 'issues'], ['Acme', 'issues'], ['%40timon%2Fx', 'issues'], ['@timon', 'issues'], ['acme', '../x'], ['acme', 'UP'], ['acme', '']]) {
    const { res, seen } = await relay(plugin!, name!, '{}');
    assert.equal(res.status, 401, `${plugin}/${name}`);
    assert.deepEqual(await res.json(), { error: 'authentication failed' });
    assert.equal(seen.length, 0);
  }
});

test('plugin hooks: the body is bounded and the daemon answer is passed through', async () => {
  const big = await relay('acme', 'issues', 'x'.repeat(256 * 1024 + 1));
  assert.equal(big.res.status, 413);
  assert.equal(big.seen.length, 0);
  const failed = await relay('acme', 'issues', '{}', {}, () => Response.json({ status: 'error' }, { status: 502 }));
  assert.equal(failed.res.status, 502);
  const down = await relay('acme', 'issues', '{}', {}, () => { throw new Error('ECONNREFUSED'); });
  assert.equal(down.res.status, 502);
});

test('plugin hooks: the signature headers of every shipped format reach the daemon untouched', async () => {
  const proofs: Record<string, string> = {
    'x-hub-signature-256': 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    'x-github-delivery': 'd-1',
    'x-gitea-signature': 'abc', 'x-gitea-delivery': 'g-1',
    'x-forgejo-signature': 'abc', 'x-forgejo-delivery': 'f-1',
    'x-gitlab-token': 'token-value', 'idempotency-key': 'k-1',
    'stripe-signature': 't=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd,v0=6ffb',
    'x-slack-signature': 'v0=a2114d57', 'x-slack-request-timestamp': '1531420618',
    'x-shopify-hmac-sha256': 'XWmrwMey6OsLMeiZKwP4FppHH3cmAiiJJAweH5Jo4bM=', 'x-shopify-webhook-id': 'w-1',
    'linear-signature': 'abc', 'linear-delivery': 'l-1',
    'x-signature-ed25519': 'ab'.repeat(64), 'x-signature-timestamp': '1700000000',
  };
  const { seen } = await relay('acme', 'events', '{}', proofs);
  for (const [name, value] of Object.entries(proofs)) assert.equal(seen[0]!.headers.get(name), value, name);
});

test('plugin hooks: a subscription GET is relayed with its query string, never with a credential', async () => {
  const original = globalThis.fetch;
  const seen: Array<{ url: string; method: string; headers: Headers }> = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    return new Response('1158201444', { headers: { 'content-type': 'text/plain' } });
  };
  try {
    const { GET } = await route;
    const query = '?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=1158201444';
    const res = await GET(new Request(`http://app.test/api/plugins/hooks/acme/fb${query}`, { headers: { cookie: 'timon_session=secret' } }), { params: { plugin: 'acme', name: 'fb' } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '1158201444');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(seen[0]!.url, /\/api\/plugins\/hooks\/acme\/fb\?hub\.mode=subscribe&hub\.verify_token=abc&hub\.challenge=1158201444$/);
    assert.equal(seen[0]!.method, 'GET');
    assert.equal(seen[0]!.headers.has('cookie'), false);
    const bad = await GET(new Request('http://app.test/api/plugins/hooks/Acme/fb?x=1'), { params: { plugin: 'Acme', name: 'fb' } });
    assert.equal(bad.status, 401);
    assert.equal(seen.length, 1);
  } finally { globalThis.fetch = original; }
});
