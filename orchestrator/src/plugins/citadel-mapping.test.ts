/**
 * Citadel's model (plugins/citadel/src/mapping.ts): spaces, projects, agent states, journal rows,
 * and that every language ships the same messages. Fictional data only: nothing here describes a real installation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defaultLookFor, buildModel, normName, toMs, agentState, structureKey, transitions, summarize, UNASSIGNED_SPACE, ORPHAN_SLUG,
} from '../../../plugins/citadel/src/mapping.js';
import type { StateInput, StateMission } from '../../../plugins/citadel/src/mapping.js';
import { t } from '../../../plugins/citadel/src/i18n.js';
import messages from '../../../plugins/citadel/src/messages.json' with { type: 'json' };

type Fixture = StateInput & { generated_at: number; missions: (StateMission & { ended_at: number })[] };
const fx = JSON.parse(readFileSync(fileURLToPath(new URL('../../../plugins/citadel/test/fixtures/state.json', import.meta.url)), 'utf8')) as Fixture;
const NOW = fx.generated_at + 60000;
const model = buildModel(fx, NOW);

/** The value, which the test knows exists. */
function must<T>(v: T | undefined | null): T {
  assert.ok(v !== undefined && v !== null, 'expected a value');
  return v;
}
const ag = (n: string) => must(model.agents.find(a => a.name === n));
const project = (slug: string) => must(model.projects.find(p => p.slug === slug));

test('normName ignores accents, dashes, spaces and case', () => {
  assert.equal(normName('On-Line'), normName('On line'));
  assert.equal(normName('Éléphant'), 'elephant'); // french-ok: the accent folding is what is tested
});

