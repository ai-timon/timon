/**
 * Tests of the "series plan" contract (series-plan.ts).
 *
 * `node --test --import tsx src/series-plan.test.ts`. Only the mapping tables
 * and the validators are exercised: no agent, no task.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// french-ok-file: accented part titles and group names the commands must quote

// `series-plan.ts` reads the authoritative list of pipelines and task types
// in `db.ts`, which opens SQLite on import. TIMON_HOME must therefore point to a
// throwaway folder BEFORE the dynamic import, otherwise the suite would write into the
// production database.
process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-series-plan-test-'));
const {
  validateSeriesPlanForm,
  validateSeriesPlanAnswer,
  seriesPlanCommands,
  planBranchChoice,
  fallbackScopeForRole,
  seriesPlanPipelineDrift,
  planGroupNames,
  ROLES_BY_MODE,
  SERIES_PLAN_MODES,
  MAX_GROUPS,
} = await import('./series-plan.js');
type SeriesPlanAnswer = import('./series-plan.js').SeriesPlanAnswer;

const form = { kind: 'series_plan', chantier: 'Refonte du formulaire', volets: [{ title: 'front' }] };

test('a valid form is accepted', () => {
  assert.equal(validateSeriesPlanForm(form), null);
});

test('form: named defaults', () => {
  assert.match(String(validateSeriesPlanForm({ ...form, kind: 'autre' })), /kind/);
  assert.match(String(validateSeriesPlanForm({ ...form, chantier: '  ' })), /chantier/);
  assert.match(String(validateSeriesPlanForm({ ...form, volets: [] })), /empty/);
  assert.match(String(validateSeriesPlanForm({ ...form, volets: [{}] })), /title/);
  const trop = { ...form, volets: Array.from({ length: 13 }, (_, i) => ({ title: `v${i}` })) };
  assert.match(String(validateSeriesPlanForm(trop)), /maximum 12/);
});

test('answer: a role outside the mode is refused', () => {
  // A reviewer set on a pipeline without review = a dead setting, never
  // applied. Refusing it is better than letting one believe it counts.
  const answer = { mode: 'kanban-code-self', roles: { review: { fallbackBackend: 'codex' } } };
  assert.match(String(validateSeriesPlanAnswer(answer)), /is outside mode/);
});

test('answer: a half-filled fallback is refused', () => {
  const answer = { mode: 'kanban-full', roles: { code: { fallbackModel: 'gpt-5.6-sol' } } };
  assert.match(String(validateSeriesPlanAnswer(answer)), /fallbackBackend/);
  assert.match(String(validateSeriesPlanAnswer({ mode: 'kanban-full', roles: {}, resolves_issues: 'yes' })), /resolves_issues/);
  assert.equal(validateSeriesPlanAnswer({ mode: 'kanban-full', roles: {}, resolves_issues: false }), null);
});

test('answer: an unknown mode is refused', () => {
  assert.match(String(validateSeriesPlanAnswer({ mode: 'kanban-turbo', roles: {} })), /unknown mode/);
});

test('minimal answer accepted (everything inherits)', () => {
  assert.equal(validateSeriesPlanAnswer({ mode: 'sequential-here', roles: {} }), null);
});

test('the new mission sets its fallback on the orchestrator scope', () => {
  assert.equal(fallbackScopeForRole('mission'), 'orchestrator');
  assert.equal(fallbackScopeForRole('orchestrator'), 'orchestrator');
  assert.equal(fallbackScopeForRole('code'), 'code');
  assert.equal(fallbackScopeForRole('doc'), 'doc');
});

test('commands: fallbacks then tasks, one per part', () => {
  const answer: SeriesPlanAnswer = {
    mode: 'kanban-full',
    roles: {
      orchestrator: { fallbackBackend: 'codex', fallbackModel: 'gpt-5.6-sol' },
      code: { backend: 'claude', model: 'opus', fallbackBackend: 'codex', fallbackModel: 'gpt-5.6-sol' },
    },
  };
  const cmds = seriesPlanCommands(answer, [{ title: 'front' }, { title: 'back' }]);
  assert.equal(cmds[0], 'timon series fallback set --scope orchestrator --backend codex --model gpt-5.6-sol');
  assert.equal(cmds[1], 'timon series fallback set --scope code --backend codex --model gpt-5.6-sol');
  const tasks = cmds.filter((c) => c.includes('task create'));
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((c) => c.includes('--pipeline full')));
  // The coder's pick is a series role now: it also reaches the code iterations.
  assert.ok(tasks.every((c) => !c.includes('--model') && !c.includes('--backend')));
  assert.ok(cmds.includes('timon series role set --scope code --backend claude --model opus'));
  assert.ok(cmds.indexOf('timon series role set --scope code --backend claude --model opus') < cmds.indexOf(tasks[0]!));
});

test('commands: the review/merge/doc choices are series overrides set before the tasks', () => {
  const rolesFile = join(process.env.TIMON_HOME!, 'projects', 'acme', 'roles.json');
  mkdirSync(join(process.env.TIMON_HOME!, 'projects', 'acme'), { recursive: true });
  const rolesBefore = JSON.stringify({ review: { agent: 'acme.reviewer', backend: 'claude', model: 'sonnet' } });
  writeFileSync(rolesFile, rolesBefore);
  const answer: SeriesPlanAnswer = {
    mode: 'kanban-full',
    roles: {
      orchestrator: { backend: 'claude', model: 'opus' },
      review: { backend: 'codex', model: 'gpt-5.6-sol' },
      merge: { model: 'sonnet' },
      doc: { backend: 'claude', model: 'haiku', fallbackBackend: 'codex' },
    },
  };
  const cmds = seriesPlanCommands(answer, [{ title: 'front' }]);
  const firstTask = cmds.findIndex((c) => c.includes('task create'));
  const roles = cmds.filter((c) => c.startsWith('timon series role set'));
  assert.deepEqual(roles, [
    'timon series role set --scope review --backend codex --model gpt-5.6-sol',
    'timon series role set --scope merge --model sonnet',
    'timon series role set --scope doc --backend claude --model haiku',
  ]);
  assert.ok(roles.every((c) => cmds.indexOf(c) < firstTask));
  // The pilot is a mission, not a task type: nothing to set at series level.
  assert.ok(!cmds.some((c) => c.includes('--scope orchestrator') && c.includes('series role')));
  // Nothing in the plan writes project roles.
  assert.ok(!cmds.some((c) => c.includes('project set-role')));
  assert.equal(readFileSync(rolesFile, 'utf8'), rolesBefore);
});

test('commands: only a set role produces a series override', () => {
  const cmds = seriesPlanCommands({ mode: 'kanban-code-self', roles: { code: { model: 'opus' } } }, [{ title: 'a' }]);
  assert.deepEqual(cmds.filter((c) => c.includes('series role')), ['timon series role set --scope code --model opus']);
});

test('commands: the grouped merge adds its consolidation task', () => {
  const cmds = seriesPlanCommands({ mode: 'kanban-code-group', roles: {} }, [{ title: 'a' }]);
  assert.equal(cmds.filter((c) => c.includes('--type merge')).length, 1);
  assert.ok(cmds.every((c) => c.includes('--group-id')));
});

test('commands, pull request: every task on the job branch, then the task that opens the pull request', () => {
  const landing = { branch: 'feat/big-feature', chantier: 'Big feature' };
  const full = seriesPlanCommands({ mode: 'kanban-full', roles: {} }, [{ title: 'front' }, { title: 'back' }], landing);
  assert.deepEqual(full, [
    "timon task create --type code --pipeline full --base feat/big-feature --title front --description '<part brief>'",
    "timon task create --type code --pipeline full --base feat/big-feature --title back --description '<part brief>'",
    'timon task create --type merge --landing pr --base feat/big-feature --deps <IDS of the code tasks> '
      + "--title 'Pull request — Big feature' --description '<what the pull request carries>'",
  ]);
  const self = seriesPlanCommands({ mode: 'kanban-code-self', roles: {} }, [{ title: 'a' }], landing);
  assert.match(self.at(-1)!, /--landing pr --base feat\/big-feature --deps <IDS of the code tasks>/);

  // The grouped merge stays the job's own merge; the pull request waits for it.
  const grouped = seriesPlanCommands({ mode: 'kanban-code-group', roles: {} }, [{ title: 'a' }], landing);
  assert.equal(grouped.length, 3);
  assert.match(grouped[1]!, /^timon task create --type merge --group-id <GROUP> --base feat\/big-feature --deps <IDS of the code tasks>/);
  assert.match(grouped[2]!, /^timon task create --type merge --landing pr --group-id <GROUP> --base feat\/big-feature --deps <ID of the grouped merge>/);
  assert.ok(grouped.every((c) => c.includes('--base feat/big-feature')));

  // A sequential job: the branch first, then only the pull request task, with no deps.
  for (const mode of ['sequential-here', 'sequential-new-mission'] as const) {
    assert.deepEqual(seriesPlanCommands({ mode, roles: {} }, [{ title: 'a' }], landing), [
      'timon pr branch feat/big-feature',
      "timon task create --type merge --landing pr --base feat/big-feature --title 'Pull request — Big feature' "
      + "--description '<what the pull request carries>'",
    ], mode);
  }
  // The model choices still come before it.
  const withRoles = seriesPlanCommands(
    { mode: 'sequential-new-mission', roles: { mission: { fallbackBackend: 'codex' } } }, [], landing,
  );
  assert.deepEqual(withRoles.map((c) => c.split(' ').slice(0, 3).join(' ')), [
    'timon series fallback', 'timon pr branch', 'timon task create',
  ]);
});

test('a landing for another project than the agent\'s names it on every task', () => {
  const landing = { branch: 'feat/big-feature', chantier: 'Big feature', taskProject: 'acme' };
  const grouped = seriesPlanCommands({ mode: 'kanban-code-group', roles: {} }, [{ title: 'a' }], landing);
  assert.equal(grouped.length, 3);
  assert.ok(grouped.every((c) => c.includes(' --base feat/big-feature --project acme ')));
  const seq = seriesPlanCommands({ mode: 'sequential-here', roles: {} }, [], landing);
  assert.deepEqual(seq.map((c) => c.includes('--project acme')), [false, true], 'the daemon reads the project from the series');
  const same = seriesPlanCommands({ mode: 'kanban-full', roles: {} }, [{ title: 'a' }], { ...landing, taskProject: null });
  assert.ok(same.every((c) => !c.includes('--project')));
});

test('non-regression: without a landing the commands are byte for byte the previous ones', () => {
  for (const mode of SERIES_PLAN_MODES) {
    const before = seriesPlanCommands({ mode, roles: {} }, [{ title: 'a' }]);
    assert.deepEqual(seriesPlanCommands({ mode, roles: {} }, [{ title: 'a' }], null), before);
    assert.ok(before.every((c) => !c.includes('--base') && !c.includes('--landing')), mode);
  }
});

test('commands: a sequential mode creates no task', () => {
  assert.deepEqual(seriesPlanCommands({ mode: 'sequential-here', roles: {} }, [{ title: 'a' }]), []);
});

test('a part title with a quote does not break the command', () => {
  const cmds = seriesPlanCommands({ mode: 'kanban-full', roles: {} }, [{ title: "l'index" }]);
  assert.ok(cmds[0].includes(`'l'\\''index'`));
});

test('each mode declares its roles and an existing pipeline', () => {
  for (const mode of SERIES_PLAN_MODES) {
    assert.ok(ROLES_BY_MODE[mode].length > 0, `mode ${mode} without a role`);
  }
  assert.equal(seriesPlanPipelineDrift(), null);
});

/* ── Groups of parts (TODO #433) ──────────────────────────────────────────
 * A part can carry a `group`; the answer then sets the models PER
 * GROUP, the global per-role settings staying the default.
 * ───────────────────────────────────────────────────────────────────────── */

