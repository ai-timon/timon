/**
 * `ctx.mcpServers` (API 10): MCP server declarations written by a plugin. A
 * declaration is a command on the host or an endpoint every attached agent talks
 * to, so the refusals come first.
 */
import { account, admin, anonymous, as, code, pluginWith } from '../../tests/helpers/facade-kit.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginMcpServer } from './contract/mcp-servers.js';

const { PluginPermissionError, PluginCallerError } = await import('./context.js');
const { upsertMcp, getMcp, mcpRelayUpstream } = await import('../mcp.js');
/** The headers the daemon would send the server: the vault holds their values, not `getMcp`. */
const sentHeaders = async (id: string) => (await mcpRelayUpstream(id))?.headers;
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');
const { resetPluginPolicyState } = await import('./policy.js');
const { setMcpHostLookupForTest } = await import('../mcp-url-guard.js');

// Names resolve without the network: public unless listed.
const DNS: Record<string, string> = { 'loop.acme.test': '127.0.0.1', 'lan.acme.test': '192.168.1.20', 'meta.acme.test': '169.254.169.254' };
setMcpHostLookupForTest(async (hostname) => {
  const address = DNS[hostname] ?? '93.184.215.14';
  return [{ address, family: 4 }];
});
test.after(() => { setMcpHostLookupForTest(null); });

/** Installs a `pluginPolicy` through the real schema. */
function withPolicy(pluginPolicy: { exec?: { allow?: string[] } }): void {
  setConfig(TimonConfigSchema.parse({ pluginPolicy }));
  resetPluginPolicyState();
}

const manager = account('mona', ['mcp:manage']);
const viewer = account('vic', []);
const BOTH = ['mcp-servers:read', 'mcp-servers:write'];
const http = (url = 'https://mcp.example.com/sse', headers?: Record<string, string>) => ({ transport: { type: 'http' as const, url, ...(headers ? { headers } : {}) } });

upsertMcp({ id: 'human-server', name: 'Human', transport: { type: 'http', url: 'https://human.example.com/mcp', headers: { Authorization: 'Bearer human-secret' } } });
upsertMcp({ id: 'human-cmd', transport: { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'cmd-secret' } } });

test('every call needs its permission in the manifest', async () => {
  const { plugin, dispose } = await pluginWith(['storage']);
  await assert.rejects(as(admin, () => plugin.mcpServers.list()), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.mcpServers.get('human-server')), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.mcpServers.put('x', http())), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.mcpServers.rm('human-server')), PluginPermissionError);
  const readOnly = await pluginWith(['mcp-servers:read'], 'reader');
  await assert.rejects(as(admin, () => readOnly.plugin.mcpServers.put('x', http())), PluginPermissionError);
  await assert.rejects(readOnly.plugin.mcpServers.rm('human-server'), PluginPermissionError);
  assert.ok(getMcp('human-server'));
  await readOnly.dispose();
  await dispose();
});

test('an anonymous request is refused; writing needs mcp:manage on the account', async () => {
  const { plugin, dispose } = await pluginWith(BOTH);
  await assert.rejects(as(anonymous, () => plugin.mcpServers.list()), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.mcpServers.put('anon', http())), PluginCallerError);
  await assert.rejects(as(viewer, () => plugin.mcpServers.put('sneaky', http())), PluginCallerError);
  await assert.rejects(as(viewer, () => plugin.mcpServers.rm('human-server')), PluginCallerError);
  assert.equal(getMcp('sneaky'), null);
  assert.ok((await as(viewer, () => plugin.mcpServers.list())).some((s) => s.id === 'human-server'));
  await dispose();
});

test('secrets are read back masked, a superadmin\'s request included', async () => {
  const { plugin, dispose } = await pluginWith(BOTH);
  for (const who of [viewer, manager, admin]) {
    const server = await as(who, () => plugin.mcpServers.get('human-server'));
    assert.deepEqual(server?.transport, { type: 'http', url: 'https://human.example.com/mcp', headers: { Authorization: '***' } });
    const cmd = await as(who, () => plugin.mcpServers.get('human-cmd'));
    assert.deepEqual((cmd?.transport as { env?: Record<string, string> }).env, { TOKEN: '***' });
  }
  const listed = JSON.stringify(await as(admin, () => plugin.mcpServers.list()));
  for (const secret of ['human-secret', 'cmd-secret']) assert.ok(!listed.includes(secret), `list must not expose ${secret}`);
  await dispose();
});

