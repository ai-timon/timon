/**
 * Machine detection (step 5.7.1) — every case is a FIXTURE.
 *
 * Onboarding is blocking now: what this file computes decides whether a user
 * is offered an install command or a dead end. It must therefore answer for
 * machines this one is not, and it must answer without a network, without
 * `/etc/os-release` and without executing anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installCommandFor,
  installPlanFor,
  linuxRelease,
  type Machine,
  parseOsRelease,
  readOsRelease,
  supervisorFor,
} from './machine.js';

/** A desktop derivative of Ubuntu, as `/etc/os-release` describes it. */
const DERIVED = `PRETTY_NAME="Example OS 18"
NAME="Example OS"
ID=exampleos
ID_LIKE="ubuntu debian"
VERSION_CODENAME=noble
`;

test('quoted values, comments and empty lines are handled', () => {
  const parsed = parseOsRelease(`# a comment\n\nID=fedora\nPRETTY_NAME="Fedora Linux 41"\nEMPTY=\n`);
  assert.equal(parsed['ID'], 'fedora');
  assert.equal(parsed['PRETTY_NAME'], 'Fedora Linux 41');
  assert.equal(parsed['EMPTY'], '');
});

test('a known distro gives its manager', () => {
  assert.equal(linuxRelease(parseOsRelease('ID=fedora\n'))?.packageManager, 'dnf');
  assert.equal(linuxRelease(parseOsRelease('ID=arch\n'))?.packageManager, 'pacman');
  assert.equal(linuxRelease(parseOsRelease('ID=alpine\n'))?.packageManager, 'apk');
});

/**
 * The case that matters: `exampleos` is in no list of distributions, and yet
 * `apt` is the right answer. That is exactly what `ID_LIKE` is for.
 */
test('an unknown derived distro falls back on the manager of its base', () => {
  const derived = linuxRelease(parseOsRelease(DERIVED));
  assert.equal(derived?.id, 'exampleos');
  assert.deepEqual(derived?.idLike, ['ubuntu', 'debian']);
  assert.equal(derived?.packageManager, 'apt');
  assert.equal(derived?.prettyName, 'Example OS 18');

  const exotic = linuxRelease(parseOsRelease('ID=neverheardof\nID_LIKE="debian"\n'));
  assert.equal(exotic?.packageManager, 'apt');
});

test('the order of ID_LIKE is respected', () => {
  const r = linuxRelease(parseOsRelease('ID=x\nID_LIKE="ubuntu fedora"\n'));
  assert.equal(r?.packageManager, 'apt');
});

test('a totally unknown distro says so, it does not guess', () => {
  const r = linuxRelease(parseOsRelease('ID=mystery\n'));
  assert.equal(r?.id, 'mystery');
  assert.equal(r?.packageManager, null, 'better no command than a wrong one');
});

test('without /etc/os-release, detection returns null without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-osrelease-'));
  assert.equal(readOsRelease(join(dir, 'absent')), null);
  assert.equal(linuxRelease(null), null);

  const file = join(dir, 'os-release');
  writeFileSync(file, DERIVED);
  assert.equal(linuxRelease(readOsRelease(file))?.packageManager, 'apt');
});

/**
 * Two independent axes: Alpine has a package manager (`apk`) and
 * NO supervisor Timon can install (OpenRC, outside v1). Mixing up the
 * two would offer a service install that cannot succeed.
 */
test('package and supervisor are two distinct axes', () => {
  assert.equal(linuxRelease(parseOsRelease('ID=alpine\n'))?.packageManager, 'apk');
  assert.equal(supervisorFor('linux', { systemd: false }), null);
  assert.equal(supervisorFor('linux', { systemd: true }), 'systemd-user');
  assert.equal(supervisorFor('darwin', { systemd: false }), 'launchd');
  assert.equal(supervisorFor('win32', { systemd: false }), 'windows');
  // TODO #342: Windows does not launch the task for this account → portable mode.
  assert.equal(supervisorFor('win32', { systemd: false, windowsTaskRefused: true }), null);
  assert.equal(supervisorFor('darwin', { systemd: false, windowsTaskRefused: true }), 'launchd');
});

