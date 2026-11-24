/**
 * Resource guard: profile logic.
 *
 * The systemd interaction is NOT tested here (it requires a live user
 * manager, so it does not run in CI) but the decisions that do go wrong
 * silently: which hour falls into which profile, and the fact that a "day" cap
 * can NEVER be more permissive than the night cap: a typo
 * in the settings must not raise a safety ceiling.
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The settings are read through the env (absolute priority over the database): they are set
// BEFORE importing the module, which caches the resolution on the first call.
process.env.TIMON_DAY_START_HOUR = '8';
process.env.TIMON_DAY_END_HOUR = '20';
process.env.TIMON_DAY_MAX_LIVE_MISSIONS = '4';
process.env.TIMON_DAY_MAX_PARALLEL = '2';
process.env.TIMON_MAX_LIVE_MISSIONS = '12';
process.env.TIMON_MAX_PARALLEL = '8';
process.env.TIMON_DAY_CPU_QUOTA_PCT = '400';
process.env.TIMON_NIGHT_CPU_QUOTA_PCT = '1600';

const {
  currentProfile,
  profileLimits,
  missionScopeUnit,
  wrapMissionLaunch,
  stopMissionScopes,
  listMissionScopes,
  systemctlCallCount,
  instancePrefix,
  missionScopePattern,
  grepaiWatcherUnit,
  LEGACY_MISSION_SCOPE_PATTERN,
} = await import('./resources.js');
const { setHasSystemdForTest, setSystemctlForTest } = await import('./host/systemd.js');

const at = (h: number) => new Date(2026, 7, 13, h, 0, 0);

test('the day window covers 8 a.m.–8 p.m., bounds included on the start side', () => {
  assert.equal(currentProfile(at(7)), 'night');
  assert.equal(currentProfile(at(8)), 'day');
  assert.equal(currentProfile(at(15)), 'day');
  assert.equal(currentProfile(at(19)), 'day');
  assert.equal(currentProfile(at(20)), 'night');
  assert.equal(currentProfile(at(3)), 'night');
});

test('the day profile throttles CPU and concurrency, the night relaxes', () => {
  const day = profileLimits(at(15));
  const night = profileLimits(at(3));
  assert.equal(day.cpuQuotaPct, 400);
  assert.equal(night.cpuQuotaPct, 1600);
  assert.equal(day.maxLive, 4);
  assert.equal(night.maxLive, 12);
  assert.equal(day.maxParallel, 2);
  assert.equal(night.maxParallel, 8);
});

test('a day cap above the global cap is clipped, never applied as is', async () => {
  // Scenario: day setting typed as 99 by mistake. The "discreet" profile must
  // by no means become more permissive than the global ceiling.
  process.env.TIMON_DAY_MAX_LIVE_MISSIONS = '99';
  const { invalidateSettingsCache } = await import('./settings.js');
  invalidateSettingsCache();
  assert.equal(profileLimits(at(15)).maxLive, 12);
  process.env.TIMON_DAY_MAX_LIVE_MISSIONS = '4';
  invalidateSettingsCache();
});

test('the properties of the systemd envelope are in long form', () => {
  // Regression: `-p=MemoryMax=12G` is rejected by systemd-run ("Unknown
  // assignment") and makes the spawn of ALL missions fail, not
  // only the confinement. No typecheck sees a command line;
  // only this assertion (and the startup probe) protects.
  const { cmd, args } = wrapMissionLaunch('claude', ['--x'], 'aaaaaaaa-0000-4000-8000-000000000000');
  if (cmd !== 'systemd-run') return; // no systemd here (CI): nothing to check
  for (const a of args.filter((v) => v.includes('MemoryMax') || v.includes('CPUWeight'))) {
    assert.match(a, /^--property=/);
  }
  assert.ok(args.includes('--'), 'a -- separator must precede the wrapped command');
  assert.deepEqual(args.slice(-2), ['claude', '--x']);
  const slice = args.find((v) => v.startsWith('--slice='));
  if (slice) assert.equal(slice, `--slice=${instancePrefix()}-missions.slice`);
});

test('the scope name is unique per turn and can be attached to its mission', () => {
  const id = 'b73f0bd2-9c47-489c-9118-0296e6749dbe';
  const a = missionScopeUnit(id);
  const b = missionScopeUnit(id);
  assert.notEqual(a, b, 'two turns of the same mission cannot share a unit');
  const prefix = instancePrefix();
  for (const u of [a, b]) {
    assert.match(u, new RegExp(`^${prefix}-mission-b73f0bd2-`));
    assert.doesNotMatch(u, /^timon-mission-/);
  }
});

test('resource guard disabled: stopMissionScopes runs no systemd command', async () => {
  // Regression of 29/08/2026: called at boot and on SIGTERM, this function
  // stopped ALL the `timon-mission-*.scope` of the machine without telling
  // instances apart. A witness orchestrator launched by an agent therefore killed the scope
  // of that agent, and the production missions with it. The disabled guard must
  // make the function totally inert, not even the `hasSystemd()` probe,
  // which already runs `systemctl`. The real runs of the binary are measured:
  // a return of 0 would prove nothing (it is also "0 scopes stopped").
  const { invalidateSettingsCache } = await import('./settings.js');
  process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
  invalidateSettingsCache();
  const before = systemctlCallCount();
  assert.equal(stopMissionScopes(), 0);
  assert.equal(systemctlCallCount(), before, 'no call to systemctl must happen');
  delete process.env.TIMON_RESOURCE_GUARD_ENABLED;
  invalidateSettingsCache();
});

test('two distinct TIMON_HOMEs produce two distinct instance prefixes', () => {
  const a = instancePrefix('/tmp/timon-home-a');
  const b = instancePrefix('/tmp/timon-home-b');
  assert.match(a, /^timon-[0-9a-f]{8}$/);
  assert.match(b, /^timon-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
  assert.equal(grepaiWatcherUnit('demo', '/tmp/timon-home-a').startsWith(`${a}-grepai-watch-`), true);
  assert.equal(missionScopePattern('/tmp/timon-home-a'), `${a}-mission-*.scope`);
});

test("stopMissionScopes of home A builds no command with B's prefix", async () => {
  const { invalidateSettingsCache } = await import('./settings.js');
  const homeA = '/tmp/timon-home-iso-a';
  const homeB = '/tmp/timon-home-iso-b';
  const prefixA = instancePrefix(homeA);
  const prefixB = instancePrefix(homeB);
  const unitA = `${prefixA}-mission-aaaaaaaa-1.scope`;
  const unitB = `${prefixB}-mission-bbbbbbbb-1.scope`;
  const legacy = 'timon-mission-deadbeef-1.scope';
  const calls: string[][] = [];

  process.env.TIMON_RESOURCE_GUARD_ENABLED = '1';
  invalidateSettingsCache();
  setHasSystemdForTest(true);
  setSystemctlForTest((args) => {
    calls.push([...args]);
    if (args[0] === 'list-units') {
      return { ok: true, out: `${unitA} loaded active running\n${unitB} loaded active running\n${legacy} loaded active running\n` };
    }
    return { ok: true, out: '' };
  });
  try {
    const stopped = stopMissionScopes(homeA);
    assert.equal(stopped, 1);
    assert.ok(calls.some((a) => a[0] === 'list-units' && a.includes(missionScopePattern(homeA))));
    const stopCalls = calls.filter((a) => a[0] === 'stop');
    for (const args of stopCalls) {
      assert.ok(args.includes(unitA));
    }
    for (const args of calls) {
      const joined = args.join(' ');
      assert.equal(joined.includes(prefixB), false, `command with B's prefix: ${joined}`);
      assert.equal(args.includes(LEGACY_MISSION_SCOPE_PATTERN), false);
      assert.equal(args.includes(unitB), false);
      assert.equal(args.includes(legacy), false);
    }
  } finally {
    setSystemctlForTest(null);
    setHasSystemdForTest(null);
    delete process.env.TIMON_RESOURCE_GUARD_ENABLED;
    invalidateSettingsCache();
  }
});

test('the production unit name is no longer created; adoption still lists it', async () => {
  const { invalidateSettingsCache } = await import('./settings.js');
  const home = '/tmp/timon-home-adopt';
  const own = `${instancePrefix(home)}-mission-aaaaaaaa-1.scope`;
  const legacy = 'timon-mission-c0ffee00-1.scope';
  const foreign = `${instancePrefix('/tmp/timon-home-other')}-mission-bbbbbbbb-1.scope`;

  assert.doesNotMatch(missionScopeUnit('c0ffee00-0000-4000-8000-000000000000', home), /^timon-mission-/);
  assert.match(legacy, /^timon-mission-[0-9a-f]{8}-/);

  setHasSystemdForTest(true);
  setSystemctlForTest((args) => {
    const pattern = args[args.length - 1] ?? '';
    if (pattern === missionScopePattern(home)) {
      return { ok: true, out: `${own} loaded active running\n${foreign} loaded active running\n` };
    }
    if (pattern === LEGACY_MISSION_SCOPE_PATTERN) {
      return { ok: true, out: `${legacy} loaded active running\n` };
    }
    return { ok: true, out: '' };
  });
  try {
    const listed = listMissionScopes(home);
    assert.ok(listed.includes(own));
    assert.ok(listed.includes(legacy), 'the historical scopes stay visible (read-only adoption)');
    assert.equal(listed.includes(foreign), false);
  } finally {
    setSystemctlForTest(null);
    setHasSystemdForTest(null);
    delete process.env.TIMON_RESOURCE_GUARD_ENABLED;
    invalidateSettingsCache();
  }
});
