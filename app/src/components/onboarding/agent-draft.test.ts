/**
 * The agent step, pure: the look an agent wears before anyone styles it (its
 * job's, accessory included, kept once styled), when "Create" opens, and
 * exactly what the creation sends to the daemon from each view.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultLookFor, ROLES, type AgentLook } from '@/components/mascot/agent-look';
import { randomLook } from '@/components/mascot/random-look';
import { mainAgentOf, mainSeatCandidates } from '@/lib/main-agent';
import type { BackendCatalog } from '@/lib/backends';
import {
  AGENT_VIEWS, AUTONOMY_PERMISSION, creationName, DEV_ROLES, roleLine, creationPatch, directivesOf, initialDraft, lookOf, missionsOf,
  modelOptions, namePool, nextQuestion, randomName, readyToCreate, shownModel, templateLook, TEMPLATE_IDS,
  type AgentDraft, type CreationContext,
} from './agent-draft';

const draft = (patch: Partial<AgentDraft> = {}): AgentDraft => ({ ...initialDraft(), ...patch });
const NO_CONTEXT: CreationContext = { current: { skills: [], mcp_servers: [] }, shownSkills: [], shownMcp: [] };
const STYLED: AgentLook = { shape: 'bean', color: '#3fa9ff', eyes: 'heart', acc: 'globe' };

test('three views, the simplest first; six templates', () => {
  assert.deepEqual([...AGENT_VIEWS], ['templates', 'interview', 'sheet']);
  assert.deepEqual(TEMPLATE_IDS, ['assist', 'dev', 'watch', 'write', 'research', 'blank']);
});

test('the default look follows the job: missions in templates and interview, role in the sheet', () => {
  assert.deepEqual(lookOf('templates', draft()), defaultLookFor([]), 'no template yet');
  const assistant = lookOf('templates', draft({ template: 'assist' }));
  assert.deepEqual(assistant, defaultLookFor(['mail', 'agenda']));
  assert.equal(assistant.acc, 'clipboard', 'mail and agenda: the clipboard');
  assert.equal(lookOf('templates', draft({ template: 'dev' })).acc, 'coffee');
  assert.equal(lookOf('templates', draft({ template: 'watch' })).acc, 'telescope');
  assert.deepEqual(lookOf('interview', draft({ missions: ['write'] })), defaultLookFor(['write']));
  assert.equal(lookOf('interview', draft({ missions: ['write'] })).acc, 'quill');
  assert.deepEqual(lookOf('sheet', draft({ role: 'review' })), defaultLookFor('review'));
  assert.equal(lookOf('sheet', draft({ role: 'review' })).acc, 'pen');
  assert.equal(lookOf('sheet', draft({ role: 'orchestrator' })).acc, 'baton');
  const coder = lookOf('sheet', draft({ role: 'code' }));
  assert.equal(coder.shape, 'tri');
  assert.equal(coder.eyes, 'code');
});

test('once styled, the look is kept whatever the job becomes', () => {
  const styled = draft({ customLook: STYLED });
  assert.deepEqual(lookOf('templates', { ...styled, template: 'dev' }), STYLED);
  assert.deepEqual(lookOf('interview', { ...styled, missions: ['mail'] }), STYLED);
  assert.deepEqual(lookOf('sheet', { ...styled, role: 'chore' }), STYLED);
});

test('missions per view: the template\'s, the interview\'s, none for a role', () => {
  assert.deepEqual(missionsOf('templates', draft({ template: 'watch', missions: ['code'] })), ['watch', 'research']);
  assert.deepEqual(missionsOf('interview', draft({ template: 'watch', missions: ['code'] })), ['code']);
  assert.deepEqual(missionsOf('sheet', draft({ template: 'watch', missions: ['code'] })), []);
  assert.equal(templateLook('blank').eyes, 'sleepy');
});

test('"Create" opens on a template, after the fifth answer, at once in the sheet', () => {
  assert.equal(readyToCreate('templates', draft()), false);
  assert.equal(readyToCreate('templates', draft({ template: 'blank' })), true);
  assert.equal(readyToCreate('interview', draft({ question: 5 })), false);
  assert.equal(readyToCreate('interview', draft({ question: 6 })), true);
  assert.equal(readyToCreate('sheet', draft()), true);
});

test('leaving the first question adds the tools its missions need, once', () => {
  const after = nextQuestion(draft({ missions: ['mail', 'research'], tools: ['slack'] }));
  assert.deepEqual(after.tools, ['slack', 'gmail', 'browser']);
  assert.equal(after.question, 2);
  const later = nextQuestion({ ...after, tools: [] });
  assert.deepEqual(later.tools, [], 'only the first question adds tools');
  assert.equal(nextQuestion(draft({ question: 6 })).question, 6, 'never past the end');
});

test('names are drawn from the language\'s pool, never the one shown', () => {
  const pool = namePool('Nova, Pixel ,, Ziggy');
  assert.deepEqual(pool, ['Nova', 'Pixel', 'Ziggy']);
  for (let i = 0; i < 20; i += 1) assert.notEqual(randomName(pool, 'Pixel'), 'Pixel');
  assert.equal(randomName(['Solo'], 'Solo'), 'Solo', 'a pool of one still answers');
  assert.equal(creationName(draft({ name: '  Kiwi ' }), pool), 'Kiwi');
  assert.ok(pool.includes(creationName(draft({ name: '' }), pool)), 'no name: one is drawn');
  const look = randomLook(() => 0.999);
  // A draw of 0.999 takes the last of each list: the black fur, the musician.
  assert.deepEqual(look, { shape: 'hex', color: '#2b2b2b', eyes: 'code', acc: 'musician' });
});

test('templates send the look and the missions as directives, nothing else', () => {
  const patch = creationPatch('templates', draft({ template: 'assist' }), NO_CONTEXT);
  assert.deepEqual(Object.keys(patch).sort(), ['directives', 'look']);
  assert.deepEqual(patch.look, defaultLookFor(['mail', 'agenda']));
  assert.match(patch.directives ?? '', /read and sort their email; check and fill their calendar/);
  assert.deepEqual(Object.keys(creationPatch('templates', draft({ template: 'blank' }), NO_CONTEXT)), ['look'], 'from scratch: no directives');
});

test('the interview sends its autonomy as a permission mode and every answer as directives', () => {
  const answered = draft({
    missions: ['mail'], other: 'invoices', tools: ['gmail', 'slack'], triggers: ['chat', 'daily'], at: '07:30',
    autonomy: 'report', notify: ['timon', 'email'], question: 6,
  });
  const patch = creationPatch('interview', answered, NO_CONTEXT);
  assert.equal(patch.permission_mode, 'auto');
  assert.ok(!('role' in patch), 'the main agent keeps its role');
  assert.equal(patch.model, undefined, 'and its model');
  const lines = (patch.directives ?? '').split('\n');
  assert.deepEqual(lines, [
    'Set up with the user during onboarding:',
    'What the user expects from you: read and sort their email; invoices.',
    'Tools the user allowed: Gmail, Slack.',
    'When to start: when the user talks to you; every day at 07:30.',
    'Before an important action: act, then tell the user what you did.',
    'Where to let the user know: in Timon, by email.',
  ]);
  assert.equal(AUTONOMY_PERMISSION.ask, 'default');
  assert.equal(AUTONOMY_PERMISSION.silent, 'auto', 'silence never bypasses the checks');
});

test('the sheet sends model, exact permission mode, folder, skills, MCP servers, its line of work and rules', () => {
  const sheet = draft({
    role: 'review', model: { backend: 'codex', model: 'gpt-5.5' }, effort: 'high', permission: 'bypassPermissions', folder: ' /home/me/app ',
    skills: ['tests'], mcp: ['github'], rules: ' Never push. ', customLook: STYLED,
  });
  const patch = creationPatch('sheet', sheet, {
    current: { skills: ['timon-task', 'tests', 'debug'], mcp_servers: ['postgres', 'sentry'] },
    shownSkills: ['tests', 'debug'],
    shownMcp: ['github', 'sentry'],
  });
  assert.deepEqual(patch, {
    look: STYLED,
    directives: 'Main line of work: reviewing changes before they land. You remain the main agent and pilot: delegate what falls outside it.\nNever push.',
    permission_mode: 'bypassPermissions',
    backend: 'codex',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    cwd: '/home/me/app',
    // Not shown, so not unchecked: the product's own skill and an unlisted server stay.
    skills: ['timon-task', 'tests'],
    mcp_servers: ['postgres', 'github'],
  });
  const untouched = creationPatch('sheet', draft(), NO_CONTEXT);
  assert.equal(untouched.model, undefined, 'no model picked: the agent keeps its own');
  assert.ok(!('reasoningEffort' in untouched), 'no effort picked: the model\'s default, nothing written');
  assert.ok(!('reasoningEffort' in creationPatch('interview', draft({ effort: 'high' }), NO_CONTEXT)), 'only the sheet sets the effort');
  assert.equal(untouched.cwd, undefined, 'no folder: the workspace stays');
  assert.equal(directivesOf('sheet', draft({ rules: '   ' })), '', 'the pilot needs no line of work');
  assert.equal(directivesOf('sheet', draft({ role: 'code', rules: '' })), roleLine('code'));
});

test('the sheet opens on the pilot, first of its list', () => {
  assert.equal(initialDraft().role, 'orchestrator');
  assert.equal(DEV_ROLES[0], 'orchestrator');
  assert.deepEqual([...DEV_ROLES].sort(), [...ROLES].sort(), 'every role still offered');
  assert.equal(roleLine('orchestrator'), null);
  for (const role of ROLES.filter((r) => r !== 'orchestrator')) assert.match(roleLine(role) ?? '', /^Main line of work: .+ You remain the main agent and pilot/);
});

/* The main agent stays `orchestrator` (docs/ONBOARDING-AGENT.md): the PATCH
   that follows `applyMainAgentName` must never carry a role, or the daemon
   drops the pilot preamble and refuses to seat it. */
