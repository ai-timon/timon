/**
 * The view of what an agent is injected at spawn.
 *
 * Three things are pinned, in order of what a wrong answer costs:
 *   1. a vault secret never leaves in a block, and a masked block is never
 *      editable (saving the `***` shown would overwrite the real text);
 *   2. the blocks come in the order the model reads them — measured against the
 *      prompt `buildEffectivePrompt` actually builds, not against a list
 *      written down here;
 *   3. each block names the real source to edit.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { agentConfig, agentDir, skillFile, TIMON_HOME } = await import('./paths.js');
const { buildEffectivePrompt, hostOsBullet, loadConfig, skillsBlockHeadings, upsertAgent, setAgentOrchestrates } = await import('./agent.js');
const { estimateTokens } = await import('./summary.js');
const { getBackend } = await import('./backends/index.js');
const { addMemoryRule } = await import('./memory-rule-add.js');
const { upsertSkill } = await import('./skills.js');
const { setRedactionSource } = await import('./secrets/redact.js');
const { buildInjections } = await import('./prompt-injections.js');
const { logDir, readRecentLines } = await import('./log-file.js');
const { invalidateSettingsCache } = await import('./settings.js');

const SECRET = 'vault-secret-value-9f3a2c71';

function seed(name: string, extra: { system?: string; project?: string; cwd?: string; skills?: string[] } = {}): void {
  upsertAgent({
    name,
    system_prompt: extra.system ?? '# base prompt\n',
    config: { role: 'coder', directives: 'my custom directive', project: extra.project, cwd: extra.cwd, skills: extra.skills },
  });
}

{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('blocks follow the order of the effective prompt', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'timon-injections-'));
  writeFileSync(join(cwd, 'AGENTS.md'), 'project rules from the repo\n');
  upsertSkill('inj-skill', '---\nname: inj-skill\n---\nskill body marker\n');
  seed('inj-order', { system: '# system-prompt marker\n', project: 'inj-proj', cwd, skills: ['inj-skill'] });
  writeFileSync(join(agentDir('inj-order'), 'SOUL.md'), 'soul marker\n');
  addMemoryRule({ scope: 'project', project: 'inj-proj', tier: 'core', kind: 'pitfall', text: 'rule marker for order' });

  const view = buildInjections('inj-order');
  const ids = view.blocks.map((b) => b.id);
  assert.deepEqual(ids, [
    'preamble', 'backend', 'soul', 'role', 'directives', 'system-prompt', 'skills', 'memory', 'project-file-AGENTS.md',
  ]);
  assert.deepEqual(view.blocks.map((b) => b.order), ids.map((_, i) => i + 1));

  // Measured, not assumed: every Timon block sits after the previous one in the
  // real prompt; the file a CLI may read is only a candidate, listed after them.
  const prompt = buildEffectivePrompt('inj-order', loadConfig('inj-order'), getBackend(loadConfig('inj-order').backend));
  assert.equal(view.prompt_chars, prompt.length);
  let cursor = 0;
  for (const block of view.blocks.filter((b) => b.injected_by === 'timon')) {
    const at = prompt.indexOf(block.content, cursor);
    assert.ok(at >= cursor, `${block.id} is out of order in the prompt`);
    cursor = at + block.content.length;
  }
  assert.equal(view.blocks.at(-1)?.injected_by, 'cli');
});

test('every block names the real source to edit', () => {
  seed('inj-targets', { project: 'inj-proj-t' });
  writeFileSync(join(agentDir('inj-targets'), 'soul.md'), 'a soul\n');
  const rule = addMemoryRule({ scope: 'project', project: 'inj-proj-t', tier: 'core', kind: 'pitfall', text: 'editable rule text' });
  const blocks = Object.fromEntries(buildInjections('inj-targets').blocks.map((b) => [b.id, b]));

  assert.deepEqual(blocks['system-prompt']!.edit_target, { kind: 'agent_file', agent: 'inj-targets', path: 'system-prompt.md' });
  // The file's real name, not the canonical one: `soul.md` is `soul.md` on disk.
  assert.deepEqual(blocks.soul!.edit_target, { kind: 'agent_file', agent: 'inj-targets', path: 'soul.md' });
  assert.equal(blocks.soul!.editable_text, 'a soul');
  assert.deepEqual(blocks.directives!.edit_target, { kind: 'agent_config', agent: 'inj-targets', field: 'directives' });
  assert.equal(blocks.directives!.editable_text, 'my custom directive');
  assert.equal(blocks.role!.edit_target?.kind, 'agent_role');
  const item = blocks.memory!.items.find((i) => i.content === 'editable rule text');
  assert.ok(item, 'the rule is listed as its own item');
  assert.deepEqual(item.edit_target, { kind: 'memory_rule', rule_id: (rule as { id: number }).id });
  assert.equal(item.editable_text, 'editable rule text');
  // What Timon writes in code is shown, never editable from here.
  assert.equal(blocks.preamble!.editable, false);
  assert.equal(blocks.preamble!.edit_target, null);
});

test('the preamble sends Kanban planning to `kanban_plan`, a one-off decision to `question`', () => {
  seed('inj-forms', { project: 'inj-proj-f' });
  const blocks = Object.fromEntries(buildInjections('inj-forms').blocks.map((b) => [b.id, b.content]));
  const preamble = blocks.preamble!;
  // The line an agent asked to "create Kanban tasks" must find: planner first.
  assert.match(preamble, /Create Kanban tasks, start a job\*\*\s+\| `kanban_plan` \(MCP `timon_ask`\) \*\*first\*\*/);
  assert.match(preamble, /`question` \(MCP `timon_ask`\)/);
  assert.match(preamble, /`mcp__timon_ask__question`/);
  // The former names appear once, to say what they have become — never as the
  // tool to call.
  assert.equal(preamble.match(/mcp__timon_permission__/g)?.length, 2);
  assert.match(preamble, /\*\*Old names\*\*: `mcp__timon_permission__ask_user`[^]*are\s+`question` and `kanban_plan`/);
  assert.doesNotMatch(preamble.replace(/\*\*Old names\*\*:[^]*?Call the new names\./, ''), /ask_user|ask_series_plan|timon_permission/);
});

