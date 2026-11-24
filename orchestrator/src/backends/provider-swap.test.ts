/**
 * Hot update of a provider plugin: between the old fiber going and the new one
 * applying, the backend must still be there, and a named backend must NEVER be
 * served by another one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeHomeOnExit } from '../../tests/helpers/test-home.js';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-provider-swap-'));
process.env.TIMON_HOME = TMP_HOME;
removeHomeOnExit(TMP_HOME);

const { registerDialect, registerProfile, beginProviderSwap, registeredBackendOwners } = await import('./registry.js');
const { backendMetadata, backendNames, getBackend, isBackendName } = await import('./index.js');
type Dialect = import('./types.js').Dialect;

function dialect(tag: string): Dialect {
  return {
    defaultCmd: 'echo',
    persistentProcess: false,
    finishMissionOnExit: false,
    sessionResumable: true,
    sessionStore: 'global',
    permissionModel: 'none',
    rateLimitReporting: 'none',
    hostedConnectors: false,
    async buildSpawn(opts, profile) {
      return { cmd: profile.cmd, args: [tag, opts.message], env: profile.env, cwd: opts.cfg.cwd, initialStdin: null };
    },
    writeUserInput() { /* one-shot */ },
    parseLine: () => [],
    extractSessionId: () => null,
  };
}
const profile = (id: string, dialectId: string) => ({
  id, dialect: dialectId, label: id, vendor: 'ACME', custom: true, defaultModel: 'm-1', models: [{ slug: 'm-1', label: 'm-1' }],
});
const spawnArgs = async (name: string) => (await getBackend(name).buildSpawn({
  agentName: 'timon.test', systemPrompt: 's', message: 'hi', resumeSession: null,
  cfg: { cwd: TMP_HOME, model: 'm-1', permission_mode: 'auto' }, missionId: 'm',
})).args;

test('an explicit backend that is absent is an error, never another backend', () => {
  assert.equal(isBackendName('swap-llm'), false);
  assert.throws(() => getBackend('swap-llm'), /not available/);
  // An absent name still takes the default.
  assert.equal(backendNames().length, 0);
  assert.throws(() => getBackend(undefined), /No active LLM backend/);
});

test('a remount keeps the backend dispatchable from start to finish, then serves the new version', async () => {
  const offOldDialect = registerDialect('swap-plugin', 'swap-echo', dialect('v1'));
  const offOldProfile = registerProfile('swap-plugin', profile('swap-llm', 'swap-echo'));
  const held = getBackend('swap-llm');
  assert.deepEqual(await spawnArgs('swap-llm'), ['v1', 'hi']);

  const endSwap = beginProviderSwap('swap-plugin');
  // The loader disposes the old fiber, then imports and applies the new one.
  offOldProfile();
  offOldDialect();
  assert.equal(isBackendName('swap-llm'), true, 'no gap while the new version is being imported');
  assert.deepEqual(await spawnArgs('swap-llm'), ['v1', 'hi'], 'a dispatch in the gap still lands on the same provider');

  const offNewDialect = registerDialect('swap-plugin', 'swap-echo', dialect('v2'));
  const offNewProfile = registerProfile('swap-plugin', profile('swap-llm', 'swap-echo'));
  endSwap();

  assert.deepEqual(await spawnArgs('swap-llm'), ['v2', 'hi'], 'the new version is live');
  assert.deepEqual(registeredBackendOwners().profiles, { 'swap-llm': 'swap-plugin' });
  assert.deepEqual(await held.buildSpawn({
    agentName: 'a', systemPrompt: 's', message: 'x', resumeSession: null, cfg: { cwd: TMP_HOME, model: 'm-1', permission_mode: 'auto' }, missionId: 'm',
  }).then((s) => s.args), ['v1', 'x'], 'a mission already running keeps the object it holds');

  offNewProfile();
  offNewDialect();
  assert.equal(isBackendName('swap-llm'), false, 'a plain unload is immediate');
});

