/**
 * The catalogue only offers what the backend can really do. A body is read with
 * `skill_get` (Timon's MCP) or from its file (Timon's disk, `attachments`); a
 * backend with neither gets the body pasted, since a catalogue line would have
 * no follow-up, and that widens nothing: what this agent does not resolve stays out.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TIMON_HOME } from './paths.js';

const { buildEffectivePrompt, loadConfig, resolveSpawnSkills, upsertAgent } = await import('./agent.js');
await import('../tests/helpers/claude-provider.js');

const { getBackend } = await import('./backends/index.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { upsertSkill } = await import('./skills.js');
const { buildInjections } = await import('./prompt-injections.js');
const { listSkillAttachments, putSkillAttachment } = await import('./skill-attachments.js');
type Dialect = import('./backends/types.js').Dialect;

const OWNER = 'skill-read-capability-test';
const base: Dialect = {
  defaultCmd: 'echo',
  persistentProcess: false,
  finishMissionOnExit: false,
  sessionResumable: true,
  sessionStore: 'global',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  async buildSpawn(_opts, profile) { return { cmd: profile.cmd, args: [], initialStdin: null }; },
  writeUserInput() { /* one-shot */ },
  parseLine() { return []; },
  extractSessionId() { return null; },
};
for (const [id, capabilities] of [
  ['skills-remote', { worktree: false, timonMcp: false, attachments: false, timonPreamble: false }],
  ['skills-remote-preamble', { worktree: false, timonMcp: false, attachments: false }],
  ['skills-tool-only', { attachments: false }],
  ['skills-file-only', { timonMcp: false }],
] as const) {
  registerDialect(OWNER, id, { ...base, capabilities });
  registerProfile(OWNER, { id, dialect: id, label: id, custom: true, defaultModel: null, models: [] });
}

upsertSkill('read-alpha', '---\nname: read-alpha\ndescription: Alpha reports.\n---\n\n# Alpha\n\nALPHA BODY MARKER\n');
upsertSkill('read-beta', '---\nname: read-beta\ndescription: Beta procedure.\n---\n\n# Beta\n\nBETA BODY MARKER\n');
upsertSkill('read-other', '---\nname: read-other\ndescription: Not for this agent.\n---\n\nOTHER BODY MARKER\n');

function promptOn(name: string, backend: string, skills: string[] = ['read-alpha']): string {
  upsertAgent({ name, system_prompt: '# base\n', config: { backend, memory_scope: 'NONE', skills } });
  const cfg = loadConfig(name);
  return buildEffectivePrompt(name, cfg, getBackend(backend));
}

const CATALOGUE = '# Skills available on demand';
// The prompt names the file with the host's separator.
const skillPath = (id: string) => join('skills', id, 'SKILL.md');

