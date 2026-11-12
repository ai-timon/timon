/**
 * Refresh loop (SECU-LICENCES L-1 / L-7): the licence is re-evaluated without
 * a restart, a refusal the server makes switches it off at once, a 429 changes
 * nothing, an unreachable server is tolerated for `offlineHours` and not one
 * minute more.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-license-refresh-test-'));
const { bootLicenseState, recordServerContact, startLicenseRefresh, writeLicenseKey } = await import('./license/refresh.js');
const { installLicenseToken, readLicense } = await import('./license/license.js');
const { licenseState, setLicenseState } = await import('./license/runtime.js');
const { deviceId } = await import('./license/device.js');
const { readLicenseStore, writeLicenseStore } = await import('./license/store.js');
const { bus } = await import('./bus.js');
const { whiteLabelAllowed } = await import('./license/capabilities.js');
const { LICENSE_FILE } = await import('./paths.js');

const fixture = JSON.parse(readFileSync(new URL('../fixtures/token-claims.json', import.meta.url), 'utf8')) as {
  examples: { name: string; claims: Record<string, unknown> }[];
};
const { fph: _fph, ...base } = fixture.examples.find((e) => e.name === 'beta-1-year')!.claims;
const pair = generateKeyPairSync('ed25519');
const keys = [{ keyId: 'test', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
const DEVICE = deviceId();
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function token(at: number, overrides: Record<string, unknown> = {}): string {
  const input = `${enc({ alg: 'EdDSA', typ: 'JWT', kid: 'test' })}.${enc({ ...base, did: DEVICE, iat: at, nbf: at - 60, exp: at + 900, srv: at, ...overrides })}`;
  return `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`;
}

/** A clock the test moves by hand, in Unix seconds. */
let clock = Math.floor(Date.now() / 1000);
const nowMs = () => clock * 1000;

type Reply = { status: number; body: unknown; unsigned?: boolean } | 'down';
function server(replies: Reply[]) {
  const calls: string[] = [];
  const fetchLike = (async (url: unknown, init: unknown) => {
    calls.push(new URL(String(url)).pathname);
    const reply = replies.shift() ?? 'down';
    if (reply === 'down') throw new TypeError('fetch failed');
    const text = JSON.stringify(reply.body);
    const headers = new Headers();
    if (!reply.unsigned) {
      const nonce = (init as { headers: Record<string, string> }).headers['x-timon-nonce']!;
      headers.set('x-timon-signature', `test.${sign(null, Buffer.from(`${nonce}\n${reply.status}\n${text}`), pair.privateKey).toString('base64url')}`);
    }
    return { ok: reply.status < 300, status: reply.status, headers, text: async () => text };
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchLike };
}

const notices: { title: string; urgent: boolean }[] = [];
const events: unknown[] = [];
bus.on('event', (ev: { kind: string }) => { if (ev.kind === 'license_changed') events.push(ev); });

function loop(replies: Reply[], recomposed?: { n: number }) {
  const s = server(replies);
  const refresh = startLicenseRefresh({
    app: recomposed ? ({ get: () => undefined } as never) : null,
    client: { baseUrl: 'https://licence.test', fetch: s.fetch, keys },
    verify: { keys, device: DEVICE },
    now: nowMs,
    recompose: recomposed ? async () => { recomposed.n += 1; } : undefined,
    notify: (n) => { notices.push({ title: n.title, urgent: n.urgent }); },
    manual: true,
  });
  return { ...s, refresh };
}

/** Fresh, valid, activated state with a persisted key and a server contact. */
function activated(): void {
  writeLicenseKey('TMN-REFRESH');
  setLicenseState(installLicenseToken(token(clock), LICENSE_FILE, { keys, device: DEVICE, fresh: true, now: new Date(nowMs()) }));
  recordServerContact({ every: 300, offlineHours: 24 }, nowMs());
  notices.length = 0;
  events.length = 0;
}

test('renew réussi : nouveau jeton installé, contact enregistré, aucune notification', async () => {
  activated();
  clock += 600;
  const recomposed = { n: 0 };
  const { refresh, calls } = loop([{ status: 200, body: { token: token(clock), refresh: { every: 300, offlineHours: 24 } } }], recomposed);
  await refresh.tick();
  assert.deepEqual(calls, ['/api/v1/license/renew']);
  assert.equal(licenseState().status, 'valid');
  assert.equal(readLicenseStore().lastContact, clock);
  assert.equal(readLicense(LICENSE_FILE, { keys, device: DEVICE, now: new Date(nowMs()) }).status, 'valid');
  assert.equal(notices.length, 0);
});

test('a renewal that only adds or withdraws `whitelabel` recomposes the daemon', async () => {
  activated();
  const features = base.features as string[];
  const recomposed = { n: 0 };
  clock += 600;
  const grant = loop([{ status: 200, body: { token: token(clock, { features: [...features, 'whitelabel'] }), refresh: { every: 300, offlineHours: 24 } } }], recomposed);
  await grant.refresh.tick();
  assert.equal(recomposed.n, 1, 'the loader must re-read the right');
  assert.equal(whiteLabelAllowed(licenseState()), true);
  clock += 600;
  const same = loop([{ status: 200, body: { token: token(clock, { features: [...features, 'whitelabel'] }), refresh: { every: 300, offlineHours: 24 } } }], recomposed);
  await same.refresh.tick();
  assert.equal(recomposed.n, 1, 'an identical renewal changes nothing');
  clock += 600;
  const withdraw = loop([{ status: 200, body: { token: token(clock), refresh: { every: 300, offlineHours: 24 } } }], recomposed);
  await withdraw.refresh.tick();
  assert.equal(recomposed.n, 2);
  assert.equal(whiteLabelAllowed(licenseState()), false);
});

test('403 revoked : la licence s\'éteint sur-le-champ, bus + notification + recomposition', async () => {
  activated();
  const recomposed = { n: 0 };
  const { refresh } = loop([{ status: 403, body: { error: 'revoked', message: 'nope' } }], recomposed);
  await refresh.tick();
  const state = licenseState();
  assert.equal(state.status, 'unlicensed');
  assert.equal(state.reason, 'revoked');
  assert.equal(recomposed.n, 1);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.urgent, true);
  assert.deepEqual((events.at(-1) as { status: string; reason: string }), { kind: 'license_changed', status: 'unlicensed', reason: 'revoked', offlineSince: null } as never);
});

