/**
 * Automatic mission titles (TODO #358): a database written before the feature
 * holds thousands of conversations with no title. None of them gets a one-shot
 * when resumed — no backfill was decided (quota), and the generation belongs
 * to the first turn, which they have all had. The migration that adds
 * `title_generation` marks them claimed at once; an existing title is `manual`.
 *
 * `npm test -- src/mission-titles-migration.test.ts`
 */
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// french-ok-file: French sample prompts and titles the test feeds in

const home = mkdtempSync(join(tmpdir(), 'timon-mission-titles-migration-'));
process.env.TIMON_HOME = home;

// A pre-#358 database: `missions` with a `title`, no `title_source`, no `title_generation`.
{
  const legacy = new Database(join(home, 'timon.db'));
  legacy.exec(`
    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      mission TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      exit_code INTEGER,
      source_channel TEXT,
      source_meta TEXT,
      total_cost_usd REAL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      title TEXT
    );
    INSERT INTO missions (id, agent_name, mission, status, started_at, title)
      VALUES ('m-untitled', 'timon.main', 'Relis le README', 'completed', 1, NULL),
             ('m-named', 'timon.main', 'Corrige le login', 'completed', 1, 'Login'),
             ('m-blank', 'timon.main', 'Déploie la doc', 'completed', 1, '   ');
  `);
  legacy.close();
}

const { dbApi } = await import('./db.js');
const { generateMissionTitle } = await import('./mission-titles.js');

test('every mission that predates the column is marked claimed: no backfill', () => {
  for (const id of ['m-untitled', 'm-named', 'm-blank']) {
    assert.equal(dbApi.getMission(id)?.title_generation, 1, id);
  }
  // A title typed before the column is the user's: `manual`. Blank is no title.
  assert.deepEqual([dbApi.getMission('m-named')?.title, dbApi.getMission('m-named')?.title_source], ['Login', 'manual']);
  assert.equal(dbApi.getMission('m-blank')?.title_source, null);
});

test('resuming an old conversation never pays a one-shot', async () => {
  let calls = 0;
  const oneShot = async () => { calls += 1; return 'Relecture du README'; };
  assert.equal(await generateMissionTitle('m-untitled', { resolveLlm: () => ({ backend: 'claude', model: 'haiku' }), oneShot }), 'skipped');
  assert.equal(calls, 0);
  assert.equal(dbApi.getMission('m-untitled')?.title, null);
  assert.equal(dbApi.claimMissionTitleGeneration('m-untitled'), false, 'already claimed by the migration');
});

test('a mission created after the migration starts unclaimed', () => {
  dbApi.createMission('m-new', 'timon.main', 'Nouvelle conversation');
  assert.equal(dbApi.getMission('m-new')?.title_generation, 0);
});
