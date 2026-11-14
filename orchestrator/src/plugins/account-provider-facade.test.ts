import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createTestAccount, stopServingTestAccounts } from '../../tests/helpers/accounts.js';

// The paid test helper serves accounts itself; these tests are about who holds the seam.
stopServingTestAccounts();

const { dbApi, AccountSourceError } = await import('../db.js');
const { LEGACY_ACCOUNT_TABLES_FILE } = await import('../paths.js');
const { createAccountProviderFacade, accountProviderHolder, AccountProviderError } = await import('./account-provider-facade.js');
const { hashSessionToken } = await import('../users/session.js');
const { verifyPassword } = await import('../users/password.js');
const { PluginPermissionError } = await import('./context.js');

type Facade = ReturnType<typeof createAccountProviderFacade>;

function facade(pluginId: string, opts: { trusted?: boolean; granted?: boolean } = {}): { provider: Facade; unload: () => void } {
  const disposers: Array<() => void> = [];
  const provider = createAccountProviderFacade({
    pluginId,
    assertPermission: () => { if (opts.granted === false) throw new PluginPermissionError(pluginId, 'accounts:provision'); },
    trusted: opts.trusted ?? true,
    onUnload: (fn) => { disposers.push(fn); },
  });
  return { provider, unload: () => { for (const fn of disposers.splice(0)) fn(); } };
}

function fakeRes() {
  const headers = new Map<string, unknown>();
  return { headers, setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; } };
}
const fakeReq = { header: (name: string) => (name === 'user-agent' ? 'test-agent' : undefined) };

test('createUser refuses any caller that is not the setup, the provider, the legacy routes or a test', () => {
  assert.throws(() => dbApi.createUser({ email: 'nobody@example.com', name: 'Nobody', passwordHash: 'x' } as never), AccountSourceError);
  assert.throws(() => dbApi.createUser({ email: 'nobody@example.com', name: 'Nobody', passwordHash: 'x', source: 'plugin' } as never), AccountSourceError);
  // `test` outside the test runner is refused: a daemon never runs with NODE_TEST_CONTEXT.
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.throws(() => dbApi.createUser({ email: 'nobody@example.com', name: 'Nobody', passwordHash: 'x', source: 'test' }), AccountSourceError);
  } finally {
    process.env.NODE_TEST_CONTEXT = saved;
  }
  assert.equal(dbApi.getUserByEmail('nobody@example.com'), undefined, 'nothing was created');
});

test('an unsigned plugin, or one without the permission, never adds an account', () => {
  const unsigned = facade('unsigned-plugin', { trusted: false });
  assert.throws(() => unsigned.provider.provision({ email: 'u1@example.com', name: 'U', password: 'long-enough' }),
    (err: unknown) => err instanceof AccountProviderError && err.code === 'not_trusted');
  const denied = facade('denied-plugin', { granted: false });
  assert.throws(() => denied.provider.provision({ email: 'u2@example.com', name: 'U', password: 'long-enough' }), PluginPermissionError);
  assert.equal(dbApi.getUserByEmail('u1@example.com'), undefined);
  assert.equal(dbApi.getUserByEmail('u2@example.com'), undefined);
  assert.equal(accountProviderHolder(), null, 'a refused call does not claim the provider');
});

test('the core creates the account: hashed password, never a superadmin, audited', async () => {
  const { provider, unload } = facade('team-plugin');
  const account = provider.provision({ email: ' Ada@Example.com ', name: 'Ada', password: 'ada-password' });
  assert.deepEqual({ email: account.email, status: account.status }, { email: 'ada@example.com', status: 'active' });
  const row = dbApi.getUserById(account.id)!;
  assert.equal(row.is_superadmin, false);
  assert.ok(await verifyPassword('ada-password', row.password_hash), 'hashed by the core');
  assert.ok(dbApi.listAuditLog(20).some((a) => a.actor === 'plugin:team-plugin' && a.action === 'user.create' && a.target === `user:${account.id}`));
  assert.throws(() => provider.provision({ email: 'ada@example.com', name: 'Ada again', password: 'ada-password' }),
    (err: unknown) => err instanceof AccountProviderError && err.code === 'duplicate');
  assert.throws(() => provider.provision({ email: 'short@example.com', name: 'S', password: 'short' }),
    (err: unknown) => err instanceof AccountProviderError && err.code === 'invalid');
  assert.throws(() => provider.provision({ email: 'not-an-email', name: 'S', password: 'long-enough' }),
    (err: unknown) => err instanceof AccountProviderError && err.code === 'invalid');
  unload();
});

