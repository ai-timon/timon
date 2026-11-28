import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { AddressInfo } from 'node:net';

async function harness(t: TestContext, respond: (path: string, body: any) => { status?: number; body: unknown }) {
  const requests: { path: string; auth?: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push({ path: req.url!, auth: req.headers.authorization, body });
    const out = respond(req.url!, body);
    res.statusCode = out.status ?? 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out.body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/computer-mcp.mjs', import.meta.url))], {
    env: { ...process.env, TIMON_API_TOKEN: 'mission-token', TIMON_ORCH_URL: origin }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill(); });
  let id = 0;
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => { const v = JSON.parse(line); replies.get(v.id)?.(v); replies.delete(v.id); });
  const call = (method: string, params?: unknown) => new Promise<any>((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => reject(new Error('MCP reply timed out')), 5000);
    replies.set(n, (v) => { clearTimeout(timer); resolve(v); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  return { requests, call };
}

test('computer MCP lists its tools and warns about screenshots, tokens and passwords', async (t) => {
  const { call } = await harness(t, () => ({ body: {} }));
  const { result } = await call('tools/list');
  assert.deepEqual(result.tools.map((x: any) => x.name).sort(), [
    'computer_a11y_action', 'computer_a11y_tree', 'computer_actions', 'computer_click', 'computer_cursor_position', 'computer_double_click', 'computer_drag', 'computer_focus_window', 'computer_key',
    'computer_list_windows', 'computer_move', 'computer_screenshot', 'computer_scroll', 'computer_type', 'computer_wait',
  ]);
  const text = result.tools.map((x: any) => x.description).join(' ');
  assert.match(text, /screenshot/i);
  assert.match(text, /Never type a password/);
  assert.match(text, /save tokens/);
  assert.match(text, /Read the window first with computer_a11y_tree and act by element\. Take a screenshot and click in pixels only if the element is missing from the tree\./);
});

test('computer MCP posts to /api/computer/:command with the mission token and returns screenshots as images', async (t) => {
  const { requests, call } = await harness(t, (path) => path.endsWith('/screenshot')
    ? { body: { ok: true, result: { mimeType: 'image/png', data: 'AAAA', width: 10, height: 5 } } }
    : { body: { ok: true, result: { clicked: true } } });
  const shot = await call('tools/call', { name: 'computer_screenshot', arguments: {} });
  assert.deepEqual(shot.result.content[0], { type: 'image', data: 'AAAA', mimeType: 'image/png' });
  const click = await call('tools/call', { name: 'computer_click', arguments: { x: 1, y: 2 } });
  assert.match(click.result.content[0].text, /clicked/);
  assert.deepEqual(requests.map((r) => [r.path, r.auth, r.body]), [
    ['/api/computer/screenshot', 'Bearer mission-token', {}],
    ['/api/computer/click', 'Bearer mission-token', { x: 1, y: 2 }],
  ]);
});

test('computer MCP surfaces a daemon refusal as a tool error', async (t) => {
  const { call } = await harness(t, () => ({ status: 403, body: { error: 'computer_use_disabled', message: 'Computer use is turned off for this agent.' } }));
  const out = await call('tools/call', { name: 'computer_move', arguments: { x: 1, y: 1 } });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /turned off/);
});

test('computer_actions runs the steps in order and returns one screenshot at the end', async (t) => {
  const { requests, call } = await harness(t, (path) => path.endsWith('/screenshot')
    ? { body: { ok: true, result: { mimeType: 'image/jpeg', data: 'BBBB', width: 1024, height: 640 } } }
    : { body: { ok: true, result: {} } });
  const out = await call('tools/call', { name: 'computer_actions', arguments: { steps: [
    { action: 'key', keys: 'cmd+space' }, { action: 'type', text: 'TextEdit' }, { action: 'wait', ms: 500 },
  ] } });
  assert.deepEqual(out.result.content[0], { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' });
  assert.deepEqual(JSON.parse(out.result.content[1].text), { width: 1024, height: 640, steps: 3 });
  assert.deepEqual(requests.map((r) => [r.path, r.body]), [
    ['/api/computer/key', { keys: 'cmd+space' }], ['/api/computer/type', { text: 'TextEdit' }],
    ['/api/computer/wait', { ms: 500 }], ['/api/computer/screenshot', {}],
  ]);
});

test('computer_screenshot and the capture of computer_actions pass windowId on, and the answer names the window', async (t) => {
  const { requests, call } = await harness(t, (path) => path.endsWith('/screenshot')
    ? { body: { ok: true, result: { mimeType: 'image/jpeg', data: 'CCCC', width: 1024, height: 768, window: { id: '4242', title: 'Docs', app: 'Firefox' } } } }
    : { body: { ok: true, result: {} } });
  const shot = await call('tools/call', { name: 'computer_screenshot', arguments: { windowId: 'front', maxWidth: 1024 } });
  assert.deepEqual(JSON.parse(shot.result.content[1].text), { width: 1024, height: 768, windowId: '4242' });
  const out = await call('tools/call', { name: 'computer_actions', arguments: { windowId: '4242', steps: [{ action: 'key', keys: 'Enter' }] } });
  assert.deepEqual(JSON.parse(out.result.content[1].text), { width: 1024, height: 768, windowId: '4242', steps: 1 });
  assert.deepEqual(requests.map((r) => [r.path, r.body]), [
    ['/api/computer/screenshot', { windowId: 'front', maxWidth: 1024 }],
    ['/api/computer/key', { keys: 'Enter' }], ['/api/computer/screenshot', { windowId: '4242' }],
  ]);
  const listed = (await call('tools/list')).result.tools as Array<{ name: string; inputSchema: { properties: Record<string, { type: string }> } }>;
  for (const name of ['computer_screenshot', 'computer_actions']) {
    assert.equal(listed.find((entry) => entry.name === name)?.inputSchema.properties.windowId?.type, 'string', name);
  }
});

test('computer_actions stops at the first refused step, says which, and reads nothing', async (t) => {
  const { requests, call } = await harness(t, (path) => path.endsWith('/type')
    ? { status: 409, body: { error: 'Computer use was stopped by the user.', code: 'computer_stopped' } }
    : { body: { ok: true, result: {} } });
  const out = await call('tools/call', { name: 'computer_actions', arguments: { steps: [
    { action: 'click', x: 1, y: 1 }, { action: 'type', text: 'hello' }, { action: 'key', keys: 'Enter' },
  ] } });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /Step 2 \(type\) failed: Computer use was stopped by the user\.; 1 step\(s\) done/);
  assert.deepEqual(requests.map((r) => r.path), ['/api/computer/click', '/api/computer/type']);
});

test('computer_actions refuses a step that is not an action, before doing anything', async (t) => {
  const { requests, call } = await harness(t, () => ({ body: { ok: true, result: {} } }));
  const out = await call('tools/call', { name: 'computer_actions', arguments: { steps: [{ action: 'screenshot' }] } });
  assert.equal(out.result.isError, true);
  assert.deepEqual(requests, []);
});

test('computer_actions accepts focus_window as a step, and the window tools reach their commands', async (t) => {
  const { requests, call } = await harness(t, () => ({ body: { ok: true, result: {} } }));
  await call('tools/call', { name: 'computer_actions', arguments: { screenshot: false, steps: [{ action: 'focus_window', id: '12:1' }, { action: 'type', text: 'x' }] } });
  await call('tools/call', { name: 'computer_list_windows', arguments: {} });
  await call('tools/call', { name: 'computer_focus_window', arguments: { id: '7' } });
  assert.deepEqual(requests.map((r) => r.path), ['/api/computer/focus_window', '/api/computer/type', '/api/computer/list_windows', '/api/computer/focus_window']);
});

const TREE = {
  window: { id: '10:1', title: 'Form', app: 'TextEdit' }, truncated: false,
  nodes: [
    { id: '10:1#0', parent: null, depth: 0, role: 'window', name: 'Form', enabled: true, actions: [], bounds: { x: 0, y: 0, width: 400, height: 300 } },
    { id: '10:1#0.0', parent: '10:1#0', depth: 1, role: 'textfield', name: 'Nom', value: 'abc', enabled: true, focused: true, actions: ['focus', 'set_value'], bounds: { x: 20, y: 30, width: 100, height: 20 } },
    { id: '10:1#0.1', parent: '10:1#0', depth: 1, role: 'button', name: '', enabled: false, actions: ['press'] },
  ],
};

test('computer_a11y_tree renders an indented text, with positions only on request', async (t) => {
  const { requests, call } = await harness(t, () => ({ body: { ok: true, result: TREE } }));
  const plain = await call('tools/call', { name: 'computer_a11y_tree', arguments: { query: 'nom', maxDepth: 3 } });
  assert.equal(plain.result.content.length, 1);
  assert.equal(plain.result.content[0].text, [
    'window #10:1 "Form" (TextEdit)',
    '#10:1#0 window "Form"',
    '  #10:1#0.0 textfield "Nom" = "abc" (focused) [focus,set_value]',
    '  #10:1#0.1 button (disabled) [press]',
  ].join('\n'));
  const bounded = await call('tools/call', { name: 'computer_a11y_tree', arguments: { withBounds: true } });
  assert.match(bounded.result.content[0].text, /\[focus,set_value\] @20,30/);
  assert.deepEqual(requests.map((r) => [r.path, r.body]), [['/api/computer/a11y_tree', { query: 'nom', maxDepth: 3 }], ['/api/computer/a11y_tree', {}]]);
});

test('computer_a11y_tree says why a tree is cut: a limit to raise, or a reading that took too long', async (t) => {
  let result: Record<string, unknown> = { ...TREE, truncated: true };
  const { call } = await harness(t, () => ({ body: { ok: true, result } }));
  const limited = await call('tools/call', { name: 'computer_a11y_tree', arguments: {} });
  assert.match(limited.result.content[0].text.split('\n')[0], /truncated: raise maxNodes or maxDepth, or use query$/);
  result = { ...TREE, truncated: true, timedOut: true };
  const slow = await call('tools/call', { name: 'computer_a11y_tree', arguments: {} });
  assert.match(slow.result.content[0].text.split('\n')[0], /truncated: reading took too long, use query, the windowId of a smaller window or a lower maxDepth$/);
});

test('computer_a11y_action reaches its command, with or without the # an id is shown with, also as a step', async (t) => {
  const { requests, call } = await harness(t, () => ({ body: { ok: true, result: { ok: true } } }));
  await call('tools/call', { name: 'computer_a11y_action', arguments: { id: '#10:1#0.0', action: 'set_value', value: 'timon' } });
  await call('tools/call', { name: 'computer_actions', arguments: { screenshot: false, steps: [{ action: 'a11y_action', id: '10:1#0.1', do: 'press' }] } });
  assert.deepEqual(requests.map((r) => [r.path, r.body]), [
    ['/api/computer/a11y_action', { id: '10:1#0.0', action: 'set_value', value: 'timon' }],
    ['/api/computer/a11y_action', { id: '10:1#0.1', action: 'press' }],
  ]);
});
