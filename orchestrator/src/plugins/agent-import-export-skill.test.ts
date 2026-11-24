/**
 * The `timon-export` skill (plugins/agent-import/skills/timon-export/SKILL.md):
 * what another agent tool writes by following it must pass the engine as
 * shipped (`lib/index.js`). The example manifest of the skill is read from
 * the skill itself, so the text and the schema cannot drift apart unseen.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeZip } from '../../../plugins/agent-import/test/zip-writer.js';

type Manifest = {
  source: { app: string };
  agents: Array<Record<string, unknown> & { key: string; routines?: Array<Record<string, unknown>> }>;
  groups?: Array<{ members: string[] }>;
};
const lib = await import('../../../plugins/agent-import/lib/index.js') as {
  parseManifest(value: unknown): Manifest;
  readManifestFromZip(path: string): Promise<Manifest>;
  MANIFEST_FILE: string;
};

// A Windows checkout may turn the line endings into CRLF: the skill is read as LF.
const SKILL = readFileSync(fileURLToPath(new URL('../../../plugins/agent-import/skills/timon-export/SKILL.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const MARKER = '<!-- timon-export:example -->';

function example(): unknown {
  const at = SKILL.indexOf(MARKER);
  assert.ok(at >= 0, 'the skill marks its example manifest');
  const block = /```json\n([\s\S]*?)\n```/.exec(SKILL.slice(at));
  assert.ok(block, 'a json block follows the marker');
  return JSON.parse(block[1]!) as unknown;
}

const dir = mkdtempSync(join(tmpdir(), 'agent-import-export-skill-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('the skill is an Agent Skill named timon-export, with a description', () => {
  const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(SKILL);
  assert.ok(front, 'front matter with name and description first');
  assert.equal(front[1], 'timon-export');
  assert.ok(front[2]!.length > 40 && front[2]!.length <= 1024);
});

test('the example manifest of the skill passes the engine, as a zip too', async () => {
  const value = example();
  const parsed = lib.parseManifest(value);
  const file = join(dir, 'timon-agents-grok-bot-2026-11-03.zip');
  writeFileSync(file, forgeZip([{ name: lib.MANIFEST_FILE, data: JSON.stringify(value) }]));
  assert.deepEqual(await lib.readManifestFromZip(file), parsed);
});

test('the example shows every object the skill asks for', () => {
  const m = lib.parseManifest(example());
  const [ada] = m.agents;
  assert.ok(ada);
  for (const field of ['docs', 'memories', 'skills', 'routines', 'mcpServers', 'avatar', 'hints']) {
    assert.ok(ada[field], `the example agent has ${field}`);
  }
  const hints = ada.hints as { secretNames?: string[] };
  assert.ok(hints.secretNames?.length, 'secret names in hints');
  const servers = ada.mcpServers as Array<{ secretNames?: string[] }>;
  assert.ok(servers.some((s) => s.secretNames?.length), 'secret names on an MCP server');
  assert.ok(m.groups?.[0]?.members.every((key) => m.agents.some((a) => a.key === key)), 'group members are agents of the manifest');
});

test('every schedule the skill lists is one the engine takes', () => {
  const base = example() as Manifest;
  const schedules = [...SKILL.matchAll(/^\| `(\{ "kind": [^`]+\})` \|/gm)].map((m) => JSON.parse(m[1]!) as { kind: string });
  assert.deepEqual(schedules.map((s) => s.kind), ['cron', 'interval', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'once']);
  for (const schedule of schedules) {
    const manifest = structuredClone(base);
    manifest.agents[0]!.routines = [{ name: 'Try', instruction: 'Do it.', schedule, timezone: null, enabledInSource: true }];
    assert.doesNotThrow(() => lib.parseManifest(manifest), schedule.kind);
  }
});

test('the skill names the source apps the Hermes direct import uses', () => {
  // Same app and sourceRef as the Hermes card: importing both ways updates one agent.
  assert.match(SKILL, /`hermes` \| `grok-bot`/);
  assert.match(SKILL, /`profile:<profile name>`/);
});

test('the skill tells the active Hermes folder from the root, as Hermes resolves them', () => {
  // Run from a named profile, HERMES_HOME is `<root>/profiles/<name>`: taking it for the
  // root would miss the other profiles and key that profile as `profile:default`.
  assert.match(SKILL, /\*\*active folder\*\*/);
  assert.match(SKILL, /\*\*root\*\*/);
  assert.match(SKILL, /`<folder>\/profiles\/<name>`:\s+`<folder>`/);
  assert.match(SKILL, /you are `work`, not `default`/);
  assert.doesNotMatch(SKILL, /The home itself is the profile `default`/);
});

test('the skill never names another product\'s export format', () => {
  assert.doesNotMatch(SKILL, /openbot/i);
});
// That `lib/index.js` serves this very text is checked by the `export-skill` route test.

