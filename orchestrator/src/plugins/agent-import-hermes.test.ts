/**
 * The Hermes direct source of the agent import (plugins/agent-import, built
 * `lib/index.js`): the daemon finds the roots itself (never a path from a
 * request, never `HERMES_HOME`), reads each profile through the folder reader,
 * reads the `.env` for its NAMES only, and turns it all into a
 * `timon-agent-import` v1 manifest — on a fake Hermes tree under a temporary
 * HOME, then through the real routes, preview and apply.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import { createPluginContext, daemonHost, type PluginContext } from './context.js';
import { readManifest } from './manifest.js';
import { createHttpPlugin } from '../kernel/http-service.js';
import { createBodyParser } from '../kernel/body-parser.js';
import { dbApi } from '../db.js';
import { getAgent, readDoc, upsertAgent } from '../agent.js';
import { mountOfficialProviders } from '../../tests/helpers/official-providers.js';
import { forgeZip } from '../../../plugins/agent-import/test/zip-writer.js';

await mountOfficialProviders();

type Json = Record<string, unknown>;
type Platform = { platform: NodeJS.Platform; env: Record<string, string | undefined>; home: string };
type Installation = { root: string; label: string; profiles: Array<{ name: string; root: string }> };
type SourceTree = { files: Map<string, Uint8Array>; skipped: Array<{ path: string; reason: string }>; notices: unknown[]; totalBytes: number };
type ProfileInput = { name: string; tree: SourceTree; envNames: string[]; hasHistory: boolean };
type ManifestAgent = Json & {
  key: string; displayName: string; sourceRef: string; soul?: string | null;
  memories?: Array<{ text: string; kind: string }>;
  skills?: Array<{ id: string; content: string; companionFiles?: string[]; hasCode?: boolean }>;
  routines?: Array<{ name: string; instruction: string; schedule: Json; timezone?: string | null; enabledInSource: boolean }>;
  mcpServers?: Array<{ name: string; transport: string; url?: string; command?: string; args?: string[]; secretNames?: string[] }>;
  hints?: { model?: string; deliveries?: string[]; secretNames?: string[]; hasHistory?: boolean };
};
type Manifest = { source: { app: string }; agents: ManifestAgent[]; warnings?: string[] };

const pkg = (await import('../../../plugins/agent-import/package.json', { with: { type: 'json' } })).default as { timon: unknown };
const lib = await import('../../../plugins/agent-import/lib/index.js') as unknown as {
  apply(ctx: PluginContext): void;
  hermesRootCandidate(host: Platform): { root: string; label: string } | null;
  detectHermes(host?: Platform): Promise<Installation | null>;
  parseEnvNames(bytes: Uint8Array): { names: string[]; truncated: boolean };
  readEnvNames(root: string): Promise<{ names: string[]; skipped: string | null; truncated: boolean }>;
  readHermesManifest(installation: Installation, names?: string[]): Promise<Manifest>;
  hermesToManifest(profiles: ProfileInput[]): Manifest;
  hermesSchedule(value: unknown): Json | null;
  soulText(raw: string): string | null;
  memoryEntries(raw: string): string[];
  redactArgs(args: string[], secrets: Set<string>): string[];
  sanitizeUrl(raw: string, secrets: Set<string>): string | null;
  ENV_NAMES_MAX: number;
  ENV_FILE_MAX_BYTES: number;
};

/** Values that must never leave the `.env` or the MCP settings. */
const SECRETS = ['sk-live-0123456789', 'ghp_supersecretvalue', 'hunter2-password', 'xoxb-slack-value', 'Bearer abc.def', 'query-secret-value', 'ENVRC-VALUE'];

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** Where Hermes keeps its root under a home on this host: `~/.hermes`, or the profile's local app data on Windows. */
const WINDOWS = process.platform === 'win32';
const hermesDir = (home: string): string => (WINDOWS ? join(home, 'AppData', 'Local', 'hermes') : join(home, '.hermes'));
const HERMES_LABEL = WINDOWS ? '%USERPROFILE%\\AppData\\Local\\hermes' : '~/.hermes';

