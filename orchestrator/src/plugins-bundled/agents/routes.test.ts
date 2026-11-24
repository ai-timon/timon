/**
 * secu-1 — mutating /api/agents*, /api/mcp*, /api/skills* and spawn
 * require the matching permission. Ephemeral no longer trusts
 * `X-TIMON-Agent`. Isolated TIMON_HOME, witness on 127.0.0.1:0.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-agents-secu1-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('./routes.js');
const { registerRoutes: registerMissionRoutes } = await import('../missions/routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { SETUP_ROLE_PRESETS } = await import('../../../tests/helpers/presets.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerAgentRoutes(app);
registerMissionRoutes(app);

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

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: unknown; res: Response }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
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

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const adminCookie = sessionCookie(setup.res)!;
assert.ok(adminCookie);

const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
assert.equal(created.status, 201);
const adaId = (created.json as { user: { id: string } }).user.id;
const employeePreset = SETUP_ROLE_PRESETS.find((p) => p.key === 'employee');
assert.ok(employeePreset);
grantTestPermissions(dbApi, adaId, [...employeePreset.permissions]);
const adaLogin = await call('POST', '/api/auth/login', {
  body: { email: 'ada@example.com', password: 'ada-secret' },
});
const adaCookie = sessionCookie(adaLogin.res)!;
assert.ok(adaCookie);

const eveCreated = await postTestAccount(dbApi, { email: 'eve@example.com', name: 'Eve', password: 'eve-secret' });
assert.equal(eveCreated.status, 201);
const eveLogin = await call('POST', '/api/auth/login', {
  body: { email: 'eve@example.com', password: 'eve-secret' },
});
const eveCookie = sessionCookie(eveLogin.res)!;
assert.ok(eveCookie);

test('employee is 403 on POST/PATCH/DELETE /api/agents*', async () => {
  const create = await call('POST', '/api/agents', {
    cookie: adaCookie,
    body: { name: 'x.pwn', system_prompt: 'pwn', config: { cwd: tmpdir() } },
  });
  assert.equal(create.status, 403);

  const patch = await call('PATCH', '/api/agents/nope/config', {
    cookie: adaCookie,
    body: { cwd: tmpdir() },
  });
  assert.equal(patch.status, 403);

  const del = await call('DELETE', '/api/agents/nope', { cookie: adaCookie });
  assert.equal(del.status, 403);

  const rename = await call('POST', '/api/agents/nope/rename', {
    cookie: adaCookie,
    body: { newName: 'other' },
  });
  assert.equal(rename.status, 403);

  const files = await call('POST', '/api/agents/nope/files?path=x', { cookie: adaCookie });
  assert.equal(files.status, 403);

  const rmFile = await call('DELETE', '/api/agents/nope/files?path=x', { cookie: adaCookie });
  assert.equal(rmFile.status, 403);

  const list = await call('GET', '/api/agents', { cookie: adaCookie });
  assert.equal(list.status, 200);
});

test('employee is 403 on POST/DELETE /api/mcp*', async () => {
  const create = await call('POST', '/api/mcp', {
    cookie: adaCookie,
    body: { id: 'pwn', transport: { type: 'stdio', command: 'id' } },
  });
  assert.equal(create.status, 403);

  const oauth = await call('POST', '/api/mcp/pwn/oauth/start', { cookie: adaCookie });
  assert.equal(oauth.status, 403);

  const del = await call('DELETE', '/api/mcp/pwn', { cookie: adaCookie });
  assert.equal(del.status, 403);

  const list = await call('GET', '/api/mcp', { cookie: adaCookie });
  assert.equal(list.status, 200);
});

test('GET /api/mcp/:id masks transport secrets for non-managers', async () => {
  // stdio: the env holds a token; http: the headers hold an Authorization value.
  const stdio = await call('POST', '/api/mcp', {
    cookie: adminCookie,
    body: { id: 'mask-stdio', transport: { type: 'stdio', command: 'id', env: { SECRET: 'stdio-secret' } } },
  });
  assert.equal(stdio.status, 200, JSON.stringify(stdio.json));
  const http = await call('POST', '/api/mcp', {
    cookie: adminCookie,
    body: { id: 'mask-http', transport: { type: 'http', url: 'https://example.com/mcp', headers: { authorization: 'Bearer http-secret' } } },
  });
  assert.equal(http.status, 200, JSON.stringify(http.json));

  // A non-manager reads the shape — keys kept, values scrubbed.
  const stdioAsAda = await call('GET', '/api/mcp/mask-stdio', { cookie: adaCookie });
  assert.equal(stdioAsAda.status, 200);
  assert.deepEqual((stdioAsAda.json as { transport: { env: Record<string, string> } }).transport.env, { SECRET: '***' });

  const httpAsAda = await call('GET', '/api/mcp/mask-http', { cookie: adaCookie });
  assert.equal(httpAsAda.status, 200);
  assert.deepEqual((httpAsAda.json as { transport: { headers: Record<string, string> } }).transport.headers, { authorization: '***' });

  // The superadmin reads the env back; a header's value is in the vault, which nothing reads back.
  const stdioAsAdmin = await call('GET', '/api/mcp/mask-stdio', { cookie: adminCookie });
  assert.equal(stdioAsAdmin.status, 200);
  assert.deepEqual((stdioAsAdmin.json as { transport: { env: Record<string, string> } }).transport.env, { SECRET: 'stdio-secret' });

  const httpAsAdmin = await call('GET', '/api/mcp/mask-http', { cookie: adminCookie });
  assert.equal(httpAsAdmin.status, 200);
  assert.deepEqual((httpAsAdmin.json as { transport: { headers: Record<string, string> } }).transport.headers, { authorization: '***' });
  assert.ok(!JSON.stringify(httpAsAdmin.json).includes('header_secrets'), 'which vault secret holds it is not said');
  assert.ok(!JSON.stringify(http.json).includes('http-secret'), 'nor is it in the response of the write');
});

test('employee is 403 on POST/DELETE /api/skills*', async () => {
  const create = await call('POST', '/api/skills', {
    cookie: adaCookie,
    body: { id: 'pwn', content: '# pwn\n' },
  });
  assert.equal(create.status, 403);

  const del = await call('DELETE', '/api/skills/pwn', { cookie: adaCookie });
  assert.equal(del.status, 403);

  const list = await call('GET', '/api/skills', { cookie: adaCookie });
  assert.equal(list.status, 200);
});

test('spawn without missions:spawn is 403; employee still reaches the handler', async () => {
  const eveSpawn = await call('POST', '/api/missions', {
    cookie: eveCookie,
    body: { agent: 'nope', mission: 'ping' },
  });
  assert.equal(eveSpawn.status, 403);

  const eveAgentsSpawn = await call('POST', '/api/agents/spawn', {
    cookie: eveCookie,
    body: { agent: 'nope', mission: 'ping' },
  });
  assert.equal(eveAgentsSpawn.status, 403);

  // Employee has missions:spawn — empty body is 400 (validation), not 403.
  const adaSpawn = await call('POST', '/api/missions', {
    cookie: adaCookie,
    body: {},
  });
  assert.equal(adaSpawn.status, 400);
});

test('ephemeral rejects a spoofed X-TIMON-Agent header', async () => {
  const asEmployee = await call('POST', '/api/agents/ephemeral', {
    cookie: adaCookie,
    headers: { 'X-TIMON-Agent': '_main' },
    body: { mission: 'ping', system_prompt: 'pwn' },
  });
  assert.equal(asEmployee.status, 403);

  const asAdminSession = await call('POST', '/api/agents/ephemeral', {
    cookie: adminCookie,
    headers: { 'X-TIMON-Agent': '_main' },
    body: { mission: 'ping', system_prompt: 'pwn' },
  });
  assert.equal(asAdminSession.status, 403);

  // Header alone, no identity: the auth middleware 401s once users exist.
  const headerOnly = await call('POST', '/api/agents/ephemeral', {
    headers: { 'X-TIMON-Agent': '_main' },
    body: { mission: 'ping', system_prompt: 'pwn' },
  });
  assert.ok(headerOnly.status === 401 || headerOnly.status === 403);

  // Daemon-token is the operator identity: the header is irrelevant, and
  // an empty body is a 400 (validation) not a 403 (identity).
  const asDaemon = await call('POST', '/api/agents/ephemeral', {
    bearer: TOKEN,
    body: {},
  });
  assert.equal(asDaemon.status, 400);
});

test('the Files editor can save: PUT /api/agents/:name/files writes the text body (bug #62)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'timon-files-put-'));
  const created = await call('POST', '/api/agents', {
    cookie: adminCookie,
    body: { name: 'files.agent', system_prompt: '# files', config: { cwd } },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));

  // The app's proxy forwards the editor's draft as text/plain, not JSON.
  const saved = await fetch(`${base}/api/agents/files.agent/files?path=notes/hello.md`, {
    method: 'PUT',
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(adminCookie)}`,
    },
    body: '# hello\n',
  });
  assert.equal(saved.status, 200, await saved.text());
  assert.equal(readFileSync(join(cwd, 'notes', 'hello.md'), 'utf8'), '# hello\n');

  // Same write from an employee: refused, and the file untouched.
  const denied = await fetch(`${base}/api/agents/files.agent/files?path=notes/hello.md`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain', cookie: `${SESSION_COOKIE}=${encodeURIComponent(adaCookie)}` },
    body: 'pwned',
  });
  assert.equal(denied.status, 403);
  assert.equal(readFileSync(join(cwd, 'notes', 'hello.md'), 'utf8'), '# hello\n');
});

/** A minimal valid zip of empty stored entries: enough to carry the part names
 *  the daemon looks for in an OOXML container, and a real central directory. */
