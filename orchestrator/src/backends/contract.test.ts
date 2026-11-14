/**
 * Suite de CONFORMITÉ des backends.
 *
 * Un seul fichier, joué contre CHAQUE backend actif du registry
 * (`backendNames()`). C'est ce qui divise le coût du prochain provider : on
 * n'écrit pas une suite par backend, on déclare une entrée d'attentes + un
 * fichier de fixtures JSONL, et tout le contrat est vérifié.
 *
 * Les vérifications elles-mêmes vivent dans le banc que le SDK publie
 * (`@timon-ai/sdk/testing`, `packages/sdk/src/testing/`) : un auteur de plugin
 * lance la MÊME suite sur son dialecte. Ce fichier ne garde que ce qui dépend du
 * registry du produit (couverture, table figée des dialectes, nom du profil).
 *
 * Ce que la suite vérifie, sans jamais spawner de CLI ni toucher au réseau :
 *   - `buildSpawn` (fresh ET resume) produit un cmd/args/env/cwd cohérent, et
 *     achemine bien system prompt, message, modèle et id de resume ;
 *   - `parseLine` sur des fixtures JSONL réelles produit le vocabulaire
 *     normalisé TIMON (system/init, assistant, result) ;
 *   - `extractSessionId` retrouve l'id depuis le system/init de ces fixtures ;
 *   - les capacités déclarées collent au comportement réel (`initialStdin`
 *     non nul ⇔ `persistentProcess`, `writeUserInput` écrit ⇔ persistent…) ;
 *   - un backend SANS process (`RemoteDialect`) tient le contrat de son pilote :
 *     tour complet, annulation, échec lisible, fermeture (bloc "distants").
 *
 * `node --test --import tsx src/backends/contract.test.ts` (ou `npm test`).
 *
 * AJOUTER UN BACKEND : ajouter son entrée dans EXPECTATIONS ci-dessous et son
 * fichier `__fixtures__/<dialecte>.jsonl`. Sans ça la suite échoue — c'est tout
 * son intérêt : un backend enregistré mais non couvert n'est pas un backend
 * dont on connaît le contrat.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/* TIMON_HOME jetable : les dialectes codex et grok matérialisent un home par
   mission sur disque au buildSpawn. Posé AVANT l'import du registry (paths.js lit
   process.env au chargement) → import dynamique obligatoire. */
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
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const {
  backendNames, getBackend, NO_SESSION_CAPABILITIES, PERMISSION_MODELS,
} = await import('./index.js');
const { backendTrust, getDialect, registerDialect, registerProfile } = await import('./registry.js');
const { mountOfficialProviders, buildUnderSeal } = await import('../../tests/helpers/official-providers.js');
/* The providers the release ships as plugins (grok today) are registered the way the loader does: the contract
   covers them as it covers the core's. A plugin's services answer inside a launch, hence the seal. */
await mountOfficialProviders();
const kit = await import('../../../packages/sdk/src/testing/index.js');

/* Un dialecte TIERS entre dans la même suite que les first-party.
   `examples/plugin-provider` est le gabarit qu'un auteur copie : le faire
   passer ici est la seule façon de savoir que le contrat publié est celui que
   le produit applique vraiment. Enregistré AVANT la boucle paramétrée, qui lit
   `backendNames()` au chargement du module. */
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
  label: 'Echo (démo)',
  vendor: 'Exemple',
  custom: true,
  env: { ECHO_API_KEY: 'clé-de-test' },
  defaultModel: 'echo-1',
  models: [{ slug: 'echo-1', label: 'echo-1', contextWindow: 8_000 }],
});
/* Dialecte DISTANT apporté par un plugin (`examples/plugin-remote-backend`) :
   aucun process, un pilote en mémoire. Trois profils sur le même dialecte, un
   par comportement que le contrat doit voir (cf. REMOTE_EXPECTATIONS). */
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
 * Attentes propres à un backend. Tout ce qui n'est PAS ici est vérifié de façon
 * générique plus bas — la règle est de garder cette table aussi maigre que
 * possible pour qu'un nouveau backend soit bon marché à couvrir.
 */