/** A fake HOME with `~/.hermes`: the default profile, two named ones, and what must be ignored. */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'agent-import-hermes-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const hermes = hermesDir(home);
  write(hermes, {
    'SOUL.md': '<!-- Hermes template: edit me -->\n# Hermes\n\nI am the house assistant.\r\nI answer briefly.\n<!-- trailing\nnote -->\n',
    'memories/USER.md': 'Prefers French.\n§\nWorks at night.\n§\n\n',
    'memories/MEMORY.md': 'The NAS is at home.\n§\nUse pnpm.',
    '.env': `OPENAI_API_KEY=${SECRETS[0]}\n# comment=not-a-name\nexport GITHUB_TOKEN="${SECRETS[1]}"\n  SPACED_NAME = ${SECRETS[2]}\nnot a line\nMULTI="line one\nline two"\n`,
    '.envrc': `export ENVRC=${SECRETS[6]}`,
    'auth.json': `{"token":"${SECRETS[0]}"}`,
    'state.db': 'sqlite',
    'config.yaml': [
      'timezone: Europe/Paris',
      'model:',
      '  provider: openrouter',
      '  default: anthropic/claude-sonnet',
      `  api_key: ${SECRETS[0]}`,
      'mcp_servers:',
      '  notion:',
      `    url: https://mcp.notion.com/mcp?api_key=${SECRETS[5]}&workspace=me`,
      '    headers:',
      `      Authorization: ${SECRETS[4]}`,
      '  github:',
      '    command: npx',
      `    args: ["-y", "@modelcontextprotocol/server-github", "--token", "${SECRETS[1]}", "--api-key=${SECRETS[0]}", "${SECRETS[3]}"]`,
      '    env:',
      `      GITHUB_PERSONAL_ACCESS_TOKEN: ${SECRETS[1]}`,
      '  local:',
      '    url: http://127.0.0.1:9000/mcp',
      '  off:',
      '    url: https://mcp.example.com/off',
      '    enabled: false',
      '',
    ].join('\n'),
    'cron/jobs.json': JSON.stringify({
      jobs: [
        { id: 'a1', name: 'Morning brief', prompt: 'Brief me.', schedule: { kind: 'cron', expr: '30 8 * * 1-5', display: '30 8 * * 1-5' }, enabled: true, deliver: 'telegram:123,local' },
        { id: 'a2', name: 'Every hour', prompt: 'Check the inbox.', schedule: { kind: 'interval', minutes: 60 }, enabled: false, state: 'paused', deliver: 'origin', origin: { platform: 'discord' } },
        { id: 'a3', name: 'One shot', prompt: 'Remind me.', schedule: { kind: 'once', run_at: '2026-12-01T09:00:00.123456+01:00' }, enabled: true },
        { id: 'a4', name: 'Legacy', prompt: 'Old job.', schedule: 'every 2h', enabled: true, skills: ['arxiv'] },
        { id: 'a5', name: 'Script job', prompt: 'x', script: 'collect.py', schedule: { kind: 'interval', minutes: 30 }, enabled: true },
        { id: 'a6', name: 'Raw script', no_agent: true, script: 'beep.sh', schedule: { kind: 'interval', minutes: 30 }, enabled: true },
        { id: 'a7', name: 'Unreadable', prompt: 'x', schedule: { kind: 'lunar' }, enabled: true },
      ],
    }),
    'skills/.bundled_manifest': 'arxiv:abc123\nairtable:def456\n',
    'skills/research/arxiv/SKILL.md': '---\nname: arxiv\n---\nBundled.',
    'skills/research/DESCRIPTION.md': 'Category.',
    'skills/research/brief/SKILL.md': '---\nname: brief\n---\n\nWrite a brief.\n',
    'skills/notes/SKILL.md': '---\nname: notes\nallowed-tools: Bash\n---\n\nTake notes.\n',
    'skills/tooling/runner/SKILL.md': '---\nname: runner\n---\nRun it.',
    'skills/tooling/runner/scripts/run.py': 'print(1)',
    'skills/.curator_state/x/SKILL.md': 'hidden',
    'sessions/s1.jsonl': '{}',
    'profiles/coder/SOUL.md': '# Coder\n\n<!-- nothing else -->\n',
    'profiles/coder/config.yaml': 'model: gpt-5\n',
    'profiles/coder/memories/MEMORY.md': 'Run the tests first.',
    'profiles/my_profile/config.yaml': 'timezone: "../../etc"\n',
    'profiles/gone/config.yaml': 'x: 1\n',
    'profiles/.deleted/gone/config.yaml': 'x: 1\n',
    'profiles/stray/cache.txt': 'not a profile',
    'profiles/Bad/config.yaml': 'x: 1\n',
  });
  return home;
}

