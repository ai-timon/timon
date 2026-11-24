/**
 * 4.2c / M.5: `TIMON_API_TOKEN` in the env of missions.
 *
 * A fake spawn (a host whose `spawn` runs nothing) checks that the
 * token is set in the same place as `TIMON_MISSION_ID`, and that a
 * `TIMON_API_TOKEN` inherited from the parent does not win. First-run (empty
 * `users` table) issues a per-mission `api_tokens` row too, never the
 * daemon-token: the operator's credential would let the agent approve its own
 * permission cards (`mission-token-first-run.test.ts`). After setup, see
 * `agent-identity.test.ts`. Throwaway TIMON_HOME, no real CLI, no bind.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathKeyOf } from './host/launch-path.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { getHost } = await import('./host/index.js');
await import('../tests/helpers/claude-provider.js');

const { spawnAgent, upsertAgent, missionEnv } = await import('./agent.js');
const { ensureDaemonToken } = await import('./plugins-bundled/http/auth.js');
const { hashApiToken } = await import('./users/api-tokens.js');
const { config, setConfig } = await import('./config/load.js');
const { dbApi } = await import('./db.js');
const { seal } = await import('./secrets/box.js');
const { resolveMasterKey } = await import('./secrets/key.js');

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.emit('exit', 0, signal ?? null);
    child.emit('close', 0, signal ?? null);
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

/** The token is a live row bound to this mission, not the operator's. */
function assertMissionToken(token: string | undefined, missionId: string): void {
  assert.ok(token, 'TIMON_API_TOKEN is set');
  assert.notEqual(token, ensureDaemonToken(), 'never the daemon-token, even with no account');
  assert.equal(dbApi.getApiTokenByHash(hashApiToken(token))?.mission_id, missionId);
}

test('missionEnv sets TIMON_API_TOKEN (first-run: mission token), not the parent one', () => {
  const previous = process.env.TIMON_API_TOKEN;
  process.env.TIMON_API_TOKEN = 'token-du-parent';
  try {
    const env = missionEnv({
      missionId: 'mission-temoin',
      agentName: 'env-temoin',
      specEnv: { FOO: 'bar' },
      cwd: tmpdir(),
    });
    assert.equal(env.TIMON_MISSION_ID, 'mission-temoin');
    assert.equal(env.TIMON_AGENT, 'env-temoin');
    assert.equal(env.TIMON_API, 'http://localhost:3000');
    assert.equal(env.FOO, 'bar');
    assertMissionToken(env.TIMON_API_TOKEN, 'mission-temoin');
    assert.notEqual(env.TIMON_API_TOKEN, 'token-du-parent');
  } finally {
    if (previous === undefined) delete process.env.TIMON_API_TOKEN;
    else process.env.TIMON_API_TOKEN = previous;
  }
});

test('first-run fake spawn: the child receives its mission token, not the daemon-token', async () => {
  const previous = process.env.TIMON_API_TOKEN;
  process.env.TIMON_API_TOKEN = 'token-du-parent';

  upsertAgent({
    name: 'env-temoin',
    system_prompt: 'témoin 4.2c — ne fait rien.', // french-ok: free-text sample data
    config: {
      backend: 'claude',
      cwd: tmpdir(),
      skills: [],
      mcp_servers: [],
      memory_scope: 'NONE',
    },
  });

  const host = getHost();
  const original = host.spawn;
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const children: FakeChild[] = [];
  host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const child = fakeChild();
    children.push(child);
    calls.push({ cmd, args, env: (opts?.env ?? {}) as NodeJS.ProcessEnv });
    return child;
  }) as typeof host.spawn;

  let missionId = '';
  try {
    missionId = await spawnAgent('env-temoin', 'ping');
    assert.equal(calls.length, 1, 'a single spawn, through the host');
    const env = calls[0].env;
    assert.equal(env.TIMON_MISSION_ID, missionId);
    assert.equal(env.TIMON_AGENT, 'env-temoin');
    assertMissionToken(env.TIMON_API_TOKEN, missionId);
    assert.notEqual(env.TIMON_API_TOKEN, 'token-du-parent');
  } finally {
    host.spawn = original;
    for (const child of children) {
      if (!child.killed) child.kill();
    }
    if (previous === undefined) delete process.env.TIMON_API_TOKEN;
    else process.env.TIMON_API_TOKEN = previous;
  }
});

/* ── S.4: the mission env is no longer `process.env` (SECRETS-VAULT.md §6.1) ── */

/** Sets a sealed secret for its own row, as the S.5 routes will. */
function putSecret(name: string, value: string, mode: 'inject' | 'broker' = 'inject'): string {
  const key = resolveMasterKey({ keyring: null });
  // S.8 refuses a broker row without a spec at the write. The injection tests
  // only care that a brokered identity never enters missionEnv, so any valid
  // spec is enough — the daemon will never call it from here.
  const row = dbApi.createSecret({
    name,
    value_enc: 'placeholder',
    mode,
    ...(mode === 'broker'
      ? { broker_spec: JSON.stringify({ type: 'http', hosts: ['example.invalid'], inject: { kind: 'header', name: 'X', template: '{{value}}' } }) }
      : {}),
  });
  dbApi.updateSecret(row.id, { value_enc: seal(value, key, { secretId: row.id, name }) });
  return row.id;
}

