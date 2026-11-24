/**
 * Per-mission memory ceiling vs. the slice's MemoryMax, slice properties, and
 * OOM attribution.
 *
 * Two incidents of 19/09/2026. First, scope MemoryMax=12G under a slice
 * MemoryHigh=8G: the mission's own ceiling was never reached, the slice
 * throttled and every mission hung. Then that throttling produced memory
 * pressure that climbed to user@UID.service, and systemd-oomd killed the whole
 * desktop session. These tests pin: no finite MemoryHigh on the slice, oomd
 * scoped to the slice, mission ceiling strictly below the slice MemoryMax,
 * the live re-application on a night → day switch, and the notices.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProfileLimits } from './resources.js';

// `ensureMissionSlice()` writes under ~/.config/systemd/user: never the real one.
process.env.HOME = mkdtempSync(join(tmpdir(), 'timon-cap-home-'));

const {
  currentProfile, missionMemCapMiB, profileLimits, applyProfile, resetAppliedProfileForTest, instancePrefix,
  MISSION_SLICE, parsePressureSomeAvg10, checkSlicePressure, resetPressureAlertForTest,
  setResourceAlertSink, PRESSURE_ALERT_PCT, PRESSURE_REARM_PCT,
} = await import('./resources.js');
const { diffScopeKills, formatKillNotice, killNoticeMessage, missionPrefixOfScope, parseKernelOom, readScopeSnapshots } =
  await import('./resources-oom.js');
const { setHasSystemdForTest, setSystemctlForTest } = await import('./host/systemd.js');
const { invalidateSettingsCache, resolve, retiredSettingsInUse, setSetting } = await import('./settings.js');

const ALWAYS_DAY = { TIMON_DAY_START_HOUR: '0', TIMON_DAY_END_HOUR: '24' };
const ALWAYS_NIGHT = { TIMON_DAY_START_HOUR: '0', TIMON_DAY_END_HOUR: '0' };

function setEnv(vars: Record<string, string>): void {
  Object.assign(process.env, vars);
  invalidateSettingsCache();
}

test('the mission ceiling stays strictly below the slice MemoryMax, with a margin', () => {
  // 12 GB asked under an 8 GB slice ceiling: clamped with a 1 GiB margin.
  const small = missionMemCapMiB(12, 8);
  assert.equal(small.clamped, true);
  assert.equal(small.mib, 7 * 1024);
  // Shipped day default: 12 GB under a 16 GB slice ceiling, kept as is.
  assert.deepEqual(missionMemCapMiB(12, 16), { mib: 12 * 1024, clamped: false });
  // Equal is not "strictly below": clamped too.
  assert.equal(missionMemCapMiB(16, 16).clamped, true);
  assert.ok(missionMemCapMiB(16, 16).mib < 16 * 1024);
  // Never raised above what the setting allows.
  assert.equal(missionMemCapMiB(2, 64).mib, 2 * 1024);
  // A tiny slice still gets a positive ceiling below its soft limit.
  const tiny = missionMemCapMiB(4, 1);
  assert.ok(tiny.mib > 0 && tiny.mib < 1024);
});

test('profileLimits applies the clamp for day AND night with the shipped defaults', () => {
  for (const window of [ALWAYS_DAY, ALWAYS_NIGHT]) {
    setEnv(window);
    const lim = profileLimits();
    assert.ok(
      lim.missionMemMaxMiB < lim.memMaxGb * 1024,
      `${lim.profile}: ${lim.missionMemMaxMiB} MiB is not below MemoryMax ${lim.memMaxGb} GB`,
    );
    assert.equal(lim.missionMemMaxGb, lim.missionMemMaxMiB / 1024);
  }
});

test('night → day lowers MemoryMax on live scopes BEFORE lowering the slice', () => {
  const scope = `${instancePrefix()}-mission-abcd1234-1.scope`;
  const calls: string[][] = [];
  // The memory defaults follow the host's RAM class (`resource-memory-presets.ts`): on a 16 GB machine
  // the night already caps a mission at 4 GB, which an 8 GB day does not lower. Pinned, the switch
  // lowers the ceiling on any host.
  setEnv({ ...ALWAYS_NIGHT, TIMON_RESOURCE_GUARD_ENABLED: '1', TIMON_NIGHT_MEM_MAX_GB: '24', TIMON_MISSION_MEM_MAX_GB: '12' });
  setHasSystemdForTest(true);
  setSystemctlForTest((args) => {
    calls.push([...args]);
    if (args[0] === 'list-units') return { ok: true, out: `${scope} loaded active running\n` };
    return { ok: true, out: '' };
  });
  try {
    resetAppliedProfileForTest();
    assert.equal(applyProfile(true), 'night');
    const nightCap = profileLimits().missionMemMaxMiB;
    calls.length = 0;

    // A day slice small enough that the per-mission ceiling must drop.
    setEnv({ ...ALWAYS_DAY, TIMON_DAY_MEM_MAX_GB: '8' });
    assert.equal(applyProfile(), 'day');
    const dayCap = profileLimits().missionMemMaxMiB;
    assert.ok(dayCap < nightCap);

    const setProps = calls.filter((a) => a[0] === 'set-property');
    const scopeIdx = setProps.findIndex((a) => a.includes(scope));
    const sliceIdx = setProps.findIndex((a) => a.some((x) => x.endsWith('.slice')));
    assert.ok(scopeIdx >= 0, 'the live scope was not updated');
    assert.ok(sliceIdx > scopeIdx, 'the slice was lowered before the scopes');
    assert.deepEqual(setProps[scopeIdx], ['set-property', '--runtime', scope, `MemoryMax=${dayCap}M`]);

    // Same profile, same ceiling: nothing to do on the next tick.
    calls.length = 0;
    assert.equal(applyProfile(), null);
    assert.equal(calls.filter((a) => a[0] === 'set-property').length, 0);
  } finally {
    setSystemctlForTest(null);
    setHasSystemdForTest(null);
    resetAppliedProfileForTest();
    for (const k of ['TIMON_DAY_START_HOUR', 'TIMON_DAY_END_HOUR', 'TIMON_RESOURCE_GUARD_ENABLED', 'TIMON_DAY_MEM_MAX_GB', 'TIMON_NIGHT_MEM_MAX_GB', 'TIMON_MISSION_MEM_MAX_GB']) delete process.env[k];
    invalidateSettingsCache();
  }
});

test('a CPU quota change is pushed to the slice without a profile switch', () => {
  const calls: string[][] = [];
  setEnv({ ...ALWAYS_DAY, TIMON_RESOURCE_GUARD_ENABLED: '1', TIMON_DAY_CPU_QUOTA_PCT: '1600' });
  setHasSystemdForTest(true);
  setSystemctlForTest((args) => {
    calls.push([...args]);
    return { ok: true, out: '' };
  });
  const sliceSets = () => calls.filter((a) => a[0] === 'set-property' && a.includes(MISSION_SLICE));
  try {
    resetAppliedProfileForTest();
    assert.equal(applyProfile(true), 'day');
    calls.length = 0;

    // Same profile, only the quota changes (the 19/09/2026 case: 1600 % → 400 %).
    setEnv({ TIMON_DAY_CPU_QUOTA_PCT: '400' });
    assert.equal(applyProfile(), 'day');
    const [call, ...rest] = sliceSets();
    assert.ok(call, 'the new quota was not pushed to the slice');
    assert.equal(rest.length, 0);
    assert.ok(call.includes('CPUQuota=400%'), call.join(' '));

    // Nothing changed since: the next tick does nothing.
    calls.length = 0;
    assert.equal(applyProfile(), null);
    assert.equal(calls.filter((a) => a[0] === 'set-property').length, 0);
  } finally {
    setSystemctlForTest(null);
    setHasSystemdForTest(null);
    resetAppliedProfileForTest();
    for (const k of ['TIMON_DAY_START_HOUR', 'TIMON_DAY_END_HOUR', 'TIMON_RESOURCE_GUARD_ENABLED', 'TIMON_DAY_CPU_QUOTA_PCT']) delete process.env[k];
    invalidateSettingsCache();
  }
});

/** Runs `applyProfile(true)` against a fake systemctl; returns every call and
 *  the limits read under the same forced day window — read after the cleanup,
 *  they would follow the wall clock and diverge at night. */
