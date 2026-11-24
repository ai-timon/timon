/**
 * `timon doctor` — two behaviors that, if wrong, are noticed too late.
 *
 * Binary resolution is our own PATH walk (`which` doesn't exist on Windows):
 * if `host.binaries` pinning were ignored, a machine whose `git` isn't in
 * PATH would be declared unusable even though the config designates it. And
 * the exit code is a contract: an install script relies on it.
 */
// Isolate TIMON_HOME BEFORE any module that touches TIMON state (cf. test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { whichBin, diagnose, dockerInfoVerdict, formatDoctor, BINARIES } = await import('./doctor.js');
const { TimonConfigSchema } = await import('./config/schema.js');
const { setConfig, resetConfig } = await import('./config/load.js');

test('a pinned binary short-circuits PATH, and a dead pin is not caught', () => {
  const real = whichBin('node');
  assert.ok(real.path, 'node must be found in PATH');
  assert.equal(real.pinned, false);

  const pinned = whichBin('node', { node: real.path });
  assert.deepEqual(pinned, { path: real.path, pinned: true });

  // A wrong pinned path must NOT silently fall back to PATH: the user
  // designated a specific binary, so we tell them it's not there.
  assert.deepEqual(whichBin('node', { node: '/nowhere/node' }), { path: null, pinned: true });
});

/**
 * The wording of this blocker is a CONTRACT with the first-run screen.
 *
 * `app/src/lib/setup-plan.ts` decides whether to show the "no agent tool
 * found" recourse by matching this prefix, deliberately rather than
 * recomputing the rule: two implementations of "is a backend missing" drift,
 * and the screen would then alarm on a machine this daemon considers fine.
 * The two packages share no code (no monorepo), so the string is pinned on
 * both sides — here, and in `setup-plan.test.ts`.
 */
test('the no-backend blocker keeps the wording the first-run screen matches', () => {
  const backends = BINARIES.filter((b) => 'backend' in b && b.backend).map((b) => b.name);
  assert.deepEqual(backends, ['claude', 'codex', 'grok', 'copilot', 'opencode', 'hermes-acp', 'pi', 'agy']);
  const blocker = `no LLM backend installed (${backends.join(', ')})`;
  assert.ok(blocker.startsWith('no LLM backend installed'),
    'app/src/lib/setup-plan.ts matches this prefix');
  // And it is only ever pushed when NOT ONE of them is present: the group rule
  // the screen relies on to stay silent while a single backend is installed.
  const r = diagnose();
  const anyBackend = r.binaries.some((b) => backends.includes(b.name) && b.ok);
  assert.equal(r.blockers.some((b) => b.startsWith('no LLM backend installed')), !anyBackend);
});

test('the diagnostic names what blocks and the text render shows it', () => {
  const r = diagnose();
  assert.equal(r.platform, process.platform);
  assert.ok(r.binaries.some((b) => b.name === 'node' && b.ok));
  // `ok` is the command's exit code: it depends ONLY on the blockers.
  assert.equal(r.ok, r.blockers.length === 0);
  const txt = formatDoctor(r);
  assert.match(txt, /Timon doctor/);
  assert.match(txt, /capabilities/);
  // TIM-0109: the free space where the data lives is part of every report.
  assert.equal(r.storage.path, r.timonHome);
  assert.match(txt, /free disk space/);
});

const ISO_DEFAULTS = { unixSockets: 'deny', writable: [], exceptions: { agents: {}, projects: {} } } as const;

type IsoInput = Parameters<typeof import('./doctor.js')['missionIsolationReport']>[0];
function isoInput(over: Partial<IsoInput>): IsoInput {
  return {
    configured: 'auto', status: null, mechanism: 'landlock', platform: 'linux',
    isolation: ISO_DEFAULTS, launcher: 'scope', maskedPaths: 7, ...over,
  };
}

/**
 * GHSA-f58g — the isolation line must never read as protection that is absent:
 * a fenced machine says which mechanism holds, an unfenced one says NOT
 * enforced with its cause and what a mission can then read, an altered
 * launcher is said apart from a machine without the mechanism, and only
 * `enforce` turns the absence into a blocker.
 */