test('one plugin holds the provider at a time, until it is unloaded', () => {
  const first = facade('holder-a');
  const second = facade('holder-b');
  first.provider.provision({ email: 'held-a@example.com', name: 'A', password: 'long-enough' });
  assert.equal(accountProviderHolder(), 'holder-a');
  assert.throws(() => second.provider.provision({ email: 'held-b@example.com', name: 'B', password: 'long-enough' }),
    (err: unknown) => err instanceof AccountProviderError && err.code === 'held');
  first.unload();
  assert.equal(accountProviderHolder(), null);
  second.provider.provision({ email: 'held-b@example.com', name: 'B', password: 'long-enough' });
  assert.equal(accountProviderHolder(), 'holder-b');
  second.unload();
});

test('a session is opened for an active member, never for a superadmin or an inactive account', () => {
  const { provider, unload } = facade('session-plugin');
  const member = provider.provision({ email: 'member@example.com', name: 'Member', password: 'member-password' });
  const res = fakeRes();
  provider.openSession(member.id, fakeReq, res);
  const cookie = String(res.headers.get('set-cookie'));
  const token = decodeURIComponent(/timon_session=([^;]+)/.exec(cookie)?.[1] ?? '');
  assert.equal(dbApi.getSessionByTokenHash(hashSessionToken(token))?.user_id, member.id, 'the core stored the session it set');
  assert.match(cookie, /HttpOnly/);

  const boss = createTestAccount(dbApi, { email: 'boss@example.com', name: 'Boss', passwordHash: 'x', isSuperadmin: true });
  assert.throws(() => provider.openSession(boss.id, fakeReq, fakeRes()),
    (err: unknown) => err instanceof AccountProviderError && err.code === 'refused');
  const invited = provider.provision({ email: 'invited@example.com', name: 'Invited', password: 'invited-password', status: 'invited' });
  assert.throws(() => provider.openSession(invited.id, fakeReq, fakeRes()),
    (err: unknown) => err instanceof AccountProviderError && err.code === 'refused');
  assert.throws(() => provider.openSession('no-such-id', fakeReq, fakeRes()),
    (err: unknown) => err instanceof AccountProviderError && err.code === 'invalid');
  unload();
});

test('the holder hears when an account is disabled, and stops hearing once unloaded', () => {
  const { provider, unload } = facade('listener-plugin');
  const member = provider.provision({ email: 'listened@example.com', name: 'L', password: 'long-enough' });
  const heard: unknown[] = [];
  provider.onAccountChanged((change) => heard.push(change));
  dbApi.setUserStatus(member.id, 'disabled');
  assert.deepEqual(heard, [{ userId: member.id, status: 'disabled', previous: 'active' }]);
  unload();
  dbApi.setUserStatus(member.id, 'active');
  assert.equal(heard.length, 1, 'no change reaches an unloaded plugin');
});

test('a signed plugin declaring the permission holds the provider from its mount, not from its first call', () => {
  const disposers: Array<() => void> = [];
  createAccountProviderFacade({
    pluginId: 'mounted-holder', assertPermission: () => {}, trusted: true, declared: true,
    onUnload: (fn) => { disposers.push(fn); },
  });
  assert.equal(accountProviderHolder(), 'mounted-holder');
  for (const fn of disposers.splice(0)) fn();
  assert.equal(accountProviderHolder(), null);
  createAccountProviderFacade({ pluginId: 'unsigned-declared', assertPermission: () => {}, trusted: false, declared: true, onUnload: () => {} });
  assert.equal(accountProviderHolder(), null, 'an unsigned plugin never holds it');
});

test('the holder reads the former account tables, a closed list, and nothing else', () => {
  const { provider, unload } = facade('migrating-plugin');
  assert.deepEqual(provider.readLegacy('roles'), [], 'no file: nothing to migrate');
  const role = { id: 'legacy-role' };
  writeFileSync(LEGACY_ACCOUNT_TABLES_FILE, JSON.stringify({
    version: 1, exportedAt: 1,
    tables: { roles: [{ id: role.id, name: 'legacy-readers', description: null, created_at: 1 }], role_permissions: [{ role_id: role.id, permission: 'kanban:read' }] },
  }));
  assert.ok(provider.readLegacy('roles').some((r) => r.id === role.id));
  assert.ok(provider.readLegacy('role_permissions').some((r) => r.role_id === role.id && r.permission === 'kanban:read'));
  assert.throws(() => provider.readLegacy('users' as never), (err: unknown) => err instanceof AccountProviderError && err.code === 'invalid');
  assert.throws(() => provider.readLegacy('roles; DROP TABLE users' as never), (err: unknown) => err instanceof AccountProviderError && err.code === 'invalid');
  unload();
  const other = facade('unsigned-reader', { trusted: false });
  assert.throws(() => other.provider.readLegacy('roles'), (err: unknown) => err instanceof AccountProviderError && err.code === 'not_trusted');
});

