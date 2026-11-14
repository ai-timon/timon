/**
 * The Seatbelt profile of a mission, rendered from the fence policy. Pure, so
 * it runs on every platform; the real `sandbox-exec` run is in `darwin.test.ts`.
 *
 * The strongest assertion here is the small evaluator below: it reads the
 * profile back the way Seatbelt does (everything allowed, last matching rule
 * wins) and must agree with `fenceAccess`, the reference semantics of the
 * policy, on every path a mission may try.
 */
import '../test-home.js';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TimonConfigSchema } from '../config/schema.js';
import { fenceAccess, resolveFence, type FencePolicy } from './isolation.js';
import {
  canonicalPaths, MDNS_RESPONDER_SOCKET, parseSeatbeltProbe, renderSeatbeltProfile, SANDBOX_EXEC,
  SeatbeltRenderError, sbplString, seatbeltLaunch,
} from './seatbelt.js';

const HOME = '/Users/tester';
const TH = `${HOME}/.timon`;
const WT = `${TH}/worktrees/m1`;

const cfg = (isolation: Record<string, unknown> = {}) => TimonConfigSchema.parse({ host: { isolation } });

function policyFor(isolation: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): FencePolicy {
  return resolveFence(cfg(isolation), {
    timonHome: TH, cwd: WT, home: HOME, platform: 'darwin', missionId: 'm1', agent: 'a1', project: 'p1',
    account: 'acc1', backend: 'claude', providerPlugin: 'claude', realpath: (path: string) => path, ...extra,
  });
}

/** Reverses `sbplString`, for the evaluator. */
function unquote(literal: string): string {
  return literal.replace(/\\(.)/g, (_, c: string) => ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[c] ?? c);
}

type Rule = { allow: boolean; ops: string[]; path: string };

const RULE = /^\((allow|deny) ([a-z*\- ]+?) \(subpath "((?:[^"\\]|\\.)*)"\)\)$/;

function rulesOf(text: string): Rule[] {
  return text.split('\n').flatMap((line) => {
    const match = RULE.exec(line);
    return match ? [{ allow: match[1] === 'allow', ops: (match[2] ?? '').split(' '), path: unquote(match[3] ?? '') }] : [];
  });
}

const under = (root: string, path: string) => root === '/' || path === root || path.startsWith(`${root}/`);

/**
 * What Seatbelt decides for `path`: `(allow default)`, then the last matching
 * rule wins. Executing is judged on its own rules, not inferred from reading:
 * the kernel maps an image without the process reading it.
 */
function evaluate(rules: readonly Rule[], path: string): { read: boolean; write: boolean; exec: boolean } {
  const decide = (op: string) => rules.reduce((allowed, rule) => (rule.ops.includes(op) && under(rule.path, path) ? rule.allow : allowed), true);
  return { read: decide('file-read-data'), write: decide('file-write*'), exec: decide('process-exec*') };
}

const PROBED_PATHS = [
  `${TH}/daemon-token`, `${TH}/secret-key`, `${TH}/timon.db`, `${TH}/timon.db-wal`, `${TH}/timon.config.json`,
  `${TH}/plugins/evil.js`, `${TH}/plugins-data/x`, `${TH}/browser-profiles/default/Cookies`, `${TH}/desktop-profile/x`,
  `${TH}/worktrees/m2/notes`, `${WT}/src/index.ts`, `${WT}/.git/HEAD`,
  `${TH}/skills/s1/SKILL.md`, `${TH}/agents/a1/SOUL.md`, `${TH}/agents/a1/memory/learnings.jsonl`, `${TH}/agents/a2/SOUL.md`,
  `${TH}/backend-accounts/acc1/.credentials.json`, `${TH}/backend-accounts/acc2/auth.json`,
  `${TH}/tmp/missions/m1/x`, `${TH}/tmp/missions/m2/x`, `${TH}/provider-cache/claude/x`, `${TH}/projects/p1/memory/notes.md`,
  `${HOME}/.ssh/id_ed25519`, `${HOME}/.codex/auth.json`, `${HOME}/.claude/settings.json`, `${HOME}/.gitconfig`,
  `${HOME}/.local/bin/git`, `${HOME}/Library/LaunchAgents/x.plist`, `${HOME}/.npm/x`,
  '/usr/bin/git', '/private/tmp/x', '/private/var/folders/ab/cd/T/x', '/dev/null', '/Applications/x',
];

test('the profile agrees with fenceAccess on every path a mission may try', () => {
  for (const policy of [policyFor(), policyFor({}, { account: undefined }), policyFor({ writable: ['~/.npm'] })]) {
    const rules = rulesOf(renderSeatbeltProfile(policy).text);
    for (const path of PROBED_PATHS) {
      assert.deepEqual(evaluate(rules, path), fenceAccess(policy, path), path);
    }
  }
});

