/**
 * `scripts/install-linux.sh`: parse and dry-run. The script is for a VPS:
 * it is not run (it would write the live unit and call systemctl).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(repoRoot, 'scripts', 'install-linux.sh');

function home(): string {
  return mkdtempSync(join(tmpdir(), 'timon-install-linux-'));
}

/**
 * The script refuses to start without `loginctl` and `systemctl`, even in dry-run, which never runs
 * them. Stand-ins first on the PATH: the dry-run passes on a host without systemd (a CI runner, a
 * container), and one that would really be called fails loudly instead of touching the real manager.
 */
function systemdStandIns(h: string): string {
  const bin = join(h, 'systemd-stand-ins');
  mkdirSync(bin, { recursive: true });
  for (const name of ['loginctl', 'systemctl']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "stand-in ${name} was called" >&2\nexit 97\n`, { mode: 0o755 });
  }
  return bin;
}

/**
 * The refusal tests leave only a fake `node` on the PATH, but the script runs a few system tools
 * before it reaches its checks. A CI runner keeps them in /usr/bin, beside git, so that folder
 * cannot go on the PATH of the test that wants git absent: each tool is linked instead.
 */
function linkSystemTools(bin: string): void {
  for (const name of ['dirname', 'id', 'sed']) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
    if (found) symlinkSync(found, join(bin, name));
  }
}

function envFor(h: string, patch: Record<string, string | null> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: h, TIMON_HOME: join(h, '.timon') };
  env.PATH = `${systemdStandIns(h)}${delimiter}${env.PATH ?? ''}`;
  delete env.TIMON_MISSION_ID;
  delete env.XDG_CONFIG_HOME;
  env.TIMON_RESOURCE_GUARD_ENABLED = '0';
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  return env;
}

function run(args: string[], opts: SpawnSyncOptions = {}) {
  // Absolute path: a test PATH reduced to a fake `node` must not
  // prevent finding bash (Node resolves the executable in options.env.PATH).
  return spawnSync('/usr/bin/bash', [script, ...args], {
    encoding: 'utf8',
    ...opts,
  });
}

// The installer targets a Linux VPS: it runs `/usr/bin/bash` and systemd stand-ins
// written in sh, which macOS (bash elsewhere) and Windows cannot start. Parsing it
// still holds everywhere bash exists.
const LINUX_ONLY = process.platform !== 'linux' && 'the installer and its stand-ins run on Linux only';

const NO_BASH = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status !== 0 && 'bash is not installed';

test('bash -n: the script parses', { skip: NO_BASH }, () => {
  const r = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('--dry-run: clone, builds, unit with installDir, linger, enable --now, doctor, zero real systemctl', { skip: LINUX_ONLY }, () => {
  const h = home();
  try {
    const r = run(['--dry-run'], { env: envFor(h) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = r.stdout;
    assert.match(out, /dry-run: no write command, no systemctl/);
    assert.match(out, new RegExp(`\\+ git clone .+ ${h}/timon`));
    assert.match(out, new RegExp(`\\+ \\(cd ${h}/timon/orchestrator && npm ci\\)`));
    assert.match(out, new RegExp(`\\+ \\(cd ${h}/timon/orchestrator && npm run build\\)`));
    assert.match(out, new RegExp(`\\+ \\(cd ${h}/timon/app && npm ci\\)`));
    assert.match(out, new RegExp(`\\+ \\(cd ${h}/timon/app && npm run build\\)`));
    // The mission launcher, optional: a VPS without a compiler still installs.
    assert.match(out, new RegExp(`\\+ \\(cd ${h}/timon && node native/timon-fence/build\\.mjs --optional\\)`));
    assert.match(out, /WorkingDirectory=.*\/timon\/orchestrator/);
    assert.match(out, /ExecStart=.*dist\/index\.js/);
    assert.doesNotMatch(out, /^Environment=TIMON_/m);
    assert.match(out, /StartLimitIntervalSec=60/);
    assert.match(out, new RegExp(`\\+ loginctl enable-linger ${process.env.USER || '.+'}`));
    assert.match(out, /\+ systemctl --user daemon-reload/);
    assert.match(out, /\+ systemctl --user enable --now timon-orchestrator/);
    assert.match(out, /\+ .*bin\/timon doctor/);
    assert.match(out, /"profile": "linux-server"/);
    assert.match(out, /"installDir": "~\/timon\/orchestrator"/);
    assert.match(out, /dry-run OK/);
    // Proof that nothing was set outside the dry-run.
    assert.equal(r.stderr, '');
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('--dry-run is idempotent: a clone already there becomes a pull --ff-only', { skip: LINUX_ONLY }, () => {
  const h = home();
  const dest = join(h, 'timon');
  try {
    mkdirSync(dest, { recursive: true });
    const init = spawnSync('git', ['init', '-q', dest], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const r = run(['--dry-run'], { env: envFor(h) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`\\+ git -C ${dest} pull --ff-only`));
    assert.doesNotMatch(r.stdout, /git clone /);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('Node < 20 is refused before any clone', { skip: LINUX_ONLY }, () => {
  const h = home();
  const bin = join(h, 'bin');
  try {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'node'), '#!/bin/sh\necho v18.19.0\n', { mode: 0o755 });
    linkSystemTools(bin);
    const r = run(['--dry-run'], { env: envFor(h, { PATH: bin }) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Node ≥ 20 required \(found v18\.19\.0\)/);
    assert.doesNotMatch(r.stdout + r.stderr, /git clone|systemctl/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('a missing git is refused', { skip: LINUX_ONLY }, () => {
  const h = home();
  const bin = join(h, 'bin');
  try {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'node'), '#!/bin/sh\necho v22.11.0\n', { mode: 0o755 });
    linkSystemTools(bin);
    const r = run(['--dry-run'], { env: envFor(h, { PATH: bin }) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /git not found/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('without --dry-run, a TIMON mission is refused (nothing is launched)', { skip: LINUX_ONLY }, () => {
  const h = home();
  try {
    const r = run([], { env: envFor(h, { TIMON_MISSION_ID: 'mission-temoin' }) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /TIMON mission/);
    assert.doesNotMatch(r.stdout + r.stderr, /systemctl|loginctl|git clone|npm ci/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('a live unit pointing elsewhere is refused, even in dry-run', { skip: LINUX_ONLY }, () => {
  const h = home();
  try {
    const unitDir = join(h, '.config', 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      join(unitDir, 'timon-orchestrator.service'),
      '[Service]\nWorkingDirectory=/ailleurs/orchestrator\n',
    );
    const r = run(['--dry-run'], { env: envFor(h) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /live unit points elsewhere/);
    assert.doesNotMatch(r.stdout + r.stderr, /\+ systemctl/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('an existing target folder outside git is refused', { skip: LINUX_ONLY }, () => {
  const h = home();
  try {
    mkdirSync(join(h, 'timon'), { recursive: true });
    writeFileSync(join(h, 'timon', 'pas-git'), 'x');
    const r = run(['--dry-run'], { env: envFor(h) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not a git repo/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});
