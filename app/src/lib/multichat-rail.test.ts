// french-ok-file: accented names, the folding under test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRail, filterRail, firstAgent, foldText, readRailPrefs, type RailAgent } from './multichat-rail';
import { getLocale, registerLocale, setLocale } from './i18n';

const agents: RailAgent[] = [
  { name: 'timon.coder', project: 'timon', role: 'coder' },
  { name: 'nimbus.main', project: 'Nimbus', role: 'orchestrator' },
  { name: 'timon.reviewer', project: 'timon', role: 'reviewer' },
  { name: 'veille', project: null, role: null, team: 'team-1' },
  { name: 'lonely', project: null, role: null },
  { name: 'ghost-team', project: null, role: null, team: 'deleted' },
  { name: 'perso.main', project: 'perso', role: 'orchestrator' },
];
const projects = [{ slug: 'timon', name: 'Timon', color: '#123456' }, { slug: 'nimbus', name: 'Nímbus' }];
const teams = [{ id: 'team-1', name: 'Recherche', color: null }];

test('without poles: one section, projects by name, then teams, then the agents of no project', () => {
  const sections = buildRail(agents, { projects, teams });
  assert.equal(sections.length, 1);
  assert.equal(sections[0]!.pole, null);
  assert.deepEqual(sections[0]!.groups.map((g) => [g.key, g.kind, g.label]), [
    ['p:nimbus', 'project', 'Nímbus'],
    ['p:perso', 'project', 'perso'],
    ['p:timon', 'project', 'Timon'],
    ['t:team-1', 'team', 'Recherche'],
    ['none', 'none', ''],
  ]);
  const timon = sections[0]!.groups.find((g) => g.key === 'p:timon')!;
  assert.equal(timon.color, '#123456');
  assert.deepEqual(timon.agents.map((a) => a.name), ['timon.coder', 'timon.reviewer'], 'the list order is kept');
  // A team that no longer exists does not make a group of its own.
  assert.deepEqual(sections[0]!.groups.at(-1)!.agents.map((a) => a.name), ['lonely', 'ghost-team']);
});

test('poles head their projects; what is in no pole trails, without a heading', () => {
  const sections = buildRail(agents, {
    projects,
    teams,
    poles: [
      { slug: 'pro', name: 'Pro', projects: ['timon', 'NIMBUS'] },
      { slug: 'empty', name: 'Empty', projects: ['nothing'] },
      { slug: 'life', name: 'Life', projects: ['perso'] },
    ],
  });
  assert.deepEqual(sections.map((s) => s.pole?.name ?? null), ['Life', 'Pro', null], 'a pole without agents is not shown');
  assert.deepEqual(sections[1]!.groups.map((g) => g.key), ['p:nimbus', 'p:timon'], 'project slugs match without case');
  assert.deepEqual(sections[2]!.groups.map((g) => g.key), ['t:team-1', 'none']);
});

test('project groups follow the interface language: pinyin order in Chinese', () => {
  // Code-point order puts 张 (zhang) before 李 (li); a Chinese reader expects li first.
  const chinese = [{ slug: 'zhang', name: '张' }, { slug: 'li', name: '李' }];
  const members: RailAgent[] = [
    { name: 'a', project: 'zhang', role: null },
    { name: 'b', project: 'li', role: null },
  ];
  const previous = getLocale();
  registerLocale('zh-CN', {});
  try {
    setLocale('zh-CN');
    assert.deepEqual(buildRail(members, { projects: chinese }).at(0)!.groups.map((g) => g.label), ['李', '张']);
  } finally {
    setLocale(previous);
  }
});

test('no agent, no section', () => {
  assert.deepEqual(buildRail([]), []);
});

test('remembered side bar state is read tolerantly', () => {
  assert.deepEqual(readRailPrefs(null), { collapsed: false, open: [] });
  assert.deepEqual(readRailPrefs('not json'), { collapsed: false, open: [] });
  assert.deepEqual(readRailPrefs('[1,2]'), { collapsed: false, open: [] });
  assert.deepEqual(readRailPrefs('{"collapsed":"yes","open":"p:timon"}'), { collapsed: false, open: [] });
  assert.deepEqual(
    readRailPrefs('{"collapsed":true,"open":["p:timon",3,"p:timon","none"]}'),
    { collapsed: true, open: ['p:timon', 'none'] },
  );
});

test('search ignores case and accents, and every word must match somewhere', () => {
  assert.equal(foldText('Équipe ÀÉÏÕ'), 'equipe aeio');
  const sections = buildRail(agents, {
    projects,
    teams,
    poles: [{ slug: 'pro', name: 'Pôle Pro', projects: ['timon', 'nimbus'] }],
  });
  const names = (q: string) => filterRail(sections, q).flatMap((s) => s.groups.flatMap((g) => g.agents.map((a) => a.name)));

  assert.equal(names('  ').length, agents.length, 'blank query: everything');
  assert.deepEqual(names('REVIEW'), ['timon.reviewer'], 'name and role, any case');
  assert.deepEqual(names('NÍMBUS'), ['nimbus.main'], 'accent and case in the query do not matter');
  assert.deepEqual(names('recherche'), ['veille'], 'team name');
  assert.deepEqual(names('pole pro'), ['nimbus.main', 'timon.coder', 'timon.reviewer'], 'pole name, accent dropped');
  assert.deepEqual(names('coder timon'), ['timon.coder'], 'words in any order');
  assert.deepEqual(names('coder nimbus'), [], 'every word must match');

  const narrowed = filterRail(sections, 'timon');
  assert.deepEqual(narrowed.map((s) => s.pole?.name ?? null), ['Pôle Pro'], 'sections left empty are dropped');
  assert.deepEqual(narrowed[0]!.groups.map((g) => g.key), ['p:timon'], 'groups left empty are dropped');
  assert.equal(firstAgent(narrowed)?.name, 'timon.coder');
  assert.equal(firstAgent(filterRail(sections, 'nobody')), null);
});

test('search finds an agent by its team even when its group is its project', () => {
  const both: RailAgent[] = [
    { name: 'timon.scout', project: 'timon', role: 'researcher', team: 'team-1' },
    { name: 'timon.coder', project: 'timon', role: 'coder' },
  ];
  const sections = buildRail(both, { projects, teams });
  assert.deepEqual(sections[0]!.groups.map((g) => g.key), ['p:timon'], 'the project stays the group');
  const names = (q: string, t = teams) => filterRail(sections, q, t).flatMap((s) => s.groups.flatMap((g) => g.agents.map((a) => a.name)));
  assert.deepEqual(names('Recherche'), ['timon.scout'], 'team name');
  assert.deepEqual(names('RECHERCHE timon'), ['timon.scout'], 'team name and project together');
  assert.deepEqual(names('team-1'), ['timon.scout'], 'team id');
  assert.deepEqual(names('recherche', []), [], 'no team list: the name is unknown');
});
