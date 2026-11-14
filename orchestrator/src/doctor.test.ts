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

const { whichBin, diagnose, formatDoctor, BINARIES } = await import('./doctor.js');
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

/**
 * secu-11 — `host.isolation.filesystem` is settable to `auto` while the mission
 * launcher (a systemd `--scope`) emits nothing. The diagnostic is where an
 * operator finds that out without reading the source: a resolved policy that
 * masks nothing must print INERT, not silence.
 */
test('the diagnostic says whether mission FS masking is actually enforced', () => {
  try {
    const auto = diagnose().missionIsolation;
    assert.equal(auto.configured, 'auto');
    // `enforced` is not asserted true or false: it depends on the host adapter
    // (a `scope` launcher enforces nothing, a `service` one would). What must
    // hold is that the rendered line never claims a protection that is absent.
    const txt = formatDoctor(diagnose());
    assert.match(txt, auto.enforced ? /mission FS masking enforced/ : /mission FS masking INERT/);
    if (!auto.enforced) assert.match(txt, /NONE masked today/);

    setConfig(TimonConfigSchema.parse({ host: { isolation: { filesystem: 'off' } } }));
    const off = diagnose().missionIsolation;
    assert.deepEqual(
      { configured: off.configured, enforced: off.enforced, maskedPaths: off.maskedPaths },
      { configured: 'off', enforced: false, maskedPaths: 0 },
    );
    assert.match(formatDoctor(diagnose()), /mission FS masking off/);
  } finally {
    resetConfig();
  }
});

test('doctor explains an invalid backend pin even when another backend works', async () => {
  const { join } = await import('node:path');
  const { TIMON_HOME } = await import('./paths.js');
  const missing = join(TIMON_HOME, 'missing', 'codex.cmd');
  try {
    setConfig(TimonConfigSchema.parse({ host: { binaries: { codex: missing } } }));
    const report = diagnose();
    const binary = report.binaries.find((b) => b.name === 'codex')!;
    assert.equal(binary.ok, false);
    assert.equal(binary.pinned, true);
    assert.match(formatDoctor(report), /host\.binaries\.codex.*not.*file/);
    assert.ok(formatDoctor(report).includes(missing));
  } finally { resetConfig(); }
});

test('an empty main seat is a warning line, never a blocker, and is silent before the first agent (TIM-0142)', async () => {
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { AGENTS_DIR, TIMON_HOME } = await import('./paths.js');
  const { dbApi } = await import('./db.js');
  const { MAIN_AGENT_KEY } = await import('./main-agent.js');
  const { TEAM_STATE_KEY, writeTeamState } = await import('./onboarding-team-state.js');
  const { doctorMainSeat } = await import('./doctor.js');
  rmSync(AGENTS_DIR, { force: true, recursive: true });
  dbApi.deleteSetting(MAIN_AGENT_KEY);
  dbApi.deleteSetting(TEAM_STATE_KEY);
  assert.equal(doctorMainSeat(), null, 'no agent yet: nothing to warn about');

  // Folders written by hand, as a restore leaves them: this file loads no provider.
  for (const name of ['Zeus', 'Atlas']) {
    mkdirSync(join(AGENTS_DIR, name), { recursive: true });
    writeFileSync(join(AGENTS_DIR, name, 'config.json'), JSON.stringify({ role: 'orchestrator', cwd: TIMON_HOME }));
  }
  const r = diagnose();
  assert.equal(r.mainSeat?.empty, true);
  assert.deepEqual([...(r.mainSeat?.candidates ?? [])].sort(), ['Atlas', 'Zeus']);
  assert.ok(!r.blockers.some((b) => /orchestrator/.test(b)), 'an empty seat does not fail the command');
  assert.match(formatDoctor(r), /main orchestrator NONE .*eligible: (Zeus, Atlas|Atlas, Zeus)/);
  // `diagnose()` only looks: nobody was seated.
  assert.equal(dbApi.getAllSettings()[MAIN_AGENT_KEY], undefined);

  writeTeamState({ status: 'pending' });
  assert.equal(doctorMainSeat(), null, 'the wizard is the one asking');
  dbApi.deleteSetting(TEAM_STATE_KEY);

  dbApi.setSetting(MAIN_AGENT_KEY, 'Zeus');
  assert.match(formatDoctor(diagnose()), /main orchestrator Zeus/);
  rmSync(AGENTS_DIR, { force: true, recursive: true });
  dbApi.deleteSetting(MAIN_AGENT_KEY);
});