function withEnv(vars: Record<string, string>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) { previous.set(k, process.env[k]); process.env[k] = v; }
  try { fn(); } finally {
    for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('missionEnv: the allowlist replaces the inheritance of process.env', () => {
  withEnv({ SECRET_DU_DAEMON: 'fuite', PATH_TEMOIN: 'fuite', SSH_AUTH_SOCK: '/run/ssh-agent' }, () => {
    const env = missionEnv({ missionId: 'm', agentName: 'a', cwd: tmpdir() });
    // The historical gap: `loadSecretsAtBoot` sets the secrets in the
    // `process.env` of the daemon, and every agent inherited them.
    assert.equal(env.SECRET_DU_DAEMON, undefined);
    assert.equal(env.PATH_TEMOIN, undefined, 'a prefix is not enough: PATH is an exact name');
    // Windows keeps the spelling it read (`Path`): look the key up as the product does.
    assert.equal(env[pathKeyOf(env, process.platform)], process.env.PATH);
    assert.equal(env.SSH_AUTH_SOCK, '/run/ssh-agent', 'kept on purpose: otherwise no SSH git push at all');
    assert.equal(env.TIMON_HOME, process.env.TIMON_HOME, "otherwise the agent's CLI targets the wrong home");
  });
});

test('missionEnv: a secret without a grant enters the env of no agent', () => {
  putSecret('SANS_GRANT', 'top-secret');
  for (const agentName of ['a', 'b.coder']) {
    const env = missionEnv({ missionId: 'm', agentName, cwd: tmpdir(), project: 'initech' });
    assert.equal(env.SANS_GRANT, undefined);
  }
});

test('missionEnv: a broker secret is never injected, grant or not', () => {
  const id = putSecret('BROKER_ONLY', 'ne-sort-pas', 'broker');
  dbApi.addSecretGrant(id, 'global');
  const env = missionEnv({ missionId: 'm', agentName: 'a', cwd: tmpdir(), project: 'initech' });
  assert.equal(env.BROKER_ONLY, undefined);
  // S.8 had to assert this on `resolveSecretsFor` because S.4 was not merged
  // yet. The layer that actually applies it is `missionEnv`; both guards stay.
  // And `missionEnv` itself must not write the journal — that is spawn's job.
  assert.equal(dbApi.listSecretAccess(id).length, 0);
});

test('missionEnv: an agent:<name> secret only appears for that agent', () => {
  const id = putSecret('POUR_LE_CODER', 'valeur');
  dbApi.addSecretGrant(id, 'agent', 'initech.coder');
  assert.equal(missionEnv({ missionId: 'm', agentName: 'initech.coder', cwd: tmpdir() }).POUR_LE_CODER, 'valeur');
  assert.equal(missionEnv({ missionId: 'm', agentName: 'initech.reviewer', cwd: tmpdir() }).POUR_LE_CODER, undefined);
});

test('missionEnv: specEnv wins over a secret of the same name', () => {
  const id = putSecret('COLLISION', 'du-coffre');
  dbApi.addSecretGrant(id, 'global');
  const env = missionEnv({ missionId: 'm', agentName: 'a', cwd: tmpdir(), specEnv: { COLLISION: 'du-profil' } });
  assert.equal(env.COLLISION, 'du-profil');
});

test('missionEnv: secrets.inheritEnv = true restores exactly the old behaviour', () => {
  const previous = config();
  // The comparison only has value if the vault has something to inject:
  // on an empty vault, the buggy version (vault layer kept) and the
  // correct version return the same object and the test passes for nothing.
  // COLLISION_HERITAGE exists on both sides with different values:
  // it is what tells "layer removed" from "layer reordered".
  const granted = putSecret('SECRET_ACCORDE', 'du-coffre');
  dbApi.addSecretGrant(granted, 'global');
  const clash = putSecret('COLLISION_HERITAGE', 'du-coffre');
  dbApi.addSecretGrant(clash, 'global');

  withEnv({ SECRET_DU_DAEMON: 'herite', COLLISION_HERITAGE: 'du-daemon' }, () => {
    try {
      setConfig({ ...previous, secrets: { ...previous.secrets, inheritEnv: true } });
      const env = missionEnv({
        missionId: 'm',
        agentName: 'a',
        cwd: tmpdir(),
        specEnv: { SPEC_TEMOIN: 'du-profil' },
      });
      // The old behaviour, in full: process.env, then the
      // spec, then the mission variables. No vault layer in between.
      const expected: NodeJS.ProcessEnv = {
        ...process.env,
        SPEC_TEMOIN: 'du-profil',
        TIMON_MISSION_ID: 'm',
        TIMON_AGENT: 'a',
        TIMON_API: env.TIMON_API,
        TIMON_PROJECT: '',
        TIMON_API_TOKEN: env.TIMON_API_TOKEN,
      };
      assert.deepEqual(env, expected);
      // `deepEqual` ignores the order of keys: it is checked separately, since
      // it is what encodes the precedence of the layers.
      assert.deepEqual(Object.keys(env), Object.keys(expected));
      assert.equal(env.SECRET_ACCORDE, undefined, 'the valve removes the vault layer, it does not move it');
      assert.equal(env.COLLISION_HERITAGE, 'du-daemon');
    } finally {
      setConfig(previous);
    }
  });

  // Valve closed again: the default behaviour comes back, vault included.
  withEnv({ SECRET_DU_DAEMON: 'herite', COLLISION_HERITAGE: 'du-daemon' }, () => {
    const env = missionEnv({ missionId: 'm', agentName: 'a', cwd: tmpdir() });
    assert.equal(env.SECRET_DU_DAEMON, undefined);
    assert.equal(env.SECRET_ACCORDE, 'du-coffre');
    assert.equal(env.COLLISION_HERITAGE, 'du-coffre');
  });

  // And the spec keeps winning over the vault (the most specific layer).
  const env = missionEnv({
    missionId: 'm', agentName: 'a', cwd: tmpdir(), specEnv: { COLLISION_HERITAGE: 'du-profil' },
  });
  assert.equal(env.COLLISION_HERITAGE, 'du-profil');
});