type Expectation = {
  /** Fichier de `__fixtures__/`, une ligne JSONL par event tel que le CLI
   *  l'émet réellement (avant normalisation). */
  fixture: string;
  /** Session/thread id porté par le system:init de la fixture. */
  sessionId: string;
  /** Binaire attendu au spawn. */
  cmd: string;
  /** Clés d'env que `buildSpawn` DOIT poser (au-delà de process.env). */
  envKeys: string[];
  /** Modèle passé à `cfg.model` — doit être cohérent avec le backend. */
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
    // Profil first-party : rien à injecter, l'env de l'orchestrateur suffit.
    envKeys: [],
    model: 'opus',
  },
  codex: {
    fixture: 'codex.jsonl',
    sessionId: '0199f3c1-8b7a-7c2d-9e4f-5a6b7c8d9e0f',
    cmd: 'codex',
    // CODEX_HOME per-mission : sans lui, config.toml et MCP de l'agent
    // seraient ceux de l'hôte.
    envKeys: ['CODEX_HOME'],
    model: 'gpt-5.5',
  },
  grok: {
    fixture: 'grok.jsonl',
    sessionId: '01a014dc-392a-7753-9cf4-a111cc3ac77f',
    cmd: 'grok',
    // GROK_HOME per-mission : porte config.toml (MCP), rules/ (prompt système)
    // et les sessions, donc le resume en dépend.
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
  /* Profils tiers : même dialecte, donc mêmes fixtures. Ils ne sont actifs que
     si leurs credentials sont dans l'env — les entrées restent ici pour que la
     suite les couvre dès qu'ils le deviennent. */
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
  /* Dialecte apporté par un PLUGIN (`examples/plugin-provider`), couvert
     exactement comme les autres : c'est ce qui rend la promesse open-core
     vérifiable plutôt que déclarative. */
  'echo-llm': {
    fixture: 'echo.jsonl',
    sessionId: 'echo-session-7f21c0d4',
    cmd: 'echo',
    // L'env vient du profil, que le plugin a rempli depuis ses réglages.
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
 * Attentes d'un backend DISTANT : ses profils de scénario, sur le même
 * dialecte, qui font traîner un tour (`slow`, pour l'annuler ou fermer la
 * session dessous) et qui échouent (`failing`). Un backend distant est couvert
 * s'il est une clé de cette table ou l'un de ses scénarios.
 */
const REMOTE_EXPECTATIONS: Record<string, { model: string; slow: string; failing: string }> = {
  'memory-remote': { model: 'memory-1', slow: 'memory-remote-slow', failing: 'memory-remote-failing' },
};
const remoteCovered = new Set(Object.entries(REMOTE_EXPECTATIONS).flatMap(([name, e]) => [name, e.slow, e.failing]));

test('tout backend enregistré est couvert par la suite de conformité', () => {
  const uncovered = backendNames().filter((n) => remote(n)
    ? !remoteCovered.has(n)
    : !EXPECTATIONS[n] && !sessionDriven(n));
  assert.deepEqual(
    uncovered, [],
    `Backend(s) sans attentes de conformité : ${uncovered.join(', ')}. `
    + "Ajoute une entrée dans EXPECTATIONS (src/backends/contract.test.ts) et le "
    + 'fichier de fixtures JSONL correspondant dans src/backends/__fixtures__/. '
    + "Un backend enregistré sans fixtures est un backend dont personne ne "
    + 'connaît le contrat.',
  );
});

test('le registry contient au moins les deux backends first-party', () => {
  for (const name of ['claude', 'codex']) {
    assert.ok(backendNames().includes(name), `backend ${name} absent du registry`);
  }
});

/* ── Les quatre dialectes line-oriented, figés ──────────────────────────────
   Ajouter un pilote de session (`Dialect.openSession`) est une extension du
   contrat, pas une modification de ces dialectes. Cette table est ce qui le
   prouve : chaque déclaration qu'un appelant peut lire, telle qu'elle était
   avant l'extension. Un changement ici est un changement de comportement, à
   assumer comme tel dans le commit qui le fait. */

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
  test(`[${id}] dialecte inchangé par l'extension pilote de session`, () => {
    const dialect = getDialect(id);
    assert.ok(dialect, `dialecte ${id} absent`);
    for (const [key, value] of Object.entries(declared)) {
      assert.equal((dialect as unknown as Record<string, unknown>)[key], value, `${id}.${key}`);
    }
    assert.equal(dialect.openSession, undefined, `${id} ne doit pas déclarer de pilote de session`);
    // Le Backend lié le dit pareil : l'absence EST le signal pour l'appelant.
    assert.equal('openSession' in getBackend(id), false);
  });
}

test('protocol est une valeur du contrat, et aucun dialecte first-party ne la revendique encore', () => {
  assert.ok(PERMISSION_MODELS.includes('protocol'));
  for (const id of Object.keys(LINE_ORIENTED)) {
    assert.notEqual(getDialect(id)?.permissionModel, 'protocol', id);
  }
});

test('NO_SESSION_CAPABILITIES ne promet rien, et ne se laisse pas réécrire', () => {
  assert.deepEqual(NO_SESSION_CAPABILITIES, { loadSession: false, resume: false, mcp: false, image: false });
  assert.throws(() => { (NO_SESSION_CAPABILITIES as { mcp: boolean }).mcp = true; }, TypeError);
});

/* ── Contrat paramétré, un bloc par backend actif ─────────────────────────
   Les vérifications sont celles du banc publié dans le SDK : le produit ne passe
   pas une suite que ses auteurs de plugins n'ont pas. */

const ctx = { cwd: TMP_HOME, scratchDirs: [TMP_HOME] };

for (const name of backendNames()) {
  const exp = EXPECTATIONS[name];
  // Le garde-fou ci-dessus a déjà signalé le trou ; ici on ne peut rien tester.
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

  // Ce que seul le registry fait : annoncer le PROFIL sur l'init, jamais le
  // dialecte. Un dialecte partagé se nomme lui-même (celui de codex écrit "codex"
  // en dur), ce qui faisait qu'une mission servie par Ollama Cloud se déclarait
  // "codex" dans son propre historique — et que l'agent, lisant son init, se
  // croyait GPT.
  test(`[${name}] l'init s'annonce sous le nom du profil, jamais du dialecte`, () => {
    const events = readFileSync(join(FIXTURES_DIR, exp.fixture), 'utf8')
      .split('\n').filter((l) => l.trim().length > 0).flatMap((line) => backend.parseLine(line));
    const init = events.find((e) => e.type === 'system' && (e.payload as { subtype?: string }).subtype === 'init');
    assert.equal((init?.payload as { backend?: unknown }).backend, name);
  });
}

/* ── Backends distants : le contrat du pilote, sans process ni réseau ─────── */

for (const [name, exp] of Object.entries(REMOTE_EXPECTATIONS)) {
  if (!backendNames().includes(name)) continue;
  kit.defineConformanceTests(test, kit.remoteProviderChecks({
    model: exp.model,
    scenarios: { normal: getBackend(name), slow: getBackend(exp.slow), failing: getBackend(exp.failing) },
  }, ctx), `[${name}]`);
}
