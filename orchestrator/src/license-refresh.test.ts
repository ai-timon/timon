/**
 * Refresh loop (SECU-LICENCES L-1 / L-7): the licence is re-evaluated without
 * a restart, a refusal the server makes switches it off at once, a 429 changes
 * nothing, an unreachable server is tolerated for `offlineHours` and not one
 * minute more.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DaemonMessage } from './daemon-message.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-license-refresh-test-'));
const { bootLicenseState, describeRenewFailure, forgetLicenseKey, paidRightsLapse, recordServerContact, startLicenseRefresh, writeLicenseKey } = await import('./license/refresh.js');
const { LicenseServerError } = await import('./license/client.js');
const { overrideBuildInfo } = await import('./build-info.js');
const { overrideSetupPolicyForTests } = await import('./users/setup-policy.js');
const { installLicenseToken, readLicense, unlicensed } = await import('./license/license.js');
const { licenseState, setLicenseState } = await import('./license/runtime.js');
const { deviceId } = await import('./license/device.js');
const { readLicenseStore, writeLicenseStore } = await import('./license/store.js');
const { bus } = await import('./bus.js');
const { whiteLabelAllowed } = await import('./license/capabilities.js');
const { LICENSE_FILE, LICENSE_KEY_FILE, LICENSE_STATE_FILE } = await import('./paths.js');

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
const messages: DaemonMessage[] = [];
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
    notify: (n) => { notices.push({ title: n.title, urgent: n.urgent }); if (n.message) messages.push(n.message); },
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

test('successful renew: new token installed, contact recorded, no notification', async () => {
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

test('403 revoked: the licence goes off on the spot, bus + card + recomposition, no notification', async () => {
  activated();
  const contact = clock;
  const recomposed = { n: 0 };
  const { refresh } = loop([{ status: 403, body: { error: 'revoked', message: 'nope' } }], recomposed);
  await refresh.tick();
  const state = licenseState();
  assert.equal(state.status, 'unlicensed');
  assert.equal(state.reason, 'revoked');
  assert.equal(recomposed.n, 1);
  // Fallen back to Free: the web app's card says it, nothing doubles it.
  assert.deepEqual(notices, []);
  assert.deepEqual(paidRightsLapse(state), { cause: 'refused', since: new Date(contact * 1000).toISOString() });
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

test('403 deactivated / not_active and 403 expired each have their own reason', async () => {
  for (const [code, reason] of [['deactivated', 'deactivated'], ['not_active', 'deactivated'], ['expired', 'expired']] as const) {
    activated();
    const { refresh } = loop([{ status: 403, body: { error: code } }]);
      await refresh.tick();
    assert.equal(licenseState().reason, reason, code);
  }
});

test('429: nothing changes', async () => {
  activated();
  const { refresh } = loop([{ status: 429, body: { error: 'rate_limited' } }]);
  await refresh.tick();
  assert.equal(licenseState().status, 'valid');
  assert.equal(licenseState().offlineSince, null);
  assert.equal(events.length, 0);
});

test('409 device_mismatch: invalid:machine, the device identifier is NOT rotated', async () => {
  activated();
  const before = deviceId();
  const { refresh, calls } = loop([{ status: 409, body: { error: 'device_mismatch' } }]);
  await refresh.tick();
  assert.equal(licenseState().reason, 'invalid:machine');
  assert.equal(deviceId(), before);
  assert.deepEqual(calls, ['/api/v1/license/renew']); // no second, rotated activation
});

test('unreachable server: offline tolerated for offlineHours without a word, cut-off afterwards', async () => {
  // A token of its own: an earlier test persisted a refusal against the token of this second.
  clock += 1;
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
  assert.equal(paidRightsLapse(licenseState()), null, 'a passing outage shows no card');
  // 13 h, past half the tolerance: still nothing — the outage is not the user's doing.
  clock = contact + 13 * 3600;
  await refresh.tick();
  await refresh.tick();
  assert.deepEqual(notices, []);
  assert.deepEqual(messages, []);
  assert.equal(paidRightsLapse(licenseState()), null);
  // 25 h: the local tick switches the licence off, network or not.
  clock = contact + 25 * 3600;
  await refresh.localTick();
  state = licenseState();
  assert.equal(state.status, 'unlicensed');
  assert.equal(state.reason, 'expired');
  assert.deepEqual(notices, [], 'the card carries it, no notification');
  const lapse = { cause: 'offline', since: new Date(contact * 1000).toISOString() };
  assert.deepEqual(paidRightsLapse(state), lapse);
  // Restarts read the same episode: the same card, never a new one.
  for (let restart = 0; restart < 3; restart += 1) {
    clock += 3600;
    setLicenseState(bootLicenseState({ keys, now: new Date(nowMs()) }));
    await loop(['down']).refresh.tick();
    assert.deepEqual(paidRightsLapse(licenseState()), lapse, `restart ${restart}`);
  }
  assert.deepEqual(notices, []);
  // A renewal that goes through brings the rights back, and the card leaves.
  await loop([{ status: 200, body: { token: token(clock), refresh: { every: 300, offlineHours: 24 } } }]).refresh.tick();
  assert.equal(licenseState().status, 'valid');
  assert.equal(paidRightsLapse(licenseState()), null);
  assert.deepEqual(notices, []);
});

test('an unsigned response counts as offline, never as a refusal', async () => {
  activated();
  const { refresh } = loop([{ status: 403, body: { error: 'revoked' }, unsigned: true }]);
  clock += 60;
  await refresh.tick();
  assert.equal(licenseState().status, 'valid');
  assert.notEqual(licenseState().offlineSince, null);
});

test('without a persisted key, no network call: a token set by hand expires on its own', async () => {
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

test('bootLicenseState: an expired token stays good within the offline window, and says so', () => {
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

// TIM-0147: a hard reset of a VPS left `license.state.json` empty. Its
// `lastContact` gone, the boot read the token as never renewed: `expired`, and
// a beta build locked itself to a lite composition.
for (const [label, content] of [['empty', ''], ['cut short', '{"every":300,"lastCon'], ['of the wrong shape', '{"lastContact":"yesterday"}']] as const) {
  test(`bootLicenseState: a ${label} license.state.json keeps the offline tolerance, counted from the token file`, () => {
    activated();
    const contact = clock;
    utimesSync(LICENSE_FILE, contact, contact);
    writeFileSync(LICENSE_STATE_FILE, content);
    clock = contact + 3600;
    const state = bootLicenseState({ keys, now: new Date(nowMs()) });
    assert.equal(state.status, 'valid');
    assert.equal(state.offlineSince, new Date(contact * 1000).toISOString());
    assert.equal(readLicenseStore().lastContact, contact, 'the store is rewritten, so the loop counts from the same instant');
  });
}

test('bootLicenseState: a damaged store grants no more than the tolerance would have', () => {
  activated();
  const contact = clock;
  utimesSync(LICENSE_FILE, contact, contact);
  writeFileSync(LICENSE_STATE_FILE, '');
  clock = contact + 25 * 3600;
  assert.equal(bootLicenseState({ keys, now: new Date(nowMs()) }).reason, 'expired');
});

test('bootLicenseState: without an activation key, a damaged store grants nothing', () => {
  activated();
  const contact = clock;
  utimesSync(LICENSE_FILE, contact, contact);
  rmSync(LICENSE_KEY_FILE);
  writeFileSync(LICENSE_STATE_FILE, '');
  clock = contact + 3600;
  assert.equal(bootLicenseState({ keys, now: new Date(nowMs()) }).reason, 'expired', 'a hand-installed token says nothing about the server');
});

test('bootLicenseState: a damaged store gets its clock anchors back from the token', () => {
  activated();
  const contact = clock;
  utimesSync(LICENSE_FILE, contact, contact);
  writeFileSync(LICENSE_STATE_FILE, '');
  clock = contact + 3600;
  assert.equal(bootLicenseState({ keys, now: new Date(nowMs()) }).status, 'valid');
  assert.equal(readLicenseStore().maxSrv, contact, 'the server clock of the last accepted token');
  assert.ok((readLicenseStore().lastSeen ?? 0) >= contact, 'and a local clock seen since');
  // An older token replayed after the reset is a rollback again.
  writeFileSync(LICENSE_FILE, token(contact - 3600) + '\n');
  assert.equal(readLicense(LICENSE_FILE, { keys, device: DEVICE, now: new Date(nowMs()) }).reason, 'invalid:clock:rollback');
  writeFileSync(LICENSE_FILE, '');
});

/**
 * No licence is Free (the maintainer's decision, 17/11/2026), so nothing is
 * asked of the server for it. A paid licence that expired while the daemon was
 * off is not "no licence" though: with its activation key on disk, it is
 * renewed, silently, and its rights come back (decision of 18/11/2026).
 */