function zipOf(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

test('the Files viewer serves raw bytes by magic bytes, inside the agent cwd only', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'timon-files-raw-'));
  const outside = mkdtempSync(join(tmpdir(), 'timon-files-raw-outside-'));
  writeFileSync(join(outside, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  writeFileSync(join(cwd, 'pic.png'), png);
  writeFileSync(join(cwd, 'doc.pdf'), '%PDF-1.4\n%fake\n');
  const docxBytes = zipOf(['[Content_Types].xml', 'word/document.xml']);
  writeFileSync(join(cwd, 'letter.docx'), docxBytes);
  writeFileSync(join(cwd, 'letter-renamed.txt'), docxBytes);
  writeFileSync(join(cwd, 'generic.docx'), zipOf(['notes.txt', 'data/a.bin']));
  writeFileSync(join(cwd, 'letter-as.xlsx'), docxBytes);
  writeFileSync(join(cwd, 'cut.docx'), docxBytes.subarray(0, docxBytes.length - 30));
  writeFileSync(join(cwd, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(join(cwd, 'page.html'), '<script>alert(1)</script>');
  writeFileSync(join(cwd, 'fake.png'), 'not really a png');
  writeFileSync(join(cwd, 'clip.mp4'), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64)]));
  mkdirSync(join(cwd, 'sub'));
  symlinkSync(outside, join(cwd, 'link-out'));
  symlinkSync(join(outside, 'secret.png'), join(cwd, 'secret-link.png'));
  const created = await call('POST', '/api/agents', {
    cookie: adminCookie,
    body: { name: 'files.raw', system_prompt: '# raw', config: { cwd } },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));

  const get = (path: string, opts: { cookie?: string; headers?: Record<string, string> } = {}) => fetch(
    `${base}/api/agents/files.raw/files/raw?path=${encodeURIComponent(path)}`,
    { headers: { ...(opts.cookie ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}` } : {}), ...opts.headers } },
  );

  // Who may read: an anonymous caller and a user without agent permissions are refused.
  assert.equal((await get('pic.png')).status, 401);
  assert.equal((await get('pic.png', { cookie: eveCookie })).status, 403);

  const image = await get('pic.png', { cookie: adminCookie });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.match(image.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);

  const pdf = await get('doc.pdf', { cookie: adminCookie });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition') ?? '', /^inline/);
  assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff');
  await pdf.arrayBuffer();

  // An Office document is an attachment under a sandbox, never an inline document.
  const docx = await get('letter.docx', { cookie: adminCookie });
  assert.equal(docx.status, 200);
  assert.match(docx.headers.get('content-type') ?? '', /wordprocessingml/);
  assert.match(docx.headers.get('content-disposition') ?? '', /^attachment/);
  assert.match(docx.headers.get('content-security-policy') ?? '', /sandbox/);
  await docx.arrayBuffer();

  // A video seeks: a byte range gets a 206.
  const clip = await get('clip.mp4', { cookie: adminCookie, headers: { range: 'bytes=0-9' } });
  assert.equal(clip.status, 206);
  assert.equal(clip.headers.get('content-range'), 'bytes 0-9/76');
  await clip.arrayBuffer();

  // The signature decides, not the name: a zip called .txt, an svg, an html
  // page and a text called .png are not put in front of a browser.
  // An Office file must also be the right container: a generic zip called
  // .docx, a docx called .xlsx and a truncated archive carry no root part.
  for (const refused of ['letter-renamed.txt', 'vector.svg', 'page.html', 'fake.png', 'generic.docx', 'letter-as.xlsx', 'cut.docx']) {
    const r = await get(refused, { cookie: adminCookie });
    assert.equal(r.status, 415, refused);
    await r.arrayBuffer();
  }

  // Outside the working directory — dot-dot, a symlinked folder, a symlinked
  // file — is refused, and the bytes never leave.
  for (const escape of ['../' + outside.split(/[\\/]/).pop() + '/secret.png', 'link-out/secret.png', 'secret-link.png']) {
    const r = await get(escape, { cookie: adminCookie });
    assert.equal(r.status, 403, escape);
    assert.match(JSON.stringify(await r.json()), /escapes/);
  }
  // Network and drive paths are refused before anything touches disk.
  for (const network of ['//host/share/a.png', '\\\\host\\share\\a.png', 'C:\\Windows\\a.png', 'pic\0.png']) {
    const r = await get(network, { cookie: adminCookie });
    assert.equal(r.status, 400, network);
    await r.arrayBuffer();
  }
  // A folder, an absent file and an unknown agent are not served either.
  assert.equal((await get('sub', { cookie: adminCookie })).status, 404);
  assert.equal((await get('missing.png', { cookie: adminCookie })).status, 404);
  const unknown = await fetch(`${base}/api/agents/nobody/files/raw?path=pic.png`, {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(adminCookie)}` },
  });
  assert.equal(unknown.status, 404);
});