/** This host, with no environment: Windows then falls back on the profile folder. */
const onHost = (home: string): Platform => ({ platform: process.platform, env: {}, home });

/** The daemon reads the home of the account: HOME, or USERPROFILE and LOCALAPPDATA on Windows. */
function useHome(home: string): void {
  const names = ['HOME', 'USERPROFILE', 'LOCALAPPDATA'] as const;
  const before = names.map((name) => process.env[name]);
  process.env.HOME = home;
  if (WINDOWS) { process.env.USERPROFILE = home; delete process.env.LOCALAPPDATA; }
  cleanup.push(() => names.forEach((name, i) => { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; }));
}

const noSecret = (text: string, label: string): void => {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${label} carries a secret value (${secret.slice(0, 6)}…)`);
};

/* ── Roots ──────────────────────────────────────────────────────────────── */

test('the root is the platform default Hermes uses, never HERMES_HOME', () => {
  const hermesHome = { HERMES_HOME: '/srv/elsewhere' };
  assert.deepEqual(lib.hermesRootCandidate({ platform: 'linux', env: hermesHome, home: '/home/ada' }), { root: '/home/ada/.hermes', label: '~/.hermes' });
  assert.deepEqual(lib.hermesRootCandidate({ platform: 'darwin', env: hermesHome, home: '/Users/ada' }), { root: '/Users/ada/.hermes', label: '~/.hermes' });
  assert.deepEqual(
    lib.hermesRootCandidate({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local', ...hermesHome }, home: 'C:\\Users\\ada' }),
    { root: 'C:\\Users\\ada\\AppData\\Local\\hermes', label: '%LOCALAPPDATA%\\hermes' },
  );
  // A service started without LOCALAPPDATA, or with a relative one, falls back on the profile folder.
  for (const env of [{}, { LOCALAPPDATA: 'relative\\dir' }, { LOCALAPPDATA: '  ' }]) {
    assert.equal(lib.hermesRootCandidate({ platform: 'win32', env, home: 'C:\\Users\\ada' })?.root, 'C:\\Users\\ada\\AppData\\Local\\hermes');
  }
  assert.equal(lib.hermesRootCandidate({ platform: 'linux', env: {}, home: '' }), null);
  assert.equal(lib.hermesRootCandidate({ platform: 'linux', env: {}, home: 'relative' }), null);
});

test('profiles: default and the named ones, never a deleted, stray, linked or misnamed folder', async () => {
  const home = fakeHome();
  const hermes = hermesDir(home);
  const outside = mkdtempSync(join(tmpdir(), 'agent-import-hermes-out-'));
  cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
  write(outside, { 'config.yaml': 'x: 1\n' });
  symlinkSync(outside, join(hermes, 'profiles', 'linked'), 'dir');

  const found = await lib.detectHermes(onHost(home));
  assert.ok(found);
  assert.equal(found.root, hermes);
  assert.equal(found.label, HERMES_LABEL);
  assert.deepEqual(found.profiles.map((p) => p.name), ['default', 'coder', 'my_profile']);
  assert.deepEqual(found.profiles.map((p) => p.root), [hermes, join(hermes, 'profiles', 'coder'), join(hermes, 'profiles', 'my_profile')]);

  assert.equal(await lib.detectHermes(onHost(mkdtempSync(join(tmpdir(), 'agent-import-nohermes-')))), null, 'no ~/.hermes, nothing');
  // A Windows root on this machine does not exist: nothing found, nothing thrown.
  assert.equal(await lib.detectHermes({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Nope' }, home: 'C:\\Users\\x' }), null);
});

/* ── .env: names only ───────────────────────────────────────────────────── */

test('.env names are read byte by byte; no value ever becomes a string', () => {
  const text = `\uFEFFA=1\nexport B_2="${SECRETS[0]}"\n  C = x\n#D=commented\n9BAD=x\nE\nexportF=1\nA=again\r\nG=${SECRETS[1]}`;
  const out = lib.parseEnvNames(new TextEncoder().encode(text));
  assert.deepEqual(out, { names: ['A', 'B_2', 'C', 'exportF', 'G'], truncated: false });
  noSecret(JSON.stringify(out), 'parseEnvNames');
  const many = Array.from({ length: lib.ENV_NAMES_MAX + 5 }, (_, i) => `K${i}=v`).join('\n');
  const capped = lib.parseEnvNames(new TextEncoder().encode(many));
  assert.equal(capped.names.length, lib.ENV_NAMES_MAX);
  assert.equal(capped.truncated, true);
});

