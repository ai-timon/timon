import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-writable-'));
const HOME = process.env.TIMON_HOME;

const { TimonConfigSchema } = await import('../config/schema.js');
const { fenceWritableRoots, missionWritableProblem, setMissionWritableRootsSource } = await import('./mission-writable.js');

test('the Timon home holds executables only in the folders the daemon installs', () => {
  assert.equal(missionWritableProblem(join(HOME, 'plugins', 'p', 'bin', 'x')), null);
  assert.equal(missionWritableProblem(join(HOME, 'providers', 'acp-registry', 'agents', 'a', '1', 'x')), null);
  for (const zone of ['worktrees', 'tmp', 'backend-accounts', 'codex-runs', 'agents', 'workspace', 'a-folder-added-later']) {
    assert.ok(missionWritableProblem(join(HOME, zone, 'x')), zone);
  }
  assert.ok(missionWritableProblem('git'));
  assert.ok(missionWritableProblem(''));
  assert.equal(missionWritableProblem(join(tmpdir(), 'elsewhere', 'git')), null);
});

// POSIX paths written out: the arithmetic is the same on Windows.
test('the home folders the fence lets missions write are refused too', { skip: process.platform === 'win32' }, (t) => {
  const config = TimonConfigSchema.parse({
    host: {
      isolation: {
        writable: ['~/shared-bin'],
        exceptions: { agents: { a: { writable: ['/opt/agent-tools'] } }, projects: { p: { writable: ['~/proj-tools'] } } },
      },
    },
  });
  const roots = fenceWritableRoots(config, '/home/u');
  assert.deepEqual(roots, ['/home/u/shared-bin', '/opt/agent-tools', '/home/u/proj-tools']);
  setMissionWritableRootsSource(() => roots);
  t.after(() => setMissionWritableRootsSource(() => []));
  assert.ok(missionWritableProblem('/home/u/shared-bin/git', { platform: 'linux' }));
  assert.ok(missionWritableProblem('/opt/agent-tools/bin/git', { platform: 'linux' }));
  assert.equal(missionWritableProblem('/home/u/.local/bin/git', { platform: 'linux' }), null);
});

// Pure win32 arithmetic, whatever the system running the test.
test('win32: drive letters, case, another volume, and `~\\` are told apart', () => {
  const win = { platform: 'win32' as const, timonHome: 'C:\\Users\\user\\.timon', extraRoots: ['C:\\Users\\user\\shared-bin'] };
  assert.ok(missionWritableProblem('C:\\Users\\user\\.timon\\worktrees\\t\\git.exe', win));
  assert.ok(missionWritableProblem('c:\\users\\USER\\.TIMON\\Worktrees\\t\\git.exe', win), 'case-insensitive');
  assert.ok(missionWritableProblem('C:/Users/user/.timon/tmp/git.exe', win), 'forward slashes');
  assert.ok(missionWritableProblem('C:\\Users\\user\\.timon\\plugins\\..\\worktrees\\git.exe', win), 'no escape through `..`');
  assert.equal(missionWritableProblem('C:\\Users\\user\\.timon\\plugins\\p\\bin\\x.exe', win), null);
  assert.equal(missionWritableProblem('c:\\USERS\\user\\.timon\\PLUGINS\\p\\x.exe', win), null);
  assert.equal(missionWritableProblem('D:\\Users\\user\\.timon\\worktrees\\git.exe', win), null, 'another volume');
  assert.equal(missionWritableProblem('C:\\Users\\user\\.timon-old\\git.exe', win), null, 'a sibling sharing the prefix');
  assert.equal(missionWritableProblem('\\\\server\\share\\.timon\\worktrees\\git.exe', win), null);
  assert.ok(missionWritableProblem('c:\\users\\user\\SHARED-BIN\\git.exe', win), 'a fence write root, any case');
  assert.equal(missionWritableProblem('C:\\Program Files\\Git\\cmd\\git.exe', win), null);
  for (const relative of ['~\\bin\\git.exe', '~/bin/git.exe', 'C:git.exe', 'bin\\git.exe', '.', '']) {
    assert.ok(missionWritableProblem(relative, win), `relative: ${relative}`);
  }
});
