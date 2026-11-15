/**
 * The mascot look and the avatar mode on the MCP and the CLI: `agent_update`
 * and `timon agent update` send the same PATCH, `agent_list` returns the look,
 * and the tool's schema offers exactly the values the daemon accepts.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { cli, session, withDaemon } from '../tests/helpers/mcp-cli-parity.js';
import {
  AGENT_AVATAR_MODES, AGENT_LOOK_ACCESSORIES, AGENT_LOOK_COLORS, AGENT_LOOK_CUSTOM_COLOR_RE, AGENT_LOOK_EYES, AGENT_LOOK_SHAPES, MASCOT_PART_ID_RE,
} from './agent-look.js';

const LOOK = { shape: 'round', color: '#d4a373', eyes: 'happy', acc: 'coffee' };

/** A look field of the tool schema: a product value, or a pack's part whose form only the schema checks. */
type LookField = { anyOf: [{ enum: string[] }, { pattern: string }] };

test('agent_update look and timon agent update --look send the same PATCH', async () => {
  await withDaemon(async (base, seen) => {
    const run = await cli(base, ['agent', 'update', 'a.b', '--look', JSON.stringify(LOOK)], {}, '');
    assert.equal(run.code, 0, run.out);
    await session(base, [{ method: 'tools/call', params: { name: 'agent_update', arguments: { name: 'a.b', look: LOOK } } }]);
    const patches = seen.filter((s) => `${s.method} ${s.url}` === 'PATCH /api/agents/a.b/config');
    assert.equal(patches.length, 2, seen.map((s) => `${s.method} ${s.url}`).join(', '));
    for (const patch of patches) assert.deepEqual(patch.body, { look: LOOK });
  });
});

test('a mascot pack part goes through both transports as is: the daemon, not the schema, knows the packs', async () => {
  const packed = { ...LOOK, acc: 'acme-pack:cap', color: 'acme-pack:midnight' };
  await withDaemon(async (base, seen) => {
    const run = await cli(base, ['agent', 'update', 'a.b', '--look', JSON.stringify(packed)], {}, '');
    assert.equal(run.code, 0, run.out);
    await session(base, [{ method: 'tools/call', params: { name: 'agent_update', arguments: { name: 'a.b', look: packed } } }]);
    const patches = seen.filter((s) => s.method === 'PATCH');
    assert.equal(patches.length, 2);
    for (const patch of patches) assert.deepEqual(patch.body, { look: packed });
  });
});

test('null clears the look on both transports', async () => {
  await withDaemon(async (base, seen) => {
    const run = await cli(base, ['agent', 'update', 'a.b', '--look', 'null'], {}, '');
    assert.equal(run.code, 0, run.out);
    await session(base, [{ method: 'tools/call', params: { name: 'agent_update', arguments: { name: 'a.b', look: null } } }]);
    const patches = seen.filter((s) => s.method === 'PATCH');
    assert.equal(patches.length, 2);
    for (const patch of patches) assert.deepEqual(patch.body, { look: null });
  });
});

test('--look that is not JSON stops the CLI before any write', async () => {
  await withDaemon(async (base, seen) => {
    const run = await cli(base, ['agent', 'update', 'a.b', '--look', 'round']);
    assert.equal(run.code, 64);
    assert.match(run.out, /--look expects JSON/);
    assert.equal(seen.filter((s) => s.method === 'PATCH').length, 0);
  });
});

