/**
 * Non-régression du câblage MCP d'un agent codex. Deux conditions, toutes deux
 * nécessaires pour qu'un appel d'outil aboutisse — leur absence a rendu
 * `ask_user` et `kanban_add` inutilisables le 2026-08-12 :
 *
 *  1. `default_tools_approval_mode` sur CHAQUE serveur. Sans lui, codex ≥ 0.147
 *     réclame une approbation par appel d'outil MCP — et `codex exec`, non
 *     interactif, n'a personne à qui la demander : l'appel revient en
 *     `user cancelled MCP tool call` en 0,0 s, en accusant un humain qui n'a
 *     rien fait.
 *  2. `TIMON_MISSION_ID` / `TIMON_AGENT` déclarés dans l'env des MCP internes.
 *     Codex ne laisse pas hériter son propre environnement aux serveurs stdio.
 *
 * Le test lit le config.toml RÉELLEMENT matérialisé par `buildSpawn`, pas une
 * chaîne intermédiaire : c'est ce fichier que le CLI charge, et le piège TOML
 * est justement une question de placement (une clé posée après un en-tête `.env`
 * appartient à la sous-table, pas au serveur).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/* TIMON_HOME jetable, posé AVANT tout import : paths.js le lit au chargement. */
const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-mcp-approval-'));
process.env.TIMON_HOME = TMP_HOME;
process.env.CODEX_AUTH_DIR = join(TMP_HOME, 'codex-auth');
mkdirSync(process.env.CODEX_AUTH_DIR, { recursive: true });
writeFileSync(join(process.env.CODEX_AUTH_DIR, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.env.PORT = '3010';
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { mountOfficialProviders, buildUnderSeal } = await import('../../tests/helpers/official-providers.js');
const { CODEX_MCP_APPROVAL_TOML } = await import('../backends/codex-mcp-approval.js');
await mountOfficialProviders();
type AgentConfig = import('../agent.js').AgentConfig;

const MISSION_ID = 'mission-mcp-approval-0001';
const AGENT_NAME = 'TIMON.approval';

/** cwd d'agent avec un `.grepai` → le bloc grepai est injecté lui aussi. */
function makeCwd(): string {
  const cwd = join(TMP_HOME, 'projet');
  mkdirSync(join(cwd, '.grepai'), { recursive: true });
  return cwd;
}

/** Deux MCP opt-in couvrant les deux transports que codex sait charger : un
 *  stdio AVEC env (le cas où le placement TOML est piégeux) et un http. */
function seedUserMcps(): string[] {
  const dir = join(TMP_HOME, 'mcp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'probe-stdio.json'), JSON.stringify({
    id: 'probe-stdio',
    name: 'probe_stdio',
    transport: { type: 'stdio', command: 'node', args: ['/tmp/probe.mjs'], env: { PROBE_TOKEN: 'x' } },
  }));
  writeFileSync(join(dir, 'probe-http.json'), JSON.stringify({
    id: 'probe-http',
    name: 'probe_http',
    transport: { type: 'http', url: 'http://127.0.0.1:8787/mcp' },
  }));
  return ['probe-stdio', 'probe-http'];
}

async function buildConfigToml(): Promise<string> {
  const cfg: AgentConfig = {
    cwd: makeCwd(),
    model: 'gpt-5.5',
    permission_mode: 'auto',
    mcp_servers: seedUserMcps(),
  };
  const sp = await buildUnderSeal('codex', {
    agentName: AGENT_NAME,
    systemPrompt: 'Agent de test.',
    message: 'Bonjour.',
    resumeSession: null,
    cfg,
    missionId: MISSION_ID,
  });
  const codexHome = sp.env?.CODEX_HOME;
  assert.ok(typeof codexHome === 'string' && codexHome.length > 0, 'CODEX_HOME absent du spawn');
  return readFileSync(join(codexHome, 'config.toml'), 'utf8');
}

/**
 * Découpe le TOML en tables et rend, pour chaque `[mcp_servers.<name>]` (les
 * sous-tables `.env` exclues), les clés qui lui appartiennent VRAIMENT — donc
 * celles écrites avant l'en-tête suivant.
 */
function serverTables(toml: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const path = header[1] ?? '';
      const m = /^mcp_servers\.([A-Za-z0-9_-]+)$/.exec(path);
      current = m ? (m[1] ?? null) : null;
      if (current) out.set(current, []);
      continue;
    }
    if (current && line.length > 0) out.get(current)?.push(line);
  }
  return out;
}

