/**
 * A provider written against the SDK (`ctx.provider.registerProvider`): checked
 * before it is adapted, registered like any dialect, replaced in one step, and
 * read by the core through what it DECLARED (C1 to C7) instead of by its name.
 *
 * A real plugin context and the real registry; the host adapter, the isolation
 * policy and the fallback matrix are asked what they would answer for it.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import type { NativeProviderDefinition } from '../backends/engine/definition.js';
import type { NormalizedEvent } from '../backends/types.js';

const { readManifest } = await import('./manifest.js');
const { createPluginContext, daemonHost } = await import('./context.js');
const { PluginPolicyError } = await import('./policy.js');
const { config, setConfig } = await import('../config/load.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const registry = await import('../backends/registry.js');
const { providerRuntime } = await import('../backends/provider-runtime.js');
const { binaryCandidates } = await import('../host/binary-path.js');
const { installPlanFor } = await import('../host/machine.js');
const { resolveIsolation } = await import('../host/isolation.js');
const { defaultEquivalentFallback, tierOf } = await import('../backends/equivalence.js');

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

const { definitionProblems } = providerRuntime.check;
const { events, jsonLines } = providerRuntime;

/* ── Fixtures ────────────────────────────────────────────────────────────── */

function perTurn(id = 'acme-agent'): NativeProviderDefinition {
  return {
    id,
    transport: { kind: 'process-per-turn' },
    codec: {
      kind: 'lines',
      parseLine: (line: string): NormalizedEvent[] => {
        const row = jsonLines.parseJsonObjectLine(line);
        return row?.type === 'init' ? [events.systemInitEvent({ sessionId: String(row.session) })] : [];
      },
      extractSessionId: events.extractInitSessionId,
      writeUserInput: () => { /* a new launch carries the next turn */ },
    },
    launch: async (spawn, profile) => ({ cmd: profile.cmd, args: [spawn.message], cwd: spawn.cfg.cwd, initialStdin: null }),
    session: { store: 'per-mission', resumable: false },
    permission: { model: 'sandbox' },
    limits: { reporting: 'textual' },
    mcp: { timon: true },
    declares: { binary: { names: ['acme-agent', 'acme'] } },
  };
}

function persistentDriver(id = 'acme-acp'): NativeProviderDefinition {
  return {
    id,
    transport: { kind: 'stdio-persistent' },
    codec: { kind: 'driver', openSession: () => { throw new Error('not opened in this test'); } },
    launch: async (spawn, profile) => ({ cmd: profile.cmd, args: ['acp'], cwd: spawn.cfg.cwd, initialStdin: null }),
    session: { store: 'global', resumable: true },
    permission: { model: 'protocol', byAgent: true },
    limits: { reporting: 'none' },
    mcp: { timon: true },
    declares: { binary: { names: ['acme-acp'] } },
  };
}

function remote(id = 'acme-remote'): NativeProviderDefinition {
  return {
    id,
    transport: { kind: 'remote' },
    codec: { kind: 'driver', openSession: () => { throw new Error('not opened in this test'); } },
    session: { store: 'global', resumable: true },
    permission: { model: 'none' },
    limits: { reporting: 'none' },
    mcp: { timon: false },
  };
}

function pluginContext(pluginId: string, binaries: Array<{ name: string; aliases?: string[] }> = [{ name: 'acme-agent', aliases: ['acme'] }, { name: 'acme-acp' }], apiVersion = 12, credentialDirs: string[] = []) {
  const res = readManifest({ timon: {
    id: pluginId, apiVersion, kind: 'provider', permissions: ['backends:register'], provider: { binaries, credentialDirs },
  } });
  assert.equal(res.ok, true, res.ok ? '' : res.message);
  if (!res.ok) throw new Error('unreachable');
  return createPluginContext(new Context(), { manifest: res.manifest, version: '1.0.0' }, daemonHost());
}

/** The policy an operator who authorized these binaries would have. */
function allowExec(...names: string[]): () => void {
  const previous = config();
  setConfig(TimonConfigSchema.parse({ ...previous, pluginPolicy: { ...previous.pluginPolicy, exec: { allow: names } } }));
  return () => setConfig(previous);
}

/* ── definitionProblems ──────────────────────────────────────────────────── */

test('the three shapes of provider are coherent', () => {
  assert.deepEqual(definitionProblems(perTurn()), []);
  assert.deepEqual(definitionProblems({ ...perTurn(), permission: { model: 'sandbox', supportedModes: ['plan', 'bypassPermissions'] } }), []);
  assert.deepEqual(definitionProblems({ ...perTurn(), permission: { model: 'sandbox', nestedSandbox: { level: { flag: '--sandbox', off: 'none', readOnly: ['ro'] } } } }), []);
  assert.deepEqual(definitionProblems({ ...perTurn(), permission: { model: 'mcp-bridge', nestedSandbox: { offArgs: ['--no-sandbox'] } } }), []);
  assert.deepEqual(definitionProblems(persistentDriver()), []);
  assert.deepEqual(definitionProblems(remote()), []);
});

