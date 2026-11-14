/**
 * `/api/skills` and `/api/mcp` writes by a caller who is not the operator:
 * a human holding `skills:manage` without `agents:privileged-config`, and the
 * mission tokens (cap ∩ launcher). Isolated TIMON_HOME, witness on 127.0.0.1:0.
 *
 * TIMON_HOME is nested one level down so that a `..` walked out of the skills
 * folder lands in this test's own temp tree, never in the machine's /tmp.
 */
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, linkSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

const SANDBOX = mkdtempSync(join(tmpdir(), 'timon-skills-guard-'));
process.env.TIMON_HOME = join(SANDBOX, 'home');
mkdirSync(process.env.TIMON_HOME, { recursive: true });
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgents } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SKILLS_DIR, skillFile } = await import('../../paths.js');
const { MCP_DIR, holdLegacyMissionServersToPublic, resolveLaunchServers } = await import('../../mcp.js');
const { setMcpHostLookupForTest } = await import('../../mcp-url-guard.js');
const { MCP_PROXY_HEADER, stopMcpLaunchProxyForTest } = await import('../../mcp-launch-proxy.js');
const { hashApiToken, issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

// Names resolve without the network. Anything not listed is public; the
// `rebind` entry is what an attacker's DNS answers right now.
const OWN_PUBLIC_ADDRESS = '203.0.113.7';
const DNS: Record<string, string[]> = {
  'loop.example.net': ['127.0.0.1'],
  'lan.example.net': ['192.168.1.20'],
  'ten.example.net': ['10.1.2.3'],
  'tailnet.example.net': ['100.101.102.103'],
  'meta.example.net': ['169.254.169.254'],
  'ula.example.net': ['fd12:3456::1'],
  'mapped.example.net': ['::ffff:127.0.0.1'],
  'mixed.example.net': ['93.184.215.14', '127.0.0.1'],
  'self.example.net': [OWN_PUBLIC_ADDRESS],
  'rebind.example.net': ['93.184.215.14'],
};
setMcpHostLookupForTest(async (hostname) => {
  if (hostname === 'nxdomain.example.net') throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return (DNS[hostname] ?? ['93.184.215.14']).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}, ['127.0.0.1', '::1', OWN_PUBLIC_ADDRESS]);
test.after(async () => { setMcpHostLookupForTest(null); await stopMcpLaunchProxyForTest(); });

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerAgents(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
  for (const line of lines) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

type Auth = { cookie?: string; bearer?: string };

async function call(
  method: string,
  path: string,
  opts: Auth & { body?: unknown } = {},
): Promise<{ status: number; json: unknown; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, res };
}

/** `fetch` folds `%2E` / `%2F` into the URL; a raw client does not. */
function rawDelete(rawPath: string, auth: Auth): Promise<{ status: number; json: unknown }> {
  return new Promise((resolveCall, reject) => {
    const headers: Record<string, string> = {};
    if (auth.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(auth.cookie)}`;
    if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
    const req = request({ host: '127.0.0.1', port, method: 'DELETE', path: rawPath, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += String(chunk); });
      res.on('end', () => {
        let json: unknown = null;
        try { json = data ? JSON.parse(data) : null; } catch { json = data; }
        resolveCall({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function reasonOf(json: unknown): string {
  return String((json as { reason?: unknown } | null)?.reason ?? '');
}

async function createUser(email: string, password: string): Promise<{ id: string; cookie: string }> {
  const created = await postTestAccount(dbApi, { email, name: email, password });
  assert.equal(created.status, 201);
  const id = (created.json as { user: { id: string } }).user.id;
  const login = await call('POST', '/api/auth/login', { body: { email, password } });
  const cookie = sessionCookie(login.res)!;
  assert.ok(cookie);
  return { id, cookie };
}

function missionToken(agent: string, ownerId: string): string {
  const missionId = randomUUID();
  dbApi.createMission(missionId, agent, 'work', undefined, ownerId);
  const raw = issueMissionApiToken(missionId);
  assert.ok(dbApi.getLiveApiToken(hashApiToken(raw)));
  return raw;
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const adminId = (setup.json as { user: { id: string } }).user.id;
const adminCookie = sessionCookie(setup.res)!;

// Holds skills:manage + agents:manage but NOT agents:privileged-config.
const bob = await createUser('bob@example.com', 'bob-secret');
grantTestPermissions(dbApi, bob.id, ['skills:manage', 'agents:manage', 'missions:read']);
// Same, plus the power-user path.
const carol = await createUser('carol@example.com', 'carol-secret');
grantTestPermissions(dbApi, carol.id, ['skills:manage', 'agents:manage', 'agents:privileged-config']);
// Holds neither.
const ada = await createUser('ada@example.com', 'ada-secret');
grantTestPermissions(dbApi, ada.id, ['missions:read']);

// Holds mcp:manage, bounded to http: no agents:privileged-config.
const dave = await createUser('dave@example.com', 'dave-secret');
grantTestPermissions(dbApi, dave.id, ['mcp:manage', 'agents:manage', 'missions:read']);
// Holds mcp:manage AND the power-user path.
const erin = await createUser('erin@example.com', 'erin-secret');
grantTestPermissions(dbApi, erin.id, ['mcp:manage', 'agents:manage', 'agents:privileged-config', 'missions:read']);

const adminToken = missionToken('admin.agent', adminId);
const daveToken = missionToken('dave.agent', dave.id);
const erinToken = missionToken('erin.agent', erin.id);
const adaToken = missionToken('ada.agent', ada.id);
const bobToken = missionToken('bob.agent', bob.id);

const SKILL = '# Skill\n\nDo the thing.\n';
const WITH_TOOLS = '---\nname: x\nallowed_tools:\n  - "Bash"\n---\n\n# x\n';
const WITH_DASHED_TOOLS = '---\nname: x\nallowed-tools: Bash\n---\n\n# x\n';
// Every shape a parser reads, each spelling: one left unwatched is a way round the guard.
const TOOL_SHAPES = [
  WITH_TOOLS,
  WITH_DASHED_TOOLS,
  '---\nname: x\nallowed-tools:\n  - "Bash"\n---\n\n# x\n',
  '---\nname: x\nallowed_tools: ["Bash"]\n---\n\n# x\n',
  '---\nname: x\nallowed-tools: ["Bash"]\n---\n\n# x\n',
  '---\nname: x\n----\nallowed_tools: ["Bash"]\n---\n\n# x\n',
  '---\n\n---\nallowed-tools: Bash\n---\n\n# x\n',
  '---\nname: x\nallowed-tools: [\n  "Bash"\n]\n---\n\n# x\n',
  '---\nname: x\nallowed_tools: [\n  Bash,\n]\n---\n\n# x\n',
  '---\nname: x\nallowed-tools: >\n  Bash\n---\n\n# x\n',
  '---\nname: x\nallowed-tools:\n  Bash\n---\n\n# x\n',
];

const OUTSIDE = join(SANDBOX, 'outside');
mkdirSync(OUTSIDE, { recursive: true });

test('anonymous is 401 on skill writes and MCP writes', async () => {
  assert.equal((await call('POST', '/api/skills', { body: { id: 'anon', content: SKILL } })).status, 401);
  assert.equal((await call('DELETE', '/api/skills/anon')).status, 401);
  assert.equal((await call('POST', '/api/mcp', {
    body: { id: 'anon', transport: { type: 'stdio', command: 'id' } },
  })).status, 401);
  assert.equal(existsSync(skillFile('anon')), false);
});

test('a holder of skills:manage writes and deletes a skill by id', async () => {
  const put = await call('POST', '/api/skills', { cookie: bob.cookie, body: { id: 'bob-skill', content: SKILL } });
  assert.equal(put.status, 200);
  assert.equal(readFileSync(skillFile('bob-skill'), 'utf8'), SKILL);
  const del = await call('DELETE', '/api/skills/bob-skill', { cookie: bob.cookie });
  assert.equal(del.status, 200);
  assert.equal(existsSync(skillFile('bob-skill')), false);
});

test('create_only creates a skill and never replaces one: 409, the stored file untouched', async () => {
  const first = await call('POST', '/api/skills', { cookie: bob.cookie, body: { id: 'once-only', content: SKILL, create_only: true } });
  assert.equal(first.status, 200);
  for (const auth of [{ cookie: bob.cookie }, { cookie: adminCookie }, { bearer: TOKEN }]) {
    const again = await call('POST', '/api/skills', { ...auth, body: { id: 'once-only', content: '# replaced\n', create_only: true } });
    assert.equal(again.status, 409, JSON.stringify(auth));
    assert.equal((again.json as { code?: unknown }).code, 'skill_exists');
    assert.match(String((again.json as { error?: unknown }).error), /already exists/);
  }
  assert.equal(readFileSync(skillFile('once-only'), 'utf8'), SKILL);
  // By path too (operator: a managed free path).
  const free = join(SANDBOX, 'home-free', '.claude', 'skills', 'once-free', 'SKILL.md');
  mkdirSync(dirname(free), { recursive: true });
  writeFileSync(free, SKILL);
  const byPath = await call('POST', '/api/skills', { cookie: adminCookie, body: { path: free, content: '# replaced\n', create_only: true } });
  assert.equal(byPath.status, 409);
  assert.equal(readFileSync(free, 'utf8'), SKILL);
  // Without the flag the write stays an upsert.
  const upsert = await call('POST', '/api/skills', { cookie: bob.cookie, body: { id: 'once-only', content: '# v2\n' } });
  assert.equal(upsert.status, 200);
  assert.equal(readFileSync(skillFile('once-only'), 'utf8'), '# v2\n');
  assert.equal((await call('POST', '/api/skills', { cookie: bob.cookie, body: { id: 'once-only', content: SKILL, create_only: 'yes' } })).status, 400);
});

test('a skill may not pre-authorise tools for a caller without agents:privileged-config', async () => {
  for (const content of TOOL_SHAPES) {
    const refused = await call('POST', '/api/skills', { cookie: bob.cookie, body: { id: 'tools-skill', content } });
    assert.equal(refused.status, 403);
    assert.match(reasonOf(refused.json), /agents:privileged-config/);
  }
  assert.equal(existsSync(skillFile('tools-skill')), false);

  // The power-user path and the operator keep it.
  assert.equal((await call('POST', '/api/skills', {
    cookie: carol.cookie, body: { id: 'tools-skill', content: WITH_TOOLS },
  })).status, 200);
  assert.equal((await call('POST', '/api/skills', {
    cookie: adminCookie, body: { id: 'tools-admin', content: WITH_TOOLS },
  })).status, 200);
});

test('a non-operator cannot write a skill file outside <skills>/<id>/SKILL.md', async () => {
  const symlinked = join(SKILLS_DIR, 'linked');
  mkdirSync(SKILLS_DIR, { recursive: true });
  // A junction needs no privilege on Windows, a plain directory symlink does.
  symlinkSync(OUTSIDE, symlinked, process.platform === 'win32' ? 'junction' : 'dir');
  const targets = [
    join(SANDBOX, 'proj', '.claude', 'skills', 'x', 'SKILL.md'),
    join(SANDBOX, 'proj', '.claude', 'commands', 'x.md'),
    join(SKILLS_DIR, 'free-name.sh'),
    join(SKILLS_DIR, 'SKILL.md'),
    join(SKILLS_DIR, 'a', 'b', 'SKILL.md'),
    join(SKILLS_DIR, 'a', '..', '..', 'pwn', 'SKILL.md'),
    join(symlinked, 'SKILL.md'),
    'relative/SKILL.md',
  ];
  for (const path of targets) {
    const refused = await call('POST', '/api/skills', { cookie: bob.cookie, body: { path, content: SKILL } });
    assert.equal(refused.status, 403, path);
    assert.match(reasonOf(refused.json), /Timon skills folder|is a link/, path);
  }
  assert.equal(existsSync(join(OUTSIDE, 'SKILL.md')), false);
  assert.equal(existsSync(join(SKILLS_DIR, 'SKILL.md')), false);
  assert.equal(existsSync(join(SANDBOX, 'proj')), false);
});

test('the skills folder cannot be wiped through <skills>/SKILL.md, for anyone', async () => {
  const keep = await call('POST', '/api/skills', { cookie: adminCookie, body: { id: 'keep-me', content: SKILL } });
  assert.equal(keep.status, 200);
  const rootFile = join(SKILLS_DIR, 'SKILL.md');
  // The operator may write there (a managed path) …
  assert.equal((await call('POST', '/api/skills', {
    cookie: adminCookie, body: { path: rootFile, content: SKILL },
  })).status, 200);
  // … but removing it must not take the folder with it.
  const del = await call('DELETE', `/api/skills/x?path=${encodeURIComponent(rootFile)}`, { cookie: adminCookie });
  assert.equal(del.status, 400);
  assert.equal(existsSync(skillFile('keep-me')), true);
  // Nor from a non-operator, who is refused before reaching it.
  const refused = await call('DELETE', `/api/skills/x?path=${encodeURIComponent(rootFile)}`, { cookie: bob.cookie });
  assert.equal(refused.status, 403);
});

test('an id carrying a dot segment or a separator is not joined to the skills folder', async () => {
  const victim = join(SANDBOX, '.claude', 'skills', 'victim', 'SKILL.md');
  mkdirSync(join(SANDBOX, '.claude', 'skills', 'victim'), { recursive: true });
  writeFileSync(victim, SKILL);
  for (const raw of ['/api/skills/%2E', '/api/skills/%2E%2E', '/api/skills/..%2F..%2F.claude%2Fskills%2Fvictim']) {
    for (const auth of [{ cookie: bob.cookie }, { cookie: adminCookie }]) {
      const res = await rawDelete(raw, auth);
      assert.equal(res.status, 400, `${raw} → ${JSON.stringify(res.json)}`);
      assert.match(String((res.json as { error?: unknown }).error), /invalid skill id/);
    }
  }
  assert.equal(existsSync(victim), true);
  assert.equal(existsSync(skillFile('keep-me')), true);
});

test('product skills are read-only for a non-operator, writable by the operator', async () => {
  for (const id of ['timon-task', 'timon-worktree', 'timon-delegate', 'timon-msg']) {
    const write = await call('POST', '/api/skills', { cookie: bob.cookie, body: { id, content: SKILL } });
    assert.equal(write.status, 403, id);
    assert.match(reasonOf(write.json), /product skill/);
    const del = await call('DELETE', `/api/skills/${id}`, { cookie: bob.cookie });
    assert.equal(del.status, 403, id);
    assert.equal(existsSync(skillFile(id)), false, `${id} was not created`);
  }
  assert.equal((await call('POST', '/api/skills', {
    cookie: adminCookie, body: { id: 'timon-task', content: SKILL },
  })).status, 200);
});

/* ── links planted under the skills folder ──────────────────────────────── */

// A file symlink needs a privilege on Windows; the dangling cases are the point.
const LINKS = { skip: process.platform === 'win32' ? 'file symlinks need a privilege on Windows' : false };

function link(target: string, at: string, type: 'file' | 'dir'): void {
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at, type);
}

test('a dangling SKILL.md link is refused by id and by path, its target is not created', LINKS, async () => {
  const target = join(OUTSIDE, 'dangling-file.md');
  link(target, join(SKILLS_DIR, 'dangling-file', 'SKILL.md'), 'file');
  for (const auth of [{ cookie: bob.cookie }, { bearer: adminToken }, { bearer: bobToken }]) {
    const byId = await call('POST', '/api/skills', { ...auth, body: { id: 'dangling-file', content: SKILL } });
    assert.equal(byId.status, 403);
    assert.match(reasonOf(byId.json), /is a link/);
    const byPath = await call('POST', '/api/skills', {
      ...auth, body: { path: skillFile('dangling-file'), content: SKILL },
    });
    assert.equal(byPath.status, 403);
    assert.equal((await call('DELETE', '/api/skills/dangling-file', auth)).status, 403);
  }
  assert.equal(existsSync(target), false);
});

test('a dangling folder link is refused, nothing is created behind it', LINKS, async () => {
  const target = join(OUTSIDE, 'dangling-dir');
  link(target, join(SKILLS_DIR, 'dangling-dir'), 'dir');
  for (const auth of [{ cookie: bob.cookie }, { bearer: adminToken }]) {
    const put = await call('POST', '/api/skills', { ...auth, body: { id: 'dangling-dir', content: SKILL } });
    assert.equal(put.status, 403);
    assert.match(reasonOf(put.json), /is a link/);
  }
  assert.equal(existsSync(target), false);
});

test('a link to a live outside file is not overwritten', LINKS, async () => {
  const target = join(OUTSIDE, 'live.md');
  writeFileSync(target, 'precious');
  link(target, join(SKILLS_DIR, 'live-link', 'SKILL.md'), 'file');
  for (const auth of [{ cookie: bob.cookie }, { bearer: adminToken }]) {
    const put = await call('POST', '/api/skills', { ...auth, body: { id: 'live-link', content: SKILL } });
    assert.equal(put.status, 403);
  }
  assert.equal(readFileSync(target, 'utf8'), 'precious');
});

test('a hard link to an outside file is not rewritten through the skill', async () => {
  const target = join(OUTSIDE, 'hard.md');
  writeFileSync(target, 'precious');
  mkdirSync(join(SKILLS_DIR, 'hard'), { recursive: true });
  linkSync(target, join(SKILLS_DIR, 'hard', 'SKILL.md'));
  for (const auth of [{ cookie: bob.cookie }, { bearer: adminToken }, { bearer: bobToken }]) {
    const byId = await call('POST', '/api/skills', { ...auth, body: { id: 'hard', content: SKILL } });
    assert.equal(byId.status, 403);
    assert.match(reasonOf(byId.json), /is a link/);
    const byPath = await call('POST', '/api/skills', {
      ...auth, body: { path: skillFile('hard'), content: SKILL },
    });
    assert.equal(byPath.status, 403);
  }
  assert.equal(readFileSync(target, 'utf8'), 'precious');
});

test('a link cannot make a delete reach a folder outside the skills folder', LINKS, async () => {
  const victimDir = join(SANDBOX, 'proj', '.claude', 'skills', 'victim');
  mkdirSync(victimDir, { recursive: true });
  writeFileSync(join(victimDir, 'SKILL.md'), 'victim');
  writeFileSync(join(victimDir, 'notes.md'), 'keep');
  const own = join(SKILLS_DIR, 'custom-own');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'SKILL.md'), SKILL);
  // The outside file is a link to a plain skill of ours: resolved, it IS `custom-own`.
  rmSync(join(victimDir, 'SKILL.md'));
  link(join(own, 'SKILL.md'), join(victimDir, 'SKILL.md'), 'file');
  const path = join(victimDir, 'SKILL.md');
  for (const auth of [{ cookie: bob.cookie }, { bearer: adminToken }, { bearer: bobToken }]) {
    const del = await call('DELETE', `/api/skills/x?path=${encodeURIComponent(path)}`, auth);
    assert.equal(del.status, 403);
    assert.match(reasonOf(del.json), /Timon skills folder/);
  }
  assert.deepEqual(readdirSync(victimDir).sort(), ['SKILL.md', 'notes.md']);
  assert.equal(readFileSync(join(victimDir, 'notes.md'), 'utf8'), 'keep');
  assert.equal(existsSync(skillFile('custom-own')), true);
});

test('a link cannot be used to reach, or to mask, a product skill', LINKS, async () => {
  assert.equal(existsSync(skillFile('timon-task')), true);
  // A plain-looking skill whose SKILL.md is the product skill's file.
  link(skillFile('timon-task'), join(SKILLS_DIR, 'masked', 'SKILL.md'), 'file');
  // A folder alias of the product skill.
  link(join(SKILLS_DIR, 'timon-task'), join(SKILLS_DIR, 'alias-task'), 'dir');
  for (const id of ['masked', 'alias-task']) {
    for (const auth of [{ cookie: bob.cookie }, { bearer: adminToken }]) {
      const del = await call('DELETE', `/api/skills/${id}`, auth);
      assert.equal(del.status, 403, id);
      const put = await call('POST', '/api/skills', { ...auth, body: { id, content: '# hijack\n' } });
      assert.equal(put.status, 403, id);
    }
  }
  assert.equal(readFileSync(skillFile('timon-task'), 'utf8'), SKILL);
});

test('a `..` that a link would turn into another folder is refused', LINKS, async () => {
  const deep = join(OUTSIDE, 'deep', 'nested');
  mkdirSync(deep, { recursive: true });
  link(deep, join(SKILLS_DIR, 'hop'), 'dir');
  // Lexically <skills>/hop-target/SKILL.md; for the file system it is OUTSIDE/deep/hop-target/SKILL.md.
  const path = `${join(SKILLS_DIR, 'hop')}${sep}..${sep}hop-target${sep}SKILL.md`;
  const hidden = join(OUTSIDE, 'deep', 'hop-target');
  mkdirSync(hidden, { recursive: true });
  writeFileSync(join(hidden, 'SKILL.md'), 'hidden');
  for (const auth of [{ cookie: bob.cookie }, { bearer: adminToken }]) {
    const put = await call('POST', '/api/skills', { ...auth, body: { path, content: SKILL } });
    assert.equal(put.status, 403);
    const del = await call('DELETE', `/api/skills/x?path=${encodeURIComponent(path)}`, auth);
    assert.equal(del.status, 403);
  }
  assert.equal(readFileSync(join(hidden, 'SKILL.md'), 'utf8'), 'hidden');
});

test('an id ending with a dot is not a skill id (a Windows alias of the folder before it)', async () => {
  for (const auth of [{ cookie: bob.cookie }, { bearer: adminToken }]) {
    const put = await call('POST', '/api/skills', { ...auth, body: { id: 'timon-task.', content: '# hijack\n' } });
    assert.equal(put.status, 403);
  }
});

/* ── mission tokens: cap ∩ launcher ─────────────────────────────────────── */

test('a mission launched by the superadmin writes and deletes a skill by id', async () => {
  const put = await call('POST', '/api/skills', { bearer: adminToken, body: { id: 'mission-skill', content: SKILL } });
  assert.equal(put.status, 200);
  assert.equal(readFileSync(skillFile('mission-skill'), 'utf8'), SKILL);
  const del = await call('DELETE', '/api/skills/mission-skill', { bearer: adminToken });
  assert.equal(del.status, 200);
  assert.equal(existsSync(skillFile('mission-skill')), false);
});

test('a mission launched by an account without skills:manage stays refused', async () => {
  const put = await call('POST', '/api/skills', { bearer: adaToken, body: { id: 'ada-skill', content: SKILL } });
  assert.equal(put.status, 403);
  assert.equal(existsSync(skillFile('ada-skill')), false);
  assert.equal((await call('DELETE', '/api/skills/keep-me', { bearer: adaToken })).status, 403);
  assert.equal(existsSync(skillFile('keep-me')), true);
});

test('a mission token is bounded like a non-operator, even when its launcher is the superadmin', async () => {
  // Free path: the cap token is never superadmin.
  const path = join(SANDBOX, 'proj', '.claude', 'commands', 'pwn.md');
  const outside = await call('POST', '/api/skills', { bearer: adminToken, body: { path, content: SKILL } });
  assert.equal(outside.status, 403);
  assert.match(reasonOf(outside.json), /Timon skills folder/);
  assert.equal(existsSync(path), false);

  // A product skill.
  const product = await call('POST', '/api/skills', { bearer: adminToken, body: { id: 'timon-task', content: '# hijack\n' } });
  assert.equal(product.status, 403);
  assert.match(reasonOf(product.json), /product skill/);
  assert.equal(readFileSync(skillFile('timon-task'), 'utf8'), SKILL);

  // The conversion skill of a browser recording: a mission that learns a flow writes its own
  // `browser-<slug>` skill, never the instructions every later conversion follows.
  const learn = await call('POST', '/api/skills', { bearer: adminToken, body: { id: 'learn-browser-recording', content: '# hijack\n' } });
  assert.equal(learn.status, 403);
  assert.match(reasonOf(learn.json), /product skill/);
  assert.equal(existsSync(skillFile('learn-browser-recording')), false);
  assert.equal((await call('DELETE', '/api/skills/learn-browser-recording', { bearer: adminToken })).status, 403);

  // The skill an agent follows to handle browser annotations (#468): a mission does not rewrite it
  // for every later reader of an annotation.
  const handle = await call('POST', '/api/skills', { bearer: adminToken, body: { id: 'handle-browser-annotations', content: '# hijack\n' } });
  assert.equal(handle.status, 403);
  assert.match(reasonOf(handle.json), /product skill/);
  assert.equal(existsSync(skillFile('handle-browser-annotations')), false);
  assert.equal((await call('DELETE', '/api/skills/handle-browser-annotations', { bearer: adminToken })).status, 403);

  // Traversal in the id of a delete.
  const victim = join(SANDBOX, '.claude', 'skills', 'victim', 'SKILL.md');
  const walked = await rawDelete('/api/skills/..%2F..%2F.claude%2Fskills%2Fvictim', { bearer: adminToken });
  assert.equal(walked.status, 400);
  assert.equal(existsSync(victim), true);

  // A skill that pre-authorises tools adds them to every agent it is attached to:
  // no mission writes one, not even a superadmin's, which carries agents:privileged-config.
  for (const [bearer, id] of [[adminToken, 'mission-tools'], [bobToken, 'bob-tools']] as const) {
    const tools = await call('POST', '/api/skills', { bearer, body: { id, content: WITH_TOOLS } });
    assert.equal(tools.status, 403, id);
    assert.match(reasonOf(tools.json), /whatever its account holds.*Skills page/);
    assert.equal(existsSync(skillFile(id)), false);
  }
  assert.equal((await call('POST', '/api/skills', {
    bearer: bobToken, body: { id: 'bob-plain', content: SKILL },
  })).status, 200);
});

/* ── the conversion mission of a browser recording ──────────────────────── */

const { bus } = await import('../../bus.js');
const { getBrowserRecording } = await import('../../browser-recordings.js');
type RecordingEvent = { kind: string; event?: string; recording?: { learnedSkillId?: string | null } | null; origin?: unknown };
const recordingEvents: RecordingEvent[] = [];
bus.on('event', (ev: RecordingEvent) => { if (ev.kind === 'browser_recording') recordingEvents.push(ev); });

/**
 * A recording being learned and its conversion mission, launched by the superadmin: the
 * strongest launcher, so that every refusal below comes from the conversion rules. The
 * metadata is written as the store keeps it; no step is needed to bound a write.
 */
function conversion(agent = 'admin.agent'): { token: string; recordingId: string; missionId: string } {
  const missionId = randomUUID();
  const recordingId = `br-${randomUUID()}`;
  const now = Date.now();
  dbApi.pluginKvSet('@timon/browser-embedded', `browser-recordings/${recordingId}`, JSON.stringify({
    id: recordingId, profileId: 'p1', ownerUserId: adminId, title: 'Flow', startUrl: 'https://example.com/',
    steps: 3, flagged: 0, truncated: false, stoppedReason: 'user', createdAt: now, updatedAt: now,
    status: 'learned', learnMissionId: missionId, stepsAvailable: true, externalRef: null,
  }));
  dbApi.createMission(missionId, agent, 'learn', { channel: 'chat', meta: { browser_recording_id: recordingId } }, adminId);
  return { token: issueMissionApiToken(missionId), recordingId, missionId };
}

test('a conversion mission cannot replace an existing skill, browser-* or not, create_only asked or not', async () => {
  assert.equal((await call('POST', '/api/skills', { cookie: adminCookie, body: { id: 'browser-existing', content: SKILL } })).status, 200);
  assert.equal((await call('POST', '/api/skills', { cookie: adminCookie, body: { id: 'user-habits', content: SKILL } })).status, 200);
  const { token, recordingId } = conversion();
  for (const create_only of [undefined, false, true]) {
    const replaced = await call('POST', '/api/skills', { bearer: token, body: { id: 'browser-existing', content: '# hijack\n', create_only } });
    assert.equal(replaced.status, 409, String(create_only));
    assert.equal((replaced.json as { code?: unknown }).code, 'skill_exists');
  }
  assert.equal(readFileSync(skillFile('browser-existing'), 'utf8'), SKILL);
  const other = await call('POST', '/api/skills', { bearer: token, body: { id: 'user-habits', content: '# hijack\n' } });
  assert.equal(other.status, 403);
  assert.equal(readFileSync(skillFile('user-habits'), 'utf8'), SKILL);
  // A refused write keeps the conversion's one skill to come.
  assert.equal(getBrowserRecording(recordingId)?.learnedSkillId, null);
});

test('a conversion mission writes nothing outside a new browser-<slug> skill by id', async () => {
  const { token, recordingId } = conversion();
  const targets: Array<Record<string, unknown>> = [
    { id: 'my-flow' },
    { id: 'browser-' },
    { id: 'timon-task' },
    { path: skillFile('browser-by-path') },
    { path: join(SANDBOX, 'proj', '.claude', 'skills', 'browser-x', 'SKILL.md') },
  ];
  for (const target of targets) {
    const refused = await call('POST', '/api/skills', { bearer: token, body: { ...target, content: SKILL } });
    assert.equal(refused.status, 403, JSON.stringify(target));
    assert.match(reasonOf(refused.json), /browser-<slug>|product skill/, JSON.stringify(target));
  }
  assert.equal(existsSync(skillFile('my-flow')), false);
  assert.equal(existsSync(skillFile('browser-by-path')), false);
  assert.equal(readFileSync(skillFile('timon-task'), 'utf8'), SKILL);
  assert.equal(getBrowserRecording(recordingId)?.learnedSkillId, null);
});

test('a conversion mission creates one skill, kept on the recording and carried by a learned event', async () => {
  const { token, recordingId } = conversion();
  recordingEvents.length = 0;
  const created = await call('POST', '/api/skills', { bearer: token, body: { id: 'browser-pay-invoice', content: SKILL } });
  assert.equal(created.status, 200);
  assert.equal(readFileSync(skillFile('browser-pay-invoice'), 'utf8'), SKILL);
  assert.equal(getBrowserRecording(recordingId)?.learnedSkillId, 'browser-pay-invoice');
  const learned = recordingEvents.filter((ev) => ev.event === 'learned');
  assert.equal(learned.length, 1);
  assert.equal(learned[0]!.recording?.learnedSkillId, 'browser-pay-invoice');
  assert.deepEqual(learned[0]!.origin, { kind: 'agent', id: 'admin.agent' });

  // A second skill, a rewrite of its own: refused, nothing written.
  const second = await call('POST', '/api/skills', { bearer: token, body: { id: 'browser-pay-invoice-2', content: SKILL } });
  assert.equal(second.status, 403);
  assert.match(reasonOf(second.json), /already created browser-pay-invoice/);
  assert.equal(existsSync(skillFile('browser-pay-invoice-2')), false);
  const rewrite = await call('POST', '/api/skills', { bearer: token, body: { id: 'browser-pay-invoice', content: '# v2\n' } });
  assert.equal(rewrite.status, 403);
  assert.equal(readFileSync(skillFile('browser-pay-invoice'), 'utf8'), SKILL);
  assert.equal(getBrowserRecording(recordingId)?.learnedSkillId, 'browser-pay-invoice');
});

test('a conversion mission removes no skill, not even the one it created', async () => {
  const { token } = conversion();
  assert.equal((await call('POST', '/api/skills', { bearer: token, body: { id: 'browser-to-keep', content: SKILL } })).status, 200);
  for (const id of ['browser-to-keep', 'keep-me', 'user-habits']) {
    const refused = await call('DELETE', `/api/skills/${id}`, { bearer: token });
    assert.equal(refused.status, 403, id);
    // Refused at the entry since #467 (DELETE is not on its list); the skills guard refuses it too.
    assert.match(reasonOf(refused.json), /converts a browser recording and may only/, id);
    assert.equal(existsSync(skillFile(id)), true, id);
  }
});

test('a conversion mission whose recording was deleted writes no skill', async () => {
  const { token, recordingId } = conversion();
  dbApi.pluginKvDelete('@timon/browser-embedded', `browser-recordings/${recordingId}`);
  const refused = await call('POST', '/api/skills', { bearer: token, body: { id: 'browser-orphan', content: SKILL } });
  assert.equal(refused.status, 403);
  assert.match(reasonOf(refused.json), /was deleted/);
  assert.equal(existsSync(skillFile('browser-orphan')), false);
});

test('an ordinary mission keeps its behaviour: it replaces and removes a browser-* skill', async () => {
  conversion(); // another mission's conversion does not bound this one
  assert.equal((await call('POST', '/api/skills', { bearer: adminToken, body: { id: 'browser-ordinary', content: SKILL } })).status, 200);
  assert.equal((await call('POST', '/api/skills', { bearer: adminToken, body: { id: 'browser-ordinary', content: '# v2\n' } })).status, 200);
  assert.equal(readFileSync(skillFile('browser-ordinary'), 'utf8'), '# v2\n');
  assert.equal((await call('POST', '/api/skills', { bearer: adminToken, body: { id: 'ordinary-two', content: SKILL } })).status, 200);
  assert.equal((await call('DELETE', '/api/skills/browser-ordinary', { bearer: adminToken })).status, 200);
  assert.equal(existsSync(skillFile('browser-ordinary')), false);
});

const HTTP = (url: string, extra: Record<string, unknown> = {}) => ({ type: 'http', url, ...extra });
const STDIO = { type: 'stdio', command: 'id' };

function storedMcp(id: string): Record<string, unknown> | null {
  const file = join(MCP_DIR, `${id}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : null;
}

function auditTargets(action: string): string[] {
  return dbApi.listAuditLog(1000).filter((row) => row.action === action).map((row) => String(row.target));
}

test('a mission without mcp:manage is refused, with a reason that names the account', async () => {
  const ada403 = await call('POST', '/api/mcp', { bearer: adaToken, body: { id: 'ada-mcp', transport: HTTP('https://mcp.example.com/x') } });
  assert.equal(ada403.status, 403);
  assert.match(reasonOf(ada403.json), /mcp:manage/);
  assert.equal(storedMcp('ada-mcp'), null);
  const del = await call('DELETE', '/api/mcp/ada-mcp', { bearer: adaToken });
  assert.equal(del.status, 403);
  assert.match(reasonOf(del.json), /mcp:manage/);
  // A mission never starts an OAuth sign-in, whatever it holds.
  for (const token of [adminToken, erinToken]) {
    const oauth = await call('POST', '/api/mcp/whatever/oauth/start', { bearer: token });
    assert.equal(oauth.status, 403);
    assert.match(reasonOf(oauth.json), /OAuth/);
  }
});

test('a mission whose launcher is the superadmin declares an http server, and it is logged', async () => {
  const put = await call('POST', '/api/mcp', {
    bearer: adminToken,
    body: { id: 'admin-http', name: 'Admin http', transport: HTTP('https://mcp.example.com/mcp?k=v', { headers: { authorization: 'Bearer real-token' } }) },
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.deepEqual((storedMcp('admin-http') as { created_by: { agent: string } }).created_by.agent, 'admin.agent');
  const logged = auditTargets('mcp.write').find((target) => target.startsWith('mcp:admin-http'));
  assert.ok(logged, 'the write is in the audit log');
  assert.match(logged!, /mission [0-9a-f-]{36} agent admin\.agent/);
  assert.match(logged!, /mcp\.example\.com/);
  assert.doesNotMatch(logged!, /real-token|k=v/, 'no secret, no query string in the audit line');
});

test('a mission token reads a server masked, mcp:manage held or not; a human holder reads it clear', async () => {
  for (const token of [adminToken, daveToken]) {
    const got = await call('GET', '/api/mcp/admin-http', { bearer: token });
    assert.equal(got.status, 200);
    assert.deepEqual((got.json as { transport: { headers: unknown } }).transport.headers, { authorization: '***' });
  }
  const human = await call('GET', '/api/mcp/admin-http', { cookie: adminCookie });
  assert.deepEqual((human.json as { transport: { headers: unknown } }).transport.headers, { authorization: 'Bearer real-token' });
});

test('a masked round trip keeps the stored secret while the server points at the same place', async () => {
  // The agent reads the server, changes the description, writes it back as it read it.
  const read = (await call('GET', '/api/mcp/admin-http', { bearer: adminToken })).json as {
    transport: Record<string, unknown>;
  };
  const same = await call('POST', '/api/mcp', {
    bearer: adminToken,
    body: { id: 'admin-http', description: 'edited', transport: { ...read.transport, oauth: { tokens: { access_token: 'forged' } } } },
  });
  assert.equal(same.status, 200, JSON.stringify(same.json));
  // The response of the write is masked too: the restored secret is not read back from it.
  assert.deepEqual((same.json as { transport: { headers: unknown } }).transport.headers, { authorization: '***' });
  const stored = storedMcp('admin-http') as { description: string; transport: { headers: Record<string, string>; oauth?: unknown } };
  assert.equal(stored.description, 'edited');
  assert.deepEqual(stored.transport.headers, { authorization: 'Bearer real-token' });
  assert.equal(stored.transport.oauth, undefined, 'a mission never writes oauth state');

  // Same mask, another destination: the credential must not follow it.
  const moved = await call('POST', '/api/mcp', {
    bearer: adminToken,
    body: { id: 'admin-http', transport: HTTP('https://attacker.example.net/mcp', { headers: { authorization: '***' } }) },
  });
  assert.equal(moved.status, 403);
  assert.match(reasonOf(moved.json), /masked/);
  assert.deepEqual((storedMcp('admin-http') as { transport: { url: string } }).transport.url, 'https://mcp.example.com/mcp?k=v');
  // A mask with nothing stored behind it is not written as a literal either.
  const orphan = await call('POST', '/api/mcp', {
    bearer: adminToken,
    body: { id: 'admin-http', transport: HTTP('https://mcp.example.com/mcp?k=v', { headers: { 'x-new': '***' } }) },
  });
  assert.equal(orphan.status, 403);
  // Re-typing the value is how a secret is changed.
  const retyped = await call('POST', '/api/mcp', {
    bearer: adminToken,
    body: { id: 'admin-http', transport: HTTP('https://attacker.example.net/mcp', { headers: { authorization: 'Bearer typed' } }) },
  });
  assert.equal(retyped.status, 200);
});

test('without agents:privileged-config a mission declares http only, to a url off this host', async () => {
  const stdio = await call('POST', '/api/mcp', { bearer: daveToken, body: { id: 'dave-stdio', transport: STDIO } });
  assert.equal(stdio.status, 403);
  assert.match(reasonOf(stdio.json), /command on the host.*MCP servers page/);
  assert.equal(storedMcp('dave-stdio'), null);

  for (const url of [
    'file:///etc/passwd', 'ftp://example.com/x', 'not a url', 'http://localhost:3001/api', 'http://app.localhost/',
    'http://127.0.0.1:3001/', 'http://127.1/', 'http://2130706433/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data', 'http://[fe80::1]/', 'http://0.0.0.0/', 'http://LOCALHOST./',
  ]) {
    const refused = await call('POST', '/api/mcp', { bearer: daveToken, body: { id: 'dave-bad', transport: HTTP(url) } });
    assert.equal(refused.status, 403, url);
    assert.ok(reasonOf(refused.json), url);
  }
  assert.equal(storedMcp('dave-bad'), null);

  const ok = await call('POST', '/api/mcp', { bearer: daveToken, body: { id: 'dave-http', transport: HTTP('https://mcp.example.com/dave') } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  // Its own server, the same agent: an idempotent re-put and a removal go through.
  const again = await call('POST', '/api/mcp', { bearer: daveToken, body: { id: 'dave-http', transport: HTTP('https://mcp.example.com/dave2') } });
  assert.equal(again.status, 200);
  // Turning it into a command is the same refusal as declaring one.
  const toStdio = await call('POST', '/api/mcp', { bearer: daveToken, body: { id: 'dave-http', transport: STDIO } });
  assert.equal(toStdio.status, 403);
  assert.equal((await call('DELETE', '/api/mcp/dave-http', { bearer: daveToken })).status, 200);
  assert.equal(storedMcp('dave-http'), null);
  assert.ok(auditTargets('mcp.delete').some((target) => target.startsWith('mcp:dave-http') && /agent dave\.agent/.test(target)));
});

test('the host of a url is judged on what it resolves to, not on how it is spelled (TODO #530)', async () => {
  for (const host of [
    'loop.example.net', 'lan.example.net', 'ten.example.net', 'tailnet.example.net', 'meta.example.net',
    'ula.example.net', 'mapped.example.net', 'mixed.example.net', 'self.example.net', 'nxdomain.example.net',
  ]) {
    const refused = await call('POST', '/api/mcp', { bearer: daveToken, body: { id: 'dave-dns', transport: HTTP(`https://${host}/mcp`) } });
    assert.equal(refused.status, 403, host);
    assert.match(reasonOf(refused.json), new RegExp(`${host.replace(/\./g, '\\.')}.*agents:privileged-config`), host);
  }
  // An address literal of the LAN, or one of this host's own public addresses, is refused as well.
  for (const url of ['http://192.168.1.20:8080/mcp', 'http://[fd12:3456::1]/', `https://${OWN_PUBLIC_ADDRESS}/mcp`]) {
    const refused = await call('POST', '/api/mcp', { bearer: daveToken, body: { id: 'dave-dns', transport: HTTP(url) } });
    assert.equal(refused.status, 403, url);
  }
  assert.equal(storedMcp('dave-dns'), null);

  // A name that resolves public passes, and is marked to be judged again at launch.
  const ok = await call('POST', '/api/mcp', { bearer: daveToken, body: { id: 'dave-rebind', transport: HTTP('https://rebind.example.net/mcp') } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(storedMcp('dave-rebind')!.public_only, true);
  // The CLI never sees the name it would resolve again: it is handed the pinned loopback proxy (TODO #577).
  const [launched] = await resolveLaunchServers(['dave-rebind']);
  assert.ok(launched?.type === 'http');
  assert.match(launched.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.ok(launched.headers[MCP_PROXY_HEADER]);
  // The attacker moves the record after the write: the launch leaves the server out.
  DNS['rebind.example.net'] = ['127.0.0.1'];
  try {
    assert.deepEqual(await resolveLaunchServers(['dave-rebind']), []);
  } finally {
    DNS['rebind.example.net'] = ['93.184.215.14'];
  }
  assert.equal((await resolveLaunchServers(['dave-rebind'])).length, 1);

  // The operator's own server is not second-guessed: a human writes it, the mark is cleared.
  const human = await call('POST', '/api/mcp', { cookie: adminCookie, body: { id: 'dave-rebind', transport: HTTP('https://loop.example.net/mcp') } });
  assert.equal(human.status, 200);
  assert.equal(storedMcp('dave-rebind')!.public_only, undefined);
  assert.deepEqual((await resolveLaunchServers(['dave-rebind'])).map((s) => s.type === 'http' && s.url), ['https://loop.example.net/mcp']);
  assert.equal((await call('DELETE', '/api/mcp/dave-rebind', { cookie: adminCookie })).status, 200);
});

test('what a human declared, or another agent, is not rewritten by a mission without privileged-config', async () => {
  const human = await call('POST', '/api/mcp', { cookie: adminCookie, body: { id: 'human-http', transport: HTTP('https://mcp.example.com/h') } });
  assert.equal(human.status, 200);
  const humanStdio = await call('POST', '/api/mcp', { cookie: adminCookie, body: { id: 'human-stdio', transport: STDIO } });
  assert.equal(humanStdio.status, 200);
  for (const id of ['human-http', 'human-stdio', 'admin-http']) {
    const overwrite = await call('POST', '/api/mcp', { bearer: daveToken, body: { id, transport: HTTP('https://attacker.example.net/') } });
    assert.equal(overwrite.status, 403, id);
    assert.match(reasonOf(overwrite.json), /privileged-config/);
    assert.equal((await call('DELETE', `/api/mcp/${id}`, { bearer: daveToken })).status, 403, id);
  }
  assert.deepEqual((storedMcp('human-http') as { transport: { url: string } }).transport.url, 'https://mcp.example.com/h');
  assert.ok(storedMcp('human-stdio'));
  assert.equal(storedMcp('human-http')!.created_by, undefined);
});

test('even with agents:privileged-config a mission declares no stdio server, and rewrites none', async () => {
  // The maintainer's decision of 08/11/2026: a command on the host is a person's to declare.
  const stdio = await call('POST', '/api/mcp', {
    bearer: erinToken, body: { id: 'erin-stdio', transport: { ...STDIO, args: ['-u'], env: { TOKEN: 'abc' } } },
  });
  assert.equal(stdio.status, 403, JSON.stringify(stdio.json));
  assert.match(reasonOf(stdio.json), /whatever its account holds.*MCP servers page/);
  assert.equal(storedMcp('erin-stdio'), null);
  // A human-declared stdio server is not rewritten either; removing it grants nothing.
  const rewrite = await call('POST', '/api/mcp', { bearer: erinToken, body: { id: 'human-stdio', transport: { ...STDIO, command: 'sh' } } });
  assert.equal(rewrite.status, 403);
  assert.equal((storedMcp('human-stdio') as { transport: { command: string } }).transport.command, STDIO.command);
  assert.equal((await call('DELETE', '/api/mcp/human-stdio', { bearer: erinToken })).status, 200);
  // The loopback test is for callers who cannot already run a command.
  assert.equal((await call('POST', '/api/mcp', { bearer: erinToken, body: { id: 'erin-local', transport: HTTP('http://127.0.0.1:8123/mcp') } })).status, 200);
  assert.equal(storedMcp('erin-local')!.public_only, false, 'a holder of privileged-config is not judged again at launch');
  // Its write says so explicitly: the boot does not mistake it for a server declared before the rule.
  assert.deepEqual(holdLegacyMissionServersToPublic(), []);
  assert.equal(storedMcp('erin-local')!.public_only, false);
  assert.equal((await resolveLaunchServers(['erin-local']))[0]?.url, 'http://127.0.0.1:8123/mcp');
  assert.equal((await call('DELETE', '/api/mcp/erin-local', { bearer: erinToken })).status, 200);
  // Writing a server stamps no right on the one a human made: it stays unstamped.
  assert.equal(storedMcp('human-http')!.created_by, undefined);
  assert.equal((await call('POST', '/api/mcp', { bearer: erinToken, body: { id: 'human-http', transport: HTTP('https://mcp.example.com/h2') } })).status, 200);
  assert.equal(storedMcp('human-http')!.created_by, undefined);
});

test('an http server a mission declared before the rule is held to public addresses at boot (TODO #577)', async () => {
  mkdirSync(MCP_DIR, { recursive: true });
  const legacy = (id: string, url: string, extra: Record<string, unknown> = {}) => writeFileSync(join(MCP_DIR, `${id}.json`), JSON.stringify({
    id, name: id, transport: HTTP(url), source: 'timon', created_by: { mission_id: 'm-old', agent: 'dave.agent' }, ...extra,
  }));
  // Written by a mission before #530: no mark, so nothing judged it again at launch.
  legacy('old-inward', 'https://loop.example.net/mcp');
  legacy('old-public', 'https://rebind.example.net/mcp');
  legacy('old-stdio', '', { transport: STDIO });
  legacy('old-privileged', 'http://127.0.0.1:8124/mcp', { public_only: false });
  writeFileSync(join(MCP_DIR, 'old-human.json'), JSON.stringify({ id: 'old-human', transport: HTTP('http://127.0.0.1:8125/mcp'), source: 'timon' }));
  try {
    assert.equal((await resolveLaunchServers(['old-inward'])).length, 1, 'before the boot, the legacy server reaches the CLI');
    assert.deepEqual(holdLegacyMissionServersToPublic().sort(), ['old-inward', 'old-public']);
    assert.equal(storedMcp('old-inward')!.public_only, true);
    assert.equal(storedMcp('old-public')!.public_only, true);
    assert.equal(storedMcp('old-stdio')!.public_only, undefined);
    assert.equal(storedMcp('old-privileged')!.public_only, false);
    assert.equal(storedMcp('old-human')!.public_only, undefined);
    // The one that points at this host is left out of every launch; the public one still goes.
    assert.deepEqual(await resolveLaunchServers(['old-inward']), []);
    const [held] = await resolveLaunchServers(['old-public']);
    assert.ok(held?.type === 'http' && held.url.startsWith('http://127.0.0.1:') && held.headers[MCP_PROXY_HEADER], 'held servers go through the pinned proxy');
    assert.deepEqual((await resolveLaunchServers(['old-privileged', 'old-human'])).map((s) => s.type === 'http' && s.url), [
      'http://127.0.0.1:8124/mcp', 'http://127.0.0.1:8125/mcp',
    ]);
    // Idempotent: a second boot touches nothing.
    assert.deepEqual(holdLegacyMissionServersToPublic(), []);
    // A human saving it from the MCP page lifts the mark.
    const human = await call('POST', '/api/mcp', { cookie: adminCookie, body: { id: 'old-inward', transport: HTTP('https://loop.example.net/mcp') } });
    assert.equal(human.status, 200);
    assert.equal(storedMcp('old-inward')!.public_only, undefined);
    assert.equal((await resolveLaunchServers(['old-inward'])).length, 1);
  } finally {
    for (const id of ['old-inward', 'old-public', 'old-stdio', 'old-privileged', 'old-human']) rmSync(join(MCP_DIR, `${id}.json`), { force: true });
  }
});

test('the servers Timon injects and the account connectors are out of reach of every mission', async () => {
  mkdirSync(MCP_DIR, { recursive: true });
  writeFileSync(
    join(MCP_DIR, 'ext-claude-connector.json'),
    JSON.stringify({ id: 'ext-claude-connector', transport: { type: 'external', claude_key: 'claude.ai Connector' }, source: 'claude_ai' }),
  );
  for (const token of [adminToken, daveToken, erinToken]) {
    for (const body of [
      { id: 'timon', transport: HTTP('https://mcp.example.com/x') },
      { id: 'timon-browser', transport: HTTP('https://mcp.example.com/x') },
      { id: 'grepai', transport: HTTP('https://mcp.example.com/x') },
      { id: 'innocent', name: 'timon', transport: HTTP('https://mcp.example.com/x') },
      { id: 'ext-timon', transport: HTTP('https://mcp.example.com/x') },
      { id: 'ext-claude-connector', transport: HTTP('https://mcp.example.com/x') },
      { id: 'ext-new', transport: HTTP('https://mcp.example.com/x') },
    ]) {
      const refused = await call('POST', '/api/mcp', { bearer: token, body });
      assert.equal(refused.status, 403, `${body.id}/${'name' in body ? body.name : ''}`);
      assert.ok(reasonOf(refused.json));
    }
    const del = await call('DELETE', '/api/mcp/ext-claude-connector', { bearer: token });
    assert.equal(del.status, 403);
  }
  assert.ok(storedMcp('ext-claude-connector'), 'the connector stub is still there');
  assert.equal(storedMcp('innocent'), null);
  // The operator, in a session, still manages them as before.
  assert.equal((await call('DELETE', '/api/mcp/ext-claude-connector', { cookie: adminCookie })).status, 200);
});