test('an http server is declared, marked, and read back masked', async () => {
  const { plugin, dispose } = await pluginWith(BOTH);
  const made = await as(manager, () => plugin.mcpServers.put('acme-search', { name: 'Acme search', description: 'Search', ...http('https://mcp.acme.test/sse', { Authorization: 'Bearer acme-token' }) }));
  assert.equal(made.mine, true);
  assert.equal(made.createdBy, 'plugin:acme-api10');
  assert.deepEqual(made.transport, { type: 'http', url: 'https://mcp.acme.test/sse', headers: { Authorization: '***' } });
  assert.deepEqual(await sentHeaders('acme-search'), { Authorization: 'Bearer acme-token' }, 'the stored value is the real one');
  assert.ok(!JSON.stringify(getMcp('acme-search')).includes('acme-token'), 'the vault holds it, not the file');
  assert.equal(getMcp('acme-search')!.created_by?.agent, 'plugin:acme-api10');
  assert.equal(getMcp('acme-search')!.public_only, true, 'judged again at each launch');
  await dispose();
});

test('writing back a masked secret keeps the stored one, and is refused if the server moved', async () => {
  const { plugin, dispose } = await pluginWith(BOTH);
  await as(manager, () => plugin.mcpServers.put('roundtrip', http('https://mcp.acme.test/sse', { Authorization: 'Bearer real' })));
  await as(manager, () => plugin.mcpServers.put('roundtrip', { description: 'edited', ...http('https://mcp.acme.test/sse', { Authorization: '***' }) }));
  assert.deepEqual(await sentHeaders('roundtrip'), { Authorization: 'Bearer real' });
  await assert.rejects(
    as(manager, () => plugin.mcpServers.put('roundtrip', http('https://elsewhere.test/sse', { Authorization: '***' }))),
    code('forbidden'),
    'a mask carried to another url would send the stored credential there',
  );
  assert.equal((getMcp('roundtrip')!.transport as { url: string }).url, 'https://mcp.acme.test/sse');
  await dispose();
});

test('a server read with get is written back as is; a real unknown key still fails', async () => {
  const { plugin, dispose } = await pluginWith(BOTH);
  await as(manager, () => plugin.mcpServers.put('echoed', http('https://mcp.acme.test/sse', { Authorization: 'Bearer real' })));
  const read = (await as(manager, () => plugin.mcpServers.get('echoed')))!;
  assert.ok('mine' in read && 'createdBy' in read, 'the read shape carries host fields');
  await as(manager, () => plugin.mcpServers.put('echoed', { ...read, description: 'edited' } as never));
  assert.equal(getMcp('echoed')!.description, 'edited');
  assert.deepEqual(await sentHeaders('echoed'), { Authorization: 'Bearer real' }, 'the masked header kept the stored secret');
  await assert.rejects(as(manager, () => plugin.mcpServers.put('echoed', { ...http('https://mcp.acme.test/sse'), nmae: 'typo' } as never)), code('invalid'));
  await dispose();
});

test('a stdio server is a superadmin\'s request, never a job or an ordinary manager, and its binary obeys host:exec', async () => {
  const { plugin, dispose } = await pluginWith(BOTH);
  const stdio = (command: string) => ({ transport: { type: 'stdio' as const, command, args: ['x.js'] } });
  await assert.rejects(as(manager, () => plugin.mcpServers.put('cmd-a', stdio('mytool'))), code('forbidden'));
  await assert.rejects(plugin.mcpServers.put('cmd-a', stdio('mytool')), code('forbidden'));
  // A superadmin\'s request still meets the operator's policy: empty allowlist, no command…
  withPolicy({});
  await assert.rejects(as(admin, () => plugin.mcpServers.put('cmd-a', stdio('mytool'))), code('forbidden'));
  // …never the product\'s own binaries or a generic launcher, even allowlisted…
  withPolicy({ exec: { allow: ['mytool', 'claude', 'node'] } });
  for (const command of ['claude', 'codex', 'timon', 'node', 'sh']) {
    await assert.rejects(as(admin, () => plugin.mcpServers.put('cmd-a', stdio(command))), code('forbidden'), command);
  }
  // …and an allowlisted one is accepted, but only from that superadmin\'s request.
  const made = await as(admin, () => plugin.mcpServers.put('cmd-a', stdio('mytool')));
  assert.equal(made.transport.type, 'stdio');
  await assert.rejects(as(manager, () => plugin.mcpServers.put('cmd-b', stdio('mytool'))), code('forbidden'));
  // A human\'s command cannot be repointed at another binary behind the allowlist\'s back.
  await assert.rejects(as(admin, () => plugin.mcpServers.put('human-cmd', stdio('node'))), code('forbidden'));
  assert.equal((getMcp('human-cmd')!.transport as { command: string }).command, 'node', 'unchanged');
  assert.equal(getMcp('cmd-b'), null);
  resetConfig();
  await dispose();
});

