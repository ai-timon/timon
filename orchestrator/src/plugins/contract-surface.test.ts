/**
 * Snapshot of the `PluginContext` SURFACE (§10.15).
 *
 * The compile-time guards at the end of `context.ts` freeze a few signatures;
 * this test freezes the whole shape. It walks a REAL context — the one a
 * plugin receives — and compares every member, sub-member and function arity
 * to `contract-surface.json`, which is versioned alongside the code.
 *
 * Why a JSON file rather than assertions written here: an open-core product
 * promises that a plugin compiled today keeps working tomorrow. The promise is
 * only credible if breaking it requires EDITING A FILE THAT SAYS SO. Removing
 * `ctx.usage.list` fails this test; adding `ctx.acme` fails it too, until the
 * file records it with the `since` version that introduced it — which is how a
 * reader knows what a daemon of a given contract offers.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Context } from '@deepseek-ai/cordis';

const { readManifest, PLUGIN_API_VERSION, PLUGIN_PERMISSIONS } = await import('./manifest.js');
const { createPluginContext } = await import('./context.js');

type Entry = { type: string; arity?: number; since: number };
type TypeEntry = { since: number; signature: string; members: Record<string, string> };
type RuntimeEntry = { type: string; arity?: number; value?: unknown; since: number };
type Snapshot = {
  apiVersion: number;
  members: Record<string, Entry>;
  providerTypes?: Record<string, TypeEntry>;
  /** Runtime exports of `@timon-ai/sdk/provider` and `/testing` (API 11; the behaviour left the package for `ctx.provider.runtime` in API 12). */
  kitExports?: Record<string, RuntimeEntry>;
  /** Types of the provider kit (API 11). */
  kitTypes?: Record<string, TypeEntry>;
  /** Types of a dictation engine and of its manifest block (API 14). */
  dictationTypes?: Record<string, TypeEntry>;
};

const PROVIDER_TYPE_NAMES = ['BackendProfile', 'RegisteredProfile', 'Dialect', 'EnvResolver', 'SecretRef', 'SettingRef',
  'BuildSpawnOpts', 'SpawnResult', 'ProfileRuntime', 'ProviderConfig', 'NormalizedEvent',
  'PermissionModel', 'RateLimitReporting', 'SessionStore', 'ImageAttachment', 'CatalogModel', 'LocalBackendFile',
  'LocalEnvPolicy', 'DiscoveredModel', 'ModelReasoning', 'ReasoningControl', 'DeclaredReasoningControl',
  'RemoteDialect', 'RemoteSessionOpenArgs', 'RemoteSessionHost', 'SessionEnd', 'SessionDriver', 'SessionHost',
  'SessionInfo', 'SessionCapabilities', 'TurnOutcome', 'PermissionRequest', 'PermissionDecision', 'PermissionWait', 'ApprovalScope',
  'BackendCapabilities', 'BackendLaunchContext', 'RemoteResumeState', 'RemoteSessionResume',
  'SessionAskRequest', 'SessionAskOutcome', 'SessionAnswer', 'SessionQuestion', 'SessionQuestionOption'];

/**
 * The shape of the named exports of `entry`, as the contract freezes it.
 *
 * A union of object shapes (`ReasoningControl`) has no properties of its own and
 * prints as its alias name, so it would freeze as nothing at all: each variant
 * is recorded instead, expanded and in a stable order, so changing, adding or
 * removing one changes the snapshot.
 *
 * `expandLiterals` does the same for a union of literals (`'busy' | 'crashed'`),
 * which also prints as its alias name. Opt-in: the provider snapshots were
 * recorded without it, and turning it on for them would read as a change.
 */
export function describeTypeExports(entry: string, names: readonly string[], expandLiterals = false): Record<string, Omit<TypeEntry, 'since'>> {
  const program = ts.createProgram([entry], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, skipLibCheck: true, strict: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry)!;
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!);
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  const print = (value: ts.Type) => checker.typeToString(value, source, flags);
  const result: Record<string, Omit<TypeEntry, 'since'>> = {};
  for (const name of names) {
    const exported = exports.find(symbol => symbol.name === name);
    if (!exported) continue;
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const objectVariants = type.isUnion() && type.types.some(variant => variant.flags & ts.TypeFlags.Object);
    const literalVariants = expandLiterals && type.isUnion() && type.types.every(variant => variant.isLiteral());
    const members = objectVariants || literalVariants
      ? Object.fromEntries((type as ts.UnionType).types.map(variant => checker.typeToString(variant, source, flags | ts.TypeFormatFlags.InTypeAlias))
        .sort().map((text, index) => [`|${index}`, text]))
      : Object.fromEntries((type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection) ? type.getProperties() : []).map(member => [
        member.name + (member.flags & ts.SymbolFlags.Optional ? '?' : ''),
        print(checker.getTypeOfSymbolAtLocation(member, source)),
      ]));
    result[name] = {
      signature: type.getCallSignatures().map(sig => checker.signatureToString(sig, source, flags)).join('; ') || print(type),
      members,
    };
  }
  return result;
}

