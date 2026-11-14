/**
 * The official Grok provider, run the way a third party's would be: its `apply(ctx)` against
 * the stand-in `ctx` of `@timon-ai/sdk/testing`, then the conformance bench of the SDK on what
 * it registered. What the generic bench cannot see is here: the contents of the per-mission
 * GROK_HOME, the translation of the permission mode, the prompt channel, the sign-in file.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildSpawnOpts, ImageAttachment, NativeProviderDefinition, ProfileRuntime } from '../backends/types.js';

const kit = await import('../../../packages/sdk/src/testing/index.js');
const { createScratchDir } = await import('../backends/scratch-dir.js');
const plugin = await import('../../official-providers/provider-grok/lib/index.js') as {
  apply(ctx: unknown): void;
};

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-grok-plugin-'));
const AUTH_DIR = join(TMP_HOME, 'grok-auth');
mkdirSync(AUTH_DIR, { recursive: true });
process.env.GROK_AUTH_DIR = AUTH_DIR;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const ctx = kit.createProviderContext({ credentialDirs: [AUTH_DIR] });
plugin.apply(ctx);
const provider = ctx.registered.providers.get('grok') as NativeProviderDefinition & { launch(spawn: BuildSpawnOpts, profile: ProfileRuntime): Promise<{ cmd: string; args: string[]; cwd?: string; env?: Record<string, string>; initialStdin: string | null }> };
const dialect = ctx.registered.dialect('grok') as import('../backends/types.js').Dialect;
process.on('exit', () => ctx.cleanup());

const PROFILE: ProfileRuntime = { id: 'grok', cmd: 'grok', env: {} };
const SYSTEM_PROMPT = 'Tu es un agent TIMON. Réponds en français.';
const MESSAGE = 'Résume src/index.ts.';

function opts(over: Partial<BuildSpawnOpts> = {}): BuildSpawnOpts {
  return {
    agentName: 'TIMON.grok-test',
    systemPrompt: SYSTEM_PROMPT,
    message: MESSAGE,
    resumeSession: null,
    cfg: { cwd: TMP_HOME, model: 'grok-4.6', permission_mode: 'auto' },
    missionId: `mission-${Math.random().toString(36).slice(2, 10)}`,
    ...over,
  };
}

/** Value that follows `flag` in the args, or null. */
function argAfter(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : null;
}

test('the provider registers under the product\'s own id, and what it declares matches the product\'s table', async () => {
  const { BUILTIN_DECLARATIONS } = await import('../backends/builtin-declarations.js');
  assert.equal(provider.id, 'grok');
  const declared = BUILTIN_DECLARATIONS.grok!;
  // `standaloneInstaller` is what the provider cards may run: the product's own, never a plugin's.
  const { standaloneInstaller: _productOnly, ...publicBinary } = declared.binary!;
  assert.deepEqual(provider.declares?.binary, publicBinary, 'binary (C1)');
  assert.deepEqual(provider.declares?.credentialDirs, declared.credentialDirs, 'credentialDirs (C2)');
  // C2 bis: without it, `GROK_AUTH_DIR` outside `~/.grok` was refused by `scratch.link` (TODO #551).
  assert.deepEqual(provider.declares?.credentialDirEnv, ['GROK_AUTH_DIR']);
  const { declarationProblems } = await import('../backends/provider-declarations.js');
  assert.deepEqual(declarationProblems(provider.declares, 'grok'), []);
  assert.equal(provider.declares?.spans, 'stream-json');
  // The names the manifest lists are what the operator authorizes: they must be the ones declared.
  const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'official-providers', 'provider-grok', 'package.json'), 'utf8')) as {
    timon: { provider: { binaries: Array<{ name: string }>; credentialDirs: string[] } };
  };
  assert.deepEqual(manifest.timon.provider.binaries.map((b) => b.name), [...(provider.declares?.binary?.names ?? [])]);
  assert.deepEqual(manifest.timon.provider.credentialDirs, [...(provider.declares?.credentialDirs ?? [])]);
});