test('a file outside the agent folder opens only with files:external, as an absolute path, and only an existing file', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'timon-files-external-'));
  const note = join(outside, 'note.txt');
  writeFileSync(note, 'hello outside');
  const url = (path: string) => `${base}/api/agents/files.raw/files/external?path=${encodeURIComponent(path)}`;
  const as = (cookie?: string) => ({ headers: cookie ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } : {} });

  // An anonymous caller and an account without the permission are refused.
  assert.equal((await fetch(url(note))).status, 401);
  assert.equal((await fetch(url(note), as(eveCookie))).status, 403);
  const put = (cookie: string | undefined, path: string, body: string) => fetch(url(path), {
    method: 'PUT', body, headers: { 'content-type': 'text/plain', ...as(cookie).headers },
  });
  assert.equal((await put(eveCookie, note, 'x')).status, 403);
  assert.equal(readFileSync(note, 'utf8'), 'hello outside');

  // The superadmin (`*`) reads and writes.
  const read = await fetch(url(note), as(adminCookie));
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as { content: string }).content, 'hello outside');
  assert.equal((await put(adminCookie, note, 'edited')).status, 200);
  assert.equal(readFileSync(note, 'utf8'), 'edited');

  // Absolute local paths to an existing file, nothing else.
  for (const bad of ['note.txt', '../note.txt', outside, join(outside, 'missing.txt'), '//host/share/a.txt']) {
    assert.equal((await fetch(url(bad), as(adminCookie))).status, 400, bad);
    assert.equal((await put(adminCookie, bad, 'x')).status, 400, bad);
  }
  assert.equal(readdirSync(outside).length, 1, 'a write never creates a file');
});