const grouped = [
  { title: 'typo', group: 'simple' },
  { title: 'libellés', group: 'simple' },
  { title: 'refonte du dispatcher', group: 'complexe' },
  { title: 'doc', description: 'sans groupe' },
];

test("form: groups accepted, distinct names in the order of the parts", () => {
  assert.equal(validateSeriesPlanForm({ ...form, volets: grouped }), null);
  assert.deepEqual(planGroupNames(grouped), ['simple', 'complexe']);
  assert.deepEqual(planGroupNames([{ title: 'a' }]), []);
});

test('form: an empty, non-text or too long group name is refused', () => {
  assert.match(String(validateSeriesPlanForm({ ...form, volets: [{ title: 'a', group: '  ' }] })), /group/);
  assert.match(String(validateSeriesPlanForm({ ...form, volets: [{ title: 'a', group: 3 }] })), /group/);
  const long = { ...form, volets: [{ title: 'a', group: 'g'.repeat(61) }] };
  assert.match(String(validateSeriesPlanForm(long)), /maximum 60/);
  assert.equal(validateSeriesPlanForm({ ...form, volets: [{ title: 'a', group: 'g'.repeat(60) }] }), null);
});

test('form: a control character in a group name is refused', () => {
  // `seriesPlanCommands` puts the name between single quotes: a line break would
  // survive there and cut the command the agent copies.
  for (const group of ['a\nb', 'a\rb', 'tab\there', 'nul\u0000', 'del\u007f', '\u001b[0m']) {
    assert.match(String(validateSeriesPlanForm({ ...form, volets: [{ title: 'a', group }] })), /control character/, JSON.stringify(group));
  }
  // Accented letters and inner spaces stay valid names.
  assert.equal(validateSeriesPlanForm({ ...form, volets: [{ title: 'a', group: 'très simple' }] }), null);
});