test('the system prompt goes out by file, never in argv', async () => {
  const sp = await provider.launch(opts(), PROFILE);
  assert.ok(!sp.args.some((a) => a.includes(SYSTEM_PROMPT)), 'system prompt in argv: E2BIG as soon as the preamble grows');
  assert.equal(readFileSync(join(sp.env!.GROK_HOME!, 'rules', 'timon.md'), 'utf8'), SYSTEM_PROMPT);
});

test('the user message goes out through --prompt-file', async () => {
  const sp = await provider.launch(opts(), PROFILE);
  const file = argAfter(sp.args, '--prompt-file');
  assert.ok(file, '--prompt-file missing');
  assert.equal(readFileSync(file!, 'utf8'), MESSAGE);
  assert.ok(!sp.args.includes('--prompt-json'), 'both prompt channels at once');
});

test('a multimodal turn goes through --prompt-json and resource links to real file: URLs', async () => {
  const png: ImageAttachment = { media_type: 'image/png', data: Buffer.from('x').toString('base64') };
  const sp = await provider.launch(opts({ images: [png] }), PROFILE);
  const json = argAfter(sp.args, '--prompt-json');
  assert.ok(json, '--prompt-json missing for a turn with an image');
  const blocks = JSON.parse(json!) as Array<Record<string, string>>;
  assert.equal(blocks[0]?.type, 'text');
  assert.equal(blocks[0]?.text, MESSAGE);
  assert.equal(blocks[1]?.type, 'resource_link');
  const uri = blocks[1]?.uri ?? '';
  assert.ok(uri.startsWith('file://'), `unexpected uri: ${uri}`);
  const file = fileURLToPath(uri);
  assert.ok(existsSync(file), 'image not written to disk');
  assert.ok(file.startsWith(sp.env!.GROK_HOME!), 'the image lives in the mission\'s folder');
  // TODO #403: the name is the file's, split by `node:path`, not on a `/` it may not contain.
  assert.equal(blocks[1]?.name, basename(file));
  assert.ok(!json!.includes(png.data), 'the base64 of the image travels in argv');
});

test('a huge message goes back through the file even with an image', async () => {
  const png: ImageAttachment = { media_type: 'image/png', data: Buffer.from('x').toString('base64') };
  const big = 'x'.repeat(200_000);
  const sp = await provider.launch(opts({ message: big, images: [png] }), PROFILE);
  assert.ok(!sp.args.includes('--prompt-json'), '200 KB argv: E2BIG at spawn');
  const written = readFileSync(argAfter(sp.args, '--prompt-file')!, 'utf8');
  assert.ok(written.startsWith(big), 'message truncated');
  assert.ok(written.includes('[Images jointes]'), 'images not referenced in the fallback');
});

test('permission_mode: never raised — only an explicit bypassPermissions gets always-approve, the rest runs in plan', async () => {
  for (const [mode, expected] of [
    ['bypassPermissions', 'bypassPermissions'],
    ['plan', 'plan'],
    // Guarded modes: the CLI's approval pipeline has no channel headless, and
    // always-approve would hand more than the agent was given (fail-closed).
    ['default', 'plan'],
    ['auto', 'plan'],
    ['acceptEdits', 'plan'],
    ['dontAsk', 'plan'],
    // Another dialect's vocabulary, a typo, nothing: never a reason to raise.
    ['danger-full-access', 'plan'],
    ['read-only', 'plan'],
    ['bypass', 'plan'],
    [undefined, 'plan'],
  ] as const) {
    const sp = await provider.launch(opts({ cfg: { cwd: TMP_HOME, model: 'grok-4.6', permission_mode: mode } }), PROFILE);
    assert.equal(argAfter(sp.args, '--permission-mode'), expected, `mode ${mode}`);
  }
});

test('permission_mode: the provider declares the two modes it honours, and its mapping keeps to them', async () => {
  const { permissionModeForGrok, GROK_SUPPORTED_MODES } = await import('../../official-providers/provider-grok/lib/grok.js') as {
    permissionModeForGrok(mode: string | undefined): string;
    GROK_SUPPORTED_MODES: string[];
  };
  assert.deepEqual(provider.permission.supportedModes, ['plan', 'bypassPermissions']);
  assert.deepEqual(dialect.supportedPermissionModes, ['plan', 'bypassPermissions']);
  for (const mode of ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'read-only', undefined]) {
    assert.ok(GROK_SUPPORTED_MODES.includes(permissionModeForGrok(mode)), `mode ${String(mode)}`);
  }
});