test('the daemon refusal reaches the caller unchanged', async () => {
  const error = 'look.acc: unknown value "sword" (expected one of none, loupe)';
  // The existence probe (GET) must pass for the write to be attempted at all.
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const refused = req.method === 'PATCH';
      res.writeHead(refused ? 400 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(refused ? { error } : { name: 'a.b' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const bad = { ...LOOK, acc: 'sword' };
    const run = await cli(base, ['agent', 'update', 'a.b', '--look', JSON.stringify(bad)], {}, '');
    assert.notEqual(run.code, 0);
    // The CLI prints the daemon's JSON body as it came, quotes escaped.
    assert.ok(run.out.includes(JSON.stringify({ error })), run.out);
    const [reply] = await session(base, [{ method: 'tools/call', params: { name: 'agent_update', arguments: { name: 'a.b', look: bad } } }]);
    assert.equal(reply!.result!.isError, true);
    assert.ok(reply!.result!.content![0]!.text.includes(error), reply!.result!.content![0]!.text);
  } finally { server.closeAllConnections(); server.close(); }
});

test('agent_list returns the look, null when the agent has none', async () => {
  await withDaemon(async (base) => {
    const [reply] = await session(base, [{ method: 'tools/call', params: { name: 'agent_list', arguments: {} } }]);
    const listed = JSON.parse(reply!.result!.content![0]!.text) as { agents: { name: string; look: unknown }[] };
    assert.deepEqual(listed.agents, [
      { name: 'a.b', role: 'coder', reports_to: null, orchestrator: false, icon_url: null, look: LOOK },
      { name: 'c.d', role: null, reports_to: null, orchestrator: false, icon_url: null, look: null },
    ]);
  }, {
    status: 200,
    body: {
      ok: true,
      agents: [
        { name: 'a.b', role: 'coder', reports_to: null, orchestrator: false, icon_url: null, look: LOOK },
        { name: 'c.d', role: null, reports_to: null, orchestrator: false, icon_url: null },
      ],
    },
  });
});

test('the agent_update and agent_create schemas offer exactly the values the daemon accepts', async () => {
  await withDaemon(async (base) => {
    const [list] = await session(base, [{ method: 'tools/list' }]);
    for (const name of ['agent_update', 'agent_create']) {
      const tool = list!.result!.tools!.find((t) => t.name === name)!;
      const look = tool.inputSchema.properties.look as { properties: Record<string, LookField> };
      assert.deepEqual(look.properties.shape!.anyOf[0]!.enum, [...AGENT_LOOK_SHAPES], name);
      assert.equal(look.properties.shape!.anyOf[1]!.pattern, MASCOT_PART_ID_RE.source, name);
      assert.deepEqual(look.properties.color!.anyOf[0]!.enum, [...AGENT_LOOK_COLORS], name);
      assert.equal(look.properties.color!.anyOf[1]!.pattern, MASCOT_PART_ID_RE.source, name);
      assert.equal(look.properties.color!.anyOf[2]!.pattern, AGENT_LOOK_CUSTOM_COLOR_RE.source, name);
      assert.deepEqual(look.properties.eyes!.anyOf[0]!.enum, [...AGENT_LOOK_EYES], name);
      assert.equal(look.properties.eyes!.anyOf[1]!.pattern, MASCOT_PART_ID_RE.source, name);
      assert.deepEqual(look.properties.acc!.anyOf[0]!.enum, [...AGENT_LOOK_ACCESSORIES], name);
      assert.equal(look.properties.acc!.anyOf[1]!.pattern, MASCOT_PART_ID_RE.source, name);
    }
  });
});

test('agent_update avatar and timon agent update --avatar send the same PATCH, null included', async () => {
  await withDaemon(async (base, seen) => {
    for (const [flag, value] of [['mascot', 'mascot'], ['null', null]] as const) {
      const run = await cli(base, ['agent', 'update', 'a.b', '--avatar', flag], {}, '');
      assert.equal(run.code, 0, run.out);
      await session(base, [{ method: 'tools/call', params: { name: 'agent_update', arguments: { name: 'a.b', avatar: value } } }]);
    }
    const patches = seen.filter((s) => `${s.method} ${s.url}` === 'PATCH /api/agents/a.b/config').map((s) => s.body);
    assert.deepEqual(patches, [{ avatar: 'mascot' }, { avatar: 'mascot' }, { avatar: null }, { avatar: null }]);
  });
});

test('the avatar schema of agent_update and agent_create offers the daemon modes and null', async () => {
  await withDaemon(async (base) => {
    const [list] = await session(base, [{ method: 'tools/list' }]);
    for (const name of ['agent_update', 'agent_create']) {
      const tool = list!.result!.tools!.find((t) => t.name === name)!;
      const avatar = tool.inputSchema.properties.avatar as { enum: (string | null)[] };
      assert.deepEqual(avatar.enum, [...AGENT_AVATAR_MODES, null], name);
    }
  });
});
