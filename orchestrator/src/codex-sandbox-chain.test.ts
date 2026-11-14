/**
 * TIM-0121: the whole road from a task's permission mode to the sandbox a codex
 * mission runs in, link by link.
 *
 *   task.permission_mode_override > RoleSpec.permission_mode   (resolveRoleSpec)
 *     → missions.permission_mode_override, else the agent's   (missionPermissionState, spawnTurn)
 *     → `--sandbox <level>`                                    (sandboxLevelForPermissionMode)
 *     → `<CODEX_HOME>/config.toml`: [windows] + [sandbox_workspace_write]
 *
 * The series carries no permission mode: `series_roles` picks a backend and a
 * model, never a level. The tester read "read-only forced" from a Windows
 * sandbox that refused every command; these tests pin that Timon itself only
 * hands codex `read-only` for `plan`.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dbApi } from './db.js';
import { writeRoles } from './projects.js';
import { resolveRoleSpec } from './dispatcher.js';
import { missionPermissionState } from './mission-permission-mode.js';
import type { OverrideAuthority } from './users/privileged-overrides.js';
import { agentDir } from './paths.js';
import { gitWritableRoots } from './backends/provider-git.js';

const AUTH_DIR = mkdtempSync(join(tmpdir(), 'timon-codex-chain-auth-'));
writeFileSync(join(AUTH_DIR, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.env.CODEX_AUTH_DIR = AUTH_DIR;
process.on('exit', () => rmSync(AUTH_DIR, { recursive: true, force: true }));

const { workspaceWriteRoots } = await import('../official-providers/provider-codex/lib/codex.js');
const { mountOfficialProviders, buildUnderSeal } = await import('../tests/helpers/official-providers.js');
await mountOfficialProviders();
type AgentConfig = import('./agent.js').AgentConfig;

const PROJECT = 'sandboxchain';
const CODER = 'sandboxchain.coder';
mkdirSync(agentDir(CODER), { recursive: true });
writeFileSync(join(agentDir(CODER), 'config.json'), JSON.stringify({
  role: 'coder', project: PROJECT, backend: 'codex', permission_mode: 'bypassPermissions',
}));
writeFileSync(join(agentDir(CODER), 'system-prompt.md'), 'coder');

function codeTask(opts: { permission?: string; seriesId?: string } = {}) {
  const id = randomUUID();
  dbApi.createTask(id, 'code witness', CODER, {
    type: 'code', project: PROJECT, seriesId: opts.seriesId ?? null,
    permissionModeOverride: opts.permission ?? null,
  });
  return dbApi.getTask(id)!;
}

test('the task override beats the role, the role beats the agent, the series has no say', () => {
  writeRoles(PROJECT, { code: { agent: CODER, permission_mode: 'plan' } });
  assert.equal(resolveRoleSpec(codeTask({ permission: 'acceptEdits' })).permissionMode, 'acceptEdits');
  assert.equal(resolveRoleSpec(codeTask()).permissionMode, 'plan');

  const seriesId = randomUUID();
  dbApi.setSeriesRole(seriesId, 'code', 'codex', null);
  assert.equal(resolveRoleSpec(codeTask({ seriesId })).permissionMode, 'plan', 'a series role moves the backend, not the level');

  // No level on the task nor the role: nothing is written on the mission, and
  // the agent's own mode applies at spawn.
  writeRoles(PROJECT, { code: { agent: CODER } });
  assert.equal(resolveRoleSpec(codeTask()).permissionMode, null);
});

test('the mission reads its own level first, the agent\'s otherwise', () => {
  const authority: OverrideAuthority = { relaxed: true, ceiling: null };
  const bare = randomUUID();
  dbApi.createMission(bare, CODER, 'witness', { channel: 'dispatcher' });
  assert.deepEqual(
    { mode: missionPermissionState(bare, authority)?.mode, source: missionPermissionState(bare, authority)?.source },
    { mode: 'bypassPermissions', source: 'agent' },
  );
  const pinned = randomUUID();
  dbApi.createMission(pinned, CODER, 'witness', { channel: 'dispatcher' });
  dbApi.setMissionPermissionModeOverride(pinned, 'plan');
  assert.deepEqual(
    { mode: missionPermissionState(pinned, authority)?.mode, source: missionPermissionState(pinned, authority)?.source },
    { mode: 'plan', source: 'mission' },
  );
});

test('the selector shows the level codex really runs in, not the label it was given', () => {
  const authority: OverrideAuthority = { relaxed: true, ceiling: null };
  for (const label of ['default', 'acceptEdits', 'workspace-write']) {
    const id = randomUUID();
    dbApi.createMission(id, CODER, 'witness', { channel: 'dispatcher' });
    dbApi.setMissionPermissionModeOverride(id, label);
    const state = missionPermissionState(id, authority);
    assert.equal(state?.mode, 'auto', `${label} runs in the workspace-write sandbox`);
    assert.ok(state?.choices.includes(state.mode), `${label}: the menu can tick the level shown`);
  }
  const edits = randomUUID();
  dbApi.createMission(edits, CODER, 'witness', { channel: 'dispatcher' });
  dbApi.setMissionPermissionModeOverride(edits, 'acceptEdits');
  assert.equal(missionPermissionState(edits, authority)?.configured, 'acceptEdits', 'the written label stays readable');
});

test('only plan reaches codex as read-only; acceptEdits and auto write, bypassPermissions lifts the sandbox', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'timon-codex-chain-cwd-')));
  try {
    const expected: Record<string, string> = {
      plan: 'read-only',
      default: 'workspace-write',
      acceptEdits: 'workspace-write',
      auto: 'workspace-write',
      bypassPermissions: 'danger-full-access',
    };
    for (const [permission_mode, level] of Object.entries(expected)) {
      const cfg: AgentConfig = { cwd, model: 'gpt-5.5', permission_mode };
      const sp = await buildUnderSeal('codex', {
        agentName: CODER, systemPrompt: 'sp', message: 'm', resumeSession: null, cfg,
        missionId: `mission-chain-${permission_mode}`,
      });
      assert.equal(sp.args[sp.args.indexOf('--sandbox') + 1], level, permission_mode);
      assert.equal(sp.args.filter((a) => a === '--sandbox').length, 1);
      const toml = readFileSync(join(sp.env!.CODEX_HOME!, 'config.toml'), 'utf8');
      assert.match(toml, /^\[sandbox_workspace_write\]\nnetwork_access = true$/m);
      assert.equal(/^\[windows\]\nsandbox = "unelevated"$/m.test(toml), process.platform === 'win32');
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test('a task worktree opens git roots nested under codex\'s .git carve-outs: kept off Windows, dropped on it', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'timon-codex-chain-wt-')));
  try {
    const repo = join(base, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '.');
    git(repo, 'config', 'user.email', 'test@timon.local');
    git(repo, 'config', 'user.name', 'timon-test');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-qm', 'init');
    const worktree = join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'timon/task/witness');

    const roots = gitWritableRoots(worktree);
    // Every root sits under a folder codex protects read-only: `<repo>/.git`
    // under the main working tree, the worktree's gitdir under `<repo>/.git`.
    assert.deepEqual([...roots].sort(), [repo, join(repo, '.git'), join(repo, '.git', 'worktrees', 'wt')].sort());
    assert.deepEqual(workspaceWriteRoots(roots, 'linux'), roots);
    assert.deepEqual(workspaceWriteRoots(roots, 'darwin'), roots);
    assert.deepEqual(workspaceWriteRoots(roots, 'win32'), []);

    const sp = await buildUnderSeal('codex', {
      agentName: CODER, systemPrompt: 'sp', message: 'm', resumeSession: null,
      cfg: { cwd: worktree, model: 'gpt-5.5', permission_mode: 'auto' }, missionId: 'mission-chain-worktree',
    });
    const toml = readFileSync(join(sp.env!.CODEX_HOME!, 'config.toml'), 'utf8');
    if (process.platform === 'win32') {
      assert.doesNotMatch(toml, /writable_roots/);
    } else {
      for (const root of roots) assert.ok(toml.includes(JSON.stringify(root)), `${root} missing from writable_roots`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
