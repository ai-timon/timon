/**
 * The product's own providers declare themselves in the vocabulary a plugin writes
 * (`builtin-declarations.ts`), and the core reads those declarations instead of names.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-builtin-declarations-'));

const { BUILTIN_DECLARATIONS, builtinBinaries } = await import('./builtin-declarations.js');
const { mountOfficialProviders, stubCliBinaries } = await import('../../tests/helpers/official-providers.js');
await stubCliBinaries('grok');
await mountOfficialProviders();
const { declarationProblems } = await import('./provider-declarations.js');
const { installedProfiles } = await import('./registry.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { DEFAULT_DENY_HOME_DIRS, resolveIsolation } = await import('../host/isolation.js');
const { declaredBinary, setDeclaredBinariesSource } = await import('../host/declared-binaries.js');
const { INSTALLABLE_BACKENDS } = await import('../host/machine.js');
const { BINARIES, BINARY_NAMES } = await import('../doctor.js');

const HOME = '/home/tester';
const cfg = () => TimonConfigSchema.parse({});

test('every declaration of the product is one a plugin could write', () => {
  for (const [id, declared] of Object.entries(BUILTIN_DECLARATIONS)) {
    assert.deepEqual(declarationProblems(declared, id), [], id);
    assert.ok(installedProfiles().some((profile) => profile.id === id), `${id} declares itself but is no profile of the product`);
  }
});

test('the binaries are listed once, canonical name first', () => {
  const names = builtinBinaries().flatMap((binary) => binary.names);
  assert.equal(new Set(names).size, names.length);
});

test('the doctor lists the AI CLIs the providers declare, in the product order', () => {
  const backends = BINARIES.filter((binary) => binary.backend).map((binary) => binary.name);
  assert.deepEqual(backends, ['claude', 'codex', 'grok', 'copilot', 'opencode', 'hermes-acp', 'pi', 'agy']);
  assert.ok(BINARY_NAMES.includes('pi'));
  assert.ok(!BINARY_NAMES.includes('pi-acp'), 'Pi runs without the pi-acp adapter');
});

test('only providers that declared a standalone installer can be installed from the onboarding', () => {
  assert.deepEqual([...INSTALLABLE_BACKENDS], ['claude', 'codex', 'grok', 'copilot', 'opencode', 'pi', 'agy']);
  // A plugin declaring an installer for its own program never joins the list.
  setDeclaredBinariesSource(() => [{ names: ['acme-agent'], install: { any: { kind: 'script', posix: 'curl https://acme.invalid | sh' } } }]);
  try {
    assert.deepEqual([...INSTALLABLE_BACKENDS], ['claude', 'codex', 'grok', 'copilot', 'opencode', 'pi', 'agy']);
    assert.ok(!BINARY_NAMES.includes('acme-agent'));
  } finally {
    setDeclaredBinariesSource(() => []);
  }
});

test('a plugin cannot narrow what counts as a build of a desktop app: that is the product\'s own field', () => {
  setDeclaredBinariesSource(() => [{
    names: ['acme-agent'],
    desktopBuilds: [{ platform: 'win32', root: '${LOCALAPPDATA}/Acme', executable: ['acme.exe'], order: 'newest', folderPattern: '^x$' } as never],
  }]);
  try {
    const build = declaredBinary('acme-agent')?.desktopBuilds?.[0];
    assert.ok(build);
    assert.equal('folderPattern' in build, false);
  } finally {
    setDeclaredBinariesSource(() => []);
  }
});

test('the sign-in folder of every provider is masked from the others (TODO #402)', () => {
  const { deny } = resolveIsolation(cfg(), { home: HOME, backend: 'claude' });
  for (const dir of ['.copilot', '.config/opencode', '.local/share/opencode', '.hermes', '.gemini/antigravity-cli', '.pi', '.codex', '.grok', '.kimi', '.ollama']) {
    assert.ok(deny.includes(`${HOME}/${dir}`), `~/${dir} must be masked from a claude mission`);
    assert.ok(DEFAULT_DENY_HOME_DIRS.includes(dir), dir);
  }
});

test('Antigravity masks its own folder only: the sign-in of the ACP registry\'s Antigravity agent stays visible to it', () => {
  const { deny } = resolveIsolation(cfg(), { home: HOME, backend: 'acp-antigravity-acp' });
  assert.ok(deny.includes(`${HOME}/.gemini/antigravity-cli`));
  assert.ok(!deny.includes(`${HOME}/.gemini`), 'the whole `.gemini` would take `antigravity-acp` with it');
  assert.ok(!deny.some((path) => path.startsWith(`${HOME}/.gemini/antigravity-acp`)));
});

test('a mission keeps the folders of its own provider, and only those', () => {
  for (const [backend, dirs] of [['opencode', ['.config/opencode', '.local/share/opencode']], ['copilot', ['.copilot']], ['hermes', ['.hermes']], ['antigravity', ['.gemini/antigravity-cli']], ['pi', ['.pi']]] as const) {
    const { deny } = resolveIsolation(cfg(), { home: HOME, backend });
    for (const dir of dirs) assert.ok(!deny.includes(`${HOME}/${dir}`), `${backend} must keep ~/${dir}`);
    assert.ok(deny.includes(`${HOME}/.claude`), `${backend} must not see ~/.claude`);
  }
});

test('C5: the provider that declared oneShot is the default and runs the daemon\'s own tasks', async () => {
  const { tryDefaultBackendName, oneShotTarget } = await import('./index.js');
  assert.equal(tryDefaultBackendName(), 'claude');
  // The operator's model, when it is that provider's or one the catalogue does not know.
  assert.deepEqual(oneShotTarget('claude-sonnet-4-6'), { backend: 'claude', model: 'claude-sonnet-4-6' });
  assert.deepEqual(oneShotTarget('some-new-model'), { backend: 'claude', model: 'some-new-model' });
  // A model of another provider would only fail there: the provider's declared model stands in.
  assert.deepEqual(oneShotTarget('gpt-5.5'), { backend: 'claude', model: 'sonnet' });
  assert.deepEqual(oneShotTarget(''), { backend: 'claude', model: 'sonnet' });
});

test('the catalogue serves the model-name fragments and the sign-in hints, whether or not the provider is active', async () => {
  const { catalogForViewer } = await import('../plugins-bundled/backends/account-routes.js');
  const served = catalogForViewer(null);
  assert.ok(!served.backends.some((entry) => entry.id === 'kimi'), 'no key: the profile is inactive here');
  assert.ok(served.modelBrands.some((hint) => hint.match === 'kimi' && hint.brand === 'moonshot'), 'its models keep their logo');
  const claude = served.backends.find((entry) => entry.id === 'claude');
  assert.equal(claude?.signInCommand, 'claude');
  assert.equal(claude?.signInThen, '/login');
});

test('the doctor reports codex under auth[] only: the deprecated codexAuth field is gone (API 15)', async () => {
  const { diagnose } = await import('../doctor.js');
  const report = diagnose();
  const codex = report.auth.find((entry) => entry.provider === 'codex');
  assert.ok(codex);
  assert.ok(!('codexAuth' in report), 'codexAuth left the report with API 15 (TODO #555)');
});

test('C3: the automatic fallback walks the ranks the profiles declare, then matches the tier', async () => {
  const { defaultEquivalentFallback, tierOf } = await import('./equivalence.js');
  assert.equal(tierOf('claude', 'opus'), 'flagship');
  assert.equal(tierOf('claude', 'haiku'), 'small');
  assert.equal(tierOf('codex', 'gpt-5.6-terra'), 'mid');
  assert.equal(tierOf('grok', 'grok-4.6'), 'flagship');
  assert.equal(tierOf('kimi', 'kimi-k2-thinking'), 'mid');
  // codex (10) before grok (20) before claude (30) before kimi (40).
  const seen: string[] = [];
  defaultEquivalentFallback('opencode', null, (backend) => { seen.push(backend); return false; });
  assert.deepEqual(seen.filter((backend) => ['codex', 'grok', 'claude', 'kimi'].includes(backend)), ['codex', 'grok', 'claude'].filter((backend) => seen.includes(backend)));
  assert.equal(defaultEquivalentFallback('claude', 'opus', (backend) => backend === 'codex')?.model, 'gpt-5.6-sol');
});

test('credentialDirEnv names the variables that move a sign-in folder, and nothing that is Timon\'s or a secret', () => {
  assert.deepEqual(declarationProblems({ credentialDirEnv: ['CODEX_AUTH_DIR', 'GROK_HOME'] }), []);
  for (const bad of ['TIMON_HOME', 'OPENAI_API_KEY', 'lowercase_dir', '1_DIR', 'PATH']) {
    assert.equal(declarationProblems({ credentialDirEnv: [bad] }).length, 1, bad);
  }
  assert.equal(declarationProblems({ credentialDirEnv: 'CODEX_AUTH_DIR' }).length, 1);
  assert.equal(declarationProblems({ credentialDirEnv: ['A_DIR', 'B_DIR', 'C_DIR', 'D_DIR', 'E_DIR'] }).length, 1, 'at most four');
});

test('timon.provider.backends: an entry is held to the plugin vocabulary plus the product\'s own fields', async () => {
  const { productBackendProblems } = await import('./builtin-declarations.js');
  const good = {
    id: 'acme', rank: 500,
    binary: { names: ['acme'], install: { any: { kind: 'none' } }, standaloneInstaller: { label: 'Acme', posix: 'curl https://acme.invalid | sh', windows: 'irm https://acme.invalid | iex' },
      desktopBuilds: [{ platform: 'win32', root: '${LOCALAPPDATA}/Acme', executable: ['acme.exe'], order: 'newest', folderPattern: '^[0-9a-f]+$' }] },
    credentialDirs: ['.acme'], signInCommand: 'acme login', setupCard: { label: 'Acme', order: 9 }, modelBrands: [{ match: 'acme', brand: 'acme' }],
    seedsMainAgent: true, readOnlyTools: true, apiKeyProviders: [{ id: 'acme-cloud', label: 'Acme Cloud', brand: 'acme' }],
  };
  assert.deepEqual(productBackendProblems(good), []);
  for (const [bad, why] of [
    [{ ...good, id: 'Not A Slug' }, /id/],
    [{ ...good, rank: 'first' }, /rank/],
    [{ ...good, nickname: 'x' }, /nickname|Unrecognized/i],
    [{ ...good, setupCard: { label: 'Acme', order: 1, colour: 'red' } }, /setupCard/],
    [{ ...good, seedsMainAgent: false }, /seedsMainAgent/],
    [{ ...good, binary: { names: ['/usr/bin/acme'] } }, /BARE/],
    [{ ...good, binary: { ...good.binary, desktopBuilds: [{ ...good.binary.desktopBuilds[0], folderPattern: '(' }] } }, /regular expression/],
    [{ ...good, credentialDirs: ['.ssh'] }, /credentials that belong to the user/],
  ] as const) {
    assert.match(productBackendProblems(bad).join('; '), why, JSON.stringify(bad).slice(0, 80));
  }
});

test('timon.provider.backends: what a backend declares is what the operator was shown, once per id', async () => {
  const { providerBackendsProblems } = await import('./builtin-declarations.js');
  const entry = { id: 'acme', rank: 500, binary: { names: ['acme'] }, credentialDirs: ['.acme'] };
  const block = { binaries: [{ name: 'acme', aliases: [] }], credentialDirs: ['.acme'] };
  assert.deepEqual(providerBackendsProblems({ ...block, backends: [entry] }), []);
  assert.deepEqual(providerBackendsProblems(block), [], 'the field is optional');
  assert.match(providerBackendsProblems({ ...block, binaries: [] , backends: [entry] }).join(), /not among the manifest's `provider.binaries`/);
  assert.match(providerBackendsProblems({ ...block, credentialDirs: [], backends: [entry] }).join(), /not among the manifest's `provider.credentialDirs`/);
  assert.match(providerBackendsProblems({ ...block, backends: [entry, entry] }).join(), /listed twice/);
  assert.match(providerBackendsProblems({ ...block, backends: { acme: entry } }).join(), /must be a list/);
  // The sign-in folder of a backend of the product is nobody else's.
  assert.match(providerBackendsProblems({ binaries: [], credentialDirs: ['.claude'], backends: [{ id: 'acme', rank: 1, credentialDirs: ['.claude'] }] }).join(), /`claude` backend/);
});

test('a manifest whose backends do not hold is refused at install', async () => {
  const { readManifest } = await import('../plugins/manifest.js');
  const manifest = (backends: unknown) => ({
    name: '@acme/provider-acme', version: '1.0.0', main: 'lib/index.js',
    timon: { id: 'provider-acme', apiVersion: 12, kind: 'provider', permissions: ['backends:register'], provider: { binaries: [{ name: 'acme' }], credentialDirs: ['.acme'], backends } },
  });
  assert.equal(readManifest(manifest([{ id: 'acme', rank: 1, binary: { names: ['acme'] }, credentialDirs: ['.acme'] }])).ok, true);
  const refused = readManifest(manifest([{ id: 'acme', rank: 1, binary: { names: ['other'] } }]));
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.message, /provider\.binaries/);
});

test('a product profile keeps its place ahead of the others, whatever the order the plugins register in', async () => {
  const { beginProviderSwap, registerFileProfile, registerTrustedProfile } = await import('./registry.js');
  const ids = () => installedProfiles().map((profile) => profile.id);
  const product = Object.keys(BUILTIN_DECLARATIONS).filter((id) => ids().includes(id));
  const last = product[product.length - 1]!;
  const lastProfile = installedProfiles().find((profile) => profile.id === last)!;
  const owner = (await import('./registry.js')).registeredBackendOwners().profiles[last]!;
  const disposeFile = registerFileProfile('test-file', { id: 'acme-early', dialect: 'acme', label: 'Acme', models: [], defaultModel: null });
  // The plugin that brings the last product profile is remounted after the user's file was read.
  const endSwap = beginProviderSwap(owner);
  try {
    registerTrustedProfile(owner, lastProfile, { deferDialect: true, trusted: true });
    assert.deepEqual(ids().filter((id) => product.includes(id)), product, 'the product order holds');
    assert.ok(ids().indexOf(last) < ids().indexOf('acme-early'), `${last} stays ahead of a user's profile`);
  } finally {
    endSwap();
    disposeFile();
  }
});