function expiredWhileOff(): void {
  activated();
  clock += 25 * 3600; // past the 24 h offline tolerance
  const boot = bootLicenseState({ keys, now: new Date(nowMs()) });
  assert.equal(boot.reason, 'expired');
  setLicenseState(boot);
  assert.equal(licenseState().localFree, true, 'the expired licence falls back to Free');
  notices.length = 0;
  messages.length = 0;
}

test('a paid licence that expired while the daemon was off is renewed with its key, without a word', async () => {
  for (const build of ['stable', 'beta'] as const) {
    overrideBuildInfo({ channel: build, builtAt: new Date((clock - 86_400) * 1000).toISOString(), expiresAt: null });
    try {
      expiredWhileOff();
      const { refresh, calls } = loop(['down', { status: 200, body: { token: token(clock), refresh: { every: 300, offlineHours: 24 } } }]);
      await refresh.tick();
      assert.deepEqual(calls, ['/api/v1/license/renew'], `${build}: the renewal is attempted`);
      assert.equal(licenseState().localFree, true, `${build}: still Free while the server is out of reach`);
      assert.equal(licenseState().offlineSince, null, `${build}: no offline banner for a licence not in force`);
      await refresh.tick();
      assert.equal(calls.length, 2);
      assert.equal(licenseState().status, 'valid', `${build}: the licence is back`);
      assert.equal(licenseState().planId, base.plan);
      assert.equal(licenseState().users, base.users ?? null);
      assert.deepEqual(notices, [], `${build}: nobody is told anything`);
    } finally { overrideBuildInfo(undefined); }
  }
});