test('form: too many distinct groups refused', () => {
  const many = Array.from({ length: MAX_GROUPS + 1 }, (_, i) => ({ title: `v${i}`, group: `g${i}` }));
  assert.match(String(validateSeriesPlanForm({ ...form, volets: many })), new RegExp(`maximum ${MAX_GROUPS}`));
  // The same name repeated only counts once.
  const repeated = Array.from({ length: 10 }, (_, i) => ({ title: `v${i}`, group: `g${i % MAX_GROUPS}` }));
  assert.equal(validateSeriesPlanForm({ ...form, volets: repeated }), null);
});

test('answer: a group missing from the issued form is refused', () => {
  const answer = { mode: 'kanban-full', roles: {}, groups: { fantôme: { code: { model: 'haiku' } } } };
  assert.match(String(validateSeriesPlanAnswer(answer, ['simple', 'complexe'])), /unknown group: fantôme/);
  // Without a list of known groups, no group is known.
  assert.match(String(validateSeriesPlanAnswer(answer)), /unknown group/);
  assert.equal(validateSeriesPlanAnswer({ ...answer, groups: { simple: { code: { model: 'haiku' } } } }, planGroupNames(grouped)), null);
});

test('answer: orchestrator and mission are not set per group', () => {
  const groups = ['simple'];
  const orch = { mode: 'kanban-full', roles: {}, groups: { simple: { orchestrator: { model: 'opus' } } } };
  assert.match(String(validateSeriesPlanAnswer(orch, groups)), /`orchestrator` is not set per group/);
  const mission = { mode: 'sequential-new-mission', roles: {}, groups: { simple: { mission: { model: 'opus' } } } };
  assert.match(String(validateSeriesPlanAnswer(mission, groups)), /`mission` is not set per group/);
  const unknown = { mode: 'kanban-full', roles: {}, groups: { simple: { chore: { model: 'opus' } } } };
  assert.match(String(validateSeriesPlanAnswer(unknown, groups)), /unknown role: chore/);
});