test('a capability declared without the member that serves it is refused, naming both', () => {
  const cases: Array<[string, (d: Record<string, unknown>) => void, RegExp]> = [
    ['protocol model without a session driver', (d) => { d.permission = { model: 'protocol' }; }, /permission\.model: 'protocol'.*codec: driver/],
    ['byAgent without a protocol', (d) => { d.permission = { model: 'sandbox', byAgent: true }; }, /byAgent.*only a session protocol/],
    ['appliesMode without a protocol', (d) => { d.permission = { model: 'sandbox', appliesMode: true }; }, /appliesMode.*permission\.model: 'protocol'/],
    ['appliesMode on an agent that never asks', (d) => { d.permission = { model: 'protocol', byAgent: true, appliesMode: true }; }, /appliesMode.*no `byAgent`/],
    ['supportedModes that is not a list', (d) => { d.permission = { model: 'sandbox', supportedModes: 'plan' }; }, /supportedModes.*non-empty list/],
    ['an empty supportedModes', (d) => { d.permission = { model: 'sandbox', supportedModes: [] }; }, /supportedModes.*non-empty list/],
    ['supportedModes naming an unknown mode', (d) => { d.permission = { model: 'sandbox', supportedModes: ['plan', 'yolo'] }; }, /supportedModes.*unknown modes "yolo"/],
    ['supportedModes listing a mode twice', (d) => { d.permission = { model: 'sandbox', supportedModes: ['plan', 'plan'] }; }, /supportedModes.*twice/],
    ['supportedModes without plan', (d) => { d.permission = { model: 'sandbox', supportedModes: ['bypassPermissions'] }; }, /supportedModes.*must include 'plan'/],
    ['a nestedSandbox that says nothing', (d) => { d.permission = { model: 'sandbox', nestedSandbox: {} }; }, /nestedSandbox.*`level`, `offArgs` or both/],
    ['a nestedSandbox level that is no option', (d) => { d.permission = { model: 'sandbox', nestedSandbox: { level: { flag: 'sandbox', off: 'none' } } }; }, /nestedSandbox\.level\.flag/],
    ['a nestedSandbox read-only level that turns it off', (d) => { d.permission = { model: 'sandbox', nestedSandbox: { level: { flag: '--sandbox', off: 'none', readOnly: ['none'] } } }; }, /nestedSandbox\.level\.readOnly/],
    ['nestedSandbox offArgs that are not arguments', (d) => { d.permission = { model: 'sandbox', nestedSandbox: { offArgs: ['a\0b'] } }; }, /nestedSandbox\.offArgs/],
    ['a nestedSandbox with an unknown key', (d) => { d.permission = { model: 'sandbox', nestedSandbox: { offArgs: ['-x'], replace: true } }; }, /nestedSandbox.*unknown keys "replace"/],
    ['setModel on a process per turn', (d) => { d.session = { store: 'per-mission', resumable: false, setModel: async () => true }; }, /setModel.*stdio-persistent/],
    ['a persistent process that cannot resume', (d) => { d.transport = { kind: 'stdio-persistent' }; d.session = { store: 'per-mission', resumable: false }; }, /stdio-persistent.*resumable: false/],
    ['a global store that is not resumable', (d) => { d.session = { store: 'global', resumable: false }; }, /global.*resumable by construction/],
    ['a driver codec on a one-shot process', (d) => { d.codec = { kind: 'driver', openSession: () => ({}) }; }, /driver.*stdio-persistent/],
    ['a lines codec without parseLine', (d) => { d.codec = { kind: 'lines', extractSessionId: () => null, writeUserInput: () => {} }; }, /codec\.parseLine/],
    ['a process without launch', (d) => { delete d.launch; }, /`launch` must be a function/],
    ['a process that names no binary', (d) => { d.declares = {}; }, /declares\.binary\.names/],
    ['an unknown permission model', (d) => { d.permission = { model: 'trust-me' }; }, /permission\.model.*"trust-me"/],
    ['no limit reporting', (d) => { d.limits = {}; }, /limits\.reporting/],
    ['a maxPromptBytes that is not a size', (d) => { d.session = { store: 'per-mission', resumable: false, maxPromptBytes: -4 }; }, /maxPromptBytes/],
    ['spans declared twice', (d) => { d.spans = () => []; d.declares = { binary: { names: ['acme-agent'] }, spans: 'stream-json' }; }, /declared twice/],
    ['an id that is not one', (d) => { d.id = 'Not An Id'; }, /`id` must be/],
  ];
  for (const [label, mutate, expected] of cases) {
    const def = perTurn() as unknown as Record<string, unknown>;
    mutate(def);
    const problems = definitionProblems(def);
    assert.ok(problems.some((p) => expected.test(p)), `${label}: expected ${expected}, got ${JSON.stringify(problems)}`);
  }
  const remoteWithLines = remote() as unknown as Record<string, unknown>;
  remoteWithLines.codec = perTurn().codec;
  assert.ok(definitionProblems(remoteWithLines).some((p) => /remote.*no process/.test(p)));
  const remoteNested = remote() as unknown as Record<string, unknown>;
  remoteNested.permission = { model: 'none', nestedSandbox: { offArgs: ['-x'] } };
  assert.ok(definitionProblems(remoteNested).some((p) => /nestedSandbox.*remote.*no process/.test(p)));
  assert.ok(definitionProblems('nope').length > 0 && definitionProblems(null).length > 0);
});

