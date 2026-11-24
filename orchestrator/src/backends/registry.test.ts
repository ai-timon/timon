/**
 * Live registry of backends (§10.15): what a provider plugin can
 * add, and what disappears when it leaves.
 *
 * The invariant that matters is not "one can add a backend" but its
 * symmetric: an unloaded plugin must leave nothing dispatchable behind.
 * A ghost backend accepted by `isBackendName` would send tasks to an
 * unmounted dialect; they would fail at spawn, far from the uninstall
 * that caused them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { removeHomeOnExit } from '../../tests/helpers/test-home.js';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-registry-'));
process.env.TIMON_HOME = TMP_HOME;
removeHomeOnExit(TMP_HOME);

const { backendOwnerPlugin, registerDialect, registerFileProfile, registerPackProfile, registerProfile, registeredBackendOwners } = await import('./registry.js');
const { backendNames, getBackend, isBackendName, backendCatalog } = await import('./index.js');
type Dialect = import('./types.js').Dialect;
type NormalizedEvent = import('./types.js').NormalizedEvent;
type SessionInfo = import('./types.js').SessionInfo;

/**
 * A minimal dialect, in the exact shape of the contract: a one-shot CLI speaking
 * JSON per line. The same as the `examples/plugin-provider` template.
 */
const echoDialect: Dialect = {
  defaultCmd: 'echo',
  persistentProcess: false,
  finishMissionOnExit: false,
  sessionResumable: true,
  sessionStore: 'global',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  async buildSpawn(opts, profile) {
    const args = ['--model', opts.cfg.model ?? 'echo-1', '--system', opts.systemPrompt, opts.message];
    if (opts.resumeSession) args.push('--resume', opts.resumeSession);
    return { cmd: profile.cmd, args, env: profile.env, cwd: opts.cfg.cwd, initialStdin: null };
  },
  writeUserInput() { /* one-shot: each turn is a process */ },
  parseLine(line: string): NormalizedEvent[] {
    let row: { type?: string; session?: string; text?: string } | null = null;
    try { row = JSON.parse(line) as typeof row; } catch { return []; }
    if (!row || typeof row !== 'object') return [];
    if (row.type === 'init') return [{ type: 'system', payload: { subtype: 'init', session_id: row.session } }];
    if (row.type === 'text') return [{ type: 'assistant', payload: { text: row.text } }];
    if (row.type === 'done') return [{ type: 'result', payload: { subtype: 'success', is_error: false } }];
    return [];
  },
  extractSessionId(ev: NormalizedEvent): string | null {
    const payload = ev.payload as { subtype?: string; session_id?: unknown } | null;
    if (ev.type !== 'system' || payload?.subtype !== 'init') return null;
    return typeof payload.session_id === 'string' ? payload.session_id : null;
  },
};

const profile = {
  id: 'acme-llm',
  dialect: 'acme-echo',
  label: 'ACME LLM',
  vendor: 'ACME',
  custom: true,
  defaultModel: 'acme-1',
  models: [{ slug: 'acme-1', label: 'acme-1' }],
  env: { ACME_API_KEY: 'resolved-by-the-plugin' },
};

test('a plugin adds its provider, and removes it when leaving', async () => {
  assert.equal(isBackendName('acme-llm'), false, 'nothing before registration');

  const removeDialect = registerDialect('acme-plugin', 'acme-echo', echoDialect);
  const removeProfile = registerProfile('acme-plugin', profile);

  assert.ok(backendNames().includes('acme-llm'), 'the backend is dispatchable');
  assert.equal(isBackendName('acme-llm'), true);
  assert.ok(backendCatalog().some((b) => b.id === 'acme-llm'), 'and visible in the catalogue');
  assert.deepEqual(registeredBackendOwners(), {
    profiles: { 'acme-llm': 'acme-plugin' },
    dialects: { 'acme-echo': 'acme-plugin' },
  });

  // The daemon did bind profile and dialect: the spawn leaves with the env the
  // plugin resolved itself, and the init announces itself under the PROFILE name.
  const backend = getBackend('acme-llm');
  const spawned = await backend.buildSpawn({
    agentName: 'timon.test', systemPrompt: 'sys', message: 'msg',
    resumeSession: null, cfg: { cwd: TMP_HOME, model: 'acme-1', permission_mode: 'auto' },
    missionId: 'mission-1',
  });
  assert.equal(spawned.cmd, 'echo');
  assert.equal(spawned.env?.ACME_API_KEY, 'resolved-by-the-plugin');
  const [init] = backend.parseLine('{"type":"init","session":"s-1"}');
  assert.equal((init?.payload as { backend?: string }).backend, 'acme-llm');
  assert.equal(backend.extractSessionId(init!), 's-1');

  // Unloading: nothing dispatchable any more, in the registry as in the
  // catalogue. `isBackendName` is what refuses a task aimed at this backend.
  removeProfile();
  removeDialect();
  assert.equal(isBackendName('acme-llm'), false, 'an unloaded plugin leaves no ghost backend');
  assert.equal(backendCatalog().some((b) => b.id === 'acme-llm'), false);
  assert.deepEqual(registeredBackendOwners(), { profiles: {}, dialects: {} });
});

