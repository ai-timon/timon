/**
 * "Update the branch" of a pull request: who may ask for it, what is refused
 * before anything is proposed, and what publishing does with the head the
 * person saw. The forge is a fake: nothing reaches GitHub.
 */
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import express from 'express';
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import { dbApi } from '../../db.js';
import { branchGestures } from '../../forge-branch-update.js';
import type { ForgeProposalDeps } from '../../forge-proposals.js';
import type {
  BranchUpdateOutcome, ForgeBranchWriter, ForgeCommentWriter, PullRequestBranch, PullRequestBranchOutcome,
} from '../../host/forge.js';
import { registerForgeBranchRoutes } from './forge-branch-routes.js';
import { registerForgeProposalRoutes } from './forge-proposal-routes.js';
import { registerIntegrationRoutes } from './integration-routes.js';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'timon-forge-branch-')));
const ghFolder = join(home, '.config', 'gh-acme');
mkdirSync(ghFolder, { recursive: true });
dbApi.upsertProject('acme', { cwd: join(home, 'code', 'acme') });
dbApi.upsertProject('solo', { cwd: join(home, 'code', 'solo') });
dbApi.setProjectIntegration('acme', JSON.stringify({
  mode: 'pr', remote: 'origin', target: 'main', forge: 'github', account: 'ai-bot',
  gh_config_dir: ghFolder, branch_prefix: 'feat/', remote_url: 'git@github.com:acme/widgets.git',
}));

const admin = createTestAccount(dbApi, { email: 'maintainer@example.test', name: 'Maintainer', passwordHash: 'x', isSuperadmin: true });
const guest = createTestAccount(dbApi, { email: 'guest@example.test', name: 'Guest', passwordHash: 'x', isSuperadmin: false });

const HEAD = 'a'.repeat(40);
const OTHER = 'c'.repeat(40);

function branchOf(extra: Partial<PullRequestBranch> = {}): PullRequestBranch {
  return {
    state: 'open', isDraft: false, baseRef: 'main', headRef: 'fix/typo', headSha: HEAD, headRepository: 'contrib/widgets',
    isCrossRepository: true, maintainerCanModify: true, mergeable: 'mergeable', mergeStateStatus: 'behind',
    url: 'https://github.com/acme/widgets/pull/7', ...extra,
  };
}

let branch: PullRequestBranchOutcome = { ok: true, branch: branchOf() };
let update: BranchUpdateOutcome = { ok: true };
let parents: string[] = [];
let login = 'ai-bot';
const updates: Array<{ repo: string; number: number; sha: string }> = [];
const reads: number[] = [];

