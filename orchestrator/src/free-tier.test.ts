import { createTestAccount, serveTestAccounts } from '../tests/helpers/accounts.js';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-free-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
// A paid install here also has the Multi-user plugin serving its accounts.
serveTestAccounts();
const { verifyLicenseToken, installLicenseToken, fingerprintHash, readLicense, unlicensed } = await import('./license/license.js');
const { overrideKeyringForTests } = await import('./license/pubkey.js');
const { deviceId } = await import('./license/device.js');
const { fingerprint } = await import('./license/fingerprint.js');
const { setLicenseState, licenseState } = await import('./license/runtime.js');
const { dbApi } = await import('./db.js');
const { registerRoutes: userRoutes } = await import('./plugins-bundled/users/routes.js');
const { registerRoutes: licenseRoutes } = await import('./kernel/routes/license.js');
const { registerRoutes: pluginRoutes } = await import('./plugins-bundled/plugins/routes.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { assertLicenseCompatible } = await import('./license/compliance.js');
const { LicenseCapabilityError } = await import('./license/capabilities.js');
const { addPlugin, removePlugin, setPluginEnabled } = await import('./plugins/install.js');
const { setModuleEnabled } = await import('./kernel/module-config.js');
const { planEntries } = await import('./kernel/registry.js');
const { TimonConfigSchema } = await import('./config/schema.js');
const { CONFIG_FILE } = await import('./config/load.js');
const { LICENSE_FILE } = await import('./paths.js');
const { unsignedPluginsAllowed } = await import('./plugins/pubkey.js');
const { startLicenseRefresh } = await import('./license/refresh.js');
const { PluginLoader } = await import('./plugins/loader.js');
const { Context } = await import('@deepseek-ai/cordis');
const pair = generateKeyPairSync('ed25519');
const keys = [{ keyId: 'free-test', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
overrideKeyringForTests(keys);
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
// The last fixed Free composition the issuer minted: such tokens stay valid,
// and are applied as the open local Free like any other Free token.
// `@timon/agenda` has since left the catalogue: a token that still names it stays valid.
const LEGACY_FREE_MODULES = ['@timon/db', '@timon/settings', '@timon/agenda'];
const caps = { version: 1, plugins: 'fixed', accounts: 'single-superadmin' };
const now = Math.floor(Date.now() / 1000);
function token(overrides: Record<string, unknown> = {}) {
  const body = { sub: 'free-user', lic: 'free-lic', did: deviceId(), fph: fingerprintHash(fingerprint()), plan: 'free', plan_name: 'Free',
    edition: 'lite', modules: LEGACY_FREE_MODULES,
    plugins: [], features: [], seats: 1, users: 1, capabilities: caps, iat: now, nbf: now - 60, exp: now + 900,
    srv: now, jti: 'free-token', sub_exp: null, status: 'active', ...overrides };
  const input = `${enc({ alg: 'EdDSA', typ: 'JWT', kid: 'free-test' })}.${enc(body)}`;
  return `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`;
}
const paidToken = () => token({ plan: 'internal', capabilities: undefined, modules: '*', plugins: '*', users: null });
const paid = () => setLicenseState(verifyLicenseToken(paidToken()));
const activateFree = () => setLicenseState(installLicenseToken(token()));
// A paid offer with a fixed composition: the lock Free no longer carries.
const fixedToken = () => token({ plan: 'solo', capabilities: { version: 1, plugins: 'fixed', accounts: 'standard' }, modules: LEGACY_FREE_MODULES, users: null });
const fixedPaid = () => setLicenseState(verifyLicenseToken(fixedToken()));
const app = express();
app.use(createDaemonAuthMiddleware({ token: 'test-admin', required: false }));
app.use(express.json());
// The Free policy is injected, not inherited: the shipped default is the beta
// one (a licence key is required to create the first account), and this file
// exercises what Free does once it is the policy — see `setup-policy.test.ts`.
userRoutes(app, { setupPolicy: 'free' }); licenseRoutes(app); pluginRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const actualFetch = globalThis.fetch;
async function call(path: string, body: unknown, method = 'POST') {
  const r = await actualFetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer test-admin' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}
test.after(() => { server.close(); globalThis.fetch = actualFetch; overrideKeyringForTests(null); });

test('Free signed policy and all local admission boundaries', async (t) => {
  await t.test('legacy tokens remain valid; Free cannot omit or widen its signed limits', () => {
    assert.equal(verifyLicenseToken(paidToken()).status, 'valid');
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/token-claims.json', import.meta.url), 'utf8')) as { version: number; examples: { name: string; claims: Record<string, unknown> }[] };
    assert.equal(fixture.version, 6);
    const proposal = fixture.examples.find((example) => example.name === 'free')!;
    assert.equal(verifyLicenseToken(token({ ...proposal.claims, did: deviceId(), fph: fingerprintHash(fingerprint()), iat: now, nbf: now - 60, exp: now + 900, srv: now })).status, 'valid', 'the issuer handoff fixture is accepted by the real verifier');
    assert.equal(verifyLicenseToken(token()).status, 'valid');
    // Free names every module and plugin (the maintainer, 03/11/2026): the composition
    // claims are free-form, only the account axis is signed and enforced.
    for (const patch of [{ modules: '*' }, { plugins: '*' }, { modules: [] }, { edition: 'expert' }, { features: ['code-pipeline'] }, { capabilities: { ...caps, plugins: 'extensible' } }]) {
      assert.equal(verifyLicenseToken(token(patch)).status, 'valid', JSON.stringify(patch));
    }
    for (const patch of [{ capabilities: undefined }, { capabilities: { ...caps, accounts: 'standard' } }, { users: null }, { users: 2 }, { seats: 2 }, { fph: undefined }, { capabilities: { ...caps, version: 2 } }, { exp: now + 3600 }, { nbf: now - 3600 }, { status: 'past_due' }, { sub_exp: now + 86400 }]) {
      assert.equal(verifyLicenseToken(token(patch)).status, 'unlicensed', JSON.stringify(patch));
    }
    // `past_due` gates Free only: on a paid licence it is a banner, never a lock.
    const latePaid = verifyLicenseToken(token({ plan: 'internal', capabilities: undefined, modules: '*', plugins: '*', users: null, status: 'past_due', sub_exp: now + 86400, exp: now + 3600, nbf: now - 3600 }));
    assert.equal(latePaid.status, 'valid');
    assert.equal(latePaid.paymentStatus, 'past_due');
    assert.equal(verifyLicenseToken(token(), { now: new Date((now + 1000) * 1000), graceUntil: now + 86400 }).reason, 'expired');
    assert.equal(verifyLicenseToken(token(), { device: 'another-machine' }).reason, 'invalid:machine');
  });
  await t.test('offline setup creates the local owner without any licensing request', async () => {
    globalThis.fetch = async () => { throw new Error('Free must never contact the issuer'); };
    const input = { name: 'Owner', email: 'owner@example.test', password: 'test-password' };
    const results = await Promise.all([call('/api/auth/setup', input), call('/api/auth/setup', input)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(dbApi.listUsers()[0].is_superadmin, true);
    assert.equal(licenseState().localFree, true);
    assert.equal(existsSync(LICENSE_FILE), false);
    globalThis.fetch = actualFetch;
  });
  await t.test('second accounts fail: no core route makes one, and the database refuses it', async () => {
    // The routes are gone: Express answers its own 404, not JSON.
    const status = async (path: string, body: unknown) => (await actualFetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-admin' }, body: JSON.stringify(body) })).status;
    const responses = await Promise.all([1, 2].map((n) => status('/api/users', { name: 'Other', email: `other${n}@example.test`, password: 'test-password', is_superadmin: true })));
    assert.deepEqual(responses, [404, 404]);
    assert.equal(await status('/api/invitations', { email: 'invite@example.test', name: 'Invite', is_superadmin: true }), 404);
    assert.equal(dbApi.countUsers(), 1);
    assert.throws(() => createTestAccount(dbApi, { name: 'Bad', email: 'bad@example.test', passwordHash: 'hash', isSuperadmin: false }), LicenseCapabilityError);
    assert.throws(() => createTestAccount(dbApi, { name: 'Other', email: 'direct@example.test', passwordHash: 'hash', isSuperadmin: true }), LicenseCapabilityError);
    assert.throws(() => createTestAccount(dbApi, { name: 'Hidden', email: 'hidden@example.test', passwordHash: 'hash', isSuperadmin: true, status: 'disabled' }), LicenseCapabilityError);
  });
  await t.test('install/remove/enable and unsigned/developer cannot mutate a fixed paid composition', async () => {
    fixedPaid();
    const dir = join(process.env.TIMON_HOME!, 'external');
    let ran = false;
    const opts = { npm: async () => { ran = true; } };
    for (const spec of ['signed-package', 'unsigned-package', './bundle', '/tmp/copied-plugin']) {
      await assert.rejects(addPlugin(spec, dir, opts), LicenseCapabilityError);
    }
    await assert.rejects(removePlugin('base', dir, opts), LicenseCapabilityError);
    assert.equal(ran, false); assert.equal(existsSync(dir), false);
    assert.throws(() => setPluginEnabled('external', true), LicenseCapabilityError);
    assert.throws(() => setModuleEnabled('@timon/vault', false), LicenseCapabilityError);
    assert.equal(unsignedPluginsAllowed(true, { keys: [] }), false);
    const r = await call('/api/plugins/%40timon%2Fvault/enabled', { enabled: false });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'plugin_composition_fixed');
  });
  await t.test('a built-in stays switchable under the fixed composition', async () => {
    // The maintainer, 26/09/2026: shipped with the product, so not part of what the
    // licence fixes. The source layout resolves `quota-monitor` from examples/.
    setPluginEnabled('quota-monitor', false);
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { plugins?: Record<string, unknown> };
    assert.equal(cfg.plugins?.['quota-monitor'], false);
    setPluginEnabled('quota-monitor', true);
    const r = await call('/api/plugins/quota-monitor/enabled', { enabled: false });
    assert.notEqual(r.body.error, 'plugin_composition_fixed');
    // Anything else keeps the lock, the built-in's npm name aside.
    assert.throws(() => setPluginEnabled('external', false), LicenseCapabilityError);
  });
  await t.test('Free leaves the composition to its owner: plugins and module overrides are writable', async () => {
    activateFree();
    const { assertCompositionMutable } = await import('./license/capabilities.js');
    assert.doesNotThrow(() => assertCompositionMutable(licenseState()));
    assert.doesNotThrow(() => setModuleEnabled('@timon/vault', false));
    assert.doesNotThrow(() => setModuleEnabled('@timon/vault', true));
    assert.doesNotThrow(() => setPluginEnabled('external', true));
    assert.equal(unsignedPluginsAllowed(true, { keys: [] }), true);
    const r = await call('/api/plugins/%40timon%2Fvault/enabled', { enabled: false });
    assert.notEqual(r.body.error, 'plugin_composition_fixed');
    fixedPaid();
  });
  await t.test('boot/reload decisions preserve options but ignore composition edits', () => {
    const catalog = [{ id: '@timon/agenda', name: 'base', tier: 'opt' as const }, { id: '@timon/extra', name: 'extra', tier: 'std' as const }];
    const cfg = TimonConfigSchema.parse({ edition: 'expert', developer: { unsignedPlugins: true }, modules: { '@timon/agenda': { enabled: false, account: 'work' }, '@timon/extra': true } });
    const result = planEntries(catalog, { config: cfg, capabilities: [] });
    assert.equal(result[0].disabled, false); assert.deepEqual(result[0].config, { account: 'work' });
    assert.equal(result[1].disabled, true);
    activateFree();
    const open = planEntries(catalog, { config: cfg, capabilities: [] });
    assert.equal(open[0].disabled, true, 'under Free the owner switches a module off');
    assert.equal(open[1].disabled, false);
    fixedPaid();
  });
  await t.test('a plugin manually copied to disk is refused before import even if licence.required is false', async () => {
    const dir = join(process.env.TIMON_HOME!, 'copied');
    const pkg = join(dir, 'node_modules', 'copied-plugin'); mkdirSync(pkg, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'copied-plugin': '1' } }));
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'copied-plugin', version: '1', type: 'module', main: 'index.js', timon: { id: 'copied-plugin', apiVersion: 1, license: { required: false } } }));
    writeFileSync(join(pkg, 'index.js'), 'throw new Error("PLUGIN EXECUTED")');
    const ctx = new Context();
    const loader = new PluginLoader(ctx, { dir, host: {} as import('./plugins/context.js').PluginHost, allowUnsigned: () => true, licensedPlugins: () => '*' });
    const records = await loader.update();
    assert.equal(records[0].reason, 'skipped:unlicensed');
    const { hashPluginDirectory } = await import('./plugins/signature.js');
    const hash = hashPluginDirectory(pkg);
    writeFileSync(join(pkg, 'SIGNATURE'), JSON.stringify({ alg: 'ed25519', keyId: 'free-test', hash, sig: sign(null, Buffer.from(hash, 'hex'), pair.privateKey).toString('base64') }));
    const signedLoader = new PluginLoader(ctx, { dir, host: {} as import('./plugins/context.js').PluginHost, publicKeys: keys, allowUnsigned: () => true, licensedPlugins: () => '*' });
    const signedRecords = await signedLoader.update();
    assert.equal(signedRecords[0].signed, true);
    assert.equal(signedRecords[0].reason, 'skipped:unlicensed', 'a valid signature is not a commercial grant');
    await signedLoader.dispose();
    await loader.dispose();
  });
  await t.test('Free mounts a plugin without SIGNATURE once developer.unsignedPlugins is true, and only then', async () => {
    // Free is `unlicensed` + `localFree`, never `valid`: until 10/11/2026 the
    // admission gate read `status === 'valid'` and no Free user could load a
    // plugin they wrote themselves (the maintainer's decision of that day).
    activateFree();
    assert.equal(licenseState().status, 'unlicensed');
    assert.equal(licenseState().localFree, true);
    const dir = join(process.env.TIMON_HOME!, 'free-dev');
    const pkg = join(dir, 'node_modules', 'free-dev-plugin'); mkdirSync(pkg, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'free-dev-plugin': '1' } }));
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'free-dev-plugin', version: '1.0.0', type: 'module', main: 'index.js', timon: { id: 'free-dev-plugin', apiVersion: 1 } }));
    writeFileSync(join(pkg, 'index.js'), 'export const name = "free-dev-plugin";\nexport function apply() { globalThis.__timonFreeDevMounted = true; }\n');
    const marker = globalThis as { __timonFreeDevMounted?: boolean };
    const ctx = new Context();
    // A real key in the registry: an unset setting resolves closed, as shipped.
    for (const setting of [undefined, false] as const) {
      const closed = new PluginLoader(ctx, { dir, host: {} as import('./plugins/context.js').PluginHost, publicKeys: keys, allowUnsigned: () => unsignedPluginsAllowed(setting, { keys }), licensedPlugins: () => licenseState().plugins });
      const [record] = await closed.update();
      assert.equal(record.reason, 'skipped:unsigned', `setting ${String(setting)}`);
      assert.equal(marker.__timonFreeDevMounted, undefined, 'refused before import');
      await closed.dispose();
    }
    const open = new PluginLoader(ctx, { dir, host: {} as import('./plugins/context.js').PluginHost, publicKeys: keys, allowUnsigned: () => unsignedPluginsAllowed(true, { keys }), licensedPlugins: () => licenseState().plugins });
    const [record] = await open.update();
    assert.equal(record.state, 'active', record.error ?? '');
    assert.equal(record.signed, false);
    assert.equal(marker.__timonFreeDevMounted, true);
    await open.dispose();
    delete marker.__timonFreeDevMounted;
    fixedPaid();
  });
  await t.test('Free grants every catalogue module and every plugin, machines included', async () => {
    const { CATALOG } = await import('./kernel/catalog.js');
    activateFree();
    const state = licenseState();
    assert.equal(state.modules, '*'); assert.equal(state.plugins, '*'); assert.equal(state.edition, 'expert');
    assert.equal(state.users, 1); assert.equal(state.capabilities?.accounts, 'single-superadmin');
    const cfg = TimonConfigSchema.parse({ edition: 'expert' });
    const { licensedModulesOf } = await import('./kernel/registry.js');
    const decisions = planEntries(CATALOG, { config: cfg, capabilities: [], licensed: licensedModulesOf(CATALOG, state.modules), license: state });
    assert.deepEqual(decisions.filter((d) => d.reason === 'not included in this licence').map((d) => d.id), []);
  });
  await t.test('a pending plugin write refuses a concurrent Free downgrade', async () => {
    paid();
    const { withCompositionWrite } = await import('./license/capabilities.js');
    let release!: () => void;
    const pending = withCompositionWrite(licenseState(), () => new Promise<void>((resolve) => { release = resolve; }));
    assert.throws(() => assertLicenseCompatible(verifyLicenseToken(fixedToken())), /ongoing plugin operation/);
    assert.doesNotThrow(() => assertLicenseCompatible(verifyLicenseToken(token())), 'Free fixes no composition');
    release(); await pending;
    activateFree();
  });
  await t.test('deactivation requires a signed acknowledgement and invalidates a pending renewal', async () => {
    const { writeLicenseKey, readLicenseKey } = await import('./license/refresh.js');
    paid(); installLicenseToken(paidToken());
    writeLicenseKey('TMN-PAID');
    const ack = (init: RequestInit | undefined, value: unknown) => {
      const body = JSON.stringify(value);
      const nonce = new Headers(init?.headers).get('x-timon-nonce');
      return new Response(body, { headers: { 'x-timon-signature': `free-test.${sign(null, Buffer.from(`${nonce}\n200\n${body}`), pair.privateKey).toString('base64url')}` } });
    };
    globalThis.fetch = async () => new Response('{"ok":true}');
    assert.equal((await call('/api/license/deactivate', {})).status, 502);
    assert.equal(readLicenseKey(), 'TMN-PAID');
    let finish!: (r: Response) => void;
    let request: RequestInit | undefined;
    const renewal = new Promise<Response>((resolve) => { finish = resolve; });
    const loop = startLicenseRefresh({ app: null, manual: true, client: { keys, fetch: async (_input, init) => { request = init; return renewal; } } });
    const pending = loop.tick();
    globalThis.fetch = async (_input, init) => ack(init, { ok: true });
    assert.equal((await call('/api/license/deactivate', {})).status, 200);
    assert.equal(readLicenseKey(), null);
    assert.equal(existsSync(LICENSE_FILE), false);
    finish(ack(request, { token: token() })); await pending;
    assert.equal(licenseState().status, 'unlicensed');
    assert.equal(existsSync(LICENSE_FILE), false, 'late renewal cannot resurrect a released seat');
    const { assertLicensedExecution } = await import('./license/capabilities.js');
    assert.doesNotThrow(() => assertLicensedExecution(licenseState()));
    loop.stop(); globalThis.fetch = actualFetch;
    paid(); activateFree();
  });
  await t.test('historical Free credentials never renew, even expired, and are retained', async () => {
    const { writeLicenseKey, readLicenseKey, bootLicenseState } = await import('./license/refresh.js');
    installLicenseToken(token()); writeLicenseKey('TMN-HISTORICAL-FREE');
    const historical = readFileSync(LICENSE_FILE, 'utf8');
    setLicenseState(bootLicenseState({ keys, now: new Date((now + 2000) * 1000) }));
    let calls = 0;
    const loop = startLicenseRefresh({ app: null, manual: true, client: { fetch: async () => { calls++; throw new Error('offline'); } } });
    await loop.tick(); await loop.localTick();
    assert.equal(calls, 0);
    assert.equal(licenseState().localFree, true);
    assert.equal(licenseState().reason, 'missing');
    assert.equal(readLicenseKey(), 'TMN-HISTORICAL-FREE');
    assert.equal(readFileSync(LICENSE_FILE, 'utf8'), historical);
    assert.doesNotThrow(() => assertLicenseCompatible(licenseState()));
    loop.stop();
  });
  await t.test('downgrade suspends extra account access without modifying accounts or configuration', async () => {
    const { freeAccountAllowed } = await import('./users/free-access.js');
    paid();
    const extra = createTestAccount(dbApi, { email: 'retained@example.test', name: 'Retained', passwordHash: 'hash', isSuperadmin: true });
    const { issueSessionToken, hashSessionToken, SESSION_COOKIE } = await import('./users/session.js');
    const session = issueSessionToken();
    dbApi.createSession({ tokenHash: hashSessionToken(session), userId: extra.id, expiresAt: Date.now() + 60000 });
    const { issueMissionApiToken } = await import('./users/api-tokens.js');
    dbApi.createMission('free-transition-mission', 'test-agent', 'transition', undefined, extra.id);
    const bearer = issueMissionApiToken('free-transition-mission');
    const before = dbApi.listUsers();
    const owner = dbApi.getActiveSuperadmin()!;
    assert.equal(freeAccountAllowed(extra.id), true);
    setLicenseState(unlicensed('expired'));
    assert.equal(freeAccountAllowed(owner.id), true);
    assert.equal(freeAccountAllowed(extra.id), false);
    for (const headers of [{ cookie: `${SESSION_COOKIE}=${session}` }, { authorization: `Bearer ${bearer}` }]) {
      const response = await actualFetch(base + '/api/license', { headers });
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.equal(body.error, 'free_account_restricted');
      assert.equal(typeof body.message, 'string');
    }
    assert.deepEqual(dbApi.listUsers(), before);
    paid();
    assert.equal(freeAccountAllowed(extra.id), true);
    dbApi.setUserStatus(extra.id, 'disabled');
    activateFree();
  });
  await t.test('expiry/revocation/removal keep Free restrictions and never grant an offline day', async () => {
    const loop = startLicenseRefresh({ app: null, manual: true, now: () => (now + 1000) * 1000, verify: { keys } });
    await loop.localTick();
    assert.equal(licenseState().status, 'unlicensed');
    assert.doesNotThrow(() => setModuleEnabled('@timon/vault', false));
    setModuleEnabled('@timon/vault', true);
    paid(); activateFree();
    rmSync(LICENSE_FILE);
    await loop.localTick();
    assert.equal(licenseState().status, 'unlicensed');
    assert.equal(readLicense().capabilities?.accounts, 'single-superadmin', 'the account restriction survives a boot');
    assert.equal(readLicense().capabilities?.plugins, 'extensible');
    loop.stop();
  });
  await t.test('nonconforming downgrade is refused even with force, with all rows and the paid token preserved', async () => {
    paid(); installLicenseToken(paidToken());
    const extra = createTestAccount(dbApi, { email: 'paid@example.test', name: 'Paid user', passwordHash: 'hash' });
    const before = readFileSync(LICENSE_FILE, 'utf8');
    const r = await call('/api/license', { token: token(), force: true }, 'PUT');
    assert.equal(r.status, 409); assert.equal(r.body.error, 'free_incompatible');
    assert.equal(readFileSync(LICENSE_FILE, 'utf8'), before);
    assert.ok(dbApi.getUserById(extra.id));
    dbApi.setUserStatus(extra.id, 'disabled');
    assert.doesNotThrow(() => assertLicenseCompatible(verifyLicenseToken(token())));
    activateFree();
    assert.throws(() => dbApi.setUserStatus(extra.id, 'active'), LicenseCapabilityError);
    assert.equal(dbApi.getUserById(extra.id)?.status, 'disabled');
    paid();
    assert.doesNotThrow(() => dbApi.setUserStatus(extra.id, 'active'));
  });
});
