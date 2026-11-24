/**
 * TODO #110: a coder another agent spawned directly (no Kanban task) opened
 * the series planner — a Kanban planning card in front of an agent whose only
 * job was to code its brief. The planner belongs to the mission the user
 * pilots; a delegated mission or a task mission is refused before any card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeHomeOnExit } from '../tests/helpers/test-home.js';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-series-plan-test-'));
process.env.TIMON_HOME = TMP_HOME;
removeHomeOnExit(TMP_HOME);

const { requestPermission, seriesPlanRefusal, listPending } = await import('./permissions.js');
const { dbApi } = await import('./db.js');

const plan = { form: { kind: 'series_plan', chantier: 'Big feature', volets: [{ title: 'Front' }] } };
const ask = (mission_id: string, tool_use_id = 'tu-' + mission_id) =>
  ({ mission_id, agent: 'acme.coder', tool_name: 'ask_user', input: plan, tool_use_id });

test('a delegated mission is refused the planner, with no card', async () => {
  dbApi.createMission('parent', 'acme.main', 'pilot');
  dbApi.createMission('child', 'acme.coder', 'code the brief');
  dbApi.setMissionLineage('child', { parentMissionId: 'parent', parentAgent: 'acme.main' });
  const decision = await requestPermission(ask('child'));
  assert.equal(decision.behavior, 'deny');
  assert.match(decision.behavior === 'deny' ? decision.message : '', /delegated to you by acme\.main/);
  assert.ok(!listPending().some((p) => p.mission_id === 'child'));
});

test('the mission the user pilots still opens the planner', () => {
  dbApi.createMission('pilot', 'acme.main', 'big chantier');
  assert.equal(seriesPlanRefusal(ask('pilot')), null);
});

test('a plain ask_user in a delegated mission is not affected', () => {
  const questions = { questions: [{ question: 'Which?', header: 'h', options: [{ label: 'a' }, { label: 'b' }] }] };
  assert.equal(seriesPlanRefusal({ ...ask('child'), input: questions }), null);
});

/* TIM-0053: the platform owner's first name was written into text the agent relays to the user. */
test('the messages the agent relays never name the platform owner', async () => {
  dbApi.createMission('pilot-1', 'acme.main', 'big chantier');
  const pending = requestPermission(ask('pilot-1', 'tu-rom'));
  const id = listPending('pilot-1')[0]!.id;
  const { resolvePermission, buildContinuation } = await import('./permissions.js');
  resolvePermission(id, { behavior: 'allow', updatedInput: { plan: { mode: 'no-such-mode' } } });
  const invalid = await pending;
  assert.equal(invalid.behavior, 'deny');
  assert.match(invalid.behavior === 'deny' ? invalid.message : '', /The user did answer/);
  assert.doesNotMatch(invalid.behavior === 'deny' ? invalid.message : '', /\bRom\b/);

  const resumed = buildContinuation(
    { tool_name: 'ask_user', mission_id: 'pilot-1' } as never,
    { behavior: 'allow', updatedInput: { plan: { mode: 'sequential-here', roles: {} }, commands: [] } },
  );
  assert.match(resumed, /\[series plan\] The user chose mode/);
  assert.doesNotMatch(resumed, /\bRom\b/);
});

test('the fast-mode briefs given to a coder do not name the platform owner', async () => {
  const { pipelineDirective } = await import('./dispatcher.js');
  for (const pipeline of ['code-self', 'code-group']) {
    const text = pipelineDirective({ type: 'code', pipeline } as never);
    assert.match(text, /the user chose the fast mode/);
    assert.doesNotMatch(text, /\bRom\b/);
  }
});

/* TODO #433: settings per group of volets. The UI's answer is checked against
 * the groups of THE form the agent emitted, and comes back as `--group` commands. */
