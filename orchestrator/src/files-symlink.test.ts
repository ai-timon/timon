/** A symlink inside an agent's folder never carries a write out of it, nor into `.git` under another name. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-files-symlink-test-'));
const { AGENTS_DIR } = await import('./paths.js');
const files = await import('./files.js');

const work = mkdtempSync(join(tmpdir(), 'timon-files-symlink-cwd-'));
const outside = mkdtempSync(join(tmpdir(), 'timon-files-symlink-out-'));
mkdirSync(join(AGENTS_DIR, 'a'), { recursive: true });
writeFileSync(join(AGENTS_DIR, 'a', 'config.json'), JSON.stringify({ cwd: work }));
mkdirSync(join(work, '.git', 'hooks'), { recursive: true });
writeFileSync(join(work, '.git', 'config'), '[core]\n');
mkdirSync(join(work, 'real'));
writeFileSync(join(work, 'real', 'kept.txt'), 'kept');
mkdirSync(join(work, 'docs'));

// Creating a directory symlink needs a privilege on Windows (or developer
// mode): where it is refused, there is nothing these tests can set up.
let canLink = true;
try {
  symlinkSync(outside, join(work, 'link'), 'dir');
  symlinkSync(join(work, '.git'), join(work, 'alias'), 'dir');
  symlinkSync(join(work, 'real'), join(work, 'inner'), 'dir');
  symlinkSync(join(outside, 'gone'), join(work, 'dangling'), 'file');
} catch {
  canLink = false;
}
const skip = canLink ? false : 'symlinks need a privilege on this machine';

const gitConfig = () => readFileSync(join(work, '.git', 'config'), 'utf8');

test('a write or a mkdir through a link to outside is refused, nothing created there', { skip }, () => {
  assert.throws(() => files.writeAgentFile('a', 'link/new.txt', 'x'), /escapes/);
  assert.throws(() => files.writeAgentFile('a', 'link/sub/new.txt', 'x'), /escapes/);
  assert.throws(() => files.mkdirAgentPath('a', 'link/newdir'), /escapes/);
  assert.deepEqual(readdirSync(outside), []);
});

test('a write through a broken link is refused, its target never created', { skip }, () => {
  assert.throws(() => files.writeAgentFile('a', 'dangling', 'x'), /escapes/);
  assert.throws(() => files.writeAgentFile('a', 'dangling/new.txt', 'x'), /escapes/);
  assert.equal(existsSync(join(outside, 'gone')), false);
});

test('an alias of .git is refused like .git itself', { skip }, () => {
  assert.throws(() => files.writeAgentFile('a', 'alias/config', '[core]\n\tfsmonitor = evil\n'), /refused/);
  assert.throws(() => files.writeAgentFile('a', 'alias/hooks/x', 'x'), /refused/);
  assert.throws(() => files.mkdirAgentPath('a', 'alias/newdir'), /refused/);
  assert.throws(() => files.deleteAgentPath('a', 'alias/hooks'), /refused/);
  assert.throws(() => files.moveAgentPath('a', 'alias/config', 'docs'), /refused/);
  assert.throws(() => files.renameAgentPath('a', 'alias/config', 'other'), /refused/);
  assert.equal(gitConfig(), '[core]\n');
  assert.ok(existsSync(join(work, '.git', 'hooks')));
  assert.equal(existsSync(join(work, '.git', 'hooks', 'x')), false);
  assert.equal(existsSync(join(work, '.git', 'newdir')), false);
});

test('.git itself cannot be deleted, written or renamed into', () => {
  assert.throws(() => files.deleteAgentPath('a', '.git'), /refused/);
  assert.throws(() => files.writeAgentFile('a', 'docs/.git', 'gitdir: /elsewhere\n'), /refused/);
  writeFileSync(join(work, 'docs', 'plain.txt'), '');
  assert.throws(() => files.renameAgentPath('a', 'docs/plain.txt', '.git'), /refused/);
  assert.ok(existsSync(join(work, '.git', 'config')));
});

test('a link to an ordinary folder inside stays usable', { skip }, () => {
  const r = files.writeAgentFile('a', 'inner/new.txt', 'hello');
  assert.equal(r.path, 'real/new.txt');
  assert.equal(readFileSync(join(work, 'real', 'new.txt'), 'utf8'), 'hello');
  assert.equal(files.mkdirAgentPath('a', 'inner/made/deep').path, 'real/made/deep');
  assert.ok(lstatSync(join(work, 'real', 'made', 'deep')).isDirectory());
});

test('moving a link moves the link itself', { skip }, () => {
  assert.deepEqual(files.moveAgentPath('a', 'inner', 'docs'), { kind: 'moved', from: 'inner', path: 'docs/inner' });
  assert.ok(lstatSync(join(work, 'docs', 'inner')).isSymbolicLink());
  assert.equal(readFileSync(join(work, 'real', 'kept.txt'), 'utf8'), 'kept');
  assert.equal(files.renameAgentPath('a', 'docs/inner', 'inner2').path, 'docs/inner2');
  assert.ok(lstatSync(join(work, 'docs', 'inner2')).isSymbolicLink());
});

test('deleting a link removes the link, never the folder it points to', { skip }, () => {
  files.deleteAgentPath('a', 'docs/inner2');
  assert.equal(lstatSync(join(work, 'docs', 'inner2'), { throwIfNoEntry: false }), undefined);
  assert.equal(readFileSync(join(work, 'real', 'kept.txt'), 'utf8'), 'kept');
  // The alias of .git is only a link too: removing it leaves .git alone.
  files.deleteAgentPath('a', 'alias');
  assert.equal(gitConfig(), '[core]\n');
  files.deleteAgentPath('a', 'dangling');
  assert.equal(lstatSync(join(work, 'dangling'), { throwIfNoEntry: false }), undefined);
});