test('TIMON_LOG_SYSTEM_PROMPT writes the prompt masked, and the model still gets it as written', () => {
  const previous = setRedactionSource(() => [SECRET]);
  process.env.TIMON_LOG_SYSTEM_PROMPT = '1';
  invalidateSettingsCache();
  try {
    seed('inj-log', { system: `# prompt\nlog-key=${SECRET}\n` });
    const prompt = buildEffectivePrompt('inj-log', loadConfig('inj-log'), getBackend(loadConfig('inj-log').backend));
    assert.ok(prompt.includes(`log-key=${SECRET}`), 'the prompt sent to the model is not masked');
    const logged = readRecentLines(logDir(TIMON_HOME), 'prompts', 100_000).join('\n');
    assert.ok(logged.includes('log-key=***'), 'the prompt reached the log');
    assert.ok(!logged.includes(SECRET));
  } finally {
    delete process.env.TIMON_LOG_SYSTEM_PROMPT;
    invalidateSettingsCache();
    setRedactionSource(previous);
  }
});

test('a vault secret is masked everywhere, and a masked block cannot be edited', () => {
  const previous = setRedactionSource(() => [SECRET]);
  try {
    seed('inj-secret', { system: `# prompt\nkey=${SECRET}\n`, project: 'inj-proj-s' });
    addMemoryRule({ scope: 'project', project: 'inj-proj-s', tier: 'core', kind: 'pitfall', text: `never print ${SECRET} again` });
    addMemoryRule({ scope: 'project', project: 'inj-proj-s', tier: 'core', kind: 'pitfall', text: 'a clean rule' });
    const view = buildInjections('inj-secret');

    assert.ok(!JSON.stringify(view).includes(SECRET), 'the secret appears nowhere in the response');
    const sys = view.blocks.find((b) => b.id === 'system-prompt')!;
    assert.match(sys.content, /key=\*\*\*/);
    assert.equal(sys.redacted, true);
    assert.equal(sys.sent_masked, false, 'the prompt carries it as written');
    assert.equal(sys.editable, false, 'saving the masked text would overwrite the real file');
    assert.equal(sys.editable_text, null);

    const memory = view.blocks.find((b) => b.id === 'memory')!;
    const leaky = memory.items.find((i) => i.content.includes('never print'))!;
    assert.equal(leaky.editable, false);
    assert.equal(leaky.editable_text, null);
    const clean = memory.items.find((i) => i.content === 'a clean rule')!;
    assert.equal(clean.editable, true, 'a rule without a secret stays editable');
  } finally {
    setRedactionSource(previous);
  }
});