test('the declarations are checked: binary names, folders, passthrough, brand', () => {
  const declare = (declares: Record<string, unknown>) => {
    const def = perTurn() as unknown as Record<string, unknown>;
    def.declares = { binary: { names: ['acme-agent'] }, ...declares };
    return definitionProblems(def);
  };
  assert.ok(declare({ binary: { names: ['/usr/bin/acme'] } }).some((p) => /BARE names/.test(p)));
  assert.ok(declare({ binary: { names: ['a', 'b', 'c', 'd', 'e'] } }).some((p) => /1 to 4/.test(p)));
  assert.ok(declare({ credentialDirs: ['/etc'] }).some((p) => /relative to the home folder/.test(p)));
  assert.ok(declare({ credentialDirs: ['../x'] }).some((p) => /\.\./.test(p)));
  // The user's own credentials, and every folder above or inside them, are never a provider's (by segment, any case).
  // public-name-ok: the archive's home is refused like the keys
  for (const dir of ['.ssh', '.SSH', '.ssh/keys', '.aws', '.gnupg', '.config', '.config/gcloud', '.config/GCloud/legacy', '.kube', '.docker', '.npmrc', '.timon', '.pkos', '.local', '.local/share', '.cache']) {
    assert.ok(declare({ credentialDirs: [dir] }).some((p) => /declares\.credentialDirs/.test(p)), `${dir} must be refused`);
  }
  // Another built-in backend's folder is refused too; the backend's own provider may name it.
  assert.ok(declare({ credentialDirs: ['.claude'] }).some((p) => /credential folder of the `claude` backend/.test(p)));
  assert.ok(declare({ credentialDirs: ['.codex/sessions'] }).some((p) => /`codex` backend/.test(p)));
  assert.deepEqual(declare({ credentialDirs: ['.acme', '.config/acme', '.local/share/acme'] }), []);
  assert.ok(declare({ passthroughEnv: ['GITHUB_TOKEN'] }).some((p) => /reads like a credential/.test(p)));
  assert.ok(declare({ passthroughEnv: ['TIMON_HOME'] }).some((p) => /belongs to Timon/.test(p)));
  assert.ok(declare({ passthroughEnv: ['AWS_SECRET_ACCESS_KEY'] }).length > 0);
  assert.deepEqual(declare({ passthroughEnv: ['COPILOT_HOME', 'GH_HOST'] }), []);
  assert.ok(declare({ brand: { svg: '<svg><script>alert(1)</script></svg>' } }).some((p) => /plain picture/.test(p)));
  assert.ok(declare({ brand: { svg: '<svg onload="x()"></svg>' } }).length > 0);
  assert.ok(declare({ brand: { svg: '<svg><image href="https://evil.test/x.png"/></svg>' } }).length > 0);
  assert.deepEqual(declare({ brand: { svg: '<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>' } }), []);
  assert.ok(declare({ binary: { names: ['acme'], searchDirs: { win32: ['C:\\x'] } } }).some((p) => /backslash/.test(p)));
  assert.ok(declare({ binary: { names: ['acme'], install: { beos: { kind: 'none' } } } }).some((p) => /not an OS/.test(p)));
  assert.ok(declare({ oneShot: { model: '' } }).length > 0);
  assert.ok(declare({ capabilities: { worktrees: false } }).some((p) => /unknown capability/.test(p)));
});

/* ── Through the plugin context ──────────────────────────────────────────── */