test('chaque serveur MCP du config.toml codex porte le mode d\'approbation', async () => {
  const toml = await buildConfigToml();
  const tables = serverTables(toml);

  // Les trois MCP injectés d'office par TIMON + les deux opt-in de l'agent.
  for (const name of ['timon', 'timon_ask', 'grepai', 'probe_stdio', 'probe_http']) {
    assert.ok(tables.has(name), `serveur ${name} absent du config.toml :\n${toml}`);
  }
  for (const [name, keys] of tables) {
    assert.ok(
      keys.includes(CODEX_MCP_APPROVAL_TOML),
      `[mcp_servers.${name}] sans ${CODEX_MCP_APPROVAL_TOML} → tout appel d'outil `
      + `de ce serveur reviendra en « user cancelled MCP tool call » sous codex exec.\n${toml}`,
    );
  }
});

test('le mode d\'approbation ne tombe pas dans la sous-table .env', async () => {
  const toml = await buildConfigToml();
  // WHY : la régression la plus probable est un déplacement d'une ligne après
  // `[mcp_servers.<x>.env]`. Le TOML resterait valide, la clé serait lue comme
  // une variable d'environnement, et le bug reviendrait sans rien casser.
  const envTables = toml.split(/^\[/m)
    .filter((chunk) => /^mcp_servers\.[A-Za-z0-9_-]+\.env\]/.test(chunk));
  assert.ok(envTables.length > 0, 'aucune sous-table .env dans le fixture — test devenu aveugle');
  for (const chunk of envTables) {
    assert.ok(
      !chunk.includes('default_tools_approval_mode'),
      `default_tools_approval_mode écrit dans une sous-table .env :\n[${chunk}`,
    );
  }
});

test('les MCP internes reçoivent l\'identité de la mission dans leur env', async () => {
  const toml = await buildConfigToml();
  // WHY : codex ne laisse pas hériter son env aux MCP stdio (vérifié sur 0.147,
  // seuls PATH et les clés déclarées passent). Si ces variables manquent,
  // `ask_user` POSTe un mission_id vide → 400, et le MCP `timon` perd les
  // en-têtes qui rattachent une task à sa mission d'origine.
  for (const server of ['timon', 'timon_ask']) {
    const chunk = toml.split(/^\[/m)
      .find((c) => c.startsWith(`mcp_servers.${server}.env]`));
    assert.ok(chunk, `sous-table [mcp_servers.${server}.env] absente :\n${toml}`);
    assert.match(chunk, new RegExp(`TIMON_MISSION_ID = "${MISSION_ID}"`));
    assert.match(chunk, new RegExp(`TIMON_AGENT = "${AGENT_NAME.replace('.', '\\.')}"`));
    assert.match(chunk, /TIMON_ORCH_URL = "http:\/\/localhost:3010"/,
      'the MCP must target the daemon port actually in use');
  }
});

test('les MCP internes reçoivent le jeton de mission par env_vars, jamais sa valeur', async () => {
  const toml = await buildConfigToml();
  // WHY (TIM bêta, Windows, 0.1.0) : sans `env_vars`, le pont reçoit un token
  // vide et `ask_user` POSTe anonymement → 401 sur toute instance à comptes,
  // aucun formulaire ne s'affiche. Le navigateur avait déjà la ligne, pas eux.
  const tables = serverTables(toml);
  for (const server of ['timon', 'timon_ask']) {
    assert.ok(
      tables.get(server)?.some((line) => line.startsWith('env_vars = ["TIMON_API_TOKEN", ')),
      `[mcp_servers.${server}] sans env_vars = ["TIMON_API_TOKEN"] :\n${toml}`,
    );
  }
  // La VALEUR ne doit jamais atterrir dans config.toml (fichier en clair, par
  // mission, sous ~/.timon/provider-runs/provider-codex/). Le jeton est celui
  // que `buildUnderSeal` émet, pas un TIMON_API_TOKEN hérité : run-tests.mjs
  // ne transmet plus celui de la mission (TODO #606).
  assert.ok(!toml.includes(`test-token-${MISSION_ID}`), 'la valeur du jeton est écrite dans config.toml');
});

test('la valeur retenue est bien un variant accepté par codex', () => {
  // `auto` | `prompt` | `writes` exigent tous une approbation dans au moins un
  // cas — impossible à satisfaire en `exec`. Seul `approve` débloque.
  assert.equal(CODEX_MCP_APPROVAL_TOML, 'default_tools_approval_mode = "approve"');
});