test('a definitive refusal of the expired licence turns its card to "refused", then nothing more is asked', async () => {
  const refusals: [number, string][] = [[403, 'revoked'], [403, 'unknown_key'], [403, 'expired'], [409, 'device_mismatch']];
  for (const [status, code] of refusals) {
    expiredWhileOff();
    assert.equal(paidRightsLapse(licenseState())?.cause, 'offline', `${code}: paused until the server answers`);
    events.length = 0;
    const { refresh, calls } = loop([{ status, body: { error: code } }, { status: 200, body: { token: token(clock) } }]);
    await refresh.tick();
    assert.equal(calls.length, 1, code);
    assert.deepEqual(notices, [], `${code}: the card says it, no notification`);
    const lapse = paidRightsLapse(licenseState());
    assert.equal(lapse?.cause, 'refused', code);
    assert.ok(events.length >= 1, `${code}: the web app is told to read the state again`);
    assert.equal(licenseState().localFree, true, `${code}: Free goes on`);
    await refresh.tick(); await refresh.localTick(); await refresh.tick();
    assert.equal(calls.length, 1, `${code}: no request after the refusal`);

    // The refusal is persisted: a restart does not ask again, and reads the same card.
    for (let restart = 0; restart < 2; restart += 1) {
      setLicenseState(bootLicenseState({ keys, now: new Date(nowMs()) }));
      const after = loop([{ status: 200, body: { token: token(clock) } }]);
      await after.refresh.tick();
      assert.deepEqual(after.calls, [], `${code}: nothing asked after a restart`);
      assert.deepEqual(paidRightsLapse(licenseState()), lapse, `${code}: same episode after a restart`);
    }
    assert.deepEqual(notices, []);
  }
});

test('no card without paid rights to lose: Free, a licence in force, a beta build', async () => {
  // A licence in force, the server answering or not.
  activated();
  assert.equal(paidRightsLapse(licenseState()), null);
  // Free: no activation key on disk, whatever ended the licence before it.
  for (const reason of ['missing', 'expired', 'revoked', 'deactivated'] as const) {
    activated();
    forgetLicenseKey();
    assert.equal(paidRightsLapse(unlicensed(reason)), null, reason);
  }
  // A beta build locks instead of falling back to Free: its lock screen speaks.
  await onBetaBuild(async () => {
    activated();
    setLicenseState(unlicensed('expired'));
    assert.equal(licenseState().localFree, false);
    assert.equal(paidRightsLapse(licenseState()), null);
  });
});

