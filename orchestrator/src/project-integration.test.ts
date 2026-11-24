import './test-home.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { db, dbApi } from './db.js';
import { TIMON_HOME } from './paths.js';
import {
  clearProjectIntegration, DEFAULT_PROJECT_INTEGRATION, ghConfigDirProblem, integrationBaseRef,
  ProjectIntegrationError, readProjectIntegration, updateProjectIntegration,
} from './project-integration.js';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'timon-integration-home-')));
const ghDir = join(home, '.config', 'gh-work');
mkdirSync(ghDir, { recursive: true });
const projectCwd = join(home, 'code', 'acme');
mkdirSync(projectCwd, { recursive: true });

function project(slug: string): string {
  dbApi.upsertProject(slug, { cwd: projectCwd });
  return slug;
}

test('a project nobody configured lands locally, as before', () => {
  const read = readProjectIntegration(project('fresh'));
  assert.equal(read.configured, false);
  assert.deepEqual(read.integration, DEFAULT_PROJECT_INTEGRATION);
  assert.equal(integrationBaseRef(read.integration), 'origin/main');
});

test('a patch merges over the current setting and is stored whole', () => {
  const slug = project('pr-project');
  const written = updateProjectIntegration(slug, { mode: 'pr', account: 'ai-bot', gh_config_dir: ghDir }, { home });
  assert.equal(written.mode, 'pr');
  assert.equal(written.remote, 'origin');
  assert.equal(written.gh_config_dir, ghDir);
  const again = updateProjectIntegration(slug, { branch_prefix: 'sec/', target: 'release' }, { home });
  assert.equal(again.account, 'ai-bot');
  assert.equal(again.branch_prefix, 'sec/');
  const read = readProjectIntegration(slug);
  assert.equal(read.configured, true);
  assert.deepEqual(read.integration, again);
  clearProjectIntegration(slug);
  assert.equal(readProjectIntegration(slug).configured, false);
});

test('the schema refuses what it does not know and what is malformed', () => {
  const slug = project('strict');
  for (const body of [
    { mode: 'local-merge' },
    { mode: 'pr' },
    { forge: 'gitlab' },
    { remote: '-origin' },
    { target: 'main..x' },
    { account: 'bad login!' },
    { branch_prefix: 'feat' },
    { branch_prefix: 'Feat/' },
    { branch_prefix: 'timon/' },
    { branch_prefix: 'a/b/' },
    { extra: true },
  ]) {
    assert.throws(() => updateProjectIntegration(slug, body, { home }), ProjectIntegrationError, JSON.stringify(body));
  }
  assert.equal(readProjectIntegration(slug).configured, false);
});

test('remote_url: an ssh or https push URL is kept, one with credentials or an option is refused', () => {
  const slug = project('remote-url');
  assert.equal(updateProjectIntegration(slug, { remote_url: 'git@github.com:acme/app.git' }, { home }).remote_url, 'git@github.com:acme/app.git');
  assert.equal(updateProjectIntegration(slug, { remote_url: 'https://github.com/acme/app.git' }, { home }).remote_url, 'https://github.com/acme/app.git');
  for (const remote_url of ['https://user:token@github.com/acme/app.git', '--upload-pack=x', 'ext::sh -c x', '']) {
    assert.throws(() => updateProjectIntegration(slug, { remote_url }, { home }), ProjectIntegrationError, remote_url);
  }
  assert.equal(updateProjectIntegration(slug, { remote_url: null }, { home }).remote_url, null);
});

test('a setting stored before remote_url existed still reads, with no push URL', () => {
  const slug = project('older');
  dbApi.setProjectIntegration(slug, JSON.stringify({
    mode: 'pr', remote: 'origin', target: 'main', forge: 'github', account: 'ai-bot', gh_config_dir: null, branch_prefix: 'feat/',
  }));
  const read = readProjectIntegration(slug);
  assert.equal(read.invalid, undefined);
  assert.equal(read.integration.remote_url, null);
  assert.equal(read.integration.account, 'ai-bot');
});

test('a missing project is not_found, not created', () => {
  assert.throws(() => readProjectIntegration('ghost'), (err: unknown) => err instanceof ProjectIntegrationError && err.code === 'not_found');
  assert.throws(() => updateProjectIntegration('ghost', { mode: 'local' }, { home }), (err: unknown) => err instanceof ProjectIntegrationError && err.code === 'not_found');
  assert.equal(dbApi.getProjectRow('ghost'), undefined);
});

test('gh_config_dir: relative, dotted, outside the home or the home itself are refused', () => {
  assert.match(String(ghConfigDirProblem('.config/gh', { home })), /absolute/);
  assert.match(String(ghConfigDirProblem([home, '.config', '..', '..', 'etc'].join(sep), { home })), /"\." or "\.\."/);
  assert.match(String(ghConfigDirProblem(join(tmpdir(), 'elsewhere'), { home })), /inside your home/);
  assert.match(String(ghConfigDirProblem(home, { home })), /inside your home/);
  assert.equal(ghConfigDirProblem(ghDir, { home }), null);
  assert.equal(ghConfigDirProblem(join(home, '.config', 'gh-not-yet'), { home }), null);
});

test('gh_config_dir: a folder an agent can write is refused', () => {
  const insideTimon = join(TIMON_HOME, 'gh');
  assert.match(String(ghConfigDirProblem(insideTimon, { home: TIMON_HOME.replace(/[\\/][^\\/]+$/, '') })), /agent can write/);
  assert.match(String(ghConfigDirProblem(join(projectCwd, '.gh'), { home, projectFolders: [projectCwd] })), /agent can write/);
});

test('gh_config_dir: a link out of the home is refused, a file is refused', () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'timon-integration-out-')));
  const link = join(home, 'gh-link');
  symlinkSync(outside, link, 'dir'); // portability: test-only link, Windows needs dir links
  assert.match(String(ghConfigDirProblem(link, { home })), /inside your home/);
  const file = join(home, 'gh-file');
  writeFileSync(file, '');
  assert.match(String(ghConfigDirProblem(file, { home })), /must be a folder/);
});

test('a project folder cannot become the gh folder through the setting', () => {
  const slug = project('cwd-guard');
  assert.throws(
    () => updateProjectIntegration(slug, { gh_config_dir: join(projectCwd, 'gh') }, { home }),
    /agent can write/,
  );
});

test('a stored value that no longer validates is reported, never passed for local', () => {
  const slug = project('broken');
  db.prepare(`UPDATE projects SET integration = ? WHERE slug = ?`).run('{"mode":"pr"}', slug);
  const read = readProjectIntegration(slug);
  assert.equal(read.configured, true);
  assert.ok(read.invalid);
  db.prepare(`UPDATE projects SET integration = ? WHERE slug = ?`).run('not json', slug);
  assert.match(String(readProjectIntegration(slug).invalid), /JSON/);
  // A write starts again from the default.
  assert.equal(updateProjectIntegration(slug, { mode: 'local' }, { home }).mode, 'local');
  assert.equal(readProjectIntegration(slug).invalid, undefined);
});

test('a meta edit leaves the setting alone', () => {
  const slug = project('meta-edit');
  updateProjectIntegration(slug, { mode: 'pr', account: 'ai-bot' }, { home });
  dbApi.upsertProject(slug, { name: 'Renamed' });
  assert.equal(readProjectIntegration(slug).integration.mode, 'pr');
});