test('what the new version no longer registers goes at the end of the swap', () => {
  const offDialect = registerDialect('drop-plugin', 'drop-echo', dialect('v1'));
  const offA = registerProfile('drop-plugin', profile('drop-a', 'drop-echo'));
  const offB = registerProfile('drop-plugin', profile('drop-b', 'drop-echo'));
  const endSwap = beginProviderSwap('drop-plugin');
  offA(); offB(); offDialect();
  registerDialect('drop-plugin', 'drop-echo', dialect('v2'));
  registerProfile('drop-plugin', profile('drop-a', 'drop-echo'));
  assert.equal(isBackendName('drop-b'), true, 'still there until the swap closes');
  endSwap();
  assert.equal(isBackendName('drop-a'), true);
  assert.equal(isBackendName('drop-b'), false, 'dropped by the new version');
  assert.throws(() => getBackend('drop-b'), /not available/);
});

test('a new version that fails to apply leaves nothing behind', () => {
  const offDialect = registerDialect('fail-plugin', 'fail-echo', dialect('v1'));
  const offProfile = registerProfile('fail-plugin', profile('fail-llm', 'fail-echo'));
  const endSwap = beginProviderSwap('fail-plugin');
  offProfile(); offDialect();
  // apply() threw before registering anything.
  endSwap();
  assert.equal(isBackendName('fail-llm'), false);
  assert.throws(() => getBackend('fail-llm'), /not available/);
});

test('outside a swap, a duplicate registration is still refused', () => {
  const off = registerDialect('dup-plugin', 'dup-echo', dialect('v1'));
  assert.throws(() => registerDialect('dup-plugin', 'dup-echo', dialect('v2')), /already|déjà/); // french-ok: the older French wording of the error
  off();
});

test('a rollback that registers the very same objects again is not undone by the stale release', () => {
  const same = dialect('v1');
  const offDialect = registerDialect('roll-plugin', 'roll-echo', same);
  const shape = profile('roll-llm', 'roll-echo');
  const offProfile = registerProfile('roll-plugin', shape);
  const endSwap = beginProviderSwap('roll-plugin');
  offProfile(); offDialect();
  registerDialect('roll-plugin', 'roll-echo', same);
  registerProfile('roll-plugin', shape);
  endSwap();
  assert.equal(isBackendName('roll-llm'), true, 'same objects, new registration: still live');
});

test('a swap that changes transport is refused with the dialect and the reason named', () => {
  const offDialect = registerDialect('refuse-plugin', 'refuse-echo', dialect('v1'));
  const endSwap = beginProviderSwap('refuse-plugin');
  offDialect();
  assert.throws(
    () => registerDialect('refuse-plugin', 'refuse-echo', { ...dialect('v2'), persistentProcess: true, finishMissionOnExit: true }),
    /transport changed \(per-turn → persistent\)/,
  );
  assert.throws(
    () => registerDialect('refuse-plugin', 'refuse-echo', { ...dialect('v2'), sessionStore: 'per-mission' }),
    /session store changed/,
  );
  endSwap();
});

test('a mission on a provider that is gone can still be stopped and cleaned (no throw, safe defaults)', () => {
  const offDialect = registerDialect('gone-plugin', 'gone-echo', dialect('v1'));
  const offProfile = registerProfile('gone-plugin', profile('gone-llm', 'gone-echo'));
  assert.equal(backendMetadata('gone-llm').sessionResumable, true);
  offProfile(); offDialect();
  assert.throws(() => getBackend('gone-llm'), /not available/);
  const meta = backendMetadata('gone-llm');
  assert.equal(meta.sessionResumable, false);
  assert.equal(meta.persistentProcess, false);
  assert.equal(meta.dispose, undefined);
  assert.doesNotThrow(() => backendMetadata('never-existed@some-account'));
});
