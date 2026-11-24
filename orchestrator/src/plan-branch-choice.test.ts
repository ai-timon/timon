/**
 * The Kanban planner's branch and destination, for any project: a new branch
 * or one the repository already has, merged into the target at the end or
 * kept on the branch. A project that merges locally gets the job's branch only
 * when the answer names its kind; without `branch`, every answer is the earlier
 * one to the byte.
 *
 * `npm test -- src/plan-branch-choice.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeHomeOnExit } from '../tests/helpers/test-home.js';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-plan-branch-choice-'));
process.env.TIMON_HOME = TMP_HOME;
removeHomeOnExit(TMP_HOME);

const { requestPermission, resolvePermission, listPending } = await import('./permissions.js');
const { dbApi } = await import('./db.js');
const { agentDir } = await import('./paths.js');
const { updateProjectIntegration } = await import('./project-integration.js');
const { seriesPlanCommands } = await import('./series-plan.js');

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** A repository on `main` with `feat/existing` and a task branch. */
function mkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'timon-plan-choice-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'branch', 'feat/existing');
  git(repo, 'branch', 'timon/task/abc');
  return repo;
}

let projects = 0;
function mkProject(opts: { pr?: boolean } = {}): { slug: string; agent: string; repo: string } {
  const repo = mkRepo();
  const slug = `choice-${++projects}`;
  const agent = `${slug}.main`;
  dbApi.upsertProject(slug, { cwd: repo });
  mkdirSync(agentDir(agent), { recursive: true });
  writeFileSync(join(agentDir(agent), 'config.json'), JSON.stringify({ cwd: repo, role: 'orchestrator', project: slug }));
  writeFileSync(join(agentDir(agent), 'system-prompt.md'), 'Test');
  if (opts.pr) updateProjectIntegration(slug, { mode: 'pr', account: 'octocat' });
  return { slug, agent, repo };
}

type FormLanding = {
  project: string; mode: string; prefix: string; branch: string; kind: string; finish: string;
  target: string; base_ref: string; locked: boolean; refusal?: string; branches: Array<{ name: string }>;
};
type Answered = {
  behavior: string;
  message?: string;
  commands?: string[];
  integration?: { mode: string; branch: string; base_ref: string; note: string; kind?: string; finish?: string; target?: string };
};

const VOLETS = [{ title: 'Front' }];
let cards = 0;
function open(mission: string, agent: string, branch?: string): {
  landing: FormLanding | undefined; answer: (plan: Record<string, unknown>) => Promise<Answered>;
} {
  if (!dbApi.getMission(mission)) dbApi.createMission(mission, agent, 'job');
  const input = { form: { kind: 'series_plan', chantier: 'Branch choice', volets: VOLETS, ...(branch ? { branch } : {}) } };
  const pending = requestPermission({ mission_id: mission, agent, tool_name: 'ask_user', input, tool_use_id: `tu-${mission}-${++cards}` });
  const card = listPending(mission).at(-1)!;
  const landing = (card.input as { form: { landing?: FormLanding } }).form.landing;
  const answer = async (plan: Record<string, unknown>): Promise<Answered> => {
    resolvePermission(card.id, { behavior: 'allow', updatedInput: { plan: { mode: 'kanban-full', roles: {}, ...plan } } });
    const decision = await pending;
    if (decision.behavior !== 'allow') return { behavior: decision.behavior, message: decision.message };
    return { behavior: 'allow', ...(decision.updatedInput as Omit<Answered, 'behavior'>) };
  };
  return { landing, answer };
}

test('the form shows the branch field for a project that merges locally, with the branches it may start from', () => {
  const p = mkProject();
  const { landing } = open('form-local', p.agent, 'planner-topic');
  assert.ok(landing);
  assert.equal(landing.mode, 'local');
  assert.equal(landing.branch, 'feat/planner-topic');
  assert.equal(landing.kind, 'new');
  assert.equal(landing.finish, 'merge');
  assert.equal(landing.target, 'main');
  assert.equal(landing.base_ref, 'main');
  assert.equal(landing.locked, false);
  // Local branches, Timon's own task branches left out.
  assert.deepEqual(landing.branches.map((b) => b.name).sort(), ['feat/existing', 'main']);
});

