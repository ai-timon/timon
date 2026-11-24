/**
 * TODO #309 — the panel and the mission resolve the same browser project.
 *
 * Unit cases for the one function, then parity against the real paths: a
 * mission spawned by `spawnAgent` (fake host, no CLI) and the panel's
 * `GET /api/native-browser/resolve`, for the same agent, must land on the same
 * profile — otherwise a login made in one is missing from the other.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import express from 'express';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { getHost } = await import('./host/index.js');
await import('../tests/helpers/claude-provider.js');

const { spawnAgent, upsertAgent } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { getBrowserProfile } = await import('./browser-profiles.js');
const { resolveBrowserProject, taskIdOfSource } = await import('./browser-project.js');
const { projectFromRegisteredCwd } = await import('./task-project.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerNativeBrowserRoutes } = await import('./plugins-bundled/browser-embedded/native-routes.js');
const { hashSessionToken, SESSION_COOKIE } = await import('./users/session.js');
const { resolveMasterKey } = await import('./secrets/key.js');

resolveMasterKey({ keyring: null });

/* ── the function ─────────────────────────────────────────────────────────── */

const MAC_ROOT = join(tmpdir(), 'Users', 'someone', 'Documents', 'client-site');
const registry = [
  { slug: 'client-site', cwd: MAC_ROOT },
  { slug: 'client-site-docs', cwd: join(MAC_ROOT, 'docs') },
  { slug: 'no-root', cwd: null },
];

test('the precedence is agent, workflow, task, cwd marker, registered cwd, then ?project=', () => {
  const none = () => registry;
  const all = { agentProject: 'a', workflowProject: 'w', taskProject: 't', agentCwd: '/x/projects/m', requested: 'r' };
  assert.equal(resolveBrowserProject(all, none), 'a');
  assert.equal(resolveBrowserProject({ ...all, agentProject: null }, none), 'w');
  assert.equal(resolveBrowserProject({ ...all, agentProject: null, workflowProject: null }, none), 't');
  assert.equal(resolveBrowserProject({ ...all, agentProject: null, workflowProject: null, taskProject: null }, none), 'm');
  assert.equal(resolveBrowserProject({ agentCwd: join(MAC_ROOT, 'src'), requested: 'r' }, none), 'client-site');
  assert.equal(resolveBrowserProject({ agentCwd: '/elsewhere', requested: 'r' }, none), 'r');
});

test('an empty or blank slug is absent at every link', () => {
  const none = () => registry;
  assert.equal(resolveBrowserProject({
    agentProject: '', workflowProject: '  ', taskProject: '', agentCwd: '/x/projects/real/src', requested: '',
  }, none), 'real');
  assert.equal(resolveBrowserProject({ agentProject: '', requested: '' }, none), null);
});

test('a task worktree says nothing: the task project wins, then the agent cwd', () => {
  const worktree = join(tmpdir(), '.timon', 'worktrees', randomUUID());
  const none = () => registry;
  assert.equal(resolveBrowserProject({ cwdOverride: worktree, agentCwd: MAC_ROOT, taskProject: 'timon' }, none), 'timon');
  assert.equal(resolveBrowserProject({ cwdOverride: worktree, agentCwd: MAC_ROOT }, none), 'client-site');
  assert.equal(resolveBrowserProject({ cwdOverride: worktree }, none), null);
});

// The marker is the POSIX layout `projectFromCwd` reads: spelled with `/` so the
// precedence is checked on every OS (a Windows path carries no marker).
test('the …/projects/<slug> marker is tried before the registry', () => {
  const nested = [{ slug: 'registered-other', cwd: '/x/projects/marked' }];
  assert.equal(resolveBrowserProject({ agentCwd: '/x/projects/marked/src' }, () => nested), 'marked');
});

test('the registry matches whole path segments, the deepest root wins, projects without a root are ignored', () => {
  assert.equal(projectFromRegisteredCwd(MAC_ROOT, registry), 'client-site');
  assert.equal(projectFromRegisteredCwd(join(MAC_ROOT, 'docs', 'guide'), registry), 'client-site-docs');
  assert.equal(projectFromRegisteredCwd(`${MAC_ROOT}-old`, registry), null);
  assert.equal(projectFromRegisteredCwd(join(tmpdir(), 'Users', 'someone'), registry), null);
  assert.equal(projectFromRegisteredCwd(null, registry), null);
  assert.equal(projectFromRegisteredCwd(MAC_ROOT, []), null);
});

test('case does not separate two spellings of a root on macOS and Windows, only on Linux', () => {
  const upper = MAC_ROOT.toUpperCase();
  assert.equal(projectFromRegisteredCwd(upper, registry, 'darwin'), 'client-site');
  assert.equal(projectFromRegisteredCwd(upper, registry, 'win32'), 'client-site');
  // `node:path` on a Windows host compares without case whatever platform is asked.
  if (process.platform !== 'win32') assert.equal(projectFromRegisteredCwd(upper, registry, 'linux'), null);
});