test('skill creation persists markdown and rejects anonymous callers', async () => {
  const body = { id: 'contract-skill', content: '# Contract\n\nInstructions é\r\n' }; // french-ok: a non-ASCII byte the skill round-trips
  assert.equal((await call('POST', '/api/skills', { body })).status, 401);
  const created = await call('POST', '/api/skills', { cookie: adminCookie, body });
  assert.equal(created.status, 200);
  const { skillFile } = await import('../../paths.js');
  assert.equal(readFileSync(skillFile(body.id), 'utf8'), body.content);
});

test('skill writes reject empty content and invalid payloads before writing', async () => {
  for (const body of [
    { id: 'empty-skill', content: ' \r\n ' },
    { id: 'empty-skill' },
    { id: 'empty-skill', content: 42 },
    { id: '.', content: '# Invalid' },
    { id: '..', content: '# Invalid' },
    { id: 'valid', path: 42, content: '# Invalid' },
  ]) {
    assert.equal((await call('POST', '/api/skills', { cookie: adminCookie, body })).status, 400, JSON.stringify(body));
  }
});

test('agents without cwd can be created and saved; invalid directories remain rejected', async () => {
  const body = { name: 'no-cwd.agent', system_prompt: 'Initial', config: { role: 'orchestrator' } };
  const create = await call('POST', '/api/agents', { cookie: adminCookie, body });
  assert.equal(create.status, 200);
  const save = await call('POST', '/api/agents', {
    cookie: adminCookie, body: { ...body, system_prompt: 'Edited' },
  });
  assert.equal(save.status, 200);
  const agent = await call('GET', '/api/agents/no-cwd.agent', { cookie: adminCookie });
  assert.equal(agent.status, 200);
  assert.equal((agent.json as { cwd: string | null }).cwd, null);
  const invalid = await call('POST', '/api/agents', {
    cookie: adminCookie,
    body: { ...body, config: { cwd: join(process.env.TIMON_HOME!, 'missing-directory') } },
  });
  assert.equal(invalid.status, 400);
  const error = (invalid.json as { error: string }).error;
  assert.match(error, /cwd does not exist on the host/);
  assert.doesNotMatch(error, /\/home\/<user>/, 'the guidance must not assume Linux');
});