test('a group the form never showed is refused; a known one yields --group commands', async () => {
  dbApi.createMission('grp-pilot', 'acme.main', 'grouped chantier');
  const { resolvePermission, buildContinuation } = await import('./permissions.js');
  const form = { form: { kind: 'series_plan', chantier: 'Big feature', volets: [{ title: 'Front', group: 'easy' }, { title: 'Core', group: 'hard' }] } };
  const req = (tu: string) => ({ mission_id: 'grp-pilot', agent: 'acme.main', tool_name: 'ask_user', input: form, tool_use_id: tu });

  const unknown = requestPermission(req('tu-grp-1'));
  resolvePermission(listPending('grp-pilot')[0]!.id, { behavior: 'allow', updatedInput: { plan: { mode: 'kanban-full', roles: {}, groups: { ghost: { code: { model: 'haiku' } } } } } });
  const refused = await unknown;
  assert.equal(refused.behavior, 'deny');
  assert.match(refused.behavior === 'deny' ? refused.message : '', /unknown group: ghost/);

  const known = requestPermission(req('tu-grp-2'));
  const plan = { mode: 'kanban-full', roles: { code: { model: 'opus' } }, groups: { easy: { code: { model: 'haiku', fallbackBackend: 'codex' } } } };
  resolvePermission(listPending('grp-pilot')[0]!.id, { behavior: 'allow', updatedInput: { plan } });
  const accepted = await known;
  assert.equal(accepted.behavior, 'allow');
  const commands = accepted.behavior === 'allow' ? (accepted.updatedInput as { commands: string[] }).commands : [];
  assert.deepEqual(commands, [
    'timon series role set --scope code --model opus',
    'timon series fallback set --scope code --group easy --backend codex',
    'timon series role set --scope code --group easy --model haiku',
    "timon task create --type code --pipeline full --plan-group easy --title Front --description '<part brief>'",
    "timon task create --type code --pipeline full --plan-group hard --title Core --description '<part brief>'",
  ]);
  // The late-resume message tells the agent what each group runs on.
  const resumed = buildContinuation({ tool_name: 'ask_user', mission_id: 'grp-pilot' } as never, { behavior: 'allow', updatedInput: { plan, commands } });
  assert.match(resumed, /- code: \? \/ opus — fallback global TIMON fallback/);
  assert.match(resumed, /- group `easy`, code: \? \/ haiku — fallback codex/);
});

