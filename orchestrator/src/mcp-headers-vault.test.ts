/**
 * The headers of a remote MCP server (an API key typed in the editor) live in
 * the vault, not in `~/.timon/mcp/<id>.json`, which every agent's shell can
 * read: stored there, read back masked by everyone, carried over by a masked
 * save while the server keeps its url, moved there at boot from an older file —
 * and, when the vault cannot take them, left in the file without loss, the
 * server held back from the agents, and no value in any log or error.
 */
// Isolates TIMON_HOME BEFORE any module touching Timon state (see test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MCP_DIR, deleteMcp, getMcp, listMcp, mcpRelayUpstream, migrateMcpHeadersToVault, presentMcpServer,
  redactMcpServer, resolveLaunchServers, upsertMcp,
} from './mcp.js';
import { createSecret, getSecret, listSecrets, resetRotationCheck } from './secrets/store.js';
import { resetMasterKeyCache, resolveMasterKey } from './secrets/key.js';
import { resetActiveModules, setActiveModules } from './kernel/module-state.js';
import { SECRET_KEY_FILE, TIMON_HOME } from './paths.js';
import { exportTimon, importTimon } from './export.js';
import type { McpStoredServer } from './mcp.js';

resolveMasterKey({ keyring: null });

const RELAY = () => ({ url: 'http://127.0.0.1:3001/mcp-relay/r/agent', headers: { 'x-timon-mcp-relay': 'relay-token' } });

function fileOf(id: string): string {
  return readFileSync(join(MCP_DIR, `${id}.json`), 'utf8');
}

function writeLegacy(server: McpStoredServer): void {
  mkdirSync(MCP_DIR, { recursive: true });
  writeFileSync(join(MCP_DIR, `${server.id}.json`), JSON.stringify(server, null, 2) + '\n');
}

function typedSecretIds(id: string): string[] {
  const s = getMcp(id);
  return s?.transport.type === 'http'
    ? Object.values(s.transport.header_secrets ?? {}).filter((ref) => ref.typed).map((ref) => ref.secret_id)
    : [];
}

/** Runs `fn` with every console line it prints collected. */
async function capturingLogs<T>(fn: () => T | Promise<T>): Promise<{ value: T; logs: string }> {
  const lines: string[] = [];
  const original = { warn: console.warn, log: console.log, error: console.error };
  const sink = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.warn = sink; console.log = sink; console.error = sink;
  try {
    const value = await fn();
    return { value, logs: lines.join('\n') };
  } finally {
    Object.assign(console, original);
  }
}

/** The vault's master key made unreadable, as a locked keyring leaves it. */
async function withLockedVault<T>(fn: () => T | Promise<T>): Promise<T> {
  const key = readFileSync(SECRET_KEY_FILE);
  unlinkSync(SECRET_KEY_FILE); resetMasterKeyCache(); resetRotationCheck();
  try {
    return await fn();
  } finally {
    writeFileSync(SECRET_KEY_FILE, key, { mode: 0o600 }); resetMasterKeyCache(); resetRotationCheck();
  }
}

test('typed headers go to the vault: the file names the secret, the relay sends the value, the CLI gets neither', async () => {
  const saved = upsertMcp({
    id: 'typed-http',
    transport: { type: 'http', url: 'https://mcp.typed.example/mcp', headers: { Authorization: 'Bearer typed-123', 'X-Empty': '' } },
  });
  assert.ok(!fileOf('typed-http').includes('typed-123'), 'the value is not in the server file');
  assert.ok(!JSON.stringify(saved).includes('typed-123'), 'nor in the record the write returns');
  const ids = typedSecretIds('typed-http');
  assert.equal(ids.length, 1);
  assert.equal(getSecret(ids[0]!)?.name, 'MCP_TYPED_HTTP_AUTHORIZATION');
  assert.deepEqual(getSecret(ids[0]!)?.grants, [], 'no agent environment receives it');
  // An empty value is no secret, and the vault refuses one: it stays in the file.
  assert.deepEqual(saved.transport.type === 'http' ? saved.transport.headers : null, { 'X-Empty': '' });
  assert.deepEqual((await mcpRelayUpstream('typed-http'))?.headers, { 'X-Empty': '', Authorization: 'Bearer typed-123' });
  const launched = await resolveLaunchServers(['typed-http'], RELAY);
  assert.equal(launched.length, 1);
  assert.ok(!JSON.stringify(launched).includes('typed-123'), 'the launch hands the relay, not the key');
  deleteMcp('typed-http');
  assert.equal(getSecret(ids[0]!), undefined, 'deleting the server deletes its keys');
});