test('built-in prompt overrides persist, preserve identity and reset to shipped defaults', async () => {
  const { getRole, ROLE_REGISTRY, createRole, updateRole, deleteRole } = await import('../../agent-roles.js');
  const { BUILTIN_ROLE_OVERRIDES_FILE } = await import('../../paths.js');
  const original = ROLE_REGISTRY.find((role) => role.id === 'coder')!;
  const path = '/api/agent-roles/coder';
  const saved = await call('PUT', path, { cookie: adminCookie, body: { default_directives: 'Use the project conventions.' } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, { ...original, default_directives: 'Use the project conventions.', directives_overridden: true });
  assert.equal(getRole('coder')?.default_directives, 'Use the project conventions.');
  assert.equal(JSON.parse(readFileSync(BUILTIN_ROLE_OVERRIDES_FILE, 'utf8')).coder, 'Use the project conventions.');
  const listed = await call('GET', '/api/agent-roles', { cookie: adminCookie });
  assert.deepEqual((listed.json as { roles: unknown[] }).roles.find((role) => (role as { id: string }).id === 'coder'), saved.json);

  createRole({ id: 'test-role', label: 'Test', iconName: 'Test', iconSvg: '<path/>', color: '#123456' });
  updateRole('test-role', { default_directives: 'Custom' });
  deleteRole('test-role');
  assert.equal(getRole('coder')?.directives_overridden, true, 'custom role writes preserve overrides');
  for (const body of [{ label: 'Changed' }, { default_directives: 'x', iconName: 'Other' }, { default_directives: 42 }, { reset_directives: false }, { reset_directives: true, default_directives: 'x' }]) {
    assert.equal((await call('PUT', path, { cookie: adminCookie, body })).status, 400);
  }
  assert.equal((await call('DELETE', path, { cookie: adminCookie })).status, 400);
  assert.equal((await call('PUT', path, { cookie: adminCookie, body: { default_directives: '' } })).status, 200);
  assert.equal(getRole('coder')?.default_directives, '', 'an empty override is intentional');
  const reset = await call('PUT', path, { cookie: adminCookie, body: { reset_directives: true } });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.json, { ...original, directives_overridden: false });
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(BUILTIN_ROLE_OVERRIDES_FILE, 'utf8')), 'coder'), false);
  assert.equal((await call('PUT', path, { cookie: adminCookie, body: { reset_directives: true } })).status, 200);
});

test('role prompt writes and reset reject anonymous and unauthorized users', async () => {
  for (const body of [{ default_directives: 'Unauthorized' }, { reset_directives: true }]) {
    assert.equal((await call('PUT', '/api/agent-roles/coder', { body })).status, 401);
    assert.equal((await call('PUT', '/api/agent-roles/coder', { cookie: adaCookie, body })).status, 403);
  }
  assert.equal((await call('GET', '/api/agent-roles')).status, 401);
});


