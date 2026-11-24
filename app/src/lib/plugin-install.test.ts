// french-ok-file: the French locale of the install prompt under test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHIVE_ACCEPT,
  confirmInstall,
  installErrorMessage,
  PLUGIN_UPLOAD_MAX_BYTES,
  PluginInstallError,
  previewImage,
  signatureSummary,
  stageDetected,
  stageUpload,
} from './plugin-install';

type Call = { url: string; init: RequestInit | undefined };

function mockFetch(respond: (url: string) => Response): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(String(input));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('the confirmation carries the token and an explicit `confirm: true`, nothing else', async () => {
  const mock = mockFetch(() => Response.json({ ok: true, id: 'x', pkg: 'x', version: '1', refused: null, signature: { state: 'signed' } }));
  try {
    await confirmInstall('a'.repeat(48));
    assert.equal(mock.calls[0]?.url, '/api/ui/plugin-install/confirm');
    assert.equal(mock.calls[0]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(mock.calls[0]?.init?.body)), { token: 'a'.repeat(48), confirm: true });
  } finally { mock.restore(); }
});

test('a detected package is staged by its name, never by a path', async () => {
  const mock = mockFetch(() => Response.json({ token: 't' }, { status: 201 }));
  try {
    await stageDetected('acme-1.0.0.tgz');
    assert.deepEqual(JSON.parse(String(mock.calls[0]?.init?.body)), { source: 'detected', name: 'acme-1.0.0.tgz' });
  } finally { mock.restore(); }
});

