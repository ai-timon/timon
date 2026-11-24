/**
 * A profile on the claude dialect other than `claude` keeps its CLI's config in a folder of its own
 * (TODO #1104). A session it started before, in the user's `~/.claude`, is brought over once on the
 * first launch that resumes it: that one file, never anything else of the user's folder.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderContext } from '../../../packages/sdk/src/testing/index.js';
import { createClaudeProvider } from '../../official-providers/provider-claude/lib/claude.js';
import { createClaudeToken } from '../../official-providers/provider-claude/lib/token.js';
import { createClaudeUsage } from '../../official-providers/provider-claude/lib/usage.js';
import { claudeProjectSlug } from '../../official-providers/provider-claude/lib/profile-config.js';

// The user's own config folder the daemon reads, a throwaway one: the real `~/.claude` is never read.
const USER_CONFIG = realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-user-claude-')));
process.env.CLAUDE_CONFIG_DIR = USER_CONFIG;
const PROJECT = realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-claude-project-')));
process.on('exit', () => {
  rmSync(USER_CONFIG, { recursive: true, force: true });
  rmSync(PROJECT, { recursive: true, force: true });
});

// The contract the plugin's manifest declares, which `scratch.profile` needs.
const { timon: { apiVersion } } = JSON.parse(readFileSync(new URL('../../official-providers/provider-claude/package.json', import.meta.url), 'utf8')) as { timon: { apiVersion: number } };
const ctx = createProviderContext({ apiVersion });
process.on('exit', () => ctx.cleanup());
const token = createClaudeToken(ctx.provider);
ctx.provider.registerProvider(createClaudeProvider(ctx.provider, token, createClaudeUsage(ctx.provider, token)));
const dialect = ctx.registered.dialect('claude');

const KIMI = { id: 'kimi', cmd: 'claude', env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic', ANTHROPIC_AUTH_TOKEN: 'test-key' } };
const SESSION = '3f9a1c52-7e64-4d0b-9a11-0b2c8de41f77';
const SLUG = claudeProjectSlug(PROJECT);
let missions = 0;

const launch = (profile: { id: string; cmd: string; env: Record<string, string> }, resumeSession: string | null) => dialect.buildSpawn({
  agentName: 'claude.adoption', systemPrompt: 'contract', message: 'ping', resumeSession, missionId: `mission-adoption-${++missions}`,
  cfg: { cwd: PROJECT, permission_mode: 'auto', mcp_servers: [] },
} as never, profile as never);

/** Every file under `root`, relative to it. */
function filesUnder(root: string): string[] {
  let entries: string[];
  try { entries = readdirSync(root); } catch { return []; }
  return entries.flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path).map((file) => join(name, file)) : [name];
  });
}

function userSession(slug: string, name: string, content: string): string {
  const dir = join(USER_CONFIG, 'projects', slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

// What else the user's folder holds, none of which may reach the profile's.
writeFileSync(join(USER_CONFIG, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"user-subscription"}}');
writeFileSync(join(USER_CONFIG, 'settings.json'), '{"hooks":{}}');
userSession(SLUG, 'another-session.jsonl', '{"type":"user"}\n');
// A transcript may quote a launch's reference: bytes are copied as they are, never refused or swapped.
const TRANSCRIPT = '{"type":"user","message":"timon-seal-00000000000000000000000000000000"}\n';
userSession(SLUG, `${SESSION}.jsonl`, TRANSCRIPT);

test('the slug is the cwd with every character that is not a letter or a digit made a dash, as the CLI files it', () => {
  assert.equal(claudeProjectSlug('/home/me/.timon/worktrees/a_b'), '-home-me--timon-worktrees-a-b');
  assert.equal(claudeProjectSlug('C:\\Users\\me\\proj'), 'C--Users-me-proj');
  const long = `/${'a'.repeat(250)}`;
  const slug = claudeProjectSlug(long);
  assert.ok(slug.startsWith(`-${'a'.repeat(199)}-`), 'a slug over 200 characters is cut at 200, then hashed');
  assert.match(slug.slice(201), /^[0-9a-z]+$/);
  assert.equal(claudeProjectSlug(long), slug);
});

test('a launch without a session to resume copies nothing into the profile\'s folder', async () => {
  const spec = await launch(KIMI, null);
  assert.deepEqual(filesUnder(spec.env!.CLAUDE_CONFIG_DIR!), []);
});

test('the first launch that resumes a session copies that session\'s file, and only it', async () => {
  const spec = await launch(KIMI, SESSION);
  const folder = spec.env!.CLAUDE_CONFIG_DIR!;
  assert.equal(folder, ctx.provider.scratch.profile(KIMI).path);
  assert.ok(spec.args.includes('--resume'));
  const name = join('projects', SLUG, `${SESSION}.jsonl`);
  assert.deepEqual(filesUnder(folder), [name]);
  assert.equal(readFileSync(join(folder, name), 'utf8'), TRANSCRIPT);
});

test('a later launch never writes over the profile\'s own copy', async () => {
  const folder = ctx.provider.scratch.profile(KIMI).path;
  const copy = join(folder, 'projects', SLUG, `${SESSION}.jsonl`);
  writeFileSync(copy, '{"type":"assistant","note":"went on in the profile"}\n');
  userSession(SLUG, `${SESSION}.jsonl`, '{"type":"user","note":"changed in the user folder"}\n');
  await launch(KIMI, SESSION);
  assert.equal(readFileSync(copy, 'utf8'), '{"type":"assistant","note":"went on in the profile"}\n');
});

test('a session id that is not one safe name reaches nothing of the user\'s folder', async () => {
  const before = filesUnder(ctx.provider.scratch.profile(KIMI).path);
  for (const hostile of ['../../.credentials', '..', `${SESSION}/../../settings`, '.credentials']) {
    await launch(KIMI, hostile);
  }
  assert.deepEqual(filesUnder(ctx.provider.scratch.profile(KIMI).path), before);
});

test('a session file that is a link is not followed', { skip: process.platform === 'win32' && 'symbolic links need a privilege on Windows' }, async () => {
  const linked = 'aaaaaaaa-1111-2222-3333-444444444444';
  symlinkSync(join(USER_CONFIG, '.credentials.json'), join(USER_CONFIG, 'projects', SLUG, `${linked}.jsonl`));
  await launch(KIMI, linked);
  const folder = ctx.provider.scratch.profile(KIMI).path;
  assert.ok(!filesUnder(folder).some((file) => file.includes(linked)), 'the link was followed');
});

test('a missing session leaves the launch alone: the CLI starts a fresh one', async () => {
  const spec = await launch({ id: 'user-claude', cmd: 'claude', env: {} }, 'bbbbbbbb-1111-2222-3333-444444444444');
  assert.deepEqual(filesUnder(spec.env!.CLAUDE_CONFIG_DIR!), []);
});

test('the `claude` profile adopts nothing: its config folder is the user\'s own', async () => {
  const spec = await launch({ id: 'claude', cmd: 'claude', env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } }, SESSION);
  assert.equal(spec.env?.CLAUDE_CONFIG_DIR, undefined);
});
