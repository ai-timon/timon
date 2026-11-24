/**
 * The landing poller (`docs/KANBAN-PR-PIPELINE.md` §2.6): a merge is learnt
 * from git without asking the forge, a pull request closed without a merge is
 * learnt from it, a failure concludes nothing, and a pass replayed changes
 * nothing. The pilot is told once per outcome.
 *
 * Real throwaway repositories: a bare one plays the forge's git side, a second
 * clone plays the merge button. `gh` is a stand-in: nothing here reaches
 * GitHub.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { db, dbApi } from './db.js';
import { agentDir } from './paths.js';
import type { ForgeStateReader, GitTransport, PullRequestStateOutcome } from './host/forge.js';
import { landIntegration } from './integration-landing.js';
import { pollOpenIntegrations, type PollerDeps } from './integration-poller.js';
import { updateProjectIntegration } from './project-integration.js';
import { notifyIntegrationOutcome } from './wake.js';
await import('../tests/helpers/claude-provider.js');

const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-landing-poller-')));
after(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function identity(repo: string): void {
  git(repo, 'config', 'user.name', 'Acme Bot');
  git(repo, 'config', 'user.email', 'bot@acme.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
}

function commit(cwd: string, file: string, message: string): string {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

type Job = { repo: string; forgeSide: string; branch: string; id: string; head: string; todo: number; slug: string };

let counter = 0;
/** The bare remote of each repository, for the stand-in fetch. */
const remotes = new Map<string, string>();

/**
 * A job whose pull request is open: `feat/topic-<n>` pushed to the bare
 * remote one commit ahead of `main`, its code chain merged into it with a TO
 * DO idea waiting, and the integration row the pull request step recorded.
 */
