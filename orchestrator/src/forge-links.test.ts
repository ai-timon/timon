/**
 * The way back between a job, its ideas, their issues and its pull request:
 * computed through the caller's scope, our links kept apart from the ones a
 * pull request's author claims.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dbApi, type DbViewer } from './db.js';
import {
  githubIssueRef, parseGithubIssueRef, pullRequestLinks, repoOfPullRequestUrl, withJobLinks,
  GITHUB_ISSUE_PROVIDER, LINKED_TODO_TEXT_LIMIT,
} from './forge-links.js';
import { integrationView, listIntegrationViews } from './integration-preview.js';

const PROJECT = 'forge-links';
const OWNER: DbViewer = { id: 'owner-a', isSuperadmin: false, permissions: [] };
const STRANGER: DbViewer = { id: 'owner-b', isSuperadmin: false, permissions: [] };
const ADMIN: DbViewer = { id: 'admin', isSuperadmin: true, permissions: [] };

// The series is the mission that planned it; a remap made `PILOT` its pilot now.
const SERIES = randomUUID();
const PILOT = randomUUID();
dbApi.createMission(SERIES, 'acme.main', 'plan the job', undefined, 'owner-a');
dbApi.createMission(PILOT, 'acme.main', 'took the helm', undefined, 'owner-a');

const row = dbApi.recordIntegration({
  repo: '/repos/app', branch: 'feat/links', remote: 'origin', target: 'main', mode: 'pr', project: PROJECT, seriesId: SERIES,
});
dbApi.markIntegrationOpen(row.id, { number: 51, url: 'https://github.com/acme/app/pull/51', headSha: 'a'.repeat(40) });
dbApi.setIntegrationChecks(row.id, JSON.stringify({
  read_at: 1, state: 'open', draft: false, mergeable: 'mergeable', review: null, title: 'Links', body: '', items: [],
  // `repo: null`: the forge left it out, the pull request's own repository is meant.
  closing_issues: [{ repo: 'acme/app', number: 212, url: 'https://github.com/acme/app/issues/212' }, { repo: null, number: 300, url: null }],
}));

function idea(text: string, owner: string): number {
  return dbApi.insertProjectTodo({ text, project: PROJECT, ownerUserId: owner }).id;
}
function link(todo: number, ref: string): void {
  dbApi.putTodoExternalRef({ todoId: todo, provider: GITHUB_ISSUE_PROVIDER, ref, url: `https://github.com/${ref.replace('#', '/issues/')}`, label: null, pluginId: null });
}
function task(todo: number | null, owner: string, branch = 'feat/links'): void {
  const id = randomUUID();
  dbApi.createTask(id, `work on ${branch}`, 'acme.coder', {
    type: 'code', project: PROJECT, baseBranch: branch, integrationMode: 'pr', baseRef: 'origin/main',
    seriesId: SERIES, creatorMissionId: PILOT, ownerUserId: owner,
  });
  if (todo !== null) dbApi.setTaskTodoId(id, todo);
}

const ours = idea('Fix the export', 'owner-a');
link(ours, 'acme/app#212');
link(ours, 'acme/app#213');
// Imported by its owner with another case: the forge's names ignore it.
const imported = idea('Crash on import', 'owner-a');
link(imported, 'ACME/App#300');
const hidden = idea('Someone else', 'owner-b');
task(ours, 'owner-a');
task(ours, 'owner-a');
task(null, 'owner-a');
task(hidden, 'owner-b');

test('a link ref names an issue, or nothing', () => {
  assert.deepEqual(parseGithubIssueRef('acme/app#212'), { repo: 'acme/app', number: 212 });
  assert.equal(githubIssueRef('acme/app', 9), 'acme/app#9');
  for (const bad of ['acme#1', 'acme/app#0', 'acme/app#x', '../app#1', 'acme/app/x#1', 'acme/app#1x']) {
    assert.equal(parseGithubIssueRef(bad), null, bad);
  }
  assert.equal(repoOfPullRequestUrl('https://github.com/acme/app/pull/51'), 'acme/app');
  assert.equal(repoOfPullRequestUrl('https://example.com/acme/app/pull/51'), null);
  assert.equal(repoOfPullRequestUrl(null), null);
});

test('the owner reads the ideas, their issues, the series and its pilot of a job', () => {
  const [view] = withJobLinks([integrationView(dbApi.getIntegrationById(row.id)!)], OWNER);
  const links = view!.links;
  assert.deepEqual(links.todos.map((t) => t.id), [ours, imported], 'the job’s idea first, then the one a closing issue reaches');
  assert.equal(links.series_id, SERIES);
  assert.equal(links.pilot_mission_id, PILOT);
  assert.deepEqual(links.issues.map((i) => [i.repo, i.number, i.todo_id, i.closes]), [
    ['acme/app', 213, ours, false],
    ['acme/app', 212, ours, true],
    ['acme/app', 300, imported, true],
  ]);
  assert.equal(links.issues[0]!.url, 'https://github.com/acme/app/issues/213');
});

test('a caller who sees the job but none of its tasks gets no idea, no pilot', () => {
  const [view] = withJobLinks([integrationView(dbApi.getIntegrationById(row.id)!)], STRANGER);
  const links = view!.links;
  assert.deepEqual(links.todos.map((t) => t.id), [hidden], 'only the idea of its own task');
  assert.equal(links.pilot_mission_id, null, 'the pilot is owner-a’s mission');
  // The pull request's claims stay, without the ideas the caller cannot see.
  assert.deepEqual(links.issues.map((i) => [i.number, i.todo_id]), [[212, null], [300, null]]);
});

test('no viewer reads no link', () => {
  const [view] = withJobLinks([integrationView(dbApi.getIntegrationById(row.id)!)], null);
  assert.deepEqual(view!.links, { todos: [], issues: [], series_id: null, pilot_mission_id: null });
});

test('an idea’s text is cut for a line', () => {
  const long = idea('x'.repeat(LINKED_TODO_TEXT_LIMIT + 50), 'owner-a');
  const branch = 'feat/long';
  dbApi.recordIntegration({ repo: '/repos/app', branch, remote: 'origin', target: 'main', mode: 'pr', project: PROJECT });
  task(long, 'owner-a', branch);
  const views = listIntegrationViews({ todo: long }, OWNER);
  assert.equal(views.length, 1);
  const [linked] = withJobLinks(views, OWNER);
  assert.equal(linked!.links.todos[0]!.text.length, LINKED_TODO_TEXT_LIMIT);
  // The series comes from the task when the row has none.
  assert.equal(linked!.links.series_id, SERIES);
});

test('the jobs of an idea, only for a caller who sees the idea', () => {
  assert.deepEqual(listIntegrationViews({ todo: ours }, OWNER).map((v) => v.id), [row.id]);
  assert.deepEqual(listIntegrationViews({ todo: ours }, STRANGER), []);
  assert.deepEqual(listIntegrationViews({ todo: ours }, null), []);
  assert.deepEqual(listIntegrationViews({ todo: imported }, OWNER), [], 'an idea reached through an issue has no job of its own');
  assert.deepEqual(listIntegrationViews({ todo: ours, series: 'another' }, ADMIN), []);
});

test('a pull request finds its job, and any pull request the ideas of the issues it closes', () => {
  // Same number in another repository: not this job.
  const other = dbApi.recordIntegration({
    repo: '/repos/fork', branch: 'feat/other', remote: 'origin', target: 'main', mode: 'pr', project: PROJECT,
  });
  dbApi.markIntegrationOpen(other.id, { number: 58, url: 'https://github.com/other/app/pull/58', headSha: 'c'.repeat(40) });

  const pulls = [
    { number: 51, closingIssues: [] },
    { number: 58, closingIssues: [{ repo: null, number: 300, url: null }] },
    { number: 77, closingIssues: [{ repo: 'acme/app', number: 999, url: null }] },
  ];
  const out = pullRequestLinks(PROJECT, 'acme/app', pulls, OWNER);
  const ourPull = out.get(51)!;
  assert.equal(ourPull.job_id, row.id);
  assert.deepEqual(ourPull.todos.map((t) => t.id), [ours]);
  assert.equal(ourPull.pilot_mission_id, PILOT);
  assert.deepEqual(ourPull.issues.map((i) => [i.number, i.closes]), [[212, false], [213, false]]);

  const contributor = out.get(58)!;
  assert.equal(contributor.job_id, null);
  assert.deepEqual(contributor.todos.map((t) => t.id), [imported]);
  assert.deepEqual(contributor.issues.map((i) => [i.repo, i.number, i.todo_id, i.closes]), [['acme/app', 300, imported, true]]);
  assert.equal(contributor.series_id, null);

  assert.deepEqual(out.get(77)!.todos, []);
  assert.deepEqual(out.get(77)!.issues.map((i) => i.todo_id), [null]);

  // A stranger sees neither the job nor the idea.
  const theirs = pullRequestLinks(PROJECT, 'acme/app', pulls, { id: 'owner-c', isSuperadmin: false, permissions: [] });
  assert.equal(theirs.get(51)!.job_id, null);
  assert.deepEqual(theirs.get(58)!.todos, []);
});
