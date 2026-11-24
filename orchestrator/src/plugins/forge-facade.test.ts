/**
 * `ctx.forge` (API 19): a plugin reads a project's GitHub repository and
 * proposes a comment without ever holding `gh`, the project's account or what
 * `gh` printed. Refusals first: manifest, version, anonymous, an account
 * without `projects:manage`, a request no person made. Then what it reads,
 * how it proposes (once per key, never published), and the caps. Every
 * process goes through a recorder standing in for the host: `gh` answers from
 * fixtures and nothing reaches GitHub.
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'timon-plugin-forge-')));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION, FORGE_API_VERSION, SENSITIVE_PLUGIN_PERMISSIONS } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError, PluginForgeError } = await import('./context.js');
const { identityFromRequest, runPluginRequest } = await import('./als.js');
const { db, dbApi } = await import('../db.js');
const { getHost } = await import('../host/index.js');
const { proposeForgeWrite, proposalAnchor } = await import('../forge-proposals.js');
const { FORGE_CALLS_PER_PLUGIN, FORGE_OPEN_PROPOSALS_PER_PLUGIN } = await import('./forge-facade.js');
type ExecOpts = import('../host/types.js').ExecOpts;
type ExecResult = import('../host/types.js').ExecResult;

const home = process.env.TIMON_HOME;
const ghFolder = join(home, '.config', 'gh-acme-secret-folder');
mkdirSync(ghFolder, { recursive: true });
dbApi.upsertProject('acme', { cwd: join(home, 'code', 'acme') });
dbApi.upsertProject('local', { cwd: join(home, 'code', 'local') });
dbApi.setProjectIntegration('acme', JSON.stringify({
  mode: 'pr', remote: 'origin', target: 'main', forge: 'github', account: 'ai-bot',
  gh_config_dir: ghFolder, branch_prefix: 'feat/', remote_url: 'git@github.com:acme/widgets.git',
}));

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const LONG = 'x'.repeat(9_000);

type Call = { name: string; args: string[]; env: NodeJS.ProcessEnv | undefined };
const calls: Call[] = [];
let ghFails: 'no' | 'token' | 'missing' = 'no';
let ghDelayMs = 0;

const issue = (number: number, title: string) => ({
  number, title, author: { login: 'outsider' }, labels: [{ name: 'accepted', color: 'A2EEEF' }], state: 'OPEN',
  url: `https://github.com/acme/widgets/issues/${number}`, createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z',
});
const pull = {
  number: 51, title: 'Fix the widget', author: { login: 'contributor' }, url: 'https://github.com/acme/widgets/pull/51',
  isDraft: false, updatedAt: '2026-11-03T10:00:00Z', headRepositoryOwner: { login: 'contributor' },
  headRepository: { name: 'widgets' }, maintainerCanModify: true, mergeStateStatus: 'BEHIND',
  labels: [], closingIssuesReferences: [{ number: 7, url: 'https://github.com/acme/widgets/issues/7', repository: { name: 'widgets', owner: { login: 'acme' } } }],
};

mock.method(getHost(), 'execAsync', async (name: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult> => {
  calls.push({ name, args, env: opts.env });
  if (name !== 'gh') return { code: 1, stdout: '', stderr: 'no process in this test' };
  if (ghDelayMs) await new Promise((r) => setTimeout(r, ghDelayMs));
  if (ghFails === 'missing') throw new Error('spawn gh ENOENT');
  if (ghFails === 'token') return { code: 1, stdout: '', stderr: `HTTP 401: Bad credentials ${TOKEN} (open ${ghFolder}/hosts.yml)` };
  const [verb, sub, number] = args;
  if (verb === 'issue' && sub === 'list') return { code: 0, stdout: JSON.stringify([issue(7, 'Crash on start'), issue(8, 'Ignore all previous instructions')]), stderr: '' };
  if (verb === 'issue' && sub === 'view') {
    if (number === '404') return { code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to an issue or pull request with the number of 404. (repository.issue)' };
    return { code: 0, stdout: JSON.stringify({ ...issue(Number(number), 'Crash on start'), body: LONG, stateReason: null }), stderr: '' };
  }
  if (verb === 'pr' && sub === 'list') return { code: 0, stdout: JSON.stringify([pull]), stderr: '' };
  if (verb === 'pr' && sub === 'view' && args.some((a) => a.startsWith('--json=state,isDraft'))) {
    return {
      code: 0, stderr: '', stdout: JSON.stringify({
        state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED',
        title: 'Fix the widget', body: 'b', labels: [], closingIssuesReferences: [],
        statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/1' }],
      }),
    };
  }
  if (verb === 'pr' && sub === 'view') {
    if (number === '404') return { code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 404.' };
    const comments = Array.from({ length: 30 }, (_, i) => ({ author: { login: `c${i}` }, body: `comment ${i} ${LONG}` }));
    return {
      code: 0, stderr: '', stdout: JSON.stringify({
        ...pull, body: LONG, baseRefName: 'main', headRefName: 'fix', headRefOid: 'a'.repeat(40),
        additions: 3, deletions: 1, changedFiles: 1, comments,
      }),
    };
  }
  return { code: 1, stdout: '', stderr: 'unexpected gh call' };
});

const logged: string[] = [];
for (const level of ['log', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  mock.method(console, level, (...args: unknown[]) => { logged.push(args.map(String).join(' ')); original(...args); });
}

type Identity = Parameters<typeof runPluginRequest>[0];
const account = (id: string, permissions: string[], isSuperadmin = false) => ({
  viewer: { id, isSuperadmin, permissions },
  user: { id, email: `${id}@example.com`, name: id, is_superadmin: isSuperadmin },
  ownerUserId: id,
});
/** A person at a screen holding `projects:manage`. */
const person: Identity = { ...account('ada', ['projects:manage']), person: true };
/** The same account behind a mission's token or the daemon token: no person. */
const token: Identity = account('ada', ['projects:manage']);
const guest: Identity = { ...account('rita', []), person: true };
const anonymous: Identity = { viewer: null, user: undefined, ownerUserId: null };
const as = <T>(who: Identity, fn: () => Promise<T>) => runPluginRequest(who, fn);