test('.env is refused when it is a link, a hard link, a folder or too large', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-import-env-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const outside = join(dir, 'outside.txt');
  writeFileSync(outside, `STOLEN=${SECRETS[0]}`);
  const cases: Array<[string, (root: string) => void, string | null, string[]]> = [
    ['absent', () => {}, null, []],
    ['plain', (root) => writeFileSync(join(root, '.env'), `KEY=${SECRETS[2]}\n`), null, ['KEY']],
    ['symlink', (root) => symlinkSync(outside, join(root, '.env')), 'link', []],
    ['hard link', (root) => linkSync(outside, join(root, '.env')), 'hard-link', []],
    ['folder', (root) => mkdirSync(join(root, '.env')), 'special', []],
    ['too large', (root) => writeFileSync(join(root, '.env'), 'A=1\n'.repeat(lib.ENV_FILE_MAX_BYTES / 4 + 1)), 'too-large', []],
  ];
  for (const [label, make, skipped, names] of cases) {
    const root = join(dir, label.replace(' ', '-'));
    mkdirSync(root);
    make(root);
    const out = await lib.readEnvNames(root);
    assert.equal(out.skipped, skipped, label);
    assert.deepEqual(out.names, names, label);
    noSecret(JSON.stringify(out), label);
  }
});

/* ── The manifest ───────────────────────────────────────────────────────── */

