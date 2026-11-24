import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProviderContext, defineConformanceTests, dialectConformance } from '../../../packages/sdk/src/testing/index.js';
import { createClaudeProvider } from '../../official-providers/provider-claude/lib/claude.js';
import { createClaudeToken } from '../../official-providers/provider-claude/lib/token.js';
import { createClaudeUsage } from '../../official-providers/provider-claude/lib/usage.js';
import { apply } from '../../official-providers/provider-kimi/lib/index.js';
// The contract the plugin's manifest declares, which `scratch.profile` needs.
const { timon: { apiVersion } } = JSON.parse((await import('node:fs')).readFileSync(new URL('../../official-providers/provider-claude/package.json', import.meta.url), 'utf8')) as { timon: { apiVersion: number } };
const ctx = createProviderContext({ apiVersion });
const token = createClaudeToken(ctx.provider);
ctx.provider.registerProvider(createClaudeProvider(ctx.provider, token, createClaudeUsage(ctx.provider, token)));
apply(ctx);
const env = { ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic', ANTHROPIC_AUTH_TOKEN: 'test-key' };
const dialect = ctx.registered.dialect('claude');
const scratch = await ctx.provider.scratch.mission({ missionId: 'mission-contract-0001' } as never);
process.on('exit', () => ctx.cleanup());
defineConformanceTests(test, dialectConformance(dialect, { id: 'kimi', cmd: 'claude', env }, {
 transcript: readFileSync(join(import.meta.dirname, '../backends/__fixtures__/claude.jsonl'), 'utf8'),
 sessionId: '3f9a1c52-7e64-4d0b-9a11-0b2c8de41f77', cmd: 'claude', model: 'kimi-k3',
}, { cwd: scratch.path, scratchDirs: [scratch.path] }), '[Kimi plugin]');
test('Kimi preserves its profile id, fallback rank, key reference and credential directory', () => {
  const profile = ctx.registered.productProfiles.find((p) => p.id === 'kimi')!;
  assert.equal(profile.dialect, 'claude');
  assert.equal(profile.fallbackRank, 40);
  assert.deepEqual(profile.credentialDirs, ['.kimi']);
  assert.deepEqual(profile.env.ANTHROPIC_AUTH_TOKEN, { secret: 'KIMI_API_KEY' });
});

/** A launch of `profile` the way the daemon asks for one, in `mission`. */
const spawnOf = (profile: { id: string; cmd: string; env: Record<string, string> }, mission: string, resumeSession: string | null = null) => dialect.buildSpawn({
  agentName: 'kimi.contract', systemPrompt: 'contract', message: 'ping', resumeSession, missionId: mission,
  cfg: { cwd: scratch.path, permission_mode: 'auto', mcp_servers: [] },
} as never, profile as never);

test('#1104: Kimi\'s claude CLI keeps its config in the profile\'s own folder, the same across missions, never ~/.claude', async () => {
  const kimi = { id: 'kimi', cmd: 'claude', env };
  const first = await spawnOf(kimi, 'mission-kimi-config-1');
  const second = await spawnOf(kimi, 'mission-kimi-config-2');
  const folder = ctx.provider.scratch.profile(kimi).path;
  assert.equal(first.env?.CLAUDE_CONFIG_DIR, folder);
  assert.equal(second.env?.CLAUDE_CONFIG_DIR, folder, 'a new mission must find the sessions of the previous one');
  assert.equal(first.env?.ANTHROPIC_AUTH_TOKEN, 'test-key', 'the profile\'s own credentials still reach the CLI');
  assert.equal(first.env?.ANTHROPIC_BASE_URL, env.ANTHROPIC_BASE_URL);
  assert.ok(!folder.includes(`${join('', '.claude')}`), `${folder} is the user's Claude folder`);
});

test('#1104: a user\'s file on the claude dialect gets a folder of its own, even with no environment', async () => {
  const spec = await spawnOf({ id: 'user-claude', cmd: 'claude', env: {} }, 'mission-user-claude-1');
  const folder = ctx.provider.scratch.profile({ id: 'user-claude', cmd: 'claude', env: {} }).path;
  assert.equal(spec.env?.CLAUDE_CONFIG_DIR, folder);
  assert.notEqual(folder, ctx.provider.scratch.profile({ id: 'kimi', cmd: 'claude', env }).path, 'two profiles share one folder');
});