function captureApply(reject?: (args: string[]) => boolean): { calls: string[][]; limits: ProfileLimits } {
  const calls: string[][] = [];
  let limits: ProfileLimits;
  setEnv({ ...ALWAYS_DAY, TIMON_RESOURCE_GUARD_ENABLED: '1' });
  setHasSystemdForTest(true);
  setSystemctlForTest((args) => {
    calls.push([...args]);
    if (reject?.(args)) return { ok: false, out: 'Unknown assignment' };
    return { ok: true, out: '' };
  });
  try {
    resetAppliedProfileForTest();
    assert.equal(applyProfile(true), 'day');
    limits = profileLimits();
  } finally {
    setSystemctlForTest(null);
    setHasSystemdForTest(null);
    resetAppliedProfileForTest();
    for (const k of ['TIMON_DAY_START_HOUR', 'TIMON_DAY_END_HOUR', 'TIMON_RESOURCE_GUARD_ENABLED']) delete process.env[k];
    invalidateSettingsCache();
  }
  return { calls, limits };
}

const sliceCalls = (calls: string[][]) =>
  calls.filter((a) => a[0] === 'set-property' && a.includes(MISSION_SLICE));

test('the slice gets MemoryHigh=infinity and oomd kill, never a finite MemoryHigh', () => {
  const { calls, limits } = captureApply();
  const [call, ...rest] = sliceCalls(calls);
  assert.ok(call);
  assert.equal(rest.length, 0);
  // Explicit infinity: omitting it would leave a finite value from an older
  // runtime drop-in in place.
  assert.ok(call.includes('MemoryHigh=infinity'));
  assert.ok(!call.some((a) => /^MemoryHigh=\d/.test(a)), call.join(' '));
  assert.ok(call.includes('ManagedOOMMemoryPressure=kill'));
  assert.ok(call.includes('ManagedOOMMemoryPressureLimit=40%'));
  assert.ok(call.includes(`MemoryMax=${limits.memMaxGb}G`));
  assert.ok(!call.some((a) => /ManagedOOMPreference/.test(a)), 'nothing may shield the missions from oomd');

  // The persistent unit carries the same memory properties.
  const unitPath = join(homedir(), '.config', 'systemd', 'user', MISSION_SLICE);
  assert.ok(existsSync(unitPath));
  const unit = readFileSync(unitPath, 'utf8');
  assert.match(unit, /^MemoryHigh=infinity$/m);
  assert.doesNotMatch(unit, /^MemoryHigh=\d/m);
  assert.match(unit, /^ManagedOOMMemoryPressure=kill$/m);
  assert.match(unit, /^ManagedOOMMemoryPressureLimit=40%$/m);
  assert.match(unit, /^MemoryMax=\d+G$/m);
});