const roots: Context[] = [];
after(async () => { for (const root of roots) await root.fiber.dispose(); });

async function pluginWith(permissions: string[], id = 'acme-forge', apiVersion: number = PLUGIN_API_VERSION) {
  const root = new Context();
  roots.push(root);
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id, apiVersion, permissions } });
  if (!res.ok) throw new Error(res.message);
  return createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
}

const forgeCode = (c: string) => (err: unknown) => err instanceof PluginForgeError && err.code === c;
const ghCalls = () => calls.filter((c) => c.name === 'gh');
const writes = () => ghCalls().filter((c) => c.args.includes('--method=POST') || c.args[0] === 'pr' && c.args[1] !== 'list' && c.args[1] !== 'view');

beforeEach(() => {
  ghFails = 'no';
  ghDelayMs = 0;
});

test('the manifest: `forge:*` needs API 19, and both permissions are sensitive', () => {
  assert.equal(FORGE_API_VERSION, 19);
  assert.ok(PLUGIN_API_VERSION >= FORGE_API_VERSION);
  for (const permission of ['forge:read', 'forge:propose']) {
    const old = readManifest({ timon: { id: 'old-forge', apiVersion: 18, permissions: [permission] } });
    assert.equal(old.ok, false);
    if (!old.ok) assert.match(old.message, new RegExp(`${permission}.*apiVersion: 19`));
    assert.equal(readManifest({ timon: { id: 'new-forge', apiVersion: 19, permissions: [permission] } }).ok, true);
    assert.ok((SENSITIVE_PLUGIN_PERMISSIONS as readonly string[]).includes(permission));
  }
});

test('without `forge:*` in the manifest every member refuses', async () => {
  const plugin = await pluginWith(['storage']);
  await assert.rejects(as(person, () => plugin.forge.repository('acme')), PluginPermissionError);
  await assert.rejects(as(person, () => plugin.forge.issues.list('acme', { label: 'accepted' })), PluginPermissionError);
  await assert.rejects(as(person, () => plugin.forge.pulls.list('acme')), PluginPermissionError);
  await assert.rejects(as(person, () => plugin.forge.propose('acme', { target: { type: 'issue', number: 7 }, body: 'x', key: 'k' })), PluginPermissionError);
  await assert.rejects(as(person, () => plugin.forge.proposals.list('acme')), PluginPermissionError);
  const reader = await pluginWith(['forge:read'], 'reader-only');
  await assert.rejects(as(person, () => reader.forge.propose('acme', { target: { type: 'issue', number: 7 }, body: 'x', key: 'k' })), PluginPermissionError);
  const proposer = await pluginWith(['forge:propose'], 'proposer-only');
  await assert.rejects(as(person, () => proposer.forge.issues.get('acme', 7)), PluginPermissionError);
  assert.equal(ghCalls().length, 0);
});