const EVERY_DRAFT: AgentDraft[] = ROLES.flatMap((role) => [
  draft({ role }),
  draft({ role, template: 'dev', missions: ['code'], question: 6, model: { backend: 'codex', model: 'gpt-5.5' }, folder: '/w', rules: 'x' }),
]);

test('no view and no role ever writes `role`', () => {
  for (const view of AGENT_VIEWS) {
    for (const d of EVERY_DRAFT) assert.ok(!('role' in creationPatch(view, d, NO_CONTEXT)), `${view} / ${d.role}`);
  }
});

test('an agent created from any view stays a candidate for the main seat', () => {
  // The seed as `applyMainAgentName` leaves it: a project-less orchestrator.
  const seated = { name: 'nova', role: 'orchestrator', project: null, ephemeral: false };
  for (const view of AGENT_VIEWS) {
    for (const d of EVERY_DRAFT) {
      const created = { ...seated, ...creationPatch(view, d, NO_CONTEXT) };
      assert.deepEqual(mainSeatCandidates([created]), ['nova'], `${view} / ${d.role}`);
      assert.equal(mainAgentOf([created]), 'nova');
    }
  }
});

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    { id: 'claude', label: 'Claude Code', vendor: 'Anthropic', brand: 'claude', defaultModel: 'sonnet', models: [{ slug: 'opus', label: 'Opus' }, { slug: 'sonnet', label: 'Sonnet' }] },
    { id: 'claude@a1', label: 'Claude (work)', instanceOf: 'claude', defaultModel: 'opus', models: [{ slug: 'opus', label: 'Opus' }] },
    { id: 'codex', label: 'Codex', vendor: 'OpenAI', defaultModel: 'gpt-5.5', models: [{ slug: 'gpt-5.5', label: 'GPT-5.5' }], signedIn: false },
    { id: 'grok', label: 'Grok', defaultModel: 'grok-4', models: [{ slug: 'grok-4', label: 'Grok 4' }], account: { id: 'x', name: 'x', state: 'cooldown' } },
  ],
};

test('the models come from the catalogue: providers that can run, no account twice', () => {
  const options = modelOptions(CATALOG);
  assert.deepEqual(options.map((o) => `${o.backend}/${o.model}`), ['claude/opus', 'claude/sonnet']);
  assert.equal(options[0]?.vendor, 'Anthropic');
  assert.equal(options[0]?.brand, 'claude');
  assert.deepEqual(modelOptions({ backends: [], defaultBackend: '' }), [], 'no catalogue, no list');
});

test('the card shows the picked model, else the agent\'s, else the default', () => {
  assert.equal(shownModel(CATALOG, { backend: 'claude', model: 'opus' }, null)?.model, 'opus');
  assert.equal(shownModel(CATALOG, null, { backend: 'claude', model: 'opus' })?.model, 'opus');
  assert.equal(shownModel(CATALOG, null, null)?.model, 'sonnet', 'the default backend\'s default model');
  assert.equal(shownModel({ backends: [], defaultBackend: '' }, null, null), null);
  assert.equal(shownModel(CATALOG, { backend: 'claude@a1', model: 'opus' }, null)?.vendor, 'Claude (work)', 'an account picked in the picker is named');
});