test('a custom role icon is a closed set of shapes: script-bearing markup is refused on write and dropped on read', async () => {
  const { ROLE_REGISTRY, getRole, deleteRole, createRole, updateRole, roleIconSvgProblem } = await import('../../agent-roles.js');
  const { CUSTOM_ROLES_FILE } = await import('../../paths.js');
  for (const role of ROLE_REGISTRY) assert.equal(roleIconSvgProblem(role.iconSvg), null, `built-in ${role.id} icon stays valid`);
  // As captured by the picker from the rendered DOM (end tags, a group).
  const lucide = '<path d="M12 7v14"></path><circle cx="12" cy="12" r="3"></circle><g transform="translate(1 1)"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/></g>';
  const role = { id: 'icon-role', label: 'Icon', iconName: 'BookOpen', iconSvg: lucide, color: '#123456' };
  const createdRole = await call('POST', '/api/agent-roles', { cookie: adminCookie, body: role });
  assert.equal(createdRole.status, 201);
  assert.equal(getRole('icon-role')?.iconSvg, lucide);

  const trapped = [
    '<image href="x" onerror="alert(1)"/>',
    '<script>alert(1)</script>',
    '<path d="M1 1" onload="alert(1)"/>',
    '<path d="M1 1" style="fill:red"/>',
    '<path fill="currentColor"/>',
    '<path d="M1 1" fill="url(#x)"/>',
    '<circle r="3" stroke="url(evil)"/>',
    '<path xlink:href="#a"/>',
    '<foreignObject><div>x</div></foreignObject>',
    '<use href="#a"/>',
    '<path d="&#97;"/>',
    '<![CDATA[x]]><path/>',
    '<path d="M1 1"/>text',
    '<path d="url(javascript:alert(1))"/>',
    '<path d="M1 1"><path/></path>',
    '<path d="M1 1">',
    '<svg><path/></svg>',
    `<path d="${'1 '.repeat(2100)}"/>`,
    '',
  ];
  for (const iconSvg of trapped) {
    const label = JSON.stringify(iconSvg.slice(0, 40));
    assert.equal((await call('POST', '/api/agent-roles', { cookie: adminCookie, body: { ...role, id: 'icon-bad', iconSvg } })).status, 400, `POST ${label}`);
    assert.equal((await call('PUT', '/api/agent-roles/icon-role', { cookie: adminCookie, body: { iconSvg } })).status, 400, `PUT ${label}`);
    assert.throws(() => createRole({ ...role, id: 'icon-direct', iconSvg }), undefined, `createRole ${label}`);
    assert.throws(() => updateRole('icon-role', { iconSvg }), undefined, `updateRole ${label}`);
  }
  assert.equal(getRole('icon-bad'), null);
  assert.equal(getRole('icon-direct'), null);
  assert.equal(getRole('icon-role')?.iconSvg, lucide, 'a refused update leaves the stored icon untouched');

  assert.equal((await call('POST', '/api/agent-roles', { body: { ...role, id: 'icon-anon' } })).status, 401);
  assert.equal((await call('PUT', '/api/agent-roles/icon-role', { body: { iconSvg: lucide } })).status, 401);

  // A roles.json armed before the grammar existed is disarmed at read time.
  const stored = JSON.parse(readFileSync(CUSTOM_ROLES_FILE, 'utf8')) as Array<Record<string, unknown>>;
  stored.push({ ...role, id: 'icon-armed', iconSvg: '<image href="x" onerror="alert(1)"/>' });
  writeFileSync(CUSTOM_ROLES_FILE, JSON.stringify(stored));
  const later = Date.now() / 1000 + 120;
  utimesSync(CUSTOM_ROLES_FILE, later, later);
  const listed = await call('GET', '/api/agent-roles', { cookie: adminCookie });
  assert.equal(listed.status, 200);
  const roles = (listed.json as { roles: Array<{ id: string; iconSvg: string }> }).roles;
  assert.equal(roles.find((r) => r.id === 'icon-armed')?.iconSvg, '');
  assert.equal(roles.find((r) => r.id === 'icon-role')?.iconSvg, lucide);
  deleteRole('icon-armed');
  deleteRole('icon-role');
});

