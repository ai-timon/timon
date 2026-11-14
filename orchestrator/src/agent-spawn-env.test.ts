/**
 * 4.2c / M.5 — `TIMON_API_TOKEN` dans l'env des missions.
 *
 * Un spawn factice (hôte dont `spawn` n'exécute rien) vérifie que le
 * jeton est posé au même endroit que `TIMON_MISSION_ID`, et qu'un
 * `TIMON_API_TOKEN` hérité du parent ne gagne pas. First-run (empty
 * `users` table) issues a per-mission `api_tokens` row too, never the
 * daemon-token: the operator's credential would let the agent approve its own
 * permission cards (`mission-token-first-run.test.ts`). After setup, see
 * `agent-identity.test.ts`. TIMON_HOME jetable, aucun CLI réel, aucun bind.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

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

test('missionEnv pose TIMON_API_TOKEN (first-run: jeton de mission), pas celui du parent', () => {
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

test('spawn factice first-run : le child reçoit son jeton de mission, pas le daemon-token', async () => {
  const previous = process.env.TIMON_API_TOKEN;
  process.env.TIMON_API_TOKEN = 'token-du-parent';

  upsertAgent({
    name: 'env-temoin',
    system_prompt: 'témoin 4.2c — ne fait rien.',
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
    assert.equal(calls.length, 1, 'un seul spawn, via l\'hôte');
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

/* ── S.4 — l'env de mission n'est plus `process.env` (SECRETS-VAULT.md §6.1) ── */

/** Pose un secret scellé pour sa propre ligne, comme le feront les routes S.5. */
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

test('missionEnv : la liste blanche remplace l\'héritage de process.env', () => {
  withEnv({ SECRET_DU_DAEMON: 'fuite', PATH_TEMOIN: 'fuite', SSH_AUTH_SOCK: '/run/ssh-agent' }, () => {
    const env = missionEnv({ missionId: 'm', agentName: 'a', cwd: tmpdir() });
    // Le trou historique : `loadSecretsAtBoot` pose les secrets dans le
    // `process.env` du daemon, et chaque agent en héritait.
    assert.equal(env.SECRET_DU_DAEMON, undefined);
    assert.equal(env.PATH_TEMOIN, undefined, 'un préfixe ne suffit pas : PATH est un nom exact');
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.SSH_AUTH_SOCK, '/run/ssh-agent', 'gardé sciemment : sinon plus aucun git push SSH');
    assert.equal(env.TIMON_HOME, process.env.TIMON_HOME, 'sinon le CLI de l\'agent vise le mauvais home');
  });
});

test('missionEnv : un secret sans grant n\'entre dans l\'env d\'aucun agent', () => {
  putSecret('SANS_GRANT', 'top-secret');
  for (const agentName of ['a', 'b.coder']) {
    const env = missionEnv({ missionId: 'm', agentName, cwd: tmpdir(), project: 'initech' });
    assert.equal(env.SANS_GRANT, undefined);
  }
});

test('missionEnv : un secret broker n\'est jamais injecté, grant ou pas', () => {
  const id = putSecret('BROKER_ONLY', 'ne-sort-pas', 'broker');
  dbApi.addSecretGrant(id, 'global');
  const env = missionEnv({ missionId: 'm', agentName: 'a', cwd: tmpdir(), project: 'initech' });
  assert.equal(env.BROKER_ONLY, undefined);
  // S.8 had to assert this on `resolveSecretsFor` because S.4 was not merged
  // yet. The layer that actually applies it is `missionEnv`; both guards stay.
  // And `missionEnv` itself must not write the journal — that is spawn's job.
  assert.equal(dbApi.listSecretAccess(id).length, 0);
});

test('missionEnv : un secret agent:<nom> n\'apparaît que pour cet agent', () => {
  const id = putSecret('POUR_LE_CODER', 'valeur');
  dbApi.addSecretGrant(id, 'agent', 'initech.coder');
  assert.equal(missionEnv({ missionId: 'm', agentName: 'initech.coder', cwd: tmpdir() }).POUR_LE_CODER, 'valeur');
  assert.equal(missionEnv({ missionId: 'm', agentName: 'initech.reviewer', cwd: tmpdir() }).POUR_LE_CODER, undefined);
});

test('missionEnv : specEnv gagne sur un secret de même nom', () => {
  const id = putSecret('COLLISION', 'du-coffre');
  dbApi.addSecretGrant(id, 'global');
  const env = missionEnv({ missionId: 'm', agentName: 'a', cwd: tmpdir(), specEnv: { COLLISION: 'du-profil' } });
  assert.equal(env.COLLISION, 'du-profil');
});

test('missionEnv : secrets.inheritEnv = true restaure exactement l\'ancien comportement', () => {
  const previous = config();
  // La comparaison n'a de valeur que si le coffre a quelque chose à injecter :
  // sur un coffre vide, la version buguée (couche coffre conservée) et la
  // version correcte rendent le même objet et le test passe pour rien.
  // COLLISION_HERITAGE existe des deux côtés avec des valeurs différentes :
  // c'est lui qui distingue "couche supprimée" de "couche réordonnée".
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
      // L'ancien comportement, dans son intégralité : process.env, puis le
      // spec, puis les variables de mission. Aucune couche coffre au milieu.
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
      // `deepEqual` ignore l'ordre des clés : on le vérifie séparément, car
      // c'est lui qui encode la précédence des couches.
      assert.deepEqual(Object.keys(env), Object.keys(expected));
      assert.equal(env.SECRET_ACCORDE, undefined, 'la soupape retire la couche coffre, elle ne la déplace pas');
      assert.equal(env.COLLISION_HERITAGE, 'du-daemon');
    } finally {
      setConfig(previous);
    }
  });

  // Soupape refermée : le comportement par défaut revient, coffre compris.
  withEnv({ SECRET_DU_DAEMON: 'herite', COLLISION_HERITAGE: 'du-daemon' }, () => {
    const env = missionEnv({ missionId: 'm', agentName: 'a', cwd: tmpdir() });
    assert.equal(env.SECRET_DU_DAEMON, undefined);
    assert.equal(env.SECRET_ACCORDE, 'du-coffre');
    assert.equal(env.COLLISION_HERITAGE, 'du-coffre');
  });

  // Et le spec continue de gagner sur le coffre (couche la plus spécifique).
  const env = missionEnv({
    missionId: 'm', agentName: 'a', cwd: tmpdir(), specEnv: { COLLISION_HERITAGE: 'du-profil' },
  });
  assert.equal(env.COLLISION_HERITAGE, 'du-profil');
});
