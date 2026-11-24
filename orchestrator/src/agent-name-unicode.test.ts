/**
 * Agent names in any script: Chinese, Cyrillic, Arabic, Hebrew, accented
 * Latin. The name is still the agent's folder, so what one supported file
 * system cannot hold as a plain segment is refused, and two spellings that a
 * disk would merge (case, Unicode normalisation) are one agent.
 */
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

// french-ok-file: Unicode agent names are what this test is about
const HOME = mkdtempSync(join(tmpdir(), 'timon-agent-name-unicode-'));
process.env.TIMON_HOME = HOME;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
process.env.TIMON_AGENT_TRASH_ENABLED = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

await import('../tests/helpers/claude-provider.js');
const {
  deleteAgent, getAgent, listAgents, readDoc, readMemory, renameAgent, restoreAgent, upsertAgent, writeDoc, writeMemory,
} = await import('./agent.js');
const { canonicalAgentName, findAgentFolder, resolveAgentFolder } = await import('./agent-config.js');
const { AGENT_NAME_MAX_BYTES, isValidAgentName, toAgentName } = await import('./agent-name.js');
const { listAgentTrash } = await import('./agent-trash.js');
const { AGENTS_DIR, agentDir } = await import('./paths.js');
const { isFenceAgent } = await import('./host/isolation.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes } = await import('./plugins-bundled/agents/routes.js');

const WITNESS = join(HOME, 'witness.txt');
writeFileSync(WITNESS, 'still here');
upsertAgent({ name: 'bystander', system_prompt: 'p', config: { role: 'coder' } });

function homeIntact(): void {
  assert.equal(existsSync(WITNESS), true, 'the home root was not touched');
  assert.equal(existsSync(agentDir('bystander')), true, 'the other agents are still there');
}

const nfd = (s: string): string => s.normalize('NFD');

test('names in every script are accepted', () => {
  for (const name of ['马斯克', '東京', 'Нова', 'مرحبا', 'שלום', 'José', 'Zoë', 'नमस्ते', '_main', 'foo.bar', 'TIMON.main', 'x..y', '9lives']) {
    assert.equal(isValidAgentName(name), true, name);
  }
});

test('what a folder or a shell cannot hold is refused', () => {
  const refused = [
    '', '.', '..', '...', '.hidden', '-x', 'foo.', 'a/b', 'a\\b', 'a b', '😀', 'a😀', '‮abc', 'a‮b', 'a\u0000b', 'a​b',
    'CON', 'con', 'nul.txt', 'NUL.tar.gz', 'COM1', 'lpt9', 'com¹', 'aux',
    '́a', // a combining mark first combines with nothing
    nfd('José'), // only NFC is stored; the routes normalise first
  ];
  for (const name of refused) assert.equal(isValidAgentName(name), false, JSON.stringify(name));
  // Not reserved: a device name inside a longer word.
  for (const name of ['console', 'CONx', 'com10', 'nul-agent', 'a.con']) assert.equal(isValidAgentName(name), true, name);
});

test('the limit is 80 bytes of UTF-8, not 80 characters', () => {
  assert.equal(AGENT_NAME_MAX_BYTES, 80);
  assert.equal(isValidAgentName('马'.repeat(26)), true, '26 Chinese characters are 78 bytes');
  assert.equal(isValidAgentName('马'.repeat(27)), false, '27 are 81 bytes');
  assert.equal(isValidAgentName('a'.repeat(80)), true);
  assert.equal(isValidAgentName('a'.repeat(81)), false);
});

test('toAgentName keeps every script and is never empty', () => {
  assert.equal(toAgentName('马斯克'), '马斯克');
  assert.equal(toAgentName('Nova 马斯克'), 'Nova-马斯克');
  assert.equal(toAgentName('  Éléa  '), 'Éléa');
  assert.equal(toAgentName(nfd('José')), 'José', 'composed');
  assert.equal(toAgentName('Nova, mon assistante'), 'Nova-mon-assistante');
  assert.equal(toAgentName('😀'), 'agent');
  assert.equal(toAgentName('***'), 'agent');
  assert.equal(toAgentName(''), 'agent');
  assert.equal(toAgentName('CON'), 'agent', 'a Windows device name is not a folder');
  assert.equal(toAgentName('-.x.'), 'x');
  const long = toAgentName('马'.repeat(40));
  assert.equal(long, '马'.repeat(26), 'cut at 80 bytes, between characters');
  for (const raw of ['马斯克', 'a b c', '...', '‮', 'é'.repeat(50), 'Zoë 😀 2']) assert.equal(isValidAgentName(toAgentName(raw)), true, raw);
});

test('a decomposed name designates the composed agent, and creating it again is refused', () => {
  upsertAgent({ name: 'José', system_prompt: 'p', config: { role: 'coder' } });
  assert.equal(findAgentFolder(nfd('José')), 'José');
  assert.equal(canonicalAgentName(nfd('José')), 'José');
  assert.throws(() => upsertAgent({ name: 'josé', system_prompt: 'p' }), /already exists/);
  assert.equal(readdirSync(AGENTS_DIR).filter((e) => e.normalize('NFC').toLowerCase() === 'josé').length, 1, 'one folder');
});

test('`Foo` then `foo` is refused, the first agent stays as it was', () => {
  upsertAgent({ name: 'Foo', system_prompt: 'first', config: { role: 'coder' } });
  assert.throws(() => upsertAgent({ name: 'foo', system_prompt: 'second' }), /agent "Foo" already exists/);
  assert.equal(getAgent('Foo')?.system_prompt, 'first');
  upsertAgent({ name: 'Bar', system_prompt: 'p', config: { role: 'coder' } });
  assert.deepEqual(renameAgent('Bar', 'FOO'), { ok: false, error: 'agent "Foo" already exists' });
  assert.equal(renameAgent('Bar', 'bar').ok, true, 'an agent may change its own case');
  assert.equal(existsSync(agentDir('bar')), true);
});

test('the full life of a Chinese-named agent, the home intact', () => {
  const name = '马斯克';
  upsertAgent({ name, system_prompt: 'p', config: { role: 'coder' } });
  assert.ok(listAgents().some((a) => a.name === name), 'listed');
  writeDoc(name, 'SOUL.md', 'who I am');
  assert.equal(readDoc(name, 'SOUL.md'), 'who I am');
  writeMemory(name, 'notes.md', 'remember');
  assert.equal(readMemory(name, 'notes.md'), 'remember');

  assert.equal(deleteAgent(name), true);
  assert.equal(existsSync(agentDir(name)), false);
  const entry = listAgentTrash().find((e) => e.name === name);
  assert.ok(entry, 'in the trash');
  const restored = restoreAgent(entry.id);
  assert.equal(restored.ok, true);
  assert.equal(readMemory(name, 'notes.md'), 'remember', 'memory came back');

  assert.equal(renameAgent(name, '東京').ok, true);
  assert.equal(existsSync(agentDir(name)), false);
  assert.equal(readDoc('東京', 'SOUL.md'), 'who I am');
  assert.equal(deleteAgent('東京', { purge: true }), true);
  assert.equal(existsSync(agentDir('東京')), false);
  homeIntact();
});

test('a name resolves to the real folder entry, whatever the disk ignores', () => {
  // The entries a case- and normalisation-insensitive disk (Windows, APFS)
  // lists: there, `foo` and the decomposed `Zoë` exist as paths, yet the
  // folder is named otherwise, and the real entry is what must come back.
  const entries = ['Foo', 'Zoë', '马斯克'];
  assert.equal(resolveAgentFolder('foo', entries), 'Foo');
  assert.equal(resolveAgentFolder('FOO', entries), 'Foo');
  assert.equal(resolveAgentFolder(nfd('Zoë'), entries), 'Zoë');
  assert.equal(resolveAgentFolder(nfd('ZOË'), entries), 'Zoë');
  assert.equal(resolveAgentFolder('马斯克', entries), '马斯克');
  assert.equal(resolveAgentFolder('bar', entries), null);
  // Two legacy folders differing only by case on a case-sensitive disk each keep their name.
  assert.equal(resolveAgentFolder('foo', ['Foo', 'foo']), 'foo');
  assert.equal(resolveAgentFolder('Foo', ['foo', 'Foo']), 'Foo');
});

test('canonicalAgentName hands back the entry on disk, never the typed form', () => {
  upsertAgent({ name: 'Canon', system_prompt: 'p', config: { role: 'coder' } });
  upsertAgent({ name: 'Zoé', system_prompt: 'p', config: { role: 'coder' } });
  assert.equal(canonicalAgentName('canon'), 'Canon');
  assert.equal(canonicalAgentName(nfd('zoé')), 'Zoé');
  assert.equal(canonicalAgentName(nfd('Inconnu-é')), 'Inconnu-é', 'unknown: the name in NFC');
  assert.throws(() => canonicalAgentName('../x'), /invalid agent name/);
  assert.equal(deleteAgent('Canon', { purge: true }), true);
  assert.equal(deleteAgent('Zoé', { purge: true }), true);
});

test('the fence gives a Chinese-named agent and the daemon `_` agents their own folders', () => {
  for (const name of ['马斯克', 'Zoë', '_main', '_eph-1a2b3c', 'timon.coder']) assert.equal(isFenceAgent(name), true, name);
  for (const name of ['.agents', '.', '..', '-x', 'a/b', 'a\\b', '']) assert.equal(isFenceAgent(name), false, name);
});

test('the HTTP routes take a percent-encoded Chinese name, composed or not', async () => {
  const TOKEN = 'witness-daemon-token';
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: TOKEN, required: false }));
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  try {
    const created = await fetch(`${base}/api/agents`, { method: 'POST', headers: auth, body: JSON.stringify({ name: nfd('Zoë'), system_prompt: 'p', config: { role: 'coder' } }) });
    assert.equal(created.status, 200);
    assert.equal(((await created.json()) as { name: string }).name, 'Zoë', 'stored composed');
    assert.equal(existsSync(agentDir('Zoë')), true);

    const again = await fetch(`${base}/api/agents`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'ZOË', system_prompt: 'p' }) });
    assert.equal(again.status, 409);

    const read = await fetch(`${base}/api/agents/${encodeURIComponent(nfd('Zoë'))}`, { headers: auth });
    assert.equal(read.status, 200, 'a decomposed name in the path reads the agent');

    const renamed = await fetch(`${base}/api/agents/${encodeURIComponent('Zoë')}/rename`, { method: 'POST', headers: auth, body: JSON.stringify({ newName: '马斯克' }) });
    assert.equal(renamed.status, 200);
    const got = await fetch(`${base}/api/agents/${encodeURIComponent('马斯克')}`, { headers: auth });
    assert.equal(got.status, 200);
    assert.equal(((await got.json()) as { name: string }).name, '马斯克');

    for (const bad of ['CON', 'a b', '😀', 'foo.']) {
      const res = await fetch(`${base}/api/agents`, { method: 'POST', headers: auth, body: JSON.stringify({ name: bad, system_prompt: 'p' }) });
      assert.equal(res.status, 400, bad);
    }
    const del = await fetch(`${base}/api/agents/${encodeURIComponent('马斯克')}`, { method: 'DELETE', headers: auth });
    assert.equal(del.status, 200);
  } finally {
    server.close();
  }
  homeIntact();
});
