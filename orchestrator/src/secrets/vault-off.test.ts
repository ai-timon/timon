/**
 * The daemon without a vault — what an install that never wanted one gets.
 *
 * The vault became a `tier: opt` module: switching it off must take away its
 * routes AND stop every path that lives outside it from reading the vault
 * anyway. Two of those paths are the ones that matter, because they run on
 * every launch: the environment handed to a mission (`missionEnv`, the spawn
 * path) and the inject journal.
 *
 * The assertion that discriminates is not "nothing throws" — nothing threw
 * before this gate existed either. It is that a secret which IS granted, and
 * which the very same code injects when the module runs, does NOT reach the
 * mission environment when it does not. The two halves are asserted back to
 * back so a gate that silently stops working cannot pass by disabling both.
 *
 * The kernel is composed as `boot.ts` composes it, with two entries: booting
 * the whole catalogue to watch one route disappear would mount thirty modules
 * and their timers (same reasoning as `kernel/bundled-reload.test.ts`).
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { pathKeyOf } from '../host/launch-path.js';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Timer from '@deepseek-ai/cordis-plugin-timer';
import type { ModuleDescriptor } from '../kernel/registry.js';

const { createHttpPlugin } = await import('../kernel/http-service.js');
const { planEntries, toLoaderEntries } = await import('../kernel/registry.js');
const { setLiveDecisions } = await import('../kernel/capabilities.js');
const { CONFIG_FILE, config, resetConfig } = await import('../config/load.js');
const { dbApi } = await import('../db.js');
const { missionEnv } = await import('../agent.js');
const { injectedSecretsFor, journalInjectedSecrets } = await import('./env.js');
const { SECRETS_MODULE_ID } = await import('./availability.js');

/** The minimal kernel, and the guinea pig. */
const CATALOG: readonly ModuleDescriptor[] = [
  { id: 'core-db', name: './plugins-bundled/db/index.js', tier: 'core' },
  { id: SECRETS_MODULE_ID, name: './plugins-bundled/secrets-vault/index.js', tier: 'opt' },
];

const NAME = 'VAULT_OFF_WITNESS';
const VALUE = 'value-that-must-not-reach-a-mission';

const secret = dbApi.createSecret({
  // Not sealed: an inherited plain-text line (§10) follows exactly the same
  // injection path, without requiring a master key in this test.
  name: NAME, value_enc: VALUE, mode: 'inject',
});
dbApi.addSecretGrant(secret.id, 'global');

/** Mounts the tree with or without the vault, and returns the URL of the HTTP witness. */
async function kernel(vaultWanted: boolean): Promise<{ base: string; close: () => Promise<void> }> {
  writeFileSync(CONFIG_FILE, `${JSON.stringify({ modules: { [SECRETS_MODULE_ID]: vaultWanted } })}\n`);
  resetConfig();

  const app = express();
  app.use(express.json());
  const ctx = new Context();
  // Entry names are relative to `src/`, as they are to `dist/`
  // from `boot.js`. Under `tsx`, `./x/index.js` resolves `index.ts`.
  ctx.baseUrl = new URL('../', import.meta.url).href;
  await ctx.plugin(Timer);
  await ctx.plugin(createHttpPlugin(app));
  await ctx.plugin(Loader);

  const decisions = planEntries(CATALOG, { config: config(), capabilities: [] });
  setLiveDecisions(decisions, [], 'expert');
  for (const entry of toLoaderEntries(decisions)) await ctx.loader.create(entry);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  assert.notEqual(port, 3000, 'the witness never takes the production port');
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => { server.close(); await ctx.fiber.dispose(); },
  };
}

test('vault off: no route, no secret in the environment of a mission', async () => {
  const k = await kernel(false);
  try {
    assert.equal((await fetch(`${k.base}/api/secrets`)).status, 404, 'no secrets route without the module');

    // The launch path, without a secrets database read and without an exception.
    const env = missionEnv({ missionId: 'm-vault-off', agentName: 'witness', project: 'p' });
    assert.equal(env[NAME], undefined, 'a granted secret must not enter a mission without a vault');
    // Windows keeps the spelling it read (`Path`): look the key up as the product does.
    assert.ok(env[pathKeyOf(env, process.platform)] !== undefined, 'the system allowlist stays, for its part');

    const slice = injectedSecretsFor({ agent: 'witness', project: 'p' });
    assert.deepEqual(slice, { env: {}, injected: [] });
    // Nothing to log, and above all no write: the access journal is
    // a route of the module, which no longer exists.
    journalInjectedSecrets({ missionId: 'm-vault-off', agent: 'witness', injected: slice.injected });
    assert.equal(dbApi.listSecretAccess(secret.id).length, 0);
  } finally {
    await k.close();
  }
});

test('vault on: the same secret, the same mission, and it is indeed injected', async () => {
  const k = await kernel(true);
  try {
    assert.notEqual((await fetch(`${k.base}/api/secrets`)).status, 404, 'the module turned back on takes its routes back');
    const env = missionEnv({ missionId: 'm-vault-on', agentName: 'witness', project: 'p' });
    assert.equal(env[NAME], VALUE, 'without this half, the previous test would prove nothing');
  } finally {
    await k.close();
  }
});
