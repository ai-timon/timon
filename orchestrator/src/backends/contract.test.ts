/**
 * Backend CONFORMANCE suite.
 *
 * A single file, played against EACH active backend of the registry
 * (`backendNames()`). That is what divides the cost of the next provider: one
 * does not write a suite per backend, one declares an expectations entry + a
 * JSONL fixtures file, and the whole contract is checked.
 *
 * The checks themselves live in the bench the SDK publishes
 * (`@timon-ai/sdk/testing`, `packages/sdk/src/testing/`): a plugin author
 * runs the SAME suite on their dialect. This file only keeps what depends on the
 * product registry (coverage, frozen table of dialects, profile name).
 *
 * What the suite checks, without ever spawning a CLI or touching the network:
 *   - `buildSpawn` (fresh AND resume) produces a consistent cmd/args/env/cwd, and
 *     does route the system prompt, message, model and resume id;
 *   - `parseLine` on real JSONL fixtures produces the normalised TIMON
 *     vocabulary (system/init, assistant, result);
 *   - `extractSessionId` finds the id from the system/init of these fixtures;
 *   - the declared capabilities match the real behaviour (`initialStdin`
 *     non-null ⇔ `persistentProcess`, `writeUserInput` writes ⇔ persistent…);
 *   - a backend WITHOUT a process (`RemoteDialect`) keeps the contract of its driver:
 *     full turn, cancellation, readable failure, closing ("remote" block).
 *
 * `node --test --import tsx src/backends/contract.test.ts` (or `npm test`).
 *
 * ADDING A BACKEND: add its entry to EXPECTATIONS below and its
 * `__fixtures__/<dialect>.jsonl` file. Without that the suite fails, which is its whole
 * point: a registered but uncovered backend is not a backend
 * whose contract is known.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeHomeOnExit } from '../../tests/helpers/test-home.js';

/* Throwaway TIMON_HOME: the codex and grok dialects materialise a home per
   mission on disk at buildSpawn. Set BEFORE importing the registry (paths.js reads
   process.env on load) → dynamic import required. */