test('answer: a group role outside the mode is refused', () => {
  const answer = { mode: 'kanban-code-self', roles: {}, groups: { simple: { review: { model: 'sonnet' } } } };
  assert.match(String(validateSeriesPlanAnswer(answer, ['simple'])), /group `simple`: role `review` is outside mode/);
});

test('answer: a half-filled group fallback is refused', () => {
  const answer = { mode: 'kanban-full', roles: {}, groups: { simple: { code: { fallbackModel: 'gpt-5.6-sol' } } } };
  assert.match(String(validateSeriesPlanAnswer(answer, ['simple'])), /group `simple`, role `code`: `fallbackModel` without `fallbackBackend`/);
  assert.match(String(validateSeriesPlanAnswer({ mode: 'kanban-full', roles: {}, groups: 'simple' }, ['simple'])), /`groups`/);
  assert.match(String(validateSeriesPlanAnswer({ mode: 'kanban-full', roles: {}, groups: { simple: 3 } }, ['simple'])), /group `simple`/);
});

test('commands: without a group, EXACTLY the commands from before', () => {
  const answer: SeriesPlanAnswer = {
    mode: 'kanban-full',
    roles: {
      orchestrator: { fallbackBackend: 'codex', fallbackModel: 'gpt-5.6-sol' },
      code: { backend: 'claude', model: 'opus', fallbackBackend: 'codex', fallbackModel: 'gpt-5.6-sol' },
      review: { model: 'sonnet' },
    },
  };
  const expected = [
    'timon series fallback set --scope orchestrator --backend codex --model gpt-5.6-sol',
    'timon series fallback set --scope code --backend codex --model gpt-5.6-sol',
    'timon series role set --scope code --backend claude --model opus',
    'timon series role set --scope review --model sonnet',
    "timon task create --type code --pipeline full --title front --description '<part brief>'",
    "timon task create --type code --pipeline full --title back --description '<part brief>'",
  ];
  assert.deepEqual(seriesPlanCommands(answer, [{ title: 'front' }, { title: 'back' }]), expected);
  // An empty `groups` or one without a setting changes nothing either.
  assert.deepEqual(seriesPlanCommands({ ...answer, groups: {} }, [{ title: 'front' }, { title: 'back' }]), expected);
  assert.ok(!seriesPlanCommands(answer, [{ title: 'front' }]).some((c) => c.includes('--group') || c.includes('--plan-group')));
});

