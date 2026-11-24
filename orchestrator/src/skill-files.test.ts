/**
 * Files next to a skill's SKILL.md (TODO #674): listed and read inside the
 * skill folder only, and announced in the prompt by the way the backend can
 * reach them — Timon's disk, `skill_get`, or pasted under a budget for a
 * backend with neither.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SKILLS_DIR, TIMON_HOME } from './paths.js';
import { foldsCase } from '../tests/helpers/case-folding.js';
import { seal } from './secrets/box.js';
import { resolveMasterKey } from './secrets/key.js';

const { buildEffectivePrompt, loadConfig, upsertAgent } = await import('./agent.js');
await import('../tests/helpers/claude-provider.js');

const { getBackend } = await import('./backends/index.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { upsertSkill } = await import('./skills.js');
const { buildInjections, buildSkillsPreview, skillWeights } = await import('./prompt-injections.js');
const { dbApi } = await import('./db.js');
const {
  listSkillFiles, readSkillFile, remoteSkillFiles, SkillFileError, REMOTE_SKILL_FILES_BUDGET, REMOTE_SKILL_FILES_PROMPT_BUDGET,
} = await import('./skill-files.js');
type Dialect = import('./backends/types.js').Dialect;

const OWNER = 'skill-files-test';
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
  ['files-remote', { worktree: false, timonMcp: false, attachments: false, timonPreamble: false }],
  ['files-tool-only', { attachments: false }],
] as const) {
  registerDialect(OWNER, id, { ...base, capabilities });
  registerProfile(OWNER, { id, dialect: id, label: id, custom: true, defaultModel: null, models: [] });
}

const dir = (id: string) => join(SKILLS_DIR, id);
function put(id: string, rel: string, content: string | Buffer): void {
  const file = join(dir(id), ...rel.split('/'));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

// A skill whose body cites a reference, a script, an image, and hides a secret.
upsertSkill('nb-ref', '---\nname: nb-ref\ndescription: Uses references.\n---\n\nREF BODY. See references/api.md.\n');
put('nb-ref', 'references/api.md', 'API REFERENCE MARKER\n');
put('nb-ref', 'scripts/run.sh', 'echo SCRIPT MARKER\n');
put('nb-ref', 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
put('nb-ref', '.env', 'SECRET=DOTFILE MARKER\n');
put('nb-ref', '.git/config', 'GIT MARKER\n');
// A file outside every skill, reachable only through a link.
writeFileSync(join(TIMON_HOME, 'outside.txt'), 'OUTSIDE MARKER\n');
// A link needs a privilege on Windows (developer mode): without it, those cases are not exercised.
let linked = true;
try {
  symlinkSync(join(TIMON_HOME, 'outside.txt'), join(dir('nb-ref'), 'link.md'), 'file');
  symlinkSync(TIMON_HOME, join(dir('nb-ref'), 'linked-dir'), 'junction');
} catch { linked = false; }

upsertSkill('nb-plain', '---\nname: nb-plain\ndescription: Nothing next to it.\n---\n\nPLAIN BODY\n');

upsertSkill('nb-big', '---\nname: nb-big\ndescription: Big references.\n---\n\nBIG BODY\n');
put('nb-big', 'a-small.md', 'SMALL MARKER\n');
put('nb-big', 'b-huge.md', 'x'.repeat(REMOTE_SKILL_FILES_BUDGET));
put('nb-big', 'c-small.md', 'SECOND SMALL MARKER\n');

test('listSkillFiles: regular visible files, sorted, SKILL.md, dot entries and links left out', () => {
  assert.deepEqual(listSkillFiles('nb-ref').map((f) => f.path), ['logo.png', 'references/api.md', 'scripts/run.sh']);
  assert.deepEqual(listSkillFiles('nb-plain'), []);
  assert.deepEqual(listSkillFiles('..'), [], 'an id naming the parent lists nothing');
  assert.deepEqual(listSkillFiles('missing-skill'), []);
});

test('readSkillFile: a text file of the folder is served', () => {
  assert.deepEqual(readSkillFile('nb-ref', 'references/api.md'), { path: 'references/api.md', content: 'API REFERENCE MARKER\n' });
});

test('readSkillFile refuses every way out of the skill folder', () => {
  const refused = (rel: string, status: number, id = 'nb-ref') => {
    assert.throws(() => readSkillFile(id, rel), (err: unknown) => err instanceof SkillFileError && err.status === status, rel);
  };
  refused('../nb-plain/SKILL.md', 400);
  refused('references/../../nb-plain/SKILL.md', 400);
  refused('/etc/passwd', 400);
  refused('references\\api.md', 400);
  refused('C:/Windows/win.ini', 400);
  refused('.env', 400);
  refused('.git/config', 400);
  refused('references//api.md', 400);
  refused('SKILL.md', 400);
  if (linked) {
    refused('link.md', 404);
    refused('linked-dir/outside.txt', 404);
  }
  refused('references', 404);
  refused('absent.md', 404);
  refused('logo.png', 415);
  refused('api.md', 400, '..');
});

test('remoteSkillFiles: whole text files while they fit, the rest named', () => {
  const ref = remoteSkillFiles('nb-ref');
  assert.deepEqual(ref.pasted.map((f) => f.path), ['references/api.md', 'scripts/run.sh']);
  assert.deepEqual(ref.left_out, [{ path: 'logo.png', reason: 'binary' }]);
  const big = remoteSkillFiles('nb-big');
  assert.deepEqual(big.pasted.map((f) => f.path), ['a-small.md', 'c-small.md'], 'a file is never cut');
  assert.deepEqual(big.left_out, [{ path: 'b-huge.md', reason: 'budget' }]);
});

// `:` is a legal name on a POSIX disk, and one `readSkillFile` refuses: listed, then unreadable, though it is text.
test('remoteSkillFiles: a text file it cannot read is not called binary, and the prompt says so', { skip: process.platform === 'win32' }, () => {
  upsertSkill('nb-odd', '---\nname: nb-odd\ndescription: An odd name.\n---\n\nODD BODY\n');
  put('nb-odd', 'notes:v2.md', 'ODD NAME MARKER\n');
  assert.deepEqual(remoteSkillFiles('nb-odd'), { pasted: [], left_out: [{ path: 'notes:v2.md', reason: 'unreadable' }] });
  const p = promptOn('nb-remote-odd', 'files-remote', ['nb-odd']);
  assert.match(p, /NOT sent \(binary, over the size budget, or unreadable\)[^\n]*`notes:v2\.md`/);
  assert.ok(!p.includes('ODD NAME MARKER'));
});

// Windows cannot hold those names: `:` opens a stream, `\` is a separator.
const POSIX_NAMES = { skip: process.platform === 'win32' };

test('listSkillFiles presents no name readSkillFile refuses, and a way out stays refused', POSIX_NAMES, () => {
  upsertSkill('nb-names', '---\nname: nb-names\ndescription: Odd names.\n---\n\nNAMES BODY\n');
  put('nb-names', 'plain.md', 'PLAIN\n');
  put('nb-names', 'notes:v2.md', 'COLON\n');
  put('nb-names', 'back\\slash.md', 'BACKSLASH\n');
  put('nb-names', 'dir:v2/inner.md', 'COLON FOLDER\n');
  assert.deepEqual(listSkillFiles('nb-names').map((f) => f.path), ['plain.md']);
  for (const rel of ['notes:v2.md', 'back\\slash.md', 'dir:v2/inner.md', '../nb-ref/SKILL.md', '..\\nb-ref\\SKILL.md']) {
    assert.throws(() => readSkillFile('nb-names', rel), (err: unknown) => err instanceof SkillFileError && err.status === 400, rel);
  }
});

// Written against every character, so a guard tightened later cannot leave the listing behind unnoticed.
test('listSkillFiles and readSkillFile agree on every printable character of a name', POSIX_NAMES, () => {
  upsertSkill('nb-chars', '---\nname: nb-chars\ndescription: Every character.\n---\n\nCHARS BODY\n');
  const names: string[] = [];
  // On a volume that folds case `aab.md` is `aAb.md`, written first: the lower letters add nothing there.
  const folds = foldsCase(TIMON_HOME);
  for (let code = 0x20; code <= 0x7e; code++) {
    const char = String.fromCharCode(code);
    if (char === '/' || (folds && char >= 'a' && char <= 'z')) continue;
    names.push(`a${char}b.md`);
    put('nb-chars', `a${char}b.md`, 'TEXT\n');
  }
  const listed = new Set(listSkillFiles('nb-chars').map((f) => f.path));
  for (const name of names) {
    let served = true;
    try {
      readSkillFile('nb-chars', name);
    } catch (err) {
      assert.ok(err instanceof SkillFileError && err.status === 400, name);
      served = false;
    }
    assert.equal(listed.has(name), served, name);
  }
});

test('listSkillFiles stops at the path length readSkillFile serves', POSIX_NAMES, () => {
  upsertSkill('nb-long', '---\nname: nb-long\ndescription: Long paths.\n---\n\nLONG BODY\n');
  const folders = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(100)).join('/');
  const fits = `${folders}/${'f'.repeat(7)}`;
  const over = `${folders}/${'o'.repeat(8)}`;
  assert.equal(fits.length, 512);
  put('nb-long', fits, 'FITS\n');
  put('nb-long', over, 'OVER\n');
  assert.deepEqual(listSkillFiles('nb-long').map((f) => f.path), [fits]);
  assert.equal(readSkillFile('nb-long', fits).content, 'FITS\n');
  assert.throws(() => readSkillFile('nb-long', over), (err: unknown) => err instanceof SkillFileError && err.status === 400);
});

test('an odd name: on the disk a local agent is told of it, a tool agent is not offered it, a remote one knows it lacks it', POSIX_NAMES, async () => {
  const { putSkillAttachment } = await import('./skill-attachments.js');
  upsertSkill('nb-mixed', '---\nname: nb-mixed\ndescription: Mixed names.\n---\n\nMIXED BODY\n');
  put('nb-mixed', 'good.md', 'GOOD MARKER\n');
  put('nb-mixed', 'notes:v2.md', 'ODD MARKER\n');
  for (const name of ['nb-mixed-local', 'nb-mixed-tool', 'nb-mixed-remote']) {
    upsertAgent({ name, system_prompt: '# base\n', config: { memory_scope: 'NONE' } });
    putSkillAttachment({ skill: 'nb-mixed', scope: 'agent', target: name, mode: 'import', exclude: false });
  }
  const local = buildEffectivePrompt('nb-mixed-local', loadConfig('nb-mixed-local'), getBackend('claude'));
  assert.ok(local.includes(`Files next to this skill, in \`${dir('nb-mixed')}\`: \`good.md\`, \`notes:v2.md\`.`));
  const tool = buildEffectivePrompt('nb-mixed-tool', loadConfig('nb-mixed-tool'), getBackend('files-tool-only'));
  assert.ok(tool.includes('Files next to this skill: `good.md`. Read one with the `skill_get` tool'));
  assert.ok(!tool.includes('notes:v2.md'));
  const remote = buildEffectivePrompt('nb-mixed-remote', loadConfig('nb-mixed-remote'), getBackend('files-remote'));
  assert.ok(remote.includes('GOOD MARKER'));
  assert.match(remote, /NOT sent[^\n]*`notes:v2\.md`/);
  assert.ok(!remote.includes('ODD MARKER'));
});

function promptOn(name: string, backend: string, skills: string[]): string {
  upsertAgent({ name, system_prompt: '# base\n', config: { backend, memory_scope: 'NONE', skills } });
  return buildEffectivePrompt(name, loadConfig(name), getBackend(backend));
}

test('no MCP and no disk: the text files are pasted after the body, the binary one named as missing', () => {
  const p = promptOn('nb-remote', 'files-remote', ['nb-ref']);
  assert.ok(p.includes('REF BODY'));
  assert.ok(p.includes('## File `references/api.md`'));
  assert.ok(p.includes('API REFERENCE MARKER'));
  assert.ok(p.includes('SCRIPT MARKER'));
  assert.match(p, /NOT sent[^\n]*`logo\.png`/);
  for (const hidden of ['DOTFILE MARKER', 'GIT MARKER', 'OUTSIDE MARKER']) assert.ok(!p.includes(hidden), hidden);
  assert.ok(!p.includes(TIMON_HOME), 'no path on a disk the remote agent cannot reach');
  assert.ok(!p.includes('skill_get'), 'a tool this agent was not handed');
});

test('no MCP and no disk: past the budget, files are named, never cut', () => {
  const p = promptOn('nb-remote-big', 'files-remote', ['nb-big']);
  assert.ok(p.includes('SMALL MARKER') && p.includes('SECOND SMALL MARKER'));
  assert.ok(!p.includes('x'.repeat(1000)));
  assert.match(p, /NOT sent[^\n]*`b-huge\.md`/);
});

test('a skill with nothing next to it reads as before', () => {
  const p = promptOn('nb-remote-plain', 'files-remote', ['nb-plain']);
  assert.ok(p.includes('PLAIN BODY'));
  assert.ok(!p.includes('Files next to this skill'));
  assert.ok(!p.includes('## File '));
});

test('a catalogue skill on a local backend names no file: its path or skill_get leads to them', () => {
  const p = promptOn('nb-local', 'claude', ['nb-ref']);
  assert.ok(p.includes('- `nb-ref` — Uses references.'));
  assert.ok(!p.includes('API REFERENCE MARKER'));
  assert.ok(!p.includes('Files next to this skill'));
});

test('an imported skill names its files where the backend reaches them', async () => {
  const { putSkillAttachment } = await import('./skill-attachments.js');
  for (const name of ['nb-imp-local', 'nb-imp-tool']) {
    upsertAgent({ name, system_prompt: '# base\n', config: { memory_scope: 'NONE' } });
    putSkillAttachment({ skill: 'nb-ref', scope: 'agent', target: name, mode: 'import', exclude: false });
  }
  const local = buildEffectivePrompt('nb-imp-local', loadConfig('nb-imp-local'), getBackend('claude'));
  assert.ok(local.includes(`Files next to this skill, in \`${dir('nb-ref')}\`: \`logo.png\`, \`references/api.md\`, \`scripts/run.sh\`.`));
  assert.ok(!local.includes('API REFERENCE MARKER'), 'a local agent opens them itself');
  const tool = buildEffectivePrompt('nb-imp-tool', loadConfig('nb-imp-tool'), getBackend('files-tool-only'));
  assert.match(tool, /Files next to this skill: `logo\.png`, `references\/api\.md`, `scripts\/run\.sh`\. Read one with the `skill_get` tool \(id `nb-ref`/);
  assert.ok(!tool.includes(dir('nb-ref')), 'no path on a disk it cannot reach');
  assert.ok(!tool.includes('API REFERENCE MARKER'));
});

test('skillWeights: what a remote backend is sent, and what it is not', () => {
  const w = skillWeights().weights;
  assert.ok(w['nb-ref']!.pasted > w['nb-ref']!.import, 'the pasted references weigh');
  assert.deepEqual(w['nb-ref']!.left_out, ['logo.png']);
  assert.deepEqual(w['nb-big']!.left_out, ['b-huge.md']);
  assert.deepEqual(w['nb-plain']!.left_out, []);
  assert.ok(w['nb-ref']!.on_demand > w['nb-plain']!.on_demand, 'skill_get lists the files after the body');
});

/** A real secret in the real vault, as the redaction reads it. */
function putVaultSecret(name: string, value: string): void {
  const id = randomUUID();
  dbApi.createSecret({ id, name, value_enc: seal(value, resolveMasterKey(), { secretId: id, name }), mode: 'inject' });
}