test('the private files of the Timon home are refused, its own folders reopened', () => {
  const rules = rulesOf(renderSeatbeltProfile(policyFor()).text);
  for (const path of [`${TH}/daemon-token`, `${TH}/secret-key`, `${TH}/timon.db`, `${TH}/timon.config.json`]) {
    assert.deepEqual(evaluate(rules, path), { read: false, write: false, exec: false }, path);
  }
  assert.deepEqual(evaluate(rules, `${WT}/f`), { read: true, write: true, exec: true });
  assert.deepEqual(evaluate(rules, `${TH}/skills/s1/SKILL.md`), { read: true, write: false, exec: false });
  assert.deepEqual(evaluate(rules, `${HOME}/.gitconfig`), { read: true, write: false, exec: true });
});

test('the profile allows by default and refuses metadata nowhere, which git needs', () => {
  const text = renderSeatbeltProfile(policyFor()).text;
  assert.match(text, /^;; [^\n]*\n\(version 1\)\n\(allow default\)\n/);
  assert.doesNotMatch(text, /file-read\*/);
  assert.doesNotMatch(text, /file-read-metadata/);
});

test('Unix sockets are refused but the DNS resolver, unless the policy allows them', () => {
  const denied = renderSeatbeltProfile(policyFor()).text;
  assert.ok(denied.includes('(deny network-outbound (remote unix-socket))'));
  assert.ok(denied.includes(`(allow network-outbound (remote unix-socket (path-literal "${MDNS_RESPONDER_SOCKET}")))`));
  assert.ok(denied.indexOf('(deny network-outbound') < denied.indexOf('(allow network-outbound'));
  const allowed = renderSeatbeltProfile(policyFor({ unixSockets: 'allow' })).text;
  assert.doesNotMatch(allowed, /unix-socket/);
});

test('launchctl, LaunchServices and Apple Events are shut whatever the policy', () => {
  for (const policy of [policyFor(), policyFor({ unixSockets: 'allow' })]) {
    const text = renderSeatbeltProfile(policy).text;
    assert.ok(text.includes('(deny process-exec* (literal "/bin/launchctl"))'));
    assert.ok(text.includes('(deny lsopen)'));
    assert.ok(text.includes('(deny appleevent-send)'));
  }
});

test('on the very same path the refusal is emitted last, so it wins', () => {
  // The configuration makes the Timon home itself writable: refused, deeper or equal.
  const policy = policyFor({ writable: [TH] });
  const rules = rulesOf(renderSeatbeltProfile(policy).text);
  assert.equal(evaluate(rules, `${TH}/daemon-token`).read, false);
  for (const level of ['rw', 'ro', 'exec'] as const) {
    const exact = rulesOf(renderSeatbeltProfile({ ...policy, [level]: [...policy[level], `${HOME}/.ssh`] }).text);
    assert.deepEqual(evaluate(exact, `${HOME}/.ssh/id`), { read: false, write: false, exec: false }, level);
  }
  // Read-only beats read-write on the very same path too.
  const both = { ...policy, rw: [...policy.rw, `${HOME}/shared`], ro: [...policy.ro, `${HOME}/shared`] };
  assert.deepEqual(evaluate(rulesOf(renderSeatbeltProfile(both).text), `${HOME}/shared/f`), fenceAccess(both, `${HOME}/shared/f`));
  assert.equal(evaluate(rulesOf(renderSeatbeltProfile(both).text), `${HOME}/shared/f`).write, false);
});

test('a fence path is spelled as an escaped SBPL string', () => {
  assert.equal(sbplString('/Users/a b/c'), '"/Users/a b/c"');
  assert.equal(sbplString('/x/"q"'), '"/x/\\"q\\""');
  assert.equal(sbplString('/x/a\\b'), '"/x/a\\\\b"');
  assert.equal(sbplString('/x/\n\t\r'), '"/x/\\n\\t\\r"');
  assert.equal(sbplString('/Users/josé/日本'), '"/Users/josé/日本"');
  assert.throws(() => sbplString('/x/\u0001'), SeatbeltRenderError);
  assert.throws(() => sbplString('/x/\u007f'), SeatbeltRenderError);
});