test('a project that merges locally, a new branch merged at the end', async () => {
  const p = mkProject();
  const out = await open('local-new', p.agent).answer({ branch: { kind: 'new', name: 'local-topic' }, finish: 'merge' });
  assert.equal(out.behavior, 'allow');
  assert.equal(out.integration?.mode, 'branch');
  assert.equal(out.integration?.branch, 'feat/local-topic');
  assert.equal(out.integration?.base_ref, 'refs/heads/main');
  assert.equal(out.integration?.finish, 'merge');
  assert.match(out.integration!.note, /merges locally into main/);
  assert.match(out.integration!.note, /cuts from main/);
  assert.deepEqual(out.commands, [
    "timon task create --type code --pipeline full --base feat/local-topic --title Front --description '<part brief>'",
    "timon task create --type merge --landing local --base feat/local-topic --deps <IDS of the code tasks> "
      + "--title 'Merge into main — Branch choice' --description '<what the job carries>'",
  ]);
  assert.deepEqual(dbApi.getSeriesPlanLanding('local-new'), {
    project: p.slug, repo: p.repo, branch: 'feat/local-topic', branch_kind: 'new', mode: 'branch',
    base_ref: 'refs/heads/main', finish: 'merge',
  });
});

test('a project that merges locally, an existing branch kept as the end', async () => {
  const p = mkProject();
  const out = await open('local-existing', p.agent).answer({ branch: { kind: 'existing', name: 'feat/existing' }, finish: 'keep' });
  assert.equal(out.behavior, 'allow');
  assert.equal(out.integration?.branch, 'feat/existing');
  assert.equal(out.integration?.kind, 'existing');
  assert.match(out.integration!.note, /existing branch `feat\/existing`/);
  assert.match(out.integration!.note, /stay partial until the branch lands/);
  // No last task: the work stays on the branch.
  assert.deepEqual(out.commands, [
    "timon task create --type code --pipeline full --base feat/existing --title Front --description '<part brief>'",
  ]);
  assert.equal(dbApi.getSeriesPlanLanding('local-existing')?.branch_kind, 'existing');
  assert.equal(dbApi.getSeriesPlanLanding('local-existing')?.finish, 'keep');
});

test('a project that lands through pull requests, an existing branch kept', async () => {
  const p = mkProject({ pr: true });
  // An earlier job cut it: an existing branch is taken as named, never numbered.
  dbApi.recordIntegration({ repo: p.repo, branch: 'feat/existing', remote: 'origin', target: 'main', mode: 'pr', project: p.slug, seriesId: 'earlier' });
  const out = await open('pr-existing', p.agent).answer({ branch: { kind: 'existing', name: 'feat/existing' }, finish: 'keep' });
  assert.equal(out.behavior, 'allow');
  assert.equal(out.integration?.mode, 'pr');
  assert.equal(out.integration?.branch, 'feat/existing');
  assert.match(out.integration!.note, /No pull request is opened and the branch is never pushed/);
  assert.deepEqual(out.commands, [
    "timon task create --type code --pipeline full --base feat/existing --title Front --description '<part brief>'",
  ]);
  assert.deepEqual(dbApi.getSeriesPlanLanding('pr-existing'), {
    project: p.slug, repo: p.repo, branch: 'feat/existing', branch_kind: 'existing', mode: 'pr',
    base_ref: 'origin/main', finish: 'keep',
  });
});

test('a project that lands through pull requests, a new branch merged: the earlier plan', async () => {
  const p = mkProject({ pr: true });
  const named = await open('pr-new', p.agent).answer({ branch: { kind: 'new', name: 'pr-topic' }, finish: 'merge' });
  const legacy = await open('pr-legacy', p.agent).answer({ branch: 'pr-topic' });
  assert.equal(named.behavior, 'allow');
  assert.deepEqual(named.commands, legacy.commands);
  assert.deepEqual(named.commands, seriesPlanCommands({ mode: 'kanban-full', roles: {} }, VOLETS, { branch: 'feat/pr-topic', chantier: 'Branch choice' }));
  assert.equal(named.integration?.note, legacy.integration?.note);
  // A new branch skips a name the repository already has.
  const taken = await open('pr-new-taken', p.agent).answer({ branch: { kind: 'new', name: 'existing' } });
  assert.equal(taken.integration?.branch, 'feat/existing-2');
  // The earlier bare name records nothing: the dispatcher keeps its earlier path.
  assert.equal(dbApi.getSeriesPlanLanding('pr-legacy'), undefined);
});

