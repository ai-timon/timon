/**
 * The skills the dispatcher injects into every task (`timon-task`, plus
 * `timon-worktree` in a worktree) and the one the preamble names
 * (`timon-delegate`) must exist on a fresh install: without them a task spawns
 * with neither its closing protocol nor its `allowed_tools`, and the only trace
 * is a warning in the daemon log.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { seedBundledSkills, getSkill, upsertSkill, readSkillsContent, readSkillsAllowedTools, isSystemSkillId } =
  await import('./skills.js');
const { skillDir } = await import('./paths.js');

const IDS = ['timon-task', 'timon-worktree', 'timon-delegate'];
const CLI = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'timon'), 'utf8');

function freshSeed(): void {
  for (const id of IDS) rmSync(skillDir(id), { recursive: true, force: true });
  seedBundledSkills();
}

test('a fresh home gets the three skills, readable by the spawn without a warning', (t) => {
  freshSeed();
  const warn = t.mock.method(console, 'warn', () => {});
  const read = readSkillsContent(IDS);
  assert.deepEqual(read.map((s) => s.id), IDS);
  assert.equal(warn.mock.callCount(), 0);
  for (const id of IDS) assert.equal(isSystemSkillId(id), true, `${id} is reserved to the operator`);
});

test('they carry the tool grants a task relies on, and nothing broader', () => {
  freshSeed();
  assert.deepEqual(readSkillsAllowedTools(['timon-task']), ['Bash(timon:*)']);
  assert.deepEqual(readSkillsAllowedTools(['timon-worktree']), ['Bash(timon:*)', 'Bash(git:*)']);
  assert.deepEqual(readSkillsAllowedTools(['timon-delegate']), []);
});

test('a copy already on disk is never replaced, edited or not', () => {
  freshSeed();
  const edited = `${getSkill('timon-task')!.content}\n<!-- edited by the operator -->\n`;
  upsertSkill('timon-task', edited);
  // An older hand-made copy, front matter included, as installs had before the skill shipped.
  const older = '---\nallowed_tools: ["Bash(timon:*)", "Bash(git:*)"]\n---\n\n# skill: timon-worktree\n\nmy own version\n';
  upsertSkill('timon-worktree', older);
  seedBundledSkills();
  assert.equal(getSkill('timon-task')!.content, edited);
  assert.equal(getSkill('timon-worktree')!.content, older);
});

test('the shipped text holds nothing of the machine it was written on', () => {
  freshSeed();
  for (const id of IDS) {
    const content = getSkill(id)!.content;
    for (const leak of [/\bRom\b/, /\/home\//, /~\/\.timon/, /\.timon-dev/, /pkos/i, /riderfx/, /mail-sentinel/, /adhero/, /[À-ÿ]/]) {
      assert.doesNotMatch(content, leak, `${id} contains ${leak}`);
    }
  }
});

test('the closing protocol is there: done with a comment, block, verdict, full sha, no hand-made chaining', () => {
  freshSeed();
  const task = getSkill('timon-task')!.content;
  for (const needle of ['TASK_ID', 'timon task done', 'timon task block', '--comment-file', '--merged-sha', '40 hex', 'never create a follow-up']) {
    assert.ok(task.includes(needle), `timon-task misses ${needle}`);
  }
  const worktree = getSkill('timon-worktree')!.content;
  assert.match(worktree, /verdict: pass/);
  assert.match(worktree, /verdict: changes_requested/);
  assert.match(worktree, /Do not create the review task/);
  assert.match(worktree, /merge --ff-only/);
  assert.doesNotMatch(worktree, /git checkout <base>/, 'a merger never checks out in the shared repository');
});

/** Every `timon …` command line, with its `\`-continued lines joined. */
function commandLines(content: string): string[] {
  return content.replace(/\\\n\s*/g, ' ').split('\n').filter((l) => /\btimon [a-z]/.test(l));
}

test('every CLI command and flag the skills name exists in the shipped CLI', () => {
  freshSeed();
  let checked = 0;
  for (const id of IDS) {
    for (const line of commandLines(getSkill(id)!.content)) {
      for (const m of line.matchAll(/\btimon ([a-z-]+)(?: ([a-z-]+))?/g)) {
        const words = m[2] ? `timon ${m[1]} ${m[2]}` : `timon ${m[1]}`;
        // A one-word command (`timon spawn <agent>`) or a sub-command (`timon task done`).
        assert.ok(CLI.includes(words) || CLI.includes(`timon ${m[1]} `), `${id}: unknown command "${words}"`);
        checked++;
      }
      for (const [flag] of line.matchAll(/--[a-z][a-z-]*/g)) {
        assert.ok(CLI.includes(flag), `${id}: the CLI has no ${flag} ("${line.trim()}")`);
      }
    }
  }
  assert.ok(checked >= 30, `only ${checked} commands checked`);
});

test('every merge the task and worktree skills prescribe carries the explicit message the daemon uses', async () => {
  const { PRODUCT_SKILLS } = await import('./skills-product.js');
  const { integrateMergeMessage, refreshMergeMessage } = await import('./worktree.js');
  for (const id of ['timon-task', 'timon-worktree']) {
    // Wrapped lines of the skill are joined so a command split over two lines reads whole.
    const text = PRODUCT_SKILLS.find((s) => s.id === id)!.content.replace(/\n\s*/g, ' ');
    const merges = [...text.matchAll(/git merge [^`]*/g)].map((m) => m[0]);
    assert.ok(merges.length > 0, id);
    for (const cmd of merges) assert.match(cmd, / -m "merge: /, `${id}: ${cmd}`);
    assert.ok(text.includes(integrateMergeMessage('<base>')), id);
    assert.ok(text.includes(refreshMergeMessage('<base>')), id);
  }
});