// Resolve exports through the public entry point, so an internal type alone
// cannot make a removed SDK export pass this compatibility check.
function providerTypeSurface(): Record<string, Omit<TypeEntry, 'since'>> {
  return describeTypeExports(join(dirname(fileURLToPath(import.meta.url)), '../../..', 'packages/sdk/src/index.ts'), PROVIDER_TYPE_NAMES);
}
const providerTypes = providerTypeSurface();

/**
 * What a dictation engine is written against (`kind: dictation`, API 14). The
 * product checks every event an engine emits against these shapes, so a change
 * here changes what third-party engines may send.
 */
const DICTATION_TYPE_NAMES = ['DictationEngine', 'DictationSession', 'DictationEvent', 'DictationErrorCode',
  'DictationAvailability', 'DictationStartOptions', 'DictationLanguages', 'DictationInterim',
  'PluginDictationDecl', 'PluginDictationEngineDecl'];
const dictationTypes = describeTypeExports(join(dirname(fileURLToPath(import.meta.url)), '../../..', 'packages/sdk/src/index.ts'), DICTATION_TYPE_NAMES, true);

/** Types of the provider kit that authors write against (the rest of the kit's types are plumbing). */
const KIT_TYPE_NAMES: Record<'provider' | 'testing', readonly string[]> = {
  provider: ['Backend', 'ProviderAgentConfig', 'ProviderDefinition', 'LinesCodec', 'ProcessDriverCodec', 'RemoteDriverCodec',
    'SessionStrategy', 'PermissionStrategy', 'LimitsStrategy', 'McpStrategy', 'UsageStrategy', 'LifecycleStrategy',
    'ProviderTransportKind', 'NestedSandboxDeclaration', 'McpLaunchServer', 'McpLaunchStdio', 'McpLaunchHttp', 'RpcMessage', 'RpcId', 'RateLimitHit',
    'TokenUsage', 'SessionOpenArgs', 'SessionStdio', 'AccountUsage', 'UsageWindow', 'UsageProbeOptions', 'SpanOp', 'SpanState', 'OpenSpan',
    'AcpMcpServer', 'AcpRecord', 'AcpUsage', 'RefreshedToken', 'ProcessSessionArgs', 'LegacyLaunch', 'ProviderPluginContext',
    // `ProviderServices` and `ProviderRuntime` are frozen member by member under `members` (`provider.*`), not as
    // one type: the runtime's type prints as the whole of its signatures, which no snapshot can usefully hold.
    'ProviderMcpPlan', 'ProviderMcpServer', 'ProviderMcpOptions', 'ProviderEnvPlan', 'NativeProviderDefinition', 'ProviderDeclarations',
    'ProviderBinaryDeclaration', 'LaunchStrategy', 'ModelsStrategy', 'ReasoningStrategy', 'ProviderScratchDir', 'ProviderScratch',
    'ProviderRedact', 'ProviderBinary', 'ProviderMedia', 'ProviderOsCredentials', 'ProviderProbeOptions',
    'ProviderProbeResult', 'ProviderServeOptions', 'ProviderServer', 'ProviderGeneratedMedia',
    'ProviderAccount', 'ProviderAccountContext', 'ProviderAccountsDeclaration', 'ProviderLoginDriver', 'AcpAgentSpec', 'AcpSignIn',
    'AcpExtensionHandler', 'AcpExtensionCards', 'AcpCardQuestion', 'AcpCardOption', 'AcpCardAnswer', 'AcpCardOutcome',
    'AcpPlanApproval', 'AcpPlanVerdict', 'ProviderBinaryIdentity', 'ProviderUnverified'],
  testing: ['ConformanceCheck', 'ConformanceContext', 'LineExpectation', 'RemoteExpectation', 'TestFn', 'BoundProfile',
    'FakeCli', 'FakeCliOptions', 'ReplayResult', 'Chunking', 'ProviderContextOptions', 'LoggedLine',
    // The dictation bench (API 14): what an engine author writes a test against.
    'DictationExpectation', 'DictationRunOptions', 'DictationRun', 'DictationErrorEvent', 'FakeDictationEngine',
    'FakeDictationEngineOptions', 'FakeDictationSessionRecord', 'FakeHearing'],
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function kitTypeSurface(): Record<string, Omit<TypeEntry, 'since'>> {
  const out: Record<string, Omit<TypeEntry, 'since'>> = {};
  for (const [entry, names] of Object.entries(KIT_TYPE_NAMES)) {
    Object.assign(out, describeTypeExports(join(REPO_ROOT, `packages/sdk/src/${entry}.ts`), names));
  }
  return out;
}
const kitTypes = kitTypeSurface();

/** Runtime exports of the two kit entry points: what they are, and the value of a plain constant. */
async function kitRuntimeSurface(): Promise<Record<string, Omit<RuntimeEntry, 'since'>>> {
  const out: Record<string, Omit<RuntimeEntry, 'since'>> = {};
  for (const entry of ['provider', 'testing'] as const) {
    const mod = await import(`../../../packages/sdk/src/${entry}.js`) as Record<string, unknown>;
    for (const name of Object.keys(mod).sort()) {
      const member = mod[name];
      const path = `${entry}.${name}`;
      // The contract constants are frozen by value (a changed list of permission models is a
      // change of contract); the bench's own data (hostile inputs) is only frozen by kind.
      const frozen = entry === 'provider';
      if (typeof member === 'function') out[path] = { type: 'function', arity: member.length };
      else if (Array.isArray(member)) out[path] = { type: 'array', ...(frozen ? { value: member } : {}) };
      else if (typeof member === 'string' || typeof member === 'number' || typeof member === 'boolean') {
        out[path] = { type: typeof member, ...(frozen ? { value: member } : {}) };
      } else if (typeof member === 'symbol') out[path] = { type: 'symbol' };
      else if (member !== null && typeof member === 'object') {
        out[path] = { type: 'object', ...(frozen ? { value: JSON.parse(JSON.stringify(member)) } : {}) };
      } else out[path] = { type: member === null ? 'null' : typeof member };
    }
  }
  return out;
}
const kitExports = await kitRuntimeSurface();

const SNAPSHOT_FILE = join(dirname(fileURLToPath(import.meta.url)), 'contract-surface.json');

/**
 * Flat description of an object: `storage.kv.get → { type: 'function',
 * arity: 1 }`. Plain objects are walked; anything else is a leaf, because a
 * plugin sees a class instance or an array as one value, not as a namespace.
 */
export function describeSurface(value: object, prefix = ''): Record<string, { type: string; arity?: number }> {
  const out: Record<string, { type: string; arity?: number }> = {};
  for (const key of Object.keys(value).sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const member = (value as Record<string, unknown>)[key];
    if (typeof member === 'function') {
      out[path] = { type: 'function', arity: member.length };
      continue;
    }
    if (Array.isArray(member)) { out[path] = { type: 'array' }; continue; }
    if (member !== null && typeof member === 'object' && Object.getPrototypeOf(member) === Object.prototype) {
      out[path] = { type: 'object' };
      Object.assign(out, describeSurface(member, path));
      continue;
    }
    out[path] = { type: member === null ? 'null' : typeof member };
  }
  return out;
}

/** Context granting EVERY permission: the snapshot must cover the widest
 *  surface, including members that are absent without their permission
 *  (`fetch`). A narrower context would let a removal go unnoticed. */
function fullContext() {
  const res = readManifest({
    timon: { id: 'surface-probe', apiVersion: PLUGIN_API_VERSION, permissions: [...PLUGIN_PERMISSIONS] },
  });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const store = new Map<string, string>();
  return createPluginContext(new Context(), { manifest: res.manifest, version: '0.0.0' }, {
    mountRouter: () => () => { /* nothing mounted */ },
    kv: {
      get: (p, k) => store.get(`${p} ${k}`),
      set: (p, k, v) => void store.set(`${p} ${k}`, v),
      del: (p, k) => void store.delete(`${p} ${k}`),
      list: () => [],
    },
    missions: { spawn: async () => 'm', get: () => undefined, list: () => [] },
    kanban: { create: () => ({}), update: () => ({}), list: () => [] },
    notify: () => { /* silent */ },
    subscribe: () => () => { /* nothing */ },
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: (async () => new Response('ok')) as unknown as typeof globalThis.fetch,
    dataDir: () => '/tmp/timon-surface-probe',
    tokenKey: () => Buffer.alloc(32, 7),
    secrets: { get: () => undefined },
    usage: {
      list: async () => [],
      get: async () => null,
      registerCollector: () => () => { /* nothing registered */ },
    },
    backends: {
      registerProfile: () => () => { /* nothing registered */ },
      registerDialect: () => () => { /* nothing registered */ },
    },
  });
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) as Snapshot;

/**
 * `TIMON_SURFACE_UPDATE=1` records members that the file does not know yet,
 * stamped with the current apiVersion. It only ever ADDS: a member that
 * disappeared still fails the test, because a removal must be a decision, not
 * the side effect of running the suite.
 */
if (process.env.TIMON_SURFACE_UPDATE === '1') {
  const actual = describeSurface(fullContext());
  const members = { ...snapshot.members };
  for (const [path, entry] of Object.entries(actual)) {
    if (!(path in members)) members[path] = { ...entry, since: PLUGIN_API_VERSION };
  }
  snapshot.providerTypes ??= {};
  for (const [name, shape] of Object.entries(providerTypes)) {
    const known = snapshot.providerTypes[name];
    if (!known) {
      snapshot.providerTypes[name] = { since: PLUGIN_API_VERSION, ...shape };
      continue;
    }
    // A FIELD added to a type the contract already knows — the ordinary way a
    // provider type grows. Recorded only if every field already promised is
    // still there, unchanged: a removal or a changed signature keeps failing
    // the test, because it breaks plugins already compiled against it.
    const grewOnly = Object.entries(known.members).every(([member, type]) => shape.members[member] === type);
    if (!grewOnly) continue;
    snapshot.providerTypes[name] = { since: known.since, ...shape };
  }
  // The provider kit: additive like everything above; a shape that changed is edited by hand.
  snapshot.kitExports ??= {};
  for (const [path, entry] of Object.entries(kitExports)) {
    if (!(path in snapshot.kitExports)) snapshot.kitExports[path] = { ...entry, since: PLUGIN_API_VERSION };
  }
  snapshot.kitTypes ??= {};
  for (const [name, shape] of Object.entries(kitTypes)) {
    const known = snapshot.kitTypes[name];
    if (!known) { snapshot.kitTypes[name] = { since: PLUGIN_API_VERSION, ...shape }; continue; }
    if (Object.entries(known.members).every(([member, type]) => shape.members[member] === type)) {
      snapshot.kitTypes[name] = { since: known.since, ...shape };
    }
  }
  snapshot.dictationTypes ??= {};
  for (const [name, shape] of Object.entries(dictationTypes)) {
    const known = snapshot.dictationTypes[name];
    if (!known) { snapshot.dictationTypes[name] = { since: PLUGIN_API_VERSION, ...shape }; continue; }
    if (Object.entries(known.members).every(([member, type]) => shape.members[member] === type)) {
      snapshot.dictationTypes[name] = { since: known.since, ...shape };
    }
  }
  snapshot.apiVersion = PLUGIN_API_VERSION;
  snapshot.members = Object.fromEntries(Object.entries(members).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
}

test('the snapshot describes the contract this daemon implements', () => {
  assert.equal(snapshot.apiVersion, PLUGIN_API_VERSION,
    '`contract-surface.json` must state the apiVersion of this daemon');
  for (const [path, entry] of Object.entries(snapshot.members)) {
    assert.ok(Number.isInteger(entry.since) && entry.since >= 1 && entry.since <= PLUGIN_API_VERSION,
      `\`${path}\` : \`since\` must be an apiVersion between 1 and ${PLUGIN_API_VERSION}`);
  }
});

test('no member of PluginContext disappears or changes shape', () => {
  const actual = describeSurface(fullContext());
  for (const [path, entry] of Object.entries(snapshot.members)) {
    const found = actual[path];
    assert.ok(found, `\`ctx.${path}\` has disappeared from the contract — removing it breaks every `
      + `plugin already installed. A removal is a MAJOR version, not an edit.`);
    assert.equal(found.type, entry.type, `\`ctx.${path}\` changed type (${entry.type} → ${found.type})`);
    assert.equal(found.arity, entry.arity, `\`ctx.${path}\` changed arity (${entry.arity} → ${found.arity})`);
  }
});

test('a member added to PluginContext is recorded with the version that introduced it', () => {
  const actual = describeSurface(fullContext());
  const undocumented = Object.keys(actual).filter((path) => !(path in snapshot.members));
  assert.deepEqual(undocumented, [],
    'add these members to `plugins/contract-surface.json` with their `since`, and read `docs/SDK-COMPAT.md`');
});


test('provider SDK exports retain their signatures and introduction versions', () => {
  assert.ok(snapshot.providerTypes);
  assert.equal(Object.keys(providerTypes).length, PROVIDER_TYPE_NAMES.length, 'all provider types must be exported by the SDK');
  assert.deepEqual(Object.keys(providerTypes).sort(), Object.keys(snapshot.providerTypes).sort());
  for (const [name, entry] of Object.entries(snapshot.providerTypes)) {
    assert.ok(entry.since >= 1 && entry.since <= PLUGIN_API_VERSION);
    const { since: _since, ...shape } = entry;
    assert.deepEqual(providerTypes[name], shape, `SDK provider type ${name} changed`);
  }
});

test('the dictation engine types keep their shape and their introduction version', () => {
  assert.ok(snapshot.dictationTypes, 'record them with TIMON_SURFACE_UPDATE=1, and read docs/SDK-COMPAT.md');
  assert.deepEqual(Object.keys(dictationTypes).sort(), [...DICTATION_TYPE_NAMES].sort(), 'every dictation type is exported by the SDK');
  assert.deepEqual(Object.keys(snapshot.dictationTypes).sort(), [...DICTATION_TYPE_NAMES].sort());
  for (const [name, entry] of Object.entries(snapshot.dictationTypes)) {
    assert.ok(entry.since >= 14 && entry.since <= PLUGIN_API_VERSION, `${name}: since`);
    const { since: _since, ...shape } = entry;
    assert.deepEqual(dictationTypes[name], shape, `SDK dictation type ${name} changed`);
  }
});

test('the provider kit keeps every runtime export, with its shape and value', () => {
  assert.ok(snapshot.kitExports, 'the kit exports are recorded in contract-surface.json');
  for (const [path, entry] of Object.entries(snapshot.kitExports)) {
    const found = kitExports[path];
    assert.ok(found, `\`@timon-ai/sdk/${path.replace('.', '` export `')}\` has disappeared — a removal breaks every plugin built with the kit: it is a MAJOR version, not an edit.`);
    assert.equal(found.type, entry.type, `${path} changed type`);
    assert.equal(found.arity, entry.arity, `${path} changed arity`);
    assert.deepEqual(found.value, entry.value, `${path} changed value`);
    assert.ok(entry.since >= 11 && entry.since <= PLUGIN_API_VERSION);
  }
});

test('an export added to the provider kit is recorded with the version that introduced it', () => {
  const undocumented = Object.keys(kitExports).filter((path) => !(path in (snapshot.kitExports ?? {})));
  assert.deepEqual(undocumented, [], 'record these with TIMON_SURFACE_UPDATE=1, and read docs/SDK-COMPAT.md');
});

test('the types the provider kit publishes keep their shape', () => {
  assert.ok(snapshot.kitTypes);
  assert.deepEqual(Object.keys(kitTypes).sort(), Object.keys(snapshot.kitTypes).sort());
  for (const [name, entry] of Object.entries(snapshot.kitTypes)) {
    const { since: _since, ...shape } = entry;
    assert.deepEqual(kitTypes[name], shape, `kit type ${name} changed`);
  }
});

test('a change to one variant of a provider union type is detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-contract-'));
  const describe = (body: string) => {
    const file = join(dir, `v${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(file, `export type ReasoningControl =\n${body};\n`);
    return describeTypeExports(file, ['ReasoningControl'])['ReasoningControl']!.members;
  };
  try {
    const frozen = snapshot.providerTypes?.['ReasoningControl']?.members;
    assert.ok(frozen && Object.keys(frozen).length === 3, 'every variant of ReasoningControl is frozen');
    // The declaration as shipped: it must read exactly as the snapshot, or the
    // mutations below would prove nothing.
    const shipped = [
      "| { type: 'levels'; values: string[] }",
      "| { type: 'budget'; min?: number; max?: number }",
      "| { type: 'toggle' }",
    ];
    assert.deepEqual(describe(shipped.join('\n')), frozen);
    const mutations = [
      [shipped[0], "| { type: 'levels'; values: string[]; default?: string }", shipped[2]], // field added
      [shipped[0], "| { type: 'budget'; min: number; max?: number }", shipped[2]], // optional made required
      [shipped[0], "| { type: 'budget'; minimum?: number; max?: number }", shipped[2]], // field renamed
      ["| { type: 'level'; values: string[] }", shipped[1], shipped[2]], // discriminant changed
      [shipped[0], shipped[1]], // variant removed
      [...shipped, "| { type: 'auto' }"], // variant added
    ];
    for (const variants of mutations) {
      assert.notDeepEqual(describe(variants.join('\n')), frozen, `undetected: ${variants.join(' ')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
