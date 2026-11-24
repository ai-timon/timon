import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-workflows-http-'));
// Several accounts with different rights: a single-superadmin licence refuses them.
await import('../../tests/helpers/paid-license.js');
const { dbApi } = await import('../db.js');
const { createRun } = await import('./engine.js');
const { parseWorkflowDefinition, describeWorkflowError } = await import('./schema.js');
const { assertHttpNodesAllowed, httpNodeConfigSchema, httpNodeDenied, HTTP_MAX_RESPONSE_BYTES } = await import('./nodes/http.js');

type Seen = { method?: string; url?: string; headers?: IncomingHttpHeaders; body?: string };
const seen: Seen = {};
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    Object.assign(seen, { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    if (req.url?.startsWith('/json')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ hello: 'world', path: req.url })); return; }
    if (req.url === '/boom') { res.statusCode = 500; res.end('kaput'); return; }
    if (req.url === '/huge') { res.setHeader('content-type', 'text/plain'); res.end('x'.repeat(HTTP_MAX_RESPONSE_BYTES + 10)); return; }
    if (req.url === '/metadata') { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/latest/meta-data/'); res.end(); return; }
    res.end('plain');
  });
});
let base = '';
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

function seed(http: Record<string, unknown>, owner: string | null = null, failedEdge = false) {
  const id = randomUUID(); const now = Date.now();
  const definition = {
    schemaVersion: 1,
    nodes: [
      { id: 'manual', type: 'trigger.manual', config: {} },
      { id: 'call', type: 'http', config: http },
      { id: 'ok', type: 'output', config: { template: '{{nodes.call.output.body}}' } },
      ...(failedEdge ? [{ id: 'ko', type: 'output', config: { template: 'routed' } }] : []),
    ],
    edges: [
      { id: 'a', from: 'manual', fromPort: 'out', to: 'call', toPort: 'in' },
      { id: 'b', from: 'call', fromPort: 'done', to: 'ok', toPort: 'in' },
      ...(failedEdge ? [{ id: 'c', from: 'call', fromPort: 'failed', to: 'ko', toPort: 'in' }] : []),
    ],
    variables: [], settings: {},
  };
  dbApi.insertWorkflow({ id, slug: `http-${id.slice(0, 8)}`, name: 'HTTP witness', description: null, project: null, owner_user_id: owner, draft: JSON.stringify(definition), published_version: 1, enabled: 1, created_at: now, updated_at: now, agent_name: null });
  dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(definition), published_at: now, published_by: null });
  return id;
}