test('registerProvider registers a dialect the registry and the runner already speak', () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-a');
  try {
    const release = ctx.provider.registerProvider(perTurn('acme-a'));
    const dialect = registry.getDialect('acme-a');
    assert.ok(dialect && !('transport' in dialect && dialect.transport === 'remote'));
    assert.equal((dialect as { persistentProcess: boolean }).persistentProcess, false);
    assert.equal((dialect as { finishMissionOnExit: boolean }).finishMissionOnExit, false);
    assert.equal((dialect as { defaultCmd: string }).defaultCmd, 'acme-agent');
    assert.equal(registry.registeredBackendOwners().dialects['acme-a'], 'acme-plugin-a');
    assert.deepEqual(registry.dialectDeclarations('acme-a')?.binary?.names, ['acme-agent', 'acme']);
    release();
    assert.equal(registry.getDialect('acme-a'), undefined);
    assert.equal(registry.dialectDeclarations('acme-a'), undefined, 'the declarations leave with the provider');
  } finally {
    restore();
  }
});

test('a persistent session-driven provider and a remote one adapt to what the runner reads', () => {
  const restore = allowExec('acme-acp');
  const ctx = pluginContext('acme-plugin-b');
  try {
    const releaseDriver = ctx.provider.registerProvider(persistentDriver('acme-b-acp'));
    const driver = registry.getDialect('acme-b-acp') as unknown as Record<string, unknown>;
    assert.equal(driver.persistentProcess, true);
    assert.equal(driver.finishMissionOnExit, true);
    assert.equal(typeof driver.openSession, 'function');
    assert.equal(typeof (driver.permissionsByAgent as (id: string) => boolean)('any'), 'boolean');
    assert.equal(driver.permissionModel, 'protocol');
    const releaseRemote = ctx.provider.registerProvider(remote('acme-b-remote'));
    const remoteDialect = registry.getDialect('acme-b-remote') as unknown as Record<string, unknown>;
    assert.equal(remoteDialect.transport, 'remote');
    assert.equal(typeof remoteDialect.extractSessionId, 'function');
    releaseDriver(); releaseRemote();
  } finally {
    restore();
  }
});

test('REFUSAL: the binary must be authorized twice — by the manifest, and by the operator', () => {
  const ctx = pluginContext('acme-plugin-c', [{ name: 'acme-agent' }]);
  // The operator allowlist is empty: nothing is executable by a plugin.
  assert.throws(() => ctx.provider.registerProvider(perTurn('acme-c')), PluginPolicyError);
  const restore = allowExec('acme-agent');
  try {
    // The manifest lists `acme-agent` but the definition also declares the alias `acme`.
    assert.throws(() => ctx.provider.registerProvider(perTurn('acme-c')), /`acme` is declared.*not in the manifest's `provider.binaries`/);
    const other = perTurn('acme-c');
    (other.declares as { binary: { names: string[] } }).binary.names = ['acme-agent'];
    ctx.provider.registerProvider(other)();
  } finally {
    restore();
  }
});

test('REFUSAL: an incoherent definition never reaches the registry', () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-d');
  try {
    const bad = perTurn('acme-d') as unknown as Record<string, unknown>;
    bad.permission = { model: 'protocol' };
    assert.throws(() => ctx.provider.registerProvider(bad as unknown as NativeProviderDefinition), (error: unknown) =>
      error instanceof registry.ProviderDefinitionError && /protocol/.test(error.message));
    assert.equal(registry.getDialect('acme-d'), undefined);
    bad.permission = { model: 'sandbox', supportedModes: ['bypassPermissions', 'everything'] };
    assert.throws(() => ctx.provider.registerProvider(bad as unknown as NativeProviderDefinition), (error: unknown) =>
      error instanceof registry.ProviderDefinitionError && /supportedModes/.test(error.message));
    assert.equal(registry.getDialect('acme-d'), undefined);
  } finally {
    restore();
  }
});

test('supportedModes reaches the dialect the catalogue is built from', () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-modes');
  try {
    const release = ctx.provider.registerProvider({ ...perTurn('acme-modes'), permission: { model: 'sandbox', supportedModes: ['plan', 'bypassPermissions'] } });
    assert.deepEqual(registry.getDialect('acme-modes')?.supportedPermissionModes, ['plan', 'bypassPermissions']);
    release();
    assert.equal(registry.getDialect('acme-modes'), undefined);
  } finally {
    restore();
  }
});

test('REFUSAL: a plugin cannot take a product id, nor another plugin\'s', () => {
  const restore = allowExec('acme-agent');
  try {
    const ctxA = pluginContext('acme-plugin-e');
    const ctxB = pluginContext('acme-plugin-f');
    assert.throws(() => ctxA.provider.registerProvider(perTurn('claude')), /provider-claude/);
    const release = ctxA.provider.registerProvider(perTurn('acme-e'));
    assert.throws(() => ctxB.provider.registerProvider(perTurn('acme-e')), /already registered/);
    assert.throws(() => ctxB.provider.replaceProvider(perTurn('acme-e')), /not registered by `acme-plugin-f`/);
    release();
  } finally {
    restore();
  }
});

