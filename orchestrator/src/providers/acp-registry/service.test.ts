/**
 * The ACP-registry provider end to end, offline: a fake `fetch` serves the
 * registry document and the archives; the profile registry is the real one.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTarGzWithModes, buildZip } from './archive-fixtures.js';
import type { Fetcher } from './download.js';

const { AcpRegistryService, AcpRegistryError, profileIdOf, dialectIdOf } = await import('./service.js');
const { REGISTRY_URL } = await import('./schema.js');
const { backendNames, getBackend, isBackendName } = await import('../../backends/index.js');

const posix = process.platform !== 'win32';
const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

type Served = Map<string, Buffer | { status: number; headers?: Record<string, string> }>;
function fakeFetch(served: Served, seen: string[] = []): Fetcher {
  return async (url) => {
    seen.push(url);
    const hit = served.get(url);
    if (!hit) return new Response('nope', { status: 404 });
    if (Buffer.isBuffer(hit)) return new Response(new Uint8Array(hit), { status: 200 });
    return new Response(null, { status: hit.status, headers: hit.headers });
  };
}

function tarOf(script: string): Buffer {
  return buildTarGzWithModes([
    { path: 'dist/', type: '5', mode: 0o755 },
    { path: 'dist/agent', data: script, mode: 0o755 },
    { path: 'dist/lib.js', data: 'module.exports = 1', mode: 0o644 },
  ]);
}

function registryDoc(agents: unknown[]): Buffer {
  return Buffer.from(JSON.stringify({ version: '1.0.0', agents }));
}
const agentEntry = (over: { id?: string; version?: string; archive?: string; sha256?: string; cmd?: string; args?: string[] } = {}) => ({
  id: over.id ?? 'acme-agent', name: 'Acme Agent', version: over.version ?? '1.0.0', description: 'An agent',
  distribution: { binary: { 'linux-x86_64': {
    archive: over.archive ?? 'https://downloads.example.com/acme-1.0.0.tar.gz',
    cmd: over.cmd ?? './dist/agent', args: over.args ?? ['acp'], ...(over.sha256 ? { sha256: over.sha256 } : {}),
  } } },
});

function newService(served: Served, extra: Partial<ConstructorParameters<typeof AcpRegistryService>[0]> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'timon-acp-service-'));
  return {
    home,
    // The fixtures are shell scripts, not agents: asked how they sign in, they answer nothing.
    service: new AcpRegistryService({ home, fetchFn: fakeFetch(served), platform: 'linux', arch: 'x64', inspect: async () => [], ...extra }),
  };
}

test('list: only downloadable programs are supported, the rest says why, a bad entry is dropped', async () => {
  const served: Served = new Map([[REGISTRY_URL, registryDoc([
    agentEntry(),
    { id: 'via-npx', name: 'NPX', version: '1.0.0', distribution: { npx: { package: 'x' } } },
    { id: 'windows-only', name: 'Win', version: '1.0.0', distribution: { binary: { 'windows-x86_64': { archive: 'https://x.example/w.zip', cmd: 'w.exe' } } } },
    { id: 'bz', name: 'Bz', version: '1.0.0', distribution: { binary: { 'linux-x86_64': { archive: 'https://x.example/b.tar.bz2', cmd: 'b' } } } },
    { id: 'Bad ID', name: 'Broken', version: '1', distribution: {} },
  ])]]);
  const { service } = newService(served);
  const list = await service.list();
  assert.equal(list.dropped, 1);
  const byId = Object.fromEntries(list.agents.map((a) => [a.id, a]));
  assert.equal(byId['acme-agent']?.supported, true);
  assert.equal(byId['acme-agent']?.integrity, 'none');
  assert.match(byId['via-npx']?.reason ?? '', /package runner/);
  assert.match(byId['windows-only']?.reason ?? '', /no build for this machine/);
  assert.match(byId['bz']?.reason ?? '', /archive format/);
});

test('an agent with no published sha256 needs an explicit acknowledgement, and is then recorded unverified', { skip: !posix }, async () => {
  const archive = tarOf('#!/bin/sh\necho one\n');
  const served: Served = new Map([
    [REGISTRY_URL, registryDoc([agentEntry({ id: 'no-hash', archive: 'https://downloads.example.com/nohash.tar.gz' })])],
    ['https://downloads.example.com/nohash.tar.gz', archive],
  ]);
  const { service, home } = newService(served);
  await assert.rejects(() => service.install('no-hash'), (e: unknown) => e instanceof AcpRegistryError && e.code === 'unverified' && e.status === 409);
  assert.equal(existsSync(join(home, 'providers', 'acp-registry', 'agents', 'no-hash')), false, 'nothing was downloaded');
  const view = await service.install('no-hash', { acceptUnverified: true });
  assert.equal(view.installed?.integrity, 'unverified');
  assert.equal(view.installed?.state, 'ok');
  service.dispose();
});

test('install: verified, launched through its own provider with the registry args, executable bit kept', { skip: !posix }, async () => {
  const archive = tarOf('#!/bin/sh\necho one\n');
  const served: Served = new Map([
    [REGISTRY_URL, registryDoc([agentEntry({ id: 'good-agent', archive: 'https://downloads.example.com/good.tar.gz', sha256: sha(archive), args: ['acp', '--stdio'] })])],
    ['https://downloads.example.com/good.tar.gz', archive],
  ]);
  const { service, home } = newService(served);
  try {
    const view = await service.install('good-agent');
    assert.equal(view.installed?.integrity, 'sha256');
    const id = profileIdOf('good-agent');
    assert.ok(backendNames().includes(id), 'the profile is dispatchable');
    const spawned = await getBackend(id).buildSpawn({
      agentName: 'timon.test', systemPrompt: '', message: '', resumeSession: null,
      cfg: { cwd: tmpdir(), permission_mode: 'auto' }, missionId: 'm',
    });
    assert.equal(spawned.cmd, join(home, 'providers', 'acp-registry', 'agents', 'good-agent', '1.0.0', 'dist', 'agent'));
    assert.deepEqual(spawned.args, ['acp', '--stdio']);
    const state = JSON.parse(readFileSync(join(home, 'providers', 'acp-registry', 'state.json'), 'utf8')) as { agents: Record<string, { archiveSha256: string }> };
    assert.equal(state.agents['good-agent']?.archiveSha256, sha(archive));
  } finally { service.dispose(); }
  assert.equal(isBackendName(profileIdOf('good-agent')), false, 'dispose unregisters');
});

test('the longest id the registry schema accepts (64 characters) is still installable: the provider id stays within its own limit', { skip: !posix }, async () => {
  const longId = `a${'b'.repeat(63)}`;
  const archive = tarOf('#!/bin/sh\necho one\n');
  const served: Served = new Map([
    [REGISTRY_URL, registryDoc([agentEntry({ id: longId, archive: 'https://downloads.example.com/long.tar.gz', sha256: sha(archive) })])],
    ['https://downloads.example.com/long.tar.gz', archive],
  ]);
  const { service } = newService(served);
  try {
    await service.install(longId);
    const profile = profileIdOf(longId);
    assert.ok(backendNames().includes(profile), 'dispatchable under the profile id as before');
    const dialect = dialectIdOf(longId);
    assert.ok(dialect.length <= 64 && dialect !== profile, 'the provider id is shortened, deterministically');
    assert.equal(dialectIdOf(longId), dialect);
    assert.notEqual(dialectIdOf(`a${'b'.repeat(62)}c`), dialect, 'two long ids do not collide');
    assert.equal(dialectIdOf('good-agent'), profileIdOf('good-agent'), 'a normal id keeps the readable one');
  } finally { service.dispose(); }
});

test('a sha256 that does not match refuses the install and leaves no file', { skip: !posix }, async () => {
  const archive = tarOf('#!/bin/sh\n');
  const served: Served = new Map([
    [REGISTRY_URL, registryDoc([agentEntry({ id: 'bad-hash', archive: 'https://downloads.example.com/bad.tar.gz', sha256: 'a'.repeat(64) })])],
    ['https://downloads.example.com/bad.tar.gz', archive],
  ]);
  const { service, home } = newService(served);
  await assert.rejects(() => service.install('bad-hash'), (e: unknown) => e instanceof AcpRegistryError && e.code === 'checksum');
  assert.equal(isBackendName(profileIdOf('bad-hash')), false);
  const agents = join(home, 'providers', 'acp-registry', 'agents');
  assert.equal(existsSync(agents) ? readdirSync(agents).length : 0, 0);
  assert.deepEqual(existsSync(join(home, 'providers', 'acp-registry', 'tmp')) ? readdirSync(join(home, 'providers', 'acp-registry', 'tmp')) : [], []);
});

test('a hostile archive is refused after the hash passed, and a registry cmd cannot leave the folder', { skip: !posix }, async () => {
  const evil = buildTarGzWithModes([{ path: '../escape', data: 'x' }]);
  const noCmd = tarOf('#!/bin/sh\n');
  const served: Served = new Map([
    [REGISTRY_URL, registryDoc([
      agentEntry({ id: 'evil', archive: 'https://downloads.example.com/evil.tar.gz', sha256: sha(evil) }),
      agentEntry({ id: 'wrong-cmd', archive: 'https://downloads.example.com/ok.tar.gz', sha256: sha(noCmd), cmd: '../../etc/passwd' }),
      agentEntry({ id: 'absent-cmd', archive: 'https://downloads.example.com/ok.tar.gz', sha256: sha(noCmd), cmd: './dist/missing' }),
    ])],
    ['https://downloads.example.com/evil.tar.gz', evil],
    ['https://downloads.example.com/ok.tar.gz', noCmd],
  ]);
  const { service } = newService(served);
  await assert.rejects(() => service.install('evil'), (e: unknown) => e instanceof AcpRegistryError && e.code === 'archive');
  await assert.rejects(() => service.install('wrong-cmd'), (e: unknown) => e instanceof AcpRegistryError && e.code === 'command-missing');
  await assert.rejects(() => service.install('absent-cmd'), (e: unknown) => e instanceof AcpRegistryError && e.code === 'command-missing');
  for (const id of ['evil', 'wrong-cmd', 'absent-cmd']) assert.equal(isBackendName(profileIdOf(id)), false);
});

test('update: the new version is verified first, the backend is dispatchable throughout, the old folder is kept one generation', { skip: !posix }, async () => {
  const v1 = tarOf('#!/bin/sh\necho one\n');
  const v2 = tarOf('#!/bin/sh\necho two\n');
  const v3 = tarOf('#!/bin/sh\necho three\n');
  const registry = (version: string, archive: Buffer, url: string) =>
    registryDoc([agentEntry({ id: 'upd', version, archive: url, sha256: sha(archive) })]);
  const served: Served = new Map([
    [REGISTRY_URL, registry('1.0.0', v1, 'https://downloads.example.com/u1.tar.gz')],
    ['https://downloads.example.com/u1.tar.gz', v1],
    ['https://downloads.example.com/u2.tar.gz', v2],
    ['https://downloads.example.com/u3.tar.gz', v3],
  ]);
  let clock = 0;
  const { service, home } = newService(served, { now: () => (clock += 11 * 60_000) });
  try {
    await service.install('upd');
    served.set(REGISTRY_URL, registry('1.1.0', v2, 'https://downloads.example.com/u2.tar.gz'));
    assert.equal((await service.list()).agents.find((a) => a.id === 'upd')?.installed?.updateAvailable, true);

    const missing: number[] = [];
    let sampling = true;
    const sampler = (async () => { while (sampling) { if (!isBackendName(profileIdOf('upd'))) missing.push(1); await new Promise((r) => setImmediate(r)); } })();
    const updated = await service.install('upd');
    sampling = false; await sampler;
    assert.deepEqual(missing, []);
    assert.equal(updated.installed?.version, '1.1.0');
    const base = join(home, 'providers', 'acp-registry', 'agents', 'upd');
    assert.deepEqual(readdirSync(base).sort(), ['1.0.0', '1.1.0']);

    served.set(REGISTRY_URL, registry('1.2.0', v3, 'https://downloads.example.com/u3.tar.gz'));
    await service.install('upd');
    assert.deepEqual(readdirSync(base).sort(), ['1.1.0', '1.2.0'], '1.0.0 is pruned');
  } finally { service.dispose(); }
});

test('a failed update leaves the working version registered', { skip: !posix }, async () => {
  const v1 = tarOf('#!/bin/sh\necho one\n');
  const served: Served = new Map([
    [REGISTRY_URL, registryDoc([agentEntry({ id: 'keep', archive: 'https://downloads.example.com/k1.tar.gz', sha256: sha(v1) })])],
    ['https://downloads.example.com/k1.tar.gz', v1],
  ]);
  let clock = 0;
  const { service } = newService(served, { now: () => (clock += 11 * 60_000) });
  try {
    await service.install('keep');
    served.set(REGISTRY_URL, registryDoc([agentEntry({ id: 'keep', version: '2.0.0', archive: 'https://downloads.example.com/k2.tar.gz', sha256: 'b'.repeat(64) })]));
    served.set('https://downloads.example.com/k2.tar.gz', tarOf('#!/bin/sh\necho two\n'));
    await assert.rejects(() => service.install('keep'), (e: unknown) => e instanceof AcpRegistryError && e.code === 'checksum');
    assert.equal(isBackendName(profileIdOf('keep')), true);
    assert.equal((await service.list()).agents.find((a) => a.id === 'keep')?.installed?.version, '1.0.0');
  } finally { service.dispose(); }
});

test('restore registers an intact install and refuses one whose files changed', { skip: !posix }, async () => {
  const v1 = tarOf('#!/bin/sh\necho one\n');
  const served: Served = new Map([
    [REGISTRY_URL, registryDoc([agentEntry({ id: 'rest', archive: 'https://downloads.example.com/r.tar.gz', sha256: sha(v1) })])],
    ['https://downloads.example.com/r.tar.gz', v1],
  ]);
  const { service, home } = newService(served);
  await service.install('rest');
  service.dispose();
  assert.equal(isBackendName(profileIdOf('rest')), false);

  const again = new AcpRegistryService({ home, fetchFn: fakeFetch(served), platform: 'linux', arch: 'x64' });
  await again.restore();
  assert.equal(isBackendName(profileIdOf('rest')), true, 'an intact install comes back at boot');
  again.dispose();

  // Someone swaps the launcher on disk.
  writeFileSync(join(home, 'providers', 'acp-registry', 'agents', 'rest', '1.0.0', 'dist', 'agent'), '#!/bin/sh\nevil\n');
  const tampered = new AcpRegistryService({ home, fetchFn: fakeFetch(served), platform: 'linux', arch: 'x64' });
  await tampered.restore();
  assert.equal(isBackendName(profileIdOf('rest')), false, 'altered files are never registered');
  const view = (await tampered.list()).agents.find((a) => a.id === 'rest');
  assert.equal(view?.installed?.state, 'tampered');
  // Reinstalling repairs it.
  await tampered.install('rest');
  assert.equal(isBackendName(profileIdOf('rest')), true);
  tampered.dispose();
});

test('remove unregisters and deletes; an unreachable registry keeps what is installed usable', { skip: !posix }, async () => {
  const v1 = tarOf('#!/bin/sh\n');
  const served: Served = new Map([
    [REGISTRY_URL, registryDoc([agentEntry({ id: 'rm', archive: 'https://downloads.example.com/rm.tar.gz', sha256: sha(v1) })])],
    ['https://downloads.example.com/rm.tar.gz', v1],
  ]);
  const { service, home } = newService(served);
  await service.install('rm');
  served.delete(REGISTRY_URL);
  const offline = await service.list({ refresh: true });
  assert.equal(offline.stale, true, 'the cached document is served, flagged stale');
  await service.remove('rm');
  assert.equal(isBackendName(profileIdOf('rm')), false);
  assert.equal(existsSync(join(home, 'providers', 'acp-registry', 'agents', 'rm')), false);
  await assert.rejects(() => service.remove('rm'), (e: unknown) => e instanceof AcpRegistryError && e.code === 'not-installed');
});

test('windows: the x86_64 zip is used on arm64, with the .cmd launcher and backslash path', async () => {
  const zip = buildZip([{ path: 'dist-package/cursor-agent.cmd', data: '@echo off' }]);
  const served: Served = new Map([
    [REGISTRY_URL, registryDoc([{
      id: 'winagent', name: 'Win', version: '1.0.0',
      distribution: { binary: { 'windows-x86_64': { archive: 'https://downloads.example.com/w.zip', cmd: './dist-package\\cursor-agent.cmd', args: ['acp'], sha256: sha(zip) } } },
    }])],
    ['https://downloads.example.com/w.zip', zip],
  ]);
  const registered: string[] = [];
  const { service } = newService(served, { platform: 'win32', arch: 'arm64', register: (_agent, command) => { registered.push(command); return () => {}; } });
  const view = await service.install('winagent');
  assert.equal(view.installed?.state, 'ok');
  assert.match(registered[0] ?? '', /dist-package[\\/]cursor-agent\.cmd$/);
});

test('an unverified install is offered the verified build once the registry hashes it; the same bytes keep their folder, nothing updates by itself', { skip: !posix }, async () => {
  const archive = tarOf('#!/bin/sh\necho one\n');
  const url = 'https://downloads.example.com/ver.tar.gz';
  const served: Served = new Map([[REGISTRY_URL, registryDoc([agentEntry({ id: 'ver', archive: url })])], [url, archive]]);
  let clock = 0;
  const { service, home } = newService(served, { now: () => (clock += 11 * 60_000) });
  try {
    await service.install('ver', { acceptUnverified: true });
    let view = (await service.list()).agents.find((a) => a.id === 'ver');
    assert.equal(view?.installed?.integrity, 'unverified');
    assert.equal(view?.installed?.verifiedUpdate, false, 'no hash published yet: nothing to offer');

    served.set(REGISTRY_URL, registryDoc([agentEntry({ id: 'ver', archive: url, sha256: sha(archive) })]));
    view = (await service.list()).agents.find((a) => a.id === 'ver');
    assert.equal(view?.installed?.verifiedUpdate, true, 'the registry now hashes this build');
    assert.equal(view?.installed?.updateAvailable, false, 'same version');
    assert.equal(view?.installed?.integrity, 'unverified', 'listing changes nothing');

    const program = join(home, 'providers', 'acp-registry', 'agents', 'ver', '1.0.0', 'dist', 'agent');
    const before = statSync(program).ino;
    const verified = await service.install('ver');
    assert.equal(verified.installed?.integrity, 'sha256');
    assert.equal(verified.installed?.verifiedUpdate, false);
    assert.equal(statSync(program).ino, before, 'identical files are not replaced under a running mission');
    assert.equal(isBackendName(profileIdOf('ver')), true);
    await assert.rejects(() => service.install('ver'), (e: unknown) => e instanceof AcpRegistryError && e.code === 'already-installed');
  } finally { service.dispose(); }
});

test('a newer verified version over an unverified one is offered as such and keeps the old version one generation', { skip: !posix }, async () => {
  const v1 = tarOf('#!/bin/sh\necho one\n');
  const v2 = tarOf('#!/bin/sh\necho two\n');
  const served: Served = new Map([
    [REGISTRY_URL, registryDoc([agentEntry({ id: 'gv', archive: 'https://downloads.example.com/g1.tar.gz' })])],
    ['https://downloads.example.com/g1.tar.gz', v1],
    ['https://downloads.example.com/g2.tar.gz', v2],
  ]);
  let clock = 0;
  const { service, home } = newService(served, { now: () => (clock += 11 * 60_000) });
  try {
    await service.install('gv', { acceptUnverified: true });
    served.set(REGISTRY_URL, registryDoc([agentEntry({ id: 'gv', version: '1.5.0', archive: 'https://downloads.example.com/g2.tar.gz', sha256: sha(v2) })]));
    const view = (await service.list()).agents.find((a) => a.id === 'gv');
    assert.equal(view?.installed?.verifiedUpdate, true);
    assert.equal(view?.installed?.updateAvailable, true);
    const updated = await service.install('gv');
    assert.equal(updated.installed?.version, '1.5.0');
    assert.equal(updated.installed?.integrity, 'sha256');
    assert.deepEqual(readdirSync(join(home, 'providers', 'acp-registry', 'agents', 'gv')).sort(), ['1.0.0', '1.5.0']);
  } finally { service.dispose(); }
});

const ANTIGRAVITY_METHODS = [
  { id: 'oauth-personal', name: 'Log in with Google', description: 'Log in with your Google account' },
  { id: 'gemini-api-key', name: 'Gemini API key', description: 'Use an API key with Gemini Developer API' },
  { id: 'agent-platform', name: 'Gemini Enterprise Agent Platform', description: 'Formerly Vertex AI' },
];

test('sign-in: the methods are read at install and handed to the provider; asked again, a change re-registers the agent', { skip: !posix }, async () => {
  const archive = tarOf('#!/bin/sh\n');
  const served: Served = new Map([
    [REGISTRY_URL, registryDoc([agentEntry({ id: 'signer', archive: 'https://downloads.example.com/s.tar.gz', sha256: sha(archive) })])],
    ['https://downloads.example.com/s.tar.gz', archive],
  ]);
  let answer: unknown = ANTIGRAVITY_METHODS;
  const registered: Array<{ methods: unknown }> = [];
  const { service, home } = newService(served, {
    inspect: async () => answer,
    register: (agent) => { registered.push({ methods: agent.authMethods }); return () => {}; },
  });
  await service.install('signer');
  const kept = registered[0]?.methods as Array<{ id: string; billedPerToken: boolean }>;
  assert.deepEqual(kept.map((m) => [m.id, m.billedPerToken]), [['oauth-personal', false], ['gemini-api-key', true], ['agent-platform', true]]);

  const { methods } = await service.authMethods('signer');
  assert.deepEqual(methods.filter((m) => m.recommended).map((m) => m.id), ['oauth-personal'], 'never a billed method');
  assert.equal(registered.length, 1, 'same answer: no re-registration');

  answer = [...ANTIGRAVITY_METHODS, { id: 'login', name: 'Terminal login', type: 'terminal', args: ['--login'] }];
  const again = await service.authMethods('signer');
  assert.equal(registered.length, 2, 'a changed answer re-registers');
  const terminal = again.methods.find((m) => m.id === 'login');
  assert.equal(terminal?.recommended, true, 'a terminal command is preferred');
  assert.equal(terminal?.command, `${join(home, 'providers', 'acp-registry', 'agents', 'signer', '1.0.0', 'dist', 'agent')} --login`);
  const state = JSON.parse(readFileSync(join(home, 'providers', 'acp-registry', 'state.json'), 'utf8')) as { agents: Record<string, { authMethods: unknown[] }> };
  assert.equal(state.agents.signer?.authMethods.length, 4, 'kept for the next boot');

  answer = Promise.reject(new Error('boom'));
  (answer as Promise<unknown>).catch(() => undefined);
  await assert.rejects(() => service.authMethods('signer'), (e: unknown) => e instanceof AcpRegistryError && e.code === 'inspect-failed');
  await assert.rejects(() => service.authMethods('nobody'), (e: unknown) => e instanceof AcpRegistryError && e.code === 'not-installed');
  service.dispose();
});

test('sign-in: an agent that does not answer at install is still installed, without methods', { skip: !posix }, async () => {
  const archive = tarOf('#!/bin/sh\n');
  const served: Served = new Map([
    [REGISTRY_URL, registryDoc([agentEntry({ id: 'mute', archive: 'https://downloads.example.com/m.tar.gz', sha256: sha(archive) })])],
    ['https://downloads.example.com/m.tar.gz', archive],
  ]);
  const { service } = newService(served, { inspect: async () => { throw new Error('no handshake'); } });
  try {
    const view = await service.install('mute');
    assert.equal(view.installed?.state, 'ok');
  } finally { service.dispose(); }
});