test('the holder reads the accounts, superadmins included, but never a credential', () => {
  const { provider, unload } = facade('directory-reader');
  const member = provider.provision({ email: 'reader-member@example.com', name: 'Reader', password: 'long-enough' });
  const boss = createTestAccount(dbApi, { email: 'reader-boss@example.com', name: 'Boss', passwordHash: 'x', isSuperadmin: true });
  const listed = provider.list();
  assert.ok(listed.some((a) => a.id === member.id && a.isSuperadmin === false));
  assert.ok(listed.some((a) => a.id === boss.id && a.isSuperadmin === true));
  for (const account of listed) {
    assert.deepEqual(Object.keys(account).sort(), ['createdAt', 'email', 'id', 'isSuperadmin', 'lastLoginAt', 'name', 'status']);
  }
  assert.equal(provider.get(member.id)?.email, 'reader-member@example.com');
  assert.equal(provider.get('no-such-id'), undefined);
  assert.equal(provider.findByEmail(' Reader-Member@Example.com ')?.id, member.id);
  assert.equal(provider.findByEmail(''), undefined);
  unload();
  const unsigned = facade('unsigned-directory', { trusted: false });
  assert.throws(() => unsigned.provider.list(), (err: unknown) => err instanceof AccountProviderError && err.code === 'not_trusted');
});

test('the holder renames, disables, enables and sets a password, never on a superadmin', async () => {
  const { provider, unload } = facade('directory-writer');
  const member = provider.provision({ email: 'writer-member@example.com', name: 'Writer', password: 'first-password' });
  const res = fakeRes();
  provider.openSession(member.id, fakeReq, res);
  const token = decodeURIComponent(/timon_session=([^;]+)/.exec(String(res.headers.get('set-cookie')))?.[1] ?? '');

  assert.equal(provider.update(member.id, { name: '  Renamed  ' }).name, 'Renamed');
  provider.update(member.id, { password: 'second-password' });
  assert.ok(await verifyPassword('second-password', dbApi.getUserById(member.id)!.password_hash));
  assert.equal(dbApi.getSessionByTokenHash(hashSessionToken(token)), undefined, 'a new password closes the old sessions');

  assert.equal(provider.update(member.id, { status: 'disabled' }).status, 'disabled');
  assert.equal(provider.update(member.id, { status: 'active' }).status, 'active');
  const actions = dbApi.listAuditLog(50).filter((a) => a.actor === 'plugin:directory-writer' && a.target === `user:${member.id}`).map((a) => a.action);
  for (const action of ['user.rename', 'user.set_password', 'user.disable', 'user.enable']) assert.ok(actions.includes(action), action);

  const boss = createTestAccount(dbApi, { email: 'writer-boss@example.com', name: 'Boss', passwordHash: 'x', isSuperadmin: true });
  for (const patch of [{ name: 'Taken' }, { password: 'taken-password' }, { status: 'disabled' as const }]) {
    assert.throws(() => provider.update(boss.id, patch), (err: unknown) => err instanceof AccountProviderError && err.code === 'refused');
  }
  assert.equal(dbApi.getUserById(boss.id)!.name, 'Boss');
  for (const patch of [{}, { name: '  ' }, { password: 'short' }, { status: 'invited' as never }]) {
    assert.throws(() => provider.update(member.id, patch), (err: unknown) => err instanceof AccountProviderError && err.code === 'invalid');
  }
  assert.throws(() => provider.update('no-such-id', { name: 'X' }), (err: unknown) => err instanceof AccountProviderError && err.code === 'invalid');
  unload();
});

test('an invited account becomes active when the holder sets its password and status', () => {
  const { provider, unload } = facade('invitation-plugin');
  const invited = provider.provision({ email: 'to-accept@example.com', name: 'Guest', password: 'placeholder-pass', status: 'invited' });
  const accepted = provider.update(invited.id, { name: 'Guest', password: 'chosen-password', status: 'active' });
  assert.equal(accepted.status, 'active');
  provider.openSession(invited.id, fakeReq, fakeRes());
  unload();
});

test('the holder writes and reads the audit log in its own name, bounded', () => {
  const { provider, unload } = facade('auditing-plugin');
  provider.audit('role.create', 'role:abc');
  provider.audit('group.delete');
  const lines = provider.auditLog(10).filter((a) => a.actor === 'plugin:auditing-plugin');
  // Both lines share a millisecond: the log's order between them is not the point.
  assert.deepEqual(lines.map((a) => [a.action, a.target]).sort(), [['group.delete', null], ['role.create', 'role:abc']]);
  assert.deepEqual(Object.keys(lines[0]!).sort(), ['action', 'actor', 'at', 'id', 'target', 'userId'], 'no IP address leaves the core');
  for (const bad of ['', '  ', 'x'.repeat(201), 42 as never]) {
    assert.throws(() => provider.audit(bad), (err: unknown) => err instanceof AccountProviderError && err.code === 'invalid');
  }
  for (const limit of [0, 1001, 1.5]) {
    assert.throws(() => provider.auditLog(limit), (err: unknown) => err instanceof AccountProviderError && err.code === 'invalid');
  }
  unload();
});