test('a Hermes tree becomes one agent per profile, with secrets reduced to names', async () => {
  const home = fakeHome();
  const logged: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  }
  let manifest: Manifest;
  try {
    const found = await lib.detectHermes(onHost(home));
    assert.ok(found);
    manifest = await lib.readHermesManifest(found);
  } finally {
    Object.assign(console, original);
  }
  noSecret(JSON.stringify(manifest), 'the manifest');
  noSecret(logged.join('\n'), 'the logs');
  assert.ok(!JSON.stringify(manifest).includes(home), 'no path of the daemon in the manifest');

  assert.equal(manifest.source.app, 'hermes');
  assert.deepEqual(manifest.agents.map((a) => [a.key, a.displayName, a.sourceRef]), [
    ['default', 'Hermes', 'profile:default'],
    ['coder', 'coder', 'profile:coder'],
    ['my-profile', 'my_profile', 'profile:my_profile'],
  ]);
  const [hermes, coder, mine] = manifest.agents as [ManifestAgent, ManifestAgent, ManifestAgent];

  // SOUL.md without its comments; a title alone is empty.
  assert.equal(hermes.soul, '# Hermes\n\nI am the house assistant.\nI answer briefly.');
  assert.equal(coder.soul, null);

  // § entries: USER.md → preference, MEMORY.md → decision.
  assert.deepEqual(hermes.memories, [
    { text: 'Prefers French.', kind: 'preference' },
    { text: 'Works at night.', kind: 'preference' },
    { text: 'The NAS is at home.', kind: 'decision' },
    { text: 'Use pnpm.', kind: 'decision' },
  ]);
  assert.deepEqual(coder.memories, [{ text: 'Run the tests first.', kind: 'decision' }]);

  // Skills: bundled and hidden ones left out; one with a script flagged (the engine skips it).
  assert.deepEqual(hermes.skills?.map((s) => [s.id, s.companionFiles ?? [], s.hasCode ?? false]), [
    ['notes', [], false],
    ['brief', [], false],
    ['runner', ['scripts/run.py'], true],
  ]);
  assert.ok(manifest.warnings?.some((w) => w.includes('1 skills shipped with Hermes')));

  // Jobs: every stored shape, script jobs skipped with a reason, the state of the source kept.
  assert.deepEqual(hermes.routines?.map((r) => [r.name, r.schedule, r.timezone, r.enabledInSource]), [
    ['Morning brief', { kind: 'cron', expression: '30 8 * * 1-5' }, 'Europe/Paris', true],
    ['Every hour', { kind: 'interval', minutes: 60 }, 'Europe/Paris', false],
    ['One shot', { kind: 'once', at: '2026-12-01T08:00:00.123Z' }, 'Europe/Paris', true],
    ['Legacy', { kind: 'interval', minutes: 120 }, 'Europe/Paris', true],
  ]);
  for (const name of ['Script job', 'Raw script']) {
    assert.ok(manifest.warnings?.some((w) => w.includes(`"${name}" runs a script`)), name);
  }
  assert.ok(manifest.warnings?.some((w) => w.includes('"Unreadable" has a schedule')));
  assert.ok(manifest.warnings?.some((w) => w.includes('"Legacy" preloads skills')));

  // MCP: http kept without its secret query, stdio with its command redacted, off ones dropped.
  const servers = hermes.mcpServers ?? [];
  assert.deepEqual(servers.map((s) => [s.name, s.transport]), [['notion', 'http'], ['github', 'stdio'], ['local', 'http']]);
  assert.equal(servers[0]!.url, 'https://mcp.notion.com/mcp?workspace=me');
  assert.deepEqual(servers[0]!.secretNames?.sort(), ['Authorization', 'api_key']);
  assert.deepEqual(servers[1]!.args, ['-y', '@modelcontextprotocol/server-github', '--token', '<redacted>', '--api-key=<redacted>', '<redacted>']);
  assert.ok(servers[1]!.secretNames?.includes('GITHUB_PERSONAL_ACCESS_TOKEN'));
  assert.ok(manifest.warnings?.some((w) => w.includes('MCP server off is turned off')));

  // Hints: model as a label, deliveries, .env names, history.
  assert.equal(hermes.hints?.model, 'openrouter/anthropic/claude-sonnet');
  assert.deepEqual(hermes.hints?.deliveries, ['telegram', 'discord']);
  assert.deepEqual(hermes.hints?.secretNames, ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'SPACED_NAME', 'MULTI']);
  assert.equal(hermes.hints?.hasHistory, true);
  assert.equal(coder.hints?.model, 'gpt-5');
  assert.equal(coder.hints?.hasHistory, undefined);
  // A time zone that is not an IANA name is dropped, not passed on.
  assert.equal(mine.routines, undefined);
  assert.equal(mine.hints, undefined);
});

test('one profile can be read alone; an unreadable config or job file is a warning, not a failure', async () => {
  const home = fakeHome();
  write(join(hermesDir(home), 'profiles', 'coder'), {
    'config.yaml': `mcp_servers: [unclosed\n  secret: ${SECRETS[0]}\n`,
    'cron/jobs.json': `{"jobs": [${SECRETS[2]}`,
  });
  const found = await lib.detectHermes(onHost(home));
  assert.ok(found);
  const manifest = await lib.readHermesManifest(found, ['coder']);
  assert.deepEqual(manifest.agents.map((a) => a.key), ['coder']);
  assert.ok(manifest.warnings?.some((w) => w.includes('config.yaml could not be read')));
  assert.ok(manifest.warnings?.some((w) => w.includes('cron/jobs.json could not be read')));
  noSecret(JSON.stringify(manifest), 'a parser error');
});

