/**
 * A refusal of the mission fence, named: what a launch hands its CLI, what the
 * policy refuses of it, and what a bounced turn's output says it was refused.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config/load.js';
import { resolveFence, systemWritableFolders, type FencePolicy } from './host/isolation.js';
import {
  fencePreflight, fenceRefusal, fenceRefusalInOutput, fenceRefusalMessage, fenceSuspicionMessage, launchFenceNeeds,
  pathlessRefusalIn, toolResultTexts,
} from './fence-refusal.js';

const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-fence-refusal-')));
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }));
const HOME = join(ROOT, 'home');
const TH = join(HOME, '.timon');
const MISSION = '11111111-2222-3333-4444-555555555555';
const SCRATCH = join(TH, 'provider-runs', 'provider-codex', MISSION);
const PROJECT = join(HOME, 'project');
for (const dir of [SCRATCH, join(TH, 'run'), join(TH, 'tmp', 'missions', MISSION), join(HOME, '.ssh'), PROJECT]) mkdirSync(dir, { recursive: true });
writeFileSync(join(TH, 'daemon-token'), '');
writeFileSync(join(SCRATCH, 'config.toml'), '');

// The fence exists on Linux and macOS only: a Windows path escapes its backslashes in a JSON value, and a CLI's refusal names a POSIX path.
const POSIX_ONLY = { skip: process.platform === 'win32' && 'the fence exists on Linux and macOS only' };

/** The policy without the system folders every program writes to: this suite's homes sit in one of them. */
function policy(target: Partial<Parameters<typeof resolveFence>[1]> = {}): FencePolicy {
  const cfg = config();
  const system = systemWritableFolders('linux');
  const resolved = resolveFence({ ...cfg, host: { ...cfg.host, isolation: { ...cfg.host.isolation, filesystem: 'auto' } } }, {
    timonHome: TH, home: HOME, platform: 'linux', cwd: PROJECT, missionId: MISSION, providerPlugin: 'provider-codex', backend: 'codex', ...target,
  });
  return { ...resolved, rw: resolved.rw.filter((path) => !system.includes(path)) };
}

test('the needs of a launch: Timon home paths of its arguments, environment and folder, state folders written', POSIX_ONLY, () => {
  const needs = launchFenceNeeds({
    cmd: '/usr/bin/codex',
    args: ['exec', '-c', `model_instructions_file="${join(SCRATCH, 'system-prompt.md')}"`, '--json', JSON.stringify({ path: join(TH, 'skills', 'x') }), '/elsewhere/file'],
    env: { CODEX_HOME: SCRATCH, TIMON_HOME: TH, PATH: `/usr/bin:${join(TH, 'bin')}` },
    cwd: PROJECT,
    workspace: 'rw',
  }, TH);
  const by = Object.fromEntries(needs.map((need) => [need.path, need.access]));
  assert.equal(by[join(SCRATCH, 'system-prompt.md')], 'read');
  assert.equal(by[join(TH, 'skills', 'x')], 'read', 'a path inside a JSON value');
  assert.equal(by[SCRATCH], 'write', 'a *_HOME variable names a folder the CLI writes');
  assert.equal(by[join(TH, 'bin')], 'read', 'each entry of a PATH-like value');
  assert.equal(by[TH], undefined, 'the Timon home itself is never a need');
  assert.equal(by['/elsewhere/file'], undefined, 'outside the Timon home: the fence reads the system anyway');
  assert.equal(by[PROJECT], undefined);
});

test('the preflight passes a launch whose folders the fence opens', () => {
  const needs = launchFenceNeeds({ args: [], env: { CODEX_HOME: SCRATCH, TMPDIR: join(TH, 'tmp', 'missions', MISSION) }, workspace: 'rw' }, TH);
  assert.equal(needs.length, 2);
  assert.equal(fencePreflight(policy(), needs), null);
});

test('the preflight names a refused path, and why the fence dropped its own grant', () => {
  const refused = fencePreflight(policy(), launchFenceNeeds({ args: ['--config', join(TH, 'run', 'x.toml')], workspace: 'rw' }, TH));
  assert.equal(refused?.path, join(TH, 'run', 'x.toml'));
  assert.equal(refused?.access, 'read');
  // A mission folder that was not made before the fence was computed: a silent hole until now.
  const other = '99999999-2222-3333-4444-555555555555';
  const missing = join(TH, 'provider-runs', 'provider-codex', other);
  const dropped = fencePreflight(policy({ missionId: other }), launchFenceNeeds({ args: [], env: { CODEX_HOME: missing }, workspace: 'rw' }, TH));
  assert.equal(dropped?.path, missing);
  assert.equal(dropped?.access, 'write');
  assert.match(dropped?.dropped ?? '', /does not resolve to an existing file or folder/);
});