/* Kanban → pull request, step 8: the planner reads the project of the agent that opened it. */
test('a project that lands through pull requests: the plan gives the job branch and the pull request task', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { agentDir } = await import('./paths.js');
  const { updateProjectIntegration } = await import('./project-integration.js');
  const { resolvePermission, buildContinuation } = await import('./permissions.js');
  const { seriesPlanCommands } = await import('./series-plan.js');
  const repo = mkdtempSync(join(tmpdir(), 'timon-plan-pr-'));
  const mkAgent = (name: string, project: string) => {
    mkdirSync(agentDir(name), { recursive: true });
    writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd: repo, role: 'orchestrator', project }));
    writeFileSync(join(agentDir(name), 'system-prompt.md'), 'Test');
  };
  dbApi.upsertProject('plan-pr', { cwd: repo });
  updateProjectIntegration('plan-pr', { mode: 'pr', account: 'octocat' });
  dbApi.upsertProject('plan-local', { cwd: repo });
  mkAgent('plan-pr.main', 'plan-pr');
  mkAgent('plan-local.main', 'plan-local');
  // An earlier job of the repository already holds the plain name.
  dbApi.recordIntegration({ repo, branch: 'feat/big-feature', remote: 'origin', target: 'main', mode: 'pr', project: 'plan-pr' });

  const form = { form: { kind: 'series_plan', chantier: 'Big feature', volets: [{ title: 'Front' }] } };
  const answer = async (mission: string, agent: string, mode: string, extra: Record<string, unknown> = {}) => {
    dbApi.createMission(mission, agent, 'job');
    const pending = requestPermission({ mission_id: mission, agent, tool_name: 'ask_user', input: form, tool_use_id: `tu-${mission}` });
    resolvePermission(listPending(mission)[0]!.id, { behavior: 'allow', updatedInput: { plan: { mode, roles: {}, ...extra } } });
    const decision = await pending;
    assert.equal(decision.behavior, 'allow');
    return (decision.behavior === 'allow' ? decision.updatedInput : {}) as {
      commands: string[]; integration?: { mode: string; branch: string; base_ref: string; note: string };
    };
  };

  const pr = await answer('plan-pr-1', 'plan-pr.main', 'kanban-full', { resolves_issues: true });
  // "Resolves its issue entirely", read again by the pull request's Fixes lines.
  assert.equal(dbApi.seriesResolvesIssues('plan-pr-1'), true);
  assert.deepEqual(pr.integration && { mode: pr.integration.mode, branch: pr.integration.branch, base_ref: pr.integration.base_ref }, {
    mode: 'pr', branch: 'feat/big-feature-2', base_ref: 'origin/main',
  });
  assert.match(pr.integration!.note, /never from main/);
  assert.ok(pr.commands.slice(0, -1).every((c) => c.includes('--base feat/big-feature-2')));
  assert.match(pr.commands.at(-1)!, /--type merge --landing pr --base feat\/big-feature-2/);
  // An agent of the project: no `--project`, the commands of step 8 to the byte.
  assert.deepEqual(pr.commands, seriesPlanCommands(
    { mode: 'kanban-full', roles: {} }, [{ title: 'Front' }], { branch: 'feat/big-feature-2', chantier: 'Big feature' },
  ));
  assert.doesNotMatch(pr.integration!.note, /--project/);
  const resumed = buildContinuation({ tool_name: 'ask_user', mission_id: 'plan-pr-1' } as never, { behavior: 'allow', updatedInput: pr });
  assert.match(resumed, /Pull request: Project plan-pr lands through a pull request/);

  // A sequential job lands through the same pull request task: its pilot asks
  // for the branch first, codes in a worktree on it, and ends on that task.
  for (const [mission, mode] of [['plan-pr-2', 'sequential-here'], ['plan-pr-3', 'sequential-new-mission']] as const) {
    const seq = await answer(mission, 'plan-pr.main', mode);
    assert.equal(seq.integration?.branch, 'feat/big-feature-2', mode);
    assert.deepEqual(seq.commands, [
      'timon pr branch feat/big-feature-2',
      "timon task create --type merge --landing pr --base feat/big-feature-2 --title 'Pull request — Big feature' "
      + "--description '<what the pull request carries>'",
    ], mode);
    assert.match(seq.integration!.note, /coded in a mission/);
    assert.match(seq.integration!.note, /git push \. HEAD:refs\/heads\/feat\/big-feature-2/);
    assert.match(seq.integration!.note, /never on main/);
  }

  // Non-regression: a project without the setting gets the previous answer.
  const local = await answer('plan-local-1', 'plan-local.main', 'kanban-full', { resolves_issues: true });
  assert.equal(local.integration, undefined);
  assert.equal(dbApi.seriesResolvesIssues('plan-local-1'), false, 'no pull request, nothing to close');
  assert.deepEqual(local.commands, seriesPlanCommands({ mode: 'kanban-full', roles: {} }, [{ title: 'Front' }]));
  // A sequential job of a project that lands locally: the previous answer, no command.
  const localSeq = await answer('plan-local-2', 'plan-local.main', 'sequential-here');
  assert.equal(localSeq.integration, undefined);
  assert.deepEqual(localSeq.commands, []);
});

/* The planner's branch field: the agent proposes, the person may change it,
   the daemon checks both and fixes the name once the job has its branch. */