test('no MCP and no disk: a vault secret in a neighbour file, its name or the body does not leave', () => {
  const value = 'vault-skill-value-0123456789';
  putVaultSecret('NB_SKILL_TOKEN', value);
  upsertSkill('nb-secret', `---\nname: nb-secret\ndescription: Holds a secret.\n---\n\nBODY KEEP MARKER token=${value}\n`);
  put('nb-secret', 'references/config.md', `NEIGHBOUR KEEP MARKER api_key=${value}\n`);
  put('nb-secret', `notes-${value}.md`, 'NAMED KEEP MARKER\n');
  put('nb-secret', `shot-${value}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const p = promptOn('nb-remote-secret', 'files-remote', ['nb-secret']);
  assert.ok(!p.includes(value), 'the value reaches no part of the prompt');
  assert.ok(p.includes('BODY KEEP MARKER token=***'));
  assert.ok(p.includes('NEIGHBOUR KEEP MARKER api_key=***'));
  assert.ok(p.includes('## File `notes-***.md`') && p.includes('NAMED KEEP MARKER'));
  assert.match(p, /NOT sent[^\n]*`shot-\*\*\*\.png`/);
});

test('a skill masked for a remote backend stays marked in the view, and its editor stays closed', () => {
  const value = 'vault-view-value-0123456789';
  putVaultSecret('NB_VIEW_TOKEN', value);
  upsertSkill('nb-secret-body', `---\nname: nb-secret-body\ndescription: Secret body.\n---\n\ntoken=${value}\n`);
  upsertSkill('nb-secret-file', '---\nname: nb-secret-file\ndescription: Secret file.\n---\n\nCLEAN BODY\n');
  put('nb-secret-file', 'config.md', `api_key=${value}\n`);
  upsertSkill('nb-clean', '---\nname: nb-clean\ndescription: Nothing to mask.\n---\n\nCLEAN\n');
  promptOn('nb-remote-view', 'files-remote', ['nb-secret-body', 'nb-secret-file', 'nb-clean']);
  const res = buildInjections('nb-remote-view');
  assert.ok(!JSON.stringify(res).includes(value), 'neither the shown text nor the text an editor loads');
  const block = res.blocks.find((b) => b.id === 'skills')!;
  assert.equal(block.redacted, true);
  assert.equal(block.sent_masked, true, 'the prompt of this backend does not carry the value either');
  const item = (label: string) => block.items.find((it) => it.label === label)!;
  for (const label of ['nb-secret-body', 'nb-secret-file']) {
    assert.equal(item(label).editable, false, label);
    assert.equal(item(label).editable_text, null, label);
  }
  assert.equal(item('nb-clean').editable, true, 'a clean skill of the same block stays editable');
});

test('skillWeights: a file name left out does not carry a vault value, and on_demand weighs what a mission reads', () => {
  const value = 'vault-weights-value-0123456789';
  putVaultSecret('NB_WEIGHTS_TOKEN', value);
  upsertSkill('nb-secret-weight', `---\nname: nb-secret-weight\ndescription: Weighs.\n---\n\ntoken=${value}\n`);
  put('nb-secret-weight', `shot-${value}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const { weights } = skillWeights();
  assert.ok(!JSON.stringify(weights).includes(value));
  assert.deepEqual(weights['nb-secret-weight']!.left_out, ['shot-***.png']);
  // Two ids of the same length: only the masking can make their weights equal.
  upsertSkill('nb-secret-demand', `---\nname: same\ndescription: Weighs.\n---\n\ntoken=${value}\n`);
  upsertSkill('nb-masked-demand', '---\nname: same\ndescription: Weighs.\n---\n\ntoken=***\n');
  const { weights: after } = skillWeights();
  assert.equal(after['nb-secret-demand']!.on_demand, after['nb-masked-demand']!.on_demand);
});

test('a backend that reaches the folder keeps the skill as written: it would read the same value on demand', async () => {
  const { putSkillAttachment } = await import('./skill-attachments.js');
  const value = 'vault-local-value-0123456789';
  putVaultSecret('NB_LOCAL_TOKEN', value);
  upsertSkill('nb-secret-local', `---\nname: nb-secret-local\ndescription: Local secret.\n---\n\ntoken=${value}\n`);
  upsertAgent({ name: 'nb-local-secret', system_prompt: '# base\n', config: { memory_scope: 'NONE' } });
  putSkillAttachment({ skill: 'nb-secret-local', scope: 'agent', target: 'nb-local-secret', mode: 'import', exclude: false });
  const p = buildEffectivePrompt('nb-local-secret', loadConfig('nb-local-secret'), getBackend('claude'));
  assert.ok(p.includes(`token=${value}`));
  const block = buildInjections('nb-local-secret').blocks.find((b) => b.id === 'skills')!;
  assert.equal(block.redacted, true);
  assert.equal(block.sent_masked, false, 'the view must not pass its own masking off as the prompt\'s');
  const skill = block.items.find((it) => it.label === 'nb-secret-local')!;
  assert.ok(!skill.content.includes(value), 'the view masks what it shows');
  assert.equal(skill.editable_text, null);
});

test('no MCP and no disk: several skills share one budget per prompt, what does not fit is named', () => {
  // Each skill fits its own budget; only their sum goes past the prompt's.
  const size = REMOTE_SKILL_FILES_BUDGET - 1024;
  assert.ok(size * 2 < REMOTE_SKILL_FILES_PROMPT_BUDGET && size * 3 > REMOTE_SKILL_FILES_PROMPT_BUDGET);
  const ids = [1, 2, 3].map((n) => `nb-cap-${n}`);
  ids.forEach((id, i) => {
    upsertSkill(id, `---\nname: ${id}\ndescription: Shares the budget.\n---\n\nCAP BODY ${i + 1}\n`);
    put(id, 'a-small.md', `CAP SMALL ${i + 1}\n`);
    put(id, `big-${i + 1}.md`, `CAP BIG ${i + 1}\n`.padEnd(size, 'y'));
  });
  const p = promptOn('nb-remote-cap', 'files-remote', ids);
  for (const n of [1, 2]) assert.ok(p.includes(`CAP BIG ${n}`), `big ${n} fits`);
  assert.ok(!p.includes('CAP BIG 3'), 'past the budget of the prompt, a file is not sent');
  assert.match(p, /NOT sent[^\n]*`big-3\.md`/);
  for (const n of [1, 2, 3]) {
    assert.ok(p.includes(`CAP BODY ${n}`), 'a body is not a neighbour file: it is never held back');
    assert.ok(p.includes(`CAP SMALL ${n}`), 'a smaller file still fits what is left');
  }
  const pasted = Buffer.byteLength(p.split('## File `').slice(1).join(''));
  assert.ok(pasted < REMOTE_SKILL_FILES_PROMPT_BUDGET + 4096, `${pasted} bytes pasted`);

  const again = buildEffectivePrompt('nb-remote-cap', loadConfig('nb-remote-cap'), getBackend('files-remote'));
  assert.ok(again.includes('CAP BIG 1') && again.includes('CAP BIG 2') && !again.includes('CAP BIG 3'), 'the budget is per prompt: the next spawn starts over');
  assert.ok(promptOn('nb-remote-cap-alone', 'files-remote', ['nb-cap-3']).includes('CAP BIG 3'), 'alone, the same file is sent');
});

test('preview: what several skills leave out together is named per skill, with what each really weighs', () => {
  const size = REMOTE_SKILL_FILES_BUDGET - 1024;
  const ids = [1, 2, 3].map((n) => `nb-prev-${n}`);
  ids.forEach((id, i) => {
    upsertSkill(id, `---\nname: ${id}\ndescription: Shares the budget.\n---\n\nPREVIEW BODY ${i + 1}\n`);
    put(id, 'a-small.md', `PREVIEW SMALL ${i + 1}\n`);
    put(id, `big-${i + 1}.md`, `PREVIEW BIG ${i + 1}\n`.padEnd(size, 'y'));
  });
  upsertAgent({ name: 'nb-prev', system_prompt: '# base\n', config: { memory_scope: 'NONE' } });
  const draft = { skills: ids.map((id) => ({ id, mode: 'include' as const })), backend: 'files-remote' };
  const of = (res: ReturnType<typeof buildSkillsPreview>, id: string) => res.skills.find((s) => s.id === id)!;

  const preview = buildSkillsPreview('nb-prev', draft);
  assert.deepEqual(of(preview, 'nb-prev-1').left_out, []);
  assert.deepEqual(of(preview, 'nb-prev-2').left_out, []);
  assert.deepEqual(of(preview, 'nb-prev-3').left_out, ['big-3.md'], 'only their sum goes past the budget of the prompt');
  assert.deepEqual(skillWeights().weights['nb-prev-3']!.left_out, [], 'measured alone, the same skill loses nothing');
  assert.ok(of(preview, 'nb-prev-3').tokens < of(preview, 'nb-prev-1').tokens / 2, 'a file not sent weighs nothing');
  assert.ok(of(preview, 'nb-prev-3').tokens < skillWeights().weights['nb-prev-3']!.pasted / 2);
  assert.deepEqual(buildSkillsPreview(null, draft).skills.map((s) => s.left_out), [[], [], ['big-3.md']], 'an agent not created yet too');

  // The prompt says the same, by the same path.
  const prompt = promptOn('nb-prev-sent', 'files-remote', ids);
  assert.ok(!prompt.includes('PREVIEW BIG 3'));
  assert.match(prompt, /NOT sent[^\n]*`big-3\.md`/);

  const reachable = buildSkillsPreview('nb-prev', { ...draft, backend: 'claude' });
  assert.deepEqual(reachable.skills.map((s) => s.left_out), [[], [], []], 'a backend that reaches the files is not sent a copy to lose');
});

test('preview: a vault value in the name of a file not sent does not come back', () => {
  const value = 'vault-preview-name-0123456789';
  putVaultSecret('NB_PREVIEW_TOKEN', value);
  upsertSkill('nb-prev-secret', '---\nname: nb-prev-secret\ndescription: Secret name.\n---\n\nBODY\n');
  put('nb-prev-secret', `shot-${value}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  upsertAgent({ name: 'nb-prev-masked', system_prompt: '# base\n', config: { memory_scope: 'NONE' } });
  const res = buildSkillsPreview('nb-prev-masked', { skills: [{ id: 'nb-prev-secret', mode: 'include' }], backend: 'files-remote' });
  assert.ok(!JSON.stringify(res).includes(value));
  assert.deepEqual(res.skills.find((s) => s.id === 'nb-prev-secret')!.left_out, ['shot-***.png']);
});