test('a signed revocation survives restart and Free makes no subsequent renewal request', async () => {
  activated();
  const { refresh, calls } = loop([{ status: 403, body: { error: 'revoked' } }]);
  await refresh.tick();
  const boot = bootLicenseState({ keys, now: new Date(nowMs()) });
  assert.equal(boot.reason, 'revoked');
  assert.equal(boot.localFree, true);
  setLicenseState(boot);
  await refresh.tick(); await refresh.localTick();
  assert.equal(calls.length, 1);
});

test('403 deactivated / not_active et 403 expired ont chacun leur raison', async () => {
  for (const [code, reason] of [['deactivated', 'deactivated'], ['not_active', 'deactivated'], ['expired', 'expired']] as const) {
    activated();
    const { refresh } = loop([{ status: 403, body: { error: code } }]);
      await refresh.tick();
    assert.equal(licenseState().reason, reason, code);
  }
});

test('429 : rien ne change', async () => {
  activated();
  const { refresh } = loop([{ status: 429, body: { error: 'rate_limited' } }]);
  await refresh.tick();
  assert.equal(licenseState().status, 'valid');
  assert.equal(licenseState().offlineSince, null);
  assert.equal(events.length, 0);
});

test('409 device_mismatch : invalid:machine, l\'identifiant d\'appareil n\'est PAS tourné', async () => {
  activated();
  const before = deviceId();
  const { refresh, calls } = loop([{ status: 409, body: { error: 'device_mismatch' } }]);
  await refresh.tick();
  assert.equal(licenseState().reason, 'invalid:machine');
  assert.equal(deviceId(), before);
  assert.deepEqual(calls, ['/api/v1/license/renew']); // no second, rotated activation
});

test('serveur injoignable : hors-ligne toléré offlineHours, alerte à mi-course, coupure ensuite', async () => {
  activated();
  const contact = clock;
  const { refresh } = loop(['down', 'down', 'down', 'down']);
  // 1 h later: still valid, flagged offline since the last contact.
  clock = contact + 3600;
  await refresh.tick();
  let state = licenseState();
  assert.equal(state.status, 'valid');
  assert.equal(state.offlineSince, new Date(contact * 1000).toISOString());
  assert.equal(notices.length, 0);
  // The token expired long ago, but the local tick honours the tolerance.
  await refresh.localTick();
  assert.equal(licenseState().status, 'valid');
  // 13 h: past half the tolerance — one warning, not urgent.
  clock = contact + 13 * 3600;
  await refresh.tick();
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.urgent, false);
  await refresh.tick();
  assert.equal(notices.length, 1, 'warned once per episode');
  // 25 h: the local tick switches the licence off, network or not.
  clock = contact + 25 * 3600;
  await refresh.localTick();
  state = licenseState();
  assert.equal(state.status, 'unlicensed');
  assert.equal(state.reason, 'expired');
  assert.equal(notices.length, 2);
  assert.equal(notices[1]!.urgent, true);
});

test('une réponse non signée compte comme hors-ligne, jamais comme un refus', async () => {
  activated();
  const { refresh } = loop([{ status: 403, body: { error: 'revoked' }, unsigned: true }]);
  clock += 60;
  await refresh.tick();
  assert.equal(licenseState().status, 'valid');
  assert.notEqual(licenseState().offlineSince, null);
});