test('each missing binary comes with the command of THIS machine', () => {
  const apt = { platform: 'linux' as NodeJS.Platform, packageManager: 'apt' as const };
  assert.equal(installCommandFor('git', apt), 'sudo apt-get install -y git');
  assert.equal(installCommandFor('node', apt), 'sudo apt-get install -y nodejs');
  assert.equal(installCommandFor('docker', apt), 'sudo apt-get install -y docker.io');

  // The LLM backends are npm packages: same command everywhere.
  for (const machine of [apt, { platform: 'win32' as NodeJS.Platform, packageManager: null }]) {
    assert.equal(installCommandFor('claude', machine), 'npm install -g @anthropic-ai/claude-code');
    assert.equal(installCommandFor('copilot', machine), 'npm install -g @github/copilot');
  }
  assert.equal(installCommandFor('copilot', { platform: 'darwin', packageManager: null }), 'npm install -g @github/copilot');

  assert.equal(installCommandFor('git', { platform: 'darwin', packageManager: null }), 'brew install git');
  assert.equal(installCommandFor('node', { platform: 'darwin', packageManager: null }), 'Install Node.js 22 in ~/.local');
  assert.equal(
    installCommandFor('codex', { platform: 'darwin', packageManager: null }),
    'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
  );
  assert.equal(installCommandFor('claude', { platform: 'darwin', packageManager: null }), null);
  assert.equal(installCommandFor('git', { platform: 'win32', packageManager: null }), 'winget install -e --source winget --accept-source-agreements --accept-package-agreements --id Git.Git');
  assert.equal(installCommandFor('git', { platform: 'linux', packageManager: null }), null);
});

/**
 * Tailscale is in the default repositories of no distribution: the generic
 * branch would produce `sudo apt-get install -y tailscale`, a command that
 * fails on a fresh machine. Its official installer adds the vendor
 * repository first: the step the package name silently assumes.
 */
test('tailscale goes through its official installer, never through the distribution repository', () => {
  for (const packageManager of ['apt', 'dnf', 'pacman', 'zypper', 'apk', null] as const) {
    assert.equal(
      installCommandFor('tailscale', { platform: 'linux', packageManager }),
      'curl -fsSL https://tailscale.com/install.sh | sudo sh',
    );
  }
  // The script runs under `sudo`: the command is shown, it is not run.
  assert.equal(installPlanFor('tailscale', { platform: 'linux', packageManager: 'apt' })?.elevated, true);

  assert.equal(
    installCommandFor('tailscale', { platform: 'darwin', packageManager: null }),
    'curl -fsSLo "$TMPDIR/Tailscale.pkg" https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg && sudo installer -pkg "$TMPDIR/Tailscale.pkg" -target /',
  );
  // No Homebrew on most Macs (25/10/2026): the vendor's package, and shown, never run (sudo inside).
  assert.equal(installPlanFor('tailscale', { platform: 'darwin', packageManager: null })?.elevated, true);
  assert.equal(
    installCommandFor('tailscale', { platform: 'win32', packageManager: null }),
    'winget install -e --source winget --accept-source-agreements --accept-package-agreements --id tailscale.tailscale',
  );
});

/**
 * Better no command than a false one — the doctrine written above
 * `installCommandFor`, applied to Grok.
 *
 * Grok is not an npm package and no distribution ships it, so it used to fall
 * through to the generic package-manager branch and produce
 * `sudo apt-get install -y grok`: a command that fails in the user's terminal
 * for a reason we invented. Its vendor now publishes an installer, and that is
 * the only line it gets, whatever the package manager.
 */
test('grok gets xAI\'s own installer on every machine, never a package-manager guess', () => {
  const machines: Machine[] = [
    { platform: 'linux', packageManager: 'apt' },
    { platform: 'linux', packageManager: 'dnf' },
    { platform: 'linux', packageManager: 'pacman' },
    { platform: 'linux', packageManager: null },
    { platform: 'win32', packageManager: null },
    { platform: 'win32', packageManager: 'winget' },
    { platform: 'darwin', packageManager: null },
    { platform: 'darwin', packageManager: 'brew' },
  ];
  for (const machine of machines) {
    const command = installCommandFor('grok', machine) ?? '';
    assert.match(command, machine.platform === 'win32' ? /irm https:\/\/x\.ai\/cli\/install\.ps1 \| iex/ : /^curl -fsSL https:\/\/x\.ai\/cli\/install\.sh \| bash$/, `${machine.platform}/${machine.packageManager}`);
    assert.equal(installPlanFor('grok', machine)?.elevated, false);
  }
  assert.equal(installCommandFor('codex', { platform: 'linux', packageManager: 'apt' }), 'npm install -g @openai/codex');
  assert.equal(installCommandFor('claude', { platform: 'linux', packageManager: 'apt' }), 'npm install -g @anthropic-ai/claude-code');
});

test('a provider install script runs non-interactive on Windows, so a vendor prompt fails instead of hanging', () => {
  const plan = installPlanFor('grok', { platform: 'win32', packageManager: null });
  assert.ok(plan);
  assert.deepEqual(plan.argv.slice(0, 6), ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
  assert.match(plan.display, /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "irm https:\/\/x\.ai\/cli\/install\.ps1 \| iex"$/);
});

test('TIM-0022: winget installs unattended, off the msstore source', () => {
  const plan = installPlanFor('node', { platform: 'win32', packageManager: null });
  assert.ok(plan);
  for (const flag of ['--source', 'winget', '--accept-source-agreements', '--accept-package-agreements']) {
    assert.ok(plan.argv.includes(flag), flag);
  }
  assert.equal(plan.argv.at(-1), 'OpenJS.NodeJS.LTS');
  assert.equal(plan.argv.at(-2), '--id');
});