test('a systemd rejecting ManagedOOM* still gets the ceilings', () => {
  const calls = sliceCalls(captureApply((args) =>
    args.includes(MISSION_SLICE) && args.some((a) => a.startsWith('ManagedOOM'))).calls);
  assert.equal(calls.length, 2);
  const retry = calls[1]!;
  assert.ok(!retry.some((a) => a.startsWith('ManagedOOM')));
  assert.ok(retry.includes('MemoryHigh=infinity'));
  assert.ok(retry.some((a) => a.startsWith('MemoryMax=')));
  assert.ok(retry.some((a) => a.startsWith('CPUQuota=')));
});

test('memory.pressure: some avg10 is parsed', () => {
  const raw = 'some avg10=59.73 avg60=41.20 avg300=12.00 total=123456\nfull avg10=50.10 avg60=30.00 avg300=9.00 total=99999\n';
  assert.equal(parsePressureSomeAvg10(raw), 59.73);
  assert.equal(parsePressureSomeAvg10(''), null);
});

test('high slice pressure alerts once per episode, before oomd acts', () => {
  const alerts: { title: string; urgent: boolean; message?: { code: string; params: Readonly<Record<string, string | number>> } }[] = [];
  setResourceAlertSink((a) => alerts.push(a));
  resetPressureAlertForTest();
  const st = { memoryCurrent: 8 * 1024 ** 3, memoryMax: 16 * 1024 ** 3 };
  assert.ok(PRESSURE_ALERT_PCT < 40, 'the alert must fire below the oomd limit');
  checkSlicePressure(PRESSURE_ALERT_PCT - 1, st);
  assert.equal(alerts.length, 0);
  checkSlicePressure(PRESSURE_ALERT_PCT + 5, st);
  checkSlicePressure(PRESSURE_ALERT_PCT + 10, st);
  checkSlicePressure(PRESSURE_REARM_PCT + 1, st); // still the same episode
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.urgent, true);
  assert.deepEqual(alerts[0]?.message, {
    code: 'resource_pressure_high', params: { pressure: String(PRESSURE_ALERT_PCT + 5), usage: '8.0 GB', max: '16.0 GB', limit: '40%' },
  });
  checkSlicePressure(PRESSURE_REARM_PCT - 1, st); // re-armed
  checkSlicePressure(PRESSURE_ALERT_PCT, st);
  assert.equal(alerts.length, 2);
  checkSlicePressure(null, st);
  assert.equal(alerts.length, 2);
});

