/**
 * The three formats Timon declares MCP servers to a CLI in, pinned byte for
 * byte: claude's `--mcp-config` JSON (also copilot's), codex's `config.toml`
 * blocks and grok's. The pure serializers are what a provider author gets from
 * the SDK, so what the daemon writes for its own providers and what a plugin
 * writes must stay one and the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-mcp-serialize-'));
process.env.TIMON_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { upsertMcp, buildMcpConfig, buildCodexMcpToml, buildGrokMcpToml } = await import('./mcp.js');

upsertMcp({
  id: 'plain',
  name: 'plain',
  transport: { type: 'stdio', command: 'node', args: ['srv.mjs', '--flag'], env: { TOKEN: 'a"b', 'odd.key': 'v' } },
});
upsertMcp({ id: 'bare', name: 'has space', transport: { type: 'stdio', command: 'bare-cmd' } });
upsertMcp({
  id: 'web',
  name: 'web',
  transport: {
    type: 'http',
    url: 'https://mcp.example.test/v1',
    headers: { 'X-Key': 'k' },
  },
});
upsertMcp({
  id: 'connected',
  name: 'connected',
  transport: {
    type: 'http',
    url: 'https://oauth.example.test/mcp',
    headers: { 'X-Stored': 'stored-header-value' },
    oauth: {
      metadata: {} as never,
      client: {} as never,
      redirect_uri: 'https://app.example.test/cb',
      tokens: { access_token: 'oauth-access-token-value', token_type: 'Bearer' } as never,
    },
  },
});

const IDS = ['plain', 'bare', 'web', 'does-not-exist'];

test('claude and copilot: --mcp-config JSON', async () => {
  assert.equal(await buildMcpConfig(IDS), JSON.stringify({
    mcpServers: {
      plain: { command: 'node', args: ['srv.mjs', '--flag'], env: { TOKEN: 'a"b', 'odd.key': 'v' } },
      bare: { command: 'bare-cmd', args: [], env: {} },
      web: { type: 'http', url: 'https://mcp.example.test/v1', headers: { 'X-Key': 'k' } },
    },
  }));
  assert.equal(await buildMcpConfig([]), null);
  assert.equal(await buildMcpConfig(['does-not-exist']), null);
});

/** What every codex stdio server asks for: the package cache a fenced mission carries. */
const CACHE_ENV_VARS = 'env_vars = ["npm_config_cache", "npm_config_cache_dir", "npm_config_store_dir", "UV_CACHE_DIR"]';

test('codex: config.toml blocks, approval mode before any sub-table', async () => {
  const toml = await buildCodexMcpToml(IDS);
  assert.equal(toml, [
    '[mcp_servers.plain]',
    'command = "node"',
    'args = ["srv.mjs", "--flag"]',
    CACHE_ENV_VARS,
    'default_tools_approval_mode = "approve"',
    '',
    '[mcp_servers.plain.env]',
    'TOKEN = "a\\"b"',
    '"odd.key" = "v"',
    '',
    '[mcp_servers.bare]',
    'command = "bare-cmd"',
    CACHE_ENV_VARS,
    'default_tools_approval_mode = "approve"',
    '',
    '[mcp_servers.web]',
    'url = "https://mcp.example.test/v1"',
    'default_tools_approval_mode = "approve"',
    'http_headers = { "X-Key" = "k" }',
    '',
  ].join('\n'));
});

test('grok: enabled flag, headers in a sub-table, no approval key', async () => {
  const toml = await buildGrokMcpToml(IDS);
  assert.equal(toml, [
    '[mcp_servers.plain]',
    'command = "node"',
    'args = ["srv.mjs", "--flag"]',
    'enabled = true',
    '',
    '[mcp_servers.plain.env]',
    'TOKEN = "a\\"b"',
    '"odd.key" = "v"',
    '',
    '[mcp_servers.bare]',
    'command = "bare-cmd"',
    'enabled = true',
    '',
    '[mcp_servers.web]',
    'url = "https://mcp.example.test/v1"',
    'enabled = true',
    '',
    '[mcp_servers.web.headers]',
    'X-Key = "k"',
    '',
  ].join('\n'));
  assert.equal(await buildGrokMcpToml([]), null);
});

test('an OAuth server reaches a CLI only as the relay: neither its bearer nor its stored headers', async () => {
  const { resolveLaunchServers } = await import('./mcp.js');
  // No mission to bind a relay token to: the server is left out, not handed over with its bearer.
  assert.equal(await buildMcpConfig(['connected']), null);
  assert.equal(await buildCodexMcpToml(['connected']), null);
  const seen: Array<{ id: string; url: string }> = [];
  const launched = await resolveLaunchServers(['connected', 'web'], (server) => {
    seen.push(server);
    return { url: 'http://127.0.0.1:3001/mcp-relay/r/agent', headers: { 'x-timon-mcp-relay': 'relay-token' } };
  });
  assert.deepEqual(seen, [{ id: 'connected', url: 'https://oauth.example.test/mcp' }]);
  assert.deepEqual(launched[0], {
    type: 'http', name: 'connected', url: 'http://127.0.0.1:3001/mcp-relay/r/agent', headers: { 'x-timon-mcp-relay': 'relay-token' },
  });
  const { serializeCodexMcpToml, serializeGrokMcpToml, serializeMcpJson } = await import('./backends/mcp-serialize.js');
  for (const text of [serializeMcpJson(launched), serializeCodexMcpToml(launched), serializeGrokMcpToml(launched)]) {
    assert.ok(text && !text.includes('oauth-access-token-value') && !text.includes('stored-header-value'));
    assert.ok(!text.includes('oauth.example.test'));
  }
});

