/**
 * Mission environment (SECRETS-VAULT.md §6.1) — the whitelist and the scoped
 * injection, exercised end to end against a real vault.
 *
 * These tests are the ones that fail loudly the day the whitelist quietly grows
 * back into `...process.env`: they assert on ABSENCE, which is the property that
 * no other test in the suite protects.
 */
// Isolates TIMON_HOME BEFORE any module touching Timon state (see test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal } from './box.js';
import { resolveMasterKey } from './key.js';
import { systemEnv, secretsEnvFor, SYSTEM_ENV_ALLOW } from './env.js';
import { dbApi } from '../db.js';

const KEY = resolveMasterKey({ keyring: null });

/** Store a secret sealed for its own row, as the routes of S.5 will do. */
function put(name: string, value: string, opts: { mode?: 'inject' | 'broker' } = {}): string {
  const mode = opts.mode ?? 'inject';
  // S.8 refuses a broker row without a spec at the write. These tests only
  // care that a brokered identity never enters the environment.
  const row = dbApi.createSecret({
    name,
    value_enc: 'placeholder',
    mode,
    ...(mode === 'broker'
      ? { broker_spec: JSON.stringify({ type: 'http', hosts: ['example.invalid'], inject: { kind: 'header', name: 'X', template: '{{value}}' } }) }
      : {}),
  });
  dbApi.updateSecret(row.id, { value_enc: seal(value, KEY, { secretId: row.id, name }) });
  return row.id;
}

test('the whitelist keeps the system, drops everything else', () => {
  // Platform pinned: these are the POSIX rules, not the rules of whichever
  // machine happens to run the suite.
  const env = systemEnv({
    PATH: '/usr/bin',
    HOME: '/home/user',
    SSH_AUTH_SOCK: '/run/ssh-agent',
    DISPLAY: ':0',
    TIMON_HOME: '/tmp/home',
    LC_ALL: 'fr_FR.UTF-8',
    NODE_OPTIONS: '--max-old-space-size=4096',
    XDG_CONFIG_HOME: '/home/user/.config',
    npm_config_registry: 'https://registry.npmjs.org/',
    // Everything below must NOT survive.
    TELEGRAM_BOT_TOKEN: 'leak',
    TIMON_VAPID_PRIVATE_KEY: 'leak',
    TIMON_REMOTE_MASTER: 'leak',
    GOOGLE_OAUTH_CLIENT_SECRET: 'leak',
    node_secret: 'leak',
    LCD_PANEL: 'leak',
  }, { platform: 'linux' });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.SSH_AUTH_SOCK, '/run/ssh-agent', 'SSH_AUTH_SOCK is kept on purpose (git push over SSH)');
  assert.equal(env.DISPLAY, ':0');
  assert.equal(env.TIMON_HOME, '/tmp/home', 'without it the agent CLI targets the wrong home');
  assert.equal(env.LC_ALL, 'fr_FR.UTF-8');
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096');
  assert.equal(env.XDG_CONFIG_HOME, '/home/user/.config', 'otherwise the CLIs do not read the same config as the daemon');
  assert.equal(env.npm_config_registry, 'https://registry.npmjs.org/');

  for (const leaked of ['TELEGRAM_BOT_TOKEN', 'TIMON_VAPID_PRIVATE_KEY', 'TIMON_REMOTE_MASTER',
    'GOOGLE_OAUTH_CLIENT_SECRET', 'node_secret', 'LCD_PANEL']) {
    assert.equal(env[leaked], undefined, `${leaked} must not cross the whitelist`);
  }
});

