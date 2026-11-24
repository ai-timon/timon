/**
 * `timon plugin check` run for real, in its own process (TODO #643): exit
 * codes 0 / 1 / 64, `--json`, `--strict`, `--deny`, and npm missing from the
 * PATH. The rules themselves are covered by `preship-check.test.ts`.
 *
 * The CLI loads `dist/`; `tests/helpers/dist-from-src.mjs` points it at `src/`.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ORCH = fileURLToPath(new URL('../../', import.meta.url));
const TIMON = join(ORCH, 'bin', 'timon');
const IMPORTS = ['tsx', pathToFileURL(join(ORCH, 'tests', 'helpers', 'dist-from-src.mjs')).href];
const HOME = mkdtempSync(join(tmpdir(), 'timon-cli-check-home-'));
const WORK = mkdtempSync(join(tmpdir(), 'timon-cli-check-'));
let serial = 0;

function runTimon(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // A closed port by default: `check` asks the daemon for its Node, and a test never reaches the live one.
    const full: NodeJS.ProcessEnv = { ...process.env, TIMON_HOME: HOME, TIMON_RESOURCE_GUARD_ENABLED: '0', TIMON_API: 'http://127.0.0.1:9', TIMON_API_TOKEN: '', ...env };
    // Windows names a variable whatever its case (`Path`): an override must not leave the inherited spelling beside it.
    if (process.platform === 'win32') {
      for (const name of Object.keys(env)) {
        for (const key of Object.keys(full)) if (key !== name && key.toUpperCase() === name.toUpperCase()) delete full[key];
      }
    }
    delete full.TIMON_MISSION_ID;
    const child = spawn(process.execPath, [...IMPORTS.flatMap((m) => ['--import', m]), TIMON, ...args], {
      cwd: ORCH, env: full, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += String(c); });
    child.stderr.on('data', (c: Buffer) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function folder(manifest: Record<string, unknown> = {}, code = 'export function apply() {}\n'): string {
  const dir = join(WORK, `p-${++serial}`);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@acme/cli-check-${serial}`, version: '1.0.0', type: 'module', main: 'lib/index.js', files: ['lib', 'README.md'],
    timon: { id: `acme-cli-check-${serial}`, apiVersion: 1, kind: 'behavior', permissions: [], ...manifest },
  }, null, 2));
  writeFileSync(join(dir, 'lib', 'index.js'), code);
  writeFileSync(join(dir, 'README.md'), '# Check\n');
  return dir;
}

test('a clean unsigned folder: exit 0, the warning printed, the line format kept', async () => {
  const r = await runTimon(['plugin', 'check', folder()]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^warn   unsigned  package\.json  /m);
  assert.match(r.stdout, /To check by hand:/);
  assert.match(r.stdout, /0 error\(s\), 1 warning\(s\)/);
});

test('--strict turns the warning into an error: exit 1', async () => {
  const r = await runTimon(['plugin', 'check', folder(), '--strict']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^error  unsigned  /m);
});

test('an invalid manifest: exit 1; --json prints the report as JSON', async () => {
  const r = await runTimon(['plugin', 'check', '--json', folder({ id: 'NOT VALID' })]);
  assert.equal(r.code, 1);
  const report = JSON.parse(r.stdout) as { ok: boolean; findings: Array<{ rule: string; level: string }>; packed: { source: string } };
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.rule === 'manifest' && f.level === 'error'));
});

test('engines.node no Node satisfies: exit 1, the rule named, the daemon unreachable said (TODO #763)', async () => {
  const dir = folder();
  const file = join(dir, 'package.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>, engines: { node: '>=999' } }, null, 2));
  // No daemon on the closed port: the CLI falls back to its own Node, and says so.
  const r = await runTimon(['plugin', 'check', dir]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /^error  node-engine  package\.json:\d+  .*requires Node >=999/m);
  assert.match(r.stdout, /daemon could not be reached/);
});

test('--deny is repeatable and makes each word an error', async () => {
  const dir = folder({}, '// tuned for acmecorp and the jdoe setup\nexport function apply() {}\n');
  const r = await runTimon(['plugin', 'check', dir, '--deny', 'acmecorp', '--deny=jdoe', '--json']);
  assert.equal(r.code, 1);
  const report = JSON.parse(r.stdout) as { findings: Array<{ rule: string; message: string }> };
  assert.equal(report.findings.filter((f) => f.rule === 'deny').length, 2);
});

/**
 * PATH alone does not hide npm: the adapter also looks in the account's folders
 * (an empty HOME takes those away) and in fixed ones such as `/usr/local/bin`,
 * where a CI runner keeps it. Found there, npm cannot start without `node` on
 * the PATH, which is the same "npm could not be run".
 */
async function checkWithoutNpm(home: string): Promise<void> {
  // Windows also looks in `%APPDATA%\npm`, `Program Files\nodejs`, Volta and nvm-windows, from the account's profile.
  // A 64-bit child gets `ProgramFiles` rebuilt from `ProgramW6432` by Windows itself: both go.
  const windows: NodeJS.ProcessEnv = process.platform === 'win32'
    ? { USERPROFILE: home, APPDATA: '', LOCALAPPDATA: '', ProgramFiles: '', ProgramW6432: '', NVM_SYMLINK: '' }
    : {};
  const r = await runTimon(['plugin', 'check', '--json', folder()], { PATH: '', HOME: home, NVM_DIR: '', ...windows });
  // The report carries the finding that failed: print it with stderr, or a red run says nothing.
  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const report = JSON.parse(r.stdout) as { packed: { source: string }; findings: Array<{ rule: string }> };
  assert.equal(report.packed.source, 'files');
  assert.ok(report.findings.some((f) => f.rule === 'npm-missing'));
}

test('npm missing from the PATH: the `files` fallback and its warning, still exit 0', async () => {
  await checkWithoutNpm(mkdtempSync(join(tmpdir(), 'timon-cli-check-user-')));
});

test('npm found outside the PATH but unable to start (exit 127): the same fallback, not a pack error', { skip: process.platform === 'win32' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-cli-check-user-'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  // What npm is on disk: a script whose `env node` finds nothing on an empty PATH.
  writeFileSync(join(home, '.local', 'bin', 'npm'), '#!/usr/bin/env node\nconsole.log("[]");\n', { mode: 0o755 });
  await checkWithoutNpm(home);
});

test('usage errors exit 64: no folder, a missing folder, an unknown option', async () => {
  for (const args of [['plugin', 'check'], ['plugin', 'check', join(WORK, 'nope')], ['plugin', 'check', folder(), '--fix']]) {
    const r = await runTimon(args);
    assert.equal(r.code, 64, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /usage: timon plugin check/);
  }
});
