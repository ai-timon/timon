/**
 * M.2b — permission evaluator: wildcards, :all vs unscoped, the rights an
 * account gets from the permission source, superadmin bypass. Isolated
 * TIMON_HOME so the db-backed cases can make real accounts.
 */
import { createTestAccount, grantTestPermissions } from '../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-perms-m2b-'));
await import('../tests/helpers/paid-license.js');

const {
  grantsAllow,
  permissionCovers,
  permissionDenies,
  userAllows,
  MISSION_TOKEN_PERMISSIONS,
  intersectMissionTokenPermissions,
} = await import('./users/permissions.js');
const { hashPassword } = await import('./users/password.js');
const { dbApi } = await import('./db.js');

test('`*` covers every request', () => {
  assert.equal(permissionCovers('*', 'plugins:manage'), true);
  assert.equal(permissionCovers('*', 'missions:read:all'), true);
  assert.equal(permissionCovers('*', 'page:/chat'), true);
  assert.equal(permissionCovers('*', 'users:manage'), true);
});

test('`domain:*` covers objects and scopes of that domain only', () => {
  assert.equal(permissionCovers('plugins:*', 'plugins:manage'), true);
  assert.equal(permissionCovers('plugins:*', 'plugins:manage:all'), true);
  assert.equal(permissionCovers('plugins:*', 'users:manage'), false);
  assert.equal(permissionCovers('page:*', 'page:/chat'), true);
  assert.equal(permissionCovers('page:/', 'page:/chat'), false);
});

test('unscoped read does not grant `:all`; `:all` includes own', () => {
  assert.equal(permissionCovers('missions:read', 'missions:read'), true);
  assert.equal(permissionCovers('missions:read', 'missions:read:all'), false);
  assert.equal(permissionCovers('missions:read:all', 'missions:read'), true);
  assert.equal(permissionCovers('missions:read:all', 'missions:read:all'), true);
  assert.equal(permissionCovers('missions:read', 'missions:spawn'), false);
});

test('deny of an action also denies its scopes, not siblings', () => {
  assert.equal(permissionDenies('users:manage', 'users:manage'), true);
  assert.equal(permissionDenies('users:manage', 'users:manage:all'), true);
  assert.equal(permissionDenies('users:manage', 'users:read'), false);
  assert.equal(permissionDenies('users:*', 'users:read'), true);
});

test('deny by default; `*` except `-users:manage` is the Administration encoding', () => {
  assert.equal(grantsAllow([], 'missions:read'), false);
  const adminPreset = ['*', '-users:manage'];
  assert.equal(grantsAllow(adminPreset, 'plugins:manage'), true);
  assert.equal(grantsAllow(adminPreset, 'agents:manage'), true);
  assert.equal(grantsAllow(adminPreset, 'mcp:manage'), true);
  assert.equal(grantsAllow(adminPreset, 'skills:manage'), true);
  assert.equal(grantsAllow(adminPreset, 'secrets:manage'), true);
  assert.equal(grantsAllow(adminPreset, 'missions:read:all'), true);
  assert.equal(grantsAllow(adminPreset, 'page:/settings'), true);
  assert.equal(grantsAllow(adminPreset, 'users:manage'), false);
  assert.equal(grantsAllow(adminPreset, 'users:manage:all'), false);
  assert.equal(grantsAllow(adminPreset, 'users:read'), true);
});

test('employee preset: spawn + own read + home and chat, nothing else', () => {
  const employee = ['missions:spawn', 'missions:read', 'page:/', 'page:/chat'];
  assert.equal(grantsAllow(employee, 'missions:spawn'), true);
  assert.equal(grantsAllow(employee, 'missions:read'), true);
  assert.equal(grantsAllow(employee, 'missions:read:all'), false);
  assert.equal(grantsAllow(employee, 'page:/'), true);
  assert.equal(grantsAllow(employee, 'page:/chat'), true);
  assert.equal(grantsAllow(employee, 'page:/settings'), false);
  assert.equal(grantsAllow(employee, 'users:manage'), false);
  assert.equal(grantsAllow(employee, 'plugins:manage'), false);
  assert.equal(grantsAllow(employee, 'agents:manage'), false);
  assert.equal(grantsAllow(employee, 'mcp:manage'), false);
  assert.equal(grantsAllow(employee, 'skills:manage'), false);
  assert.equal(grantsAllow(employee, 'secrets:manage'), false);
});

