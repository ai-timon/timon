/**
 * The official Codex provider, run the way a third party's would be: its `apply(ctx)` against the
 * stand-in `ctx` of `@timon-ai/sdk/testing`. What the generic bench cannot see is here: the folders the
 * sandbox is opened to, the pictures of a turn, what the plugin declares to the core and how that agrees
 * with the product's own table.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildSpawnOpts, NativeProviderDefinition, ProfileRuntime } from '../backends/types.js';

const kit = await import('../../../packages/sdk/src/testing/index.js');
const plugin = await import('../../official-providers/provider-codex/lib/index.js') as { apply(ctx: unknown): void };
const { BUILTIN_DECLARATIONS } = await import('../backends/builtin-declarations.js');
const { declarationProblems } = await import('../backends/provider-declarations.js');
const { argsUnderFence } = await import('../backends/permission-models.js');

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-codex-plugin-'));
const AUTH_DIR = join(TMP_HOME, 'codex-auth');
mkdirSync(AUTH_DIR, { recursive: true });
writeFileSync(join(AUTH_DIR, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.env.CODEX_AUTH_DIR = AUTH_DIR;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const REPO = join(TMP_HOME, 'repo');
mkdirSync(REPO, { recursive: true });
const SHOWN = [{ file: 'f0e1d2c3-b4a5-9687-7869-5a4b3c2d1e0f.png', kind: 'image' as const, mime: 'image/png', name: 'out.png' }];
const ctx = kit.createProviderContext({
  credentialDirs: [AUTH_DIR], gitRoots: { [REPO]: [join(REPO, '.git')] }, generatedMedia: SHOWN,
  binaries: { codex: { version: '0.159.0' } },
});
plugin.apply(ctx);
type Definition = NativeProviderDefinition & { launch(spawn: BuildSpawnOpts, profile: ProfileRuntime): Promise<{ cmd: string; args: string[]; env?: Record<string, string>; initialStdin: string | null }> };
const provider = ctx.registered.providers.get('codex') as Definition;
const dialect = ctx.registered.dialect('codex') as import('../backends/types.js').Dialect;
process.on('exit', () => ctx.cleanup());

const PROFILE: ProfileRuntime = { id: 'codex', cmd: 'codex', env: {}, minCliVersion: '0.134.0' };
const opts = (over: Partial<BuildSpawnOpts> = {}): BuildSpawnOpts => ({
  agentName: 'TIMON.codex-test', systemPrompt: 'sp', message: 'm', resumeSession: null,
  cfg: { cwd: REPO, model: 'gpt-5.5', permission_mode: 'auto' }, missionId: `mission-${Math.random().toString(36).slice(2, 10)}`, ...over,
});

test('the definition is coherent, and says what the core reads about it', () => {
  assert.deepEqual(ctx.provider.runtime.check.definitionProblems(provider), []);
  assert.deepEqual(declarationProblems(provider.declares, 'codex'), []);
  assert.equal(provider.transport.kind, 'process-per-turn');
  assert.equal(provider.session.resumable, true, 'a closed mission wakes in place: its rollout outlives the process (#607)');
  assert.equal(typeof provider.session.notFound, 'function', 'a follow-up turn resumes the thread, so a lost rollout must be recognised');
  assert.equal(dialect.permissionModel, 'sandbox');
  assert.deepEqual(provider.declares?.protocols, ['openai-responses']);
  assert.deepEqual(provider.declares?.credentialDirEnv, ['CODEX_AUTH_DIR']);
});

test('a thread whose rollout is gone is recognised, any other failure is not (TIM-0111)', () => {
  assert.equal(dialect.isSessionNotFoundError?.('Error: thread/resume: thread/resume failed: no rollout found for thread id 01a148f3-b883-7033-8882-46e3c780c089 (code -32600)'), true);
  assert.equal(dialect.isSessionNotFoundError?.('Error: stream disconnected before completion'), false);
  assert.equal(dialect.isSessionNotFoundError?.('You exceeded your current quota'), false);
});

test('what the plugin declares agrees with the product\'s own table (the one the onboarding and the doctor read)', () => {
  const table = BUILTIN_DECLARATIONS['codex']!;
  assert.deepEqual(provider.declares?.binary?.names, table.binary?.names);
  assert.deepEqual(provider.declares?.binary?.install, table.binary?.install);
  assert.deepEqual(provider.declares?.credentialDirs, table.credentialDirs);
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'official-providers', 'provider-codex', 'package.json'), 'utf8')) as { timon: { provider: { binaries: Array<{ name: string }>; credentialDirs: string[] } } };
  assert.deepEqual(manifest.timon.provider.binaries.map((entry) => entry.name), table.binary?.names, 'the operator authorizes what the plugin declares');
  assert.deepEqual(manifest.timon.provider.credentialDirs, table.credentialDirs);
});

test('the sandbox is opened to the git folders the daemon computed, and the token is asked for by name, never written', async () => {
  const spec = await provider.launch(opts(), PROFILE);
  const toml = readFileSync(join(spec.env!.CODEX_HOME!, 'config.toml'), 'utf8');
  // None on Windows: its sandbox refuses a writable root under codex's own `.git` carve-out (TIM-0121).
  if (process.platform === 'win32') assert.doesNotMatch(toml, /writable_roots/);
  else assert.match(toml, new RegExp(`writable_roots = \\["${join(REPO, '.git').replace(/\\/g, '\\\\\\\\')}"\\]`));
  assert.match(toml, /network_access = true/);
  assert.equal(toml.includes(kit.FAKE_TOKEN_REFERENCE), false, 'the reference of the token is not in the file');
  assert.match(toml, /env_vars = \["TIMON_API_TOKEN", "npm_config_cache"/);
  assert.deepEqual(spec.args.slice(0, 5), ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write']);
  assert.equal(spec.initialStdin, '# Instructions\nsp\n\n# Task\nm');
});

test('golden: the arguments of a launch, unfenced as the provider builds them and fenced as the core rewrites them', async () => {
  const declaration = provider.permission.nestedSandbox;
  assert.deepEqual(declaration, { level: { flag: '--sandbox', off: 'danger-full-access', readOnly: ['read-only'] } });
  assert.deepEqual(dialect.nestedSandbox, declaration, 'the dialect carries it to the core');
  const head = (args: readonly string[]) => args.slice(0, args.indexOf('-'));
  const cases: Array<[string | undefined, string, boolean]> = [
    ['plan', 'read-only', true],
    ['auto', 'workspace-write', false],
    ['acceptEdits', 'workspace-write', false],
    [undefined, 'workspace-write', false],
    ['bypassPermissions', 'danger-full-access', false],
  ];
  for (const [permission_mode, level, readOnly] of cases) {
    const spec = await provider.launch(opts({ cfg: { cwd: REPO, ...(permission_mode ? { permission_mode } : {}) } }), PROFILE);
    assert.deepEqual(head(spec.args), ['exec', '--json', '--skip-git-repo-check', '--sandbox', level], `unfenced ${permission_mode}`);
    const fenced = argsUnderFence(spec.args, declaration);
    assert.deepEqual(head(fenced.args), ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access'], `fenced ${permission_mode}`);
    assert.deepEqual(fenced.args.slice(5), spec.args.slice(5), 'nothing else moves');
    assert.equal(fenced.readOnly, readOnly, `fenced ${permission_mode}: read-only workspace`);
    assert.equal(fenced.levelMissing, false);
  }
  // A read-only-tools launch keeps its disabled tools; the fence makes its workspace read-only.
  const tools = argsUnderFence((await provider.launch(opts({ readOnlyTools: true }), PROFILE)).args, declaration);
  assert.equal(tools.readOnly, true);
  assert.ok(tools.args.includes('shell_tool') && tools.args.includes('web_search=disabled'));
});

test('a CLI older than the profile\'s floor is refused with the command that fixes it; an unreadable version is not a verdict', async () => {
  const old = kit.createProviderContext({ credentialDirs: [AUTH_DIR], binaries: { codex: { version: '0.133.0' } } });
  plugin.apply(old);
  const oldProvider = old.registered.providers.get('codex') as Definition;
  await assert.rejects(oldProvider.launch(opts(), PROFILE), /older than 0\.134\.0.*npm install -g @openai\/codex@latest/);
  const unknown = kit.createProviderContext({ credentialDirs: [AUTH_DIR] });
  plugin.apply(unknown);
  await (unknown.registered.providers.get('codex') as Definition).launch(opts(), PROFILE);
  old.cleanup();
  unknown.cleanup();
});

test('the turn\'s result gains the pictures the CLI generated, and the folder is opened to chat_show_media', async () => {
  const missionId = 'mission-pictures';
  const spec = await provider.launch(opts({ missionId }), PROFILE);
  assert.ok(ctx.shownFrom.get(missionId)?.some((dir) => dir === join(spec.env!.CODEX_HOME!, 'generated_images')), 'the agent may show from it');
  const result = dialect.enrichEvent!({ type: 'result', payload: { type: 'result', subtype: 'success' } }, missionId);
  assert.deepEqual((result.payload as { generated_media?: unknown }).generated_media, SHOWN);
  const other = dialect.enrichEvent!({ type: 'assistant', payload: {} }, missionId);
  assert.deepEqual(other.payload, {}, 'only a result is enriched');
  const unknown = dialect.enrichEvent!({ type: 'result', payload: { type: 'result' } }, 'a-mission-it-never-launched');
  assert.deepEqual(unknown.payload, { type: 'result' });
});

test('a read-only-tools launch has no shell, no file reader, no connector nor web tool, and a read-only sandbox, whatever the agent\'s mode (TODO #469, #471)', async () => {
  for (const permission_mode of ['auto', 'bypassPermissions', 'danger-full-access']) {
    const spec = await provider.launch(opts({ readOnlyTools: true, cfg: { cwd: REPO, permission_mode } }), PROFILE);
    const args = spec.args.slice(0, spec.args.indexOf('-'));
    assert.deepEqual(args.slice(3), [
      '--sandbox', 'read-only',
      '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'view_image',
      '--disable', 'apps', '--disable', 'plugins', '--disable', 'image_generation',
      '-c', 'web_search=disabled',
    ], permission_mode);
    assert.equal(spec.args.filter((arg) => arg === '--sandbox').length, 1);
  }
  const resumed = await provider.launch(opts({ readOnlyTools: true, resumeSession: 'thread-1' }), PROFILE);
  assert.ok(resumed.args.indexOf('web_search=disabled') < resumed.args.indexOf('resume'), 'exec-level options come before `resume`');
  const ordinary = await provider.launch(opts(), PROFILE);
  assert.equal(ordinary.args.includes('--disable'), false, 'an ordinary mission keeps its shell');
  assert.equal(ordinary.args.includes('web_search=disabled'), false);
  assert.equal(ordinary.args[ordinary.args.indexOf('--sandbox') + 1], 'workspace-write');
});