test('a refusal in a CLI\'s output is the fence\'s only when the policy refuses it and the OS would not', POSIX_ONLY, () => {
  const p = policy();
  const yes = () => true;
  const token = join(TH, 'daemon-token');
  assert.deepEqual(fenceRefusalInOutput(`Error: EACCES: permission denied, open '${token}'`, p, { osAllows: yes }), { path: token, access: 'read' });
  const dotfile = join(HOME, '.gitconfig');
  assert.deepEqual(fenceRefusalInOutput(`fatal: could not lock config file ${dotfile}: Operation not permitted`, p, { osAllows: yes }), { path: dotfile, access: 'write' });
  assert.equal(fenceRefusalInOutput(`EACCES: permission denied, mkdir '/usr/lib/x'`, p, { osAllows: () => false }), null, 'the OS refuses it anyway');
  assert.equal(fenceRefusalInOutput('Error: Operation not permitted (os error 1)', p, { osAllows: yes }), null, 'no path, nothing guessed');
  assert.equal(fenceRefusalInOutput(`wrote ${token}`, p, { osAllows: yes }), null, 'no refusal words');
  assert.equal(fenceRefusalInOutput(`permission denied: ${join(PROJECT, 'a')}`, p, { osAllows: yes }), null, 'the fence opens the working folder');
});

test('the structured refusal: Timon home and credentials are never grantable, the rest is', () => {
  const p = policy();
  const base = { stage: 'run' as const, policy: p, mechanism: 'seatbelt' as const, missionId: MISSION, agent: 'a', backend: 'codex', timonHome: TH, home: HOME };
  const inHome = fenceRefusal({ ...base, path: join(TH, 'daemon-token'), access: 'read' });
  assert.equal(inHome.timonHome, true);
  assert.equal(inHome.grantable, false);
  assert.equal(inHome.display, join('~', '.timon', 'daemon-token'));
  assert.match(fenceRefusalMessage(inHome), /defect of Timon/);
  const homeMessage = fenceRefusalMessage(inHome);
  assert.ok(homeMessage.indexOf('~/.timon/daemon-token') < homeMessage.indexOf('extra folders'), 'the path comes first, then the targeted setting');
  assert.ok(homeMessage.indexOf('extra folders') < homeMessage.indexOf('Mission isolation to Off'), 'turning the isolation off comes last');
  assert.match(homeMessage, /Last resort only/);
  assert.match(fenceRefusalMessage(inHome), /Seatbelt/);
  const ssh = fenceRefusal({ ...base, path: join(HOME, '.ssh', 'id_ed25519'), access: 'read' });
  assert.equal(ssh.timonHome, false);
  assert.equal(ssh.grantable, false, 'a credential folder stays closed');
  const cache = fenceRefusal({ ...base, path: join(HOME, '.cache', 'tool'), access: 'write' });
  assert.equal(cache.grantable, true);
  assert.match(fenceRefusalMessage(cache), /writable exceptions in Settings › System › Security/);
  assert.deepEqual(cache.setting, { category: 'system', tab: 'security' });
});

test('the text of each tool result of a normalised user event, as a string or as text blocks', () => {
  const payload = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'cat: /x: Permission denied' },
        { type: 'text', text: 'not a tool output' },
        { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'one' }, { type: 'image', source: {} }, { type: 'text', text: 'two' }] },
        { type: 'tool_result', tool_use_id: 'c', content: '' },
      ],
    },
  };
  assert.deepEqual(toolResultTexts(payload), ['cat: /x: Permission denied', 'one\ntwo']);
  assert.deepEqual(toolResultTexts(null), []);
  assert.deepEqual(toolResultTexts({ message: { content: 'plain' } }), []);
  assert.equal(toolResultTexts({ message: { content: [{ type: 'tool_result', content: 'x'.repeat(300_000) }] } })[0]?.length, 200_000);
});

test('a refusal naming no path is a suspicion; one naming a path is left to the policy check', () => {
  assert.equal(pathlessRefusalIn('Error: Operation not permitted (os error 1)\n'), 'Error: Operation not permitted (os error 1)');
  assert.equal(pathlessRefusalIn('starting\nfailed: EPERM\n'), 'failed: EPERM');
  assert.equal(pathlessRefusalIn('cat: /home/me/x: Operation not permitted'), null, 'a path: fenceRefusalInOutput decides');
  assert.equal(pathlessRefusalIn("open '/etc/x': os error 1"), null);
  assert.equal(pathlessRefusalIn('all good'), null);
  assert.equal(pathlessRefusalIn(''), null);
  assert.equal(pathlessRefusalIn(`Operation not permitted ${'x'.repeat(400)}`)?.length, 200);
  const message = fenceSuspicionMessage({
    missionId: MISSION, agent: 'a', backend: 'codex', mechanism: 'seatbelt', stage: 'run',
    said: 'Operation not permitted (os error 1)', setting: { category: 'system', tab: 'security' },
  });
  assert.match(message, /the macOS sandbox \(Seatbelt\)/);
  assert.match(message, /Settings › System › Security/);
  assert.match(message, /extra folders/);
});