test('without an activation key, or with a retired Free token, nothing reaches the licence server', async () => {
  for (const build of ['stable', 'beta'] as const) {
    overrideBuildInfo({ channel: build, builtAt: new Date((clock - 86_400) * 1000).toISOString(), expiresAt: null });
    try {
      expiredWhileOff();
      forgetLicenseKey();
      const { refresh, calls } = loop([{ status: 200, body: { token: token(clock) } }]);
      await refresh.tick(); await refresh.localTick(); await refresh.tick();
      assert.deepEqual(calls, [], `${build}: no key, no renewal`);
      assert.equal(licenseState().localFree, true);

      // A Free token the server once issued, with its key: read as no licence.
      writeLicenseKey('TMN-REFRESH');
      writeFileSync(LICENSE_FILE, token(clock, { plan: 'free' }) + '\n');
      setLicenseState(bootLicenseState({ keys, now: new Date(nowMs()) }));
      assert.equal(licenseState().reason, 'missing');
      await refresh.tick(); await refresh.localTick();
      assert.deepEqual(calls, [], `${build}: a Free token has nothing to renew`);

      forgetLicenseKey();
      rmSync(LICENSE_FILE, { force: true });
      setLicenseState(bootLicenseState({ keys, now: new Date(nowMs()) }));
      assert.equal(licenseState().reason, 'missing');
      await refresh.tick(); await refresh.localTick();
      assert.deepEqual(calls, [], `${build}: nothing to ask without a token either`);
      assert.deepEqual(notices, [], `${build}: no alert`);
    } finally { overrideBuildInfo(undefined); }
  }
});

test('the licence files are replaced whole, with no temporary file left behind', () => {
  activated();
  writeLicenseStore({ every: 600 });
  assert.equal(readLicenseStore().every, 600);
  assert.equal(readFileSync(LICENSE_KEY_FILE, 'utf8'), 'TMN-REFRESH\n');
  assert.ok(existsSync(LICENSE_FILE));
  const dir = join(LICENSE_STATE_FILE, '..');
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
});

