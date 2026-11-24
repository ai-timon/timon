/**
 * Tests of the "in force" values shown by the series planner.
 *
 * What matters here: a fallback rule that was SET must be the one read in
 * the form. That was the whole problem: "keep the global fallback" did not
 * say what was kept, so the choice was made from memory.
 *
 * TIMON_HOME is redirected to a throwaway folder BEFORE the import: the
 * db → agent → projects chain reads the env on load.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeHomeOnExit } from '../tests/helpers/test-home.js';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-series-defaults-test-'));
process.env.TIMON_HOME = TMP_HOME;
removeHomeOnExit(TMP_HOME);

const { seriesPlanDefaults } = await import('./series-plan-defaults.js');
const { dbApi } = await import('./db.js');

function mission(id: string): string {
  dbApi.createMission(id, 'test.agent', 'test plan de série'); // french-ok: free-text sample data
  return id;
}

{
  const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
  // A fallback goes only to a CLI that is on this host and signed in: stand-ins, never the machine's own.
  await stubCliBinaries('claude', 'codex');
  await stubCodexSignIn();
  await mountOfficialProviders();
}

test('the series fallback that was set is the one shown', () => {
  const id = mission('m-series-defaults-1');
  dbApi.setSeriesFallback(id, 'code', 'codex', 'gpt-5.6-sol');
  const defaults = seriesPlanDefaults(id, 'test.agent');
  assert.equal(defaults.code?.fallback, 'codex / gpt-5.6-sol');
});

test('the `*` wildcard covers the roles without a rule of their own, never the orchestrator', () => {
  const id = mission('m-series-defaults-2');
  dbApi.setSeriesFallback(id, '*', 'codex', 'gpt-5.6-luna');
  const defaults = seriesPlanDefaults(id, 'test.agent');
  assert.equal(defaults.doc?.fallback, 'codex / gpt-5.6-luna');
  // The orchestrator takes all the alerts of the work: the small model
  // chosen for the reviews must not be applied to it by ricochet.
  assert.notEqual(defaults.orchestrator?.fallback, 'codex / gpt-5.6-luna');
});

test('each role announces a current model, backend and slug', () => {
  const id = mission('m-series-defaults-3');
  const defaults = seriesPlanDefaults(id, 'test.agent');
  for (const role of ['orchestrator', 'mission', 'code', 'doc'] as const) {
    assert.match(String(defaults[role]?.model), /^[a-z0-9-]+ \/ .+$/);
  }
});

test('an unknown mission does not make the resolution fail', () => {
  // The form must open even if the resolution has nothing to say: a
  // missing decision aid degrades, an exception deprives the user of the choice.
  assert.doesNotThrow(() => seriesPlanDefaults('mission-qui-n-existe-pas', 'test.agent'));
});

test('a role choice already set for the series is the one shown', () => {
  const id = mission('m-series-defaults-roles');
  dbApi.setSeriesRole(id, 'review', 'codex', 'gpt-5.6-sol');
  const defaults = seriesPlanDefaults(id, 'test.agent');
  assert.equal(defaults.review?.model, 'codex / gpt-5.6-sol');
  // Other roles of the same series keep their project/agent default.
  assert.notEqual(defaults.merge?.model, 'codex / gpt-5.6-sol');
});

test("code/review/merge announce the model of the agent that runs them, not the orchestrator's", async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { agentDir } = await import('./paths.js');
  const write = (name: string, config: Record<string, unknown>) => {
    mkdirSync(agentDir(name), { recursive: true });
    writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd: TMP_HOME, project: 'defproj', ...config }));
  };
  write('defproj.main', { role: 'orchestrator', model: 'claude-sonnet-5-5' });
  write('defproj.coder', { role: 'coder', backend: 'claude', model: 'opus' });
  write('defproj.reviewer', { role: 'reviewer', backend: 'codex', model: 'gpt-5.6-sol' });
  const id = mission('m-series-defaults-role-agent');
  const defaults = seriesPlanDefaults(id, 'defproj.main');
  assert.equal(defaults.code?.model, 'claude / opus');
  assert.equal(defaults.review?.model, 'codex / gpt-5.6-sol');
  // The orchestrator keeps its own.
  assert.match(String(defaults.orchestrator?.model), /claude-sonnet-5-5/);
});