test('registerProvider needs apiVersion 12, like the rest of ctx.provider', () => {
  const ctx = pluginContext('acme-plugin-g', [{ name: 'acme-agent' }], 11);
  assert.throws(() => ctx.provider.registerProvider(perTurn('acme-g')), /needs apiVersion 12/);
  assert.throws(() => ctx.provider.replaceProvider(perTurn('acme-g')), /needs apiVersion 12/);
});

/* ── replaceProvider ─────────────────────────────────────────────────────── */

test('replaceProvider swaps the dialect in one step: the backend is never absent, the old release is inert', () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-h');
  try {
    const first = perTurn('acme-h');
    const releaseFirst = ctx.provider.registerProvider(first);
    const before = registry.getDialect('acme-h');
    const absent: boolean[] = [];
    const stop = registry.onBackendsChanged(() => absent.push(registry.getDialect('acme-h') === undefined));

    const second = perTurn('acme-h');
    (second.declares as { binary: { names: string[] } }).binary.names = ['acme-agent'];
    (second.session as { maxPromptBytes?: number }).maxPromptBytes = 90_000;
    const releaseSecond = ctx.provider.replaceProvider(second);
    stop();

    const after = registry.getDialect('acme-h');
    assert.notEqual(after, before);
    assert.equal((after as { maxPromptBytes?: number }).maxPromptBytes, 90_000);
    assert.ok(absent.length > 0 && absent.every((missing) => !missing), 'no observer ever found the backend missing');
    assert.deepEqual(registry.dialectDeclarations('acme-h')?.binary?.names, ['acme-agent'], 'the declarations moved with it');

    releaseFirst();
    assert.ok(registry.getDialect('acme-h'), 'releasing the replaced registration leaves the live one alone');
    releaseSecond();
    assert.equal(registry.getDialect('acme-h'), undefined);
  } finally {
    restore();
  }
});

test('replaceProvider is refused when the transport or the session store would change', () => {
  const restore = allowExec('acme-agent', 'acme-acp');
  const ctx = pluginContext('acme-plugin-i');
  try {
    const release = ctx.provider.registerProvider(perTurn('acme-i'));
    const toPersistent = persistentDriver('acme-i');
    assert.throws(() => ctx.provider.replaceProvider(toPersistent), (error: unknown) =>
      error instanceof registry.HotUpdateRefusedError && /transport changed/.test(error.message));
    const otherStore = perTurn('acme-i');
    otherStore.session = { store: 'global', resumable: true };
    assert.throws(() => ctx.provider.replaceProvider(otherStore), /session store changed/);
    assert.ok(registry.getDialect('acme-i'), 'the previous version keeps serving');
    release();
  } finally {
    restore();
  }
});

/* ── What the core reads (C1, C2, C3, C4, C5, C7) ────────────────────────── */

test('C1: the host adapter looks where the provider said, and installs as it said', () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-j');
  try {
    const def = perTurn('acme-j');
    def.declares = {
      binary: {
        names: ['acme-agent'],
        searchDirs: { any: ['~/.acme/bin'], win32: ['${LOCALAPPDATA}/Programs/Acme'], linux: ['${ACME_PREFIX}/bin'] },
        install: { any: { kind: 'none' }, darwin: { kind: 'npm', package: '@acme/agent' } },
      },
    };
    const release = ctx.provider.registerProvider(def);
    const linux = binaryCandidates('acme-agent', { platform: 'linux', homeDir: '/home/t', env: { ACME_PREFIX: '/opt/acme' }, path: '/usr/bin' });
    assert.ok(linux.includes('/home/t/.acme/bin/acme-agent') && linux.includes('/opt/acme/bin/acme-agent'));
    const noPrefix = binaryCandidates('acme-agent', { platform: 'linux', homeDir: '/home/t', env: {}, path: '/usr/bin' });
    assert.equal(noPrefix.some((p) => p.includes('${')), false, 'a folder that needs an unset variable is dropped, not searched literally');
    const windows = binaryCandidates('acme-agent', { platform: 'win32', homeDir: 'C:\\Users\\t', env: { LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }, path: '' });
    assert.ok(windows.some((p) => p.toLowerCase().endsWith('\\programs\\acme\\acme-agent.exe')), JSON.stringify(windows));

    assert.equal(installPlanFor('acme-agent', { platform: 'linux', packageManager: 'apt' }), null, 'an honest blank, not `sudo apt-get install acme-agent`');
    assert.deepEqual(installPlanFor('acme-agent', { platform: 'darwin', packageManager: null })?.argv, ['npm', 'install', '-g', '@acme/agent']);
    release();
    assert.notEqual(installPlanFor('acme-agent', { platform: 'linux', packageManager: 'apt' }), null, 'with the provider gone, the generic rule is back');
  } finally {
    restore();
  }
});