async function run(workflowId: string, input: unknown = {}) {
  const started = createRun(workflowId, { trigger: { kind: 'manual' }, input });
  const deadline = performance.now() + 10_000;
  for (;;) {
    const row = dbApi.getWorkflowRun(started.id)!;
    if (!['pending', 'running', 'waiting'].includes(row.status)) {
      const nodes = Object.fromEntries(dbApi.listWorkflowRunNodes(started.id).map((node) => [node.node_id, node]));
      return { run: row, call: nodes.call!, nodes };
    }
    assert.ok(performance.now() < deadline, `run did not settle (status: ${row.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('the config schema refuses what the transport or the logs must not get', () => {
  const ok = (config: unknown) => httpNodeConfigSchema.safeParse(config).success;
  assert.ok(ok({ url: 'https://api.example.com/v1' }));
  assert.ok(ok({ url: '{{input.url}}', method: 'POST', body: '{"a":1}' }));
  assert.ok(!ok({ url: 'https://api.example.com', method: 'GET', body: 'x' }), 'GET with a body');
  assert.ok(!ok({ url: 'ftp://example.com/file' }), 'other schemes');
  assert.ok(!ok({ url: 'https://user:pass@example.com/' }), 'credentials in the URL');
  assert.ok(!ok({ url: 'https://example.com/?key={{secrets.API_TOKEN}}' }), 'a secret in the URL');
  assert.ok(!ok({ url: 'https://example.com/', method: 'POST', body: '{{ secrets.API_TOKEN }}' }), 'a secret in the body');
  assert.ok(!ok({ url: 'https://example.com/', headers: { Host: 'internal' } }), 'a framing header');
  assert.ok(!ok({ url: 'https://example.com/', headers: { 'Bad Name': 'x' } }), 'an invalid header name');
  assert.ok(!ok({ url: 'https://example.com/', timeoutMs: 3_600_000 }), 'a timeout over the ceiling');
  assert.ok(!ok({ url: 'https://example.com/', extra: true }), 'an unknown key');
  // Published through the workflow schema, the node is named.
  assert.throws(() => parseWorkflowDefinition({ schemaVersion: 1, nodes: [{ id: 'm', type: 'trigger.manual', config: {} }, { id: 'h', type: 'http', config: { url: 'ftp://x' } }], edges: [], variables: [], settings: {} }), /invalid config for h/);
});

test('a call returns status and parsed JSON, fills its templates and reads vault secrets in headers only', async () => {
  const secret = dbApi.createSecret({ name: 'HTTP_NODE_TOKEN', value_enc: 'token-value-0123456789', mode: 'inject' });
  dbApi.addSecretGrant(secret.id, 'global');
  const id = seed({
    url: `${base}/json/{{input.item}}`, method: 'POST', body: '{"name":"{{input.name}}"}',
    headers: { Authorization: 'Bearer {{secrets.HTTP_NODE_TOKEN}}', 'X-Item': '{{input.item}}' },
    allowPrivateNetwork: true,
  });
  const { run: done, call, nodes } = await run(id, { item: 'abc', name: 'Ada' });
  assert.equal(done.status, 'completed', call.error ?? '');
  assert.equal(call.taken_port, 'done');
  const output = JSON.parse(call.output!) as { status: number; headers: Record<string, string>; body: { hello: string; path: string } };
  assert.equal(output.status, 200);
  assert.equal(output.body.hello, 'world');
  assert.equal(output.body.path, '/json/abc');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.body, '{"name":"Ada"}');
  assert.equal(seen.headers?.authorization, 'Bearer token-value-0123456789');
  assert.equal(seen.headers?.['x-item'], 'abc');
  assert.equal(seen.headers?.['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(nodes.ok!.output!), JSON.stringify(output.body));
});

test('a secret the node cannot read fails the node instead of sending an empty header', async () => {
  const id = seed({ url: `${base}/plain`, headers: { Authorization: 'Bearer {{secrets.NOT_IN_THE_VAULT}}' }, allowPrivateNetwork: true });
  const { run: failed, call } = await run(id);
  assert.equal(failed.status, 'failed');
  assert.match(call.error ?? '', /secret NOT_IN_THE_VAULT is not available/);
});

test('loopback is refused unless the node allows the private network', async () => {
  const { run: failed, call } = await run(seed({ url: `${base}/json` }));
  assert.equal(failed.status, 'failed');
  assert.match(call.error ?? '', /loopback; the connection must declare private network access/);
});

test('a redirect towards a metadata address is refused at the hop', async () => {
  const { run: failed, call } = await run(seed({ url: `${base}/metadata`, allowPrivateNetwork: true }));
  assert.equal(failed.status, 'failed');
  assert.match(call.error ?? '', /never reachable/);
});

test('a non-2xx status takes the failed port when one is wired, and a body over the ceiling fails', async () => {
  const routed = await run(seed({ url: `${base}/boom`, allowPrivateNetwork: true }, null, true));
  assert.equal(routed.run.status, 'completed');
  assert.equal(routed.call.taken_port, 'failed');
  assert.match(routed.call.error ?? '', /HTTP 500: kaput/);
  assert.equal(routed.nodes.ok!.status, 'skipped');

  const huge = await run(seed({ url: `${base}/huge`, allowPrivateNetwork: true }));
  assert.equal(huge.run.status, 'failed');
  assert.match(huge.call.error ?? '', /response larger than/);
});

test('an account without http:outbound is refused at publish and at run; private network is an administrator\'s', async () => {
  const account = (name: string, permissions: string[], superadmin = false) => {
    const id = randomUUID();
    createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused', status: 'active', isSuperadmin: superadmin });
    grantTestPermissions(dbApi, id, permissions);
    return id;
  };
  const plain = account('plain', ['missions:read']);
  const caller = account('caller', ['http:outbound']);
  const admin = account('admin', [], true);

  assert.match(httpNodeDenied(plain, { allowPrivateNetwork: false }) ?? '', /needs http:outbound/);
  assert.equal(httpNodeDenied(caller, { allowPrivateNetwork: false }), null);
  assert.match(httpNodeDenied(caller, { allowPrivateNetwork: true }) ?? '', /only an administrator/);
  assert.equal(httpNodeDenied(admin, { allowPrivateNetwork: true }), null);
  assert.match(httpNodeDenied('plugin:acme', { allowPrivateNetwork: false }) ?? '', /ctx\.fetch/);
  assert.match(httpNodeDenied(randomUUID(), { allowPrivateNetwork: false }) ?? '', /not an active account/);

  // Publish names the node, as the builder draws it.
  const nodes = [{ id: 'call', type: 'http', config: { url: 'https://example.com/' } }];
  let refusal: unknown;
  try { assertHttpNodesAllowed(nodes, plain); } catch (error) { refusal = error; }
  const described = describeWorkflowError(refusal);
  assert.equal(described.issues?.[0]?.nodeId, 'call');
  assert.match(described.error, /needs http:outbound/);
  assert.equal(described.code, 'workflow_refused');
  assert.deepEqual(described.params, { detail: described.error });
  assert.doesNotThrow(() => assertHttpNodesAllowed(nodes, caller));

  // The run re-checks the owner: nothing leaves the host for a refused account.
  seen.url = undefined;
  const refused = await run(seed({ url: `${base}/json/refused`, allowPrivateNetwork: true }, caller));
  assert.equal(refused.run.status, 'failed');
  assert.match(refused.call.error ?? '', /only an administrator/);
  const denied = await run(seed({ url: `${base}/json/denied` }, plain));
  assert.match(denied.call.error ?? '', /needs http:outbound/);
  assert.equal(seen.url, undefined, 'no request reached the server');

  const allowed = await run(seed({ url: `${base}/json/admin`, allowPrivateNetwork: true }, admin));
  assert.equal(allowed.run.status, 'completed', allowed.call.error ?? '');
  assert.equal(seen.url, '/json/admin');
});
