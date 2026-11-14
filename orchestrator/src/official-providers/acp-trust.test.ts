/**
 * Moving opencode, Hermes and Pi out of the core must change nothing for their missions: the official
 * provider is the product's own (`docs/SECURITY.md` § 6.4.1), so a mission on it starts the agent under the
 * default policy (nothing on `pluginPolicy.exec.allow`), with its own token and the vault slice it was
 * granted — and the session the agent is opened with declares Timon's MCP servers with that SAME token,
 * swapped by the daemon on the pipe, never a reference and never anything the plugin held.
 *
 * Through the real launch (`spawnAgent`), the real session driver and the scripted fake ACP agent behind
 * `host.spawn`: a stub proves nothing about what the service wires.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'backends', 'acp', '__fixtures__', 'fake-acp-agent.mjs');

const { mountOfficialProviders, stubCliBinaries } = await import('../../tests/helpers/official-providers.js');
await stubCliBinaries('opencode', 'hermes-acp', 'agy');
const { getHost } = await import('../host/index.js');
const { spawnAgent, upsertAgent, killAgent } = await import('../agent.js');
const { config } = await import('../config/load.js');
const { dbApi } = await import('../db.js');
const { seal } = await import('../secrets/box.js');
const { resolveMasterKey } = await import('../secrets/key.js');
const { backendTrust, isProductBackend, getDialect } = await import('../backends/registry.js');

const VAULT_VALUE = 'vault-value-acp-witness';
{
  const key = resolveMasterKey({ keyring: null });
  const row = dbApi.createSecret({ name: 'VAULT_ACP_WITNESS', value_enc: 'placeholder', mode: 'inject' });
  dbApi.updateSecret(row.id, { value_enc: seal(VAULT_VALUE, key, { secretId: row.id, name: 'VAULT_ACP_WITNESS' }) });
  dbApi.addSecretGrant(row.id, 'global');
  // A Gemini key granted to every mission: Antigravity would be billed by the token with it.
  const gemini = dbApi.createSecret({ name: 'GEMINI_API_KEY', value_enc: 'placeholder', mode: 'inject' });
  dbApi.updateSecret(gemini.id, { value_enc: seal('AIza-vault-witness', key, { secretId: gemini.id, name: 'GEMINI_API_KEY' }) });
  dbApi.addSecretGrant(gemini.id, 'global');
}
createTestAccount(dbApi, { email: 'acp-witness@example.test', name: 'Witness', passwordHash: 'unused' });

assert.deepEqual(config().pluginPolicy.exec.allow, [], 'the witness runs under the default policy: nothing on the operator\'s allowlist');
assert.ok((await mountOfficialProviders()).includes('provider-acp'));

const AGENTS = [
  { backend: 'opencode', args: ['acp'] },
  { backend: 'hermes', args: [] as string[] },
  { backend: 'antigravity', args: ['acp'] },
] as const;

for (const { backend } of AGENTS) {
  upsertAgent({
    name: `${backend}.witness`,
    system_prompt: 'witness — does nothing.',
    config: { backend, cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
}

type Launch = { missionId: string; cmd: string; args: string[]; env: NodeJS.ProcessEnv; piped: () => string; dispose: () => void };

/** Launches `agent` with the scripted ACP agent behind the host, recording what the daemon wrote to its stdin. */
async function launch(agent: string): Promise<Launch> {
  const host = getHost();
  const original = host.spawn;
  let child!: ChildProcessWithoutNullStreams;
  const seen: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } = { cmd: '', args: [], env: {} };
  let piped = '';
  host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    seen.cmd = cmd; seen.args = args; seen.env = (opts?.env ?? {}) as NodeJS.ProcessEnv;
    child = nodeSpawn(process.execPath, [FAKE], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    child.stderr.resume();
    const write = child.stdin.write.bind(child.stdin) as (chunk: unknown, ...rest: unknown[]) => boolean;
    child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      piped += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      return write(chunk, ...rest);
    }) as typeof child.stdin.write;
    return child;
  }) as typeof host.spawn;
  let missionId: string;
  try {
    missionId = await spawnAgent(agent, 'ping');
  } finally {
    host.spawn = original;
  }
  const deadline = Date.now() + 5000;
  while (!piped.includes('"session/new"') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return { missionId, ...seen, piped: () => piped, dispose: () => { killAgent(missionId, { source: 'test' }); child.kill('SIGKILL'); } };
}

test('opencode, Hermes, Antigravity and Pi are the release\'s own providers: official, by registration', () => {
  for (const { backend } of AGENTS) {
    assert.ok(getDialect(backend), `${backend}: the dialect is registered by the plugin`);
    assert.equal(backendTrust(backend), 'official', backend);
    assert.equal(isProductBackend(backend), true, backend);
  }
});

for (const { backend, args } of AGENTS) {
  test(`a mission on ${backend} starts the agent under the default policy with its own token and vault slice; the session carries that token and no reference`, async () => {
    const run = await launch(`${backend}.witness`);
    try {
      assert.deepEqual(run.args, args, 'the command line the agent\'s row declares');
      const token = run.env.TIMON_API_TOKEN;
      assert.ok(token && !token.startsWith('timon-seal-'), 'the mission\'s own token, in the process environment');
      assert.equal(run.env.VAULT_ACP_WITNESS, VAULT_VALUE, 'the vault slice the mission was granted');
      if (backend === 'antigravity') assert.equal(run.env.GEMINI_API_KEY, '', 'Antigravity runs on the Google sign-in, never on a Gemini API key');
      else assert.equal(run.env.GEMINI_API_KEY, 'AIza-vault-witness', `${backend}: a granted secret is untouched`);
      assert.equal(run.args.join(' ').includes(token), false, 'never in argv');

      const request = run.piped().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method?: string; params?: { mcpServers?: Array<{ name: string; env: Array<{ name: string; value: string }> }> } })
        .find((message) => message.method === 'session/new');
      assert.ok(request, 'the session was opened');
      const servers = request.params?.mcpServers ?? [];
      for (const name of ['timon', 'timon_ask']) {
        const server = servers.find((candidate) => candidate.name === name);
        assert.ok(server, `${name} is declared to the agent`);
        assert.equal(server.env.find((entry) => entry.name === 'TIMON_API_TOKEN')?.value, token, `${name} carries the mission's token`);
      }
      assert.equal(run.piped().includes('timon-seal-'), false, 'no reference reached the agent');
      assert.equal(JSON.stringify(servers).includes(VAULT_VALUE), false, 'the vault slice is the process\'s, not the session\'s');
    } finally {
      run.dispose();
    }
  });
}