test('the task id is read from a dispatcher source, never from anything else', () => {
  assert.equal(taskIdOfSource({ channel: 'dispatcher', meta: { task_id: 'abc' } }), 'abc');
  assert.equal(taskIdOfSource({ channel: 'dispatcher', meta: { task_id: 3 } }), null);
  assert.equal(taskIdOfSource({ channel: 'chat' }), null);
  assert.equal(taskIdOfSource(undefined), null);
});

/* ── the panel and the mission ────────────────────────────────────────────── */

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4243;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.emit('exit', 0, signal ?? null);
    child.emit('close', 0, signal ?? null);
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

const alice = createTestAccount(dbApi, { email: 'project-alice@example.test', name: 'Alice', passwordHash: 'unused' });
const cookie = randomUUID();
dbApi.createSession({ tokenHash: hashSessionToken(cookie), userId: alice.id, expiresAt: Date.now() + 60_000 });

const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: 'project-test-daemon' }));
app.use(express.json());
registerNativeBrowserRoutes(app, { capabilities: async () => ({ available: true }), call: async () => ({}) });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/native-browser`;

async function panel(query: string): Promise<{ id: string; scope_kind: string; scope_ref: string | null } | null> {
  const res = await fetch(`${origin}/resolve?${query}`, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
  assert.equal(res.status, 200);
  return (await res.json() as { profile: { id: string; scope_kind: string; scope_ref: string | null } | null }).profile;
}

const children: FakeChild[] = [];
test.after(() => {
  server.close();
  for (const child of children) if (!child.killed) child.kill();
});

async function spawnMission(agent: string, opts: Parameters<typeof spawnAgent>[3] = {}, source?: Parameters<typeof spawnAgent>[2]) {
  const host = getHost();
  const original = host.spawn;
  host.spawn = (() => {
    const child = fakeChild();
    children.push(child);
    return child;
  }) as typeof host.spawn;
  try {
    const missionId = await spawnAgent(agent, 'ping', source, { ownerUserId: alice.id, ...opts });
    const row = dbApi.getMission(missionId)!;
    return { missionId, profile: row.browser_profile_id ? getBrowserProfile(row.browser_profile_id) : null };
  } finally {
    host.spawn = original;
  }
}

function agentAt(name: string, cwd: string, project?: string): void {
  upsertAgent({
    name,
    system_prompt: 'witness — does nothing.',
    config: { backend: 'claude', cwd, skills: [], mcp_servers: [], memory_scope: 'NONE', ...(project === undefined ? {} : { project }) },
  });
}

test('a project registered outside …/projects/<slug> gives the panel and the mission one profile', async () => {
  const root = join(tmpdir(), `Documents-${randomUUID()}`, 'client-mac');
  mkdirSync(root, { recursive: true });
  const slug = `mac-${randomUUID().slice(0, 8)}`;
  dbApi.upsertProject(slug, { cwd: root });
  const agent = `mac-agent-${randomUUID().slice(0, 8)}`;
  agentAt(agent, root);

  const { profile: mission } = await spawnMission(agent);
  const shown = await panel(`agent=${agent}`);
  assert.equal(mission?.scope_kind, 'project');
  assert.equal(mission?.scope_ref, slug);
  assert.equal(shown?.id, mission?.id);
});

// The project comes from the `…/projects/<slug>` marker, which a Windows path does not carry.
test('an empty project in the agent config resolves like an absent one, in the panel and in the mission', { skip: process.platform === 'win32' ? 'no projects/<slug> marker in a Windows path' : false }, async () => {
  const root = join(tmpdir(), randomUUID(), 'projects', 'blank-config');
  mkdirSync(root, { recursive: true });
  const agent = `blank-agent-${randomUUID().slice(0, 8)}`;
  agentAt(agent, root, '');

  const { profile: mission } = await spawnMission(agent);
  const shown = await panel(`agent=${agent}`);
  assert.equal(mission?.scope_ref, 'blank-config');
  assert.equal(shown?.id, mission?.id);
});

test('a task mission in its worktree takes the task project, and the panel shows the same profile', async () => {
  const agent = `task-agent-${randomUUID().slice(0, 8)}`;
  agentAt(agent, tmpdir());
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'witness', agent, { type: 'code', project: 'task-owned', ownerUserId: alice.id });
  const worktree = join(tmpdir(), '.timon', 'worktrees', taskId);
  mkdirSync(worktree, { recursive: true });

  const { missionId, profile: mission } = await spawnMission(
    agent, { cwdOverride: worktree }, { channel: 'dispatcher', meta: { task_id: taskId } });
  assert.equal(mission?.scope_kind, 'project');
  assert.equal(mission?.scope_ref, 'task-owned');
  assert.equal((await panel(`mission=${missionId}`))?.id, mission?.id);
  assert.equal((await panel(`agent=${agent}&project=task-owned`))?.id, mission?.id);
});

test('?project= is the last resort: a project the agent already has wins over it', async () => {
  const agent = `pinned-agent-${randomUUID().slice(0, 8)}`;
  agentAt(agent, tmpdir(), 'pinned');
  const shown = await panel(`agent=${agent}&project=something-else`);
  assert.equal(shown?.scope_ref, 'pinned');
  const bare = await panel('project=only-requested');
  assert.equal(bare?.scope_ref, 'only-requested');
  assert.equal((await panel('project='))?.scope_kind, 'general');
});