test('the fence names the plugin whose dialect opens the scratch folder, not the one that added the profile', () => {
  const removeDialect = registerDialect('acme-dialect-plugin', 'acme-echo', echoDialect);
  const data = { id: 'user-llm', dialect: 'acme-echo', label: 'User LLM', vendor: 'User', custom: true,
    defaultModel: 'u-1', models: [{ slug: 'u-1', label: 'u-1' }] };
  const removeFile = registerFileProfile('local-file', data);
  const removePack = registerPackProfile('acme-pack', { ...data, id: 'pack-llm' });
  const removeOwn = registerProfile('acme-dialect-plugin', { ...data, id: 'own-llm' });
  const removeOrphan = registerFileProfile('local-file', { ...data, id: 'orphan-llm', dialect: 'not-installed' });
  try {
    // A user's file and a provider pack bring data only: the dialect's plugin runs `buildSpawn`.
    assert.equal(backendOwnerPlugin('user-llm'), 'acme-dialect-plugin');
    assert.equal(backendOwnerPlugin('user-llm@abcdef12'), 'acme-dialect-plugin', 'an account instance too');
    assert.equal(backendOwnerPlugin('pack-llm'), 'acme-dialect-plugin');
    assert.equal(backendOwnerPlugin('own-llm'), 'acme-dialect-plugin');
    // No plugin answers for the dialect: the profile's owner is all there is.
    assert.equal(backendOwnerPlugin('orphan-llm'), 'local-file');
    assert.equal(backendOwnerPlugin('no-such-backend'), null);
  } finally {
    removeOrphan();
    removeOwn();
    removePack();
    removeFile();
    removeDialect();
  }
});

test('collisions are refused, naming who holds the place', () => {
  const remove = registerDialect('first-plugin', 'shared-echo', echoDialect);
  assert.throws(() => registerDialect('second-plugin', 'shared-echo', echoDialect), /first-plugin/);
  // An id alone confers no product trust: an unoccupied dialect name may be registered.
  const release = registerDialect('release-plugin', 'claude', echoDialect);
  assert.throws(() => registerDialect('second-plugin', 'claude', echoDialect), /release-plugin/);
  release();
  assert.throws(() => registerProfile('second-plugin', { ...profile, id: 'claude', dialect: 'shared-echo' }), /product/);
  remove();
});

test('a profile without a dialect is refused instead of disappearing silently', () => {
  // Registered as is, it would simply be missing from `activeProfiles`: the
  // plugin would think its provider installed and would never see an error.
  assert.throws(() => registerProfile('acme-plugin', { ...profile, dialect: 'inconnu' }), /inconnu/);
});

test('an incomplete dialect is refused before a mission leaves on it', () => {
  const partial = { ...echoDialect } as Partial<Dialect>;
  delete partial.parseLine;
  assert.throws(() => registerDialect('acme-plugin', 'broken-echo', partial as Dialect), /parseLine/);
});

/* ── Two-way session driver ─────────────────────────────────────
   A test dialect, with a fake scripted agent at the end of two PassThrough:
   neither a real agent nor a production transport. What it proves is the
   PLUMBING of the contract: the registry accepts the dialect, the bound Backend
   exposes `openSession` with the profile id, a request from the agent goes through
   `host.requestPermission` and its answer comes back, and the end of turn is
   emitted before `prompt` resolves. */

/** Scripted agent: answers the handshake, then a prompt by making a
 *  permission request that BLOCKS until it is answered. */
function scriptedAgent(io: { stdin: PassThrough; stdout: PassThrough }, seen: { permissionAnswer?: boolean }): void {
  void (async () => {
    const lines = createInterface({ input: io.stdin });
    const say = (msg: unknown): void => { io.stdout.write(`${JSON.stringify(msg)}\n`); };
    for await (const line of lines) {
      const msg = JSON.parse(line) as { id?: number; method?: string; allow?: boolean };
      if (msg.method === 'initialize') {
        say({ id: msg.id, result: { session: 'sess-1', caps: { loadSession: true, resume: false, mcp: true, image: false } } });
      } else if (msg.method === 'prompt') {
        say({ id: 100, method: 'ask', tool: 'write_file', input: { path: '/etc/passwd' } });
      } else if (msg.id === 100) {
        seen.permissionAnswer = msg.allow;
        say({ method: 'chunk', text: msg.allow ? 'wrote it' : 'refused' });
        say({ id: 2, result: { stopReason: 'end_turn' } });
      }
    }
  })();
}

