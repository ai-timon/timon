/**
 * Non-regression of the MCP wiring of a codex agent. Two conditions, both
 * needed for a tool call to succeed; their absence made
 * `ask_user` and `kanban_add` unusable on 2026-08-12:
 *
 *  1. `default_tools_approval_mode` on EACH server. Without it, codex ≥ 0.147
 *     asks for an approval per MCP tool call, and `codex exec`, non
 *     interactive, has nobody to ask: the call comes back as
 *     `user cancelled MCP tool call` in 0.0 s, blaming a human who did
 *     nothing.
 *  2. `TIMON_MISSION_ID` / `TIMON_AGENT` declared in the env of the internal MCPs.
 *     Codex does not let the stdio servers inherit its own environment.
 *
 * The test reads the config.toml REALLY materialised by `buildSpawn`, not an
 * intermediate string: that file is what the CLI loads, and the TOML trap
 * is precisely a matter of placement (a key set after a `.env` header
 * belongs to the subtable, not to the server).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeHomeOnExit } from '../../tests/helpers/test-home.js';

/* Throwaway TIMON_HOME, set BEFORE any import: paths.js reads it on load. */
const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-mcp-approval-'));
process.env.TIMON_HOME = TMP_HOME;
process.env.CODEX_AUTH_DIR = join(TMP_HOME, 'codex-auth');
mkdirSync(process.env.CODEX_AUTH_DIR, { recursive: true });
writeFileSync(join(process.env.CODEX_AUTH_DIR, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.env.PORT = '3010';
removeHomeOnExit(TMP_HOME);

const { mountOfficialProviders, buildUnderSeal } = await import('../../tests/helpers/official-providers.js');
const { CODEX_MCP_APPROVAL_TOML } = await import('../backends/codex-mcp-approval.js');
await mountOfficialProviders();
type AgentConfig = import('../agent.js').AgentConfig;

const MISSION_ID = 'mission-mcp-approval-0001';
const AGENT_NAME = 'TIMON.approval';

/** Agent cwd with a `.grepai` → the grepai block is injected too. */
function makeCwd(): string {
  const cwd = join(TMP_HOME, 'projet');
  mkdirSync(join(cwd, '.grepai'), { recursive: true });
  return cwd;
}

/** Two opt-in MCPs covering both transports codex can load: a
 *  stdio one WITH env (the case where the TOML placement is tricky) and an http one. */
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
 * Splits the TOML into tables and returns, for each `[mcp_servers.<name>]` (the
 * `.env` subtables excluded), the keys that REALLY belong to it, hence
 * those written before the next header.
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

test('each MCP server of the codex config.toml carries the approval mode', async () => {
  const toml = await buildConfigToml();
  const tables = serverTables(toml);

  // The three MCPs TIMON injects by default + the two opt-in ones of the agent.
  for (const name of ['timon', 'timon_ask', 'grepai', 'probe_stdio', 'probe_http']) {
    assert.ok(tables.has(name), `server ${name} missing from config.toml:\n${toml}`);
  }
  for (const [name, keys] of tables) {
    assert.ok(
      keys.includes(CODEX_MCP_APPROVAL_TOML),
      `[mcp_servers.${name}] without ${CODEX_MCP_APPROVAL_TOML} → every tool call `
      + `of this server will come back as "user cancelled MCP tool call" under codex exec.\n${toml}`,
    );
  }
});

test('the approval mode does not fall into the .env subtable', async () => {
  const toml = await buildConfigToml();
  // WHY: the most likely regression is a line moved after
  // `[mcp_servers.<x>.env]`. The TOML would stay valid, the key would be read as
  // an environment variable, and the bug would come back without breaking anything.
  const envTables = toml.split(/^\[/m)
    .filter((chunk) => /^mcp_servers\.[A-Za-z0-9_-]+\.env\]/.test(chunk));
  assert.ok(envTables.length > 0, 'no .env subtable in the fixture: the test went blind');
  for (const chunk of envTables) {
    assert.ok(
      !chunk.includes('default_tools_approval_mode'),
      `default_tools_approval_mode written in a .env subtable:\n[${chunk}`,
    );
  }
});

test('the internal MCPs receive the mission identity in their env', async () => {
  const toml = await buildConfigToml();
  // WHY: codex does not let the stdio MCPs inherit its env (checked on 0.147,
  // only PATH and the declared keys go through). If these variables are missing,
  // `ask_user` POSTs an empty mission_id → 400, and the `timon` MCP loses the
  // headers that attach a task to its originating mission.
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

test('the internal MCPs receive the mission token through env_vars, never its value', async () => {
  const toml = await buildConfigToml();
  // WHY (beta tester, Windows, 0.1.0): without `env_vars`, the bridge receives an empty
  // token and `ask_user` POSTs anonymously → 401 on any instance with accounts,
  // no form shows up. The browser already had the line, they did not.
  const tables = serverTables(toml);
  for (const server of ['timon', 'timon_ask']) {
    assert.ok(
      tables.get(server)?.some((line) => line.startsWith('env_vars = ["TIMON_API_TOKEN", ')),
      `[mcp_servers.${server}] sans env_vars = ["TIMON_API_TOKEN"] :\n${toml}`,
    );
  }
  // The VALUE must never land in config.toml (a plain-text file, per
  // mission, under ~/.timon/provider-runs/provider-codex/). The token is the one
  // `buildUnderSeal` issues, not an inherited TIMON_API_TOKEN: run-tests.mjs
  // no longer passes on the mission one (TODO #606).
  assert.ok(!toml.includes(`test-token-${MISSION_ID}`), 'the token value is written in config.toml');
});

test('the value kept is indeed a variant codex accepts', () => {
  // `auto` | `prompt` | `writes` all require an approval in at least one
  // case, impossible to satisfy in `exec`. Only `approve` unblocks.
  assert.equal(CODEX_MCP_APPROVAL_TOML, 'default_tools_approval_mode = "approve"');
});
