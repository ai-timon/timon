/**
 * Publications proposed on the forge: who may propose, edit and publish, the
 * account `gh` must answer for, idempotence at both ends, and nothing secret in
 * an answer, a row or a log. Every process goes through a recorder standing in
 * for the host: `gh` answers from fixtures and nothing reaches GitHub.
 */
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, mock, test } from 'node:test';
import express from 'express';
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import { db, dbApi } from '../../db.js';
import { getHost } from '../../host/index.js';
import type { ExecOpts, ExecResult } from '../../host/types.js';
import {
  proposalAnchor, proposalMarker, proposeForgeWrite, recoverInterruptedPublications,
} from '../../forge-proposals.js';
import { registerForgeProposalRoutes } from './forge-proposal-routes.js';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'timon-forge-proposals-')));
const ghFolder = join(home, '.config', 'gh-acme-secret-folder');
mkdirSync(ghFolder, { recursive: true });
dbApi.upsertProject('acme', { cwd: join(home, 'code', 'acme') });
dbApi.upsertProject('solo', { cwd: join(home, 'code', 'solo') });
dbApi.upsertProject('unset', { cwd: join(home, 'code', 'unset') });
const integration = (account: string | null) => JSON.stringify({
  mode: 'pr', remote: 'origin', target: 'main', forge: 'github', account,
  gh_config_dir: ghFolder, branch_prefix: 'feat/', remote_url: 'git@github.com:acme/widgets.git',
});
dbApi.setProjectIntegration('acme', integration('ai-bot'));

const admin = createTestAccount(dbApi, { email: 'maintainer@example.test', name: 'Maintainer', passwordHash: 'x', isSuperadmin: true });
const guest = createTestAccount(dbApi, { email: 'guest@example.test', name: 'Guest', passwordHash: 'x', isSuperadmin: false });

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

type Call = { name: string; args: string[]; env: NodeJS.ProcessEnv | undefined };
const calls: Call[] = [];
let login = 'ai-bot';
let postFails: 'no' | 'token' | 'timeout' = 'no';
let existingComment = '';
let postDelayMs = 0;
let commentId = 1000;