test('the serializers are pure: the same list gives the same text, with no store behind it', async () => {
  const { serializeAcpMcpServers, serializeCodexMcpToml, serializeGrokMcpToml, serializeMcpJson, mcpEnvPairs } = await import('./backends/mcp-serialize.js');
  const list = [
    { type: 'stdio', name: 'mine', command: 'node', args: ['a.mjs'], env: { K: 'v' } },
    { type: 'http', name: 'remote', url: 'https://x.test/mcp', headers: {} },
  ] as const;
  assert.equal(serializeMcpJson(list), JSON.stringify({
    mcpServers: { mine: { command: 'node', args: ['a.mjs'], env: { K: 'v' } }, remote: { type: 'http', url: 'https://x.test/mcp' } },
  }));
  assert.match(serializeCodexMcpToml(list) ?? '', /\[mcp_servers\.remote\]\nurl = "https:\/\/x\.test\/mcp"\ndefault_tools_approval_mode/);
  assert.match(serializeGrokMcpToml(list) ?? '', /\[mcp_servers\.remote\]\nurl = "https:\/\/x\.test\/mcp"\nenabled = true\n$/);
  for (const serialize of [serializeMcpJson, serializeCodexMcpToml, serializeGrokMcpToml]) {
    assert.equal(serialize([]), null);
  }
  assert.deepEqual(serializeAcpMcpServers(list), {
    servers: [{ name: 'mine', command: 'node', args: ['a.mjs'], env: [{ name: 'K', value: 'v' }] }],
    skipped: ['remote'],
  });
  assert.deepEqual(mcpEnvPairs(undefined), []);
});

test('a server name that is not a TOML bare key still yields a valid table name', async () => {
  const { serializeCodexMcpToml } = await import('./backends/mcp-serialize.js');
  const toml = serializeCodexMcpToml([{ type: 'stdio', name: 'we ird.name', command: 'c', args: [], env: {} }]);
  assert.match(toml ?? '', /^\[mcp_servers\.we_ird_name\]/);
});

test('codex forwards a variable by NAME to the servers that ask for it, before the approval key, and never writes a value', async () => {
  const { serializeCodexMcpToml } = await import('./backends/mcp-serialize.js');
  const list = [
    { type: 'stdio', name: 'timon', command: 'node', args: ['t.mjs'], env: { TIMON_ORCH_URL: 'http://localhost:3001' } },
    { type: 'stdio', name: 'plain', command: 'node', args: [], env: {} },
    { type: 'http', name: 'remote', url: 'https://x.test/mcp', headers: {} },
  ] as const;
  const toml = serializeCodexMcpToml(list, { forward: (server) => (server.name === 'timon' ? ['TIMON_API_TOKEN'] : []) }) ?? '';
  const caches = '"npm_config_cache", "npm_config_cache_dir", "npm_config_store_dir", "UV_CACHE_DIR"';
  assert.ok(toml.includes(`[mcp_servers.timon]\ncommand = "node"\nargs = ["t.mjs"]\nenv_vars = ["TIMON_API_TOKEN", ${caches}]\ndefault_tools_approval_mode = "approve"\n\n[mcp_servers.timon.env]`), toml);
  assert.equal(toml.match(/TIMON_API_TOKEN/g)?.length, 1, 'only the server that asked');
  assert.equal(serializeCodexMcpToml(list), serializeCodexMcpToml(list, {}), 'no option, no change');
});

test('codex hands every stdio server the package cache variables a fenced mission carries, by name', async () => {
  const { serializeCodexMcpToml } = await import('./backends/mcp-serialize.js');
  const toml = serializeCodexMcpToml([
    { type: 'stdio', name: 'everything', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], env: {} },
    { type: 'http', name: 'remote', url: 'https://x.test/mcp', headers: {} },
  ], { forward: () => ['npm_config_cache'] }) ?? '';
  assert.ok(toml.includes('[mcp_servers.everything]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-everything"]\n'
    + 'env_vars = ["npm_config_cache", "npm_config_cache_dir", "npm_config_store_dir", "UV_CACHE_DIR"]\n'), toml);
  assert.equal(toml.match(/env_vars/g)?.length, 1, 'an HTTP server starts no process');
  assert.ok(!toml.includes('.agents'), 'a name, never a path');
});
