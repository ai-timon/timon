/**
 * What the daemon runs an allowed command with and where: the folder must be
 * the mission's own territory, the environment carries no internal secret but
 * keeps the git credential helper, and the output is masked.
 */
import '../../test-home.js';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { dbApi } = await import('../../db.js');
const { TIMON_HOME } = await import('../../paths.js');
const { runCommandRequest, runEnv, maskOutput, RUN_REFUSALS, restartsDaemon, fallbackRunFolder } = await import('./run-context.js');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'timon-run-ctx-')));
const projectDir = join(base, 'acme');
const otherDir = join(base, 'other-project');
mkdirSync(projectDir);
mkdirSync(otherDir);
dbApi.upsertProject('acme', { cwd: projectDir });
dbApi.upsertProject('other', { cwd: otherDir });
const worktree = join(TIMON_HOME, 'worktrees', 'task-acme');
mkdirSync(worktree, { recursive: true });
const otherWorktree = join(TIMON_HOME, 'worktrees', 'task-other');
mkdirSync(otherWorktree, { recursive: true });
dbApi.createTask('task-acme', 'acme work', 'acme.coder', { project: 'acme' });
dbApi.createTask('task-other', 'other work', 'other.coder', { project: 'other' });

function mission(id: string, opts: { taskId?: string; cwd?: string }) {
  dbApi.createMission(id, 'acme.coder', 'work');
  if (opts.taskId) dbApi.setMissionLineage(id, { taskId: opts.taskId });
  if (opts.cwd) dbApi.setMissionCwdOverride(id, opts.cwd);
  return dbApi.getMission(id)!;
}
const row = (project: string | null) => ({ command: 'git status', project } as never);
let ranIn: string | null = null;
const deps = {
  run: async (o: { cwd: string }) => {
    ranIn = o.cwd;
    return { exitCode: 0, timedOut: false, output: 'ok', truncated: false, durationMs: 1, failedToStart: false };
  },
  env: () => ({}),
};

test('the project folder, a task worktree of the project and a folder under them are allowed', async () => {
  const sub = join(projectDir, 'src');
  mkdirSync(sub);
  for (const [id, cwd, expected] of [['m1', projectDir, projectDir], ['m2', sub, sub]] as const) {
    ranIn = null;
    const r = await runCommandRequest(row('acme'), mission(id, { cwd }), deps);
    assert.equal(r.failedToStart, false, id);
    assert.equal(ranIn, expected);
  }
  ranIn = null;
  dbApi.setTaskWorktree('task-acme', worktree, 'timon/task/task-acme', 'main');
  const viaTask = await runCommandRequest(row('acme'), mission('m3', { taskId: 'task-acme', cwd: worktree }), deps);
  assert.equal(viaTask.failedToStart, false);
  assert.equal(ranIn, realpathSync(worktree));
});

test('another project, a worktree of another project, a link out and the root are refused', async () => {
  for (const [id, cwd] of [['m4', otherDir], ['m5', otherWorktree], ['m6', base], ['m7', '/']] as const) {
    ranIn = null;
    const r = await runCommandRequest(row('acme'), mission(id, { cwd }), deps);
    assert.equal(r.failedToStart, true, id);
    assert.equal(ranIn, null, `${id} never ran`);
    assert.match(r.output, new RegExp(RUN_REFUSALS.outside));
  }
  const link = join(projectDir, 'escape');
  try { symlinkSync(otherDir, link, 'dir'); } catch { return; }
  ranIn = null;
  const r = await runCommandRequest(row('acme'), mission('m8', { cwd: link }), deps);
  assert.equal(r.failedToStart, true);
  assert.equal(ranIn, null);
});

test('a folder that is gone, and a mission with no folder, are refused', async () => {
  const gone = await runCommandRequest(row('acme'), mission('m9', { cwd: join(projectDir, 'gone') }), deps);
  assert.match(gone.output, new RegExp(RUN_REFUSALS.missing));
  const none = await runCommandRequest(row('acme'), undefined, deps);
  assert.equal(none.failedToStart, true);
});

test('the environment keeps the daemon’s but drops TIMON_* secrets, and adds the git helper', () => {
  const env = runEnv({
    PATH: '/usr/bin', HOME: '/home/u', TIMON_API_TOKEN: 'secret-api-token-value', TIMON_DAEMON_TOKEN: 'secret-daemon', TIMON_HOME: '/h', NODE_ENV: 'production',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.TIMON_API_TOKEN, undefined);
  assert.equal(env.TIMON_DAEMON_TOKEN, undefined);
  assert.equal(env.NODE_ENV, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  if (env.GIT_CONFIG_COUNT) {
    assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
    assert.match(env.GIT_CONFIG_VALUE_0 ?? '', /git-credential$/);
  }
  const chained = runEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x' });
  if (chained.GIT_CONFIG_COUNT === '2') assert.equal(chained.GIT_CONFIG_KEY_1, 'credential.helper');
  assert.equal(chained.GIT_CONFIG_KEY_0, 'user.name', 'the user’s own entries stay');
});

test('an internal token the command printed is masked', () => {
  const text = maskOutput('api=secret-api-token-value ok', { TIMON_API_TOKEN: 'secret-api-token-value' });
  assert.equal(text, 'api=*** ok');
  assert.equal(maskOutput('nothing', {}), 'nothing');
});

test('a mission with no project and no folder runs in the fallback folder, never in the Timon home', async () => {
  const fb = fallbackRunFolder();
  assert.ok(fb, 'a usable home exists');
  assert.ok(!fb.startsWith(TIMON_HOME), 'not inside the Timon home');
  for (const project of [null, '_main']) {
    ranIn = null;
    dbApi.createMission(`nop-${project}`, 'ghost.agent', 'work');
    const r = await runCommandRequest({ command: 'ls', project } as never, dbApi.getMission(`nop-${project}`)!, deps);
    assert.equal(r.failedToStart, false, String(project));
    assert.equal(ranIn, realpathSync(fb));
  }
});

test('a project mission with no folder is still refused', async () => {
  dbApi.createMission('nop-acme', 'ghost.agent', 'work');
  dbApi.upsertProject('empty', { cwd: null } as never);
  ranIn = null;
  const r = await runCommandRequest(row('empty'), dbApi.getMission('nop-acme')!, deps);
  assert.equal(r.failedToStart, true);
  assert.equal(ranIn, null);
});

test('commands that restart or stop the daemon are refused on Allow and point to Paste', async () => {
  for (const command of [
    'systemctl --user restart timon', 'sudo systemctl stop timon', 'launchctl unload ~/Library/LaunchAgents/x.plist',
    'npm run build', 'docker compose up -d', 'timon restart', 'pkill -f timon',
  ]) {
    assert.equal(restartsDaemon(command), true, command);
    ranIn = null;
    const r = await runCommandRequest({ command, project: 'acme' } as never, mission(`r-${command.length}-${command.slice(0, 4)}`, { cwd: projectDir }), deps);
    assert.equal(r.failedToStart, true, command);
    assert.equal(ranIn, null, `${command} never ran`);
    assert.match(r.output, /Paste into a terminal/);
  }
  for (const command of ['git status', 'npm test', 'ls -la', 'systemctl status timon']) assert.equal(restartsDaemon(command), false, command);
});
