/**
 * Full-text search in the mission history.
 *
 * What is protected: before 2026-08-23, finding "the conversation where we
 * talked about X" required a manual LIKE in sqlite3 over 1.3 GB of payloads, without
 * any official tool. The traps of this implementation:
 *   - indexing the `tool_result`s (1 GB out of 1.3) would drown the relevance;
 *   - an OR query (the one of the memory recall) would return every mission that
 *     holds one of the words; a human typing two words expects an AND;
 *   - unsanitised punctuation makes the FTS5 parser fail with an
 *     SqliteError nobody can interpret;
 *   - a non-resumable backfill would only cover the missions after
 *     the deployment, returning zero without saying so.
 *
 * `node --test --import tsx src/mission-search.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// french-ok-file: French sample prompts and titles the test feeds in

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-search-test-'));

const { extractSearchFragments, toMissionFtsQuery, parseTimeBound } = await import('./mission-search.js');
const { dbApi, db } = await import('./db.js');

/* ── extraction ─────────────────────────────────────────────────────────── */

const assistantMsg = (blocks: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } });

test('an assistant text block is indexed', () => {
  const f = extractSearchFragments('assistant', assistantMsg([{ type: 'text', text: 'on a choisi FTS5' }]));
  assert.deepEqual(f, [{ role: 'assistant', text: 'on a choisi FTS5' }]);
});

test('thinking, tool_use et tool_result restent HORS index', () => {
  assert.deepEqual(
    extractSearchFragments('assistant', assistantMsg([
      { type: 'thinking', thinking: 'réflexion interne', signature: 'CAIS…' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ])),
    [],
  );
  assert.deepEqual(
    extractSearchFragments('user', {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'un dump de 200 ko' }] },
    }),
    [],
  );
});

test('a user message in raw text (string) is indexed', () => {
  const f = extractSearchFragments('user', { type: 'user', message: { role: 'user', content: 'relance le merge' } });
  assert.deepEqual(f, [{ role: 'user', text: 'relance le merge' }]);
});

test('a malformed payload does not throw: indexing must never break the write of the event', () => {
  for (const bad of [null, undefined, 42, 'texte', { message: null }, { message: { content: 7 } }]) {
    assert.deepEqual(extractSearchFragments('assistant', bad), []);
  }
  assert.deepEqual(extractSearchFragments('system', assistantMsg([{ type: 'text', text: 'x' }])), []);
});

test('a spoken GPT-Live turn is indexed under its speaker', () => {
  assert.deepEqual(
    extractSearchFragments('voice_transcript', { type: 'voice_transcript', role: 'user', text: 'on parle du planning' }),
    [{ role: 'user', text: 'on parle du planning' }],
  );
  assert.deepEqual(
    extractSearchFragments('voice_transcript', { type: 'voice_transcript', role: 'voice', text: 'Bien sûr.' }),
    [{ role: 'assistant', text: 'Bien sûr.' }],
  );
  assert.deepEqual(extractSearchFragments('voice_transcript', null), []);
});

/* ── FTS query ────────────────────────────────────────────────────────── */

test('two words = an AND, not an OR', () => {
  assert.equal(toMissionFtsQuery('fallback quota'), '"fallback" AND "quota"');
});

test('quotes delimit an exact phrase', () => {
  assert.equal(toMissionFtsQuery('"rate limit" worktree'), '"rate limit" AND "worktree"');
});

test('the * suffix stays an FTS5 prefix', () => {
  assert.equal(toMissionFtsQuery('worktree*'), '"worktree" *');
});

test('punctuation is neutralised instead of making the parser fail', () => {
  const q = toMissionFtsQuery('timon:task -- (merge)');
  assert.ok(q);
  assert.doesNotThrow(() => db.prepare(`SELECT 1 FROM mission_search_fts WHERE text MATCH ?`).all(q));
});

test('a query without a usable term returns null', () => {
  assert.equal(toMissionFtsQuery('   '), null);
  assert.equal(toMissionFtsQuery('--- !!'), null);
});

/* ── bornes temporelles ─────────────────────────────────────────────────── */