const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-contract-'));
process.env.TIMON_HOME = TMP_HOME;
process.env.CODEX_AUTH_DIR = join(TMP_HOME, 'codex-auth');
mkdirSync(process.env.CODEX_AUTH_DIR, { recursive: true });
writeFileSync(join(process.env.CODEX_AUTH_DIR, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.env.GROK_AUTH_DIR = join(TMP_HOME, 'grok-auth');
/* The copilot profile exists only when its CLI is on PATH (`requiredBinary`).
   A stand-in file is enough for the registry to list it, so its contract runs
   on a machine without Copilot — nothing here ever executes it. Beside the
   Timon home, not in it: no binary is ever resolved from there. */
const FAKE_BIN = `${TMP_HOME}-bin`;
mkdirSync(FAKE_BIN, { recursive: true });
writeFileSync(join(FAKE_BIN, 'copilot'), '', { mode: 0o755 });
writeFileSync(join(FAKE_BIN, 'grok'), '', { mode: 0o755 });
process.env.PATH = `${FAKE_BIN}${delimiter}${process.env.PATH ?? ''}`;
removeHomeOnExit(TMP_HOME);

const {
  backendNames, getBackend, NO_SESSION_CAPABILITIES, PERMISSION_MODELS,
} = await import('./index.js');
const { backendTrust, getDialect, registerDialect, registerProfile } = await import('./registry.js');
const { mountOfficialProviders, buildUnderSeal } = await import('../../tests/helpers/official-providers.js');
/* The providers the release ships as plugins (grok today) are registered the way the loader does: the contract
   covers them as it covers the core's. A plugin's services answer inside a launch, hence the seal. */
await mountOfficialProviders();
const kit = await import('../../../packages/sdk/src/testing/index.js');

/* A THIRD-PARTY dialect enters the same suite as the first-party ones.
   `examples/plugin-provider` is the template an author copies: making it
   pass here is the only way to know that the published contract is the one
   the product really applies. Registered BEFORE the parameterised loop, which reads
   `backendNames()` when the module loads. */
const { echoDialect } = await import('../../tests/helpers/example-dialects.js') as {
  echoDialect: import('./types.js').Dialect;
};
test('provider example declares its registered dialect identity at runtime', () => {
  assert.equal(echoDialect.id, 'echo', 'the JavaScript example must supply the required Dialect.id');
});

registerDialect('examples/plugin-provider', 'echo', echoDialect);
registerProfile('examples/plugin-provider', {
  id: 'echo-llm',
  dialect: 'echo',
  label: 'Echo (démo)', // french-ok: the label of the example provider
  vendor: 'Exemple',
  custom: true,
  env: { ECHO_API_KEY: 'clé-de-test' }, // french-ok: a non-ASCII key value
  defaultModel: 'echo-1',
  models: [{ slug: 'echo-1', label: 'echo-1', contextWindow: 8_000 }],
});
/* REMOTE dialect brought by a plugin (`examples/plugin-remote-backend`):
   no process, an in-memory driver. Three profiles on the same dialect, one
   per behaviour the contract must see (see REMOTE_EXPECTATIONS). */
const { memoryDialect } = await import('../../tests/helpers/example-dialects.js') as {
  memoryDialect: import('./types.js').RemoteDialect;
};
registerDialect('examples/plugin-remote-backend', 'memory-remote', memoryDialect);
for (const [id, env] of [
  ['memory-remote', {}],
  ['memory-remote-slow', { MEMORY_AGENT_DELAY_MS: '60000' }],
  ['memory-remote-failing', { MEMORY_AGENT_FAIL: 'prompt' }],
] as const) {
  registerProfile('examples/plugin-remote-backend', {
    id, dialect: 'memory-remote', label: id, vendor: 'Exemple', custom: true, env,
    defaultModel: 'memory-1', models: [{ slug: 'memory-1', label: 'memory-1', contextWindow: 8_000 }],
  });
}

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

/**
 * Expectations specific to a backend. Everything NOT here is checked
 * generically below; the rule is to keep this table as thin as
 * possible so that a new backend is cheap to cover.
 */
type Expectation = {
  /** File in `__fixtures__/`, one JSONL line per event as the CLI
   *  really emits it (before normalisation). */
  fixture: string;
  /** Session/thread id carried by the system:init of the fixture. */
  sessionId: string;
  /** Binaire attendu au spawn. */
  cmd: string;
  /** Env keys `buildSpawn` MUST set (beyond process.env). */
  envKeys: string[];
  /** Model passed to `cfg.model`: must be consistent with the backend. */
  model: string;
  /**
   * Where the stream announces its session. `head` (default): the system:init
   * opens the flow, as claude, codex and grok do. `result`: the CLI names its
   * session only in its final line (copilot) — the init is then emitted there,
   * still exactly once, and nothing downstream needs it first (the chat keeps
   * the LAST init it sees, the orchestrator records the id whenever it comes).
   */
  initAt?: 'head' | 'result';
};

const EXPECTATIONS: Record<string, Expectation> = {
  claude: {
    fixture: 'claude.jsonl',
    sessionId: '3f9a1c52-7e64-4d0b-9a11-0b2c8de41f77',
    cmd: 'claude',
    // First-party profile: nothing to inject, the orchestrator env is enough.
    envKeys: [],
    model: 'opus',
  },
  codex: {
    fixture: 'codex.jsonl',
    sessionId: '0199f3c1-8b7a-7c2d-9e4f-5a6b7c8d9e0f',
    cmd: 'codex',
    // Per-mission CODEX_HOME: without it, the agent's config.toml and MCP
    // would be the host ones.
    envKeys: ['CODEX_HOME'],
    model: 'gpt-5.5',
  },
  grok: {
    fixture: 'grok.jsonl',
    sessionId: '01a014dc-392a-7753-9cf4-a111cc3ac77f',
    cmd: 'grok',
    // Per-mission GROK_HOME: carries config.toml (MCP), rules/ (system prompt)
    // and the sessions, so resume depends on it.
    envKeys: ['GROK_HOME'],
    model: 'grok-4.6',
  },
  copilot: {
    // Assembled from the Copilot SDK's session-events reference, not captured
    // from a live turn (no Copilot seat to capture one): cf. dialects/copilot.ts.
    fixture: 'copilot.jsonl',
    sessionId: '4dedd90b-f6fb-49ce-938f-4d74497ad7bf',
    cmd: 'copilot',
    // The system prompt's channel: a custom-instructions directory per mission.
    envKeys: ['COPILOT_CUSTOM_INSTRUCTIONS_DIRS'],
    model: 'claude-sonnet-4.6',
    initAt: 'result',
  },
  /* Third-party profiles: same dialect, hence same fixtures. They are only active
     if their credentials are in the env; the entries stay here so that the
     suite covers them as soon as they become so. */
  kimi: {
    fixture: 'claude.jsonl',
    sessionId: '3f9a1c52-7e64-4d0b-9a11-0b2c8de41f77',
    cmd: 'claude',
    envKeys: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
    model: 'kimi-k3',
  },
  'ollama-cloud': {
    fixture: 'codex.jsonl',
    sessionId: '0199f3c1-8b7a-7c2d-9e4f-5a6b7c8d9e0f',
    cmd: 'codex',
    envKeys: ['CODEX_HOME', 'OLLAMA_API_KEY'],
    model: 'gpt-oss:120b',
  },
  /* Dialect brought by a PLUGIN (`examples/plugin-provider`), covered
     exactly like the others: that is what makes the open-core promise
     checkable rather than declarative. */
  'echo-llm': {
    fixture: 'echo.jsonl',
    sessionId: 'echo-session-7f21c0d4',
    cmd: 'echo',
    // The env comes from the profile, which the plugin filled from its settings.
    envKeys: ['ECHO_API_KEY'],
    model: 'echo-1',
  },
};

/* ── Garde-fou du registry ──────────────────────────────────────────────── */

/* A backend driven through a session (`openSession`) has no line stream: its
   fixtures are protocol scripts, and its contract lives with the driver
   (`acp/driver.test.ts`, `official-providers/acp.test.ts`, the fake ACP agent). Whether it
   is registered depends on its CLI being installed — opencode and Hermes are
   only there on a machine that has them — so it must not decide this suite. */
const sessionDriven = (name: string): boolean => 'openSession' in getBackend(name);
const remote = (name: string): boolean => 'openRemoteSession' in getBackend(name);

/**
 * Expectations of a REMOTE backend: its scenario profiles, on the same
 * dialect, which drag a turn out (`slow`, to cancel it or close the
 * session under it) and which fail (`failing`). A remote backend is covered
 * if it is a key of this table or one of its scenarios.
 */
const REMOTE_EXPECTATIONS: Record<string, { model: string; slow: string; failing: string }> = {
  'memory-remote': { model: 'memory-1', slow: 'memory-remote-slow', failing: 'memory-remote-failing' },
};
const remoteCovered = new Set(Object.entries(REMOTE_EXPECTATIONS).flatMap(([name, e]) => [name, e.slow, e.failing]));

test('every registered backend is covered by the conformance suite', () => {
  const uncovered = backendNames().filter((n) => remote(n)
    ? !remoteCovered.has(n)
    : !EXPECTATIONS[n] && !sessionDriven(n));
  assert.deepEqual(
    uncovered, [],
    `Backend(s) without conformance expectations: ${uncovered.join(', ')}. `
    + 'Add an entry to EXPECTATIONS (src/backends/contract.test.ts) and the '
    + 'matching JSONL fixtures file in src/backends/__fixtures__/. '
    + 'A backend registered without fixtures is a backend whose contract '
    + 'nobody knows.',
  );
});

test('the registry holds at least the two first-party backends', () => {
  for (const name of ['claude', 'codex']) {
    assert.ok(backendNames().includes(name), `backend ${name} absent du registry`);
  }
});

/* ── The four line-oriented dialects, frozen ──────────────────────────────
   Adding a session driver (`Dialect.openSession`) is an extension of the
   contract, not a change of these dialects. This table is what
   proves it: each declaration a caller can read, as it was
   before the extension. A change here is a change of behaviour, to
   own as such in the commit that makes it. */

const LINE_ORIENTED = {
  claude: {
    persistentProcess: true, finishMissionOnExit: true, sessionResumable: true,
    sessionStore: 'global', permissionModel: 'mcp-bridge', rateLimitReporting: 'structured',
    hostedConnectors: true, defaultCmd: 'claude',
  },
  codex: {
    // The rollout outlives the process and a kill: a closed mission wakes in place (#607).
    persistentProcess: false, finishMissionOnExit: false, sessionResumable: true,
    sessionStore: 'per-mission', permissionModel: 'sandbox', rateLimitReporting: 'textual',
    hostedConnectors: false, defaultCmd: 'codex',
  },
  grok: {
    persistentProcess: false, finishMissionOnExit: false, sessionResumable: true,
    sessionStore: 'per-mission', permissionModel: 'sandbox', rateLimitReporting: 'textual',
    hostedConnectors: false, defaultCmd: 'grok',
  },
  copilot: {
    persistentProcess: false, finishMissionOnExit: false, sessionResumable: true,
    sessionStore: 'global', permissionModel: 'sandbox', rateLimitReporting: 'textual',
    hostedConnectors: false, defaultCmd: 'copilot',
  },
} as const;

for (const [id, declared] of Object.entries(LINE_ORIENTED)) {
  test(`[${id}] dialect unchanged by the session driver extension`, () => {
    const dialect = getDialect(id);
    assert.ok(dialect, `dialecte ${id} absent`);
    for (const [key, value] of Object.entries(declared)) {
      assert.equal((dialect as unknown as Record<string, unknown>)[key], value, `${id}.${key}`);
    }
    assert.equal(dialect.openSession, undefined, `${id} must not declare a session driver`);
    // The bound Backend says the same: the absence IS the signal for the caller.
    assert.equal('openSession' in getBackend(id), false);
  });
}

test('protocol is a value of the contract, and no first-party dialect claims it yet', () => {
  assert.ok(PERMISSION_MODELS.includes('protocol'));
  for (const id of Object.keys(LINE_ORIENTED)) {
    assert.notEqual(getDialect(id)?.permissionModel, 'protocol', id);
  }
});

test('NO_SESSION_CAPABILITIES promises nothing, and cannot be rewritten', () => {
  assert.deepEqual(NO_SESSION_CAPABILITIES, { loadSession: false, resume: false, mcp: false, image: false });
  assert.throws(() => { (NO_SESSION_CAPABILITIES as { mcp: boolean }).mcp = true; }, TypeError);
});

/* ── Parameterised contract, one block per active backend ─────────────────
   The checks are those of the bench published in the SDK: the product does not pass
   a suite its plugin authors do not have. */

const ctx = { cwd: TMP_HOME, scratchDirs: [TMP_HOME] };

for (const name of backendNames()) {
  const exp = EXPECTATIONS[name];
  // The guard above has already reported the gap; nothing can be tested here.
  if (!exp || sessionDriven(name) || remote(name)) continue;
  const bound = getBackend(name);
  const backend = backendTrust(name) === 'official'
    ? { ...bound, buildSpawn: (o: import('./types.js').BuildSpawnOpts) => buildUnderSeal(name, o) }
    : bound;

  kit.defineConformanceTests(test, kit.lineProviderChecks(backend, {
    transcript: readFileSync(join(FIXTURES_DIR, exp.fixture), 'utf8'),
    sessionId: exp.sessionId,
    cmd: exp.cmd,
    envKeys: exp.envKeys,
    model: exp.model,
    ...(exp.initAt ? { initAt: exp.initAt } : {}),
  }, ctx), `[${name}]`);

  // What only the registry does: announce the PROFILE on init, never the
  // dialect. A shared dialect names itself (codex's writes "codex"
  // hard-coded), which made a mission served by Ollama Cloud declare itself
  // "codex" in its own history, and the agent, reading its init, believed
  // it was GPT.
  test(`[${name}] the init announces itself under the profile name, never the dialect`, () => {
    const events = readFileSync(join(FIXTURES_DIR, exp.fixture), 'utf8')
      .split('\n').filter((l) => l.trim().length > 0).flatMap((line) => backend.parseLine(line));
    const init = events.find((e) => e.type === 'system' && (e.payload as { subtype?: string }).subtype === 'init');
    assert.equal((init?.payload as { backend?: unknown }).backend, name);
  });
}

/* ── Remote backends: the driver contract, without a process or network ─────── */

for (const [name, exp] of Object.entries(REMOTE_EXPECTATIONS)) {
  if (!backendNames().includes(name)) continue;
  kit.defineConformanceTests(test, kit.remoteProviderChecks({
    model: exp.model,
    scenarios: { normal: getBackend(name), slow: getBackend(exp.slow), failing: getBackend(exp.failing) },
  }, ctx), `[${name}]`);
}