mock.method(getHost(), 'execAsync', async (name: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult> => {
  calls.push({ name, args, env: opts.env });
  if (name !== 'gh') return { code: 1, stdout: '', stderr: 'no process in this test' };
  if (args[0] === 'api' && args[1] === 'user') return { code: 0, stdout: `${login}\n`, stderr: '' };
  if (args[0] === 'api' && args[1] === '--paginate') return { code: 0, stdout: existingComment, stderr: '' };
  if (args[0] === 'api' && args[1] === '--method=POST') {
    if (postDelayMs) await new Promise((r) => setTimeout(r, postDelayMs));
    if (postFails === 'token') {
      return { code: 1, stdout: '', stderr: `HTTP 401: Bad credentials ${TOKEN} (open ${ghFolder}/hosts.yml)` };
    }
    if (postFails === 'timeout') return { code: 1, stdout: '', stderr: '', timedOut: true };
    const id = ++commentId;
    const number = /issues\/(\d+)\/comments/.exec(args[2] ?? '')?.[1];
    return { code: 0, stdout: JSON.stringify({ id, html_url: `https://github.com/acme/widgets/issues/${number}#issuecomment-${id}` }), stderr: '' };
  }
  return { code: 1, stdout: '', stderr: 'unexpected gh call' };
});

const logged: string[] = [];
for (const level of ['log', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  mock.method(console, level, (...args: unknown[]) => { logged.push(args.map(String).join(' ')); original(...args); });
}

const app = express();
app.use(express.json());
// Stand-in for the daemon's auth middleware: no header = anonymous.
app.use((req, _res, next) => {
  const who = req.header('x-test-who');
  if (who === 'daemon') req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true };
  else if (who === 'mission') {
    req.auth = { kind: 'api-token', user: admin, isSuperadmin: false, permissions: ['projects:manage', 'kanban:write'], missionId: 'm-1' };
  } else if (who === 'plugin') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: 'plugin:x', permissions: ['projects:manage'] };
  else if (who === 'person') req.auth = { kind: 'session', user: admin, isSuperadmin: true };
  else if (who === 'device') req.auth = { kind: 'device', user: admin, isSuperadmin: true, deviceId: 'd-1' };
  else if (who === 'guest') req.auth = { kind: 'session', user: guest, isSuperadmin: false };
  next();
});
registerForgeProposalRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => { server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Who = 'anonymous' | 'daemon' | 'mission' | 'plugin' | 'person' | 'device' | 'guest';
function call(method: string, path: string, who: Who, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who !== 'anonymous') headers['x-test-who'] = who;
  return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

type View = { id: string; state: string; body: string; account: string | null; url: string | null; key: string; error: { code: string; reason: string | null } | null };

async function propose(number: number, body = 'Thanks, fixed in #51.'): Promise<View> {
  const res = await call('POST', '/api/projects/acme/forge-proposals', 'person', { kind: 'comment', target: { type: 'issue', number }, body });
  assert.equal(res.status, 201);
  return ((await res.json()) as { proposal: View }).proposal;
}

const posts = () => calls.filter((c) => c.name === 'gh' && c.args[1] === '--method=POST');
const writes = () => calls.filter((c) => c.name !== 'gh' || !(
  (c.args[0] === 'api' && (c.args[1] === 'user' || c.args[1] === '--paginate' || c.args[1] === '--method=POST'))
));

beforeEach(() => {
  login = 'ai-bot';
  postFails = 'no';
  existingComment = '';
  postDelayMs = 0;
});

test('anonymous: every route answers 401', async () => {
  const id = '00000000-0000-4000-8000-000000000000';
  for (const [method, path] of [
    ['GET', '/api/projects/acme/forge-proposals'],
    ['GET', `/api/projects/acme/forge-proposals/${id}`],
    ['POST', '/api/projects/acme/forge-proposals'],
    ['PATCH', `/api/projects/acme/forge-proposals/${id}`],
    ['POST', `/api/projects/acme/forge-proposals/${id}/publish`],
    ['POST', `/api/projects/acme/forge-proposals/${id}/discard`],
  ] as const) {
    assert.equal((await call(method, path, 'anonymous', method === 'GET' ? undefined : {})).status, 401, `${method} ${path}`);
  }
});

test('the daemon token, a mission token and a plugin token can neither propose, edit, publish nor discard', async () => {
  const proposal = await propose(301);
  const before = calls.length;
  for (const who of ['daemon', 'mission', 'plugin'] as const) {
    const created = await call('POST', '/api/projects/acme/forge-proposals', who, { kind: 'comment', target: { type: 'issue', number: 302 }, body: 'hi' });
    assert.equal(created.status, 403, who);
    assert.equal(((await created.json()) as { code: string }).code, 'person_required');
    assert.equal((await call('PATCH', `/api/projects/acme/forge-proposals/${proposal.id}`, who, { body: 'changed' })).status, 403, who);
    assert.equal((await call('POST', `/api/projects/acme/forge-proposals/${proposal.id}/publish`, who, {})).status, 403, who);
    assert.equal((await call('POST', `/api/projects/acme/forge-proposals/${proposal.id}/discard`, who, {})).status, 403, who);
  }
  assert.equal(calls.length, before, 'nothing reached gh');
  const row = ((await (await call('GET', `/api/projects/acme/forge-proposals/${proposal.id}`, 'daemon')).json()) as { proposal: View }).proposal;
  assert.equal(row.state, 'draft');
  assert.equal(row.body, 'Thanks, fixed in #51.');
});

test('a person without projects:manage is refused; a paired device acts for its person', async () => {
  assert.equal((await call('POST', '/api/projects/acme/forge-proposals', 'guest', { kind: 'comment', target: { type: 'issue', number: 303 }, body: 'hi' })).status, 403);
  assert.equal((await call('GET', '/api/projects/acme/forge-proposals', 'guest')).status, 403);
  const res = await call('POST', '/api/projects/acme/forge-proposals', 'device', { kind: 'comment', target: { type: 'pull', number: 304 }, body: 'Could you rebase on main?' });
  assert.equal(res.status, 201);
});

test('a person proposes once per target; the card waits in the notification centre', async () => {
  const first = await propose(310);
  const again = await call('POST', '/api/projects/acme/forge-proposals', 'person', { kind: 'comment', target: { type: 'issue', number: 310 }, body: 'other' });
  assert.equal(again.status, 200);
  const second = (await again.json()) as { proposal: View; created: boolean };
  assert.equal(second.created, false);
  assert.equal(second.proposal.id, first.id);
  const cards = db.prepare(`SELECT * FROM notifications WHERE anchor = ? AND dismissed_at IS NULL`).all(proposalAnchor('acme', first.id)) as { type: string }[];
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.type, 'action_required');
  // The card names the project: the screen reads a proposal under it.
  assert.equal(proposalAnchor('acme', first.id), `forge-proposal:acme:${first.id}`);
});

