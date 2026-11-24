/**
 * The tab's single Git state (TODO #278, part 1).
 *
 * What these tests hold: the panel, the publication card and the composer's
 * branch read through ONE invalidation, so a checkout can no longer leave one
 * of them on the old branch — in particular when a read was already in flight.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announceAccount } from './account-change';
import {
  agentGitId,
  getGitSnapshot,
  gitRepoId,
  invalidateGit,
  revalidateGit,
  setGitRemote,
  subscribeGit,
  GIT_LOG_LIMIT,
  type GitRemote,
} from './git-store';

type Pending = { url: string; answer: (body: unknown, status?: number) => void };

/** A `fetch` held by hand: each call waits until the test answers it. */
function holdFetch(): { calls: Pending[]; restore: () => void } {
  const calls: Pending[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => new Promise<Response>((done) => {
    calls.push({
      url: String(input),
      answer: (body, status = 200) => done(new Response(JSON.stringify(body), { status })),
    });
  })) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

const branchInfo = (branch: string) => ({ branch, dirty: false, worktree: null });

test('every reader of one key shares a single request', async () => {
  const f = holdFetch();
  try {
    const offs = [1, 2, 3].map(() => subscribeGit('agent', 'shared', () => {}));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.url, '/api/ui/agents/shared/git');
    f.calls[0]!.answer(branchInfo('main'));
    await settle();
    assert.equal(getGitSnapshot('agent', 'shared').data?.branch, 'main');
    for (const off of offs) off();
  } finally { f.restore(); }
});

test('an agent read with its project asks the daemon to compare the two repositories', async () => {
  const f = holdFetch();
  try {
    assert.equal(agentGitId('proj.coder', null), 'proj.coder');
    const off = subscribeGit('agent', agentGitId('proj.coder', 'my proj'), () => {});
    assert.equal(f.calls[0]!.url, '/api/ui/agents/proj.coder/git?slug=my%20proj');
    f.calls[0]!.answer({ ...branchInfo('main'), foreignRepo: true });
    await settle();
    assert.equal(getGitSnapshot('agent', agentGitId('proj.coder', 'my proj')).data?.foreignRepo, true);
    off();
  } finally { f.restore(); }
});

test('an invalidation during a read drops that read and asks again: the later answer wins', async () => {
  const f = holdFetch();
  try {
    const off = subscribeGit('agent', 'race', () => {});
    assert.equal(f.calls.length, 1);
    // The checkout lands while the first read is still out.
    invalidateGit();
    assert.equal(f.calls.length, 1, 'no second concurrent read');
    f.calls[0]!.answer(branchInfo('old'));
    await settle();
    assert.equal(f.calls.length, 2, 'the stale answer triggers a fresh read');
    assert.notEqual(getGitSnapshot('agent', 'race').data?.branch, 'old');
    f.calls[1]!.answer(branchInfo('new'));
    await settle();
    assert.equal(getGitSnapshot('agent', 'race').data?.branch, 'new');
    off();
  } finally { f.restore(); }
});

test('one invalidation refreshes the three reads on screen, and only those', async () => {
  const f = holdFetch();
  try {
    const offs = [
      subscribeGit('dashboard', 'proj', () => {}),
      subscribeGit('remote', 'proj', () => {}),
      subscribeGit('agent', 'proj.coder', () => {}),
    ];
    const gone = subscribeGit('agent', 'left-the-screen', () => {});
    gone();
    for (const c of f.calls) c.answer({});
    await settle();
    f.calls.length = 0;

    invalidateGit();
    assert.deepEqual(
      f.calls.map((c) => c.url).sort(),
      ['/api/ui/agents/proj.coder/git', '/api/ui/git-remote/proj', '/api/ui/git?slug=proj'],
    );
    for (const c of f.calls) c.answer({});
    await settle();
    for (const off of offs) off();
  } finally { f.restore(); }
});

