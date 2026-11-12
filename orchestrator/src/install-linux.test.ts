/**
 * `scripts/install-linux.sh` — parse et dry-run. Le script est pour un VPS :
 * on ne l'exécute pas (ça écrirait l'unit live et appellerait systemctl).
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
  // Chemin absolu : un PATH de test réduit à un faux `node` ne doit pas
  // empêcher de trouver bash (Node résout l'exécutable dans options.env.PATH).
  return spawnSync('/usr/bin/bash', [script, ...args], {
    encoding: 'utf8',
    ...opts,
  });
}

test('bash -n : le script parse', () => {
  const r = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('--dry-run : clone, builds, unit avec installDir, linger, enable --now, doctor — zéro systemctl réel', () => {
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
    // Preuve qu'on n'a rien posé hors du dry-run.
    assert.equal(r.stderr, '');
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('--dry-run est idempotent : un clone déjà là devient un pull --ff-only', () => {
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

test('Node < 20 est refusé avant tout clone', () => {
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

test('git absent est refusé', () => {
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

test('sans --dry-run, une mission TIMON est refusée (rien n\'est lancé)', () => {
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

test('une unit live qui pointe ailleurs est refusée, même en dry-run', () => {
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

test('un dossier cible existant hors git est refusé', () => {
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