test('every block traces its origin, its file and its tokens', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'timon-injections-origin-'));
  writeFileSync(join(cwd, 'AGENTS.md'), 'project rules\n');
  upsertSkill('inj-skill-o', '---\nname: inj-skill-o\n---\nskill body\n');
  seed('inj-origin', { system: '# sp\n', project: 'inj-proj-o', cwd, skills: ['inj-skill-o'] });
  writeFileSync(join(agentDir('inj-origin'), 'SOUL.md'), 'soul\n');
  addMemoryRule({ scope: 'project', project: 'inj-proj-o', tier: 'core', kind: 'pitfall', text: 'rule for origin' });

  const view = buildInjections('inj-origin');
  const blocks = Object.fromEntries(view.blocks.map((b) => [b.id, b]));
  assert.equal(blocks.preamble!.origin, 'timon');
  assert.equal(blocks.preamble!.source_path, null);
  assert.equal(blocks.soul!.origin, 'agent');
  assert.equal(blocks.soul!.source_path, join(agentDir('inj-origin'), 'SOUL.md'));
  assert.equal(blocks['system-prompt']!.origin, 'agent');
  assert.equal(blocks.memory!.origin, 'memory');
  assert.equal(blocks.skills!.origin, 'skills');
  assert.equal(blocks.skills!.items[0]!.source_path, skillFile('inj-skill-o'));
  // Read by the CLI, but it belongs to the project: the origin says so.
  assert.equal(blocks['project-file-AGENTS.md']!.origin, 'project');
  assert.equal(blocks['project-file-AGENTS.md']!.injected_by, 'cli');
  assert.equal(blocks['project-file-AGENTS.md']!.source_path, join(cwd, 'AGENTS.md'));
  for (const b of view.blocks) assert.equal(b.tokens, Math.ceil(b.content.length / 4));
  assert.ok(view.prompt_tokens > 0);
});

test('the agent\'s other .md files are sent after SOUL.md, in name order, each editable on its own', () => {
  seed('inj-docs', { project: 'inj-proj-d' });
  writeFileSync(join(agentDir('inj-docs'), 'SOUL.md'), 'soul marker\n');
  writeFileSync(join(agentDir('inj-docs'), 'rules.md'), 'rules marker\n');
  writeFileSync(join(agentDir('inj-docs'), 'charter.md'), 'charter marker\n');
  writeFileSync(join(agentDir('inj-docs'), 'empty.md'), '  \n');

  const view = buildInjections('inj-docs');
  const ids = view.blocks.map((b) => b.id);
  assert.ok(ids.indexOf('soul') < ids.indexOf('docs') && ids.indexOf('docs') < ids.indexOf('role'), 'docs sit between SOUL.md and the role');
  const docs = view.blocks.find((b) => b.id === 'docs')!;
  assert.equal(docs.origin, 'agent');
  assert.deepEqual(docs.items.map((i) => i.label), ['charter.md', 'rules.md'], 'sorted by name, empty and reserved files left out');
  assert.deepEqual(docs.items[1]!.edit_target, { kind: 'agent_file', agent: 'inj-docs', path: 'rules.md' });
  assert.equal(docs.items[1]!.source_path, join(agentDir('inj-docs'), 'rules.md'));

  const prompt = buildEffectivePrompt('inj-docs', loadConfig('inj-docs'), getBackend(loadConfig('inj-docs').backend));
  assert.ok(prompt.indexOf('soul marker') < prompt.indexOf('charter marker'));
  assert.ok(prompt.indexOf('charter marker') < prompt.indexOf('rules marker'));
  assert.ok(prompt.indexOf('rules marker') < prompt.indexOf('# Role'));
  assert.equal(view.prompt_chars, prompt.length);
});