test('sans clé persistée, aucun appel réseau : le jeton posé à la main expire seul', async () => {
  activated();
  const { forgetLicenseKey } = await import('./license/refresh.js');
  forgetLicenseKey();
  const { refresh, calls } = loop([{ status: 200, body: { token: token(clock) } }]);
  await refresh.tick();
  assert.equal(calls.length, 0);
  // Well past the token, no server contact recorded within tolerance → off.
  writeLicenseStore({ lastContact: clock - 48 * 3600 });
  clock += 1000;
  await refresh.localTick();
  assert.equal(licenseState().reason, 'expired');
});

test('bootLicenseState : un jeton périmé reste bon dans la fenêtre hors-ligne, et le dit', () => {
  activated();
  const contact = clock;
  clock = contact + 3600;
  const state = bootLicenseState({ keys, now: new Date(nowMs()) });
  assert.equal(state.status, 'valid');
  assert.equal(state.offlineSince, new Date(contact * 1000).toISOString());
  clock = contact + 25 * 3600;
  assert.equal(bootLicenseState({ keys, now: new Date(nowMs()) }).reason, 'expired');
  // A token that still verifies is not "offline".
  clock = contact;
  assert.equal(bootLicenseState({ keys, now: new Date(nowMs()) }).offlineSince, null);
});

test('un jeton renouvelé que ce daemon refuse (autre machine) éteint la licence', async () => {
  activated();
  const { refresh } = loop([{ status: 200, body: { token: token(clock, { did: 'dev_0000000000000000' }) } }]);
  await refresh.tick();
  assert.equal(licenseState().reason, 'invalid:machine');
  // The previous, valid token was not overwritten by the refused one.
  assert.equal(readLicense(LICENSE_FILE, { keys, device: DEVICE, now: new Date(nowMs()) }).status, 'valid');
  writeFileSync(LICENSE_FILE, ''); // leave nothing behind for other tests
});


test('removing the token revokes cached rights on the local tick', async () => {
  activated();
  rmSync(LICENSE_FILE);
  const recomposed = { n: 0 };
  const { refresh } = loop([], recomposed);
  await refresh.localTick();
  assert.equal(licenseState().reason, 'missing');
  assert.equal(licenseState().modules, '*');
  assert.equal(recomposed.n, 1);
});

test('renewing only module, plugin or user rights triggers recomposition', async () => {
  for (const changes of [{ modules: [] }, { plugins: [] }, { users: 1 }]) {
    activated();
    const recomposed = { n: 0 };
    const { refresh } = loop([{ status: 200, body: { token: token(clock, changes) } }], recomposed);
    await refresh.tick();
    assert.equal(licenseState().status, 'valid');
    assert.equal(recomposed.n, 1, JSON.stringify(changes));
  }
});

test('callers cannot mutate the stored licence through input or output arrays', () => {
  activated();
  const state = { ...licenseState(), modules: ['@timon/dreams'], plugins: ['example'] };
  setLicenseState(state);
  state.modules.push('@timon/kanban-code');
  state.plugins.push('injected');
  const result = licenseState();
  assert.deepEqual(result.modules, ['@timon/dreams']);
  assert.deepEqual(result.plugins, ['example']);
  if (result.modules !== '*') result.modules.push('@timon/kanban-code');
  assert.deepEqual(licenseState().modules, ['@timon/dreams']);
});

test('TIM-0024: an unreadable machine id does not switch the licence off; a different one does', async () => {
  const { fingerprintHash } = await import('./license/license.js');
  writeLicenseKey('TMN-REFRESH');
  const bound = token(clock, { fph: fingerprintHash('machine-a') });
  setLicenseState(installLicenseToken(bound, LICENSE_FILE, { keys, device: DEVICE, fingerprint: 'machine-a', fresh: true, now: new Date(nowMs()) }));
  assert.equal(licenseState().status, 'valid');
  const run = (readable: boolean) => startLicenseRefresh({
    app: null, verify: { keys, device: DEVICE, fingerprint: 'machine-b' }, now: nowMs,
    notify: (n) => { notices.push({ title: n.title, urgent: n.urgent }); },
    manual: true, fingerprintReadable: () => readable,
  });
  await run(false).localTick();
  assert.equal(licenseState().status, 'valid', 'a failed read is not a verdict');
  await run(true).localTick();
  assert.equal(licenseState().reason, 'invalid:fingerprint');
  writeFileSync(LICENSE_FILE, '');
});

test('TIM-0024: a licence valid again retires the alerts that said it was off', async () => {
  const { clearLicenseAlerts, LICENSE_ALERT_ANCHOR } = await import('./license/refresh.js');
  const { dbApi } = await import('./db.js');
  const stale = dbApi.createNotification({ id: 'license-alert', type: 'alert', urgent: true, title: 'Licence is no longer valid', anchor: LICENSE_ALERT_ANCHOR });
  const other = dbApi.createNotification({ id: 'other-alert', type: 'alert', urgent: true, title: 'Task blocked', anchor: '/kanban' });
  await clearLicenseAlerts();
  assert.ok(dbApi.getNotification(stale.id)?.dismissed_at);
  assert.equal(dbApi.getNotification(other.id)?.dismissed_at, null);
});