test('an archive over the limit is refused before any upload', async () => {
  const mock = mockFetch(() => Response.json({}));
  try {
    const big = new Blob([new Uint8Array(PLUGIN_UPLOAD_MAX_BYTES + 1)]);
    await assert.rejects(stageUpload(big), (err) => err instanceof PluginInstallError && err.code === 'too-large');
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
});

test('a refusal reaches the user as a sentence, with the daemon code kept', async () => {
  const mock = mockFetch(() => Response.json({ error: 'unsafe-path', message: 'archive entry escaping its folder' }, { status: 400 }));
  try {
    await assert.rejects(stageUpload(new Blob([new Uint8Array(4)])), (err) => {
      assert.ok(err instanceof PluginInstallError);
      assert.equal(err.code, 'unsafe-path');
      assert.equal(err.status, 400);
      assert.ok(err.message.length > 0 && err.message !== 'unsafe-path');
      return true;
    });
  } finally { mock.restore(); }
  assert.notEqual(installErrorMessage(401, null), installErrorMessage(403, null));
  assert.equal(installErrorMessage(500, { error: 'weird', message: 'daemon says' }), 'daemon says');
});

test('a binary identity refusal keeps the words of the daemon: only they quote what the program printed (TODO #588)', () => {
  const message = '`/usr/bin/agent` is not the program provider `acme` runs: `--version` printed "other 1.0".';
  assert.equal(installErrorMessage(409, { error: 'binary-identity', message }), message);
});

test('the browser picker offers .zip beside .tgz (TODO #345)', () => {
  const accepted = ARCHIVE_ACCEPT.split(',');
  for (const entry of ['.tgz', '.tar.gz', '.zip', 'application/zip']) assert.ok(accepted.includes(entry), entry);
});

test('the zip refusals have sentences of their own, not the daemon message', () => {
  for (const code of ['not-archive', 'zip64', 'encrypted', 'multi-volume', 'compression']) {
    const text = installErrorMessage(400, { error: code, message: 'daemon says' });
    assert.notEqual(text, 'daemon says', code);
    assert.notEqual(text, `pluginsPage.install.errors.${code}`, `${code} has a locale entry`);
  }
});

test('signature tones: signed is calm, unsigned warns, tampered alarms', () => {
  assert.equal(signatureSummary({ state: 'signed', keyId: 'k' }).tone, 'ok');
  assert.equal(signatureSummary({ state: 'unsigned', loads: true }).tone, 'warn');
  assert.notEqual(signatureSummary({ state: 'unsigned', loads: true }).text, signatureSummary({ state: 'unsigned', loads: false }).text);
  assert.equal(signatureSummary({ state: 'tampered' }).tone, 'danger');
});

test('preview images are `data:` URLs only — the browser fetches nothing a manifest names', () => {
  assert.equal(previewImage('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(previewImage('https://evil.example/track.png'), null);
  assert.equal(previewImage('/plugins/x/cover'), null);
  assert.equal(previewImage('data:text/html,<script>1</script>'), null);
  assert.equal(previewImage(null), null);
});

test('the sheet says what the vault and network permissions open, and flags a broker without network', async () => {
  const { vaultConsentLines } = await import('./plugin-install');
  const keys = (p: string[]) => vaultConsentLines(p).map((l) => `${l.key.split('.').pop()}${l.warn ? '!' : ''}`);
  assert.deepEqual(keys([]), []);
  assert.deepEqual(keys(['kanban:read']), []);
  assert.deepEqual(keys(['secrets:read']), ['read']);
  assert.deepEqual(keys(['secrets:broker']), ['broker', 'brokerNoHttp!']);
  assert.deepEqual(keys(['secrets:broker', 'http:outbound', 'secrets:read']), ['read', 'broker', 'network']);
  assert.deepEqual(keys(['http:outbound']), ['network']);
});

test('a permission keeps its line unless the manifest names what it uses (TODO #692)', async () => {
  const { vaultConsentLines } = await import('./plugin-install');
  const all = ['secrets:read', 'secrets:broker', 'http:outbound'];
  const secret = (mode: 'read' | 'broker') => ({ name: 'ACME', mode, why: null, present: true, otherMode: false, state: 'grantable' as const });
  const host = { host: 'api.acme.com', why: null, allowedBy: null };
  const keys = (p: string[], secrets: ReturnType<typeof secret>[], hosts: (typeof host)[]) =>
    vaultConsentLines(p, { scope: 'agent:plugin:acme', secrets, hosts }).map((l) => `${l.key.split('.').pop()}${l.warn ? '!' : ''}`);
  assert.deepEqual(keys(all, [secret('read'), secret('broker')], [host]), []);
  assert.deepEqual(keys(all, [secret('read')], []), ['broker', 'network']);
  assert.deepEqual(keys(all, [secret('broker')], []), ['read', 'network']);
  assert.deepEqual(keys(all, [], [host]), ['read', 'broker']);
  assert.deepEqual(keys(['secrets:broker'], [secret('broker')], []), ['brokerNoHttp!'], 'the warning survives a named secret');
  assert.deepEqual(vaultConsentLines(all, null), vaultConsentLines(all), 'null names nothing');
});

test('the vault and network sentences say what the daemon enforces, in both locales (TODO #692)', async () => {
  const en = (await import('../locales/en/plugins.json')).default.pluginsPage.install.vault;
  const fr = (await import('../locales/fr/plugins.json')).default.pluginsPage.install.vault;
  const enRoot = (await import('../locales/en/core.json')).default.secretsPage.pluginGrant;
  const frRoot = (await import('../locales/fr/core.json')).default.secretsPage.pluginGrant;
  for (const sentence of [en.network, fr.network, enRoot.broker, frRoot.broker]) {
    assert.match(sentence, /pluginPolicy\.http\.allow/);
    assert.match(sentence, /pluginPolicy\.http\.byPlugin/);
  }
  // `ctx.fetch` also reaches an approved connection: "limited to" must not leave it out.
  assert.match(en.network, /approved connections/);
  assert.match(fr.network, /connexions approuvées/);
  // This line can sit beside a named secret the sheet grants in one tick: no absolute "none at install".
  assert.doesNotMatch(en.read, /at install/);
  assert.doesNotMatch(fr.read, /à l'installation/);
});

test('every vault line of the sheet is translated in both locales', async () => {
  const { vaultConsentLines } = await import('./plugin-install');
  const en = (await import('../locales/en/plugins.json')).default as Record<string, unknown>;
  const fr = (await import('../locales/fr/plugins.json')).default as Record<string, unknown>;
  const lookup = (dict: Record<string, unknown>, key: string) =>
    key.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), dict);
  const keys = [
    'pluginsPage.install.vault.title',
    ...vaultConsentLines(['secrets:read', 'secrets:broker', 'http:outbound']).map((l) => l.key),
    ...vaultConsentLines(['secrets:broker']).map((l) => l.key),
  ];
  for (const key of keys) {
    assert.equal(typeof lookup(en, key), 'string', `missing in en: ${key}`);
    assert.equal(typeof lookup(fr, key), 'string', `missing in fr: ${key}`);
  }
});

const NAMED = {
  scope: 'agent:plugin:acme',
  secrets: [
    { name: 'ACME_TOKEN', mode: 'read' as const, why: 'Reads your Acme issues', present: true, otherMode: false, state: 'grantable' as const },
    { name: 'ACME_OLD', mode: 'read' as const, why: null, present: true, otherMode: false, state: 'granted' as const },
    { name: 'ACME_NEW', mode: 'broker' as const, why: null, present: false, otherMode: false, state: 'missing' as const },
    { name: 'ACME_TWICE', mode: 'read' as const, why: null, present: true, otherMode: false, state: 'ambiguous' as const },
  ],
  hosts: [
    { host: 'api.acme.com', why: null, allowedBy: null },
    { host: 'cdn.acme.com', why: null, allowedBy: 'plugin' as const },
    { host: 'example.org', why: null, allowedBy: 'global' as const },
  ],
};

test('named consent (TODO #599): nothing new by default, a host already open to the plugin starts ticked', async () => {
  const { initialVaultTicks, vaultConsent } = await import('./plugin-install');
  const ticks = initialVaultTicks(NAMED);
  assert.deepEqual(ticks, { secrets: {}, hosts: { 'cdn.acme.com': true } });
  assert.deepEqual(vaultConsent(NAMED, ticks), {
    secrets: [
      { name: 'ACME_TOKEN', mode: 'read', state: 'grantable', grant: false },
      { name: 'ACME_OLD', mode: 'read', state: 'granted', grant: false },
      { name: 'ACME_NEW', mode: 'broker', state: 'missing', grant: false },
      { name: 'ACME_TWICE', mode: 'read', state: 'ambiguous', grant: false },
    ],
    hosts: [
      { host: 'api.acme.com', allowedBy: null, grant: false },
      { host: 'cdn.acme.com', allowedBy: 'plugin', grant: true },
      { host: 'example.org', allowedBy: 'global', grant: false },
    ],
  }, 'every line goes back as shown, ticked or not');
});

test('named consent: only a grantable secret or a non-global host can carry a grant, whatever the boxes say', async () => {
  const { vaultConsent } = await import('./plugin-install');
  const all = Object.fromEntries(NAMED.secrets.map((s) => [s.name, true]));
  const hosts = Object.fromEntries(NAMED.hosts.map((h) => [h.host, true]));
  const sent = vaultConsent(NAMED, { secrets: all, hosts });
  assert.deepEqual(sent.secrets.filter((s) => s.grant).map((s) => s.name), ['ACME_TOKEN']);
  assert.deepEqual(sent.hosts.filter((h) => h.grant).map((h) => h.host), ['api.acme.com', 'cdn.acme.com']);
  // A name that is also an Object.prototype key is not "ticked" by inheritance.
  const proto = vaultConsent({ ...NAMED, secrets: [{ ...NAMED.secrets[0]!, name: 'constructor' }], hosts: [] }, { secrets: {}, hosts: {} });
  assert.equal(proto.secrets[0]?.grant, false);
});

test('the confirmation carries the named consent beside the token, and omits it when there is none', async () => {
  const { confirmInstall, initialVaultTicks, vaultConsent } = await import('./plugin-install');
  const mock = mockFetch(() => Response.json({ ok: true, id: 'acme', pkg: 'acme', version: '1', refused: null, signature: { state: 'signed' } }));
  try {
    const vault = vaultConsent(NAMED, initialVaultTicks(NAMED));
    await confirmInstall('a'.repeat(48), undefined, vault);
    assert.deepEqual(JSON.parse(String(mock.calls[0]?.init?.body)), { token: 'a'.repeat(48), confirm: true, vault });
    await confirmInstall('a'.repeat(48), ['/opt/acme']);
    assert.deepEqual(JSON.parse(String(mock.calls[1]?.init?.body)), { token: 'a'.repeat(48), confirm: true, authorizeExec: ['/opt/acme'] });
  } finally { mock.restore(); }
});

const PROVIDER_CHILD = {
  id: 'acme-prov', pkg: '@acme/prov', version: '1.0.0', label: 'Acme provider', state: 'install' as const, permissions: [], signature: { state: 'signed' as const, keyId: 'k' }, vault: null,
  provider: { binaries: [{ name: 'acme', found: 'acme', resolved: '/opt/acme', allowed: false, refused: null }] },
};

test('a child is named in the acceptance only once ticked, with what the sheet showed', async () => {
  const { childAuthorizable, childExecConsent } = await import('./plugin-install');
  const line = { id: 'acme-prov', pkg: '@acme/prov', version: '1.0.0', paths: ['/opt/acme'] };
  assert.deepEqual(childExecConsent([PROVIDER_CHILD], {}), []);
  assert.deepEqual(childExecConsent([PROVIDER_CHILD], { 'acme-prov': false }), []);
  assert.deepEqual(childExecConsent([PROVIDER_CHILD], { 'acme-prov': true }), [line]);
  assert.deepEqual(childExecConsent([PROVIDER_CHILD], { 'other-child': true }), [], 'a box is its own child');
  // Nothing to accept: not a provider, kept, or a program that can never be allowed.
  assert.deepEqual(childAuthorizable({ ...PROVIDER_CHILD, provider: null }), []);
  assert.deepEqual(childAuthorizable({ ...PROVIDER_CHILD, state: 'kept' }), []);
  const refused = { binaries: [...PROVIDER_CHILD.provider.binaries, { name: 'sh', found: 'sh', resolved: '/bin/sh', allowed: false, refused: 'a shell' }] };
  assert.deepEqual(childExecConsent([{ ...PROVIDER_CHILD, provider: refused }], { 'acme-prov': true }), []);
});

test('the confirmation carries the accepted children, and omits the field when none is', async () => {
  const { confirmInstall } = await import('./plugin-install');
  const mock = mockFetch(() => Response.json({ ok: true, id: 'acme', pkg: 'acme', version: '1', refused: null, signature: { state: 'signed' } }));
  const line = { id: 'acme-prov', pkg: '@acme/prov', version: '1.0.0', paths: ['/opt/acme'] };
  try {
    await confirmInstall('a'.repeat(48), undefined, undefined, [line]);
    assert.deepEqual(JSON.parse(String(mock.calls[0]?.init?.body)), { token: 'a'.repeat(48), confirm: true, authorizeExecChildren: [line] });
    await confirmInstall('a'.repeat(48), undefined, undefined, []);
    assert.deepEqual(JSON.parse(String(mock.calls[1]?.init?.body)), { token: 'a'.repeat(48), confirm: true });
  } finally { mock.restore(); }
});

test('a child whose programs were not allowlisted is named, with why', async () => {
  const { childExecNotices } = await import('./plugin-install');
  const outcome = { ok: true, id: 'b', pkg: 'b', version: '1', refused: null, signature: { state: 'signed' } };
  assert.deepEqual(childExecNotices(outcome, [PROVIDER_CHILD]), []);
  assert.deepEqual(childExecNotices({ ...outcome, authorizeExecChildren: null }, [PROVIDER_CHILD]), []);
  assert.deepEqual(childExecNotices({ ...outcome, authorizeExecChildren: [{ id: 'acme-prov', granted: ['/opt/acme'], refused: null }] }, [PROVIDER_CHILD]), []);
  const notices = childExecNotices({
    ...outcome,
    authorizeExecChildren: [
      { id: 'acme-prov', granted: null, refused: 'changed' },
      { id: 'gone-child', granted: null, refused: 'not-installed' },
      { id: 'acme-prov', granted: null, refused: 'grant-failed' },
    ],
  }, [PROVIDER_CHILD]);
  assert.equal(notices.length, 3);
  assert.match(notices[0] ?? '', /Acme provider.*not what the sheet showed/);
  assert.match(notices[1] ?? '', /gone-child.*not installed/);
  assert.match(notices[2] ?? '', /Acme provider.*could not be authorized/);
});

test('a 409 is a stale sheet, with a sentence for each vault refusal', async () => {
  const { isStalePreview } = await import('./plugin-install');
  for (const code of ['mismatch', 'not-grantable', 'conflict']) {
    const mock = mockFetch(() => Response.json({ error: code, message: `daemon says ${code}` }, { status: 409 }));
    try {
      const err = await confirmInstall('a'.repeat(48)).catch((e: unknown) => e);
      assert.ok(isStalePreview(err), code);
      assert.doesNotMatch((err as Error).message, /daemon says/, `${code} has its own sentence`);
    } finally { mock.restore(); }
  }
  assert.equal(isStalePreview(new PluginInstallError(404, 'expired', 'x')), false);
  assert.equal(isStalePreview(new Error('x')), false);
});

test('a secret to create links to the Secrets page consent card, encoded', async () => {
  const { secretCreateHref } = await import('./plugin-install');
  const { pluginGrantRequest } = await import('./secrets');
  const href = secretCreateHref('ACME_NEW', '@acme/plugin x');
  assert.equal(href, '/secrets?grant=ACME_NEW&plugin=%40acme%2Fplugin%20x');
  assert.deepEqual(pluginGrantRequest(new URL(href, 'http://localhost').searchParams), { name: 'ACME_NEW', plugin: '@acme/plugin x' });
});

test('every named-consent sentence is translated in both locales', async () => {
  const en = (await import('../locales/en/plugins.json')).default as Record<string, unknown>;
  const fr = (await import('../locales/fr/plugins.json')).default as Record<string, unknown>;
  const lookup = (dict: Record<string, unknown>, key: string) =>
    key.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), dict);
  const v = 'pluginsPage.install.vault';
  const keys = [
    `${v}.secretsLead`, `${v}.hostsLead`, `${v}.hostOwn`, `${v}.hostGlobal`, `${v}.mode.read`, `${v}.mode.broker`,
    `${v}.state.granted`, `${v}.state.missing`, `${v}.state.otherMode`, `${v}.state.ambiguous`, `${v}.state.vault-off`,
    `${v}.create`, `${v}.choose`, 'pluginsPage.install.refreshed',
    'pluginsPage.install.errors.not-grantable', 'pluginsPage.install.errors.conflict',
  ];
  for (const key of keys) {
    assert.equal(typeof lookup(en, key), 'string', `missing in en: ${key}`);
    assert.equal(typeof lookup(fr, key), 'string', `missing in fr: ${key}`);
  }
});

