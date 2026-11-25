/**
 * The two rules of the `/bots` rail nobody can check by eye on a screenshot:
 * which agents are bots of this view, and where a bot lands when its team is
 * not one the viewer can see.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { botMatches, groupBots, visibleGroups } from '@/plugins-client/bots/bots-rail';
import { NO_TEAM, mainBotOf, type Bot, type Team } from '@/plugins-client/bots/types';
import { isListedBot } from '@/plugins-client/bots/use-bots';

const bot = (over: Partial<Bot> & Pick<Bot, 'name'>): Bot => ({ ...over });
const team = (id: string, name: string): Team => ({ id, name, color: null, created_at: 0 });

test('a bot of this view is any named agent, project or not, but no workspace hub and no ephemeral mission', () => {
  assert.equal(isListedBot(bot({ name: 'nina' }), null), true);
  assert.equal(isListedBot(bot({ name: 'timon.coder', project: 'timon' }), null), true);
  assert.equal(isListedBot(bot({ name: '_main.perso' }), null), false);
  assert.equal(isListedBot(bot({ name: 'tmp-42', ephemeral: true }), null), false);
});

test('the main agent is a bot of this view under the name the daemon flags, not the seed name', () => {
  const renamed = [bot({ name: 'Nova', main: true }), bot({ name: '_main', main: false }), bot({ name: 'nina', main: false })];
  const mainName = mainBotOf(renamed);
  assert.equal(mainName, 'Nova');
  assert.deepEqual(renamed.filter((b) => isListedBot(b, mainName)).map((b) => b.name), ['Nova', 'nina']);

  const seeded = [bot({ name: '_main', main: true }), bot({ name: '_main.perso', main: false })];
  const seedMain = mainBotOf(seeded);
  assert.deepEqual(seeded.filter((b) => isListedBot(b, seedMain)).map((b) => b.name), ['_main']);
});

test('teams come first in alphabetical order, the team-less section last', () => {
  const groups = groupBots(
    [bot({ name: 'zoe', team: 'tm-b' }), bot({ name: 'ada', team: 'tm-a' }), bot({ name: 'lou' })],
    [team('tm-b', 'Ventes'), team('tm-a', 'Accueil')],
  );
  assert.deepEqual(groups.map((g) => g.key), ['tm-a', 'tm-b', NO_TEAM]);
  assert.deepEqual(groups[2]?.bots.map((b) => b.name), ['lou']);
});

test('a project agent lands under its team like any other bot', () => {
  const groups = groupBots(
    [bot({ name: 'timon.coder', project: 'timon', team: 'tm-a' }), bot({ name: 'timon.qa', project: 'timon' })],
    [team('tm-a', 'Timon')],
  );
  assert.deepEqual(groups.map((g) => g.key), ['tm-a', NO_TEAM]);
  assert.deepEqual(groups[0]?.bots.map((b) => b.name), ['timon.coder']);
  assert.deepEqual(groups[1]?.bots.map((b) => b.name), ['timon.qa']);
});

test('the main agent is never inside a group: the rail pins it above them, whatever its name', () => {
  const named = groupBots([bot({ name: 'Nova', main: true }), bot({ name: 'newagent', role: 'orchestrator' }), bot({ name: 'lou' })], []);
  assert.deepEqual(named.flatMap((g) => g.bots.map((b) => b.name)), ['lou', 'newagent']);
  // A daemon that predates the `main` flag: the seed orchestrator.
  const legacy = groupBots([bot({ name: '_main', role: 'orchestrator' }), bot({ name: 'lou' })], []);
  assert.deepEqual(legacy.flatMap((g) => g.bots.map((b) => b.name)), ['lou']);
});

test('a bot pointing at an invisible team falls back to the team-less section', () => {
  const groups = groupBots([bot({ name: 'lou', team: 'tm-gone' })], [team('tm-a', 'Accueil')]);
  assert.deepEqual(groups.map((g) => g.key), ['tm-a', NO_TEAM]);
  assert.deepEqual(groups[1]?.bots.map((b) => b.name), ['lou']);
});

test('the search keeps the bots whose name or role answers it, accents and case ignored', () => {
  assert.equal(botMatches(bot({ name: 'Élodie' }), 'elo'), true); // french-ok: an accented name, the folding under test
  assert.equal(botMatches(bot({ name: 'lou', role: 'Research' }), 'search'), true);
  assert.equal(botMatches(bot({ name: 'lou' }), 'zz'), false);
  assert.equal(botMatches(bot({ name: 'lou' }), '   '), true);
});

test('while searching a team with no match is dropped; without a search an empty team stays', () => {
  const groups = groupBots([bot({ name: 'ada', team: 'tm-a' }), bot({ name: 'lou' })], [team('tm-a', 'Accueil'), team('tm-b', 'Vide')]);
  assert.deepEqual(visibleGroups(groups, '').map((g) => g.key), ['tm-a', 'tm-b', NO_TEAM]);
  assert.deepEqual(visibleGroups(groups, 'lou').map((g) => g.key), [NO_TEAM]);
});