test('without a branch, every answer is the earlier one', async () => {
  const local = mkProject();
  const out = await open('none-local', local.agent).answer({});
  assert.equal(out.integration, undefined);
  assert.deepEqual(out.commands, seriesPlanCommands({ mode: 'kanban-full', roles: {} }, VOLETS));
  assert.equal(dbApi.getSeriesPlanLanding('none-local'), undefined);
  // The earlier bare name was never read by a project that merges locally.
  const bare = await open('bare-local', local.agent).answer({ branch: 'feat/whatever' });
  assert.equal(bare.integration, undefined);
  assert.deepEqual(bare.commands, out.commands);
  const seq = await open('none-local-seq', local.agent).answer({ mode: 'sequential-here' });
  assert.deepEqual(seq.commands, []);
});

test('refusals: a missing branch, the target, a task branch, a name with an id', async () => {
  const p = mkProject();
  const pr = mkProject({ pr: true });
  const refused = async (mission: string, agent: string, branch: Record<string, unknown>, why: RegExp) => {
    const out = await open(mission, agent).answer({ branch });
    assert.equal(out.behavior, 'deny', mission);
    assert.match(out.message ?? '', why, mission);
    assert.equal(dbApi.getSeriesPlanLanding(mission), undefined, mission);
  };
  await refused('no-such', p.agent, { kind: 'existing', name: 'feat/missing' }, /feat\/missing does not exist in the repository/);
  await refused('target-local', p.agent, { kind: 'existing', name: 'main' }, /the job merges into main: it needs a branch of its own/);
  await refused('target-pr', pr.agent, { kind: 'existing', name: 'main' }, /the pull request targets main/);
  await refused('task-branch', p.agent, { kind: 'existing', name: 'timon/task/abc' }, /reserved for Timon/);
  await refused('with-id', p.agent, { kind: 'new', name: 'fix-bfd1c111de16' }, /carries an id/);
  // A branch whose job already landed is not a place to start from.
  dbApi.recordIntegration({ repo: p.repo, branch: 'feat/existing', remote: '', target: 'main', mode: 'branch', project: p.slug });
  dbApi.markIntegrationMerged(dbApi.getIntegration(p.repo, 'feat/existing')!.id, null);
  await refused('landed', p.agent, { kind: 'existing', name: 'feat/existing' }, /already landed in main/);
});

test('a plan opened again once a task started on the branch keeps it', async () => {
  const p = mkProject();
  const first = await open('reopen', p.agent).answer({ branch: { kind: 'existing', name: 'feat/existing' }, finish: 'keep' });
  assert.equal(first.behavior, 'allow');
  // Before any task started, the plan may still change.
  const before = open('reopen', p.agent);
  assert.equal(before.landing?.locked, false);
  await before.answer({ branch: { kind: 'existing', name: 'feat/existing' }, finish: 'keep' });
  // A task of the series started there: the branch, its kind and its finish are fixed.
  dbApi.createTask('reopen-task', 'Front', p.agent, { type: 'code', project: p.slug, seriesId: 'reopen', creatorMissionId: 'reopen', baseBranch: 'feat/existing' });
  dbApi.setTaskIntegration('reopen-task', 'branch', 'refs/heads/main');
  const again = open('reopen', p.agent, 'something-else');
  assert.equal(again.landing?.locked, true);
  assert.equal(again.landing?.branch, 'feat/existing');
  assert.equal(again.landing?.kind, 'existing');
  assert.equal(again.landing?.finish, 'keep');
  const renamed = await again.answer({ branch: { kind: 'new', name: 'other' } });
  assert.equal(renamed.behavior, 'deny');
  assert.match(renamed.message ?? '', /already starts from feat\/existing/);
  const same = await open('reopen', p.agent).answer({ branch: { kind: 'existing', name: 'feat/existing' }, finish: 'keep' });
  assert.equal(same.behavior, 'allow');
  assert.equal(same.integration?.branch, 'feat/existing');
});