test('the hard guardrails go out as --deny, whatever the mode', async () => {
  for (const mode of ['auto', 'plan', undefined] as const) {
    const sp = await provider.launch(opts({ cfg: { cwd: TMP_HOME, model: 'grok-4.6', permission_mode: mode } }), PROFILE);
    const denied = sp.args.filter((a, i) => sp.args[i - 1] === '--deny');
    assert.ok(denied.length > 0, `no --deny rule for mode ${mode}`);
    assert.ok(denied.some((r) => r.startsWith('Bash(sudo')), 'privilege escalation not blocked');
    assert.ok(denied.some((r) => r.includes('timon-orchestrator')), 'restart of the Timon orchestrator not blocked');
    // public-name-ok: the archive guard refuses it by name
    assert.ok(denied.some((r) => r.includes('pkos-orchestrator')), 'restart of the ancestor\'s daemon not blocked');
  }
});

test('the mission\'s config.toml turns off the claude/cursor discovery', async () => {
  const sp = await provider.launch(opts(), PROFILE);
  const toml = readFileSync(join(sp.env!.GROK_HOME!, 'config.toml'), 'utf8');
  for (const vendor of ['claude', 'cursor']) {
    const section = toml.split(`[compat.${vendor}]`)[1]?.split('[')[0] ?? '';
    assert.ok(section.length > 0, `section [compat.${vendor}] missing`);
    for (const cell of ['skills', 'rules', 'agents', 'mcps', 'hooks']) {
      assert.match(section, new RegExp(`^${cell} = false$`, 'm'), `compat.${vendor}.${cell} left on: the agent would inherit the host's config`);
    }
  }
});