const sessionDialect: Dialect = {
  ...echoDialect,
  persistentProcess: true,
  finishMissionOnExit: true,
  permissionModel: 'protocol',
  openSession({ io, host, profileId }) {
    const inbox = createInterface({ input: io.stdout })[Symbol.asyncIterator]();
    const send = (msg: unknown): void => { io.stdin.write(`${JSON.stringify(msg)}\n`); };
    const next = async (): Promise<Record<string, unknown>> => {
      const { value, done } = await inbox.next();
      if (done) throw new Error('stream closed');
      return JSON.parse(value as string) as Record<string, unknown>;
    };
    let info: SessionInfo | null = null;
    return {
      get info() { return info; },
      async start() {
        send({ id: 1, method: 'initialize' });
        const { result } = await next() as { result: { session: string; caps: SessionInfo['capabilities'] } };
        info = { sessionId: `${profileId}:${result.session}`, capabilities: result.caps, resumed: false };
        return info;
      },
      async prompt(text) {
        send({ id: 2, method: 'prompt', text });
        for (;;) {
          const msg = await next() as { id?: number; method?: string; tool?: string; input?: unknown; text?: string; result?: { stopReason: string } };
          if (msg.method === 'ask') {
            const decision = await host.requestPermission({ toolCallId: null, tool: msg.tool ?? '', title: null, input: msg.input });
            send({ id: msg.id, allow: decision.allow });
          } else if (msg.method === 'chunk') {
            host.emit({ type: 'assistant', payload: { text: msg.text } });
          } else if (msg.id === 2 && msg.result) {
            host.emit({ type: 'result', payload: { subtype: 'success', is_error: false } });
            return { stopReason: msg.result.stopReason };
          }
        }
      },
      async cancel() { send({ method: 'cancel' }); },
      close() { io.stdin.end(); },
    };
  },
};

test('a session driver dialect: bound Backend, permission request, end of turn', async () => {
  const removeDialect = registerDialect('acp-like-plugin', 'acp-like', sessionDialect);
  const removeProfile = registerProfile('acp-like-plugin', { ...profile, id: 'acp-llm', dialect: 'acp-like' });
  try {
    const backend = getBackend('acp-llm');
    assert.equal(backend.permissionModel, 'protocol');
    assert.equal(typeof backend.openSession, 'function');
    assert.equal(backendCatalog().find((b) => b.id === 'acp-llm')?.permissionModel, 'protocol');

    const io = { stdin: new PassThrough(), stdout: new PassThrough() };
    const seen: { permissionAnswer?: boolean } = {};
    scriptedAgent(io, seen);

    const events: NormalizedEvent[] = [];
    const asked: unknown[] = [];
    const driver = backend.openSession!({
      // The driver reads stdout and writes stdin, as with a ChildProcess: the
      // fake agent holds the other end of both pipes.
      io: { stdin: io.stdin, stdout: io.stdout },
      spawn: {
        agentName: 'timon.test', systemPrompt: 'sys', message: 'msg', resumeSession: null,
        cfg: { cwd: TMP_HOME, permission_mode: 'auto' }, missionId: 'mission-2',
      },
      host: {
        emit: (ev) => { events.push(ev); },
        requestPermission: async (req) => { asked.push(req); return { allow: false }; },
      },
    });

    assert.equal(driver.info, null, 'nothing is known before the handshake');
    const info = await driver.start();
    assert.equal(info.sessionId, 'acp-llm:sess-1', 'the profile id is bound by the registry');
    assert.deepEqual(driver.info, info);
    assert.deepEqual(info.capabilities, { loadSession: true, resume: false, mcp: true, image: false });

    const outcome = await driver.prompt('go');
    assert.deepEqual(outcome, { stopReason: 'end_turn' });
    assert.deepEqual(asked, [{ toolCallId: null, tool: 'write_file', title: null, input: { path: '/etc/passwd' } }]);
    assert.equal(seen.permissionAnswer, false, 'the host decision goes back to the agent');
    assert.deepEqual(events.map((e) => e.type), ['assistant', 'result'], 'the end of turn is emitted before prompt resolves');
    driver.close();
  } finally {
    removeProfile();
    removeDialect();
  }
  assert.equal(isBackendName('acp-llm'), false);
});

test('a driver dialect on a one-shot process, or an openSession that is not one, is refused', () => {
  assert.throws(
    () => registerDialect('acp-like-plugin', 'oneshot-session', { ...sessionDialect, persistentProcess: false }),
    /persistentProcess/,
  );
  assert.throws(
    () => registerDialect('acp-like-plugin', 'bad-session', { ...sessionDialect, openSession: 'oui' } as unknown as Dialect),
    /openSession/,
  );
});