test('every reader gets the headers masked, and never which secret holds them', () => {
  const app = createSecret({ name: 'MCP_APP_MASKED_KEY', value: 'k-app' });
  const s = upsertMcp({
    id: 'masked-http',
    transport: { type: 'http', url: 'https://mcp.masked.example/mcp', headers: { 'X-Api-Key': 'k-typed' } },
    headerSecrets: { Authorization: { secret_id: app.id, prefix: 'Bearer ' } },
  });
  for (const view of [presentMcpServer(s), redactMcpServer(s)]) {
    assert.deepEqual(view.transport, { type: 'http', url: 'https://mcp.masked.example/mcp', headers: { 'X-Api-Key': '***' } });
    assert.ok(!JSON.stringify(view).includes('header_secrets'));
  }
  deleteMcp('masked-http');
});

test('a masked save keeps the value, a new value replaces its secret, a removed header loses it', async () => {
  const url = 'https://mcp.round.example/mcp';
  upsertMcp({ id: 'round-http', transport: { type: 'http', url, headers: { 'X-Api-Key': 'k-first', 'X-Team': 't-1' } } });
  const [first] = typedSecretIds('round-http');
  // The editor sends back what it read: masks, and a description change.
  upsertMcp({ id: 'round-http', description: 'edited', transport: { type: 'http', url, headers: { 'X-Api-Key': '***', 'X-Team': '***' } } });
  assert.deepEqual((await mcpRelayUpstream('round-http'))?.headers, { 'X-Api-Key': 'k-first', 'X-Team': 't-1' });
  assert.ok(typedSecretIds('round-http').includes(first!), 'the same secret, not a copy');
  // A typed value replaces the secret; the old one leaves the vault.
  upsertMcp({ id: 'round-http', transport: { type: 'http', url, headers: { 'X-Api-Key': 'k-second', 'X-Team': '***' } } });
  assert.deepEqual((await mcpRelayUpstream('round-http'))?.headers, { 'X-Team': 't-1', 'X-Api-Key': 'k-second' });
  assert.equal(getSecret(first!), undefined);
  // A header left out is removed, with its secret.
  const before = typedSecretIds('round-http');
  upsertMcp({ id: 'round-http', transport: { type: 'http', url, headers: { 'X-Api-Key': '***' } } });
  assert.deepEqual((await mcpRelayUpstream('round-http'))?.headers, { 'X-Api-Key': 'k-second' });
  assert.equal(before.filter((id) => getSecret(id)).length, 1);
  deleteMcp('round-http');
});

test('a mask never follows the server to another url, and the refusal quotes no value', async () => {
  upsertMcp({ id: 'moved-http', transport: { type: 'http', url: 'https://mcp.here.example/mcp', headers: { Authorization: 'Bearer k-here' } } });
  const [kept] = typedSecretIds('moved-http');
  assert.throws(
    () => upsertMcp({ id: 'moved-http', transport: { type: 'http', url: 'https://attacker.example/mcp', headers: { Authorization: '***' } } }),
    (err: Error) => /masked/.test(err.message) && !err.message.includes('k-here'),
  );
  assert.equal(getMcp('moved-http')?.transport.type === 'http' && getMcp('moved-http')?.transport.url, 'https://mcp.here.example/mcp');
  assert.throws(
    () => upsertMcp({ id: 'moved-http', transport: { type: 'http', url: 'https://mcp.here.example/mcp', headers: { 'X-New': '***' } } }),
    /no stored value/,
  );
  // Moved with a value typed again: the old key leaves the vault.
  upsertMcp({ id: 'moved-http', transport: { type: 'http', url: 'https://mcp.there.example/mcp', headers: { Authorization: 'Bearer k-there' } } });
  assert.equal(getSecret(kept!), undefined);
  assert.deepEqual((await mcpRelayUpstream('moved-http'))?.headers, { Authorization: 'Bearer k-there' });
  deleteMcp('moved-http');
});