test('the preamble is English, holds no user-specific path or convention, and gates optional sections', () => {
  seed('inj-pre', { project: 'inj-proj-pre' });
  const preamble = buildInjections('inj-pre').blocks.find((b) => b.id === 'preamble')!.content;
  assert.doesNotMatch(preamble, /[éèêàâûîôçÉÈÀ]/, 'no French left'); // french-ok: the letters that betray French
  assert.doesNotMatch(preamble, /webdev|agentic-os|Rom\b|brain²|TIMON_BRAIN_VAULT|npm test|Co-Authored-By/, 'nothing that belongs to one user');
  assert.doesNotMatch(preamble, /Knowledge vault|Code index/, 'optional sections absent without a vault or an index');

  // A project with a local index gets the grepai section, a configured vault its own.
  const cwd = mkdtempSync(join(tmpdir(), 'timon-preamble-'));
  mkdirSync(join(cwd, '.grepai'));
  upsertAgent({ name: 'inj-pre-idx', system_prompt: '# x\n', config: { role: 'coder', cwd } });
  const indexed = buildInjections('inj-pre-idx').blocks.find((b) => b.id === 'preamble')!.content;
  assert.match(indexed, /Code index/);
});

test('the preamble names the real Timon home, absolute and with the OS separator, and never a tilde', async () => {
  seed('inj-paths', { project: 'inj-proj-paths' });
  const preamble = buildInjections('inj-paths').blocks.find((b) => b.id === 'preamble')!.content;
  const { TIMON_HOME } = await import('./paths.js');
  assert.ok(preamble.includes(join(TIMON_HOME, 'timon.db')), 'the database path is the resolved one');
  assert.ok(preamble.includes(join(TIMON_HOME, 'agents', '<name>')));
  assert.doesNotMatch(preamble, /~[\\/]/, 'no unresolved tilde path');
  assert.match(preamble, /\*\*Host OS\*\*: (Linux|macOS|Windows)/);
});

test('on Windows the Host OS bullet forbids && and || for PowerShell 5.1 (TIM-0085), other OSes are untouched', () => {
  const windows = hostOsBullet('win32');
  assert.match(windows, /\*\*Host OS\*\*: Windows\./);
  assert.match(windows, /Windows PowerShell 5\.1/);
  assert.match(windows, /`&&` and `\|\|` are a parse error/);
  assert.match(windows, /chain\s+commands with `;`/);
  assert.match(windows, /`Set-Location <path>; <cmd>`/);
  for (const platform of ['linux', 'darwin'] as const) {
    assert.doesNotMatch(hostOsBullet(platform), /PowerShell|&&/, `${platform} gets no PowerShell guidance`);
  }
  assert.equal(hostOsBullet('darwin').split('\n').length, 1);
});