const VAULT_CHILD = {
  id: 'acme-mail', pkg: '@acme/mail', version: '2.0.0', label: 'Acme mail', state: 'install' as const, permissions: ['secrets:read'],
  signature: { state: 'signed' as const, keyId: 'k' }, provider: null,
  vault: {
    scope: 'agent:plugin:acme-mail',
    secrets: [
      { name: 'MAIL_TOKEN', mode: 'read' as const, why: null, present: true, otherMode: false, state: 'grantable' as const },
      { name: 'MAIL_OLD', mode: 'read' as const, why: null, present: true, otherMode: false, state: 'granted' as const },
    ],
    hosts: [{ host: 'mail.acme.test', why: null, allowedBy: 'plugin' as const }],
  },
};

test('children consent (TODO #660): every child naming something, every line, ticks by id alone', async () => {
  const { childVaultConsent } = await import('./plugin-install');
  const other = { ...VAULT_CHILD, id: 'acme-chat', pkg: '@acme/chat', label: null };
  const untouched = (id: string, pkg: string) => ({
    id, pkg, version: '2.0.0',
    secrets: [{ name: 'MAIL_TOKEN', mode: 'read', state: 'grantable', grant: false }, { name: 'MAIL_OLD', mode: 'read', state: 'granted', grant: false }],
    hosts: [{ host: 'mail.acme.test', allowedBy: 'plugin', grant: true }],
  });
  assert.deepEqual(childVaultConsent([VAULT_CHILD, other], {}), [untouched('acme-mail', '@acme/mail'), untouched('acme-chat', '@acme/chat')]);
  const ticked = childVaultConsent([VAULT_CHILD, other], { 'acme-mail': { secrets: { MAIL_TOKEN: true, MAIL_OLD: true }, hosts: {} } });
  assert.deepEqual(ticked[0]?.secrets.map((s) => s.grant), [true, false], 'a granted secret never carries a grant');
  assert.deepEqual(ticked[0]?.hosts.map((h) => h.grant), [false], 'its own boxes replace its defaults');
  assert.deepEqual(ticked[1], untouched('acme-chat', '@acme/chat'), 'another child keeps its own defaults');
  // Nothing asked: names nothing, kept, unreadable, unresolved.
  assert.deepEqual(childVaultConsent([
    { ...VAULT_CHILD, vault: null },
    { ...VAULT_CHILD, id: 'acme-kept', pkg: null, version: null, state: 'kept' },
    { ...VAULT_CHILD, id: 'acme-far', pkg: null, version: null, state: 'unreadable', vault: null },
    { ...VAULT_CHILD, id: 'acme-none', pkg: null, version: null, state: 'unresolved', vault: null },
  ], {}), []);
});