test('unreadable prompt overrides fall back to shipped defaults and recover after repair', async () => {
  const { getRole, ROLE_REGISTRY, updateRole, resetRoleDirectives } = await import('../../agent-roles.js');
  const { BUILTIN_ROLE_OVERRIDES_FILE } = await import('../../paths.js');
  const original = ROLE_REGISTRY.find((role) => role.id === 'coder')!;
  const expected = { ...original, directives_overridden: false };
  let timestamp = Date.now() / 1000 + 60;
  const replaceFile = (content: string) => {
    writeFileSync(BUILTIN_ROLE_OVERRIDES_FILE, content);
    // Distinct timestamps make cache invalidation deterministic on coarse filesystems.
    timestamp += 2;
    utimesSync(BUILTIN_ROLE_OVERRIDES_FILE, timestamp, timestamp);
  };
  try {
    for (const content of ['{oops', '{"coder":42}']) {
      updateRole('coder', { default_directives: 'Cached override' });
      assert.equal(getRole('coder')?.directives_overridden, true);
      replaceFile(content);
      assert.deepEqual(getRole('coder'), expected);
      const listed = await call('GET', '/api/agent-roles', { cookie: adminCookie });
      assert.equal(listed.status, 200);
      assert.deepEqual((listed.json as { roles: { id: string }[] }).roles.find((role) => role.id === 'coder'), expected);
      replaceFile('{"coder":"Repaired override"}');
      assert.equal(getRole('coder')?.default_directives, 'Repaired override');
      assert.equal(getRole('coder')?.directives_overridden, true);
    }
    unlinkSync(BUILTIN_ROLE_OVERRIDES_FILE);
    assert.deepEqual(getRole('coder'), expected, 'removing the file must discard cached overrides');
  } finally {
    resetRoleDirectives('coder');
  }
});

test('GET /api/agents names the main agent by the recorded name, not by `_main` nor by role (#134)', async () => {
  const { setMainAgentName } = await import('../../main-agent.js');
  for (const name of ['Nova', 'newagent']) {
    const created = await call('POST', '/api/agents', {
      cookie: adminCookie, body: { name, system_prompt: 'x', config: { role: 'orchestrator' } },
    });
    assert.equal(created.status, 200);
  }
  setMainAgentName('Nova');
  for (const cookie of [adminCookie, adaCookie]) {
    const list = await call('GET', '/api/agents', { cookie });
    assert.equal(list.status, 200);
    const main = (list.json as { agents: { name: string; main?: boolean }[] }).agents.filter((a) => a.main);
    assert.deepEqual(main.map((a) => a.name), ['Nova']);
  }
});

test('GET /api/agents says when the main seat is empty and who may take it, in both views (TIM-0142)', async () => {
  const { MAIN_AGENT_KEY, setMainAgentName } = await import('../../main-agent.js');
  const { AGENTS_DIR } = await import('../../paths.js');
  const { rmSync } = await import('node:fs');
  // A rebuilt database: nothing recorded, no seed literal on disk.
  dbApi.deleteSetting(MAIN_AGENT_KEY);
  for (const seed of ['_main', 'TIMON.main']) rmSync(join(AGENTS_DIR, seed), { force: true, recursive: true });
  try {
    for (const cookie of [adminCookie, adaCookie]) {
      const list = await call('GET', '/api/agents', { cookie });
      assert.equal(list.status, 200);
      const body = list.json as { agents: { name: string; main?: boolean }[]; main_seat: { holder: string | null; empty: boolean; candidates: string[] } };
      assert.equal(body.main_seat.empty, true);
      assert.equal(body.main_seat.holder, null);
      assert.ok(body.main_seat.candidates.includes('Nova') && body.main_seat.candidates.includes('newagent'), body.main_seat.candidates.join(','));
      assert.deepEqual(body.agents.filter((a) => a.main), []);
    }
    setMainAgentName('Nova');
    const held = await call('GET', '/api/agents', { cookie: adminCookie });
    assert.deepEqual((held.json as { main_seat: unknown }).main_seat, {
      holder: 'Nova', empty: false, candidates: (held.json as { main_seat: { candidates: string[] } }).main_seat.candidates,
    });
  } finally {
    setMainAgentName('Nova');
  }
});

