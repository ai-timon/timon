import { mcpScriptPaths } from '../backends/mcp-paths.js';
import { resolve as resolveMcpRoot } from 'node:path';
const { timon: TIMON_MCP_PATH, forms: PERMISSION_MCP_PATH } = mcpScriptPaths(resolveMcpRoot(import.meta.dirname, '../..'));
/**
 * Moving codex out of the core (`docs/PROVIDERS-SDK.md` § 11.1, volet 5e) must not change what
 * the CLI is started with. The golden file `__fixtures__/codex-golden.json` was produced by the
 * dialect that lived in `backends/dialects/codex.ts`, on the commit before it left; this test
 * builds the same launches through the official provider and compares what the CLI would see: its
 * arguments, the variables the dialect sets, the prompt on stdin, and the `config.toml` it loads
 * (tables compared as sets of lines — TOML does not order keys — and the path of the mission's
 * folder, of the working directory and of the bundled MCP scripts replaced by a name).
 *
 * `UPDATE_CODEX_GOLDEN=1` rewrites the file; it is meant to be run on a core that still owns the
 * dialect, never to absorb a difference.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const SCRATCH = mkdtempSync(join(tmpdir(), 'timon-codex-parity-'));
process.on('exit', () => rmSync(SCRATCH, { recursive: true, force: true }));
// The sign-in the CLI would find, in a folder of the test's own.
const AUTH_DIR = join(SCRATCH, 'codex-auth');
mkdirSync(AUTH_DIR, { recursive: true });
writeFileSync(join(AUTH_DIR, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.env.CODEX_AUTH_DIR = AUTH_DIR;
process.env.PORT = '3010';
process.env.OLLAMA_API_KEY = 'ollama-key-witness';
delete process.env.CODEX_API_KEY;
delete process.env.OPENAI_API_KEY;
const BIN = join(SCRATCH, 'bin');
mkdirSync(BIN, { recursive: true });
writeFileSync(join(BIN, 'codex'), '', { mode: 0o755 });
process.env.PATH = `${BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;

const { dbApi } = await import('../db.js');
const { seal } = await import('../secrets/box.js');
const { resolveMasterKey } = await import('../secrets/key.js');
{
  const key = resolveMasterKey({ keyring: null });
  const row = dbApi.createSecret({ name: 'CODEX_API_KEY', value_enc: 'placeholder', mode: 'inject' });
  dbApi.updateSecret(row.id, { value_enc: seal('sk-witness', key, { secretId: row.id, name: 'CODEX_API_KEY' }) });
  dbApi.addSecretGrant(row.id, 'agent', 'parity.keyed');
}

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'codex-golden.json');

const { mountOfficialProviders, buildUnderSeal } = await import('../../tests/helpers/official-providers.js');

await mountOfficialProviders();
type SpawnOpts = import('../backends/types.js').BuildSpawnOpts;

/** A git repository with a linked worktree: the sandbox's writable roots need both shapes. */
let made: { repo: string; worktree: string } | null = null;
function makeRepo(): { repo: string; worktree: string } {
  if (made) return made;
  const repo = join(realpathSync(SCRATCH), 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (args: string[], cwd = repo): void => { execFileSync('git', args, { cwd, stdio: 'ignore' }); };
  git(['init', '-q', '-b', 'main']);
  git(['-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const worktree = join(repo, '..', 'repo-wt');
  git(['worktree', 'add', '-q', worktree, '-b', 'wt']);
  mkdirSync(join(worktree, '.grepai'), { recursive: true });
  made = { repo, worktree: realpathSync(worktree) };
  return made;
}

function seedUserMcps(): string[] {
  const dir = join(process.env.TIMON_HOME!, 'mcp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'probe-stdio.json'), JSON.stringify({
    id: 'probe-stdio', name: 'probe_stdio',
    transport: { type: 'stdio', command: 'node', args: ['/tmp/probe.mjs'], env: { PROBE_TOKEN: 'x' } },
  }));
  writeFileSync(join(dir, 'probe-http.json'), JSON.stringify({
    id: 'probe-http', name: 'probe_http', transport: { type: 'http', url: 'http://127.0.0.1:8787/mcp' },
  }));
  return ['probe-stdio', 'probe-http'];
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');

type Scenario = { name: string; backend: string; agent?: string; opts: (cwd: string) => Partial<SpawnOpts> & { cfg: SpawnOpts['cfg'] } };
const MCP = seedUserMcps();
const SCENARIOS: Scenario[] = [
  { name: 'subscription, git worktree, grepai, two user servers, reasoning', backend: 'codex', opts: (cwd) => ({ cfg: { cwd, model: 'gpt-5.5', permission_mode: 'auto', reasoningEffort: 'high', mcp_servers: MCP } }) },
  { name: 'plan mode resumes a thread with two pictures', backend: 'codex', opts: (cwd) => ({
    resumeSession: 'thread-0001', cfg: { cwd, model: 'gpt-5.6-sol', permission_mode: 'plan' },
    images: [{ media_type: 'image/png', data: PNG }, { media_type: 'image/jpeg', data: PNG }],
  }) },
  { name: 'without the Timon servers', backend: 'codex', opts: (cwd) => ({ timonMcp: false, cfg: { cwd, permission_mode: 'bypassPermissions' } }) },
  { name: 'an API key stands for the sign-in', backend: 'codex', agent: 'parity.keyed', opts: (cwd) => ({ cfg: { cwd, permission_mode: 'default' } }) },
  { name: 'Ollama Cloud: a provider block and a key, no sign-in', backend: 'ollama-cloud', opts: (cwd) => ({ cfg: { cwd, model: 'gpt-oss:120b', permission_mode: 'acceptEdits', mcp_servers: MCP } }) },
];

/** Tables of a TOML text as a map table → sorted lines (key order is not meaning). */
function tables(toml: string): Record<string, string[]> {
  const out: Record<string, string[]> = { '': [] };
  let current = '';
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { current = header[1]!; out[current] ??= []; continue; }
    out[current]!.push(line);
  }
  for (const key of Object.keys(out)) out[key]!.sort();
  if (out['']!.length === 0) delete out[''];
  return out;
}

type Described = {
  cmd: string; args: string[]; env: Record<string, string>; initialStdin: string | null;
  config: Record<string, string[]>; authJson: 'absent' | 'link' | 'file'; pictures: string[];
};

async function describe(s: Scenario, cwd: string): Promise<Described> {
  const missionId = `parity-${Math.abs([...s.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`;
  const partial = s.opts(cwd);
  const sp = await buildUnderSeal(s.backend, {
    agentName: s.agent ?? 'parity.agent', systemPrompt: 'Agent de test.', message: 'Bonjour.', resumeSession: null, missionId, ...partial,
  } as SpawnOpts);
  const home = sp.env?.CODEX_HOME;
  assert.ok(typeof home === 'string' && home.length > 0, 'CODEX_HOME is set');
  const swap = (text: string): string => text
    .split(realpathSync(home)).join('<HOME>').split(home).join('<HOME>')
    .split(cwd).join('<CWD>')
    .split(TIMON_MCP_PATH).join('<TIMON_MCP>').split(PERMISSION_MCP_PATH).join('<FORMS_MCP>')
    .split(process.env.TIMON_HOME!).join('<TIMON_HOME>')
    .split(AUTH_DIR).join('<AUTH_DIR>')
    .split(realpathSync(SCRATCH)).join('<TMP>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
  const config = tables(swap(readFileSync(join(home, 'config.toml'), 'utf8')));
  const auth = join(home, 'auth.json');
  const authJson = !existsSync(auth) ? 'absent' : lstatSync(auth).isSymbolicLink() ? 'link' : 'file';
  const imagesDir = join(home, 'images');
  return {
    cmd: sp.cmd === 'codex' ? 'codex' : 'codex-resolved',
    args: sp.args.map(swap),
    env: Object.fromEntries(Object.entries(sp.env ?? {}).map(([key, value]) => [key, swap(String(value))])),
    initialStdin: sp.initialStdin === undefined || sp.initialStdin === null ? null : String(sp.initialStdin),
    config, authJson,
    pictures: existsSync(imagesDir) ? readdirSync(imagesDir).map((name) => name.replace(/^[0-9a-f-]{36}/, '<uuid>')).sort() : [],
  };
}

async function allScenarios(): Promise<Record<string, Described>> {
  const { worktree } = makeRepo();
  const out: Record<string, Described> = {};
  for (const s of SCENARIOS) {
    // The API-key scenario has no sign-in file: the key, granted to its agent in the vault, stands for it.
    if (s.agent === 'parity.keyed') process.env.CODEX_AUTH_DIR = join(SCRATCH, 'nowhere');
    try {
      out[s.name] = await describe(s, worktree);
    } finally {
      process.env.CODEX_AUTH_DIR = AUTH_DIR;
    }
  }
  return out;
}

test('the official codex provider launches the CLI exactly as the dialect of the core did', async () => {
  const actual = await allScenarios();
  if (process.env.UPDATE_CODEX_GOLDEN === '1') {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, Described>;
  assert.deepEqual(Object.keys(actual), Object.keys(golden));
  for (const [name, expected] of Object.entries(golden)) {
    assert.deepEqual(actual[name], expected, name);
  }
});

test('the mission token never reaches config.toml', async () => {
  const { worktree } = makeRepo();
  const sp = await buildUnderSeal('codex', {
    agentName: 'parity.agent', systemPrompt: 's', message: 'm', resumeSession: null, missionId: 'parity-token',
    cfg: { cwd: worktree, permission_mode: 'auto' },
  } as SpawnOpts);
  const toml = readFileSync(join(sp.env!.CODEX_HOME!, 'config.toml'), 'utf8');
  assert.equal(toml.includes('test-token-parity-token'), false, 'the token value');
  assert.equal(toml.includes('timon-seal-'), false, 'a reference left unresolved');
  assert.match(toml, /env_vars = \["TIMON_API_TOKEN", "npm_config_cache"/);
});