test('superadmin is `*` without reading grants; a demoted user is not', () => {
  assert.equal(userAllows({ is_superadmin: true }, [], 'users:manage'), true);
  assert.equal(userAllows({ is_superadmin: true }, ['-users:manage'], 'users:manage'), true);
  assert.equal(userAllows({ is_superadmin: false }, [], 'missions:read'), false);
  assert.equal(
    userAllows({ is_superadmin: false }, ['missions:read'], 'missions:read'),
    true,
  );
});

test('rights come from the permission source; a deny still wins, a superadmin skips the evaluator', async () => {
  const rom = createTestAccount(dbApi, {
    email: 'robin@example.com',
    name: 'Robin',
    passwordHash: await hashPassword('secret-secret'),
    isSuperadmin: true,
  });
  const ada = createTestAccount(dbApi, {
    email: 'ada@example.com',
    name: 'Ada',
    passwordHash: await hashPassword('employee-secret'),
  });
  // No source answers for Ada yet: nothing, refused by default.
  assert.deepEqual(dbApi.listPermissionsForUser(ada.id), []);

  grantTestPermissions(dbApi, ada.id, ['missions:spawn', 'missions:read', 'page:/']);
  const adaGrants = dbApi.listPermissionsForUser(ada.id);
  assert.equal(userAllows(ada, adaGrants, 'missions:spawn'), true);
  assert.equal(userAllows(ada, adaGrants, 'page:/'), true);
  assert.equal(userAllows(ada, adaGrants, 'users:manage'), false);

  grantTestPermissions(dbApi, ada.id, ['missions:spawn', '-missions:spawn']);
  assert.equal(userAllows(ada, dbApi.listPermissionsForUser(ada.id), 'missions:spawn'), false);

  grantTestPermissions(dbApi, ada.id, ['*', '-users:manage']);
  const withStar = dbApi.listPermissionsForUser(ada.id);
  assert.equal(userAllows(ada, withStar, 'plugins:manage'), true);
  assert.equal(userAllows(ada, withStar, 'users:manage'), false);

  // Superadmin with no right at all still has everything — the evaluator is skipped.
  assert.deepEqual(dbApi.listPermissionsForUser(rom.id), []);
  assert.equal(userAllows(rom, dbApi.listPermissionsForUser(rom.id), 'users:manage'), true);
});

test('mission token cap never includes users:manage, secrets, or spawn', () => {
  const cap: readonly string[] = MISSION_TOKEN_PERMISSIONS;
  assert.equal(cap.includes('users:manage'), false);
  assert.equal(cap.includes('secrets:manage'), false);
  assert.equal(cap.includes('secrets:read'), false);
  // A mission may deposit a new secret, never manage the vault.
  assert.equal(cap.includes('secrets:create'), true);
  assert.equal(cap.includes('missions:spawn'), false);
  // skill_put and mcp_server_put are open to missions; the routes bound what they write.
  assert.equal(cap.includes('skills:manage'), true);
  assert.equal(cap.includes('mcp:manage'), true);
  const capped = intersectMissionTokenPermissions({ is_superadmin: true }, []);
  assert.equal(grantsAllow(capped, 'users:manage'), false);
  assert.equal(grantsAllow(capped, 'secrets:manage'), false);
  assert.equal(grantsAllow(capped, 'missions:spawn'), false);
  assert.equal(grantsAllow(capped, 'mcp:manage'), true);
  assert.equal(grantsAllow(capped, 'skills:manage'), true);
  // ∩ the launcher: an employee's mission does not gain what the account lacks.
  assert.equal(grantsAllow(intersectMissionTokenPermissions({ is_superadmin: false }, ['missions:read']), 'mcp:manage'), false);
  assert.equal(grantsAllow(capped, 'kanban:write'), true);
});
