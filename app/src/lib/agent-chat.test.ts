/**
 * The instance model of `@timon/agent-chat`.
  *
  * french-ok-file: an accented sub-agent label, as a user names one
 *
 * What this locks: several cards of the same widget must be able to coexist,
 * each with its own identity, and that identity is what the host persists a
 * placement under. A normalisation that silently merged two instances, or that
 * crashed on a hand-edited export, would take a cockpit down with it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shownAgent,
  findMainAgent,
  seedForAgent,
  instancesOnLoad,
  instanceModes,
  normalizeInstances,
  newInstanceId,
  customizationOf,
  customizeAgent,
  removeAgent,
  instanceTitle,
  type AgentChatInstance,
} from '@/plugins-client/agent-chat/instances';

const instance = (over: Partial<AgentChatInstance> = {}): AgentChatInstance => ({
  id: 'a',
  agent: 'alice.main',
  title: '',
  avatar: '',
  zone: '',
  subAgents: [],
  ...over,
});

test('the stored list comes back with its order and its sub-agents', () => {
  const read = normalizeInstances({
    instances: [
      { id: 'a', agent: 'alice.main', subAgents: [{ agent: 'Alice.helper', label: 'Santé' }] },
      { id: 'b', agent: 'initech.coder', title: 'Coder' },
    ],
  });
  assert.deepEqual(read.map((i) => i.id), ['a', 'b']);
  assert.deepEqual(read[0]?.subAgents, [{ agent: 'Alice.helper', label: 'Santé' }]);
  assert.equal(read[1]?.title, 'Coder');
});

test('a bare array is read too: the shape stored is the front\'s business', () => {
  assert.equal(normalizeInstances([{ id: 'a', agent: 'alice.main' }]).length, 1);
});

test('nothing stored yet, or stored garbage, gives no instance and no throw', () => {
  for (const raw of [null, undefined, 42, 'x', {}, { instances: 'nope' }, [null, 3]]) {
    assert.deepEqual(normalizeInstances(raw), []);
  }
});

test('an instance without id or without agent is unrenderable, so it is dropped', () => {
  const read = normalizeInstances({
    instances: [{ agent: 'alice.main' }, { id: 'b' }, { id: 'c', agent: 'alice.main' }],
  });
  assert.deepEqual(read.map((i) => i.id), ['c']);
});

test('two instances sharing an id would share a placement: the second is dropped', () => {
  const read = normalizeInstances({
    instances: [{ id: 'a', agent: 'alice.main' }, { id: 'a', agent: 'other' }],
  });
  assert.deepEqual(read.map((i) => i.agent), ['alice.main']);
});

test('the same agent listed twice under the avatar is one button, not two', () => {
  const [read] = normalizeInstances({
    instances: [{
      id: 'a',
      agent: 'alice.main',
      subAgents: [{ agent: 'Alice.helper' }, { agent: 'alice.helper' }, { agent: '' }],
    }],
  });
  assert.deepEqual(read?.subAgents, [{ agent: 'Alice.helper' }]);
});

test('a config written before shortcuts existed loads unchanged', () => {
  const [read] = normalizeInstances({
    instances: [{ id: 'a', agent: 'alice.main', subAgents: [{ agent: 'Alice.helper' }] }],
  });
  assert.deepEqual(read?.subAgents, [{ agent: 'Alice.helper' }]);
  assert.deepEqual(instanceModes(read!), [
    { value: 'alice.main', label: 'alice.main' },
    { value: 'Alice.helper', label: 'Alice.helper' },
  ]);
});

/**
 * #155 let each sub-agent carry its own label and avatar URL; they are now the
 * agent's own name and icon. A tester's stored card must still load — the old
 * fields are read without error and dropped, so the next save writes them out.
 */