test('the daemon proposes under a key: the same trigger twice is one proposal', () => {
  const input = {
    project: 'acme', kind: 'comment' as const, target: { type: 'issue' as const, number: 320 },
    body: 'Fixed in #51, released in the next version.', trigger: 'todo_resolved' as const, key: 'todo:42:comment', createdBy: null,
  };
  const one = proposeForgeWrite(input);
  const two = proposeForgeWrite({ ...input, body: 'another text' });
  assert.ok(one.ok && two.ok);
  assert.equal(one.created, true);
  assert.equal(two.created, false);
  assert.equal(two.proposal.id, one.proposal.id);
  assert.equal(two.proposal.body, input.body);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM forge_proposals WHERE idem_key = 'todo:42:comment'`).get() as { n: number }).n, 1);
});

test('a project without a GitHub repository or an account gets no proposal, and odd input is refused', async () => {
  const solo = proposeForgeWrite({ project: 'solo', kind: 'comment', target: { type: 'issue', number: 1 }, body: 'hi', trigger: 'person', createdBy: null });
  assert.ok(!solo.ok && solo.code === 'integration_not_pr');
  for (const body of [
    { kind: 'comment', target: { type: 'issue', number: 0 }, body: 'hi' },
    { kind: 'review', target: { type: 'pull', number: 1 }, body: 'hi' },
    { kind: 'comment', target: { type: 'issue', number: 1 }, body: '   ' },
    { kind: 'comment', target: { type: 'issue', number: 1 }, body: 'x'.repeat(8_001) },
    { kind: 'comment', target: { type: 'issue', number: 1 }, body: `hi ${proposalMarker('00000000-0000-4000-8000-000000000000')}` },
    { kind: 'comment', target: { type: 'issue', number: 1 }, body: 'hi', approve: true },
  ]) {
    assert.equal((await call('POST', '/api/projects/acme/forge-proposals', 'person', body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
});

test('publishing checks the account first: another login is refused and nothing is written', async () => {
  const proposal = await propose(330);
  login = 'other-account';
  const before = posts().length;
  const res = await call('POST', `/api/projects/acme/forge-proposals/${proposal.id}/publish`, 'person', {});
  assert.equal(res.status, 409);
  const out = (await res.json()) as { code: string; proposal: View };
  assert.equal(out.code, 'forge_account_mismatch');
  assert.equal(out.proposal.state, 'draft', 'the proposal waits again');
  assert.equal(posts().length, before);
  const user = calls.findLast((c) => c.args[0] === 'api' && c.args[1] === 'user');
  assert.equal(user?.env?.GH_CONFIG_DIR, ghFolder, 'gh runs with the project folder');
  assert.equal(user?.env?.GH_TOKEN, undefined);

  dbApi.setProjectIntegration('unset', JSON.stringify({ ...JSON.parse(integration('ai-bot')), account: 'ai-bot' }));
  const other = proposeForgeWrite({ project: 'unset', kind: 'comment', target: { type: 'issue', number: 1 }, body: 'hi', trigger: 'person', createdBy: null });
  assert.ok(other.ok);
  dbApi.setProjectIntegration('unset', JSON.stringify({ ...JSON.parse(integration('ai-bot')), account: null }));
  const unset = await call('POST', `/api/projects/unset/forge-proposals/${other.proposal.id}/publish`, 'person', {});
  const unsetBody = (await unset.json()) as { code: string };
  assert.ok(unset.status === 409, `${unset.status}`);
  assert.ok(['forge_account_unset', 'integration_invalid'].includes(unsetBody.code), unsetBody.code);
  assert.equal(posts().length, before);
});

test('a proposal is published once, with the edited text and its marker, then answers what it published', async () => {
  const proposal = await propose(340);
  const res = await call('POST', `/api/projects/acme/forge-proposals/${proposal.id}/publish`, 'person', { body: 'Edited: fixed in #51.' });
  assert.equal(res.status, 200);
  const out = (await res.json()) as { proposal: View; already: boolean };
  assert.equal(out.already, false);
  assert.equal(out.proposal.state, 'published');
  assert.equal(out.proposal.account, 'ai-bot');
  assert.match(out.proposal.url ?? '', /^https:\/\/github\.com\/acme\/widgets\/issues\/340#issuecomment-\d+$/);
  const post = posts().at(-1);
  assert.deepEqual(post?.args.slice(0, 3), ['api', '--method=POST', 'repos/acme/widgets/issues/340/comments']);
  assert.equal(post?.args[3], `--raw-field=body=Edited: fixed in #51.\n\n${proposalMarker(proposal.id)}`);
  assert.equal(post?.env?.GH_CONFIG_DIR, ghFolder);

  const count = posts().length;
  const again = await call('POST', `/api/projects/acme/forge-proposals/${proposal.id}/publish`, 'person', {});
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { already: boolean }).already, true);
  assert.equal(posts().length, count, 'a second publication never reaches the forge');
  assert.equal((await call('PATCH', `/api/projects/acme/forge-proposals/${proposal.id}`, 'person', { body: 'late' })).status, 409);
  assert.equal((await call('POST', `/api/projects/acme/forge-proposals/${proposal.id}/discard`, 'person', {})).status, 409);
  const open = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE anchor = ? AND dismissed_at IS NULL`).get(proposalAnchor('acme', proposal.id)) as { n: number };
  assert.equal(open.n, 0, 'the card closes once published');
  assert.deepEqual(writes(), [], 'no other process ever ran');
});

test('two clicks at once publish one comment', async () => {
  const proposal = await propose(350);
  postDelayMs = 50;
  const count = posts().length;
  const [a, b] = await Promise.all([
    call('POST', `/api/projects/acme/forge-proposals/${proposal.id}/publish`, 'person', {}),
    call('POST', `/api/projects/acme/forge-proposals/${proposal.id}/publish`, 'person', {}),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const refused = (await (a.status === 409 ? a : b).json()) as { code: string };
  assert.equal(refused.code, 'forge_proposal_busy');
  assert.equal(posts().length, count + 1);
});

test('a failed publication keeps no secret in its answer, its row or the logs, and can be retried', async () => {
  const proposal = await propose(360);
  postFails = 'token';
  logged.length = 0;
  const res = await call('POST', `/api/projects/acme/forge-proposals/${proposal.id}/publish`, 'person', {});
  assert.equal(res.status, 502);
  const text = await res.text();
  const row = db.prepare(`SELECT * FROM forge_proposals WHERE id = ?`).get(proposal.id) as { state: string; error: string; error_code: string };
  assert.equal(row.state, 'failed');
  assert.equal(row.error_code, 'forge_publish_failed');
  for (const where of [text, row.error, logged.join('\n')]) {
    assert.ok(!where.includes(TOKEN) && !where.includes('ghp_'), 'no token');
    assert.ok(!where.includes(ghFolder), 'no config folder');
  }
  // The retry looks for the comment first: the forge did not take it.
  postFails = 'no';
  const count = posts().length;
  const retry = await call('POST', `/api/projects/acme/forge-proposals/${proposal.id}/publish`, 'person', {});
  assert.equal(retry.status, 200);
  assert.equal(posts().length, count + 1);
  const lookup = calls.findLast((c) => c.args[1] === '--paginate');
  assert.ok(lookup?.args.some((a) => a.includes(proposalMarker(proposal.id))));
});

test('an interrupted publication is recovered and found on the forge rather than posted twice', async () => {
  const proposal = await propose(370);
  db.prepare(`UPDATE forge_proposals SET state = 'publishing', attempts = 1 WHERE id = ?`).run(proposal.id);
  assert.equal(recoverInterruptedPublications(), 1);
  const row = db.prepare(`SELECT state, error_code FROM forge_proposals WHERE id = ?`).get(proposal.id) as { state: string; error_code: string };
  assert.deepEqual({ ...row }, { state: 'failed', error_code: 'interrupted' });
  existingComment = '777 https://github.com/acme/widgets/issues/370#issuecomment-777\n';
  const count = posts().length;
  const res = await call('POST', `/api/projects/acme/forge-proposals/${proposal.id}/publish`, 'person', {});
  const out = (await res.json()) as { proposal: View; already: boolean };
  assert.equal(res.status, 200);
  assert.equal(out.already, true);
  assert.equal(out.proposal.url, 'https://github.com/acme/widgets/issues/370#issuecomment-777');
  assert.equal(posts().length, count);
});

test('a person edits, then discards: the card goes, the forge never hears of it', async () => {
  const proposal = await propose(380);
  const before = calls.length;
  const edited = await call('PATCH', `/api/projects/acme/forge-proposals/${proposal.id}`, 'person', { body: 'Shorter.' });
  assert.equal(((await edited.json()) as { proposal: View }).proposal.body, 'Shorter.');
  const discarded = await call('POST', `/api/projects/acme/forge-proposals/${proposal.id}/discard`, 'person', {});
  assert.equal(((await discarded.json()) as { proposal: View }).proposal.state, 'discarded');
  assert.equal((await call('POST', `/api/projects/acme/forge-proposals/${proposal.id}/publish`, 'person', {})).status, 409);
  assert.equal(calls.length, before);
  const open = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE anchor = ? AND dismissed_at IS NULL`).get(proposalAnchor('acme', proposal.id)) as { n: number };
  assert.equal(open.n, 0);
  const listed = (await (await call('GET', '/api/projects/acme/forge-proposals?state=discarded', 'person')).json()) as { proposals: View[] };
  assert.ok(listed.proposals.some((p) => p.id === proposal.id));
  assert.equal((await call('GET', `/api/projects/solo/forge-proposals/${proposal.id}`, 'person')).status, 404, 'another project never sees it');
});

