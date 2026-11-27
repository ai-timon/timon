import './test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { dbApi } from './db.js';
import { agentConfig, agentDir } from './paths.js';
import { pushTicketBranch } from './ticket-branch-push-service.js';
import type { ExecResult } from './host/types.js';

const SLUG = `tbp-${randomUUID().slice(0, 8)}`;
const OTHER = `tbp-${randomUUID().slice(0, 8)}`;
dbApi.upsertProject(SLUG, { cwd: '/tmp/ticket-push-repo' });
dbApi.upsertProject(OTHER, { cwd: '/tmp/ticket-push-other' });
dbApi.upsertProject(SLUG, { speech: 'Tracker: ClickUp, ticket prefixes `SELP-`, `IT-`.' });

function agent(name: string, role: string, project: string): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(agentConfig(name), JSON.stringify({ role, project, cwd: '/tmp/ticket-push-repo' }));
}
agent(`${SLUG}.merge`, 'merger', SLUG);
agent(`${SLUG}.coder`, 'coder', SLUG);
agent(`${OTHER}.merge`, 'merger', OTHER);
// A name that says "merge" does not make a merger: only the role does.
agent(`${SLUG}.merger-by-name`, 'coder', SLUG);

function mergeTask(agentName: string, project: string): { task: string; mission: string } {
  const task = randomUUID();
  const mission = randomUUID();
  dbApi.createTask(task, 'merge it', agentName, { type: 'merge', project });
  dbApi.createMission(mission, agentName, 'merge');
  dbApi.assignTaskMission(task, mission);
  return { task, mission };
}

function recorder(refExists = true) {
  const calls: string[][] = [];
  const audits: string[] = [];
  return {
    calls, audits,
    deps: {
      git: async (args: string[]): Promise<ExecResult> => {
        calls.push(args);
        return { code: args.includes('rev-parse') && !refExists ? 1 : 0, stdout: '', stderr: '' };
      },
      audit: (action: string, target: string) => { audits.push(`${action} ${target}`); },
    },
  };
}

test('a merger pushes a ticket branch of its project, and the push is audited', async () => {
  const m = mergeTask(`${SLUG}.merge`, SLUG);
  const r = recorder();
  const out = await pushTicketBranch({ missionId: m.mission, taskId: m.task, branch: 'SELP-13105_remove-composer-dev' }, r.deps);
  assert.equal(out.ok, true);
  const push = r.calls.find((c) => c.includes('push'))!;
  assert.deepEqual(push, ['-C', '/tmp/ticket-push-repo', 'push', 'origin', `timon/task/${m.task}:refs/heads/SELP-13105_remove-composer-dev`]);
  assert.equal(r.audits.length, 1);
  assert.match(r.audits[0]!, /task\.push_branch .*SELP-13105_remove-composer-dev/);
});

test('a destination outside the project prefixes is refused and nothing runs', async () => {
  const m = mergeTask(`${SLUG}.merge`, SLUG);
  const r = recorder();
  for (const branch of ['ABC-1_x', 'develop', 'main', 'SELP-1_a/../b']) {
    const out = await pushTicketBranch({ missionId: m.mission, taskId: m.task, branch }, r.deps);
    assert.equal(out.ok, false, branch);
  }
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.audits, []);
});

test('a non-merger does not get the push, even with a merger-like name', async () => {
  for (const name of [`${SLUG}.coder`, `${SLUG}.merger-by-name`]) {
    const m = mergeTask(name, SLUG);
    const r = recorder();
    const out = await pushTicketBranch({ missionId: m.mission, taskId: m.task, branch: 'SELP-1_a' }, r.deps);
    assert.ok(!out.ok && out.code === 'push_not_merger', name);
    assert.deepEqual(r.calls, []);
  }
});

test('a merger of another project cannot push a task branch of this one', async () => {
  const mine = mergeTask(`${SLUG}.merge`, SLUG);
  const theirs = mergeTask(`${OTHER}.merge`, OTHER);
  const r = recorder();
  const out = await pushTicketBranch({
    missionId: theirs.mission, taskId: theirs.task, branch: 'SELP-1_a', sourceTask: mine.task,
  }, r.deps);
  assert.ok(!out.ok && out.code === 'push_not_covered');
  assert.deepEqual(r.calls, []);
});

test('a merger cannot push on behalf of a merge task it does not run', async () => {
  const a = mergeTask(`${SLUG}.merge`, SLUG);
  const b = mergeTask(`${SLUG}.merge`, SLUG);
  const r = recorder();
  const out = await pushTicketBranch({ missionId: a.mission, taskId: b.task, branch: 'SELP-1_a' }, r.deps);
  assert.ok(!out.ok && out.code === 'push_wrong_task');
  assert.deepEqual(r.calls, []);
});

test('a missing source branch is reported before any push', async () => {
  const m = mergeTask(`${SLUG}.merge`, SLUG);
  const r = recorder(false);
  const out = await pushTicketBranch({ missionId: m.mission, taskId: m.task, branch: 'SELP-1_a' }, r.deps);
  assert.ok(!out.ok && out.code === 'push_source_missing');
  assert.equal(r.calls.some((c) => c.includes('push')), false);
});

test('a remote that rejects the push is reported as rejected, with no secret echoed', async () => {
  const m = mergeTask(`${SLUG}.merge`, SLUG);
  const out = await pushTicketBranch({ missionId: m.mission, taskId: m.task, branch: 'SELP-1_a' }, {
    git: async (args) => (args.includes('push')
      ? { code: 1, stdout: '', stderr: '! [rejected] a -> b (non-fast-forward) https://user:pw@host/x' }
      : { code: 0, stdout: '', stderr: '' }),
  });
  assert.ok(!out.ok && out.code === 'push_rejected');
  assert.equal(out.reason.includes('pw@'), false);
});