test('commands: group settings after the global ones, tasks with --plan-group', () => {
  const answer: SeriesPlanAnswer = {
    mode: 'kanban-full',
    roles: { code: { backend: 'claude', model: 'opus' } },
    groups: {
      simple: { code: { backend: 'claude', model: 'haiku', fallbackBackend: 'codex', fallbackModel: 'gpt-5.4-mini' }, review: { model: 'sonnet' } },
      complexe: {},
    },
  };
  const cmds = seriesPlanCommands(answer, grouped);
  assert.deepEqual(cmds, [
    'timon series role set --scope code --backend claude --model opus',
    'timon series fallback set --scope code --group simple --backend codex --model gpt-5.4-mini',
    'timon series role set --scope code --group simple --backend claude --model haiku',
    'timon series role set --scope review --group simple --model sonnet',
    "timon task create --type code --pipeline full --plan-group simple --title typo --description '<part brief>'",
    "timon task create --type code --pipeline full --plan-group simple --title 'libellés' --description '<part brief>'",
    "timon task create --type code --pipeline full --plan-group complexe --title 'refonte du dispatcher' --description '<part brief>'",
    "timon task create --type code --pipeline full --title doc --description '<part brief>'",
  ]);
});

test('commands: a group name with a space or a quote is quoted', () => {
  const volets = [{ title: 'a', group: "l'UI simple" }];
  const answer: SeriesPlanAnswer = { mode: 'kanban-code-group', roles: {}, groups: { "l'UI simple": { code: { model: 'haiku' } } } };
  const cmds = seriesPlanCommands(answer, volets);
  assert.ok(cmds.includes(`timon series role set --scope code --group 'l'\\''UI simple' --model haiku`));
  assert.ok(cmds.some((c) => c.includes(`--group-id <GROUP> --plan-group 'l'\\''UI simple' --title a`)));
  // The final merge task consolidates the whole batch: it belongs to no group.
  assert.ok(!cmds.find((c) => c.includes('--type merge'))!.includes('--plan-group'));
});

