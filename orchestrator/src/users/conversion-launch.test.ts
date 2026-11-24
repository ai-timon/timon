/**
 * The conversion mission of a browser recording is LAUNCHED without a shell and without file
 * writes (TODO #469), whatever its agent's own settings: real registry, the official providers
 * mounted the way the loader mounts them, a real `spawnAgent` with a recording host. A backend
 * that cannot launch that way never starts a process; an ordinary mission of the same agent keeps
 * its tools.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const AUTH = mkdtempSync(join(tmpdir(), 'timon-conversion-auth-'));
writeFileSync(join(AUTH, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.env.CODEX_AUTH_DIR = AUTH;
// The profiles exist only when their CLI is found: stand-in files, nothing here executes them.
const BIN = mkdtempSync(join(tmpdir(), 'timon-conversion-bin-'));
for (const name of ['claude', 'codex', 'grok']) writeFileSync(join(BIN, process.platform === 'win32' ? `${name}.cmd` : name), '', { mode: 0o755 });
process.env.PATH = `${BIN}${delimiter}${process.env.PATH ?? ''}`;
// A project indexed by grepai: its index serves file contents.
const PROJECT = mkdtempSync(join(tmpdir(), 'timon-conversion-project-'));
mkdirSync(join(PROJECT, '.grepai'));
process.on('exit', () => {
  for (const dir of [BIN, AUTH, PROJECT]) rmSync(dir, { recursive: true, force: true });
});

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
const { sbplString } = await import('../host/seatbelt.js');
const { getHost } = await import('../host/index.js');
const { spawnAgent, upsertAgent } = await import('../agent.js');
const { dbApi } = await import('../db.js');
const { CONVERSION_BACKEND_REFUSAL, conversionAgentRefusal } = await import('./conversion-mission.js');
const { refreshToolsCacheFromInit } = await import('../mcp.js');

// Two account connectors claude reported, the notes connector among them (the one kept for every task mission).
refreshToolsCacheFromInit({ tools: [], mcp_servers: [{ name: 'claude.ai Notes', status: 'connected' }, { name: 'claude.ai Gmail', status: 'connected' }] });

createTestAccount(dbApi, { email: 'conversion-launch@example.test', name: 'Owner', passwordHash: 'unused' });
await mountOfficialProviders();

// The settings a conversion must override: a mode that asks nothing, grants that name a shell.
for (const backend of ['claude', 'codex', 'grok']) {
  upsertAgent({
    name: `${backend}.learner`,
    system_prompt: 'learner — does nothing.',
    config: { backend, cwd: PROJECT, skills: [], memory_scope: 'NONE', permission_mode: 'bypassPermissions', allowed_tools: ['Bash', 'Write'] },
  });
}

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4247;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.emit('exit', 0, signal ?? null);
    child.emit('close', 0, signal ?? null);
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

const CONVERSION = { channel: 'chat', meta: { browser_recording_id: 'br-00000000-0000-4000-8000-000000000469' } };

async function launch(agent: string, source?: { channel: string; meta?: unknown }): Promise<{ spawned: boolean; args: string[]; missionId: string; policy: string | null; error?: Error }> {
  const host = getHost();
  const original = host.spawn;
  const child = fakeChild();
  const seen = { spawned: false, args: [] as string[], missionId: randomUUID(), policy: null as string | null };
  host.spawn = ((_cmd: string, args: string[]) => {
    seen.spawned = true; seen.args = args;
    // A Seatbelt launch (`-f <policy> -- cli …`): its policy file is gone once the mission ends.
    if (args[0] === '-f' && args[1]) seen.policy = readFileSync(args[1], 'utf8');
    return child;
  }) as typeof host.spawn;
  try {
    await spawnAgent(agent, 'ping', source, { missionId: seen.missionId });
    return seen;
  } catch (error) {
    return { ...seen, error: error as Error };
  } finally {
    host.spawn = original;
    if (!child.killed) child.kill();
  }
}

test('a claude conversion offers no built-in tool, no file reader included, its agent\'s grants and mode notwithstanding', async () => {
  const run = await launch('claude.learner', CONVERSION);
  assert.equal(run.error, undefined);
  assert.ok(run.spawned);
  assert.ok(run.args.includes('--tools='));
  assert.equal(run.args.some((arg) => /^--tools(=.+)?$/.test(arg) && arg !== '--tools='), false);
  assert.ok(run.args.includes('--strict-mcp-config'));
});

/** The comma-separated values of an option that takes a list (`--disallowedTools a,b`). */
function listArg(args: string[], flag: string): string[] {
  const at = args.indexOf(flag);
  return at < 0 ? [] : (args[at + 1] ?? '').split(',');
}