test('GET /api/agents/active lists running and recently ended missions, scoped to their owner', async () => {
  const { db } = await import('../../db.js');
  const adminId = dbApi.getUserByEmail('admin@example.com')!.id;
  const now = Date.now();
  // Autonomous task missions keep the short window; a chat mission ended
  // 10 min ago is still inside its 30 min window.
  dbApi.createMission('active-running', 'active.runner', 'x', undefined, adaId);
  dbApi.createMission('active-recent', 'active.recent', 'x', undefined, adaId);
  dbApi.createMission('active-old', 'active.old', 'x', undefined, adaId);
  dbApi.createMission('active-admin', 'active.admin', 'x', undefined, adminId);
  const end = db.prepare(`UPDATE missions SET status = 'completed', ended_at = ? WHERE id = ?`);
  end.run(now - 10 * 60 * 1000, 'active-recent');
  end.run(now - 3 * 60 * 60 * 1000, 'active-old');

  const namesFor = async (cookie?: string) => {
    const res = await call('GET', '/api/agents/active', cookie ? { cookie } : {});
    return { status: res.status, names: ((res.json as { agents?: { name: string; state: string; started_at: number }[] })?.agents ?? []) };
  };

  const ada = await namesFor(adaCookie);
  assert.equal(ada.status, 200);
  const adaStates = Object.fromEntries(ada.names.map((a) => [a.name, a.state]));
  // The strip keys a closed tab on the mission's start, which turns do not move.
  const started = (id: string) => (db.prepare('SELECT started_at FROM missions WHERE id = ?').get(id) as { started_at: number }).started_at;
  const adaStarts = Object.fromEntries(ada.names.map((a) => [a.name, a.started_at]));
  assert.equal(adaStarts['active.runner'], started('active-running'));
  assert.equal(adaStarts['active.recent'], started('active-recent'));
  assert.equal(adaStates['active.runner'], 'idle');
  assert.equal(adaStates['active.recent'], 'done');
  assert.equal(adaStates['active.old'], undefined, 'a mission ended hours ago is not active');
  assert.equal(adaStates['active.admin'], undefined, "another user's mission stays invisible");

  const eve = await namesFor(eveCookie);
  assert.equal(eve.status, 200);
  assert.deepEqual(eve.names.filter((a) => a.name.startsWith('active.')), []);

  const anonymous = await namesFor();
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.names, []);

  const admin = await namesFor(adminCookie);
  const adminNames = admin.names.map((a) => a.name);
  assert.ok(adminNames.includes('active.admin'));
  assert.ok(!adminNames.includes('active.old'));
});

test('the main orchestrator seat: anonymous 401, employee 403, a human designates, the seat cannot be removed', async () => {
  const { upsertAgent } = await import('../../agent.js');
  upsertAgent({ name: 'seat-owner', system_prompt: 'x', config: { role: 'orchestrator', cwd: tmpdir() } });
  upsertAgent({ name: 'seat-other', system_prompt: 'x', config: { role: 'orchestrator', cwd: tmpdir() } });

  const anonymous = await call('PUT', '/api/agents/main', { body: { name: 'seat-owner' } });
  assert.equal(anonymous.status, 401);
  const employee = await call('PUT', '/api/agents/main', { cookie: adaCookie, body: { name: 'seat-owner' } });
  assert.equal(employee.status, 403);

  const bad = await call('PUT', '/api/agents/main', { cookie: adminCookie, body: { name: 'ghost' } });
  assert.equal(bad.status, 400);
  const extra = await call('PUT', '/api/agents/main', { cookie: adminCookie, body: { name: 'seat-owner', nope: 1 } });
  assert.equal(extra.status, 400, 'unknown fields are rejected');

  const ok = await call('PUT', '/api/agents/main', { cookie: adminCookie, body: { name: 'seat-owner' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, main: 'seat-owner' });
  const list = await call('GET', '/api/agents', { cookie: adminCookie });
  const mains = (list.json as { agents: { name: string; main: boolean }[] }).agents.filter((a) => a.main).map((a) => a.name);
  assert.deepEqual(mains, ['seat-owner']);

  const del = await call('DELETE', '/api/agents/seat-owner', { cookie: adminCookie });
  assert.equal(del.status, 409);
  const delOther = await call('DELETE', '/api/agents/seat-other', { cookie: adminCookie });
  assert.equal(delOther.status, 200, 'any other agent is removable as before');
});