test('the confirmation carries `vaultChildren` beside `vault`, and omits it when no child names anything', async () => {
  const mock = mockFetch(() => Response.json({ ok: true, id: 'b', pkg: 'b', version: '1', refused: null, signature: { state: 'signed' } }));
  const line = { id: 'acme-mail', pkg: '@acme/mail', version: '2.0.0', secrets: [], hosts: [{ host: 'mail.acme.test', allowedBy: null, grant: true }] };
  try {
    await confirmInstall('a'.repeat(48), undefined, undefined, undefined, [line]);
    assert.deepEqual(JSON.parse(String(mock.calls[0]?.init?.body)), { token: 'a'.repeat(48), confirm: true, vaultChildren: [line] });
    await confirmInstall('a'.repeat(48), undefined, undefined, [], []);
    assert.deepEqual(JSON.parse(String(mock.calls[1]?.init?.body)), { token: 'a'.repeat(48), confirm: true });
  } finally { mock.restore(); }
});

test('a child that got none of its secrets and hosts is named, with why', async () => {
  const { childVaultNotices } = await import('./plugin-install');
  const outcome = { ok: true, id: 'b', pkg: 'b', version: '1', refused: null, signature: { state: 'signed' } };
  assert.deepEqual(childVaultNotices(outcome, [VAULT_CHILD]), []);
  assert.deepEqual(childVaultNotices({ ...outcome, vaultChildren: null }, [VAULT_CHILD]), []);
  assert.deepEqual(childVaultNotices({ ...outcome, vaultChildren: [{ id: 'acme-mail', granted: { secrets: ['MAIL_TOKEN'], hosts: [] }, refused: null }] }, [VAULT_CHILD]), []);
  const notices = childVaultNotices({
    ...outcome,
    vaultChildren: [
      { id: 'acme-mail', granted: null, refused: 'changed' },
      { id: 'gone-child', granted: null, refused: 'not-installed' },
      { id: 'acme-mail', granted: null, refused: 'grant-failed' },
    ],
  }, [VAULT_CHILD]);
  assert.equal(notices.length, 3);
  assert.match(notices[0] ?? '', /Acme mail.*not what the sheet showed.*secrets and hosts/);
  assert.match(notices[1] ?? '', /gone-child.*not installed/);
  assert.match(notices[2] ?? '', /Acme mail.*could not be granted/);
});

test('every sentence of a bundle\'s children is translated in both locales', async () => {
  const en = (await import('../locales/en/plugins.json')).default as Record<string, unknown>;
  const fr = (await import('../locales/fr/plugins.json')).default as Record<string, unknown>;
  const lookup = (dict: Record<string, unknown>, key: string) =>
    key.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), dict);
  const c = 'pluginsPage.install.childrenAccess';
  const keys = [
    `${c}.title`, `${c}.permissions`,
    ...['kept', 'unreadable', 'unresolved', 'tampered'].map((s) => `${c}.state.${s}`),
    ...['not-installed', 'changed', 'grant-failed'].flatMap((r) => [`${c}.refused.${r}`, `${c}.vaultRefused.${r}`]),
  ];
  for (const key of keys) {
    assert.equal(typeof lookup(en, key), 'string', `missing in en: ${key}`);
    assert.equal(typeof lookup(fr, key), 'string', `missing in fr: ${key}`);
  }
});
