import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMcpAppHost,
  httpsUrl,
  INVALID_PARAMS,
  MAX_IN_FLIGHT,
  MAX_MESSAGE_BYTES,
  messageText,
  TOO_MANY_REQUESTS,
  MCP_APPS_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  themeVariables,
  type JsonRpcOut,
  type McpAppHostContext,
} from './mcp-app-host';

const CONTEXT: McpAppHostContext = {
  theme: 'dark',
  styles: { variables: { '--color-background-primary': 'hsl(220 12% 11%)' } },
  displayMode: 'inline',
  availableDisplayModes: ['inline'],
  containerDimensions: { width: 720, maxHeight: 2000 },
  platform: 'web',
  locale: 'en',
  timeZone: 'Europe/Paris',
  deviceCapabilities: { touch: false, hover: true },
};

function harness(context: McpAppHostContext = CONTEXT) {
  const out: JsonRpcOut[] = [];
  const sizes: number[] = [];
  let initialized = 0;
  const host = createMcpAppHost({
    post: (m) => out.push(m),
    context: () => context,
    onSizeChanged: (h) => sizes.push(h),
    onInitialized: () => { initialized += 1; },
  });
  return { host, out, sizes, initialized: () => initialized };
}

function handshake(h: ReturnType<typeof harness>) {
  h.host.receive({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: MCP_APPS_PROTOCOL_VERSION, appInfo: { name: 'x', version: '1' }, appCapabilities: {} } });
  h.host.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
}

test('handshake: the host answers ui/initialize with its context and declares only what it serves', () => {
  const h = harness();
  handshake(h);
  assert.equal(h.out.length, 1);
  const reply = h.out[0] as { id: number; result: Record<string, unknown> };
  assert.equal(reply.id, 1);
  assert.equal(reply.result.protocolVersion, MCP_APPS_PROTOCOL_VERSION);
  assert.deepEqual(reply.result.hostInfo, { name: 'timon', version: '1' });
  // The display subset serves no capability of the spec: none is declared.
  assert.deepEqual(reply.result.hostCapabilities, {});
  assert.deepEqual(reply.result.hostContext, CONTEXT);
  assert.equal(h.initialized(), 1);
  assert.equal(h.host.initialized, true);
});

test('initialized before ui/initialize was answered is ignored, and counted once', () => {
  const h = harness();
  h.host.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
  assert.equal(h.initialized(), 0);
  handshake(h);
  h.host.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
  assert.equal(h.initialized(), 1);
});

test('ping is answered', () => {
  const h = harness();
  h.host.receive({ jsonrpc: '2.0', id: 'p', method: 'ping' });
  assert.deepEqual(h.out, [{ jsonrpc: '2.0', id: 'p', result: {} }]);
});

test('a method the host does not serve gets -32601, never an effect', () => {
  const h = harness();
  handshake(h);
  for (const method of ['tools/call', 'ui/open-link', 'ui/message', 'ui/update-model-context', 'ui/download-file', 'resources/read', 'sampling/createMessage']) {
    h.host.receive({ jsonrpc: '2.0', id: method, method, params: {} });
  }
  const errors = h.out.slice(1) as Array<{ id: string; error: { code: number } }>;
  assert.equal(errors.length, 7);
  for (const e of errors) assert.equal(e.error.code, METHOD_NOT_FOUND);
});

test('size-changed is bounded to 80–2000; a malformed one is ignored', () => {
  const h = harness();
  handshake(h);
  h.host.receive({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: 400, height: 412.4 } });
  h.host.receive({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 5 } });
  h.host.receive({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 1e9 } });
  h.host.receive({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 'tall' } });
  h.host.receive({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: Number.NaN } });
  assert.deepEqual(h.sizes, [412, 80, 2000]);
});

test('a message over 256 KiB is refused without an answer', () => {
  const h = harness();
  h.host.receive({ jsonrpc: '2.0', id: 9, method: 'ping', params: { pad: 'x'.repeat(MAX_MESSAGE_BYTES) } });
  h.host.receive({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 300, pad: 'é'.repeat(MAX_MESSAGE_BYTES / 2) } }); // french-ok: multi-byte padding, the byte cap under test
  assert.deepEqual(h.out, []);
  assert.deepEqual(h.sizes, []);
});

test('anything that is not JSON-RPC 2.0 is ignored', () => {
  const h = harness();
  const cyclic: Record<string, unknown> = { jsonrpc: '2.0', id: 1, method: 'ping' };
  cyclic.self = cyclic;
  for (const data of [null, 'ping', 42, [], { id: 1, method: 'ping' }, { jsonrpc: '1.0', id: 1, method: 'ping' }, cyclic,
    { jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }, { jsonrpc: '2.0', id: 1, method: 'ping', params: 'x' },
    { jsonrpc: '2.0', id: 1, result: {} }]) {
    h.host.receive(data);
  }
  assert.deepEqual(h.out, []);
});

