/**
 * Invariant: a superadmin who belongs to NO permission group can switch a
 * bundled module on and off through a real HTTP session.
 *
 * `gate.test.ts` already covers the toggle, but it authenticates with the
 * daemon-token, which is superadmin by construction — so it could never have
 * caught a regression in the SESSION path, where `is_superadmin` has to
 * short-circuit the group evaluator on its own. The maintainer's account has no group;
 * this is the case the suite was missing.
 *
 * Everything is real: the auth middleware, the plugin routes, the config file
 * under a throwaway `TIMON_HOME`. The refusals are asserted here too, because
 * the gallery now shows their message to the user (`toggleFailureMessage`), so
 * a status or a wording that drifts stops being invisible.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugins-superadmin-'));
await import('../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { dbApi } = await import('./db.js');
const { createDaemonAuthMiddleware, ensureDaemonToken } = await import('./plugins-bundled/http/auth.js');
const { hashSessionToken } = await import('./users/session.js');
const { registerRoutes } = await import('./plugins-bundled/plugins/routes.js');
const { CONFIG_FILE } = await import('./config/load.js');

/** An optional bundled module: the kind of switch the gallery must honour. */
const OPTIONAL = '@timon/memory';
/** Licensed, `dev` tier — the toggle writes the wish whatever the licence says. */
const LICENSED = '@timon/kanban-code';

const boss = createTestAccount(dbApi, {
  email: 'boss@example.test', name: 'Boss', passwordHash: 'x', isSuperadmin: true,
});
const sessionToken = randomBytes(32).toString('hex');
dbApi.createSession({
  tokenHash: hashSessionToken(sessionToken), userId: boss.id, expiresAt: Date.now() + 3_600_000,
});
const cookie = `timon_session=${encodeURIComponent(sessionToken)}`;

const app = express();
app.use(createDaemonAuthMiddleware({ token: ensureDaemonToken(), required: false }));
app.use(express.json());
registerRoutes(app as unknown as Parameters<typeof registerRoutes>[0]);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
test.after(() => { server.close(); });

type Answer = { status: number; body: { error?: string; ok?: boolean } };
async function toggle(id: string, enabled: boolean, headers: Record<string, string> = { cookie }): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${port}/api/plugins/${encodeURIComponent(id)}/enabled`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ enabled }),
  });
  return { status: response.status, body: await response.json() as Answer['body'] };
}
const wantedInFile = (id: string): unknown =>
  (JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { modules?: Record<string, unknown> }).modules?.[id];

test('a superadmin with no group at all is still `*`', () => {
  assert.deepEqual(dbApi.listPermissionsForUser(boss.id), [], 'the account under test holds no right of its own');
  assert.deepEqual(dbApi.listPermissionsForUser(boss.id), [], 'and holds no explicit grant');
  assert.equal(boss.is_superadmin, true);
});

test('session superadmin without a group: an optional bundled module toggles both ways', async () => {
  assert.equal((await toggle(OPTIONAL, false)).status, 200);
  assert.equal(wantedInFile(OPTIONAL), false, 'the wish is written to timon.config.json');
  assert.equal((await toggle(OPTIONAL, true)).status, 200);
  assert.equal(wantedInFile(OPTIONAL), true, 'and back again — the switch is not one-way');
});

test('a licensed module keeps its switch: the wish is the user\'s, the licence is the daemon\'s', async () => {
  assert.equal((await toggle(LICENSED, true)).status, 200);
  assert.equal(wantedInFile(LICENSED), true);
});

test('the refusals stay refusals, and each carries a message the gallery can show', async () => {
  const core = await toggle('@timon/db', false);
  assert.equal(core.status, 403, 'a core module is never switchable off');
  assert.match(core.body.error ?? '', /core/i);
  assert.equal(wantedInFile('@timon/db'), undefined, 'and nothing is written for it');

  const theme = await toggle('@timon/ui-theme', false);
  assert.equal(theme.status, 403, 'the product theme carries every token');
  assert.ok((theme.body.error ?? '').length > 0);

  const unknown = await toggle('@timon/does-not-exist', false);
  assert.equal(unknown.status, 404);
  assert.ok((unknown.body.error ?? '').length > 0);
});

test('no session, no toggle — the fix must not open the route', async () => {
  const anonymous = await toggle(OPTIONAL, false, {});
  assert.equal(anonymous.status, 401);
  assert.equal(wantedInFile(OPTIONAL), true, 'the last legitimate wish is untouched');
});

test('invalid toggle inputs return explicit field errors without changing config', async () => {
  const before = readFileSync(CONFIG_FILE, 'utf8');
  for (const [id, body, code, error] of [
    [' ', { enabled: true }, 'invalid_id', '`id` must be a non-empty string'],
    [OPTIONAL, { wanted: true }, 'invalid_body', '`enabled` must be a boolean'],
    [OPTIONAL, { enabled: 'false' }, 'invalid_body', '`enabled` must be a boolean'],
    [OPTIONAL, null, 'invalid_body', '`enabled` must be a boolean'],
  ] as const) {
    const response = await fetch(`http://127.0.0.1:${port}/api/plugins/${encodeURIComponent(id)}/enabled`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    if (body !== null) assert.deepEqual(await response.json(), { code, error });
  }
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before);
});

test('session superadmin without groups cannot bypass a fixed paid composition', async () => {
  const { licenseState, setLicenseState } = await import('./license/runtime.js');
  const before = licenseState();
  const configBefore = readFileSync(CONFIG_FILE, 'utf8');
  setLicenseState({ ...before, status: 'valid', plan: 'solo', planId: 'solo', users: 1,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    capabilities: { version: 1, plugins: 'fixed', accounts: 'single-superadmin' } });
  try {
    for (const id of [OPTIONAL, LICENSED]) {
      const response = await toggle(id, true);
      assert.equal(response.status, 403);
      assert.equal(response.body.error, 'plugin_composition_fixed');
    }
    assert.equal(readFileSync(CONFIG_FILE, 'utf8'), configBefore);
  } finally {
    setLicenseState({ ...before, status: 'valid' });
    setLicenseState(before);
  }
});
