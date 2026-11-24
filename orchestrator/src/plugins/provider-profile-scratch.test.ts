/**
 * `ctx.provider.scratch.profile` (API 18): the folder a provider keeps for one profile it
 * launches, across that profile's missions.
 *
 * Written from a plugin's side: the folder belongs to the plugin that LAUNCHES the profile
 * (the one the fence names), it is private and stays where it is across calls, nothing the
 * daemon cleans up reaches it, and it never holds a value a launch sealed.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProfileRuntime } from '../backends/types.js';

const { providerServicesFor, PluginApiVersionError, PROVIDER_PROFILE_SCRATCH_API_VERSION } = await import('./provider-facade.js');
const { PluginPolicyError } = await import('./policy.js');
const { registerFileProfile, registerPackProfile } = await import('../backends/registry.js');
const {
  ProfileScratchReferenceError, disposeProviderScratch, parkProviderScratch, profileScratchPath, providerRunsDir,
  purgeProviderScratch, trimProviderCaches,
} = await import('../backends/provider-scratch.js');
const { TIMON_HOME } = await import('../paths.js');
const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');

await mountOfficialProviders();
// Data on the claude dialect, as `~/.timon/backends/<id>.json` and a provider pack load it.
registerFileProfile('local-file', { id: 'user-claude', dialect: 'claude', label: 'User claude', models: [], defaultModel: null });
registerPackProfile('acme-pack', { id: 'pack-claude', dialect: 'claude', label: 'Pack', models: [], defaultModel: null });

const servicesOf = (pluginId: string, apiVersion = PROVIDER_PROFILE_SCRATCH_API_VERSION, granted = true) => providerServicesFor({
  pluginId,
  apiVersion,
  assertPermission() { if (!granted) throw new Error('backends:register not granted'); },
  trusted: true,
  authorizedBinaries: [],
  authorizedCredentialDirs: [],
  osCredentials: [],
  effect: (register) => register(),
});
/** A launch's profile, as `buildSpawn` receives it: only its id matters here. */
const profile = (id: string): ProfileRuntime => ({ id, cmd: 'claude', env: {} });
const claude = servicesOf('provider-claude');

test('the plugin that launches a profile gets its folder, private, under the plugin\'s cache', () => {
  for (const id of ['claude', 'kimi', 'user-claude', 'pack-claude']) {
    const dir = claude.scratch.profile(profile(id));
    assert.equal(dir.path, join(TIMON_HOME, 'provider-cache', 'provider-claude', 'profiles', id), id);
    assert.equal(dir.path, profileScratchPath('provider-claude', id));
    assert.ok(statSync(dir.path).isDirectory(), `${id}: made at the call`);
    if (process.platform !== 'win32') assert.equal(statSync(dir.path).mode & 0o777, 0o700, `${id}: private`);
  }
});

test('the folder is the same from one call to the next, what was written in it included', () => {
  const first = claude.scratch.profile(profile('kimi'));
  first.writeFile('projects/-code-app/s1.jsonl', '{"type":"user"}\n');
  const second = claude.scratch.profile(profile('kimi'));
  assert.equal(second.path, first.path);
  assert.equal(readFileSync(second.resolve('projects/-code-app/s1.jsonl'), 'utf8'), '{"type":"user"}\n');
});

test('REFUSAL: a launch on an account gets no profile folder, its state goes in the account\'s', () => {
  // The profile's folder is shared by the host's sign-in and every account of the profile; an account has an owner.
  assert.throws(() => claude.scratch.profile(profile('claude@acc123')), (error: unknown) =>
    error instanceof PluginPolicyError && /account\.of\(profile\)\.configDir/.test(error.message));
});