test('Timon\'s MCP servers are declared with the mission\'s identity, and no token', async () => {
  const o = opts();
  const sp = await provider.launch(o, PROFILE);
  const toml = readFileSync(join(sp.env!.GROK_HOME!, 'config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\.timon\]/);
  assert.match(toml, /\[mcp_servers\.timon_ask\]/);
  // Without these two keys `ask_user` POSTs an empty mission_id (400) and created tasks belong to no mission.
  assert.ok(toml.includes(`TIMON_MISSION_ID = ${JSON.stringify(o.missionId)}`));
  assert.ok(toml.includes(`TIMON_AGENT = ${JSON.stringify(o.agentName)}`));
  // Grok has no --permission-prompt-tool: the forms server only serves its forms.
  assert.match(toml, /TIMON_ASK_FORMS_ONLY|FORMS_ONLY/);
  // The CLI hands its MCP servers its own environment, which carries the token: the file names no credential.
  assert.doesNotMatch(toml, /TIMON_API_TOKEN/);
  assert.equal(toml.includes(kit.FAKE_TOKEN_REFERENCE), false);
});

test('without Timon\'s servers (timonMcp: false) the config declares none of them', async () => {
  const sp = await provider.launch(opts({ timonMcp: false }), PROFILE);
  const toml = readFileSync(join(sp.env!.GROK_HOME!, 'config.toml'), 'utf8');
  assert.doesNotMatch(toml, /\[mcp_servers\.timon\]/);
  assert.doesNotMatch(toml, /\[mcp_servers\.timon_ask\]/);
  assert.match(toml, /\[compat\.claude\]/);
});

/* ── The CLI's private home: no rule of ~/.claude/settings.json reaches a mission ── */

const homeHelpers = await import('../../official-providers/provider-grok/lib/grok.js') as {
  privateHomeEnv(privateHome: string, platform?: NodeJS.Platform): Record<string, string>;
  realHomeEnv(platform?: NodeJS.Platform): Record<string, string>;
  relayRcFiles(realHome: string): Record<string, string>;
  PRIVATE_HOME_DIR: string;
};

test('grok runs with a private HOME inside its GROK_HOME, so ~/.claude/settings.json names nothing', async () => {
  const sp = await provider.launch(opts(), PROFILE);
  const privateHome = join(sp.env!.GROK_HOME!, homeHelpers.PRIVATE_HOME_DIR);
  // grok 1.0.77 reads the permission rules of `~/.claude/settings.json` whatever the compat cells
  // say, and takes `~` from HOME only: the user's home must not be the CLI's.
  assert.equal(sp.env!.HOME, privateHome);
  assert.notEqual(sp.env!.HOME, homedir());
  assert.ok(lstatSync(privateHome).isDirectory(), 'the private home exists before the CLI starts');
  assert.equal(existsSync(join(privateHome, '.claude')), false);
  assert.equal(existsSync(join(privateHome, '.claude.json')), false);
});

test('the agent\'s shell gets the user\'s real home back through [shell_environment_policy]', async () => {
  const sp = await provider.launch(opts(), PROFILE);
  const toml = readFileSync(join(sp.env!.GROK_HOME!, 'config.toml'), 'utf8');
  const section = toml.split('[shell_environment_policy]')[1]?.split('\n[')[0] ?? '';
  assert.ok(section.length > 0, 'section [shell_environment_policy] missing: git, ssh and timon would look in the private home');
  assert.ok(section.includes(`HOME = ${JSON.stringify(homedir())}`), section);
});

test('Timon\'s MCP servers start with the user\'s real home, not the CLI\'s', async () => {
  const sp = await provider.launch(opts(), PROFILE);
  const toml = readFileSync(join(sp.env!.GROK_HOME!, 'config.toml'), 'utf8');
  const timonEnv = toml.split('[mcp_servers.timon.env]')[1]?.split('\n[')[0] ?? '';
  assert.ok(timonEnv.includes(`HOME = ${JSON.stringify(homedir())}`), timonEnv);
});

test('Windows: USERPROFILE moves with HOME, both ways', () => {
  assert.deepEqual(homeHelpers.privateHomeEnv('P', 'win32'), { HOME: 'P', USERPROFILE: 'P' });
  assert.deepEqual(homeHelpers.realHomeEnv('win32'), { HOME: homedir(), USERPROFILE: homedir() });
  assert.deepEqual(homeHelpers.privateHomeEnv('P', 'linux'), { HOME: 'P' });
  assert.deepEqual(homeHelpers.realHomeEnv('darwin'), { HOME: homedir() });
});

test('the login shell grok captures reads the user\'s own rc files, with the real HOME', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-grok-rc-'));
  try {
    const realHome = join(root, "real home's");
    const privateHome = join(root, 'private');
    mkdirSync(realHome, { recursive: true });
    mkdirSync(privateHome, { recursive: true });
    writeFileSync(join(realHome, '.profile'), 'export TIMON_RC_MARK=profile\n');
    writeFileSync(join(realHome, '.bashrc'), 'export TIMON_RC_MARK=bashrc\n');
    for (const [name, content] of Object.entries(homeHelpers.relayRcFiles(realHome))) {
      writeFileSync(join(privateHome, name), content);
    }
    const env = { PATH: process.env.PATH ?? '', HOME: privateHome };
    // The machine's own rc files may print a banner first (Ubuntu's sudo hint): only the last line is ours.
    const probe = 'printf "\\n%s|%s" "$HOME" "$TIMON_RC_MARK"';
    const run = (args: string[]): string => execFileSync(args[0]!, args.slice(1), { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').at(-1)!;
    // portability: POSIX login shells, skipped on Windows
    assert.equal(run(['bash', '-l', '-c', probe]), `${realHome}|profile`);
    // portability: POSIX login shells, skipped on Windows
    assert.equal(run(['bash', '-i', '-c', probe]), `${realHome}|bashrc`);
    // portability: POSIX login shells, skipped on Windows
    assert.equal(run(['sh', '-l', '-c', probe]), `${realHome}|profile`);
    // zsh (macOS's login shell) reads every later file from ZDOTDIR, which the relay points home.
    assert.match(readFileSync(join(privateHome, '.zshenv'), 'utf8'), /^export ZDOTDIR="\$HOME"$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the mission\'s home is stable between two turns, and gone with the mission', async () => {
  const o = opts();
  const first = await provider.launch(o, PROFILE);
  const second = await provider.launch({ ...o, resumeSession: 'session-abc', message: 'suite' }, PROFILE);
  // Sessions live in the home: a different home on turn 2 would make `-r` unresolvable.
  assert.equal(second.env!.GROK_HOME, first.env!.GROK_HOME);
  assert.ok(second.args.includes('-r') && second.args.includes('session-abc'));
  assert.equal(readFileSync(argAfter(second.args, '--prompt-file')!, 'utf8'), 'suite');
});

test('the sign-in file of the host is exposed to the mission', async () => {
  writeFileSync(join(AUTH_DIR, 'auth.json'), JSON.stringify({ sentinel: true }));
  const sp = await provider.launch(opts(), PROFILE);
  assert.deepEqual(JSON.parse(readFileSync(join(sp.env!.GROK_HOME!, 'auth.json'), 'utf8')), { sentinel: true });
});

test('a sign-in file that cannot be exposed does not stop the launch: it is logged, with the reason', async () => {
  writeFileSync(join(AUTH_DIR, 'auth.json'), '{}');
  const refusing = kit.createProviderContext({ credentialDirs: [] });
  plugin.apply(refusing);
  const refused = refusing.registered.providers.get('grok') as typeof provider;
  const sp = await refused.launch(opts(), PROFILE);
  assert.ok(sp.args.includes('--prompt-file'), 'the launch went through');
  assert.equal(existsSync(join(sp.env!.GROK_HOME!, 'auth.json')), false);
  assert.ok(refusing.logs.some((l) => l.level === 'warn' && /sign-in file could not be exposed/.test(l.message)), 'the refusal is logged');
  refusing.cleanup();
});

/** A `ctx` whose per-mission folder lives at `root(missionId)` and whose file links follow `chain`. */
function contextWithScratch(
  root: (missionId: string) => string,
  chain?: (real: string, target: string) => Array<['symlink' | 'hardlink' | 'copy', () => void]>,
) {
  const scratches = new Map<string, import('../backends/scratch-dir.js').ProviderScratchDir>();
  const custom = kit.createProviderContext({ credentialDirs: [AUTH_DIR] });
  (custom.provider as { scratch: unknown }).scratch = {
    mission: async (spawn: BuildSpawnOpts) => {
      let dir = scratches.get(spawn.missionId);
      if (!dir) {
        dir = createScratchDir({ root: root(spawn.missionId), linkRoots: [AUTH_DIR], ...(chain ? { linkChain: chain } : {}) });
        scratches.set(spawn.missionId, dir);
      }
      return dir;
    },
  };
  plugin.apply(custom);
  return { custom, launch: (custom.registered.providers.get('grok') as typeof provider).launch };
}

test('TODO #401: the sign-in file reaches the mission when the OS refuses symbolic links (Windows without the privilege)', async () => {
  writeFileSync(join(AUTH_DIR, 'auth.json'), JSON.stringify({ sentinel: 'copied' }));
  const refusing = (): never => { throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' }); };
  // The symbolic link AND the hard link (another volume) are refused: the copy is what is left.
  const { custom, launch } = contextWithScratch(
    (id) => join(TMP_HOME, 'no-links', id),
    (real, target) => [['symlink', refusing], ['hardlink', refusing], ['copy', () => copyFileSync(real, target)]],
  );
  const sp = await launch.call(undefined, opts(), PROFILE);
  const file = join(sp.env!.GROK_HOME!, 'auth.json');
  assert.equal(lstatSync(file).isSymbolicLink(), false, 'a copy, not a link');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { sentinel: 'copied' });
  assert.deepEqual(custom.logs.filter((l) => l.level === 'warn'), [], 'nothing to warn about: the sign-in is there');
  custom.cleanup();
});

test('TODO #403: a folder with spaces, a # and accents gives a resource link a CLI can open', async () => {
  const png: ImageAttachment = { media_type: 'image/png', data: Buffer.from('x').toString('base64') };
  const { custom, launch } = contextWithScratch((id) => join(TMP_HOME, 'dossier avec espace #é', id));
  const sp = await launch.call(undefined, opts({ images: [png] }), PROFILE);
  const blocks = JSON.parse(argAfter(sp.args, '--prompt-json')!) as Array<Record<string, string>>;
  const uri = blocks[1]!.uri!;
  assert.match(uri, /%20/, 'a space is percent-encoded in a file: URL');
  assert.doesNotMatch(uri, /#/, 'a # would start the URL\'s fragment');
  assert.ok(existsSync(fileURLToPath(uri)), 'the URL leads back to the image');
  assert.equal(blocks[1]!.name, basename(fileURLToPath(uri)));
  custom.cleanup();
});

test('capabilities: one-shot, no argv ceiling, with a usage probe', () => {
  assert.equal(dialect.persistentProcess, false);
  assert.equal(dialect.finishMissionOnExit, false);
  assert.equal(dialect.sessionResumable, true);
  assert.equal(dialect.sessionStore, 'per-mission');
  assert.equal(dialect.permissionModel, 'sandbox');
  assert.equal(dialect.rateLimitReporting, 'textual');
  assert.equal(dialect.hostedConnectors, false);
  // The prompt does not travel in argv: advertising a ceiling would be false.
  assert.equal(dialect.maxPromptBytes, undefined);
  assert.equal(typeof dialect.accountUsage, 'function');
  // No control channel: the model only changes on respawn.
  assert.equal(dialect.setModel, undefined);
  assert.equal(dialect.defaultCmd, 'grok');
});

test('parseLine: deltas come out as an ephemeral event, the rest in the Timon vocabulary', () => {
  const delta = dialect.parseLine(JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PO' } },
  }));
  assert.equal(delta.length, 1);
  assert.deepEqual(delta[0]!.payload, { text: 'PO', mode: 'append' });
  // The Anthropic wire format's plumbing must persist NOTHING: the final `assistant` message sums it up.
  for (const noise of ['message_start', 'content_block_start', 'message_delta', 'message_stop']) {
    assert.deepEqual(dialect.parseLine(JSON.stringify({ type: 'stream_event', event: { type: noise } })), [], `event ${noise} let through`);
  }
  assert.deepEqual(dialect.parseLine('Welcome to Grok'), []);
  const init = dialect.parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123', model: 'grok-4.6' }));
  assert.equal(dialect.extractSessionId(init[0]!), 'abc-123');
});

test('parseLine: the http_status buried in errors[] comes up as api_error_status', () => {
  // The exact payload of the 2026-09-01 incident: the 402 only exists inside a STRING of `errors[]`.
  const line = JSON.stringify({
    type: 'result', subtype: 'error_during_execution', is_error: true,
    num_turns: 0, duration_ms: 295, total_cost_usd: 0,
    errors: ['Internal error: {\n  "message": "API error (status 402 Payment Required): '
      + 'Grok Build usage balance exhausted",\n  "http_status": 402\n}'],
  });
  const ev = dialect.parseLine(line);
  assert.equal(ev.length, 1);
  const payload = ev[0]!.payload as Record<string, unknown>;
  assert.equal(payload.api_error_status, 402);
  assert.ok(Array.isArray(payload.errors), 'the original message stays');

  const kept = dialect.parseLine(JSON.stringify({
    type: 'result', is_error: true, api_error_status: 429, errors: ['Internal error: {"http_status": 402}'],
  }));
  assert.equal((kept[0]!.payload as Record<string, unknown>).api_error_status, 429, 'a status the CLI gave is never overwritten');

  const plain = dialect.parseLine(JSON.stringify({ type: 'result', is_error: true, errors: ['ENOENT: no such file'] }));
  assert.equal((plain[0]!.payload as Record<string, unknown>).api_error_status, undefined);
});

/* ── The conformance bench of the SDK, on a recorded turn ──────────────────── */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'backends', '__fixtures__', 'grok.jsonl');
const benchScratch = await ctx.provider.scratch.mission({ ...opts(), missionId: kit.DEFAULT_MISSION_ID });

kit.defineConformanceTests(test, kit.dialectConformance(
  dialect,
  { id: 'grok', env: {} },
  {
    transcript: readFileSync(FIXTURE, 'utf8'),
    sessionId: '01a014dc-392a-7753-9cf4-a111cc3ac77f',
    cmd: 'grok',
    // GROK_HOME per mission carries config.toml (MCP), rules/ (system prompt) and the sessions, so resume depends on it.
    envKeys: ['GROK_HOME'],
    model: 'grok-4.6',
  },
  { cwd: TMP_HOME, scratchDirs: [benchScratch.path] },
), '[grok plugin]');