test('C1: a build folder the provider declared is a stale-able pin, not an error', () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-k');
  try {
    const def = perTurn('acme-k');
    def.declares = { binary: { names: ['acme-agent'], desktopBuilds: [{ platform: 'darwin', root: '~/Library/Acme/builds', executable: ['acme.app', 'Contents', 'MacOS', 'acme'], order: 'semver' }] } };
    const release = ctx.provider.registerProvider(def);
    const reader = {
      subdirectories: () => ['1.2.0', '1.10.0', 'junk'],
      fileMtimeMs: (file: string) => (file.includes('junk') ? 5 : 1),
    };
    const candidates = binaryCandidates('acme-agent', { platform: 'darwin', homeDir: '/Users/t', env: {}, path: '', directoryReader: reader });
    const builds = candidates.filter((p) => p.includes('/builds/'));
    assert.deepEqual(builds.map((p) => p.split('/builds/')[1]!.split('/')[0]), ['1.10.0', '1.2.0', 'junk'], 'highest version first, then the unversioned');
    release();
  } finally {
    restore();
  }
});

test('C2: another provider\'s sign-in folder is masked, the mission\'s own is spared', () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-l', undefined, 12, ['.acme', '.config/acme']);
  try {
    const def = perTurn('acme-l');
    def.declares = { binary: { names: ['acme-agent'] }, credentialDirs: ['.acme', '.config/acme'] };
    const release = ctx.provider.registerProvider(def);
    registry.registerProfile('acme-plugin-l', { id: 'acme-l-profile', dialect: 'acme-l', label: 'Acme', models: [], defaultModel: null });
    const cfg = TimonConfigSchema.parse({});
    const home = '/home/tester';
    const onClaude = resolveIsolation(cfg, { home, backend: 'claude' });
    assert.ok(onClaude.deny.includes(`${home}/.acme`) && onClaude.deny.includes(`${home}/.config/acme`), 'a claude mission cannot read acme\'s sign-in');
    const onAcme = resolveIsolation(cfg, { home, backend: 'acme-l-profile' });
    assert.equal(onAcme.deny.includes(`${home}/.acme`), false, 'acme\'s own mission keeps it');
    assert.ok(onAcme.deny.includes(`${home}/.claude`), 'and still cannot read claude\'s');
    release();
    assert.equal(resolveIsolation(cfg, { home, backend: 'claude' }).deny.includes(`${home}/.acme`), false);
  } finally {
    restore();
  }
});

test('C3: a declared tier and rank make a provider a candidate of the automatic fallback', () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-m');
  try {
    const release = ctx.provider.registerProvider(perTurn('acme-m'));
    registry.registerProfile('acme-plugin-m', {
      id: 'acme-m-profile', dialect: 'acme-m', label: 'Acme', fallbackRank: 5, defaultModel: 'acme-big',
      models: [{ slug: 'acme-big', label: 'big', tier: 'flagship' }, { slug: 'acme-small', label: 'small', tier: 'small' }],
    });
    assert.equal(tierOf('acme-m-profile', 'acme-small'), 'small');
    assert.equal(tierOf('acme-m-profile', 'acme-big'), 'flagship');
    // Every product backend is out of the running: the declared one is the only candidate left.
    const target = defaultEquivalentFallback('claude', 'opus', (backend) => backend === 'acme-m-profile');
    assert.deepEqual(target, { backend: 'acme-m-profile', model: 'acme-big' }, 'a flagship falls back on a flagship');
    assert.equal(defaultEquivalentFallback('claude', 'haiku', (backend) => backend === 'acme-m-profile')?.model, 'acme-small');
    // Without a declared rank it is never chosen automatically.
    registry.registerProfile('acme-plugin-m', { id: 'acme-m-unranked', dialect: 'acme-m', label: 'U', defaultModel: 'x', models: [{ slug: 'x', label: 'x' }] });
    assert.equal(defaultEquivalentFallback('claude', 'opus', (backend) => backend === 'acme-m-unranked'), null);
    release();
  } finally {
    restore();
  }
});

test('a third-party provider is never ahead of the product\'s in the automatic fallback, whatever rank it declares', () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-rank');
  try {
    const release = ctx.provider.registerProvider(perTurn('acme-r'));
    registry.registerProfile('acme-plugin-rank', {
      id: 'acme-r-profile', dialect: 'acme-r', label: 'Acme', fallbackRank: -100, defaultModel: 'acme-big',
      models: [{ slug: 'acme-big', label: 'big', tier: 'flagship' }],
    });
    const asked: string[] = [];
    defaultEquivalentFallback('opencode', null, (backend) => { asked.push(backend); return false; });
    assert.ok(asked.includes('acme-r-profile') && asked.includes('claude'));
    assert.ok(asked.indexOf('claude') < asked.indexOf('acme-r-profile'), `asked in the order ${asked.join(', ')}`);
    release();
  } finally {
    restore();
  }
});