function openJob(opts: { pilot?: string } = {}): Job {
  counter += 1;
  const remote = join(root, `remote-${counter}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const repo = join(root, `repo-${counter}`);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  identity(repo);
  git(repo, 'remote', 'add', 'origin', remote);
  remotes.set(repo, remote);
  commit(repo, 'a.txt', 'chore: start');
  git(repo, 'push', '-q', 'origin', 'main');
  const branch = `feat/topic-${counter}`;
  git(repo, 'checkout', '-q', '-b', branch);
  const head = commit(repo, 'b.txt', 'feat(b): add b');
  git(repo, 'push', '-q', 'origin', branch);
  git(repo, 'checkout', '-q', 'main');

  const forgeSide = join(root, `forge-${counter}`);
  execFileSync('git', ['clone', '-q', remote, forgeSide]);
  identity(forgeSide);

  const slug = `poller-${counter}`;
  dbApi.upsertProject(slug, { cwd: repo });
  updateProjectIntegration(slug, { mode: 'pr', account: 'ai-bot', remote_url: 'git@github.com:acme/app.git' });

  const todo = dbApi.insertProjectTodo({ text: `idea ${randomUUID()}`, ownerUserId: 'user-ada' }).id;
  const merge = randomUUID();
  dbApi.createTask(merge, `merge ${counter}`, 'acme.merger', {
    type: 'merge', project: slug, baseBranch: branch, integrationMode: 'pr', baseRef: 'origin/main',
    ...(opts.pilot ? { seriesId: opts.pilot, creatorMissionId: opts.pilot } : {}),
  });
  dbApi.setTaskTodoId(merge, todo);
  dbApi.setTaskMergedSha(merge, head);
  dbApi.updateTaskStatus(merge, 'DONE', { doneComment: `merged ${head}` });

  const row = dbApi.recordIntegration({ repo, branch, remote: 'origin', target: 'main', mode: 'pr', project: slug });
  dbApi.markIntegrationOpen(row.id, { number: counter, url: `https://github.com/acme/app/pull/${counter}`, headSha: head });
  return { repo, forgeSide, branch, id: row.id, head, todo, slug };
}

/** The merge button: a merge commit of the branch into `main` on the remote. */
function mergeOnForge(job: Job): string {
  git(job.forgeSide, 'fetch', '-q', 'origin');
  git(job.forgeSide, 'checkout', '-q', 'main');
  git(job.forgeSide, 'merge', '-q', '--no-ff', '-m', 'Merge pull request from feat', `origin/${job.branch}`);
  git(job.forgeSide, 'push', '-q', 'origin', 'main');
  return git(job.forgeSide, 'rev-parse', 'HEAD');
}

let ghCalls: number;
let ghAnswer: PullRequestStateOutcome;
let notices: Array<{ id: string; outcome: string }>;

beforeEach(() => {
  ghCalls = 0;
  ghAnswer = { ok: true, state: 'open', mergeSha: null };
  notices = [];
});

const forge: ForgeStateReader = {
  async pullRequest() {
    ghCalls += 1;
    return ghAnswer;
  },
};

/**
 * The fetch, by plain git: the host adapter refuses a remote that is a local
 * folder a mission could write (its hooks would run as Timon), which is what
 * a throwaway remote is. Same refspec as `gitTransport.fetchBranch`.
 */
const localTransport = (repo: string): GitTransport => ({
  remoteBranchSha: async () => ({ ok: false, reason: 'not used by the poller' }),
  fetchBranch: async (_url, branch, into) => {
    try {
      git(repo, 'fetch', '-q', '--no-tags', '--', remotes.get(repo)!, `refs/heads/${branch}:${into}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: 'failed', reason: (err as Error).message };
    }
  },
  pushBranch: async () => { throw new Error('the poller never pushes'); },
});

/** The real notice, without the wake loop's spawn. */
const deps: PollerDeps = {
  transport: localTransport,
  forge: () => forge,
  notify: (id, outcome, lines) => {
    const sent = notifyIntegrationOutcome(id, outcome, lines, () => {});
    if (sent) notices.push({ id, outcome });
    return sent;
  },
};

/** The notification centre's cards about `id`'s outcome: type and title. */
function cardsFor(id: string): string[] {
  return (db.prepare(`SELECT type, title FROM notifications WHERE anchor LIKE ? ORDER BY created_at ASC`)
    .all(`integration:${id}:%`) as Array<{ type: string; title: string }>).map((c) => `${c.type}: ${c.title}`);
}

function noticesFor(branch: string): string[] {
  return dbApi.listAllInbox({ limit: 1000 })
    .filter((m) => m.payload.includes(branch))
    .map((m) => (JSON.parse(m.payload) as { title: string }).title);
}

test('a merge is learnt from git alone: the row lands, its idea closes, the pilot is told once', async () => {
  const job = openJob();
  const mergeCommit = mergeOnForge(job);
  assert.equal(dbApi.getProjectTodo(job.todo)?.status, 'open');

  const results = await pollOpenIntegrations(deps);
  assert.equal(results.get(job.id), 'merged');
  assert.equal(ghCalls, 0, 'the forge is not asked when git can tell');
  const row = dbApi.getIntegrationById(job.id)!;
  assert.equal(row.state, 'merged');
  assert.equal(row.merge_sha, mergeCommit, 'the merge commit of the target is recorded');
  assert.ok(row.landed_at, 'the landing was replayed');
  assert.ok(row.last_polled_at);
  assert.equal(dbApi.getProjectTodo(job.todo)?.status, 'done');
  assert.deepEqual(noticesFor(job.branch), [`Pull request merged: ${job.branch}`]);
  assert.deepEqual(cardsFor(job.id), [`report: Pull request merged: ${job.branch}`]);
  const recap = dbApi.listAllInbox({ limit: 1000 }).find((m) => m.payload.includes(job.branch))!;
  const body = (JSON.parse(recap.payload) as { body: string }).body;
  assert.match(body, new RegExp(`https://github.com/acme/app/pull/\\d+`), 'the pull request is named');
  assert.match(body, new RegExp(`TO DO ideas: #${job.todo} done\\.`), 'the ideas it closed are named');
  assert.match(body, /\d+ doc task\(s\) created/, 'the doc tasks are counted');

  // Replayed: nothing is open any more, nothing is told twice.
  const again = await pollOpenIntegrations(deps);
  assert.equal(again.has(job.id), false);
  assert.equal(ghCalls, 0);
  assert.deepEqual(noticesFor(job.branch), [`Pull request merged: ${job.branch}`]);
  assert.deepEqual(cardsFor(job.id), [`report: Pull request merged: ${job.branch}`]);
});

test('a fast-forward lands under the head itself', async () => {
  const job = openJob();
  git(job.forgeSide, 'fetch', '-q', 'origin');
  git(job.forgeSide, 'checkout', '-q', 'main');
  git(job.forgeSide, 'merge', '-q', '--ff-only', `origin/${job.branch}`);
  git(job.forgeSide, 'push', '-q', 'origin', 'main');
  assert.equal((await pollOpenIntegrations(deps)).get(job.id), 'merged');
  assert.equal(dbApi.getIntegrationById(job.id)?.merge_sha, job.head);
});

test('a pull request closed without a merge closes the row and nothing else', async () => {
  const job = openJob();
  ghAnswer = { ok: true, state: 'closed', mergeSha: null };
  const results = await pollOpenIntegrations(deps);
  assert.equal(results.get(job.id), 'closed');
  assert.equal(ghCalls, 1);
  const row = dbApi.getIntegrationById(job.id)!;
  assert.equal(row.state, 'closed');
  assert.equal(row.landed_at, null, 'nothing landed');
  assert.notEqual(dbApi.getProjectTodo(job.todo)?.status, 'done');
  assert.deepEqual(noticesFor(job.branch), [`Pull request closed: ${job.branch}`]);
  assert.deepEqual(cardsFor(job.id), [`alert: Pull request closed: ${job.branch}`], 'a closed pull request is not a report');

  await pollOpenIntegrations(deps);
  assert.equal(ghCalls, 1, 'a closed row is no longer polled');
  assert.deepEqual(noticesFor(job.branch), [`Pull request closed: ${job.branch}`]);
  assert.deepEqual(cardsFor(job.id), [`alert: Pull request closed: ${job.branch}`]);
});

test('a pull request still open stays open', async () => {
  const job = openJob();
  assert.equal((await pollOpenIntegrations(deps)).get(job.id), 'open');
  assert.equal(dbApi.getIntegrationById(job.id)?.state, 'open');
  assert.deepEqual(noticesFor(job.branch), []);
  // Leave the next tests alone.
  dbApi.markIntegrationClosed(job.id);
  dbApi.claimIntegrationNotice(job.id, 'closed');
});

test('a network failure concludes nothing, even if the branch was merged', async () => {
  const job = openJob();
  mergeOnForge(job);
  const down: GitTransport = {
    remoteBranchSha: async () => ({ ok: false, reason: 'offline' }),
    fetchBranch: async () => ({ ok: false, code: 'failed', reason: 'Could not resolve host' }),
    pushBranch: async () => { throw new Error('the poller never pushes'); },
  };
  ghAnswer = { ok: true, state: 'closed', mergeSha: null };
  const results = await pollOpenIntegrations({ ...deps, transport: () => down });
  assert.equal(results.get(job.id), 'unknown');
  assert.equal(ghCalls, 0, 'without the target, gh is not asked either');
  assert.equal(dbApi.getIntegrationById(job.id)?.state, 'open');
  assert.equal(dbApi.getProjectTodo(job.todo)?.status, 'open');
  assert.deepEqual(noticesFor(job.branch), []);

  // Back online: the next pass lands it.
  assert.equal((await pollOpenIntegrations(deps)).get(job.id), 'merged');
});

test('a gh failure concludes nothing', async () => {
  const job = openJob();
  ghAnswer = { ok: false, code: 'gh_failed', reason: 'HTTP 502' };
  assert.equal((await pollOpenIntegrations(deps)).get(job.id), 'unknown');
  assert.equal(dbApi.getIntegrationById(job.id)?.state, 'open');
  assert.deepEqual(noticesFor(job.branch), []);
  dbApi.markIntegrationClosed(job.id);
  dbApi.claimIntegrationNotice(job.id, 'closed');
});

test('merged under another commit: lands once git finds it in the target, never on the word of gh', async () => {
  const job = openJob();
  ghAnswer = { ok: true, state: 'merged', mergeSha: 'e'.repeat(40) };
  assert.equal((await pollOpenIntegrations(deps)).get(job.id), 'unknown');
  assert.equal(dbApi.getIntegrationById(job.id)?.state, 'open');

  // A squash: one new commit on main, the branch's head never in it.
  git(job.forgeSide, 'checkout', '-q', 'main');
  const squash = commit(job.forgeSide, 'b.txt', 'feat(b): add b (squashed)');
  git(job.forgeSide, 'push', '-q', 'origin', 'main');
  ghAnswer = { ok: true, state: 'merged', mergeSha: squash };
  assert.equal((await pollOpenIntegrations(deps)).get(job.id), 'merged');
  assert.equal(dbApi.getIntegrationById(job.id)?.merge_sha, squash);
});

test('nothing open: no fetch, no gh', async () => {
  for (const row of dbApi.listOpenIntegrations()) {
    dbApi.markIntegrationClosed(row.id);
    dbApi.claimIntegrationNotice(row.id, 'closed');
  }
  let built = 0;
  const results = await pollOpenIntegrations({
    ...deps,
    transport: () => { built += 1; throw new Error('no fetch expected'); },
    forge: () => { built += 1; throw new Error('no gh expected'); },
  });
  assert.equal(results.size, 0);
  assert.equal(built, 0);
});

test('a row concluded without its notice (a stop in between) is told on the next pass, once', async () => {
  const job = openJob();
  await landIntegration(job.id, null);
  assert.deepEqual(noticesFor(job.branch), []);
  await pollOpenIntegrations(deps);
  assert.deepEqual(noticesFor(job.branch), [`Pull request merged: ${job.branch}`]);
  await pollOpenIntegrations(deps);
  assert.deepEqual(noticesFor(job.branch), [`Pull request merged: ${job.branch}`]);
  assert.equal(notifyIntegrationOutcome(job.id, 'merged', [], () => {}), false);
  assert.equal(notifyIntegrationOutcome(job.id, 'closed', [], () => {}), false, 'a merged row is never told closed');
});

test('a merge proposes the resolution comment of each issue the job fixed, once, and publishes nothing', async () => {
  const { db } = await import('./db.js');
  const { TODO_OUTCOME_DDL } = await import('./todo-outcome-migration.js');
  const { defuseMentions, resolutionComment, resolutionKey } = await import('./issue-resolution.js');
  db.exec(TODO_OUTCOME_DDL);
  const job = openJob();
  const link = (todo: number, ref: string) => dbApi.putTodoExternalRef({
    todoId: todo, provider: 'github', ref, url: `https://github.com/${ref.replace('#', '/issues/')}`, label: null, pluginId: 'github-issues',
  });
  link(job.todo, 'acme/app#77');
  link(job.todo, 'other/repo#5');
  db.prepare(`INSERT INTO todo_outcome (todo_id, resolution, public_note, duplicate_of, updated_at) VALUES (?, 'fixed', ?, NULL, 1)`)
    .run(job.todo, 'Thanks @reporter, it ships in 0.2.');
  // An idea two jobs carry is only mentioned (Refs): no resolution yet.
  const shared = dbApi.insertProjectTodo({ text: 'shared idea', ownerUserId: 'user-ada' }).id;
  link(shared, 'acme/app#78');
  for (const branch of [job.branch, 'feat/elsewhere']) {
    const id = randomUUID();
    dbApi.createTask(id, `part on ${branch}`, 'acme.coder', {
      type: 'code', project: job.slug, baseBranch: branch, integrationMode: 'pr', baseRef: 'origin/main',
    });
    dbApi.setTaskTodoId(id, shared);
  }
  dbApi.recordIntegration({ repo: job.repo, branch: 'feat/elsewhere', remote: 'origin', target: 'main', mode: 'pr', project: job.slug });

  mergeOnForge(job);
  assert.equal((await pollOpenIntegrations(deps)).get(job.id), 'merged');
  const rows = () => db.prepare(`SELECT * FROM forge_proposals WHERE project = ?`).all(job.slug) as Array<Record<string, unknown>>;
  const made = rows();
  assert.equal(made.length, 1, 'one issue fixed in the project repository');
  const n = Number(job.branch.split('-').at(-1));
  assert.deepEqual(
    [made[0]!.target_type, made[0]!.target_number, made[0]!.trigger, made[0]!.state, made[0]!.idem_key, made[0]!.created_by, made[0]!.repo],
    ['issue', 77, 'landing', 'draft', resolutionKey(job.todo, 77), null, 'acme/app'],
  );
  assert.equal(made[0]!.body, `This is fixed by #${n}, now merged into \`main\`.\n\nThanks \`@reporter\`, it ships in 0.2.`);
  const { proposalAnchor } = await import('./forge-proposals.js');
  const cards = db.prepare(`SELECT type FROM notifications WHERE anchor = ? AND dismissed_at IS NULL`).all(proposalAnchor(job.slug, String(made[0]!.id))) as { type: string }[];
  assert.deepEqual(cards.map((c) => c.type), ['action_required'], 'a person is asked to publish it');

  // Concluded again (mark-merged by hand): the same proposal, no other.
  const { concludeMerged } = await import('./integration-poller.js');
  await concludeMerged(job.id, null, () => true);
  assert.equal(rows().length, 1);
  // Discarded by the person: never made again.
  db.prepare(`UPDATE forge_proposals SET state = 'discarded' WHERE id = ?`).run(made[0]!.id);
  await concludeMerged(job.id, null, () => true);
  assert.deepEqual(rows().map((r) => r.state), ['discarded']);

  assert.equal(defuseMentions('@a, me@mail.test, `@b` and acme/@c'), '`@a`, me@mail.test, `@b` and acme/@c');
  assert.equal(resolutionComment({ prNumber: null, target: 'main', notes: [] }), 'This is fixed, now merged into `main`.');
});

test('the recap goes to the agent of the series pilot', async () => {
  mkdirSync(agentDir('acme.pilot'), { recursive: true });
  const pilot = randomUUID();
  dbApi.createMission(pilot, 'acme.pilot', 'plan the job');
  const job = openJob({ pilot });
  mergeOnForge(job);
  assert.equal((await pollOpenIntegrations(deps)).get(job.id), 'merged');
  const recaps = dbApi.listAllInbox({ limit: 1000 }).filter((m) => m.payload.includes(job.branch));
  assert.deepEqual(recaps.map((m) => m.to_agent), ['acme.pilot']);
  assert.equal(cardsFor(job.id).length, 1);
});

test('a pilot that no longer exists gets no recap: the card alone tells, once', async () => {
  // The pilot's agent was deleted with its team: its mission row survives.
  const pilot = randomUUID();
  dbApi.createMission(pilot, 'gone.pilot', 'plan the job');
  const job = openJob({ pilot });
  mergeOnForge(job);
  assert.equal((await pollOpenIntegrations(deps)).get(job.id), 'merged');
  assert.deepEqual(noticesFor(job.branch), [], 'nothing is queued for an agent that cannot wake');
  assert.deepEqual(cardsFor(job.id), [`report: Pull request merged: ${job.branch}`]);
  assert.equal(dbApi.getIntegrationById(job.id)?.notified_state, 'merged', 'the notice is spent');

  await pollOpenIntegrations(deps);
  assert.equal(notifyIntegrationOutcome(job.id, 'merged', [], () => {}), false);
  assert.deepEqual(cardsFor(job.id), [`report: Pull request merged: ${job.branch}`]);
  assert.deepEqual(noticesFor(job.branch), []);
});