test('a context change sends only the fields that changed, after the handshake only', () => {
  const h = harness();
  h.host.updateContext({ ...CONTEXT, theme: 'light' });
  assert.deepEqual(h.out, []);
  handshake(h);
  h.host.updateContext(CONTEXT);
  assert.equal(h.out.length, 1);
  h.host.updateContext({ ...CONTEXT, theme: 'light', containerDimensions: { width: 500, maxHeight: 2000 } });
  assert.deepEqual(h.out[1], {
    jsonrpc: '2.0',
    method: 'ui/notifications/host-context-changed',
    params: { theme: 'light', containerDimensions: { width: 500, maxHeight: 2000 } },
  });
});

test('a closed host sends nothing more', () => {
  const h = harness();
  h.host.close();
  h.host.receive({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.deepEqual(h.out, []);
});

test('theme tokens are translated to the spec names, HSL triplets wrapped', () => {
  const tokens: Record<string, string> = {
    '--background': ' 220 12% 11%',
    '--foreground': '0 0% 92%',
    '--border': 'rgb(1 2 3)',
    '--font-sans': 'ui-sans-serif, system-ui',
    '--radius': '0.6rem',
    '--ring': 'url(https://evil.example/x)',
    '--card': 'red; } body { display:none',
  };
  const vars = themeVariables((token) => tokens[token] ?? '');
  assert.equal(vars['--color-background-primary'], 'hsl(220 12% 11%)');
  assert.equal(vars['--color-text-primary'], 'hsl(0 0% 92%)');
  assert.equal(vars['--color-text-inverse'], 'hsl(220 12% 11%)');
  assert.equal(vars['--color-border-primary'], 'rgb(1 2 3)');
  assert.equal(vars['--font-sans'], 'ui-sans-serif, system-ui');
  assert.equal(vars['--border-radius-md'], '0.6rem');
  assert.equal('--color-ring-primary' in vars, false);
  assert.equal('--color-background-secondary' in vars, false);
  assert.equal('--color-text-secondary' in vars, false);
});

/** The interactive host: every callback the card gives, recording what reached it. */
function interactive(overrides: Partial<Parameters<typeof createMcpAppHost>[0]> = {}) {
  const out: JsonRpcOut[] = [];
  const calls: Array<[string, unknown]> = [];
  const host = createMcpAppHost({
    post: (m) => out.push(m),
    context: () => ({ ...CONTEXT, availableDisplayModes: ['inline', 'fullscreen'] }),
    onSizeChanged: () => undefined,
    onSubmit: async (value) => { calls.push(['submit', value]); return { ok: true }; },
    onMessage: async (text) => { calls.push(['message', text]); return true; },
    onOpenLink: async (url) => { calls.push(['link', url]); return true; },
    onDisplayMode: async (mode) => { calls.push(['mode', mode]); return mode === 'fullscreen' ? 'fullscreen' : 'inline'; },
    ...overrides,
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const answer = (id: number) => out.find((m) => 'id' in m && m.id === id && !('method' in m)) as
    { result?: Record<string, unknown>; error?: { code: number } } | undefined;
  return { host, out, calls, tick, answer };
}

test('interactive host: declares what it serves, and submit is the only tool', async () => {
  const h = interactive();
  h.host.receive({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });
  assert.deepEqual((h.answer(1)!.result as { hostCapabilities: unknown }).hostCapabilities, { openLinks: {}, serverTools: {}, message: { text: {} } });
  h.host.receive({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'deploy', arguments: {} } });
  assert.equal(h.answer(2)!.error!.code, METHOD_NOT_FOUND, 'another tool is refused');
  h.host.receive({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'submit', arguments: ['x'] } });
  assert.equal(h.answer(3)!.error!.code, INVALID_PARAMS, 'submit takes an object');
  h.host.receive({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'submit', arguments: { pick: 'b' } } });
  await h.tick();
  assert.deepEqual(h.calls, [['submit', { pick: 'b' }]]);
  assert.deepEqual(h.answer(4)!.result, { content: [{ type: 'text', text: 'The answer was sent.' }], structuredContent: { status: 'answered' } });
  for (const method of ['ui/update-model-context', 'ui/download-file', 'resources/read', 'sampling/createMessage']) {
    h.host.receive({ jsonrpc: '2.0', id: 9, method, params: {} });
    assert.equal((h.out.at(-1) as { error: { code: number } }).error.code, METHOD_NOT_FOUND, method);
  }
});

test('a refused submit reaches the document as a tool error, never as a success', async () => {
  const h = interactive({ onSubmit: async () => ({ ok: false, reason: 'no gesture' }) });
  h.host.receive({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit', arguments: {} } });
  await h.tick();
  assert.deepEqual(h.answer(1)!.result, { content: [{ type: 'text', text: 'no gesture' }], isError: true });
  const thrown = interactive({ onSubmit: async () => { throw new Error('boom'); } });
  thrown.host.receive({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit', arguments: {} } });
  await thrown.tick();
  assert.equal(thrown.answer(1)!.result!.isError, true);
});

test('at most 8 requests wait for the card; the ninth is refused, not queued', async () => {
  const pending: Array<() => void> = [];
  const h = interactive({ onMessage: () => new Promise<boolean>((resolve) => { pending.push(() => resolve(true)); }) });
  for (let i = 1; i <= 9; i++) h.host.receive({ jsonrpc: '2.0', id: i, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: `m${i}` }] } });
  assert.equal(pending.length, MAX_IN_FLIGHT);
  assert.equal(h.answer(9)!.error!.code, TOO_MANY_REQUESTS);
  for (const done of pending) done();
  await h.tick();
  assert.equal(h.out.filter((m) => 'result' in m).length, MAX_IN_FLIGHT, 'each answered once');
  h.host.receive({ jsonrpc: '2.0', id: 10, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'again' }] } });
  assert.equal(pending.length, MAX_IN_FLIGHT + 1, 'room again once answered');
});