test('an http url that names this host, a link-local address or another scheme is refused', async () => {
  const { plugin, dispose } = await pluginWith(BOTH);
  const bad = [
    'http://127.0.0.1:3001/api/agents', 'http://localhost:3001/', 'http://sub.localhost/', 'http://[::1]/', 'http://0.0.0.0/',
    'http://169.254.169.254/latest/meta-data', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'file:///etc/passwd', 'ftp://example.com/', 'javascript:alert(1)', 'not a url',
  ];
  for (const url of bad) {
    await assert.rejects(as(manager, () => plugin.mcpServers.put('local-a', http(url))), code('forbidden'), url);
    await assert.rejects(plugin.mcpServers.put('local-a', http(url)), code('forbidden'), `${url} as a job`);
  }
  // A superadmin\'s request does not point agents at the daemon through a plugin either.
  await assert.rejects(as(admin, () => plugin.mcpServers.put('local-a', http('http://127.0.0.1:3001/api/agents'))), code('forbidden'));
  // Nor does a public-looking name that resolves to this host, the LAN or a metadata endpoint (TODO #530).
  for (const host of ['loop.acme.test', 'lan.acme.test', 'meta.acme.test']) {
    for (const who of [manager, admin]) {
      await assert.rejects(as(who, () => plugin.mcpServers.put('local-a', http(`https://${host}/mcp`))), code('forbidden'), host);
    }
  }
  assert.equal(getMcp('local-a'), null);
  await dispose();
});

test('what Timon injects and what the harness discovered is never written, shadowed or removed', async () => {
  const { plugin, dispose } = await pluginWith(BOTH);
  for (const id of ['timon', 'timon-browser']) {
    await assert.rejects(as(admin, () => plugin.mcpServers.put(id, http())), code('forbidden'), id);
  }
  await assert.rejects(as(admin, () => plugin.mcpServers.put('shadow', { name: 'timon', ...http() })), code('forbidden'));
  await assert.rejects(as(admin, () => plugin.mcpServers.put('ext-connector', http())), code('forbidden'));
  await dispose();
});

test('only the servers this plugin declared are changed or removed', async () => {
  const mine = await pluginWith(BOTH, 'owner-plugin');
  const other = await pluginWith(BOTH, 'other-plugin');
  await as(manager, () => mine.plugin.mcpServers.put('owned-server', http()));
  const takeover = http('https://evil.example.com/mcp');
  for (const [target, id] of [[other.plugin, 'owned-server'], [mine.plugin, 'human-server'], [mine.plugin, 'human-cmd']] as const) {
    await assert.rejects(as(manager, () => target.mcpServers.put(id, takeover)), code('forbidden'), id);
    await assert.rejects(as(manager, () => target.mcpServers.rm(id)), code('forbidden'), id);
    await assert.rejects(target.mcpServers.put(id, takeover), code('not_found'), `${id} as a job`);
    await assert.rejects(target.mcpServers.rm(id), code('not_found'), `${id} as a job`);
    assert.equal(await target.mcpServers.get(id), undefined, `${id}: a job cannot read what it did not declare`);
  }
  assert.equal((getMcp('owned-server')!.transport as { url: string }).url, 'https://mcp.example.com/sse');
  assert.equal((getMcp('human-server')!.transport as { url: string }).url, 'https://human.example.com/mcp');
  // A superadmin's request may, and keeps the mark of whoever declared it.
  const byAdmin = await as(admin, () => other.plugin.mcpServers.put('owned-server', takeover));
  assert.equal(byAdmin.createdBy, 'plugin:owner-plugin');
  assert.equal(await as(manager, () => mine.plugin.mcpServers.rm('owned-server')), true, 'still the owner\'s to remove');
  assert.equal(getMcp('owned-server'), null);
  await mine.dispose();
  await other.dispose();
});