test('a renewed token this daemon refuses (another machine) turns the licence off', async () => {
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
    notify: (n) => { notices.push({ title: n.title, urgent: n.urgent }); if (n.message) messages.push(n.message); },
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

/**
 * TIM-0147: a beta build booted with its licence read as off, the first
 * renewals failed, and nothing told anyone: the dispatcher stayed down for an
 * hour. A licence left off by a failed renewal, with an activation key to
 * renew, now raises one alert per episode.
 */
async function onBetaBuild(body: () => Promise<void>): Promise<void> {
  overrideSetupPolicyForTests('beta');
  overrideBuildInfo({ channel: 'beta', builtAt: new Date((clock - 86_400) * 1000).toISOString(), expiresAt: null });
  try { await body(); } finally {
    overrideBuildInfo(undefined);
    overrideSetupPolicyForTests(undefined);
  }
}

test('a licence left off by a failed renewal raises one urgent alert, re-armed once valid again', async () => {
  await onBetaBuild(async () => {
    activated();
    setLicenseState(unlicensed('expired'));
    assert.equal(licenseState().reason, 'beta_ended', 'what the tester saw after the reboot');
    clock += 60;
    const { refresh, calls } = loop(['down', 'down', { status: 200, body: { token: token(clock) } }, 'down']);
    await refresh.tick();
    assert.equal(calls.length, 1, 'a locked beta build still tries to renew');
    assert.deepEqual(notices, [{ title: 'Licence not renewed', urgent: true }]);
    await refresh.tick();
    assert.equal(notices.length, 1, 'once per episode, not once per tick');

    await refresh.tick();
    assert.equal(licenseState().status, 'valid');

    setLicenseState(unlicensed('expired'));
    await refresh.tick();
    assert.equal(notices.length, 2, 'a new episode alerts again');
  });
});

test('a 429 on a licence that is off is reported too; on a valid one, it still changes nothing', async () => {
  await onBetaBuild(async () => {
    activated();
    await loop([{ status: 429, body: { error: 'rate_limited' } }]).refresh.tick();
    assert.equal(notices.length, 0);

    setLicenseState(unlicensed('expired'));
    await loop([{ status: 429, body: { error: 'rate_limited' } }]).refresh.tick();
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.urgent, true);
  });
});

test('a licence that is valid while the server is down raises no such alert', async () => {
  activated();
  clock += 60;
  await loop(['down']).refresh.tick();
  assert.equal(licenseState().status, 'valid');
  assert.deepEqual(notices, []);
});

/**
 * TIM-0147: at boot the network is often not up yet, and a licence read as
 * off then kept its modules off for a whole 300 s interval. A renewal that
 * failed for want of a network is retried a few times sooner, and only that.
 */
async function bootLoop(replies: Reply[], body: (s: ReturnType<typeof server>, stop: () => void) => Promise<void>, bootRetryMs: readonly number[] = [10, 20, 40]): Promise<void> {
  const s = server(replies);
  const refresh = startLicenseRefresh({
    app: null,
    client: { baseUrl: 'https://licence.test', fetch: s.fetch, keys },
    verify: { keys, device: DEVICE },
    now: nowMs,
    notify: (n) => { notices.push({ title: n.title, urgent: n.urgent }); },
    bootRetryMs,
  });
  try { await body(s, () => refresh.stop()); } finally { refresh.stop(); }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reach(calls: string[], expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && calls.length < expected) await pause(5);
}

async function settle(calls: string[], expected: number): Promise<void> {
  await reach(calls, expected);
  // Past the last retry delay: a call that was going to come has come.
  await pause(150);
}

test('a boot renewal without network is retried quickly until it goes through', async () => {
  await onBetaBuild(async () => {
    activated();
    setLicenseState(unlicensed('expired'));
    clock += 60;
    await bootLoop(['down', 'down', { status: 200, body: { token: token(clock), refresh: { every: 300, offlineHours: 24 } } }, 'down'], async ({ calls }) => {
      await settle(calls, 3);
      assert.equal(calls.length, 3, 'two quick retries, then nothing once renewed');
      assert.equal(licenseState().status, 'valid');
    });
  });
});

test('an expired paid licence is retried quickly at boot too, and comes back', async () => {
  expiredWhileOff();
  await bootLoop(['down', 'down', { status: 200, body: { token: token(clock), refresh: { every: 300, offlineHours: 24 } } }, 'down'], async ({ calls }) => {
    await settle(calls, 3);
    assert.equal(calls.length, 3, 'the boot renewal, two quick retries, then nothing');
    assert.equal(licenseState().status, 'valid');
    assert.deepEqual(notices, []);
  });
});

test('the quick boot retries are bounded, then the regular interval takes over', async () => {
  activated();
  clock += 60;
  await bootLoop(['down', 'down', 'down', 'down', 'down', 'down'], async ({ calls }) => {
    await settle(calls, 4);
    assert.equal(calls.length, 4, 'the first renewal and three retries');
    assert.equal(licenseState().status, 'valid', 'offline within the tolerance changes nothing');
  });
});

test('a quick boot retry never lands on the regular interval the server announced', async () => {
  activated();
  recordServerContact({ every: 1, offlineHours: 24 }, nowMs());
  clock += 60;
  await bootLoop(['down', 'down', 'down', 'down', 'down', 'down'], async ({ calls }) => {
    await pause(1_600);
    // At 0 and 100 ms the boot and its first retry, at 1 s the interval. The
    // retry due at 1.3 s would come after the interval started: dropped.
    assert.equal(calls.length, 3);
  }, [100, 1_200, 100]);
  recordServerContact({ every: 300, offlineHours: 24 }, nowMs());
});

test('an answer from the server is not retried quickly: 429 and refusals', async () => {
  activated();
  await bootLoop([{ status: 429, body: { error: 'rate_limited' } }, 'down'], async ({ calls }) => {
    await settle(calls, 1);
    assert.equal(calls.length, 1, 'asking sooner would make the rate limit worse');
  });
  activated();
  await bootLoop([{ status: 403, body: { error: 'revoked' } }, 'down'], async ({ calls }) => {
    await settle(calls, 1);
    assert.equal(calls.length, 1);
    assert.equal(licenseState().reason, 'revoked');
  });
});

test('no quick retry without an activation key, nor after stop()', async () => {
  activated();
  forgetLicenseKey();
  await bootLoop(['down'], async ({ calls }) => {
    await settle(calls, 0);
    assert.equal(calls.length, 0, 'a token installed by hand has nothing to renew');
  });
  activated();
  clock += 60;
  await bootLoop(['down', 'down', 'down', 'down'], async ({ calls }, stop) => {
    await reach(calls, 1);
    stop();
    await pause(400);
    assert.equal(calls.length, 1, 'a stopped loop asks nothing more');
  }, [100, 100, 100]);
});

test('every renewal failure names its side, and never the key', () => {
  const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }) });
  assert.equal(describeRenewFailure(refused), 'network: ECONNREFUSED');
  assert.equal(describeRenewFailure(new TypeError('fetch failed')), 'network: fetch failed');
  assert.equal(describeRenewFailure(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 'network: license server did not answer in time');
  assert.equal(describeRenewFailure(new LicenseServerError(429, 'rate_limited')), 'rate limited by the license server (429)');
  assert.equal(describeRenewFailure(new LicenseServerError(503, 'http_503')), 'license server answered 503 http_503');
  assert.equal(describeRenewFailure(new LicenseServerError(502, 'unsigned_response', 'license server answer is not signed (HTTP 502)')), 'license server answered 502 unsigned_response');
});