test('ui/message: text only, bounded; ui/open-link: https only', async () => {
  const h = interactive();
  h.host.receive({ jsonrpc: '2.0', id: 1, method: 'ui/message', params: { role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] } });
  h.host.receive({ jsonrpc: '2.0', id: 2, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(4001) }] } });
  h.host.receive({ jsonrpc: '2.0', id: 3, method: 'ui/message', params: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
  for (const id of [1, 2, 3]) assert.equal(h.answer(id)!.error!.code, INVALID_PARAMS);
  for (const [id, url] of [[4, 'javascript:alert(1)'], [5, 'http://example.com'], [6, 'https://user:pw@example.com'], [7, 'data:text/html,x']] as const) {
    h.host.receive({ jsonrpc: '2.0', id, method: 'ui/open-link', params: { url } });
    assert.deepEqual(h.answer(id)!.result, { isError: true }, url);
  }
  h.host.receive({ jsonrpc: '2.0', id: 8, method: 'ui/open-link', params: { url: 'https://example.com/a b' } });
  await h.tick();
  assert.deepEqual(h.calls, [['link', 'https://example.com/a%20b']]);
  assert.equal(httpsUrl('https://example.com'), 'https://example.com/');
  assert.equal(messageText({ role: 'user', content: [{ type: 'text', text: ' a ' }, { type: 'text', text: 'b' }] }), 'a \nb');
});

test('display mode: the card decides; pip is not offered', async () => {
  const h = interactive();
  h.host.receive({ jsonrpc: '2.0', id: 1, method: 'ui/request-display-mode', params: { mode: 'fullscreen' } });
  h.host.receive({ jsonrpc: '2.0', id: 2, method: 'ui/request-display-mode', params: { mode: 'theatre' } });
  await h.tick();
  assert.deepEqual(h.answer(1)!.result, { mode: 'fullscreen' });
  assert.equal(h.answer(2)!.error!.code, INVALID_PARAMS);
});

test('teardown waits for the document, at most 2 s, and a forged answer to it is ignored', async () => {
  const h = interactive();
  assert.equal(await Promise.race([h.host.teardown().then(() => 'done'), h.tick().then(() => 'late')]), 'done', 'no handshake: nothing to wait for');
  h.host.receive({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });
  let done = false;
  const waiting = h.host.teardown().then(() => { done = true; });
  const request = h.out.at(-1) as { id: string; method: string };
  assert.equal(request.method, 'ui/resource-teardown');
  h.host.receive({ jsonrpc: '2.0', id: 'someone-else', result: {} });
  await h.tick();
  assert.equal(done, false, 'an answer to another id does not count');
  h.host.receive({ jsonrpc: '2.0', id: request.id, result: {} });
  await waiting;
  assert.equal(done, true);
  let asked = 0;
  const closing = interactive({ onRequestTeardown: () => { asked += 1; } });
  closing.host.receive({ jsonrpc: '2.0', method: 'ui/notifications/request-teardown', params: {} });
  assert.equal(asked, 1);
});

test('closed, the host answers nothing more, even a request already in flight', async () => {
  let release: (() => void) | null = null;
  const h = interactive({ onSubmit: () => new Promise((resolve) => { release = () => resolve({ ok: true }); }) });
  h.host.receive({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit', arguments: {} } });
  h.host.close();
  release!();
  await h.tick();
  assert.equal(h.answer(1), undefined);
});