test('the branch field: proposal, typed name, refusal and lock', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { agentDir } = await import('./paths.js');
  const { updateProjectIntegration } = await import('./project-integration.js');
  const { resolvePermission } = await import('./permissions.js');
  const repo = mkdtempSync(join(tmpdir(), 'timon-plan-branch-'));
  mkdirSync(agentDir('branch-pr.main'), { recursive: true });
  writeFileSync(join(agentDir('branch-pr.main'), 'config.json'), JSON.stringify({ cwd: repo, role: 'orchestrator', project: 'branch-pr' }));
  writeFileSync(join(agentDir('branch-pr.main'), 'system-prompt.md'), 'Test');
  dbApi.upsertProject('branch-pr', { cwd: repo });
  updateProjectIntegration('branch-pr', { mode: 'pr', account: 'octocat' });

  const branchOf = (d: { behavior: string; updatedInput?: unknown }) =>
    (d.updatedInput as { integration?: { branch: string } } | undefined)?.integration?.branch;
  type Landing = { project: string; prefix: string; branch: string; base_ref: string; locked: boolean; refusal?: string };
  let opened = 0;
  const open = (mission: string, branch?: string) => {
    if (!dbApi.getMission(mission)) dbApi.createMission(mission, 'branch-pr.main', 'job');
    const form = { form: { kind: 'series_plan', chantier: 'Branch field', volets: [{ title: 'Front' }], ...(branch ? { branch } : {}) } };
    const pending = requestPermission({ mission_id: mission, agent: 'branch-pr.main', tool_name: 'ask_user', input: form, tool_use_id: `tu-${mission}-${++opened}` });
    const card = listPending(mission)[0]!;
    const landing = (card.input as { form: { landing?: Landing } }).form.landing;
    const answer = async (plan: Record<string, unknown>) => {
      resolvePermission(card.id, { behavior: 'allow', updatedInput: { plan: { mode: 'kanban-full', roles: {}, ...plan } } });
      return pending;
    };
    return { landing, answer };
  };

  // The agent's proposal is shown, prefixed, and reaches every command.
  const proposed = open('branch-1', 'planner-branch');
  assert.deepEqual(proposed.landing, {
    project: 'branch-pr', mode: 'pr', prefix: 'feat/', branch: 'feat/planner-branch', kind: 'new', finish: 'merge',
    target: 'main', base_ref: 'origin/main', locked: false, branches: [],
  });
  const kept = await proposed.answer({});
  assert.equal(kept.behavior, 'allow');
  const cmds = (kept.behavior === 'allow' ? kept.updatedInput : {}) as { commands: string[]; integration: { branch: string } };
  assert.equal(cmds.integration.branch, 'feat/planner-branch');
  assert.ok(cmds.commands.every((c) => c.includes('--base feat/planner-branch')));

  // A refused proposal opens the form with its reason under the field.
  const bad = open('branch-2', 'fix-bfd1c111de16');
  assert.match(bad.landing!.refusal!, /carries an id/);
  // A name typed in the form wins over the proposal; a refused one is a deny.
  const typed = await bad.answer({ branch: 'typed-topic' });
  assert.equal(typed.behavior, 'allow');
  assert.equal(branchOf(typed), 'feat/typed-topic');
  const denied = await open('branch-3').answer({ branch: 'timon/task/x' });
  assert.equal(denied.behavior, 'deny');
  assert.match(denied.behavior === 'deny' ? denied.message : '', /reserved for Timon/);

  // Once the series holds its integration branch, the field is locked on it:
  // no `-2` for the job's own branch, and another name is refused.
  dbApi.recordIntegration({ repo, branch: 'feat/locked-job', remote: 'origin', target: 'main', mode: 'pr', project: 'branch-pr', seriesId: 'branch-4' });
  const locked = open('branch-4', 'something-else');
  assert.equal(locked.landing!.branch, 'feat/locked-job');
  assert.equal(locked.landing!.locked, true);
  const renamed = await locked.answer({ branch: 'other' });
  assert.equal(renamed.behavior, 'deny');
  const again = open('branch-4');
  const same = await again.answer({ branch: 'feat/locked-job' });
  assert.equal(same.behavior, 'allow');
  assert.equal(branchOf(same), 'feat/locked-job');
});

test('a project without the setting gets no branch field', async () => {
  dbApi.createMission('nofield-1', 'acme.coder', 'job');
  const pending = requestPermission({ mission_id: 'nofield-1', agent: 'acme.coder', tool_name: 'ask_user', input: plan, tool_use_id: 'tu-nofield' });
  const card = listPending('nofield-1')[0]!;
  assert.equal((card.input as { form: { landing?: unknown } }).form.landing, undefined);
  const { resolvePermission } = await import('./permissions.js');
  resolvePermission(card.id, { behavior: 'deny', message: 'x' });
  await pending;
});

/* The planner reads the project of the job, not only the agent's: an agent
   outside any project, working in a registered project's folder, plans that
   project's job, and the tasks it creates name the project. */