test('C5: what a third-party provider declares for the daemon\'s own tasks is ignored', async () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-os');
  try {
    const release = ctx.provider.registerProvider({ ...perTurn('acme-os'), declares: { binary: { names: ['acme-agent', 'acme'] }, oneShot: { model: 'acme-big' } } });
    registry.registerProfile('acme-plugin-os', { id: 'acme-os-profile', dialect: 'acme-os', label: 'Acme', defaultModel: 'acme-big', models: [{ slug: 'acme-big', label: 'big' }] });
    const { tryDefaultBackendName, oneShotTarget } = await import('../backends/index.js');
    const { isTemplateBackend } = await import('../agent-seed.js');
    assert.equal(registry.profileDeclarations('acme-os-profile')?.oneShot?.model, 'acme-big', 'declared, and readable');
    assert.deepEqual(registry.oneShotProfiles().map((entry) => entry.id), ['claude']);
    assert.ok(!registry.oneShotProviderIds().includes('acme-os-profile'));
    assert.equal(isTemplateBackend('acme-os-profile'), false, 'no template privilege');
    assert.equal(tryDefaultBackendName(), 'claude');
    assert.equal(oneShotTarget('acme-big').backend, 'claude');
    release();
  } finally {
    restore();
  }
});

test('C3: a tier outside the closed list, or a rank that is not a number, is refused at registration', () => {
  assert.throws(() => registry.registerProfile('acme-plugin-n', {
    id: 'acme-n', dialect: 'claude', label: 'N', defaultModel: null,
    models: [{ slug: 'm', label: 'm', tier: 'huge' as never }],
  }), /tier `huge`/);
  assert.throws(() => registry.registerProfile('acme-plugin-n', {
    id: 'acme-n2', dialect: 'claude', label: 'N', defaultModel: null, fallbackRank: Number.NaN, models: [],
  }), /fallbackRank/);
});

test('C4 and C5: the provider says whether the user is signed in, and declares it can serve the daemon\'s own tasks', async () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-o');
  try {
    const def = perTurn('acme-o');
    def.declares = {
      binary: { names: ['acme-agent'] },
      oneShot: { model: 'acme-fast' },
      authStatus: (env) => (env.ACME_KEY ? { ok: true, detail: 'signed in', signInCommand: null } : { ok: false, detail: 'no key', signInCommand: 'acme login' }),
    };
    const release = ctx.provider.registerProvider(def);
    registry.registerProfile('acme-plugin-o', { id: 'acme-o-profile', dialect: 'acme-o', label: 'O', defaultModel: null, models: [] });
    assert.deepEqual(await registry.providerAuthStatus('acme-o-profile', {}), { ok: false, detail: 'no key', signInCommand: 'acme login' });
    assert.equal((await registry.providerAuthStatus('acme-o-profile', { ACME_KEY: 'k' }))?.ok, true);
    assert.equal(await registry.providerAuthStatus('acme-unknown'), null, 'a provider with no declaration says nothing, which is not "signed out"');
    // Declared and readable, but the daemon's own tasks carry every mission's transcript: a
    // third-party provider is never asked to serve them (see the test above).
    assert.equal(registry.profileDeclarations('acme-o-profile')?.oneShot?.model, 'acme-fast');
    assert.deepEqual(registry.oneShotProfiles().filter((p) => p.id === 'acme-o-profile'), []);
    release();
  } finally {
    restore();
  }
});

test('C7: `spans: stream-json` is claude\'s span normaliser, and a function is used as is', () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-p');
  try {
    const stream = perTurn('acme-p1');
    stream.declares = { binary: { names: ['acme-agent'] }, spans: 'stream-json' };
    const own = perTurn('acme-p2');
    const custom = (): never[] => [];
    own.declares = { binary: { names: ['acme-agent'] }, spans: custom };
    const none = perTurn('acme-p3');
    const releases = [ctx.provider.registerProvider(stream), ctx.provider.registerProvider(own), ctx.provider.registerProvider(none)];
    assert.equal((registry.getDialect('acme-p1') as { spans?: unknown }).spans, providerRuntime.spans.streamJsonSpans);
    assert.equal((registry.getDialect('acme-p2') as { spans?: unknown }).spans, custom);
    assert.equal((registry.getDialect('acme-p3') as { spans?: unknown }).spans, undefined, 'not traced');
    for (const release of releases) release();
  } finally {
    restore();
  }
});