test('small rules: SOUL comments, § entries, string schedules, URL and argument redaction', () => {
  assert.equal(lib.soulText('<!-- only a comment -->'), null);
  assert.equal(lib.soulText('# Title\n\n## Sub\n'), null);
  assert.equal(lib.soulText('# Title\n\nBody'), '# Title\n\nBody');
  assert.equal(lib.soulText('Text <!-- unterminated'), 'Text');
  assert.deepEqual(lib.memoryEntries('§ a §§ b\n§'), ['a', 'b']);

  assert.deepEqual(lib.hermesSchedule('0 9 * * *'), { kind: 'cron', expression: '0 9 * * *' });
  assert.deepEqual(lib.hermesSchedule('30m'), { kind: 'interval', minutes: 30 });
  assert.deepEqual(lib.hermesSchedule('every 1d'), { kind: 'interval', minutes: 1440 });
  assert.deepEqual(lib.hermesSchedule('2026-02-03T14:00:00Z'), { kind: 'once', at: '2026-02-03T14:00:00.000Z' });
  assert.equal(lib.hermesSchedule('2026-02-03T14:00:00'), null, 'a naive time is in an unknown zone');
  assert.equal(lib.hermesSchedule('whenever'), null);
  assert.equal(lib.hermesSchedule({ kind: 'interval', minutes: 0 }), null);

  const secrets = new Set<string>();
  assert.equal(lib.sanitizeUrl('https://user:pass@mcp.example.com/x?token=t&mode=1', secrets), 'https://mcp.example.com/x?mode=1');
  assert.deepEqual([...secrets].sort(), ['URL credentials', 'token']);
  assert.deepEqual(
    lib.redactArgs(['--password', 'p', '--verbose', 'API_KEY=x', 'PORT=3', 'https://h.example.com/?sig=1', 'ghp_x'], new Set()),
    ['--password', '<redacted>', '--verbose', 'API_KEY=<redacted>', 'PORT=3', 'https://h.example.com/', '<redacted>'],
  );
});

test('a credential written in the path of an MCP address is masked, its name listed', () => {
  const secrets = new Set<string>();
  const clean = lib.sanitizeUrl('https://mcp.example.com/sk-live1234567890/mcp?mode=1', secrets);
  assert.ok(clean && !clean.includes('sk-live'), String(clean));
  assert.equal(new URL(clean!).pathname, '/%3Credacted%3E/mcp');
  assert.equal(new URL(clean!).search, '?mode=1');
  assert.deepEqual([...secrets], ['URL path token']);
  // Encoded, it is found all the same; an ordinary path is left alone.
  assert.ok(!lib.sanitizeUrl('https://h.example.com/ghp%5Fabc/x', new Set())!.includes('abc'));
  const plain = new Set<string>();
  assert.equal(lib.sanitizeUrl('https://h.example.com/v1/sse', plain), 'https://h.example.com/v1/sse');
  assert.equal(plain.size, 0);
  // And on a command line, an address among the arguments.
  assert.deepEqual(lib.redactArgs(['--url', 'https://h.example.com/xoxb-123/rpc'], new Set()), ['--url', 'https://h.example.com/%3Credacted%3E/rpc']);
});

test('known limit: a secret with no telling flag, name or prefix is not recognised', () => {
  // Documented in plugins/agent-import/README.md: the masking reads names and
  // well-known prefixes, it does not guess. Should this test start failing
  // because such a value is now masked, update the README with it.
  const secrets = new Set<string>();
  assert.deepEqual(
    lib.redactArgs(['serve', 'a1b2c3d4e5f6g7h8', '--workspace', 'q9w8e7r6t5y4'], secrets),
    ['serve', 'a1b2c3d4e5f6g7h8', '--workspace', 'q9w8e7r6t5y4'],
  );
  assert.equal(secrets.size, 0);
});

/* ── Routes ─────────────────────────────────────────────────────────────── */

