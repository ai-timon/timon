/**
 * The daemon's own run of an allowed command: the folder is confined to what
 * the mission owns (links and `..` resolved first), the output keeps its end,
 * and a time out ends the command and what it started.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-command-run-'));
const { clampRunTimeout, commandShell, confineRunCwd, runShellCommand, DEFAULT_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS } = await import('./command-run.js');

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'timon-run-cwd-')));
const project = join(sandbox, 'project');
const sub = join(project, 'a', 'b');
const outside = join(sandbox, 'outside');
mkdirSync(sub, { recursive: true });
mkdirSync(outside);

test('the folder must exist and lie under a root', () => {
  assert.deepEqual(confineRunCwd(project, [project]), { ok: true, cwd: project });
  assert.deepEqual(confineRunCwd(sub, [project]), { ok: true, cwd: sub });
  assert.deepEqual(confineRunCwd(outside, [project]), { ok: false, reason: 'outside' });
  assert.deepEqual(confineRunCwd(join(project, 'nope'), [project]), { ok: false, reason: 'missing' });
  assert.deepEqual(confineRunCwd('', [project]), { ok: false, reason: 'missing' });
  const file = join(project, 'file.txt');
  writeFileSync(file, 'x');
  assert.deepEqual(confineRunCwd(file, [project]), { ok: false, reason: 'not_directory' });
  assert.deepEqual(confineRunCwd(project, [join(sandbox, 'gone')]), { ok: false, reason: 'outside' }, 'a missing root grants nothing');
  assert.deepEqual(confineRunCwd(project, []), { ok: false, reason: 'outside' });
});

test('a sibling that only shares a prefix is outside', () => {
  const sibling = join(sandbox, 'project-evil');
  mkdirSync(sibling);
  assert.deepEqual(confineRunCwd(sibling, [project]), { ok: false, reason: 'outside' });
});

test('`..` and a link that leaves the root are refused', (t) => {
  assert.deepEqual(confineRunCwd(join(project, '..', 'outside'), [project]), { ok: false, reason: 'outside' });
  assert.deepEqual(confineRunCwd(join(sub, '..', '..', '..'), [project]), { ok: false, reason: 'outside' });
  const link = join(project, 'escape');
  try { symlinkSync(outside, link, 'dir'); } catch { t.skip('symlinks need a privilege on this machine'); return; }
  assert.deepEqual(confineRunCwd(link, [project]), { ok: false, reason: 'outside' });
  assert.deepEqual(confineRunCwd(join(link), [outside]), { ok: true, cwd: outside }, 'the target is what counts');
  // A link inside the root that stays inside is fine.
  const inner = join(project, 'inner');
  symlinkSync(sub, inner, 'dir');
  assert.deepEqual(confineRunCwd(inner, [project]), { ok: true, cwd: sub });
});

test('the time limit is clamped', () => {
  assert.equal(clampRunTimeout(undefined), DEFAULT_RUN_TIMEOUT_MS);
  assert.equal(clampRunTimeout(-5), DEFAULT_RUN_TIMEOUT_MS);
  assert.equal(clampRunTimeout(Number.NaN), DEFAULT_RUN_TIMEOUT_MS);
  assert.equal(clampRunTimeout(5_000), 5_000);
  assert.equal(clampRunTimeout(10 * MAX_RUN_TIMEOUT_MS), MAX_RUN_TIMEOUT_MS);
});

test('the shell is chosen per system', () => {
  assert.deepEqual(commandShell('ls', 'linux', { envShell: '/bin/zsh' }), { shell: '/bin/zsh', args: ['-lc', 'ls'] });
  assert.deepEqual(commandShell('ls', 'darwin', { envShell: '', passwdShell: () => '/bin/bash' }), { shell: '/bin/bash', args: ['-lc', 'ls'] });
  assert.equal(commandShell('ls', 'linux', { envShell: '', passwdShell: () => '' }).shell, '/bin/sh');
  const win = commandShell('git status', 'win32', { pwsh: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' });
  assert.equal(win.shell, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.deepEqual(win.args.slice(-2), ['-Command', 'git status']);
  assert.equal(commandShell('x', 'win32', { pwsh: () => null }).shell, 'powershell.exe');
});

// A program that behaves the same under any shell: node itself, started by the test's own shell stand-in.
const node = process.execPath;
const viaNode = (script: string): { shell: string; args: string[] } => ({ shell: node, args: ['-e', script] });

test('the exit code, the output of both streams and the duration come back', async () => {
  const r = await runShellCommand({
    command: 'ignored', cwd: project, env: { PATH: process.env.PATH ?? '' },
    shell: viaNode("process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exit(7)"),
  });
  assert.equal(r.exitCode, 7);
  assert.equal(r.timedOut, false);
  assert.equal(r.failedToStart, false);
  assert.match(r.output, /out/);
  assert.match(r.output, /err/);
  assert.ok(r.durationMs >= 0);
});

test('it runs in the folder it is given', async () => {
  const r = await runShellCommand({
    command: 'ignored', cwd: sub, env: {}, shell: viaNode('process.stdout.write(process.cwd())'),
  });
  assert.equal(realpathSync(r.output), sub);
});

test('the output is cut to its end', async () => {
  const r = await runShellCommand({
    command: 'ignored', cwd: project, env: {}, maxOutputChars: 100,
    shell: viaNode("process.stdout.write('a'.repeat(5000) + 'THE-END')"),
  });
  assert.equal(r.truncated, true);
  assert.ok(r.output.length <= 100);
  assert.ok(r.output.endsWith('THE-END'));
});

test('a time out kills the command and what it started', async () => {
  const marker = join(sandbox, 'grandchild-pid');
  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(child.pid));
    setInterval(() => {}, 1000);`;
  const started = Date.now();
  const r = await runShellCommand({ command: 'ignored', cwd: project, env: {}, timeoutMs: 1_500, shell: viaNode(script) });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.ok(Date.now() - started < 10_000);
  assert.ok(existsSync(marker));
  if (process.platform !== 'win32') {
    const pid = Number(await import('node:fs').then((fs) => fs.readFileSync(marker, 'utf8')));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.throws(() => process.kill(pid, 0), 'the grandchild is gone with the group');
  }
});

test('a shell that cannot start is reported, not thrown', async () => {
  const r = await runShellCommand({ command: 'x', cwd: project, env: {}, shell: { shell: join(sandbox, 'no-such-shell'), args: [] } });
  assert.equal(r.failedToStart, true);
  assert.equal(r.exitCode, null);
  assert.match(r.output, /could not start the shell/);
});