test('C6: the variables a provider declared passthrough reach its process, and its own spec wins', async () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-q');
  const { getBackend } = await import('../backends/index.js');
  process.env.ACME_HOME_WITNESS = '/daemon/acme';
  process.env.ACME_OTHER_WITNESS = '/daemon/other';
  process.env.ACME_UNDECLARED_WITNESS = 'nope';
  try {
    const def = perTurn('acme-q');
    def.declares = { binary: { names: ['acme-agent'] }, passthroughEnv: ['ACME_HOME_WITNESS', 'ACME_OTHER_WITNESS', 'ACME_ABSENT_WITNESS'] };
    def.launch = async (spawn, profile) => ({
      cmd: profile.cmd, args: [spawn.message], cwd: spawn.cfg.cwd, initialStdin: null, env: { ACME_OTHER_WITNESS: '/spec/wins' },
    });
    const release = ctx.provider.registerProvider(def);
    registry.registerProfile('acme-plugin-q', { id: 'acme-q-profile', dialect: 'acme-q', label: 'Q', models: [], defaultModel: null });
    const spec = await getBackend('acme-q-profile').buildSpawn({
      agentName: 'a', systemPrompt: '', message: 'hi', resumeSession: null, cfg: { cwd: process.cwd() }, missionId: 'm-q',
    } as never);
    assert.equal(spec.env?.ACME_HOME_WITNESS, '/daemon/acme');
    assert.equal(spec.env?.ACME_OTHER_WITNESS, '/spec/wins');
    assert.equal(spec.env?.ACME_UNDECLARED_WITNESS, undefined);
    assert.equal('ACME_ABSENT_WITNESS' in (spec.env ?? {}), false);
    release();
  } finally {
    delete process.env.ACME_HOME_WITNESS;
    delete process.env.ACME_OTHER_WITNESS;
    delete process.env.ACME_UNDECLARED_WITNESS;
    restore();
  }
});

test('C6: a passthrough name that reads like a credential refuses the provider', () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-r');
  try {
    const def = perTurn('acme-r');
    def.declares = { binary: { names: ['acme-agent'] }, passthroughEnv: ['GITHUB_TOKEN'] };
    assert.throws(() => ctx.provider.registerProvider(def), /reads like a credential/);
    assert.equal(registry.getDialect('acme-r'), undefined);
  } finally {
    restore();
  }
});

test('C9: the logo a provider declared reaches the catalogue as an image; the user\'s own choice still wins', async () => {
  const restore = allowExec('acme-agent');
  const ctx = pluginContext('acme-plugin-s');
  const { catalogBackend } = await import('../backends/catalog.js');
  const svg = '<svg viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';
  try {
    const def = perTurn('acme-s');
    def.declares = { binary: { names: ['acme-agent'] }, brand: { svg } };
    const release = ctx.provider.registerProvider(def);
    registry.registerProfile('acme-plugin-s', { id: 'acme-s-profile', dialect: 'acme-s', label: 'S', models: [], defaultModel: null });
    registry.registerProfile('acme-plugin-s', { id: 'acme-s-chosen', dialect: 'acme-s', label: 'S2', icon: '🦊', models: [], defaultModel: null });
    const icon = catalogBackend('acme-s-profile')?.icon ?? '';
    assert.match(icon, /^data:image\/svg\+xml;base64,/);
    assert.equal(Buffer.from(icon.split(',')[1]!, 'base64').toString('utf8'), svg);
    assert.equal(catalogBackend('acme-s-chosen')?.icon, '🦊');
    release();
  } finally {
    restore();
  }
});

test('credential folders: the manifest lists them, the definition cannot declare others, nobody gets the user\'s keys', () => {
  const restore = allowExec('acme-agent');
  try {
    // Declared in the code but not in the manifest the operator saw: refused.
    const unlisted = perTurn('acme-m');
    unlisted.declares = { binary: { names: ['acme-agent'] }, credentialDirs: ['.acme'] };
    assert.throws(() => pluginContext('acme-plugin-m').provider.registerProvider(unlisted), /not in the manifest's `provider.credentialDirs`/);
    // Listed: accepted.
    pluginContext('acme-plugin-m2', undefined, 12, ['.acme']).provider.registerProvider({ ...unlisted, id: 'acme-m2' })();

    // The user's own credential stores are refused in the manifest itself, and in the code even if a manifest listed them.
    for (const dir of ['.ssh', '.aws', '.config', '.gnupg', '.config/gcloud']) {
      const res = readManifest({ timon: { id: 'acme-plugin-n', apiVersion: 12, kind: 'provider', permissions: ['backends:register'], provider: { binaries: [], credentialDirs: [dir] } } });
      assert.equal(res.ok, false, `${dir} must not pass the manifest`);
      const hostile = perTurn('acme-n');
      hostile.declares = { binary: { names: ['acme-agent'] }, credentialDirs: [dir] };
      assert.throws(() => pluginContext('acme-plugin-n', undefined, 12, ['.acme']).provider.registerProvider(hostile), /credentialDirs/, dir);
    }
  } finally {
    restore();
  }
});