test('a job lists and reads only what it declared; a request sees what the page lists', async () => {
  const { plugin, dispose } = await pluginWith(BOTH, 'job-plugin');
  await plugin.mcpServers.put('job-server', http());
  const own = await plugin.mcpServers.list();
  assert.deepEqual(own.map((s) => [s.id, s.mine]), [['job-server', true]]);
  assert.ok(!('transport' in own[0]!), 'the listing carries no transport');
  assert.equal(await plugin.mcpServers.get('human-server'), undefined);
  const page = (await as(viewer, () => plugin.mcpServers.list())).map((s) => s.id);
  assert.ok(page.includes('human-server') && page.includes('job-server'));
  assert.equal(await plugin.mcpServers.rm('job-server'), true);
  await dispose();
});

test('the input is strict: no oauth, no unknown field (a read-only one is ignored, not refused), a valid id', async () => {
  const { plugin, dispose } = await pluginWith(BOTH);
  const withOauth = { transport: { type: 'http', url: 'https://mcp.acme.test/sse', oauth: { tokens: { access_token: 'forged' } } } };
  await assert.rejects(as(manager, () => plugin.mcpServers.put('strict-a', withOauth as never)), code('invalid'));
  await assert.rejects(as(manager, () => plugin.mcpServers.put('strict-a', { ...http(), owner: 'x' } as never)), code('invalid'));
  await assert.rejects(as(manager, () => plugin.mcpServers.put('strict-a', { transport: { type: 'external', claude_key: 'x' } } as never)), code('invalid'));
  for (const id of ['', 'UPPER', 'a/b', '../x', 'x'.repeat(101)]) {
    await assert.rejects(as(manager, () => plugin.mcpServers.put(id, http())), code('invalid'), id);
    await assert.rejects(as(manager, () => plugin.mcpServers.get(id)), code('invalid'), id);
  }
  assert.equal(getMcp('strict-a'), null);
  await dispose();
});

test('which vault secret holds a key never reaches a plugin, by type or at runtime', async () => {
  const { createSecret } = await import('../secrets/store.js');
  const { resolveMasterKey } = await import('../secrets/key.js');
  resolveMasterKey({ keyring: null });
  // The contract a plugin compiles against has no such field.
  type PublicHttp = Extract<PluginMcpServer['transport'], { type: 'http' }>;
  const exposed: 'header_secrets' extends keyof PublicHttp ? true : false = false;
  assert.equal(exposed, false);

  const secret = createSecret({ name: 'MCP_APP_FACADE_KEY', value: 'k-facade-value' });
  upsertMcp({
    id: 'app-facade',
    transport: { type: 'http', url: 'https://mcp.facade.example/mcp' },
    headerSecrets: { Authorization: { secret_id: secret.id, prefix: 'Token ' } },
    appSlug: 'facade',
  });
  const { plugin, dispose } = await pluginWith(BOTH);
  const leaks = (value: unknown): string[] => {
    const text = JSON.stringify(value);
    return [secret.id, 'header_secrets', 'secret_id', 'Token ', 'k-facade-value'].filter((needle) => text.includes(needle));
  };
  for (const who of [viewer, manager, admin]) {
    assert.deepEqual(leaks(await as(who, () => plugin.mcpServers.get('app-facade'))), []);
    assert.deepEqual(leaks(await as(who, () => plugin.mcpServers.list())), []);
  }
  // A superadmin's request rewrites it on the same url: the answer is public too,
  // and the stored key keeps reaching the server.
  const saved = await as(admin, () => plugin.mcpServers.put('app-facade', http('https://mcp.facade.example/mcp')));
  assert.deepEqual(leaks(saved), []);
  const stored = getMcp('app-facade');
  assert.equal(stored?.transport.type === 'http' ? stored.transport.header_secrets?.Authorization?.secret_id : null, secret.id);
  await dispose();
});