test('the composer and the panel follow the same checkout', async () => {
  const f = holdFetch();
  try {
    const offs = [subscribeGit('dashboard', 'sync', () => {}), subscribeGit('agent', 'sync.coder', () => {})];
    const answerAll = (branch: string) => {
      for (const c of f.calls.splice(0)) {
        c.answer(c.url.includes('/agents/')
          ? branchInfo(branch)
          : { ok: true, repo: 'r', base: 'main', currentBranch: branch, branches: [], staged: [], unstaged: [], untracked: [] });
      }
    };
    answerAll('main');
    await settle();
    invalidateGit();
    answerAll('feature');
    await settle();
    assert.equal(getGitSnapshot('dashboard', 'sync').data?.currentBranch, 'feature');
    assert.equal(getGitSnapshot('agent', 'sync.coder').data?.branch, 'feature');
    for (const off of offs) off();
  } finally { f.restore(); }
});

test('the dashboard reports its failure; the agent read keeps its last state', async () => {
  const f = holdFetch();
  try {
    const offs = [subscribeGit('dashboard', 'fail', () => {}), subscribeGit('agent', 'fail.coder', () => {})];
    for (const c of f.calls.splice(0)) c.answer(c.url.includes('/agents/') ? branchInfo('main') : { error: 'boom' }, c.url.includes('/agents/') ? 200 : 400);
    await settle();
    assert.equal(getGitSnapshot('dashboard', 'fail').error, 'boom');
    invalidateGit();
    for (const c of f.calls.splice(0)) c.answer({ error: 'down' }, 500);
    await settle();
    assert.equal(getGitSnapshot('agent', 'fail.coder').data?.branch, 'main');
    for (const off of offs) off();
  } finally { f.restore(); }
});

test('an agent that answers 404 is not asked again on events', async () => {
  const f = holdFetch();
  try {
    const off = subscribeGit('agent', 'ghost', () => {});
    f.calls[0]!.answer({ error: 'not found' }, 404);
    await settle();
    f.calls.length = 0;
    invalidateGit();
    assert.equal(f.calls.filter((c) => c.url.includes('/ghost/')).length, 0);
    assert.equal(getGitSnapshot('agent', 'ghost').data, null);
    off();
  } finally { f.restore(); }
});

test('an action answer is written at once, and a read that left before it cannot undo it', async () => {
  const f = holdFetch();
  try {
    const off = subscribeGit('remote', 'pub', () => {});
    const fresh = { slug: 'pub', state: 'synced', ahead: 0 } as GitRemote;
    setGitRemote('pub', fresh);
    assert.equal(getGitSnapshot('remote', 'pub').data?.state, 'synced');
    // The read that started at mount answers with the pre-push state.
    f.calls[0]!.answer({ git: { slug: 'pub', state: 'ahead', ahead: 2 } });
    await settle();
    assert.equal(f.calls.length, 2, 'the stale read is replaced');
    f.calls[1]!.answer({ git: fresh });
    await settle();
    assert.equal(getGitSnapshot('remote', 'pub').data?.state, 'synced');
    off();
  } finally { f.restore(); }
});

test('an unchanged answer keeps the data identity: effects keyed on it do not rerun', async () => {
  const f = holdFetch();
  try {
    let renders = 0;
    const off = subscribeGit('agent', 'stable', () => { renders += 1; });
    f.calls[0]!.answer(branchInfo('main'));
    await settle();
    const before = getGitSnapshot('agent', 'stable');
    const rendersBefore = renders;
    invalidateGit();
    f.calls[1]!.answer(branchInfo('main'));
    await settle();
    assert.equal(getGitSnapshot('agent', 'stable').data, before.data);
    // `loading` on, then off: two notifications, never a third.
    assert.ok(renders - rendersBefore <= 2);
    off();
  } finally { f.restore(); }
});

test('an account change empties the store and drops answers read for the previous account', async () => {
  const f = holdFetch();
  try {
    const off = subscribeGit('agent', 'acct', () => {});
    f.calls[0]!.answer(branchInfo('mine'));
    await settle();
    invalidateGit();
    const late = f.calls[1]!;
    announceAccount('someone-else');
    assert.equal(getGitSnapshot('agent', 'acct').data, null);
    late.answer(branchInfo('previous-account'));
    await settle();
    assert.notEqual(getGitSnapshot('agent', 'acct').data?.branch, 'previous-account');
    f.calls[2]!.answer(branchInfo('theirs'));
    await settle();
    assert.equal(getGitSnapshot('agent', 'acct').data?.branch, 'theirs');
    off();
  } finally { f.restore(); }
});