test('a claude conversion is handed no account connector, the notes connector included, and no project index', async () => {
  const run = await launch('claude.learner', CONVERSION);
  assert.equal(run.error, undefined);
  const disallowed = listArg(run.args, '--disallowedTools');
  assert.ok(disallowed.includes('mcp__claude_ai_Notes__*'), disallowed.join(','));
  assert.ok(disallowed.includes('mcp__claude_ai_Gmail__*'));
  const servers = Object.keys((JSON.parse(run.args[run.args.indexOf('--mcp-config') + 1]!) as { mcpServers: object }).mcpServers);
  assert.equal(servers.includes('grepai'), false, servers.join(','));
  assert.ok(servers.includes('timon'));
});

test('a codex conversion runs in a read-only sandbox with its shell switched off', async () => {
  const run = await launch('codex.learner', CONVERSION);
  assert.equal(run.error, undefined);
  assert.ok(run.spawned);
  const level = run.args[run.args.indexOf('--sandbox') + 1];
  if (run.policy !== null) {
    // Under the Seatbelt fence (macOS) codex's own sandbox cannot start: it is
    // switched off, and the fence keeps the working tree read-only instead.
    assert.equal(level, 'danger-full-access');
    const spellings = [PROJECT, realpathSync(PROJECT)].map(sbplString);
    const policy = run.policy;
    assert.ok(spellings.some((p) => policy.includes(`(deny file-write* (subpath ${p}))`)), 'the fence denies writes to the project');
    assert.ok(!spellings.some((p) => policy.includes(`(allow file-read-data file-write* (subpath ${p}))`)), 'and grants none');
  } else {
    assert.equal(level, 'read-only');
  }
  const disabled = run.args.flatMap((arg, i) => (arg === '--disable' ? [run.args[i + 1]] : []));
  assert.deepEqual(disabled, ['shell_tool', 'unified_exec', 'view_image', 'apps', 'plugins', 'image_generation']);
  assert.ok(run.args.includes('web_search=disabled'));
});

test('a backend that cannot drop its shell never starts a conversion process', async () => {
  const run = await launch('grok.learner', CONVERSION);
  assert.equal(run.spawned, false);
  assert.match(run.error?.message ?? '', /cannot run a recording conversion safely/);
  assert.equal(dbApi.getMission(run.missionId)?.status, 'failed');
});

test('an ordinary mission of the same agents keeps its own tools', async () => {
  const claude = await launch('claude.learner');
  assert.equal(claude.args.some((arg) => arg.startsWith('--tools')), false);
  assert.equal(claude.args.includes('--strict-mcp-config'), false);
  const codex = await launch('codex.learner');
  assert.equal(codex.args.includes('--disable'), false);
  assert.equal(codex.args[codex.args.indexOf('--sandbox') + 1], 'danger-full-access');
  const grok = await launch('grok.learner');
  assert.equal(grok.error, undefined);
  assert.ok(grok.spawned);
});

test('an ordinary mission keeps the account connectors and the project index', async () => {
  const run = await launch('claude.learner');
  assert.equal(listArg(run.args, '--disallowedTools').some((rule) => rule.startsWith('mcp__claude_ai_')), false);
  const servers = Object.keys((JSON.parse(run.args[run.args.indexOf('--mcp-config') + 1]!) as { mcpServers: object }).mcpServers);
  assert.ok(servers.includes('grepai'));
});

test('Learn asks the same question of an agent before spawning anything', () => {
  assert.equal(conversionAgentRefusal('claude.learner'), null);
  assert.equal(conversionAgentRefusal('codex.learner'), null);
  assert.equal(conversionAgentRefusal('grok.learner'), CONVERSION_BACKEND_REFUSAL);
});
