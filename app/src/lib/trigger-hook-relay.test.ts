import { test } from 'node:test';
import assert from 'node:assert/strict';

const route = import('../app/api/triggers/hooks/[slug]/route');

type Seen = { url: string; headers: Headers; body: Buffer };

async function relay(slug: string, body: string, headers: Record<string, string> = {}, answer?: () => Response) {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers), body: Buffer.from(init?.body as Uint8Array) });
    return answer ? answer() : Response.json({ status: 'received' });
  };
  try {
    const { POST } = await route;
    const res = await POST(new Request('http://app.test/api/triggers/hooks/x', { method: 'POST', body, headers }), { params: { slug } });
    return { res, seen };
  } finally { globalThis.fetch = original; }
}

test('the relay forwards the exact bytes and what a sender signs, never a credential', async () => {
  const raw = '{"issue": {"title": "é"}}\n'; // french-ok: a non-ASCII payload, the UTF-8 relay under test
  const { res, seen } = await relay('bugs', raw, {
    'content-type': 'application/json',
    'x-hub-signature-256': 'sha256=abc',
    'x-github-event': 'issues',
    'x-github-delivery': 'd-1',
    'webhook-id': 'msg_1',
    'x-timon-signature': 'sha256=def',
    'x-timon-timestamp': '1700000000',
    cookie: 'timon_session=secret',
    authorization: 'Bearer daemon-token',
    'x-forwarded-for': '10.0.0.1',
    'x-timon-agent': 'main',
    'x-timon-relayed-by': 'nobody',
  });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  const [call] = seen;
  assert.match(call!.url, /\/api\/triggers\/hooks\/bugs$/);
  assert.equal(call!.body.toString('utf8'), raw);
  for (const kept of ['x-hub-signature-256', 'x-github-event', 'x-github-delivery', 'webhook-id', 'x-timon-signature', 'x-timon-timestamp', 'content-type']) {
    assert.ok(call!.headers.has(kept), kept);
  }
  for (const dropped of ['cookie', 'authorization', 'x-forwarded-for', 'x-timon-agent']) {
    assert.equal(call!.headers.has(dropped), false, dropped);
  }
  // Always the relay's own mark, whatever the caller wrote.
  assert.equal(call!.headers.get('x-timon-relayed-by'), 'app');
});

test('a bad name is refused like an unknown route, before the daemon is asked', async () => {
  for (const slug of ['../secret', 'UPPER', '-dash', '']) {
    const { res, seen } = await relay(slug, '{}');
    assert.equal(res.status, 401, slug);
    assert.equal(seen.length, 0);
  }
});

test('the body is bounded, and the daemon answer is passed through', async () => {
  const big = await relay('bugs', 'x'.repeat(256 * 1024 + 1));
  assert.equal(big.res.status, 413);
  assert.equal(big.seen.length, 0);

  const limited = await relay('bugs', '{}', {}, () => new Response('{"error":"rate limited"}', { status: 429, headers: { 'Retry-After': '60' } }));
  assert.equal(limited.res.status, 429);
  assert.equal(limited.res.headers.get('retry-after'), '60');

  const down = await relay('bugs', '{}', {}, () => { throw new Error('ECONNREFUSED'); });
  assert.equal(down.res.status, 502);
});