test('no MCP and no disk: the catalogue skill is pasted whole, with no promise of a tool or a path', () => {
  const p = promptOn('read-remote', 'skills-remote');
  assert.match(p, /# Skills you MUST apply/);
  assert.ok(p.includes('# Skill: read-alpha'));
  assert.ok(p.includes('ALPHA BODY MARKER'));
  assert.ok(!p.includes('description: Alpha reports.'), 'pasted as an import: frontmatter stripped');
  assert.ok(!p.includes(CATALOGUE));
  assert.ok(!p.includes('skill_get'), 'a tool this agent was not handed');
  assert.ok(!p.includes('SKILL.md'), 'a file this agent cannot open');
  assert.ok(!p.includes(TIMON_HOME), 'nothing about Timon\'s folders reaches a remote agent');
});

test('the capabilities decide, not the preamble: the same promotion with Timon\'s preamble on', () => {
  const p = promptOn('read-remote-preamble', 'skills-remote-preamble');
  assert.ok(p.includes('ALPHA BODY MARKER'));
  assert.ok(!p.includes(CATALOGUE));
});

test('promotion widens nothing: an excluded or unattached skill does not reach the remote agent', () => {
  const seed = () => upsertAgent({ name: 'read-excl', system_prompt: '# base\n', config: { backend: 'skills-remote', project: 'read-excl-project', memory_scope: 'NONE', skills: ['read-alpha'] } });
  const prompt = () => buildEffectivePrompt('read-excl', loadConfig('read-excl'), getBackend('skills-remote'));
  seed();
  putSkillAttachment({ skill: 'read-beta', scope: 'project', target: 'read-excl-project', mode: 'include', exclude: false });
  assert.ok(prompt().includes('BETA BODY MARKER'), 'inherited from the project: promoted like the others');
  putSkillAttachment({ skill: 'read-beta', scope: 'agent', target: 'read-excl', mode: 'include', exclude: true });
  const p = prompt();
  assert.ok(p.includes('ALPHA BODY MARKER'));
  assert.ok(!p.includes('BETA BODY MARKER'), 'excluded for this agent');
  assert.ok(!p.includes('OTHER BODY MARKER'), 'never attached');
});

test('the attachment keeps its mode: the choice comes back on a backend that can read', () => {
  promptOn('read-keep', 'skills-remote');
  assert.deepEqual(resolveSpawnSkills('read-keep', loadConfig('read-keep')).map((s) => s.mode), ['include']);
  assert.ok(!listSkillAttachments({ scope: 'agent', target: 'read-keep' }).some((a) => a.mode === 'import'));
  const p = promptOn('read-keep', 'claude');
  assert.ok(p.includes('- `read-alpha` — Alpha reports.'));
  assert.ok(!p.includes('ALPHA BODY MARKER'));
});

test('the tool only: a catalogue that names skill_get and no path', () => {
  const p = promptOn('read-tool', 'skills-tool-only');
  assert.ok(p.includes(CATALOGUE));
  assert.ok(p.includes('- `read-alpha` — Alpha reports.'));
  assert.ok(!p.includes('ALPHA BODY MARKER'));
  const heading = p.slice(p.indexOf(CATALOGUE), p.indexOf('- `read-alpha`'));
  assert.match(heading, /read it with the `skill_get` tool \(id\) and apply it\./);
  assert.ok(!heading.includes(skillPath('<id>')));
});

test('the disk only: a catalogue that names the file and no tool', () => {
  const p = promptOn('read-file', 'skills-file-only');
  assert.ok(p.includes(CATALOGUE));
  assert.ok(!p.includes('ALPHA BODY MARKER'));
  const heading = p.slice(p.indexOf(CATALOGUE), p.indexOf('- `read-alpha`'));
  assert.ok(heading.includes(skillPath('<id>')));
  assert.ok(!heading.includes('skill_get'));
});

test('both: the catalogue offers both, as it always did', () => {
  const p = promptOn('read-both', 'claude');
  const heading = p.slice(p.indexOf(CATALOGUE), p.indexOf('- `read-alpha`'));
  assert.match(heading, /read it with the `skill_get` tool \(id\) — or open `.*SKILL\.md` — and apply it\./);
});

test('the injections view tells a promoted skill from a chosen import, on the backend of the mission', () => {
  promptOn('read-view', 'claude', ['read-alpha', 'read-beta']);
  putSkillAttachment({ skill: 'read-beta', scope: 'agent', target: 'read-view', mode: 'import', exclude: false });
  const items = (mission: Parameters<typeof buildInjections>[2]) =>
    buildInjections('read-view', '', mission).blocks.find((b) => b.id === 'skills')!.items;
  const own = items(null);
  assert.deepEqual(own.map((i) => [i.label, i.skill_mode, i.skill_promoted]), [['read-alpha', 'include', false], ['read-beta', 'import', false]]);
  assert.ok((own[0]?.on_demand_tokens ?? 0) > 0);

  const remote = items({ backend_override: 'skills-remote', model_override: null });
  assert.deepEqual(remote.map((i) => [i.label, i.skill_mode, i.skill_promoted]), [['read-alpha', 'import', true], ['read-beta', 'import', false]]);
  const alpha = remote[0]!;
  assert.ok(alpha.content.includes('ALPHA BODY MARKER'));
  assert.equal(alpha.on_demand_tokens, null, 'nothing left to read on demand');
  assert.ok(alpha.tokens > own[0]!.tokens, 'it weighs its body, which is what is sent');
});