test('the retired MemoryHigh settings are gone from the registry but reported when set', () => {
  assert.equal(resolve('TIMON_DAY_MEM_HIGH_GB'), undefined);
  assert.equal(resolve('TIMON_NIGHT_MEM_HIGH_GB'), undefined);
  process.env.TIMON_DAY_MEM_HIGH_GB = '8';
  try {
    assert.deepEqual(retiredSettingsInUse(), [{ key: 'TIMON_DAY_MEM_HIGH_GB', source: 'env' }]);
  } finally {
    delete process.env.TIMON_DAY_MEM_HIGH_GB;
  }
  assert.deepEqual(retiredSettingsInUse(), []);
});

// The scope's processes are read from /proc, which only Linux has.
test('an OOM-killed process is named from the cgroup snapshots', { skip: process.platform !== 'linux' && 'reads /proc' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-cg-'));
  const slice = '/user.slice/timon-x-missions.slice';
  const scope = 'timon-x-mission-abcd1234-1.scope';
  const dir = join(root, slice, scope);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'memory.events'), 'low 0\nhigh 0\nmax 3\noom 1\noom_kill 0\n');
  writeFileSync(join(dir, 'memory.max'), String(7 * 1024 ** 3));
  writeFileSync(join(dir, 'cgroup.procs'), `${process.pid}\n`);
  const before = readScopeSnapshots(slice, () => true, root);
  assert.equal(before.get(scope)?.procs[0]?.pid, process.pid);

  // Simulate the next tick: the heavy process is gone, the counter moved.
  const prev = new Map(before);
  const snap = prev.get(scope);
  assert.ok(snap);
  prev.set(scope, {
    ...snap,
    procs: [
      ...snap.procs,
      { pid: 999_999_001, cmd: 'node --import tsx src/lib/kanban-series-graph.test.ts', rssBytes: 7 * 1024 ** 3 },
      { pid: 999_999_002, cmd: 'sh -c true', rssBytes: 1024 },
    ],
  });
  writeFileSync(join(dir, 'memory.events'), 'low 0\nhigh 0\nmax 9\noom 2\noom_kill 1\n');
  const after = readScopeSnapshots(slice, () => true, root);
  const kills = diffScopeKills(prev, after);
  assert.equal(kills.length, 1);
  assert.equal(kills[0]?.pid, 999_999_001, 'the heaviest vanished process is the victim');
  assert.equal(kills[0]?.ceilingBytes, 7 * 1024 ** 3);

  const notice = formatKillNotice(kills[0]!);
  const coded = killNoticeMessage(kills[0]!, 'abcd1234');
  assert.equal(coded.code, 'resource_mission_killed');
  assert.equal(coded.params.mission, 'abcd1234');
  assert.match(notice, /kanban-series-graph\.test\.ts/);
  assert.match(notice, /more than 7\.0 GB/);
  assert.match(notice, /same command again will be killed/);
  assert.equal(missionPrefixOfScope(scope), 'abcd1234');
});