test('the branch field: a short string on the form, a string or a kind and a name on the answer', () => {
  const form = { kind: 'series_plan', chantier: 'Job', volets: [{ title: 'a' }] };
  assert.equal(validateSeriesPlanForm({ ...form, branch: 'feat/topic' }), null);
  assert.match(validateSeriesPlanForm({ ...form, branch: 3 }) ?? '', /`branch` is not a string/);
  assert.match(validateSeriesPlanForm({ ...form, branch: 'a\nb' }) ?? '', /control character/);
  assert.match(validateSeriesPlanForm({ ...form, branch: 'x'.repeat(201) }) ?? '', /maximum 200/);
  assert.equal(validateSeriesPlanAnswer({ mode: 'kanban-full', roles: {}, branch: 'topic' }), null);
  assert.match(validateSeriesPlanAnswer({ mode: 'kanban-full', roles: {}, branch: ['x'] }) ?? '', /`branch` is neither a string nor an object/);
  // The kind and the name of the branch, and where it ends up.
  const answer = (extra: Record<string, unknown>) => validateSeriesPlanAnswer({ mode: 'kanban-full', roles: {}, ...extra });
  assert.equal(answer({ branch: { kind: 'new', name: 'topic' }, finish: 'merge' }), null);
  assert.equal(answer({ branch: { kind: 'existing', name: 'feat/x' }, finish: 'keep' }), null);
  assert.match(answer({ branch: { kind: 'old', name: 'x' } }) ?? '', /`branch.kind` must be one of new, existing/);
  assert.match(answer({ branch: { kind: 'new' } }) ?? '', /`branch.name` missing or empty/);
  assert.match(answer({ branch: { kind: 'new', name: ' ' } }) ?? '', /`branch.name` missing or empty/);
  assert.match(answer({ branch: { kind: 'new', name: 'a\nb' } }) ?? '', /`branch.name` holds a control character/);
  assert.match(answer({ branch: { kind: 'new', name: 'x'.repeat(201) } }) ?? '', /`branch.name` of 201 characters/);
  assert.match(answer({ branch: { kind: 'new', name: 'x', base: 'main' } }) ?? '', /`branch.base` is unknown/);
  assert.match(answer({ finish: 'push' }) ?? '', /`finish` must be one of merge, keep/);
});

test('planBranchChoice: the earlier bare name is a new branch, flagged as such', () => {
  assert.equal(planBranchChoice(undefined), null);
  assert.equal(planBranchChoice('  '), null);
  assert.deepEqual(planBranchChoice('topic'), { kind: 'new', name: 'topic', legacy: true });
  assert.deepEqual(planBranchChoice({ kind: 'existing', name: 'feat/x' }), { kind: 'existing', name: 'feat/x', legacy: false });
});

test('the last task follows where the branch ends up', () => {
  const plan = { mode: 'kanban-full' as const, roles: {} };
  const landing = { branch: 'feat/topic', chantier: 'Job' };
  const pr = seriesPlanCommands(plan, [{ title: 'Front' }], landing);
  // `last: 'pr'` is the default: the earlier commands, to the byte.
  assert.deepEqual(seriesPlanCommands(plan, [{ title: 'Front' }], { ...landing, last: 'pr' }), pr);
  assert.match(pr.at(-1)!, /--landing pr/);
  const local = seriesPlanCommands(plan, [{ title: 'Front' }], { ...landing, last: 'local', target: 'main' });
  assert.equal(local.length, pr.length);
  assert.equal(local.at(-1),
    "timon task create --type merge --landing local --base feat/topic --deps <IDS of the code tasks> "
    + "--title 'Merge into main — Job' --description '<what the job carries>'");
  const kept = seriesPlanCommands(plan, [{ title: 'Front' }], { ...landing, last: 'none' });
  assert.deepEqual(kept, pr.slice(0, -1));
  // A grouped job merges its group first, then the branch.
  const grouped = seriesPlanCommands({ mode: 'kanban-code-group', roles: {} }, [{ title: 'Front' }], { ...landing, last: 'local', target: 'dev' });
  assert.match(grouped.at(-1)!, /--landing local --group-id <GROUP> --base feat\/topic --deps <ID of the grouped merge> --title 'Merge into dev — Job'/);
  // Sequential: the branch first, then the last task with no deps, or nothing.
  assert.deepEqual(seriesPlanCommands({ mode: 'sequential-here', roles: {} }, [], { ...landing, last: 'local', target: 'main' }), [
    'timon pr branch feat/topic',
    "timon task create --type merge --landing local --base feat/topic --title 'Merge into main — Job' --description '<what the job carries>'",
  ]);
  assert.deepEqual(seriesPlanCommands({ mode: 'sequential-here', roles: {} }, [], { ...landing, last: 'none' }), ['timon pr branch feat/topic']);
});