test('toMs accepts ms, seconds and ISO strings', () => {
  assert.equal(toMs(1762550000000), 1762550000000);
  assert.equal(toMs(1762550000), 1762550000000);
  assert.equal(toMs('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(toMs(null), null);
});

test('spaces = distinct workspaces; projects without one go to the unassigned space', () => {
  assert.deepEqual(model.spaces.map(s => s.name), ['Retail', 'On line', t('unassignedSpace')]);
  assert.deepEqual(must(model.spaces.find(s => s.key === UNASSIGNED_SPACE)).projects, ['garden', 'noworkspace']);
});

test('agent → project: project field, else the name prefix', () => {
  assert.equal(ag('bakery.coder').project, 'bakery');
  assert.equal(ag('bikes.coder').project, 'bikes');
});

test('space captain found by normalised name', () => {
  assert.equal(ag('On-Line').kind, 'captain');
  assert.equal(ag('On-Line').space, 'On line');
  assert.equal(must(model.spaces.find(s => s.name === 'Retail')).captain, 'Retail');
});

test('main agent → rotunda; agents without a project → "No project"', () => {
  assert.equal(ag('Warden').kind, 'central');
  const m = buildModel({ agents: [{ name: 'solo', role: 'x' }, { name: 'attached', role: 'x', reports_to: 'solo' }], projects: [{ slug: 'a', name: 'A', workspace: 'X' }] }, NOW);
  assert.equal(m.agents[0]?.kind, 'central');
  assert.equal(m.agents[1]?.project, ORPHAN_SLUG);
  const orphan = must(m.projects.find(p => p.slug === ORPHAN_SLUG));
  assert.equal(orphan.name, t('noProject'));
  assert.equal(orphan.space, UNASSIGNED_SPACE);
  assert.deepEqual(orphan.crew, ['attached']);
});

test('without a declared main agent, the first project-less "main" role leads (the SDK gives no reporting line)', () => {
  const m = buildModel({ projects: [], agents: [{ name: 'a', role: 'coder' }, { name: 'boss', role: 'main' }] }, NOW);
  assert.equal(must(m.agents.find(a => a.name === 'boss')).main, true);
  assert.equal(m.central[0], 'boss');
});

test('pilot = role main or orchestrator, crew = the rest', () => {
  const p = project('bakery');
  assert.equal(p.pilot, 'bakery.main');
  assert.deepEqual(p.crew, ['bakery.coder', 'bakery.reviewer', 'bakery.merger']);
  assert.equal(project('bikes').pilot, null);
});

test('states: wait (question or waiting mission), err < 30 min, work, rest', () => {
  assert.equal(ag('bakery.main').state, 'wait');
  assert.equal(ag('bakery.main').text, 'Ship the fix to production?');
  assert.equal(ag('portal.reviewer').state, 'wait');
  assert.equal(ag('portal.reviewer').text, 'Waiting for the layout choice');
  assert.equal(ag('bikes.coder').state, 'err');
  assert.equal(ag('bakery.coder').state, 'work');
  assert.equal(ag('bakery.coder').text, 'Fix the booking page test');
  assert.equal(ag('garden.seo').state, 'rest');
});

test('an error older than 30 minutes → rest', () => {
  const ended = must(fx.missions[3]).ended_at;
  const s = agentState('bikes.coder', fx.missions, [], ended + 31 * 60000);
  assert.equal(s.state, 'rest');
});

test('transitions: nothing on the first reading, then one row per change', () => {
  assert.deepEqual(transitions(null, model), []);
  const next = buildModel({ ...fx, missions: fx.missions.filter(m => m.id !== 'm1'), questions: [] }, NOW);
  const rows = transitions(model, next, NOW);
  assert.deepEqual(rows.map(x => [x.name, x.state]).sort(), [['bakery.coder', 'rest']]);
  assert.equal(must(rows.find(x => x.name === 'bakery.coder')).text, t('done'));
});

test('structureKey is stable for the same structure and changes when an agent appears', () => {
  assert.equal(structureKey(model), structureKey(buildModel({ ...fx, missions: [] }, NOW)));
  assert.notEqual(structureKey(model), structureKey(buildModel({ ...fx, agents: (fx.agents ?? []).slice(1) }, NOW)));
});

test('summarize: a waiting agent comes first', () => {
  const s = summarize(model, project('portal'));
  assert.match(s.line, /^reviewer/);
  assert.equal(s.w.length, 1);
});

test('summarize of an idle project uses the plural message', () => {
  const s = summarize(model, project('garden'));
  assert.equal(s.line, '2 agents available');
});

test('an empty state does not throw', () => {
  assert.deepEqual(buildModel({}, NOW).spaces, []);
});

test('projects without a workspace are shown, technical entries dropped', () => {
  const m = buildModel({ projects: [{ slug: 'pf', name: 'PF', workspace: 'Retail' }, { slug: '--help', name: 'x' }], agents: [{ name: 'pf.main', role: 'main', project: 'pf' }] });
  assert.deepEqual(m.projects.map(p => p.slug), ['pf']);
});

test('agentState carries the mission to open', () => {
  const now = Date.now();
  const ms: StateMission[] = [{ id: 'm1', agent_name: 'x', status: 'error', started_at: now - 60000, ended_at: now - 30000 }];
  assert.equal(agentState('x', ms, [], now).missionId, 'm1');
  assert.equal(agentState('x', [{ id: 'm2', agent_name: 'x', status: 'running', started_at: now }], [], now).missionId, 'm2');
  assert.equal(agentState('x', [], [{ agent_name: 'x', mission_id: 'm3', text: 'q' }], now).missionId, 'm3');
});

test('defaultLookFor: default Timon look by role', () => {
  assert.deepEqual(defaultLookFor('coder'), { shape: 'tri', color: '#7ed957', eyes: 'code', acc: 'coffee' });
  assert.deepEqual(defaultLookFor('reviewer'), { shape: 'squircle', color: '#7a4f35', eyes: 'squint', acc: 'pen' });
  assert.deepEqual(defaultLookFor('ops'), { shape: 'squircle', color: '#7a4f35', eyes: 'pill', acc: 'hammer' });
  assert.deepEqual(defaultLookFor('research'), { shape: 'squircle', color: '#7a4f35', eyes: 'big', acc: 'loupe' });
  assert.deepEqual(defaultLookFor('orchestrator'), { shape: 'squircle', color: '#7a4f35', eyes: 'pill', acc: 'baton' });
  assert.deepEqual(defaultLookFor('seo'), { shape: 'squircle', color: '#7a4f35', eyes: 'pill', acc: 'none' });
  assert.deepEqual(defaultLookFor(''), { shape: 'squircle', color: '#7a4f35', eyes: 'pill', acc: 'none' });
});

test('buildModel keeps an own look (SDK `look`), else the default look of the role (main = orchestrator)', () => {
  const own = { shape: 'gem', color: '#33231d', eyes: 'heart', acc: 'crown' };
  const m = buildModel({ projects: [{ slug: 'pf', name: 'PF', workspace: 'C' }], agents: [
    { name: 'lead', role: 'main', main: true, look: own },
    { name: 'pf.main', role: 'main', project: 'pf' },
    { name: 'pf.coder', role: 'coder', project: 'pf', look: { shape: 'nope', color: 'red' } },
    { name: 'pf.rev', role: 'reviewer', project: 'pf' }] });
  const look = (n: string) => must(m.agents.find(a => a.name === n)).look;
  assert.deepEqual(look('lead'), own);
  assert.equal(look('pf.main').acc, 'baton');
  assert.deepEqual(look('pf.coder'), defaultLookFor('coder'));
  assert.equal(look('pf.rev').eyes, 'squint');
});

test('structureKey: a look change rebuilds the scene', () => {
  const mk = (color: string) => buildModel({ projects: [], agents: [{ name: 'lead', main: true, look: { shape: 'gem', color } }] });
  assert.notEqual(structureKey(mk('#111111')), structureKey(mk('#222222')));
});

test('messages: French has the same keys as English', () => {
  type Tree = { [key: string]: string | Tree };
  const flat = (o: Tree, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' ? flat(v, p + k + '.') : [p + k]).sort();
  assert.deepEqual(flat(messages.fr), flat(messages.en));
});