test('REFUSAL: a plugin that does not launch the profile gets no folder for it', () => {
  // `provider-kimi` registered the Kimi profile, but `provider-claude` launches it: a folder
  // under `provider-kimi` would never be opened to Kimi's missions.
  assert.throws(() => servicesOf('provider-kimi').scratch.profile(profile('kimi')), PluginPolicyError);
  assert.throws(() => servicesOf('provider-codex').scratch.profile(profile('user-claude')), PluginPolicyError);
  assert.throws(() => servicesOf('acme-pack').scratch.profile(profile('pack-claude')), PluginPolicyError);
  assert.throws(() => claude.scratch.profile(profile('codex')), PluginPolicyError);
  assert.throws(() => claude.scratch.profile(profile('no-such-backend')), PluginPolicyError);
  assert.equal(existsSync(join(TIMON_HOME, 'provider-cache', 'provider-kimi', 'profiles')), false);
});

test('REFUSAL: a plugin that declared an older contract, or no permission, is refused', () => {
  assert.throws(() => servicesOf('provider-claude', 17).scratch.profile(profile('kimi')), (error: unknown) =>
    error instanceof PluginApiVersionError && /needs apiVersion 18/.test(error.message) && /declares 17/.test(error.message));
  assert.throws(() => servicesOf('provider-claude', 18, false).scratch.profile(profile('kimi')), /backends:register/);
});

test('REFUSAL: nothing a launch sealed is written into it, and it links nothing', () => {
  const dir = claude.scratch.profile(profile('kimi'));
  assert.throws(() => dir.writeFile('settings.json', '{"env":{"TIMON_API_TOKEN":"timon-seal-0123456789abcdef0123456789abcdef"}}'),
    ProfileScratchReferenceError);
  assert.equal(dir.has('settings.json'), false);
  const source = join(TIMON_HOME, 'tmp', 'a-credential.json');
  mkdirSync(join(TIMON_HOME, 'tmp'), { recursive: true });
  writeFileSync(source, '{}');
  assert.throws(() => dir.link(source, '.credentials.json'));
});

test('nothing the daemon cleans up reaches it: purge, cache trim, dispose, backend switch', () => {
  const dir = claude.scratch.profile(profile('user-claude'));
  dir.writeFile('projects/-code-app/old.jsonl', 'kept\n');
  const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  utimesSync(dir.path, longAgo, longAgo);
  // A mission folder of the same plugin, long over, so that the passes have something to do.
  const mission = join(providerRunsDir(), 'provider-claude', 'mission-over');
  mkdirSync(mission, { recursive: true });
  utimesSync(mission, longAgo, longAgo);

  const purged = purgeProviderScratch(() => ({ live: false, endedAt: longAgo.getTime() }), 1);
  assert.deepEqual(purged.removed, ['mission-over'], 'the purge did run');
  trimProviderCaches(() => ({ live: false, endedAt: longAgo.getTime() }));
  for (const id of ['user-claude', 'profiles', 'provider-claude']) {
    disposeProviderScratch(id);
    parkProviderScratch(id).drop();
  }
  assert.equal(readFileSync(dir.resolve('projects/-code-app/old.jsonl'), 'utf8'), 'kept\n');
});

test('the testing kit stands in with a temporary folder per profile, under the same rules', async () => {
  const { createProviderContext, FAKE_TOKEN_REFERENCE } = await import('../../../packages/sdk/src/testing/context.js');
  const ctx = createProviderContext({ apiVersion: 18 });
  const dir = ctx.provider.scratch.profile(profile('kimi'));
  dir.writeFile('settings.json', '{}');
  assert.equal(ctx.provider.scratch.profile(profile('kimi')).path, dir.path, 'the same folder across calls');
  assert.notEqual(ctx.provider.scratch.profile(profile('user-claude')).path, dir.path, 'one folder per profile');
  assert.ok(!dir.path.startsWith(TIMON_HOME), 'never the Timon home');
  assert.throws(() => dir.writeFile('mcp.json', `{"token":"${FAKE_TOKEN_REFERENCE}"}`), /scratch\.mission\(\)/);
  assert.throws(() => createProviderContext().provider.scratch.profile(profile('kimi')), /needs apiVersion 18/);
  assert.throws(() => ctx.provider.scratch.profile(profile('claude@acc123')), /account\.of\(profile\)\.configDir/);
  ctx.cleanup();
  assert.equal(existsSync(dir.path), false, 'cleanup removes it');
});