test('only an agent that can hand work to others reads the parallel-split section', () => {
  seed('inj-coder', { project: 'inj-proj-c' });
  upsertAgent({ name: 'inj-boss', system_prompt: '# b\n', config: { role: 'orchestrator' } });
  upsertAgent({ name: 'inj-lead', system_prompt: '# l\n', config: { role: 'coder' } });
  setAgentOrchestrates('inj-lead', ['inj-coder']);
  const of = (name: string) => buildInjections(name).blocks.find((b) => b.id === 'preamble')!.content;
  assert.doesNotMatch(of('inj-coder'), /## Parallel split/, 'a coder does not read it');
  assert.match(of('inj-boss'), /## Parallel split/);
  assert.match(of('inj-lead'), /## Parallel split/, 'a delegation list is enough');
  // Groups of volets (TODO #433): when to propose one, and still no model names from the agent.
  assert.match(of('inj-boss'), /"volets": \[ \{ "title",\s+"description", "group"\? \}/);
  assert.match(of('inj-boss'), /volets differ in difficulty, give each a short `group` name/);
  assert.match(of('inj-boss'), /still no model names from you/);
  // What every agent needs to reach the planner stays in the table they all read.
  assert.match(of('inj-coder'), /`kanban_plan` \(MCP `timon_ask`\) \*\*first\*\*/);
  assert.ok(of('inj-coder').length < 15_000, 'the standard preamble stays short');
});

test('the global instructions reach every agent right after the backend block, editable as the file', async () => {
  const { GLOBAL_INSTRUCTIONS_FILE } = await import('./paths.js');
  seed('inj-global', { project: 'inj-proj-g' });
  writeFileSync(join(agentDir('inj-global'), 'SOUL.md'), 'soul marker\n');
  assert.ok(!buildInjections('inj-global').blocks.some((b) => b.id === 'global-instructions'), 'no file, no block');

  writeFileSync(GLOBAL_INSTRUCTIONS_FILE, '  Answer in French.\n\nNo attribution in commits.  \n');
  try {
    const view = buildInjections('inj-global');
    const ids = view.blocks.map((b) => b.id);
    assert.equal(ids.indexOf('global-instructions'), ids.indexOf('backend') + 1, 'after the backend block');
    assert.ok(ids.indexOf('global-instructions') < ids.indexOf('soul'), 'before the identity of the agent');
    const block = view.blocks.find((b) => b.id === 'global-instructions')!;
    assert.equal(block.origin, 'user');
    assert.equal(block.source_path, GLOBAL_INSTRUCTIONS_FILE);
    assert.deepEqual(block.edit_target, { kind: 'global_instructions' });
    assert.equal(block.editable_text, '  Answer in French.\n\nNo attribution in commits.  \n', 'the editor loads the file as it is');
    const prompt = buildEffectivePrompt('inj-global', loadConfig('inj-global'), getBackend(loadConfig('inj-global').backend));
    assert.ok(prompt.includes('# Global instructions\n\nAnswer in French.\n\nNo attribution in commits.\n'));
    assert.equal(view.prompt_chars, prompt.length);
  } finally {
    rmSync(GLOBAL_INSTRUCTIONS_FILE, { force: true });
  }
});

test('the backend block follows the mission overrides, not only the agent config', () => {
  seed('inj-override', { project: 'inj-proj-o' });
  const own = buildInjections('inj-override').blocks.find((b) => b.id === 'backend')!.content;
  const over = buildInjections('inj-override', '', { backend_override: 'codex', model_override: 'gpt-x' })
    .blocks.find((b) => b.id === 'backend')!.content;
  assert.match(over, /Your LLM backend \(`codex`\)/);
  assert.match(over, /`gpt-x` via `codex`/);
  assert.notEqual(over, own);
});

// TODO #241. codex nests MCP tools under `exec` as `mcp__timon_browser__*`
// (underscores) while its own web search sits at the top level: told only
// "the `timon-browser` MCP tools", GPT opened pages with web search instead
// of Timon's browser in half the runs measured on codex-cli 0.159.
test('a codex agent is told how to reach Timon\'s browser and that web search is not it', () => {
  seed('inj-browser', { project: 'inj-proj-b' });
  const block = (backend: string): string => buildInjections('inj-browser', '', { backend_override: backend, model_override: 'm' })
    .blocks.find((b) => b.id === 'backend')!.content;
  const codex = block('codex');
  assert.match(codex, /tools\.mcp__timon_browser__navigate_page/);
  assert.match(codex, /web search/i);
  // claude names its tools after the server key, the preamble already matches.
  assert.doesNotMatch(block('claude'), /mcp__timon_browser__/);
});

test('the skills block shows the skills the mission adds, as the spawn merges them', () => {
  upsertSkill('inj-own-skill', '---\nname: inj-own-skill\n---\nown body\n');
  upsertSkill('inj-task-skill', '---\nname: inj-task-skill\n---\ntask body\n');
  seed('inj-extra', { project: 'inj-proj-x', skills: ['inj-own-skill'] });
  const items = (extra: string | null | undefined): string[] =>
    (buildInjections('inj-extra', '', { backend_override: null, model_override: null, extra_skills: extra })
      .blocks.find((b) => b.id === 'skills')?.items ?? []).map((i) => i.label);
  assert.deepEqual(items(JSON.stringify(['inj-task-skill', 'inj-own-skill'])), ['inj-task-skill', 'inj-own-skill'], 'forced skills of the mission come first, deduplicated');
  assert.deepEqual(items(null), ['inj-own-skill']);
  assert.deepEqual(items('{not json'), ['inj-own-skill'], 'malformed JSON adds nothing');
  assert.deepEqual((buildInjections('inj-extra').blocks.find((b) => b.id === 'skills')?.items ?? []).map((i) => i.label), ['inj-own-skill']);
});

test('mergeMissionSkills: the one merge the spawn and the view share', async () => {
  const { mergeMissionSkills } = await import('./agent.js');
  assert.deepEqual(mergeMissionSkills(['a'], '["b","a"]'), ['a', 'b']);
  assert.deepEqual(mergeMissionSkills(undefined, '["b"]'), ['b']);
  assert.equal(mergeMissionSkills(undefined, null), undefined);
  assert.deepEqual(mergeMissionSkills(['a'], 'oops'), ['a']);
  assert.deepEqual(mergeMissionSkills(['a'], '"b"'), ['a'], 'a non-array is malformed, not spread into characters');
  assert.deepEqual(mergeMissionSkills(['a'], '["b", 3]'), ['a', 'b']);
});

test('a skill weighs what its mode sends; a catalogue skill shows what reading it would cost', async () => {
  const { putSkillAttachment } = await import('./skill-attachments.js');
  const { skillWeights } = await import('./prompt-injections.js');
  const body = 'Step one of a long procedure. '.repeat(80);
  upsertSkill('inj-w-cat', `---\nname: inj-w-cat\ndescription: Read me when needed.\n---\n\n${body}\n`);
  upsertSkill('inj-w-imp', `---\nname: inj-w-imp\ndescription: Always on.\n---\n\n${body}\n`);
  seed('inj-weights', { project: 'inj-proj-w', skills: ['inj-w-cat', 'inj-w-imp'] });
  putSkillAttachment({ skill: 'inj-w-imp', scope: 'agent', target: 'inj-weights', mode: 'import', exclude: false });

  const res = buildInjections('inj-weights');
  const block = res.blocks.find((b) => b.id === 'skills')!;
  const cat = block.items.find((i) => i.label === 'inj-w-cat')!;
  const imp = block.items.find((i) => i.label === 'inj-w-imp')!;
  assert.equal(cat.skill_mode, 'include');
  assert.ok(cat.tokens < 30, `a catalogue line, not the body (${cat.tokens})`);
  assert.ok(imp.tokens > 500, `the body pasted whole (${imp.tokens})`);
  // What skill_get returns: the id, then the whole file.
  assert.ok(cat.on_demand_tokens! > imp.tokens, 'reading the body costs the file, front-matter included');
  assert.equal(imp.on_demand_tokens, null, 'an imported skill is already paid');
  assert.equal(res.on_demand_tokens, cat.on_demand_tokens);
  // Information only: the total stays the prompt of the spawn.
  const prompt = buildEffectivePrompt('inj-weights', loadConfig('inj-weights'), getBackend(loadConfig('inj-weights').backend));
  assert.equal(res.prompt_tokens, Math.ceil(prompt.length / 4));

  const { weights, headings } = skillWeights();
  assert.deepEqual(weights['inj-w-cat'], {
    include: cat.tokens, import: weights['inj-w-cat']!.import, on_demand: cat.on_demand_tokens,
    pasted: weights['inj-w-cat']!.import, left_out: [],
  });
  assert.equal(weights['inj-w-imp']!.import, imp.tokens);
  // The block is its headings plus its pieces, which is what each entry shows, within rounding.
  const summed = headings.include + headings.import + cat.tokens + imp.tokens;
  assert.ok(summed >= block.tokens && summed <= block.tokens + 4, `${summed} vs ${block.tokens}`);
});

/**
 * The dry run is only worth its name if a real save lands on the same prompt:
 * each case below writes what the editor's Save writes, then compares with the
 * saved view and the spawn's own text. A client calculation failed all of them.
 */
async function savedLikeThePreview(
  agent: string,
  draft: { id: string; mode: 'include' | 'import' }[],
  over: { role?: string; project?: string } = {},
): Promise<{ preview: import('./prompt-injections.js').SkillsPreviewResponse; saved: ReturnType<typeof buildInjections> }> {
  const { buildSkillsPreview } = await import('./prompt-injections.js');
  const { deleteSkillAttachment, listSkillAttachments, putSkillAttachment } = await import('./skill-attachments.js');
  const before = listSkillAttachments();
  const preview = buildSkillsPreview(agent, { skills: draft, ...over });
  assert.deepEqual(listSkillAttachments(), before, 'a preview writes nothing');
  const cfg = loadConfig(agent);
  upsertAgent({ name: agent, system_prompt: '# base prompt\n', config: { ...cfg, ...over } });
  const own = listSkillAttachments({ scope: 'agent', target: agent });
  for (const s of draft) {
    if (!own.some((a) => a.skill === s.id && a.exclude)) putSkillAttachment({ skill: s.id, scope: 'agent', target: agent, mode: s.mode, exclude: false });
  }
  for (const a of own) if (!a.exclude && !draft.some((s) => s.id === a.skill)) deleteSkillAttachment(a.id);
  return { preview, saved: buildInjections(agent) };
}

function assertSameAsSaved(res: Awaited<ReturnType<typeof savedLikeThePreview>>, agent: string): void {
  const block = res.saved.blocks.find((b) => b.id === 'skills');
  assert.equal(res.preview.prompt_tokens, res.saved.prompt_tokens, 'the total is the prompt a save leads to');
  assert.equal(res.preview.skills_tokens, block?.tokens ?? 0);
  assert.equal(res.preview.on_demand_tokens, res.saved.on_demand_tokens);
  assert.deepEqual(
    res.preview.skills.map((s) => `${s.id}:${s.mode}:${s.via}`),
    (block?.items ?? []).map((i) => `${i.label}:${i.skill_mode}:${i.skill_via}`),
  );
  const cfg = loadConfig(agent);
  assert.equal(res.preview.prompt_tokens, estimateTokens(buildEffectivePrompt(agent, cfg, getBackend(cfg.backend))));
}

const PREVIEW_BODY = 'Follow this procedure with care. '.repeat(60);
for (const id of ['prev-own', 'prev-wide', 'prev-role']) {
  upsertSkill(id, `---\nname: ${id}\ndescription: ${id} line.\n---\n\n${PREVIEW_BODY}\n`);
}

test('preview: a checked skill the agent excludes is not counted, and is named', async () => {
  const { putSkillAttachment } = await import('./skill-attachments.js');
  seed('prev-excl', { project: 'prev-p1' });
  putSkillAttachment({ skill: 'prev-own', scope: 'agent', target: 'prev-excl', mode: 'include', exclude: true });
  const res = await savedLikeThePreview('prev-excl', [{ id: 'prev-own', mode: 'import' }]);
  assert.deepEqual(res.preview.skills, []);
  assert.deepEqual(res.preview.excluded, ['prev-own']);
  assertSameAsSaved(res, 'prev-excl');
});

test('preview: unchecking a skill that narrowed an inherited one brings the inherited one back', async () => {
  const { putSkillAttachment } = await import('./skill-attachments.js');
  seed('prev-shadow', { project: 'prev-p2' });
  putSkillAttachment({ skill: 'prev-wide', scope: 'project', target: 'prev-p2', mode: 'import', exclude: false });
  putSkillAttachment({ skill: 'prev-wide', scope: 'agent', target: 'prev-shadow', mode: 'include', exclude: false });
  const res = await savedLikeThePreview('prev-shadow', []);
  assert.deepEqual(res.preview.skills.map(({ id, mode, via, left_out }) => ({ id, mode, via, left_out })), [{ id: 'prev-wide', mode: 'import', via: 'project', left_out: [] }]);
  assert.ok(res.preview.skills_tokens > 400, `the inherited body is paid again (${res.preview.skills_tokens})`);
  assertSameAsSaved(res, 'prev-shadow');
});

test('preview: a checked skill lifts an exclusion from a wider scope, and takes the place of an inherited mode', async () => {
  const { putSkillAttachment } = await import('./skill-attachments.js');
  seed('prev-lift', { project: 'prev-p3', role: 'coder' });
  putSkillAttachment({ skill: 'prev-role', scope: 'project', target: 'prev-p3', mode: 'include', exclude: true });
  putSkillAttachment({ skill: 'prev-wide', scope: 'project', target: 'prev-p3', mode: 'import', exclude: false });
  const res = await savedLikeThePreview('prev-lift', [{ id: 'prev-role', mode: 'include' }, { id: 'prev-wide', mode: 'include' }]);
  assert.deepEqual(res.preview.skills.map((s) => `${s.id}:${s.mode}:${s.via}`).sort(), ['prev-role:include:agent', 'prev-wide:include:agent']);
  assertSameAsSaved(res, 'prev-lift');
});

test('preview: a role or project changed in the draft brings its own attachments', async () => {
  const { putSkillAttachment } = await import('./skill-attachments.js');
  seed('prev-move', { project: 'prev-p4', role: 'coder' });
  putSkillAttachment({ skill: 'prev-role', scope: 'role', target: 'reviewer', mode: 'import', exclude: false });
  putSkillAttachment({ skill: 'prev-wide', scope: 'project', target: 'prev-p5', mode: 'include', exclude: false });
  const res = await savedLikeThePreview('prev-move', [], { role: 'reviewer', project: 'prev-p5' });
  assert.deepEqual(res.preview.skills.map((s) => `${s.id}:${s.via}`).sort(), ['prev-role:role', 'prev-wide:project']);
  assertSameAsSaved(res, 'prev-move');
});

test('preview: an old config.skills is not read any more, a mode change moves the total', async () => {
  const { buildSkillsPreview } = await import('./prompt-injections.js');
  seed('prev-cfg', { project: 'prev-p6' });
  // A config.json not migrated yet (imported, restored): only the next boot or
  // write moves its skills to attachments; until then the spawn has none.
  writeFileSync(agentConfig('prev-cfg'), JSON.stringify({ ...loadConfig('prev-cfg'), skills: ['prev-own'] }));
  assert.deepEqual(buildInjections('prev-cfg').blocks.find((b) => b.id === 'skills')?.items ?? [], []);
  const catalogue = buildSkillsPreview('prev-cfg', { skills: [{ id: 'prev-own', mode: 'include' }] });
  const imported = buildSkillsPreview('prev-cfg', { skills: [{ id: 'prev-own', mode: 'import' }] });
  const none = buildSkillsPreview('prev-cfg', { skills: [] });
  assert.ok(imported.prompt_tokens! > catalogue.prompt_tokens! + 300);
  assert.ok(catalogue.prompt_tokens! > none.prompt_tokens!);
  assert.equal(none.skills_tokens, 0);
  assert.ok(catalogue.on_demand_tokens > 0);
  assert.equal(imported.on_demand_tokens, 0, 'an imported skill costs no read');
});

test('preview: a draft system prompt counts, without being written', async () => {
  const { buildSkillsPreview } = await import('./prompt-injections.js');
  seed('prev-sys', { project: 'prev-p7' });
  const saved = buildInjections('prev-sys');
  const longer = buildSkillsPreview('prev-sys', { skills: [], system_prompt: 'x'.repeat(4000) });
  assert.ok(longer.prompt_tokens! >= saved.prompt_tokens + 900);
  assert.equal(buildInjections('prev-sys').prompt_tokens, saved.prompt_tokens);
});

test('preview: an agent not created yet gets its wider attachments, and no total', async () => {
  const { buildSkillsPreview } = await import('./prompt-injections.js');
  const { putSkillAttachment } = await import('./skill-attachments.js');
  putSkillAttachment({ skill: 'prev-wide', scope: 'project', target: 'prev-p8', mode: 'include', exclude: false });
  const res = buildSkillsPreview(null, { skills: [{ id: 'prev-own', mode: 'include' }], project: 'prev-p8', role: 'coder' });
  assert.deepEqual(res.skills.map((s) => `${s.id}:${s.via}`), ['prev-wide:project', 'prev-own:agent']);
  assert.equal(res.prompt_tokens, null);
  assert.ok(res.skills_tokens > 0);
  assert.equal(res.agent, null);
});