test('an agent outside any project plans the job of the project whose folder it works in', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { agentDir } = await import('./paths.js');
  const { updateProjectIntegration } = await import('./project-integration.js');
  const { resolvePermission } = await import('./permissions.js');
  const { seriesPlanCommands } = await import('./series-plan.js');
  const mkAgent = (name: string, config: Record<string, unknown>) => {
    mkdirSync(agentDir(name), { recursive: true });
    writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ role: 'orchestrator', ...config }));
    writeFileSync(join(agentDir(name), 'system-prompt.md'), 'Test');
  };
  const prRepo = mkdtempSync(join(tmpdir(), 'timon-plan-loose-pr-'));
  const localRepo = mkdtempSync(join(tmpdir(), 'timon-plan-loose-local-'));
  dbApi.upsertProject('loose-pr', { cwd: prRepo });
  updateProjectIntegration('loose-pr', { mode: 'pr', account: 'octocat' });
  dbApi.upsertProject('loose-local', { cwd: localRepo });
  mkAgent('loose.pr', { cwd: join(prRepo, 'sub') });
  mkAgent('loose.local', { cwd: localRepo });
  mkAgent('elsewhere.main', { cwd: localRepo, project: 'loose-local' });

  const form = { form: { kind: 'series_plan', chantier: 'Loose job', volets: [{ title: 'Front' }] } };
  const open = (mission: string, agent: string) => {
    dbApi.createMission(mission, agent, 'job');
    const pending = requestPermission({ mission_id: mission, agent, tool_name: 'ask_user', input: form, tool_use_id: `tu-${mission}` });
    const card = listPending(mission)[0]!;
    const landing = (card.input as { form: { landing?: { project: string; branch: string } } }).form.landing;
    const answer = async () => {
      resolvePermission(card.id, { behavior: 'allow', updatedInput: { plan: { mode: 'kanban-full', roles: {} } } });
      const decision = await pending;
      assert.equal(decision.behavior, 'allow');
      return (decision.behavior === 'allow' ? decision.updatedInput : {}) as {
        commands: string[]; integration?: { branch: string; note: string };
      };
    };
    return { landing, answer };
  };

  // In a subfolder of the `pr` project: its branch, its pull request task, and
  // `--project` on every task so the setting reaches them.
  const loose = open('loose-1', 'loose.pr');
  assert.equal(loose.landing?.project, 'loose-pr');
  const pr = await loose.answer();
  assert.equal(pr.integration?.branch, 'feat/loose-job');
  assert.match(pr.integration!.note, /--project loose-pr/);
  assert.deepEqual(pr.commands, [
    "timon task create --type code --pipeline full --base feat/loose-job --project loose-pr --title Front --description '<part brief>'",
    "timon task create --type merge --landing pr --base feat/loose-job --project loose-pr --deps <IDS of the code tasks> "
      + "--title 'Pull request — Loose job' --description '<what the pull request carries>'",
  ]);

  // In the folder of a `local` project: the plan stays what it was.
  const local = await open('loose-2', 'loose.local').answer();
  assert.equal(local.integration, undefined);
  assert.deepEqual(local.commands, seriesPlanCommands({ mode: 'kanban-full', roles: {} }, [{ title: 'Front' }]));

  // The mission's job comes first: a series already started in the `pr`
  // project stays there, whatever project the agent belongs to.
  dbApi.createMission('loose-3', 'elsewhere.main', 'job');
  dbApi.createTask('loose-3-task', 'earlier part', 'elsewhere.main', { type: 'code', project: 'loose-pr', seriesId: 'loose-3', creatorMissionId: 'loose-3' });
  const pending = requestPermission({ mission_id: 'loose-3', agent: 'elsewhere.main', tool_name: 'ask_user', input: form, tool_use_id: 'tu-loose-3' });
  const card = listPending('loose-3')[0]!;
  assert.equal((card.input as { form: { landing?: { project: string } } }).form.landing?.project, 'loose-pr');
  resolvePermission(card.id, { behavior: 'allow', updatedInput: { plan: { mode: 'kanban-full', roles: {} } } });
  const followed = await pending;
  const commands = followed.behavior === 'allow' ? (followed.updatedInput as { commands: string[] }).commands : [];
  assert.ok(commands.length > 0 && commands.every((c) => c.includes('--project loose-pr')));
});