test('a save from the editor keeps the key an Apps connector set, which it is not shown', async () => {
  const app = createSecret({ name: 'MCP_APP_KEPT_KEY', value: 'k-app-kept' });
  const url = 'https://mcp.kept.example/mcp';
  upsertMcp({ id: 'app-kept', transport: { type: 'http', url }, headerSecrets: { Authorization: { secret_id: app.id, prefix: 'Bearer ' } }, appSlug: 'kept' });
  upsertMcp({ id: 'app-kept', transport: { type: 'http', url, headers: { 'X-Region': 'eu' } } });
  assert.deepEqual((await mcpRelayUpstream('app-kept'))?.headers, { Authorization: 'Bearer k-app-kept', 'X-Region': 'eu' });
  upsertMcp({ id: 'app-kept', transport: { type: 'http', url, headers: {} } });
  assert.deepEqual((await mcpRelayUpstream('app-kept'))?.headers, { Authorization: 'Bearer k-app-kept' });
  assert.ok(getSecret(app.id));
  deleteMcp('app-kept');
});

test('vault switched off: the headers stay in the file, the server is held back and the page says why', async () => {
  setActiveModules(['@timon/agents']);
  let held: ReturnType<typeof listMcp>[number] | undefined;
  try {
    const { logs } = await capturingLogs(() => upsertMcp({
      id: 'off-http',
      transport: { type: 'http', url: 'https://mcp.off.example/mcp', headers: { Authorization: 'Bearer k-off' } },
    }));
    assert.match(logs, /off-http: its headers stay in its file/);
    assert.ok(!logs.includes('k-off'), 'the warning names the server, not the value');
    assert.ok(fileOf('off-http').includes('k-off'), 'nothing is lost');
    assert.deepEqual(presentMcpServer(getMcp('off-http')!).transport, { type: 'http', url: 'https://mcp.off.example/mcp', headers: { Authorization: '***' } });
    assert.deepEqual(await resolveLaunchServers(['off-http'], () => null), [], 'not handed to agents');
    held = listMcp().find((s) => s.id === 'off-http');
    assert.equal(held?.held_back, 'vault_off');
    const { value: migrated, logs: bootLogs } = await capturingLogs(() => migrateMcpHeadersToVault());
    assert.deepEqual(migrated.kept, ['off-http']);
    assert.ok(!bootLogs.includes('k-off'));
    assert.ok(fileOf('off-http').includes('k-off'), 'the boot leaves the file as it is');
  } finally {
    resetActiveModules();
  }
  assert.equal(listMcp().find((s) => s.id === 'off-http')?.held_back, undefined);
  // The vault back: the next boot moves them.
  const { value: migrated } = await capturingLogs(() => migrateMcpHeadersToVault());
  assert.deepEqual(migrated.moved, ['off-http']);
  assert.ok(!fileOf('off-http').includes('k-off'));
  assert.deepEqual((await mcpRelayUpstream('off-http'))?.headers, { Authorization: 'Bearer k-off' });
  deleteMcp('off-http');
});