async function loaded(): Promise<string> {
  const root = new Context();
  const app = express();
  app.use((req, _res, next) => {
    const user = dbApi.getUserById(String(req.headers['x-test-user'] ?? ''));
    if (user) req.auth = { kind: 'session', user, isSuperadmin: user.is_superadmin };
    next();
  });
  app.use(createBodyParser());
  await root.plugin(createHttpPlugin(app));
  let inner!: Context;
  await root.plugin({ name: 'holder', apply(ctx: Context) { inner = ctx; } });
  const manifest = readManifest(pkg);
  assert.ok(manifest.ok, manifest.ok ? '' : manifest.message);
  lib.apply(createPluginContext(inner, { manifest: manifest.manifest, version: '0.1.0' }, daemonHost(root)));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  cleanup.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await root.fiber.dispose();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/plugins/agent-import`;
}

function account(name: string, permissions: string[]): string {
  const id = randomUUID();
  createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused', status: 'active' });
  grantTestPermissions(dbApi, id, ['plugin:agent-import', ...permissions]);
  return id;
}

async function call(base: string, method: 'GET' | 'POST', route: string, user: string | null, body?: unknown): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (user) headers['x-test-user'] = user;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Json : {} };
}

test('the Hermes routes refuse an anonymous caller and an account that may not create agents', async () => {
  useHome(fakeHome());
  const base = await loaded();
  const reader = account('reader', []);
  for (const [method, route] of [['GET', 'hermes'], ['POST', 'hermes/stage']] as const) {
    const anonymous = await call(base, method, route, null, method === 'POST' ? {} : undefined);
    assert.equal(anonymous.status, 401, route);
    assert.equal(anonymous.body.code, 'unauthorized', route);
    assert.equal((await call(base, method, route, reader, method === 'POST' ? {} : undefined)).status, 403, route);
  }
});

test('detect names the profiles without a path; stage takes names only, never a path', async () => {
  const home = fakeHome();
  useHome(home);
  const base = await loaded();
  const ada = account('ada', ['agents:manage']);
  const detected = await call(base, 'GET', 'hermes', ada);
  assert.equal(detected.status, 200);
  assert.deepEqual(detected.body, {
    found: true,
    label: HERMES_LABEL,
    profiles: [{ name: 'default', displayName: 'Hermes' }, { name: 'coder', displayName: 'coder' }, { name: 'my_profile', displayName: 'my_profile' }],
  });
  assert.ok(!JSON.stringify(detected.body).includes(home));

  for (const profiles of [['../../etc'], ['/etc/passwd'], ['C:\\Windows'], [], 'default']) {
    const res = await call(base, 'POST', 'hermes/stage', ada, { profiles });
    assert.equal(res.status, 400, JSON.stringify(profiles));
    assert.equal(res.body.code, 'invalid');
  }
  assert.equal((await call(base, 'POST', 'hermes/stage', ada, { root: '/etc' })).status, 400, 'no other field');
  const unknown = await call(base, 'POST', 'hermes/stage', ada, { profiles: ['nobody'] });
  assert.equal(unknown.status, 404);
  assert.equal((await call(base, 'POST', 'hermes/stage', ada, { profiles: ['gone'] })).status, 404, 'a deleted profile is not readable');

  useHome(mkdtempSync(join(tmpdir(), 'agent-import-nohermes-')));
  assert.deepEqual((await call(base, 'GET', 'hermes', ada)).body, { found: false, profiles: [] });
  assert.equal((await call(base, 'POST', 'hermes/stage', ada, {})).status, 404);
});

test('stage → preview → apply imports the profiles; a Hermes Gateway agent sends them under import.', async () => {
  useHome(fakeHome());
  const base = await loaded();
  const ada = account('ada', ['agents:manage', 'skills:manage', 'mcp:manage', 'triggers:manage', 'kanban:write']);

  const logged: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  }
  let staged: { status: number; body: Json };
  let preview: { status: number; body: Json };
  let applied: { status: number; body: Json };
  try {
    staged = await call(base, 'POST', 'hermes/stage', ada, { profiles: ['default'] });
    assert.equal(staged.status, 201, JSON.stringify(staged.body));
    preview = await call(base, 'POST', 'preview', ada, { token: staged.body.token });
    applied = await call(base, 'POST', 'apply', ada, { token: staged.body.token });
  } finally {
    Object.assign(console, original);
  }
  noSecret(logged.join('\n'), 'the logs');
  noSecret(JSON.stringify([staged.body, preview.body, applied.body]), 'the answers');

  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const agents = (preview.body.preview as { agents: Array<Json & { warnings: string[] }> }).agents;
  assert.deepEqual(agents.map((a) => [a.finalName, a.action]), [['hermes.default', 'create']]);
  const notes = agents[0]!.warnings.join('\n');
  assert.match(notes, /MCP server github runs a command on this machine \(npx .*<redacted>/);
  assert.match(notes, /Deliveries are not carried over: telegram, discord/);
  assert.match(notes, /conversation history is not imported/);
  assert.match(notes, /OPENAI_API_KEY/);
  assert.match(notes, /Skill runner comes with files or scripts/);

  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual((applied.body.agents as Json[]).map((a) => [a.agent, a.status]), [['hermes.default', 'created']]);
  assert.ok(getAgent('hermes.default'));
  assert.match(readDoc('hermes.default', 'SOUL.md') ?? '', /I am the house assistant\./);

  // Hermes Gateway names its agents `hermes.<connection>.<profile>`: a new profile goes under `import.`.
  upsertAgent({ name: 'hermes.gw.coder', system_prompt: 'gateway', config: { role: 'research', backend: 'claude' } });
  const again = await call(base, 'POST', 'hermes/stage', ada, { profiles: ['coder'] });
  assert.equal(again.status, 201);
  const second = await call(base, 'POST', 'preview', ada, { token: again.body.token });
  const secondAgents = (second.body.preview as { agents: Json[]; warnings: string[] });
  assert.deepEqual(secondAgents.agents.map((a) => a.finalName), ['import.coder']);
  assert.ok(secondAgents.warnings.some((w) => w.includes('import.')));
});

/** Stages one zip upload, as the archive card does. */
async function stageZip(base: string, user: string, manifest: Json): Promise<string> {
  const bytes = forgeZip([{ name: 'timon-agent-import.json', data: JSON.stringify(manifest) }]);
  const res = await fetch(`${base}/stage`, { method: 'POST', headers: { 'x-test-user': user, 'content-type': 'application/zip' }, body: bytes });
  const body = await res.json() as Json;
  assert.equal(res.status, 201, JSON.stringify(body));
  return String(body.token);
}

async function previewAndApply(base: string, user: string, token: string): Promise<{ previewed: string[][]; applied: string[][] }> {
  const preview = await call(base, 'POST', 'preview', user, { token });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const applied = await call(base, 'POST', 'apply', user, { token });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  return {
    previewed: (preview.body.preview as { agents: Json[] }).agents.map((a) => [String(a.finalName), String(a.action)]),
    applied: (applied.body.agents as Json[]).map((a) => [String(a.agent), String(a.status)]),
  };
}

test('a named profile keeps one identity: the direct card and the zip of the skill run from it update the same agent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-import-hermes-named-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const hermes = hermesDir(home);
  write(hermes, {
    'config.yaml': 'timezone: Europe/Paris\n',
    'SOUL.md': 'I am the default profile.',
    'profiles/work/config.yaml': 'timezone: Europe/Paris\n',
    'profiles/work/SOUL.md': 'I am work, first version.',
  });
  useHome(home);
  const base = await loaded();
  const ada = account('ada', ['agents:manage']);

  const direct = await call(base, 'POST', 'hermes/stage', ada, {});
  assert.equal(direct.status, 201, JSON.stringify(direct.body));
  const first = await previewAndApply(base, ada, String(direct.body.token));
  // Earlier tests left `hermes.*` agents behind, so the final names may carry the `import.` prefix.
  assert.deepEqual(first.applied.map(([, status]) => status), ['created', 'created']);
  const [defaultAgent, workAgent] = first.applied.map(([name]) => name) as [string, string];
  assert.match(workAgent, /\.work$/);

  // What the skill writes when Hermes runs on `work` (HERMES_HOME = <root>/profiles/work).
  const fromWork = {
    format: 'timon-agent-import',
    version: 1,
    source: { app: 'hermes', exportedAt: '2026-11-18T10:00:00+01:00' },
    agents: [{ key: 'work', displayName: 'work', sourceRef: 'profile:work', soul: 'I am work, from the zip.' }],
  };
  const zipped = await previewAndApply(base, ada, await stageZip(base, ada, fromWork));
  assert.deepEqual(zipped.previewed, [[workAgent, 'update']]);
  assert.deepEqual(zipped.applied, [[workAgent, 'updated']]);
  assert.match(readDoc(workAgent, 'SOUL.md') ?? '', /from the zip/);
  assert.match(readDoc(defaultAgent, 'SOUL.md') ?? '', /default profile/, 'the default profile is left alone');

  // Back to the direct card.
  write(join(hermes, 'profiles', 'work'), { 'SOUL.md': 'I am work, read again.' });
  const again = await call(base, 'POST', 'hermes/stage', ada, { profiles: ['work'] });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  const third = await previewAndApply(base, ada, String(again.body.token));
  assert.deepEqual(third.previewed, [[workAgent, 'update']], 'the same agent again, never a copy');
  assert.match(readDoc(workAgent, 'SOUL.md') ?? '', /read again/);
  assert.match(readDoc(defaultAgent, 'SOUL.md') ?? '', /default profile/);
});