const fakeBranches: ForgeBranchWriter = {
  login: async () => ({ ok: true, login }),
  pullRequestBranch: async (_repo, number) => { reads.push(number); return branch; },
  updatePullRequestBranch: async (repo, number, sha) => { updates.push({ repo, number, sha }); return update; },
  commitParents: async () => ({ ok: true, parents }),
};
const fakeComments: ForgeCommentWriter = {
  login: async () => ({ ok: true, login }),
  findIssueComment: async () => ({ ok: true, comment: null }),
  postIssueComment: async () => { throw new Error('a branch update posts no comment'); },
};
const deps: ForgeProposalDeps = { forge: () => fakeComments, branchForge: () => fakeBranches };

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const who = req.header('x-test-who');
  if (who === 'daemon') req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true };
  else if (who === 'mission') {
    req.auth = { kind: 'api-token', user: admin, isSuperadmin: false, permissions: ['projects:manage', 'kanban:write'], missionId: 'm-1' };
  } else if (who === 'plugin') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: 'plugin:x', permissions: ['projects:manage'] };
  else if (who === 'person') req.auth = { kind: 'session', user: admin, isSuperadmin: true };
  else if (who === 'guest') req.auth = { kind: 'session', user: guest, isSuperadmin: false };
  next();
});
registerForgeProposalRoutes(app, deps);
registerForgeBranchRoutes(app, deps);
registerIntegrationRoutes(app, { home });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => { server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Who = 'anonymous' | 'daemon' | 'mission' | 'plugin' | 'person' | 'guest';
function call(method: string, path: string, who: Who, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who !== 'anonymous') headers['x-test-who'] = who;
  return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

type View = {
  id: string; kind: string; state: string; body: string; editable: boolean; url: string | null;
  details: Record<string, unknown> | null; error: { code: string } | null;
};

async function ask(number: number, who: Who = 'person'): Promise<{ status: number; code?: string; proposal?: View; created?: boolean }> {
  const res = await call('POST', `/api/projects/acme/pull-requests/${number}/update-branch`, who, {});
  const json = (await res.json()) as { code?: string; proposal?: View; created?: boolean };
  return { status: res.status, ...json };
}

const publish = (id: string, body?: unknown) => call('POST', `/api/projects/acme/forge-proposals/${id}/publish`, 'person', body ?? {});

beforeEach(() => {
  branch = { ok: true, branch: branchOf() };
  update = { ok: true };
  parents = [];
  login = 'ai-bot';
  updates.length = 0;
  reads.length = 0;
});

test('anonymous: the update route answers 401', async () => {
  assert.equal((await call('POST', '/api/projects/acme/pull-requests/7/update-branch', 'anonymous', {})).status, 401);
});

test('the daemon token, a mission, a plugin and a person without projects:manage cannot ask for an update', async () => {
  for (const who of ['daemon', 'mission', 'plugin'] as const) {
    const out = await ask(7, who);
    assert.equal(out.status, 403, who);
    assert.equal(out.code, 'person_required', who);
  }
  assert.equal((await ask(7, 'guest')).status, 403);
  assert.equal(reads.length, 0, 'nothing reached the forge');
});

test('a person asks: the proposal records the head GitHub showed, has no text to edit, and is made once per head', async () => {
  const first = await ask(7);
  assert.equal(first.status, 201);
  assert.equal(first.proposal?.kind, 'update_branch');
  assert.equal(first.proposal?.editable, false);
  assert.equal(first.proposal?.details?.expected_head_sha, HEAD);
  assert.match(first.proposal?.body ?? '', /merges `main` into `fix\/typo`/);
  const again = await ask(7);
  assert.equal(again.status, 200);
  assert.equal(again.proposal?.id, first.proposal?.id);
  assert.equal(updates.length, 0, 'asking writes nothing on GitHub');

  const edit = await call('PATCH', `/api/projects/acme/forge-proposals/${first.proposal!.id}`, 'person', { body: 'merge it all' });
  assert.equal(edit.status, 409);
  assert.equal(((await edit.json()) as { code: string }).code, 'forge_proposal_not_editable');
  const withText = await publish(first.proposal!.id, { body: 'merge it all' });
  assert.equal(((await withText.json()) as { code: string }).code, 'forge_proposal_not_editable');
  assert.equal(updates.length, 0);
});

test('refused before anything is proposed: closed, not behind, conflicting, not modifiable, deleted fork, unknown head, unreadable', async () => {
  const cases: Array<[PullRequestBranchOutcome, string]> = [
    [{ ok: true, branch: branchOf({ state: 'merged' }) }, 'forge_pull_closed'],
    [{ ok: true, branch: branchOf({ mergeStateStatus: 'clean' }) }, 'forge_pull_not_behind'],
    [{ ok: true, branch: branchOf({ mergeStateStatus: 'dirty', mergeable: 'conflicting' }) }, 'forge_pull_not_behind'],
    [{ ok: true, branch: branchOf({ maintainerCanModify: false }) }, 'forge_branch_not_modifiable'],
    [{ ok: true, branch: branchOf({ headRepository: null }) }, 'forge_branch_not_modifiable'],
    [{ ok: true, branch: branchOf({ headSha: null }) }, 'forge_head_unknown'],
    [{ ok: false, code: 'gh_failed', reason: 'HTTP 502' }, 'forge_read_failed'],
  ];
  for (const [answer, code] of cases) {
    branch = answer;
    const out = await ask(8);
    assert.equal(out.code, code, code);
    assert.ok(out.status >= 400);
  }
  // A draft hides its merge state: it is behind when GitHub says it merges cleanly.
  branch = { ok: true, branch: branchOf({ mergeStateStatus: 'draft', mergeable: 'mergeable', isDraft: true }) };
  assert.equal((await ask(9)).status, 201);
  const solo = await call('POST', '/api/projects/solo/pull-requests/7/update-branch', 'person', {});
  assert.equal(((await solo.json()) as { code: string }).code, 'integration_not_pr');
});

test('publishing checks the account, then asks GitHub to update with the expected head', async () => {
  const { proposal } = await ask(10);
  login = 'someone-else';
  const wrong = await publish(proposal!.id);
  assert.equal(((await wrong.json()) as { code: string }).code, 'forge_account_mismatch');
  assert.equal(updates.length, 0, 'the wrong account writes nothing');

  login = 'ai-bot';
  const res = await publish(proposal!.id);
  assert.equal(res.status, 200);
  const out = (await res.json()) as { proposal: View; already: boolean };
  assert.equal(out.proposal.state, 'published');
  assert.equal(out.proposal.url, 'https://github.com/acme/widgets/pull/7');
  assert.deepEqual(updates, [{ repo: 'acme/widgets', number: 10, sha: HEAD }]);
  const twice = (await (await publish(proposal!.id)).json()) as { already: boolean };
  assert.equal(twice.already, true);
  assert.equal(updates.length, 1, 'a published update is not sent again');
});

test('a branch that moved since the proposal is never updated; a retry recognises its own merge', async () => {
  const { proposal } = await ask(11);
  branch = { ok: true, branch: branchOf({ headSha: OTHER }) };
  const moved = await publish(proposal!.id);
  const body = (await moved.json()) as { code: string; proposal: View };
  assert.equal(body.code, 'forge_head_moved');
  assert.equal(body.proposal.state, 'failed');
  assert.equal(updates.length, 0);

  // The second attempt finds a head whose first parent is the expected one:
  // the first attempt reached GitHub before its answer was lost.
  parents = [HEAD, 'd'.repeat(40)];
  const retried = (await (await publish(proposal!.id)).json()) as { proposal: View; already: boolean };
  assert.equal(retried.proposal.state, 'published');
  assert.equal(retried.already, true);
  assert.equal(updates.length, 0);
});

test('GitHub refusing the update: a conflict, a moved head, no right — the proposal fails and says why', async () => {
  for (const [answer, code] of [
    [{ ok: false, code: 'conflict', reason: 'merge conflict' }, 'forge_branch_conflict'],
    [{ ok: false, code: 'head_moved', reason: 'expected head sha' }, 'forge_head_moved'],
    [{ ok: false, code: 'forbidden', reason: 'HTTP 403' }, 'forge_branch_forbidden'],
    [{ ok: false, code: 'gh_failed', reason: 'HTTP 500' }, 'forge_publish_failed'],
  ] as const) {
    branch = { ok: true, branch: branchOf({ headSha: `${code.length}`.padStart(40, 'e') }) };
    const { proposal } = await ask(20 + code.length);
    update = answer;
    const out = (await (await publish(proposal!.id)).json()) as { code: string; proposal: View };
    assert.equal(out.code, code);
    assert.equal(out.proposal.state, 'failed');
  }
});

test('a pull request closed or no longer modifiable before publishing: nothing written, the proposal waits as it was', async () => {
  const { proposal } = await ask(30);
  branch = { ok: true, branch: branchOf({ state: 'closed' }) };
  const closed = (await (await publish(proposal!.id)).json()) as { code: string; proposal: View };
  assert.equal(closed.code, 'forge_pull_closed');
  assert.equal(closed.proposal.state, 'draft');
  branch = { ok: true, branch: branchOf({ maintainerCanModify: false }) };
  const locked = (await (await publish(proposal!.id)).json()) as { code: string; proposal: View };
  assert.equal(locked.code, 'forge_branch_not_modifiable');
  assert.equal(updates.length, 0);
});

test('the list tells which gestures a branch allows, without another call', () => {
  const pull = { headRepository: 'contrib/widgets', maintainerCanModify: true, mergeStateStatus: 'behind' as const };
  const ask = { contributor_conflicts: 'ask' as const };
  const resolve = { contributor_conflicts: 'resolve' as const };
  assert.deepEqual(branchGestures('acme/widgets', pull, ask), { update_branch: true, ask_contributor: false, resolve_conflict: false, locked: null });
  assert.deepEqual(branchGestures('acme/widgets', { ...pull, maintainerCanModify: false }, ask), {
    update_branch: false, ask_contributor: false, resolve_conflict: false, locked: 'not_allowed',
  });
  const dirty = { ...pull, mergeStateStatus: 'dirty' as const };
  assert.deepEqual(branchGestures('acme/widgets', dirty, ask), { update_branch: false, ask_contributor: true, resolve_conflict: false, locked: null });
  // A locked branch still conflicts: asking its author stays the one gesture.
  assert.deepEqual(branchGestures('acme/widgets', { ...dirty, maintainerCanModify: false }, resolve), {
    update_branch: false, ask_contributor: true, resolve_conflict: false, locked: 'not_allowed',
  });
  assert.equal(branchGestures('acme/widgets', { ...dirty, headRepository: null }, resolve).locked, 'fork_deleted');
  assert.equal(branchGestures('acme/widgets', dirty, resolve).resolve_conflict, true);
  assert.equal(branchGestures('acme/widgets', { ...dirty, maintainerCanModify: false }, resolve).resolve_conflict, false);
  assert.equal(branchGestures('acme/widgets', { ...dirty, headRepository: null }, resolve).resolve_conflict, false);
  // Our own branch: its conflict is the job's to fix, not a contributor's.
  assert.equal(branchGestures('acme/widgets', { ...dirty, headRepository: 'acme/widgets' }, resolve).resolve_conflict, false);
  // The flag says nothing of a branch in the repository itself: it is always ours to write.
  assert.equal(branchGestures('acme/widgets', { ...dirty, headRepository: 'acme/widgets', maintainerCanModify: false }, resolve).locked, null);
});

test('only a signed-in person lets Timon resolve conflicts; anyone may turn it back off', async () => {
  for (const who of ['daemon', 'mission'] as const) {
    const res = await call('PUT', '/api/projects/acme/integration', who, { contributor_conflicts: 'resolve' });
    assert.equal(res.status, 403, who);
    assert.equal(((await res.json()) as { code: string }).code, 'person_required');
  }
  assert.equal((await call('PUT', '/api/projects/acme/integration', 'anonymous', { contributor_conflicts: 'resolve' })).status, 401);
  const on = await call('PUT', '/api/projects/acme/integration', 'person', { contributor_conflicts: 'resolve' });
  assert.equal(on.status, 200);
  assert.equal(((await on.json()) as { integration: { contributor_conflicts: string } }).integration.contributor_conflicts, 'resolve');
  // Already on: another field changes freely.
  assert.equal((await call('PUT', '/api/projects/acme/integration', 'daemon', { contributor_conflicts: 'resolve', branch_prefix: 'sec/' })).status, 200);
  const off = await call('PUT', '/api/projects/acme/integration', 'daemon', { contributor_conflicts: 'ask', branch_prefix: 'feat/' });
  assert.equal(off.status, 200);
  assert.equal(((await off.json()) as { integration: { contributor_conflicts: string } }).integration.contributor_conflicts, 'ask');
});

test('while Timon resolves conflicts, where it fetches and pushes and as whom is a person\'s to change', async () => {
  const PUT = (who: 'daemon' | 'mission' | 'plugin' | 'person', body: Record<string, unknown>) =>
    call('PUT', '/api/projects/acme/integration', who, body);
  const stored = async () => ((await (await call('GET', '/api/projects/acme/integration', 'person')).json()) as {
    integration: Record<string, unknown>;
  }).integration;
  assert.equal((await PUT('person', { contributor_conflicts: 'resolve' })).status, 200);
  const before = await stored();
  const otherGh = join(home, '.config', 'gh-other');
  mkdirSync(otherGh, { recursive: true });
  const changes: Array<Record<string, unknown>> = [
    { remote_url: 'git@evil.example:acme/widgets.git' },
    { account: 'someone-else' },
    { gh_config_dir: otherGh },
    { mode: 'local' },
    { remote: 'upstream' },
    { contributor_conflicts: 'resolve', remote_url: 'https://github.com/acme/widgets' },
  ];
  for (const who of ['daemon', 'mission', 'plugin'] as const) {
    for (const change of changes) {
      const res = await PUT(who, change);
      assert.equal(res.status, 403, `${who} ${JSON.stringify(change)}`);
      assert.equal(((await res.json()) as { code: string }).code, 'person_required');
    }
  }
  assert.deepEqual(await stored(), before, 'nothing changed');
  // The same values sent again, and the other fields, stay open.
  assert.equal((await PUT('daemon', { remote_url: before.remote_url, account: 'ai-bot', mode: 'pr', remote: 'origin' })).status, 200);
  assert.equal((await PUT('mission', { branch_prefix: 'sec/' })).status, 200);
  // A person changes them.
  assert.equal((await PUT('person', { remote_url: 'https://github.com/acme/widgets' })).status, 200);
  assert.equal((await stored()).remote_url, 'https://github.com/acme/widgets');
  // Switched off, they are open again: no push follows without a person turning it back on.
  assert.equal((await PUT('daemon', { contributor_conflicts: 'ask' })).status, 200);
  assert.equal((await PUT('daemon', { remote_url: before.remote_url, branch_prefix: 'feat/' })).status, 200);
  assert.deepEqual(await stored(), { ...before, contributor_conflicts: 'ask' });
});
