/**
 * An MCP server declared as `npx -y <package>`, started inside the real
 * fence: the user's home is read-only there, so npm fails at once in
 * `~/.npm`, even with the package already cached (it writes the refreshed
 * metadata under `_cacache/tmp`). With the agent's own package cache, the
 * server starts with the cache empty, then again with it full, and another
 * agent's mission cannot read that cache.
 *
 * Runs only where a mission can be fenced (Linux, Landlock, a C compiler to
 * build the launcher) and the npm registry answers: the package is
 * downloaded for real, as a user's MCP server would be.
 */
import './test-home.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, setConfig } from './config/load.js';
import { findFenceBinary, probeFence } from './host/fence.js';
import { createLandlockFence } from './host/landlock.js';
import { packageCacheEnv } from './backends/package-cache-env.js';
import { fenceMissionCommand } from './resources.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
// Pinned: a release of the reference server that is neither deprecated nor held to a Node engine floor.
const PACKAGE = '@modelcontextprotocol/server-everything@1.0.0';

function launcher(): string | null {
  if (process.platform !== 'linux') return null;
  const found = findFenceBinary();
  if (found) return found;
  const out = join(mkdtempSync(join(tmpdir(), 'fence-npx-bin-')), 'timon-fence');
  try {
    execFileSync(process.execPath, [join(REPO, 'native', 'timon-fence', 'build.mjs'), '--out', out, '--optional'], { stdio: 'ignore', timeout: 120_000 });
  } catch { return null; }
  return existsSync(out) ? out : null;
}

/** `npx` next to the `node` running the tests: the one a user's MCP line names. */
function npx(): string | null {
  const beside = join(dirname(process.execPath), 'npx');
  return existsSync(beside) ? beside : null;
}

async function registryAnswers(): Promise<boolean> {
  try {
    const res = await fetch('https://registry.npmjs.org/@modelcontextprotocol%2fserver-everything', {
      method: 'HEAD', signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const FENCE = launcher();
const PROBE = FENCE ? probeFence(FENCE) : null;
const NPX = npx();
const skip = !FENCE ? 'no timon-fence for this machine (Linux with a C compiler only)'
  : !PROBE?.available ? `no fence on this kernel: ${PROBE?.reason}`
  : !NPX ? 'no npx beside node'
  : !(await registryAnswers()) ? 'the npm registry does not answer' : false;

const INITIALIZE = `${JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fence-test', version: '0' } },
})}\n`;

type Run = { answered: boolean; code: number | null; stderr: string };

/** Starts `cmd` as a CLI would start a stdio MCP server, and waits for its answer to `initialize`. */
async function startServer(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Run> {
  const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  child.stdin.on('error', () => { /* a server that died at launch closed its stdin */ });
  child.stdin.write(INITIALIZE);
  return new Promise<Run>((resolve) => {
    let answered = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 90_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (!answered && /"id":1\b/.test(stdout) && /"result"/.test(stdout)) {
        answered = true;
        child.kill('SIGTERM');
      }
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ answered, code, stderr: answered ? stderr : `${stderr}\n[stdout] ${stdout.slice(0, 500)}` });
    });
  });
}

test('an npx MCP server starts inside the fence from its agent\'s cache, empty then full, out of other agents\' reach', { skip }, async () => {
  // Not under /tmp when avoidable: every mission writes it, so a home inside it is listed whole.
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime && existsSync(runtime) ? runtime : tmpdir();
  const root = realpathSync(mkdtempSync(join(base, 'fence-npx-')));
  const previous = config();
  after(() => {
    setConfig(previous);
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, 'home');
  const th = join(home, '.timon');
  const cwd = join(th, 'worktrees', 'task-npx');
  for (const dir of [cwd, join(th, 'agents', 'coder'), join(th, 'agents', 'other')]) mkdirSync(dir, { recursive: true });
  // Should the scenario land under /tmp, which every mission writes, the home stays read-only like a real one.
  setConfig({ ...previous, host: { ...previous.host, isolation: { ...previous.host.isolation, readOnly: [home] } } });
  const fence = createLandlockFence({ status: () => ({ state: 'ready', binary: FENCE as string, abi: PROBE?.abi ?? 0, seccomp: true }) });
  let launches = 0;
  const fenced = (agent: string, unit: string, cmd: string, args: string[]) => {
    launches += 1;
    const launch = fenceMissionCommand(cmd, args, unit, {
      timonHome: th, home, cwd, missionId: `aaaaaaaa-0000-4000-8000-00000000000${launches}`, agent, platform: 'linux',
    }, { mode: 'enforce', fence, warn: () => {} });
    assert.ok(launch.fence?.state === 'fenced' && launch.fence.tmpDir);
    return { ...launch, fence: launch.fence };
  };
  const baseEnv = (tmpDir: string): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: home, TMPDIR: tmpDir });
  const server = [NPX as string, '-y', PACKAGE, 'stdio'] as const;

  // Before: the user's own cache, in the read-only home.
  const bare = fenced('coder', 'u-bare', server[0], server.slice(1));
  const refused = await startServer(bare.cmd, bare.args, cwd, baseEnv(bare.fence.tmpDir as string));
  assert.equal(refused.answered, false);
  assert.match(refused.stderr, /EACCES/);

  // With the agent's cache: empty, then full.
  const cache = bare.fence.packageCacheDir;
  assert.equal(cache, join(th, 'provider-cache', '.agents', 'coder'));
  for (const round of ['empty cache', 'full cache']) {
    const launch = fenced('coder', `u-${round.replace(' ', '-')}`, server[0], server.slice(1));
    const run = await startServer(launch.cmd, launch.args, cwd, {
      ...baseEnv(launch.fence.tmpDir as string), ...packageCacheEnv(launch.fence.packageCacheDir as string),
    });
    assert.ok(run.answered, `${round}: ${run.stderr}`);
    const npm = join(cache as string, 'npm');
    assert.ok(existsSync(join(npm, '_cacache')), `${round}: the download landed in the agent's cache`);
    assert.equal(readdirSync(join(npm, '_npx')).length, 1, `${round}: one install of the package, reused`);
  }

  // Another agent's mission cannot read that cache, let alone plant a package in it.
  const probe = String.raw`
const fs = require('node:fs');
const t = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code || String(e.message); } };
process.stdout.write(JSON.stringify({
  read: t(() => fs.readdirSync(process.argv[1])),
  write: t(() => fs.writeFileSync(require('node:path').join(process.argv[1], 'planted'), 'x')),
}));`;
  const other = fenced('other', 'u-other-agent', process.execPath, ['-e', probe, join(cache as string, 'npm', '_npx')]);
  const out = execFileSync(other.cmd, other.args, { cwd, env: baseEnv(other.fence.tmpDir as string), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), { read: 'EACCES', write: 'EACCES' });
});
