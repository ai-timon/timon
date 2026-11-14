/**
 * The provider cards can install an AI CLI: the vendor's official installer,
 * chosen from a closed list (the routes: `provider-cli-routes.test.ts`). The
 * refusals matter most; no test here ever runs a real installer.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../tests/helpers/paid-license.js');
const { desktopBundled, PROVIDER_CLI_NAMES, runInstallBackend, setupBackends } = await import('./onboarding.js');
const { installBackendPlanFor } = await import('./host/machine.js');

const NO_VERSION = () => ({ version: null, latest: null, updateAvailable: false, unsupportedVersion: false });

test('the official installers: per user, no Node, one line that works in CMD too', () => {
  assert.deepEqual(installBackendPlanFor('claude', 'linux')?.argv, ['/bin/sh', '-c', 'curl -fsSL https://claude.ai/install.sh | bash']);
  assert.equal(installBackendPlanFor('codex', 'darwin')?.display, 'curl -fsSL https://chatgpt.com/codex/install.sh | sh');
  const win = installBackendPlanFor('claude', 'win32')!;
  assert.equal(win.argv[0], 'powershell');
  assert.equal(win.argv.at(-1), 'irm https://claude.ai/install.ps1 | iex');
  assert.equal(win.display, 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"');
  for (const name of ['claude', 'codex', 'grok', 'copilot'] as const) {
    for (const platform of ['linux', 'darwin', 'win32'] as const) assert.equal(installBackendPlanFor(name, platform)?.elevated, false);
  }
});

test('more vendors, each with its own documented line, and none made up', () => {
  assert.equal(installBackendPlanFor('grok', 'linux')?.display, 'curl -fsSL https://x.ai/cli/install.sh | bash');
  assert.equal(installBackendPlanFor('grok', 'win32')?.argv.at(-1), 'irm https://x.ai/cli/install.ps1 | iex');
  // A CLI already there updates itself, none yet gets the vendor's script (TODO #789): `tests/copilot-update-line.test.ts`.
  assert.match(installBackendPlanFor('copilot', 'darwin')?.display ?? '', /then copilot update;else curl -fsSL https:\/\/gh\.io\/copilot-install\|bash;fi$/);
  // A fresh Windows: winget with the flags without which it stops on the source's terms (TIM-0022).
  // A CLI already there: its own `copilot update`, since winget's record drifts from it (TIM-0138).
  const copilotWin = installBackendPlanFor('copilot', 'win32')?.argv.at(-1) ?? '';
  // After the update, an explicit exit with the CLI's own code: a failed update is a failed job.
  assert.match(copilotWin, /if \(Get-Command copilot -ErrorAction SilentlyContinue\) \{ copilot update; exit \(Get-Variable LASTEXITCODE -ValueOnly\) \} else \{ winget install .*--accept-source-agreements .*--id GitHub\.Copilot \}$/);
  assert.match(copilotWin, /GetEnvironmentVariable\('Path', 'User'\)/);
  assert.match(copilotWin, /GetEnvironmentVariable\('Path', 'Machine'\)/);
  assert.ok(copilotWin.length <= 500, `${copilotWin.length} characters`);
  // Shown inside `-Command "…"` for pasting into PowerShell or CMD. A `"` ends the quoting; a `$`
  // is expanded by a PowerShell paste, and the backtick escaping it there reaches the inner shell
  // intact from a CMD paste: no escape works for both, hence `Get-Variable` over `$LASTEXITCODE`.
  assert.ok(!/["$]/.test(copilotWin), copilotWin);
  assert.equal(installBackendPlanFor('opencode', 'linux')?.display, 'curl -fsSL https://opencode.ai/install | bash');
  // opencode documents package managers on Windows, no script: the card links to its page.
  assert.equal(installBackendPlanFor('opencode', 'win32'), null);
  const win = setupBackends('win32', () => null, () => null, NO_VERSION).find((b) => b.name === 'opencode')!;
  assert.equal(win.installable, false);
  assert.equal(win.installCommand, null);
  assert.equal(win.installDocs, 'https://opencode.ai/docs/');
  // pi.dev gives both sides; the installer writes `pi` itself, the CLI the provider drives over RPC.
  assert.equal(installBackendPlanFor('pi', 'linux')?.display, 'curl -fsSL https://pi.dev/install.sh | sh');
  assert.equal(installBackendPlanFor('pi', 'darwin')?.display, 'curl -fsSL https://pi.dev/install.sh | sh');
  assert.deepEqual(installBackendPlanFor('pi', 'win32')?.argv, ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://pi.dev/install.ps1 | iex']);
  for (const platform of ['linux', 'darwin', 'win32'] as const) assert.equal(installBackendPlanFor('pi', platform)?.elevated, false);
});

test('opencode 2 found: the card offers neither Install nor Update, which would replace it with opencode 1', () => {
  const v2 = () => ({ version: '2.0.0', latest: '1.14.29', updateAvailable: false, unsupportedVersion: true });
  const card = setupBackends('linux', (name) => (name === 'opencode' ? '/home/ann/.opencode/bin/opencode' : null), () => null, v2)
    .find((b) => b.name === 'opencode')!;
  assert.equal(card.unsupportedVersion, true);
  assert.equal(card.installable, false);
  assert.equal(card.installCommand, null);
  assert.equal(card.updateAvailable, false);
  assert.equal(card.installDocs, 'https://opencode.ai/docs/');
});

test('a provider without an installer is a card with its vendor\'s page, never a command', () => {
  assert.deepEqual([...PROVIDER_CLI_NAMES], ['claude', 'codex', 'grok', 'copilot', 'opencode', 'hermes-acp', 'pi', 'agy']);
  for (const card of setupBackends('linux', () => null, () => null, NO_VERSION)) {
    if (card.installable) assert.ok(card.installCommand, card.name);
    else assert.ok(card.installDocs?.startsWith('https://'), card.name);
  }
  const hermes = setupBackends('linux', () => null, () => null, NO_VERSION).find((b) => b.name === 'hermes-acp')!;
  assert.equal(hermes.installable, false);
});

test('Antigravity: Google\'s own installer on each system, and its sign-in on the resolved path', () => {
  for (const [platform, installer] of [['linux', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'], ['win32', 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"']] as const) {
    const card = setupBackends(platform, () => null, () => null, NO_VERSION).find((b) => b.name === 'agy')!;
    assert.equal(card.installable, true, platform);
    assert.equal(card.installCommand, installer, platform);
  }
  const found = setupBackends('linux', (name) => (name === 'agy' ? '/home/ann/.local/bin/agy' : null), () => null, NO_VERSION).find((b) => b.name === 'agy')!;
  assert.equal(found.signInCommand, '/home/ann/.local/bin/agy acp --login');
});

test('sign-in lines are built on the resolved path, quoted for the shell that will read them', () => {
  const found = setupBackends('win32', (name) => (name === 'codex' ? 'C:\\Users\\Ann Lee\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe' : null), () => false, NO_VERSION);
  assert.deepEqual(found.slice(0, 2).map((b) => b.name), ['claude', 'codex']);
  assert.equal(found[0]!.signInCommand, 'claude');
  assert.equal(found[0]!.signedIn, null);
  assert.equal(found[1]!.signInCommand, '& "C:\\Users\\Ann Lee\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe" login');
  assert.equal(found[1]!.signedIn, false);
  const posix = setupBackends('linux', () => '/home/ann/.local/bin/claude', () => true, NO_VERSION);
  assert.equal(posix[0]!.signInCommand, '/home/ann/.local/bin/claude');
  assert.equal(posix[1]!.signInCommand, '/home/ann/.local/bin/claude login');
});

test('an install is a success only once the daemon finds the binary', async () => {
  const ok = async () => ({ code: 0, stdout: '', stderr: '' });
  const found = await runInstallBackend('claude', 'linux', ok, () => '/home/ann/.local/bin/claude');
  assert.equal(found.ok, true);
  const lost = await runInstallBackend('claude', 'linux', ok, () => null);
  assert.equal(lost.ok, false);
  assert.equal(lost.command, 'curl -fsSL https://claude.ai/install.sh | bash');
  const failed = await runInstallBackend('codex', 'win32', async () => ({ code: 1, stdout: '', stderr: 'Invoke-WebRequest: unable to connect' }), () => null);
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? '', /unable to connect \(exit 1\)/);
});

test('a failed Copilot update on Windows is a failed job, though the CLI is still found (TIM-0138)', async () => {
  // The exit code comes from the line's explicit `exit` after `copilot update` (asserted above);
  // no PowerShell runs here, so this locks what the daemon does with it: the old binary still
  // being where Timon looks must not turn a non-zero exit into a success.
  const calls: string[][] = [];
  const failed = await runInstallBackend('copilot', 'win32', async (command, args) => {
    calls.push([command, ...args]);
    return { code: 1, stdout: '', stderr: 'copilot: failed to download the update: network unreachable' };
  }, () => 'C:\\Users\\ann\\AppData\\Roaming\\npm\\copilot.cmd');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], 'powershell');
  assert.match(calls[0]!.at(-1) ?? '', /copilot update; exit \(Get-Variable LASTEXITCODE -ValueOnly\)/);
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? '', /network unreachable \(exit 1\)/);
  assert.match(failed.lines[0] ?? '', / → 1$/);
});

test('a CLI shipped inside a desktop app is flagged, so Install stays offered', () => {
  assert.equal(desktopBundled('codex', '/Applications/ChatGPT.app/Contents/Resources/codex', 'darwin'), true);
  assert.equal(desktopBundled('claude', '/Users/ann/.local/bin/claude', 'darwin'), false);
  assert.equal(desktopBundled('codex', '/home/ann/.local/bin/codex', 'linux'), false);
  const mac = setupBackends('darwin', (name) => (name === 'codex' ? '/Applications/Codex.app/Contents/Resources/codex' : null), () => true, NO_VERSION);
  assert.equal(mac[1]!.bundled, true);
  assert.equal(mac[0]!.bundled, false);
});

test('an installer that exits 0 without installing says why', async () => {
  const res = await runInstallBackend('claude', 'linux', async () => ({ code: 0, stdout: '', stderr: 'sh: 1: curl: not found' }), () => null);
  assert.match(res.reason ?? '', /curl: not found/);
});

test('the CLI of the Claude desktop app is signed in where it lies, with what to type once it runs', () => {
  const bundled = '/Users/ann/Library/Application Support/Claude/claude-code/2.1.275/claude.app/Contents/MacOS/claude';
  const [claude, codex] = setupBackends('darwin', (name) => (name === 'claude' ? bundled : null), () => false, NO_VERSION);
  assert.equal(claude!.bundled, true);
  assert.equal(claude!.signedIn, false);
  assert.equal(claude!.signInCommand, `"${bundled}"`, 'no install needed: the sign-in runs the copy the app ships');
  assert.equal(claude!.signInThen, '/login');
  assert.equal(codex!.signInThen, null);
});