test('the diagnostic says whether missions are fenced, and why not', async () => {
  const { missionIsolationReport } = await import('./doctor.js');
  const ready = { state: 'ready', binary: '/x/timon-fence', abi: 6, seccomp: true } as const;

  const linux = missionIsolationReport(isoInput({ status: ready }));
  assert.equal(linux.blocker, null);
  assert.deepEqual(
    { mechanism: linux.report.mechanism, abi: linux.report.abi, enforced: linux.report.enforced, launch: linux.report.launch, gaps: linux.report.gaps, reason: linux.report.reason },
    { mechanism: 'landlock', abi: 6, enforced: true, launch: 'fenced', gaps: [], reason: null },
  );
  assert.equal(linux.report.message, "enforced (landlock ABI 6 + unix-socket filter): missions cannot read Timon's private files.");

  const mac = missionIsolationReport(isoInput({ status: { ...ready, abi: 0 }, mechanism: 'seatbelt', platform: 'darwin' }));
  assert.equal(mac.report.message, "enforced (seatbelt): missions cannot read Timon's private files.");
  assert.deepEqual({ abi: mac.report.abi, gaps: mac.report.gaps }, { abi: 0, gaps: [] });

  // ABI 2: truncation and signals are not confined.
  const abi2 = missionIsolationReport(isoInput({ status: { ...ready, abi: 2 } })).report;
  assert.equal(abi2.gaps[0], 'partial: kernel ABI 2 — a mission can truncate files it cannot read.');
  assert.match(abi2.gaps[1] ?? '', /ABI 2 — a mission can send signals/);
  assert.deepEqual(missionIsolationReport(isoInput({ status: { ...ready, abi: 4 } })).report.gaps.length, 1);

  const kernel = missionIsolationReport(isoInput({ status: { state: 'unsupported', reason: 'kernel without Landlock', abi: 0 } }));
  assert.equal(kernel.blocker, null, 'auto never blocks');
  assert.deepEqual({ mechanism: kernel.report.mechanism, enforced: kernel.report.enforced, launch: kernel.report.launch },
    { mechanism: 'none', enforced: false, launch: 'unfenced' });
  assert.match(kernel.report.message, /^NOT enforced — kernel without Landlock\. A mission can read Timon's private files, including the operator token and the vault key: on a multi-account install, account permissions do not hold against a mission\. Set host\.isolation\.filesystem to "enforce"/);
  assert.doesNotMatch(kernel.report.message, /altered/);

  const windows = missionIsolationReport(isoInput({ status: { state: 'unsupported', reason: 'no mission fence on this OS', abi: 0 }, mechanism: null, platform: 'win32', launcher: null }));
  assert.equal(windows.report.reason, 'no mission fence on Windows yet');
  assert.match(windows.report.message, /^NOT enforced — no mission fence on Windows yet\./);

  const tampered = { state: 'tampered', reason: 'the fence launcher this release ships (/x/native/timon-fence) is not executable', abi: 0 } as const;
  const altered = missionIsolationReport(isoInput({ status: tampered }));
  assert.equal(altered.report.state, 'tampered');
  assert.match(altered.report.message, /^NOT enforced — ALTERED: .*not executable\. The Timon package may have been altered: reinstall it\./);
  assert.equal(altered.blocker, null);

  const refused = missionIsolationReport(isoInput({ configured: 'enforce', status: tampered }));
  assert.equal(refused.report.launch, 'refused');
  assert.match(refused.blocker ?? '', /^Mission refused.*"enforce".*altered/);
  assert.match(refused.report.message, /every mission is refused until this is fixed/);

  const off = missionIsolationReport(isoInput({ configured: 'off', status: null }));
  assert.deepEqual({ state: off.report.state, enforced: off.report.enforced, blocker: off.blocker }, { state: 'off', enforced: false, blocker: null });
  assert.match(off.report.message, /^NOT enforced — turned off/);
});

test('the diagnostic names what the fence leaves open: unix sockets, writable paths, exceptions', async () => {
  const { missionIsolationReport } = await import('./doctor.js');
  const ready = { state: 'ready', binary: '/x/timon-fence', abi: 6, seccomp: true } as const;
  const report = missionIsolationReport(isoInput({
    status: ready,
    isolation: {
      unixSockets: 'deny',
      writable: ['~/.cache/tool'],
      exceptions: {
        agents: { deployer: { unixSockets: 'allow', writable: [] }, quiet: { writable: [] } },
        projects: { site: { writable: ['~/.npm', '~/.cargo'] } },
      },
    },
  })).report;
  assert.deepEqual(report.exceptions, { agents: ['deployer', 'quiet'], projects: ['site'] });
  assert.deepEqual(report.gaps, [
    '1 extra writable path(s) in the home for every mission (host.isolation.writable).',
    'exception for agent "deployer": unix sockets allowed.',
    'exception for project "site": 2 extra writable path(s).',
  ]);

  const open = missionIsolationReport(isoInput({ status: ready, isolation: { ...ISO_DEFAULTS, unixSockets: 'allow' } })).report;
  assert.equal(open.message, "enforced (landlock ABI 6): missions cannot read Timon's private files.");
  assert.match(open.gaps[0] ?? '', /^unix sockets allowed for every mission/);

  // Unfenced, the gaps are moot: the warning already says a mission reaches everything.
  const none = missionIsolationReport(isoInput({ status: { state: 'unsupported', reason: 'kernel without Landlock', abi: 0 }, isolation: { ...ISO_DEFAULTS, unixSockets: 'allow' } })).report;
  assert.deepEqual(none.gaps, []);
});

/**
 * #891: the INERT masking line goes away where the fence applies, and stays
 * where it does not, next to the NOT enforced warning; `enforce` without a
 * fence is a blocker, `auto` never is.
 */
test('the text render shows the fence, the warning and the INERT line only where unfenced', async () => {
  const { missionIsolationReport } = await import('./doctor.js');
  const base = diagnose();
  const fenced = missionIsolationReport(isoInput({ status: { state: 'ready', binary: '/x', abi: 2, seccomp: true } })).report;
  const fencedText = formatDoctor({ ...base, missionIsolation: fenced, blockers: [] });
  assert.match(fencedText, /mission isolation enforced \(landlock ABI 2 \+ unix-socket filter\)/);
  assert.match(fencedText, /\n {2}partial: kernel ABI 2 — a mission can truncate files it cannot read\./);
  assert.doesNotMatch(fencedText, /INERT|mission FS masking|WARNING:/);

  const unfenced = missionIsolationReport(isoInput({ status: { state: 'unsupported', reason: 'kernel without Landlock', abi: 0 } })).report;
  const unfencedText = formatDoctor({ ...base, missionIsolation: unfenced, blockers: [] });
  assert.match(unfencedText, /mission isolation NOT enforced — kernel without Landlock\./);
  assert.match(unfencedText, /mission FS masking INERT — 7 path\(s\) in the policy, NONE masked today/);
  assert.match(unfencedText, /WARNING:\n {2}- mission isolation NOT enforced/);

  try {
    const live = diagnose();
    assert.equal(live.missionIsolation.configured, 'auto');
    assert.ok(!live.blockers.some((b) => b.startsWith('Mission refused')));
    assert.equal(live.missionIsolation.enforced, live.missionIsolation.launch === 'fenced');
    setConfig(TimonConfigSchema.parse({ host: { isolation: { filesystem: 'enforce' } } }));
    const strict = diagnose();
    assert.equal(strict.blockers.some((b) => b.startsWith('Mission refused')), strict.missionIsolation.launch === 'refused');
    setConfig(TimonConfigSchema.parse({ host: { isolation: { filesystem: 'off' } } }));
    const off = diagnose();
    assert.equal(off.missionIsolation.state, 'off');
    assert.match(formatDoctor(off), /mission isolation NOT enforced — turned off/);
    assert.doesNotMatch(formatDoctor(off), /mission FS masking/);
  } finally {
    resetConfig();
  }
});

test('an empty main seat names the command that fills it', () => {
  const r = diagnose();
  const empty = formatDoctor({ ...r, mainSeat: { holder: null, empty: true, candidates: ['Atlas', 'Zeus'] } });
  assert.match(empty, /main orchestrator NONE .*eligible: Atlas, Zeus; run "timon agent set-main <name>"/);
  const none = formatDoctor({ ...r, mainSeat: { holder: null, empty: true, candidates: [] } });
  assert.doesNotMatch(none, /set-main/, 'no command to suggest when nobody is eligible');
});

test('a Docker daemon is usable only when it answers with its version', () => {
  assert.deepEqual(dockerInfoVerdict({ code: 0, stdout: '26.1.5+dfsg1\n', stderr: '' }), { usable: true, detail: 'server 26.1.5+dfsg1' });
  // Docker 26 exits 0 with an empty version when it cannot reach the daemon.
  const unreachable = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
  assert.deepEqual(dockerInfoVerdict({ code: 0, stdout: '\n', stderr: `${unreachable}\n` }), { usable: false, detail: unreachable });
  assert.deepEqual(dockerInfoVerdict({ code: 1, stdout: '', stderr: '' }), { usable: false, detail: 'daemon unreachable' });
});