test('the kernel OOM report yields pid, scope and RSS', () => {
  const scopePath = '/user.slice/user-1000.slice/user@1000.service/timon.slice/timon-x.slice/timon-x-missions.slice/timon-x-mission-abcd1234-3.scope';
  const log = [
    'node invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=0',
    `oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=user.slice,mems_allowed=0,oom_memcg=${scopePath},task_memcg=${scopePath},task=node,pid=4242,uid=1000`,
    'Memory cgroup out of memory: Killed process 4242 (node) total-vm:12345678kB, anon-rss:7340032kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:20000kB oom_score_adj:0',
  ].join('\n');
  const [line] = parseKernelOom(log);
  assert.ok(line);
  assert.equal(line.pid, 4242);
  assert.equal(line.task, 'node');
  assert.equal(line.taskScope, 'timon-x-mission-abcd1234-3.scope');
  assert.equal(line.scopeCeiling, true);
  assert.equal(line.rssBytes, 7340032 * 1024);
});


test('saved memory ceilings reach the slice on the next tick without a profile switch', () => {
  const calls: string[][] = [];
  setEnv({ ...ALWAYS_DAY, TIMON_RESOURCE_GUARD_ENABLED: '1', TIMON_MISSION_MEM_MAX_GB: '2' });
  delete process.env.TIMON_DAY_MEM_MAX_GB;
  setHasSystemdForTest(true);
  setSystemctlForTest((args) => { calls.push([...args]); return { ok: true, out: '' }; });
  try {
    resetAppliedProfileForTest();
    setSetting('TIMON_DAY_MEM_MAX_GB', '6');
    applyProfile();
    calls.length = 0;
    setSetting('TIMON_DAY_MEM_MAX_GB', '3');
    assert.equal(applyProfile(), 'day');
    assert.ok(sliceCalls(calls).some((args) => args.includes('MemoryMax=3G')));
    calls.length = 0;
    assert.equal(applyProfile(), null);
    assert.equal(calls.length, 0);
  } finally {
    setSetting('TIMON_DAY_MEM_MAX_GB', null);
    setSystemctlForTest(null);
    setHasSystemdForTest(null);
    resetAppliedProfileForTest();
    for (const key of ['TIMON_DAY_START_HOUR', 'TIMON_DAY_END_HOUR', 'TIMON_RESOURCE_GUARD_ENABLED', 'TIMON_MISSION_MEM_MAX_GB']) delete process.env[key];
    invalidateSettingsCache();
  }
});

test('TIM-0124: out-of-range day hours are bounded when read, never stuck on day', () => {
  const at = (h: number) => new Date(2026, 9, 25, h, 0, 0);
  try {
    // A value stored before the bounds existed (the tester had end=25) reaches
    // the reader untouched: end is read as 24, so the night still comes.
    setEnv({ TIMON_DAY_START_HOUR: '8', TIMON_DAY_END_HOUR: '25' });
    assert.equal(currentProfile(at(3)), 'night');
    assert.equal(currentProfile(at(7)), 'night');
    assert.equal(currentProfile(at(23)), 'day');
    // A negative end is read as 0 (night from midnight), a start past 23 as 23.
    setEnv({ TIMON_DAY_START_HOUR: '8', TIMON_DAY_END_HOUR: '-3' });
    assert.equal(currentProfile(at(3)), 'night');
    assert.equal(currentProfile(at(9)), 'day');
    setEnv({ TIMON_DAY_START_HOUR: '99', TIMON_DAY_END_HOUR: '24' });
    assert.equal(currentProfile(at(22)), 'night');
    assert.equal(currentProfile(at(23)), 'day');
    // The documented edges keep their meaning.
    setEnv(ALWAYS_DAY);
    assert.equal(currentProfile(at(3)), 'day');
    setEnv(ALWAYS_NIGHT);
    assert.equal(currentProfile(at(15)), 'night');
  } finally {
    for (const k of ['TIMON_DAY_START_HOUR', 'TIMON_DAY_END_HOUR']) delete process.env[k];
    invalidateSettingsCache();
  }
});