test('an anonymous request and an account without `projects:manage` are refused', async () => {
  const plugin = await pluginWith(['forge:read', 'forge:propose']);
  const before = ghCalls().length;
  await assert.rejects(as(anonymous, () => plugin.forge.issues.list('acme', { label: 'accepted' })), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.forge.propose('acme', { target: { type: 'issue', number: 7 }, body: 'x', key: 'k' })), PluginCallerError);
  await assert.rejects(as(guest, () => plugin.forge.pulls.list('acme')), PluginCallerError);
  await assert.rejects(as(guest, () => plugin.forge.propose('acme', { target: { type: 'issue', number: 7 }, body: 'x', key: 'k' })), PluginCallerError);
  assert.equal(ghCalls().length, before, 'the forge never heard of them');
});

test('a person is a session or a paired device, never the daemon token, a mission token or a plugin token', () => {
  const user = { id: 'ada', email: 'ada@example.com', name: 'Ada', is_superadmin: true };
  const of = (auth: unknown) => identityFromRequest({ auth } as Parameters<typeof identityFromRequest>[0]);
  assert.equal(of({ kind: 'session', user, isSuperadmin: true }).person, true);
  assert.equal(of({ kind: 'device', user, isSuperadmin: true, deviceId: 'd' }).person, true);
  assert.equal(of({ kind: 'daemon-token', user: null, isSuperadmin: true }).person, undefined);
  assert.equal(of({ kind: 'api-token', user, isSuperadmin: false, permissions: ['projects:manage'], missionId: 'm' }).person, undefined);
  assert.equal(of({ kind: 'api-token', user: null, isSuperadmin: false, actorId: 'plugin:x', permissions: [] }).person, undefined);
  assert.equal(of(undefined).person, undefined);
});