test('on Windows, names AND prefixes are matched without case', () => {
  // Windows environment variable names are case-insensitive at the OS level:
  // `Path` IS `PATH`, and `node_options` IS `NODE_OPTIONS`. A case-sensitive
  // match there drops the system variables the spawn needs.
  const win = systemEnv({
    Path: 'C:\\Windows',
    SystemRoot: 'C:\\Windows',
    UserProfile: 'C:\\Users\\robin',
    node_options: '--max-old-space-size=4096',
    Lc_All: 'en_US.UTF-8',
    Xdg_Config_Home: 'C:\\config',
    // The widening this implies, stated rather than discovered later: on
    // Windows `node_secret` and `NODE_SECRET` are the same variable, so the
    // `NODE_*` family necessarily covers it. Nothing can distinguish them.
    node_secret: 'crosses on win32',
    TELEGRAM_BOT_TOKEN: 'leak',
    Timon_Vapid_Private_Key: 'leak',
  }, { platform: 'win32' });

  assert.equal(win.Path, 'C:\\Windows');
  assert.equal(win.UserProfile, 'C:\\Users\\robin');
  assert.equal(win.node_options, '--max-old-space-size=4096');
  assert.equal(win.Lc_All, 'en_US.UTF-8');
  assert.equal(win.Xdg_Config_Home, 'C:\\config');
  assert.equal(win.node_secret, 'crosses on win32', 'assumed consequence of Windows case rules');
  assert.equal(win.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(win.Timon_Vapid_Private_Key, undefined, 'TIMON_* is not a family, whatever the case');

  // Same source under POSIX rules: the lowercase spellings are other variables.
  const posix = systemEnv({ Path: 'x', node_options: 'y', node_secret: 'z', PATH: '/usr/bin' },
    { platform: 'linux' });
  assert.deepEqual(posix, { PATH: '/usr/bin' });
});

test('the TIMON_* prefix is NOT whitelisted as a family', () => {
  // Only the two pointers are listed one by one; anything else under that prefix
  // is a daemon secret.
  assert.deepEqual(SYSTEM_ENV_ALLOW.filter((k) => k.startsWith('TIMON_')), ['TIMON_HOME', 'TIMON_API']);
});

test('a secret without a grant reaches no agent', () => {
  put('DAEMON_ONLY_TOKEN', 'top-secret');
  for (const target of [
    { agent: 'initech.coder', project: 'initech' },
    { agent: null, project: null },
    { agent: 'anyone', project: 'anything' },
  ]) {
    assert.equal(secretsEnvFor(target).DAEMON_ONLY_TOKEN, undefined);
  }
});

test('a broker secret is never injected, even with a grant', () => {
  const id = put('BROKER_TOKEN', 'never-leaves', { mode: 'broker' });
  dbApi.addSecretGrant(id, 'global');
  dbApi.addSecretGrant(id, 'agent', 'initech.coder');

  const env = secretsEnvFor({ agent: 'initech.coder', project: 'initech' });
  assert.equal(env.BROKER_TOKEN, undefined);
  assert.equal(JSON.stringify(env).includes('never-leaves'), false);
  // `secretsEnvFor` / `missionEnv` stay free of journal writes: tests of the
  // env layer must not fill `secret_access`.
  assert.equal(dbApi.listSecretAccess(id).length, 0);
});

test('an agent-scoped secret only shows up for that agent', () => {
  const id = put('AGENT_SCOPED', 'for-the-coder');
  dbApi.addSecretGrant(id, 'agent', 'initech.coder');

  assert.equal(secretsEnvFor({ agent: 'initech.coder', project: 'initech' }).AGENT_SCOPED, 'for-the-coder');
  assert.equal(secretsEnvFor({ agent: 'initech.reviewer', project: 'initech' }).AGENT_SCOPED, undefined);
  assert.equal(secretsEnvFor({ agent: null, project: 'initech' }).AGENT_SCOPED, undefined);
});

test('project and global grants are decrypted at the last moment', () => {
  const proj = put('PROJECT_SCOPED', 'for-initech');
  dbApi.addSecretGrant(proj, 'project', 'initech');
  const glob = put('GLOBAL_SCOPED', 'for-everyone');
  dbApi.addSecretGrant(glob, 'global');

  assert.equal(secretsEnvFor({ agent: 'x', project: 'initech' }).PROJECT_SCOPED, 'for-initech');
  assert.equal(secretsEnvFor({ agent: 'x', project: 'umbrella' }).PROJECT_SCOPED, undefined);
  assert.equal(secretsEnvFor({ agent: 'x', project: 'umbrella' }).GLOBAL_SCOPED, 'for-everyone');
});

test('a legacy plaintext value is injected as is, not dropped', () => {
  // Rows written before the S.5 migration hold no envelope. Feeding them to
  // `open()` would raise `bad-envelope` and lose a valid secret in silence.
  const row = dbApi.createSecret({ name: 'LEGACY_PLAIN', value_enc: 'plain-value', mode: 'inject' });
  dbApi.addSecretGrant(row.id, 'global');
  assert.equal(secretsEnvFor({ agent: 'x', project: 'y' }).LEGACY_PLAIN, 'plain-value');
});

test('secretsEnvFor does not write the access journal', () => {
  const id = put('ENV_NO_JOURNAL', 'valeur-env-assez-longue');
  dbApi.addSecretGrant(id, 'global');
  assert.equal(secretsEnvFor({ agent: 'x', project: 'y' }).ENV_NO_JOURNAL, 'valeur-env-assez-longue');
  assert.equal(dbApi.listSecretAccess(id).length, 0);
});

test('an undecipherable secret costs one variable, not the whole launch', () => {
  const broken = dbApi.createSecret({ name: 'BROKEN_SECRET', value_enc: 'enc:1:AAAA:BBBB:CCCC', mode: 'inject' });
  dbApi.addSecretGrant(broken.id, 'global');
  const ok = put('STILL_FINE', 'intact');
  dbApi.addSecretGrant(ok, 'global');

  const env = secretsEnvFor({ agent: 'x', project: 'y' });
  assert.equal(env.BROKEN_SECRET, undefined);
  assert.equal(env.STILL_FINE, 'intact', 'one broken row must not take the others down');
});