test('a home with quotes, spaces and backslashes renders rules that still mean the same paths', () => {
  const home = '/Users/we ird"q\\b\tt';
  const th = `${home}/.timon`;
  const policy = resolveFence(cfg(), {
    timonHome: th, cwd: `${th}/worktrees/m1`, home, platform: 'darwin', missionId: 'm1', realpath: (path) => path,
  });
  const text = renderSeatbeltProfile(policy).text;
  assert.ok(text.includes('(deny file-read-data file-write* (subpath "/Users/we ird\\"q\\\\b\\tt/.timon"))'));
  const rules = rulesOf(text);
  assert.equal(evaluate(rules, `${th}/daemon-token`).read, false);
  assert.equal(evaluate(rules, `${th}/worktrees/m1/f`).write, true);
});

test('a path the profile cannot spell refuses the whole rendering, never a rule less', () => {
  const policy = policyFor();
  assert.throws(() => renderSeatbeltProfile({ ...policy, deny: [...policy.deny, '/x/\u0002'] }), SeatbeltRenderError);
  assert.throws(() => renderSeatbeltProfile({ ...policy, rw: [...policy.rw, 'relative/path'] }), /absolute/);
  assert.throws(() => renderSeatbeltProfile({ ...policy, enabled: false }), SeatbeltRenderError);
});

test('canonical spellings: the path as given, and resolved through its deepest existing ancestor', () => {
  const links: Record<string, string> = { '/tmp': '/private/tmp', '/Users/tester/.timon': '/Volumes/Data/timon', '/': '/' };
  const realpath = (path: string) => {
    if (path in links) return links[path] as string;
    if (path === '/Users' || path === '/Users/tester') return path;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  assert.deepEqual(canonicalPaths('/tmp/missing/x', realpath), ['/tmp/missing/x', '/private/tmp/missing/x']);
  assert.deepEqual(canonicalPaths('/Users/tester/.timon/worktrees/m1', realpath),
    ['/Users/tester/.timon/worktrees/m1', '/Volumes/Data/timon/worktrees/m1']);
  assert.deepEqual(canonicalPaths('/Users/tester/.gitconfig', realpath), ['/Users/tester/.gitconfig']);
  assert.deepEqual(canonicalPaths('/nowhere/at/all', (p) => { if (p === '/') return '/'; throw new Error('ENOENT'); }), ['/nowhere/at/all']);
});

test('a Timon home behind a link is refused under both spellings', () => {
  const spellings = (path: string) => (path === TH || path.startsWith(`${TH}/`) ? [path, path.replace(TH, '/Volumes/Data/timon')] : [path]);
  const rules = rulesOf(renderSeatbeltProfile(policyFor(), { spellings }).text);
  for (const root of [TH, '/Volumes/Data/timon']) {
    assert.equal(evaluate(rules, `${root}/daemon-token`).read, false, root);
    assert.equal(evaluate(rules, `${root}/worktrees/m1/f`).write, true, root);
  }
});

test('a grant that resolves onto a private entry of the Timon home is dropped', () => {
  // The working folder is a link into the browser profiles: the profile must not reopen them.
  const cwd = '/Users/tester/project';
  const policy = policyFor({}, { cwd });
  const spellings = (path: string) => (path === cwd ? [path, `${TH}/browser-profiles/default`] : [path]);
  const profile = renderSeatbeltProfile(policy, { spellings });
  assert.deepEqual(profile.dropped.map((d) => d.path), [`${TH}/browser-profiles/default`]);
  const rules = rulesOf(profile.text);
  assert.equal(evaluate(rules, `${TH}/browser-profiles/default/Cookies`).read, false);
  assert.equal(evaluate(rules, `${cwd}/f`).write, true);
});

test('sandbox-exec is launched by absolute path and exec()s the command after --', () => {
  assert.deepEqual(seatbeltLaunch('/p/fence.sb', '/opt/claude', ['-p', '--flag']), {
    cmd: SANDBOX_EXEC, args: ['-f', '/p/fence.sb', '--', '/opt/claude', '-p', '--flag'],
  });
  assert.equal(SANDBOX_EXEC, '/usr/bin/sandbox-exec');
});

test('the probe tells a nested sandbox from a missing sandbox-exec', () => {
  assert.deepEqual(parseSeatbeltProbe(0, ''), { available: true });
  assert.match(parseSeatbeltProbe(71, 'sandbox-exec: sandbox_apply: Operation not permitted\n').reason ?? '', /already runs inside a sandbox/);
  assert.match(parseSeatbeltProbe(null, '', new Error('spawn /usr/bin/sandbox-exec ENOENT')).reason ?? '', /cannot run .*ENOENT/);
  assert.match(parseSeatbeltProbe(65, 'sandbox-exec: unbound variable: x\nBacktrace\n').reason ?? '', /failed \(sandbox-exec: unbound variable: x\)/);
  assert.match(parseSeatbeltProbe(1, '').reason ?? '', /exit 1/);
});