test('per-agent nickname and photo load; blank or malformed ones are dropped', () => {
  const stored = {
    instances: [{
      id: 'main',
      agent: 'Nova',
      title: 'Nova',
      avatar: '/api/uploads/avatars/nova.png',
      zone: 'centre',
      subAgents: [
        { agent: 'Alice.helper', label: 'Santé', avatar: '/health.png' },
        { agent: 'a.two', label: '', avatar: '   ' },
        { agent: 'a.three', label: 42, avatar: 42 },
      ],
    }],
  };
  const [read] = normalizeInstances(stored);
  assert.deepEqual(read?.subAgents, [{ agent: 'Alice.helper', label: 'Santé', avatar: '/health.png' }, { agent: 'a.two' }, { agent: 'a.three' }]);
  // The card's own avatar is the one the daemon writes at onboarding: kept.
  assert.equal(read?.avatar, '/api/uploads/avatars/nova.png');
  assert.deepEqual(instanceModes(read!), [
    { value: 'Nova', label: 'Nova', avatar: '/api/uploads/avatars/nova.png' },
    { value: 'Alice.helper', label: 'Santé', avatar: '/health.png' },
    { value: 'a.two', label: 'a.two' },
    { value: 'a.three', label: 'a.three' },
  ]);
  // What a save writes back keeps the overrides and nothing blank.
  assert.deepEqual(JSON.parse(JSON.stringify(read)).subAgents, [
    { agent: 'Alice.helper', label: 'Santé', avatar: '/health.png' }, { agent: 'a.two' }, { agent: 'a.three' },
  ]);
});

test('there is no ceiling on the number of shortcuts', () => {
  const subAgents = Array.from({ length: 40 }, (_, i) => ({ agent: `agent.${i}` }));
  const [read] = normalizeInstances({ instances: [{ id: 'a', agent: 'alice.main', subAgents }] });
  assert.equal(read?.subAgents.length, 40);
  assert.equal(instanceModes(read!).length, 41);
});

test('an untitled card is named after the agent it shows', () => {
  assert.equal(instanceTitle(instance()), 'alice.main');
  assert.equal(instanceTitle(instance({ title: 'Alice' })), 'Alice');
});

test('fresh ids never collide inside one list', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newInstanceId()));
  assert.equal(ids.size, 50);
});

test('an instance renders any agent: alice and its health sub-agent, as the hard tile did', () => {
  const alice = instance({
    id: 'alice',
    agent: 'alice.main',
    title: 'Alice',
    subAgents: [{ agent: 'Alice.helper' }],
  });
  assert.deepEqual(instanceModes(alice), [
    { value: 'alice.main', label: 'Alice' },
    { value: 'Alice.helper', label: 'Alice.helper' },
  ]);
  // Same widget, another agent entirely: nothing of alice is baked in.
  assert.deepEqual(instanceModes(instance({ agent: 'initech.coder' })), [
    { value: 'initech.coder', label: 'initech.coder' },
  ]);
  // A sub-agent is named after the agent it opens.
  assert.deepEqual(instanceModes(instance({ subAgents: [{ agent: 'x.main' }] }))[1], {
    value: 'x.main',
    label: 'x.main',
  });
});

test('a selection the config no longer offers falls back to the card\'s own agent', () => {
  const alice = instance({ subAgents: [{ agent: 'Alice.helper' }] });
  assert.equal(shownAgent(alice, 'Alice.helper'), 'Alice.helper');
  assert.equal(shownAgent(alice, 'removed.agent'), 'alice.main');
});

/**
 * The main agent is read by ROLE, never by a literal: the build ships before
 * anyone names their orchestrator, and the seed that hard-coded `alice.main`
 * pointed at an agent no install outside that one machine has.
 */
test('the main agent is read from its role, not from its name', () => {
  const agents = [
    { name: 'Nimbus.main', role: 'orchestrator', project: 'nimbus' },
    { name: '_main.perso', role: 'orchestrator', project: null },
    { name: 'Nova', role: 'orchestrator', project: null },
    { name: '_main', role: 'orchestrator', project: null },
  ];
  // A named orchestrator beats the seed name; a hub `_main.<ws>` and a
  // project-bound orchestrator are never the main agent.
  assert.equal(findMainAgent(agents), 'Nova');
  // Step 3 skipped: the placeholder is the answer because there is no other.
  assert.equal(findMainAgent([{ name: '_main', role: 'orchestrator', project: null }]), '_main');
  // Nothing to show: no card rather than a card pointing at nobody.
  assert.equal(findMainAgent([{ name: 'coder', role: 'coder', project: 'x' }]), null);
  assert.equal(findMainAgent([]), null);
});

