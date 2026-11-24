/**
 * Backend switch on an exhausted quota, and identity of Kanban series.
 *
 * What is checked here is what was missing on 2026-08-20: a backend running dry
 * must become a KNOWN STATE of the system (otherwise each spawn hits the
 * wall again), and a work must keep a stable identity when its pilot changes
 * (otherwise one no longer knows which tasks to move, nor where to deliver the returns).
 *
 * The database is opened in a temporary TIMON_HOME: the imports are therefore
 * dynamic, AFTER the environment is set.
 *
 * `node --test --import tsx src/backend-fallback.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-fallback-test-'));
process.env.TIMON_FALLBACK_ENABLED = '1';
process.env.TIMON_FALLBACK_BACKEND = 'codex';
process.env.TIMON_FALLBACK_MODEL = '';
process.env.TIMON_FALLBACK_COOLDOWN_MS = '3600000';
// `ollama-cloud` only exists as a backend when its key is in the env (profile
// `requiredEnv`, cf. backends/registry.ts). The last test below relies on it,
// and passed only on a shell that happened to carry the real key: neither a
// mission nor CI does. A dummy value is enough, nothing is ever called.
process.env.OLLAMA_API_KEY ??= 'test-key';

const { dbApi } = await import('./db.js');
const { mountOfficialProviders, stubCliBinaries } = await import('../tests/helpers/official-providers.js');
await stubCliBinaries('grok');
await mountOfficialProviders();
const {
  noteBackendRateLimit,
  clearBackendCooldown,
  isBackendCoolingDown,
  fallbackFor,
  redirectIfExhausted,
  cooldownReason,
} = await import('./backend-fallback.js');
const { setBackendBinaryAvailabilityForTest } = await import('./backends/binary-check.js');
// The cascade skips a backend whose CLI is missing: these tests must not
// depend on the CLIs installed on the machine that runs them.
setBackendBinaryAvailabilityForTest(() => true);

const hit = (
  over: Partial<{
    kind: 'rate_limit' | 'exhausted';
    window: string | null;
    resetsAt: number | null;
    source: 'event' | 'status' | 'text';
    pending: boolean;
  }> = {},
) => ({
  kind: 'rate_limit' as const,
  window: 'five_hour',
  resetsAt: null,
  source: 'event' as const,
  pending: false,
  ...over,
});

test('an exhausted balance (402) sets the backend aside longer than a quota, and the next 429 does not shorten it', () => {
  clearBackendCooldown('grok');
  const quotaWindow = Date.now() + 3600_000;

  noteBackendRateLimit('grok', hit({ kind: 'exhausted', window: null, source: 'status' }));
  const dry = dbApi.getBackendCooldown('grok');
  assert.equal(dry?.kind, 'exhausted');
  assert.equal(isBackendCoolingDown('grok'), true);
  // The "no credit" cooldown has its own duration (24 h by default), well
  // beyond the quota window configured here at 1 h.
  assert.ok((dry?.until ?? 0) > quotaWindow);

  // A later 429, even with the exact time of the provider, does not bring
  // an account running dry back into rotation: nothing was recharged.
  noteBackendRateLimit('grok', hit({ resetsAt: quotaWindow }));
  assert.equal(dbApi.getBackendCooldown('grok')?.until, dry?.until);
  assert.equal(dbApi.getBackendCooldown('grok')?.kind, 'exhausted');

  // Only a turn that succeeds lifts the exclusion: empirical proof of the recharge.
  clearBackendCooldown('grok');
  assert.equal(isBackendCoolingDown('grok'), false);
});

test('an exhausted quota sets the backend aside, a successful turn brings it back', () => {
  clearBackendCooldown('claude');
  assert.equal(isBackendCoolingDown('claude'), false);

  noteBackendRateLimit('claude', hit());
  assert.equal(isBackendCoolingDown('claude'), true);

  clearBackendCooldown('claude');
  assert.equal(isBackendCoolingDown('claude'), false);
});

test("the provider's reopening time prevails, and a running cooldown is never shortened", () => {
  clearBackendCooldown('claude');
  const far = Date.now() + 4 * 60 * 60 * 1000;
  noteBackendRateLimit('claude', hit({ resetsAt: far }));
  assert.equal(dbApi.getBackendCooldown('claude')?.until, far);

  // A second hit announcing earlier must not restart the missions against the
  // wall before the latest known time.
  noteBackendRateLimit('claude', hit({ resetsAt: Date.now() + 60_000 }));
  assert.equal(dbApi.getBackendCooldown('claude')?.until, far);
  clearBackendCooldown('claude');
});

test('an estimate does not extend the exact time announced by the provider', () => {
  clearBackendCooldown('claude');
  // The scenario of 2026-08-22: the `five_hour` event announces 04:40, then the 429s
  // that follow have no timestamp any more. The "now + cooldown" estimate
  // (1 h in this test) falls AFTER 04:40 and overwrote it on each 429: the
  // backend stayed set aside for hours after its real reopening.
  const exact = Date.now() + 20 * 60 * 1000;
  noteBackendRateLimit('claude', hit({ resetsAt: exact }));
  assert.equal(dbApi.getBackendCooldown('claude')?.until, exact);

  noteBackendRateLimit('claude', hit({ resetsAt: null, source: 'status' }));
  assert.equal(
    dbApi.getBackendCooldown('claude')?.until,
    exact,
    "l'estimation ne doit pas repousser l'heure exacte",
  );
  clearBackendCooldown('claude');
});

test('an exact time corrects an estimate, even to shorten it', () => {
  clearBackendCooldown('claude');
  noteBackendRateLimit('claude', hit({ resetsAt: null, source: 'status' }));
  const estimated = dbApi.getBackendCooldown('claude')!.until;

  // The provider ends up announcing a reopening CLOSER than our
  // estimate: doing without the backend until the estimate would be absurd.
  const exact = Date.now() + 5 * 60 * 1000;
  assert.ok(exact < estimated);
  noteBackendRateLimit('claude', hit({ resetsAt: exact }));
  assert.equal(dbApi.getBackendCooldown('claude')?.until, exact);
  assert.equal(dbApi.getBackendCooldown('claude')?.exact, 1);
  clearBackendCooldown('claude');
});

test('a stale cooldown is purged on read', () => {
  dbApi.setBackendCooldown('claude', Date.now() - 1_000, 'five_hour');
  assert.equal(isBackendCoolingDown('claude'), false);
  assert.equal(dbApi.getBackendCooldown('claude'), undefined);
});

test('a queued request does not count as an exhausted quota', () => {
  clearBackendCooldown('claude');
  // `pending` = the turn can still succeed: setting the backend aside would be premature.
  noteBackendRateLimit('claude', hit({ pending: true }));
  assert.equal(isBackendCoolingDown('claude'), false);
});

test('the fallback does not stand in for itself, nor for a backend that has quota', () => {
  clearBackendCooldown('claude');
  clearBackendCooldown('codex');
  // Fleeing codex to go to codex makes no sense: the fixed setting nevertheless
  // points at codex, so the cascade must rule it out and offer something else.
  clearBackendCooldown('grok');
  assert.notEqual(fallbackFor('codex')?.backend, 'codex');
  // Intact backend: nothing to redirect.
  assert.equal(redirectIfExhausted('claude'), null);

  noteBackendRateLimit('claude', hit());
  assert.deepEqual(redirectIfExhausted('claude')?.backend, 'codex');

  // Fallback itself running dry: go down one step in the cascade rather than
  // give up; there may still be a backend with quota.
  noteBackendRateLimit('codex', hit());
  clearBackendCooldown('grok');
  assert.equal(redirectIfExhausted('claude')?.backend, 'grok');

  // NO practicable backend left: only then, promise nothing. Switching
  // from one wall to another would only move the failure.
  noteBackendRateLimit('grok', hit());
  assert.equal(redirectIfExhausted('claude'), null);
  clearBackendCooldown('claude');
  clearBackendCooldown('codex');
  clearBackendCooldown('grok');
});

test('a series keeps its identity when its pilot changes from one mission to the next', () => {
  const pilot1 = randomUUID();
  const pilot2 = randomUUID();
  const t1 = randomUUID();
  const t2 = randomUUID();

  dbApi.createTask(t1, 'volet 1', 'a.coder', { creatorMissionId: pilot1, type: 'code' });
  dbApi.createTask(t2, 'volet 2', 'a.coder', { creatorMissionId: pilot1, type: 'code' });

  const seriesId = dbApi.getTask(t1)?.series_id;
  assert.equal(seriesId, pilot1, 'the series takes the identity of its first pilot mission');
  assert.equal(dbApi.getTask(t2)?.series_id, seriesId, 'same pilot → same series');

  // The pilot changes (backend switch, or a wake mission taking over the
  // helm): the non-terminal tasks follow, the identity of the series does not move.
  const moved = dbApi.remapSeriesOrchestratorMission(seriesId!, pilot1, pilot2);
  assert.equal(moved, 2);
  assert.equal(dbApi.getTask(t1)?.creator_mission_id, pilot2);
  assert.equal(dbApi.getTask(t1)?.series_id, seriesId);
  assert.equal(dbApi.seriesIdForMission(pilot2), seriesId);

  // A task then created by the NEW pilot joins the same series; without
  // that, a work would split in two at each switch.
  const t3 = randomUUID();
  dbApi.createTask(t3, 'volet 3', 'a.coder', { creatorMissionId: pilot2, type: 'code' });
  assert.equal(dbApi.getTask(t3)?.series_id, seriesId);
});

test("a series's LLM switch spares the tasks in flight", () => {
  const pilot = randomUUID();
  const todo = randomUUID();
  const running = randomUUID();
  dbApi.createTask(todo, 'pas encore lancée', 'a.coder', { creatorMissionId: pilot, type: 'code' }); // french-ok: free-text sample data
  dbApi.createTask(running, 'en vol', 'a.coder', { creatorMissionId: pilot, type: 'code' });
  dbApi.setTaskStatusOnly(running, 'IN_PROGRESS');

  const changed = dbApi.setSeriesLlmOverride(pilot, 'code', 'codex', 'gpt-5.6-sol');
  assert.equal(changed, 1, 'only the PENDING task is repointed');
  assert.equal(dbApi.getTask(todo)?.backend_override, 'codex');
  // Cutting a running task would lose its work while it may still
  // have quota on its own backend.
  assert.equal(dbApi.getTask(running)?.backend_override, null);
});

test('the switch only touches the targeted type', () => {
  const pilot = randomUUID();
  const code = randomUUID();
  const review = randomUUID();
  dbApi.createTask(code, 'coder', 'a.coder', { creatorMissionId: pilot, type: 'code' });
  dbApi.createTask(review, 'relire', 'a.reviewer', { creatorMissionId: pilot, type: 'review' });

  dbApi.setSeriesLlmOverride(pilot, 'code', 'codex', 'gpt-5.6-sol');
  assert.equal(dbApi.getTask(code)?.model_override, 'gpt-5.6-sol');
  // A long work does not want the same fallback for its coder and for its
  // reviews: that is the whole point of the plan by scope.
  assert.equal(dbApi.getTask(review)?.backend_override, null);
});

test('the series plan wins over the global setting, scope by scope', () => {
  clearBackendCooldown('claude');
  const seriesId = randomUUID();
  // The global says codex; the series wants grok for its coder.
  dbApi.setSeriesFallback(seriesId, 'code', 'grok', 'grok-4.6');
  assert.deepEqual(fallbackFor('claude', { seriesId, scope: 'code' }), {
    backend: 'grok',
    model: 'grok-4.6',
  });
  // Scope not mentioned: the global still applies.
  assert.equal(fallbackFor('claude', { seriesId, scope: 'review' })?.backend, 'codex');
});

test("the '*' wildcard covers the types not mentioned, but never the orchestrator", () => {
  const seriesId = randomUUID();
  dbApi.setSeriesFallback(seriesId, '*', 'grok', 'grok-4.6');
  assert.equal(fallbackFor('claude', { seriesId, scope: 'review' })?.backend, 'grok');
  assert.equal(fallbackFor('claude', { seriesId, scope: 'doc' })?.backend, 'grok');
  // The fallback chosen for reviews (often a small model) does not suit
  // the one holding the plan of the work: it falls back on the global, not on '*'.
  assert.equal(fallbackFor('claude', { seriesId, scope: 'orchestrator' })?.backend, 'codex');
});

test('a rule without a backend is an explicit refusal to switch', () => {
  const seriesId = randomUUID();
  dbApi.setSeriesFallback(seriesId, 'code', null, null);
  // Distinct from "no rule": here we want it to stop rather than
  // carry on with a model that will produce code to redo.
  assert.equal(fallbackFor('claude', { seriesId, scope: 'code' }), null);
  assert.equal(fallbackFor('claude', { seriesId, scope: 'review' })?.backend, 'codex');
});

test('a plan pointing at a backend running dry goes down one step, it does not fail', () => {
  const seriesId = randomUUID();
  dbApi.setSeriesFallback(seriesId, 'code', 'grok', null);
  noteBackendRateLimit('grok', hit());
  clearBackendCooldown('codex');
  // "Otherwise" means otherwise: the orchestrator's decision is
  // inapplicable (its target has no quota left), so the equivalence takes
  // over. Returning null here stopped the work while a backend was
  // available.
  const target = fallbackFor('claude', { seriesId, scope: 'code' });
  assert.equal(target?.backend, 'codex');

  // An EXPLICIT refusal never cascades: it is a decision, not an
  // impediment.
  const refused = randomUUID();
  dbApi.setSeriesFallback(refused, 'code', null, null);
  assert.equal(fallbackFor('claude', { seriesId: refused, scope: 'code' }), null);
  clearBackendCooldown('grok');
});

test('the fallback set on ONE task wins over the series and the global setting', () => {
  const seriesId = randomUUID();
  dbApi.setSeriesFallback(seriesId, 'code', 'grok', 'grok-4.6');
  // The task wants codex/gpt-5.6-terra, the series says grok, the global says codex
  // (without a precise model): the EXPLICIT model of the task is what must
  // come out, not the one inferred from the series or the backend default.
  assert.deepEqual(
    fallbackFor('claude', { seriesId, scope: 'code' }, { backend: 'codex', model: 'gpt-5.6-terra' }),
    { backend: 'codex', model: 'gpt-5.6-terra' },
  );
});

test("the 'none' sentinel at task level is an explicit refusal, even if the series or the global offer a fallback", () => {
  const seriesId = randomUUID();
  dbApi.setSeriesFallback(seriesId, 'code', 'grok', 'grok-4.6');
  assert.equal(fallbackFor('claude', { seriesId, scope: 'code' }, { backend: 'none', model: null }), null);
  // Without a task override (backend null = "no opinion"), the series takes over again.
  assert.equal(fallbackFor('claude', { seriesId, scope: 'code' }, { backend: null, model: null })?.backend, 'grok');
});

test('the equivalence comes BEFORE the fixed setting: the original calibre is kept', () => {
  clearBackendCooldown('claude');
  clearBackendCooldown('codex');
  // TIMON_FALLBACK_BACKEND is 'codex' without a model: the fixed setting alone
  // would send a small haiku onto gpt-5.6-sol, the flagship of the account. The
  // matrix, consulted first, respects the original tier.
  const target = fallbackFor('claude', {
    seriesId: null,
    scope: 'orchestrator',
    fromModel: 'haiku',
  });
  assert.equal(target?.backend, 'codex');
  assert.equal(target?.model, 'gpt-5.6-luna', 'a small one must fall back on a small one');
  assert.notEqual(target?.model, 'gpt-5.6-sol');
});

test('the fixed setting stays the last resort when the equivalence finds nothing', async () => {
  const { invalidateSettingsCache } = await import('./settings.js');
  clearBackendCooldown('claude');
  // `ollama-cloud` is deliberately missing from FALLBACK_PRIORITY: the matrix
  // will NEVER pick it on its own (no catalogued models, too
  // uncertain for an automatic switch). Getting it therefore proves one did
  // go down to the fixed setting, and not through the equivalence.
  // The env wins over the database (see buildCache): it is what must move
  // here, `setSetting` alone would have no effect.
  process.env.TIMON_FALLBACK_BACKEND = 'ollama-cloud';
  invalidateSettingsCache();
  noteBackendRateLimit('codex', hit());
  noteBackendRateLimit('grok', hit());
  try {
    const target = fallbackFor('claude', undefined, undefined);
    assert.equal(target?.backend, 'ollama-cloud');
  } finally {
    process.env.TIMON_FALLBACK_BACKEND = 'codex';
    invalidateSettingsCache();
    clearBackendCooldown('codex');
    clearBackendCooldown('grok');
  }
});

test('no manual config anywhere: the equivalence matrix takes over, at an equal tier', async () => {
  const { invalidateSettingsCache } = await import('./settings.js');
  // Empty the env TOO: it overrides the database, and as long as it is 'codex' the
  // fixed setting answers; this test then passed without ever reaching the
  // matrix it claims to check.
  delete process.env.TIMON_FALLBACK_BACKEND;
  invalidateSettingsCache();
  try {
    clearBackendCooldown('codex');
    clearBackendCooldown('grok');
    // opus (claude flagship) → a flagship elsewhere, never a small model.
    const target = fallbackFor('claude', { seriesId: null, scope: 'orchestrator', fromModel: 'opus' });
    assert.ok(target, 'an automatic fallback must be found');
    assert.notEqual(target?.backend, 'claude');
    assert.equal(target?.model, 'gpt-5.6-sol', 'a flagship must fall back on a flagship');
  } finally {
    process.env.TIMON_FALLBACK_BACKEND = 'codex';
    invalidateSettingsCache();
  }
});

test('the pilot only moves if the orchestrator is targeted or if ITS backend is running dry', async () => {
  const { pilotIsGoverned } = await import('./backend-fallback.js');
  // Automatic path (no scope): codex dry on the reviews, pilot on claude.
  assert.equal(pilotIsGoverned(undefined, false), false);
  assert.equal(pilotIsGoverned(undefined, true), true, 'its own backend is running dry: it leaves');
  assert.equal(pilotIsGoverned('code', false), false);
  assert.equal(pilotIsGoverned('code', true), true);
  assert.equal(pilotIsGoverned('orchestrator', false), true, 'a rule set for it moves it');
});

test('codex dry on a task: the tasks switch, the pilot left on claude does not move', async () => {
  const { switchSeriesToFallback } = await import('./backend-fallback.js');
  const pilot = randomUUID();
  dbApi.createMission(pilot, 'a.main', 'pilote');
  dbApi.setMissionLlmOverrides(pilot, 'claude', 'claude-opus-5-5');
  const review = randomUUID();
  dbApi.createTask(review, 'relire', 'a.reviewer', {
    creatorMissionId: pilot, type: 'review', backendOverride: 'codex', modelOverride: 'gpt-5.6-sol',
  });
  const seriesId = dbApi.seriesIdForMission(pilot)!;
  clearBackendCooldown('claude');
  clearBackendCooldown('grok');
  noteBackendRateLimit('codex', hit());
  try {
    await switchSeriesToFallback(seriesId, { pilotMissionId: pilot, reason: 'codex à sec' }); // french-ok: free-text sample data
    assert.equal(dbApi.getMission(pilot)?.backend_override, 'claude', 'the pilot keeps its backend');
    assert.equal(dbApi.getMission(pilot)?.model_override, 'claude-opus-5-5');
    assert.notEqual(dbApi.getTask(review)?.backend_override, 'codex', 'the task, for its part, leaves the backend running dry');
  } finally {
    clearBackendCooldown('codex');
  }
});

test('a fallback target whose CLI is not on this machine is skipped (spawn claude ENOENT, 2026-10-18)', () => {
  clearBackendCooldown('claude');
  clearBackendCooldown('codex');
  clearBackendCooldown('grok');
  noteBackendRateLimit('codex', hit());
  setBackendBinaryAvailabilityForTest((b) => b === 'codex');
  try {
    assert.equal(redirectIfExhausted('codex'), null, 'no installed fallback: nothing promised');
  } finally {
    setBackendBinaryAvailabilityForTest(() => true);
    clearBackendCooldown('codex');
  }
});

test('only a reported limit is called a quota; a breaker cooldown is named as such (TIM-0111)', () => {
  clearBackendCooldown('codex');
  try {
    noteBackendRateLimit('codex', hit());
    assert.equal(cooldownReason('codex'), 'out of quota');
    dbApi.setBackendCooldown('codex', Date.now() + 1_800_000, 'circuit breaker', false, 'unavailable');
    assert.match(cooldownReason('codex'), /^sidelined by the circuit breaker until .+, no quota measured$/);
    dbApi.setBackendCooldown('codex', Date.now() + 1_800_000, 'authentication failed', false, 'unavailable');
    assert.match(cooldownReason('codex'), /^sidelined after an authentication failure until /);
  } finally {
    clearBackendCooldown('codex');
  }
});

test('a fallback target that is installed but signed out is skipped: one signed-in provider means no fallback (rc.8, 20/10/2026)', async () => {
  const { setProviderSignInForTest, resetProviderSignInForTest } = await import('./backends/sign-in-state.js');
  clearBackendCooldown('claude');
  clearBackendCooldown('codex');
  clearBackendCooldown('grok');
  noteBackendRateLimit('codex', hit());
  // claude and grok are on the machine, nobody signed in to them.
  setProviderSignInForTest('claude', false);
  setProviderSignInForTest('grok', false);
  try {
    assert.equal(redirectIfExhausted('codex'), null, 'no signed-in fallback: nothing promised');
    assert.equal(fallbackFor('codex', { seriesId: null, scope: 'code', fromModel: 'gpt-5.6-sol' }), null);
    // Unknown is not signed out: a provider that cannot tell stays a candidate.
    setProviderSignInForTest('claude', null);
    assert.equal(fallbackFor('codex', { seriesId: null, scope: 'code', fromModel: 'gpt-5.6-sol' })?.backend, 'claude');
  } finally {
    resetProviderSignInForTest();
    clearBackendCooldown('codex');
  }
});