test('a masked save while the vault is off keeps the value the file holds', async () => {
  setActiveModules(['@timon/agents']);
  try {
    await capturingLogs(() => {
      upsertMcp({ id: 'off-round', transport: { type: 'http', url: 'https://mcp.offround.example/mcp', headers: { 'X-Api-Key': 'k-offround' } } });
      upsertMcp({ id: 'off-round', description: 'edited', transport: { type: 'http', url: 'https://mcp.offround.example/mcp', headers: { 'X-Api-Key': '***' } } });
    });
    const s = getMcp('off-round');
    assert.deepEqual(s?.transport.type === 'http' ? s.transport.headers : null, { 'X-Api-Key': 'k-offround' });
  } finally {
    resetActiveModules();
  }
  deleteMcp('off-round');
});

test('boot migration: a legacy file moves into the vault once, and a locked vault leaves it as it is', async () => {
  // A sealed secret is what tells a missing key from a fresh install: without
  // one, the vault would draw a new key instead of reading as locked.
  createSecret({ name: 'MCP_TEST_WITNESS', value: 'witness' });
  writeLegacy({
    id: 'legacy-http',
    name: 'legacy-http',
    source: 'timon',
    transport: { type: 'http', url: 'https://mcp.legacy.example/mcp', headers: { Authorization: 'Bearer k-legacy', 'X-Empty': '' } },
  });
  const locked = await withLockedVault(() => capturingLogs(() => migrateMcpHeadersToVault()));
  assert.deepEqual(locked.value.kept, ['legacy-http']);
  assert.match(locked.logs, /legacy-http: its headers stay in its file, .*\(vault error: unavailable\)/);
  assert.ok(!locked.logs.includes('k-legacy'));
  assert.ok(fileOf('legacy-http').includes('k-legacy'), 'no loss while the vault is locked');
  const secretsBefore = listSecrets().length;

  const { value: first, logs } = await capturingLogs(() => migrateMcpHeadersToVault());
  assert.deepEqual(first.moved, ['legacy-http']);
  assert.ok(!logs.includes('k-legacy'));
  assert.ok(!fileOf('legacy-http').includes('k-legacy'));
  const s = getMcp('legacy-http');
  assert.deepEqual(s?.transport.type === 'http' ? s.transport.headers : null, { 'X-Empty': '' });
  assert.deepEqual((await mcpRelayUpstream('legacy-http'))?.headers, { 'X-Empty': '', Authorization: 'Bearer k-legacy' });
  assert.equal(listSecrets().length, secretsBefore + 1);

  const second = migrateMcpHeadersToVault();
  assert.deepEqual(second, { moved: [], kept: [] }, 'idempotent');
  assert.equal(listSecrets().length, secretsBefore + 1, 'no second copy');
  deleteMcp('legacy-http');
  assert.equal(existsSync(join(MCP_DIR, 'legacy-http.json')), false);
});

/** Every file under `dir`, read as text. */
function allText(dir: string): string {
  let out = '';
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    out += statSync(path).isDirectory() ? allText(path) : readFileSync(path, 'utf8');
  }
  return out;
}

test('an export carries the server without its header value, and the import says how to get it back', () => {
  upsertMcp({ id: 'exported-http', transport: { type: 'http', url: 'https://mcp.exported.example/mcp', headers: { 'X-Api-Key': 'k-exported' } } });
  const out = join(mkdtempSync(join(tmpdir(), 'timon-mcp-export-')), 'export.tar.gz');
  exportTimon({ out, home: TIMON_HOME, vacuumInto: () => {} });
  const to = mkdtempSync(join(tmpdir(), 'timon-mcp-import-'));
  const imported = importTimon({ file: out, to });
  const restored = JSON.parse(readFileSync(join(to, 'mcp', 'exported-http.json'), 'utf8')) as McpStoredServer;
  assert.equal(restored.transport.type === 'http' && restored.transport.url, 'https://mcp.exported.example/mcp');
  assert.ok(!allText(join(to, 'mcp')).includes('k-exported'), 'no header value in the archive');
  assert.ok(imported.todo.some((line) => /secrets vault key.*headers of remote MCP servers/.test(line)));
  deleteMcp('exported-http');
});