test('a never-written list is the seeded card; an emptied list stays empty', () => {
  const seed = instancesOnLoad(null, [{ name: 'Nova', role: 'orchestrator', project: null }]);
  assert.deepEqual(seed, [seedForAgent('Nova')]);
  assert.equal(seed[0]?.agent, 'Nova');
  assert.equal(seed[0]?.id, 'main', 'the id the cockpit starter places');
  assert.equal(seed[0]?.zone, 'centre', 'the seeded card opens in the cockpit centre');
  // Deleting the card writes `{ instances: [] }`: the seed must not come back.
  assert.deepEqual(instancesOnLoad({ instances: [] }), []);
  assert.deepEqual(instancesOnLoad([]), []);
});

/**
 * The 404 of the first real launch: `/api/ui/agents/alice.main/git` on a
 * fresh home. The seeded card pointed at an agent that no shipped install
 * has; it was painted anyway and queried the void every 30
 * seconds. A surface whose subject does not exist fades away.
 */
test('the seeded card only shows if a main agent exists', () => {
  assert.deepEqual(instancesOnLoad(null, []), []);
  assert.deepEqual(instancesOnLoad(null, [{ name: 'coder', role: 'coder', project: 'x' }]), []);
  // Nothing written and nothing to show: no ghost card.
  assert.deepEqual(instancesOnLoad(null, undefined), []);
});

test('a card configured by the user keeps its thread, agent deleted or not', () => {
  // Deliberate decision (see `use-agents.ts`): only the card NOBODY
  // chose fades away. A written card stays, whatever the list.
  const written = { instances: [{ id: 'a', agent: 'disparu.main' }] };
  assert.deepEqual(instancesOnLoad(written, []).map((i) => i.agent), ['disparu.main']);
});

test('a stored instance without a zone keeps the host default, not the seed\'s centre', () => {
  const [read] = normalizeInstances([{ id: 'a', agent: 'other.main' }]);
  assert.equal(read?.zone, '');
});

test('customising the card\'s own agent writes its title and avatar, a sub-agent its label and avatar', () => {
  const base = instance({ subAgents: [{ agent: 'Alice.helper' }] });
  const main = customizeAgent(base, 'alice.main', { label: ' Boss ', avatar: '/b.png' });
  assert.deepEqual([main.title, main.avatar], ['Boss', '/b.png']);
  const sub = customizeAgent(base, 'Alice.helper', { label: 'Santé', avatar: '' });
  assert.deepEqual(sub.subAgents, [{ agent: 'Alice.helper', label: 'Santé' }]);
  assert.deepEqual(customizationOf(sub, 'Alice.helper'), { label: 'Santé', avatar: '' });
  // Emptying both puts the agent's own name and picture back.
  assert.deepEqual(customizeAgent(sub, 'Alice.helper', { label: '', avatar: '' }).subAgents, [{ agent: 'Alice.helper' }]);
});

test('removing an agent: a sub-agent leaves, the main one hands over, the last one takes the card away', () => {
  const base = instance({ title: 'Boss', subAgents: [{ agent: 'a.two', label: 'Deux', avatar: '/2.png' }, { agent: 'a.three' }] });
  assert.deepEqual(removeAgent(base, 'a.three')?.subAgents.map((s) => s.agent), ['a.two']);
  const successor = removeAgent(base, 'alice.main');
  assert.deepEqual([successor?.agent, successor?.title, successor?.avatar], ['a.two', 'Deux', '/2.png']);
  assert.deepEqual(successor?.subAgents, [{ agent: 'a.three' }]);
  assert.equal(removeAgent(instance(), 'alice.main'), null);
});