test('no agent surface creates or publishes a proposal: no MCP tool, no CLI verb; the plugin facade only proposes', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|mjs|js)$/.test(name) && !/\.test\.ts$/.test(name)) files.push(path);
    }
  };
  walk(join(root, 'bin'));
  walk(join(root, 'src'));
  const allowed = new Set([
    join(root, 'src', 'forge-proposals.ts'),
    join(root, 'src', 'plugins-bundled', 'kanban', 'forge-proposal-routes.ts'),
    join(root, 'src', 'plugins-bundled', 'kanban', 'index.ts'),
  ]);
  // `ctx.forge.propose` (API 19) stores a proposal for a person to publish:
  // its facade may create one, never edit, discard or publish one.
  const facade = join(root, 'src', 'plugins', 'forge-facade.ts');
  // The daemon's own producer, after a merge: it proposes, a person publishes.
  const landing = join(root, 'src', 'issue-resolution.ts');
  // A person's click on a pull request's branch: the daemon reads the branch
  // and proposes the update; the person publishes it through the route above.
  const branch = [
    join(root, 'src', 'forge-branch-update.ts'),
    join(root, 'src', 'plugins-bundled', 'kanban', 'forge-branch-routes.ts'),
  ];
  // A person's conflict resolution: proposed by the daemon on a person's
  // click; dropping it drops its waiting publication too, never publishes it.
  const conflicts = join(root, 'src', 'forge-conflicts.ts');
  const proposers = [facade, landing, ...branch, conflicts];
  const offenders = files.filter((file) => !allowed.has(file) && !proposers.includes(file)
    && /\/forge-proposals\b|forge-proposals\.js|proposeForgeWrite|publishForgeProposal/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders.map((f) => f.slice(root.length)), []);
  for (const file of proposers) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /publishForgeProposal|editForgeProposal|recoverInterruptedPublications/, file);
    if (file !== conflicts) assert.doesNotMatch(text, /discardForgeProposal/, file);
  }
});