test('reading the store starts no polling timer', () => {
  const f = holdFetch();
  const original = globalThis.setInterval;
  globalThis.setInterval = (() => { throw new Error('the Git store must not poll'); }) as unknown as typeof setInterval;
  try {
    const off = subscribeGit('dashboard', 'no-poll', () => {});
    off();
  } finally {
    globalThis.setInterval = original;
    f.restore();
  }
});

test('hints that something may have moved keep a read already in flight: one request, not two', async () => {
  const f = holdFetch();
  try {
    const off = subscribeGit('agent', 'focus', () => {});
    // `focus` and `visibilitychange` fire together on return to the tab.
    revalidateGit();
    revalidateGit();
    f.calls[0]!.answer(branchInfo('main'));
    await settle();
    assert.equal(f.calls.length, 1);
    assert.equal(getGitSnapshot('agent', 'focus').data?.branch, 'main');
    // Once idle, a hint does read again.
    revalidateGit();
    assert.equal(f.calls.length, 2);
    f.calls[1]!.answer(branchInfo('main'));
    await settle();
    off();
  } finally { f.restore(); }
});

test('the graph reads follow the same invalidation, bounded, and a failed log says why', async () => {
  const f = holdFetch();
  try {
    const offs = [subscribeGit('log', 'graph', () => {}), subscribeGit('worktrees', 'graph', () => {})];
    assert.deepEqual(
      f.calls.map((c) => c.url).sort(),
      [`/api/ui/git/log?slug=graph&limit=${GIT_LOG_LIMIT}`, '/api/ui/git/worktrees?slug=graph'],
    );
    for (const c of f.calls.splice(0)) c.answer({ error: 'project has no cwd configured' }, 400);
    await settle();
    assert.equal(getGitSnapshot('log', 'graph').error, 'project has no cwd configured');
    assert.equal(getGitSnapshot('worktrees', 'graph').error, null);

    invalidateGit();
    assert.equal(f.calls.length, 2);
    for (const c of f.calls.splice(0)) c.answer({ ok: true, repo: 'r', worktrees: [], head: null, currentBranch: null, truncated: false, commits: [] });
    await settle();
    assert.equal(getGitSnapshot('log', 'graph').error, null);
    for (const off of offs) off();
  } finally { f.restore(); }
});

test('a nested repository has its own reads, the root keeps the bare slug (TODO #923)', async () => {
  const f = holdFetch();
  try {
    assert.equal(gitRepoId('proj', null), 'proj');
    assert.equal(gitRepoId('proj', ''), 'proj');
    const id = gitRepoId('proj', 'links/private notes');
    const offs = [
      subscribeGit('dashboard', id, () => {}),
      subscribeGit('remote', id, () => {}),
      subscribeGit('log', id, () => {}),
      subscribeGit('worktrees', id, () => {}),
      subscribeGit('repos', 'proj', () => {}),
    ];
    const repo = 'repo=links%2Fprivate%20notes';
    assert.deepEqual(f.calls.map((c) => c.url).sort(), [
      `/api/ui/git-remote/proj?${repo}`,
      `/api/ui/git/log?slug=proj&limit=${GIT_LOG_LIMIT}&${repo}`,
      '/api/ui/git/repos?slug=proj',
      `/api/ui/git/worktrees?slug=proj&${repo}`,
      `/api/ui/git?slug=proj&${repo}`,
    ]);
    const repos = [{ path: '', name: 'proj' }, { path: 'docs', name: 'docs' }];
    f.calls.find((c) => c.url.includes('/repos'))!.answer({ repos });
    await settle();
    assert.deepEqual(getGitSnapshot('repos', 'proj').data, repos);
    // The root's entry is not the nested one's.
    assert.equal(getGitSnapshot('dashboard', 'proj').data, null);
    for (const off of offs) off();
  } finally { f.restore(); }
});