test('parseTimeBound understands relative, ISO and ms', () => {
  const now = Date.parse('2026-08-23T10:00:00Z');
  assert.equal(parseTimeBound('2d', now), now - 2 * 86_400_000);
  assert.equal(parseTimeBound('12h', now), now - 12 * 3_600_000);
  assert.equal(parseTimeBound('2026-08-01T00:00:00Z', now), Date.parse('2026-08-01T00:00:00Z'));
  assert.equal(parseTimeBound(String(now), now), now);
  assert.equal(parseTimeBound('', now), null);
  assert.equal(parseTimeBound('n’importe quoi', now), null);
});

/* ── end to end on the database ───────────────────────────────────────────── */

function seed(agent: string, prompt: string, texts: string[]): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, prompt);
  for (const t of texts) dbApi.insertEvent(id, 'assistant', assistantMsg([{ type: 'text', text: t }]));
  return id;
}

const m1 = seed('alpha.main', 'audit du fallback de quota', [
  'le backend à sec bascule sur son repli au lieu d’arrêter le chantier',
  JSON.stringify({ noise: 'x' }),
]);
const m2 = seed('beta.main', 'refonte du worktree de merge', [
  'la branche est intégrée depuis le worktree, jamais depuis l’arbre principal',
]);
// Noise: a large tool_result holding the searched word must NOT
// come up: that is precisely what is refused for indexing.
dbApi.insertEvent(m2, 'user', {
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'y', content: 'quota quota quota' }] },
});

test("the mission's initial prompt is searchable", () => {
  const hits = dbApi.searchMissions({ q: 'audit fallback' });
  assert.deepEqual(hits.map((h) => h.mission_id), [m1]);
  assert.equal(hits[0]?.role, 'prompt');
});

test('the text of an assistant turn is searchable, with excerpt and agent', () => {
  const hits = dbApi.searchMissions({ q: 'arbre principal' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.mission_id, m2);
  assert.equal(hits[0]?.agent_name, 'beta.main');
  assert.ok(hits[0]?.snippet.includes('principal'));
});

test('a tool_result is never a result, even if it holds the word', () => {
  const hits = dbApi.searchMissions({ q: 'quota' });
  assert.ok(hits.every((h) => h.mission_id === m1), 'only the mission that TALKS about it comes up');
});

test('a mission talking about the subject several times returns one hit per fragment', () => {
  // "worktree" is in the prompt of m2 AND in one of its assistant turns:
  // two distinct excerpts, each reopenable at its place.
  const hits = dbApi.searchMissions({ q: 'worktree' });
  assert.equal(hits.length, 2);
  assert.deepEqual(new Set(hits.map((h) => h.mission_id)), new Set([m2]));
  assert.deepEqual(new Set(hits.map((h) => h.role)), new Set(['prompt', 'assistant']));
});

test('the agent filter narrows without overriding the query', () => {
  assert.deepEqual(dbApi.searchMissions({ q: 'worktree', agents: ['alpha.main'] }), []);
  assert.equal(dbApi.searchMissions({ q: 'worktree', agents: ['beta.main'] }).length, 2);
  assert.deepEqual(dbApi.searchMissions({ q: 'worktree', agents: [] }), []);
});

test('time bounds filter on the date of the fragment', () => {
  const now = Date.now();
  assert.equal(dbApi.searchMissions({ q: 'worktree', since: now + 60_000 }).length, 0);
  assert.equal(dbApi.searchMissions({ q: 'worktree', until: now - 60_000 }).length, 0);
  assert.equal(dbApi.searchMissions({ q: 'worktree', since: now - 60_000 }).length, 2);
});

test('the backfill is idempotent: replaying it duplicates no result', () => {
  const before = dbApi.searchMissions({ q: 'worktree' }).length;
  assert.equal(before, 2);
  // cursor reset to zero = the whole history passed through the indexer again
  db.prepare(`UPDATE mission_search_state SET v = 0 WHERE k = 'event_cursor'`).run();
  let guard = 0;
  while (!dbApi.reindexMissionSearch(50).done && guard++ < 100) { /* boucle de rattrapage */ }
  assert.equal(dbApi.searchMissions({ q: 'worktree' }).length, before);
  assert.equal(dbApi.missionSearchProgress().done, true);
});

test('an event deleted from the index leaves no orphan fragment', () => {
  const id = seed('gamma.main', 'mission jetable', ['terme éphémère indexé']);
  assert.equal(dbApi.searchMissions({ q: 'éphémère' }).length, 1);
  db.prepare(`DELETE FROM mission_search WHERE mission_id = ?`).run(id);
  assert.equal(dbApi.searchMissions({ q: 'éphémère' }).length, 0);
});