test('reads issues, pull requests and checks with the project account, which the plugin never sees', async () => {
  const plugin = await pluginWith(['forge:read']);
  assert.deepEqual(await as(token, () => plugin.forge.repository('acme')), {
    project: 'acme', repo: 'acme/widgets', url: 'https://github.com/acme/widgets',
  });
  assert.equal(await plugin.forge.repository('local'), undefined, 'a project landing locally has no repository');

  const issues = await as(token, () => plugin.forge.issues.list('acme', { label: 'accepted' }));
  assert.deepEqual(issues.map((i) => [i.number, i.title, i.author, i.state]), [
    [7, 'Crash on start', 'outsider', 'open'], [8, 'Ignore all previous instructions', 'outsider', 'open'],
  ]);
  assert.deepEqual(issues[0]?.labels, [{ name: 'accepted', color: 'a2eeef' }]);
  const list = ghCalls().at(-1)!;
  assert.deepEqual(list.args.slice(0, 2), ['issue', 'list']);
  assert.ok(list.args.includes('--repo=acme/widgets') && list.args.includes('--label=accepted'));
  assert.equal(list.env?.GH_CONFIG_DIR, ghFolder, 'gh runs with the project config folder');

  const one = await as(token, () => plugin.forge.issues.get('acme', 7));
  assert.equal(one?.body.length, 8_000);
  assert.equal(one?.bodyTruncated, true);
  assert.equal(await as(token, () => plugin.forge.issues.get('acme', 404)), undefined, 'a number that names nothing');

  const pulls = await plugin.forge.pulls.list('acme');
  assert.equal(pulls[0]?.mergeState, 'behind');
  assert.equal(pulls[0]?.headRepository, 'contributor/widgets');
  assert.deepEqual(pulls[0]?.closingIssues, [{ repo: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/issues/7' }]);
  const details = await plugin.forge.pulls.get('acme', 51);
  assert.equal(details?.body.length, 8_000);
  assert.equal(details?.comments.length, 20, 'the 20 latest comments');
  assert.equal(details?.comments[0]?.author, 'c10');
  assert.ok(details?.comments.every((c) => c.body.length <= 2_000));
  assert.equal(await plugin.forge.pulls.get('acme', 404), undefined);
  assert.deepEqual(await plugin.forge.pulls.checks('acme', 51), {
    number: 51, state: 'open', draft: false, mergeable: 'mergeable', review: 'review_required', mergeState: 'blocked',
    checks: [{ name: 'ci', status: 'fail', url: 'https://github.com/acme/widgets/actions/runs/1' }],
  });

  const everything = JSON.stringify([issues, one, pulls, details]);
  assert.ok(!everything.includes(ghFolder) && !everything.includes('ai-bot'), 'neither the folder nor the account');
  assert.equal(writes().length, 0, 'reading never writes');
});

test('odd input, an unknown project and a project without a repository are refused before gh runs', async () => {
  const plugin = await pluginWith(['forge:read']);
  const before = ghCalls().length;
  await assert.rejects(plugin.forge.issues.list('../etc', { label: 'accepted' }), forgeCode('invalid'));
  await assert.rejects(plugin.forge.issues.list('acme', { label: 'a,b' }), forgeCode('invalid'));
  await assert.rejects(plugin.forge.issues.list('acme', {} as { label: string }), forgeCode('invalid'));
  await assert.rejects(plugin.forge.issues.get('acme', -1), forgeCode('invalid'));
  await assert.rejects(plugin.forge.pulls.get('acme', 1.5), forgeCode('invalid'));
  await assert.rejects(plugin.forge.pulls.list('nope'), forgeCode('not_found'));
  await assert.rejects(plugin.forge.pulls.list('local'), forgeCode('not_configured'));
  assert.equal(ghCalls().length, before);
});

test('a forge that fails answers `unavailable`, with nothing gh printed', async () => {
  const plugin = await pluginWith(['forge:read']);
  for (const mode of ['token', 'missing'] as const) {
    ghFails = mode;
    await assert.rejects(plugin.forge.pulls.list('acme'), (err: unknown) => {
      assert.ok(err instanceof PluginForgeError);
      assert.equal(err.code, 'unavailable');
      assert.ok(!err.message.includes(TOKEN) && !err.message.includes(ghFolder));
      return true;
    });
  }
  assert.ok(!logged.some((line) => line.includes(TOKEN)));
});

test(`at most ${FORGE_CALLS_PER_PLUGIN} forge calls of one plugin run at once`, async () => {
  const plugin = await pluginWith(['forge:read'], 'busy-reader');
  const other = await pluginWith(['forge:read'], 'other-reader');
  ghDelayMs = 50;
  const running = Array.from({ length: FORGE_CALLS_PER_PLUGIN }, () => plugin.forge.pulls.list('acme'));
  await assert.rejects(plugin.forge.pulls.list('acme'), forgeCode('busy'));
  const theirs = other.forge.pulls.list('acme');
  await Promise.all([...running, theirs]);
  ghDelayMs = 0;
  assert.equal((await plugin.forge.pulls.list('acme')).length, 1, 'the slots are given back');
});

test('a job proposes a comment once per key: a card, a draft, and nothing written on the forge', async () => {
  const plugin = await pluginWith(['forge:propose'], 'issue-bot');
  const before = ghCalls().length;
  const first = await plugin.forge.propose('acme', {
    target: { type: 'issue', number: 7 }, body: 'Fixed in #51.', key: 'todo:1', sourceRef: 'todo:1',
  });
  assert.equal(first.created, true);
  assert.equal(first.proposal.state, 'draft');
  assert.equal(first.proposal.key, 'todo:1');
  assert.equal(first.proposal.sourceRef, 'todo:1');
  assert.deepEqual(first.proposal.target, { type: 'issue', number: 7, url: 'https://github.com/acme/widgets/issues/7' });
  const row = db.prepare('SELECT * FROM forge_proposals WHERE id = ?').get(first.proposal.id) as Record<string, unknown>;
  assert.equal(row.trigger, 'plugin');
  assert.equal(row.created_by, 'plugin:issue-bot');
  assert.equal(row.idem_key, 'plugin:issue-bot:todo:1');
  const card = db.prepare('SELECT * FROM notifications WHERE anchor = ?').get(proposalAnchor('acme', first.proposal.id)) as Record<string, unknown> | undefined;
  assert.equal(card?.type, 'action_required');

  const again = await plugin.forge.propose('acme', { target: { type: 'issue', number: 7 }, body: 'Another text', key: 'todo:1' });
  assert.equal(again.created, false);
  assert.equal(again.proposal.id, first.proposal.id);
  assert.equal(again.proposal.body, 'Fixed in #51.');
  assert.equal(ghCalls().length, before, 'proposing never calls the forge');
  assert.equal(typeof (plugin.forge as Record<string, unknown>).publish, 'undefined');
});

test('a plugin key never reaches the daemon\'s or another plugin\'s proposal', async () => {
  const daemon = proposeForgeWrite({
    project: 'acme', kind: 'comment', target: { type: 'issue', number: 9 }, body: 'Daemon text', trigger: 'todo_resolved',
    key: 'todo:42:comment', createdBy: null,
  });
  assert.ok(daemon.ok);
  const mine = await pluginWith(['forge:propose'], 'plugin-a');
  const theirs = await pluginWith(['forge:propose'], 'plugin-b');
  const a = await mine.forge.propose('acme', { target: { type: 'issue', number: 9 }, body: 'A', key: 'todo:42:comment' });
  assert.equal(a.created, true);
  assert.notEqual(a.proposal.id, daemon.proposal.id);
  const b = await theirs.forge.propose('acme', { target: { type: 'issue', number: 9 }, body: 'B', key: 'todo:42:comment' });
  assert.equal(b.created, true);
  assert.notEqual(b.proposal.id, a.proposal.id);

  assert.deepEqual((await mine.forge.proposals.list('acme')).map((p) => p.id), [a.proposal.id]);
  assert.equal((await mine.forge.proposals.get('acme', a.proposal.id))?.body, 'A');
  assert.equal(await mine.forge.proposals.get('acme', b.proposal.id), undefined, 'another plugin\'s');
  assert.equal(await mine.forge.proposals.get('acme', daemon.proposal.id), undefined, 'the daemon\'s');
});

test('in a request, only a person may have the plugin propose: never a token without one', async () => {
  const plugin = await pluginWith(['forge:propose'], 'route-bot');
  const input = { target: { type: 'pull' as const, number: 51 }, body: 'Thanks!', key: 'pr:51' };
  await assert.rejects(as(token, () => plugin.forge.propose('acme', input)), forgeCode('forbidden'));
  const made = await as(person, () => plugin.forge.propose('acme', input));
  assert.equal(made.created, true);
  assert.equal(made.proposal.target.url, 'https://github.com/acme/widgets/pull/51');
  // An event handler runs unattended: the plugin acts as itself.
  const unattended = await as({ ...token, unattended: true }, () => plugin.forge.propose('acme', { ...input, key: 'pr:51:event' }));
  assert.equal(unattended.created, true);
});

test('a proposal is checked like any other, and a plugin holds at most a bounded number open', async () => {
  const plugin = await pluginWith(['forge:propose'], 'noisy-bot');
  const target = { type: 'issue' as const, number: 7 };
  await assert.rejects(plugin.forge.propose('acme', { target, body: '', key: 'k' }), forgeCode('invalid'));
  await assert.rejects(plugin.forge.propose('acme', { target, body: 'x'.repeat(8_001), key: 'k' }), forgeCode('invalid'));
  await assert.rejects(plugin.forge.propose('acme', { target, body: 'a\u0007b', key: 'k' }), forgeCode('invalid'));
  await assert.rejects(plugin.forge.propose('acme', { target, body: 'x <!-- timon-proposal:00000000-0000-0000-0000-000000000000 -->', key: 'k' }), forgeCode('invalid'));
  await assert.rejects(plugin.forge.propose('acme', { target, body: 'x', key: '' }), forgeCode('invalid'));
  await assert.rejects(plugin.forge.propose('acme', { target, body: 'x', key: 'k'.repeat(121) }), forgeCode('invalid'));
  await assert.rejects(plugin.forge.propose('acme', { target: { type: 'label', number: 7 } as never, body: 'x', key: 'k' }), forgeCode('invalid'));
  await assert.rejects(plugin.forge.propose('local', { target, body: 'x', key: 'k' }), forgeCode('not_configured'));
  await assert.rejects(plugin.forge.propose('nope', { target, body: 'x', key: 'k' }), forgeCode('not_found'));

  for (let i = 0; i < FORGE_OPEN_PROPOSALS_PER_PLUGIN; i += 1) {
    await plugin.forge.propose('acme', { target, body: `n${i}`, key: `n${i}` });
  }
  await assert.rejects(plugin.forge.propose('acme', { target, body: 'one more', key: 'over' }), forgeCode('busy'));
  const known = await plugin.forge.propose('acme', { target, body: 'again', key: 'n0' });
  assert.equal(known.created, false, 'a key already used still answers');
  assert.equal(writes().length, 0);
});
