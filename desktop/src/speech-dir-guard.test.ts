// french-ok-file: an accented user name, the non-ASCII home under test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import {
  ensureSharedSpeechDir,
  guardedChain,
  lockedDown,
  parseSecuritySnapshot,
  prepareSpeechModels,
  SharedDirRefused,
  sharedSpeechDirRemovable,
  SID_ADMINISTRATORS,
  SID_SYSTEM,
  windowsSecurityProbe,
  type AclEntry,
  type GuardFs,
  type PathSecurity,
  type SecurityProbe,
} from './speech-dir-guard.js';
import { speechModelsDirPlan } from './speech-paths.js';

const ME = 'S-1-5-21-1111-2222-3333-1001';
const OTHER = 'S-1-5-21-1111-2222-3333-1002';
const USERS = 'S-1-5-32-545';
const HOME = 'C:\\Users\\Zoé\\.timon';
const ENV = { ProgramData: 'C:\\ProgramData', PUBLIC: 'C:\\Users\\Public', SystemDrive: 'C:' };

type Node = { owner: string; protected: boolean; entries: AclEntry[]; reparse?: boolean };

/** What ProgramData hands down to a folder: Users may add entries in it. */
const inheritedFor = (owner: string): AclEntry[] => [
  { sid: SID_SYSTEM, allow: true, inherited: true },
  { sid: SID_ADMINISTRATORS, allow: true, inherited: true },
  { sid: owner, allow: true, inherited: true },
  { sid: USERS, allow: true, inherited: true },
];

/** An NTFS volume in memory, seen by one account (`as`). */
function volume(as = ME) {
  const nodes = new Map<string, Node>([['c:\\programdata', { owner: SID_SYSTEM, protected: true, entries: [] }]]);
  const key = (path: string): string => win32.resolve(path).toLowerCase();
  const calls: string[] = [];
  const hooks: { afterMkdir?: (dir: string) => void } = {};
  const put = (path: string, node: Node): void => { nodes.set(key(path), node); };
  const children = (dir: string): string[] => [...nodes.keys()].filter((k) => win32.dirname(k) === key(dir) && k !== key(dir));

  const probe: SecurityProbe = {
    async inspect(paths) {
      calls.push(`inspect:${paths.length}`);
      return {
        user: as,
        items: paths.map((path): PathSecurity => {
          const node = nodes.get(key(path));
          if (!node) return { exists: false };
          return { exists: true, directory: true, reparse: node.reparse ?? false, owner: node.owner, protected: node.protected, entries: node.entries.map((e) => ({ ...e })) };
        }),
      };
    },
    async restrict(dir, userSid) {
      calls.push(`restrict:${dir}`);
      const node = nodes.get(key(dir));
      if (!node) throw new Error('ENOENT');
      node.protected = true;
      node.entries = [{ sid: userSid, allow: true, inherited: false }, { sid: SID_SYSTEM, allow: true, inherited: false }];
    },
  };
  const fs: GuardFs = {
    async mkdir(dir, options) {
      calls.push(`mkdir:${dir}:${options.recursive}`);
      const parts: string[] = [];
      for (let current = win32.resolve(dir); ; current = win32.dirname(current)) {
        parts.unshift(current);
        if (win32.dirname(current) === current) break;
      }
      for (const part of parts) {
        if (nodes.has(key(part))) {
          if (!options.recursive && key(part) === key(dir)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
          continue;
        }
        if (part.length <= 3) continue; // the drive
        nodes.set(key(part), { owner: as, protected: false, entries: inheritedFor(as) });
      }
      hooks.afterMkdir?.(dir);
    },
    async rm(dir) {
      calls.push(`rm:${dir}`);
      for (const k of [...nodes.keys()]) if (k === key(dir) || k.startsWith(`${key(dir)}\\`)) nodes.delete(k);
    },
    async readdir(dir) {
      return children(dir).map((k) => win32.basename(k));
    },
  };
  return { nodes, probe, fs, calls, hooks, put, key };
}

const leafOf = (home = HOME): { dir: string; root: string } => {
  const shared = speechModelsDirPlan(home, 'win32', ENV)[0];
  assert.ok(shared?.shared);
  return { dir: shared.dir, root: shared.shared.root };
};

test('guardedChain lists the folders from under the root down to the models folder', () => {
  assert.deepEqual(guardedChain('C:\\ProgramData', 'C:\\ProgramData\\Timon\\speech-models\\0123456789abcdef'), [
    'C:\\ProgramData\\Timon',
    'C:\\ProgramData\\Timon\\speech-models',
    'C:\\ProgramData\\Timon\\speech-models\\0123456789abcdef',
  ]);
  assert.throws(() => guardedChain('C:\\ProgramData', 'D:\\Elsewhere\\x'), SharedDirRefused);
  assert.throws(() => guardedChain('C:\\ProgramData', 'C:\\ProgramData'), SharedDirRefused);
});

test('lockedDown accepts only our own protected folder open to us, SYSTEM and Administrators', () => {
  const ok: PathSecurity = { exists: true, directory: true, reparse: false, owner: ME, protected: true, entries: [
    { sid: ME, allow: true, inherited: false }, { sid: SID_SYSTEM, allow: true, inherited: false },
    { sid: OTHER, allow: false, inherited: false },
  ] };
  assert.equal(lockedDown(ok, ME), true);
  assert.equal(lockedDown({ ...ok, owner: SID_ADMINISTRATORS }, ME), true, 'an elevated Timon creates as Administrators');
  assert.equal(lockedDown({ ...ok, owner: OTHER }, ME), false);
  assert.equal(lockedDown({ ...ok, protected: false }, ME), false);
  assert.equal(lockedDown({ ...ok, reparse: true }, ME), false);
  assert.equal(lockedDown({ ...ok, entries: [...ok.entries, { sid: USERS, allow: true, inherited: false }] }, ME), false);
  assert.equal(lockedDown({ ...ok, entries: [{ sid: ME, allow: true, inherited: true }] }, ME), false);
  assert.equal(lockedDown({ exists: false }, ME), false);
});

test('a fresh shared folder is created, restricted to this account, and checked empty', async () => {
  const v = volume();
  const { dir, root } = leafOf();
  await ensureSharedSpeechDir(root, dir, v.probe, v.fs);
  const leaf = v.nodes.get(v.key(dir));
  assert.equal(leaf?.owner, ME);
  assert.equal(leaf?.protected, true);
  assert.deepEqual(leaf?.entries.map((e) => e.sid).sort(), [ME, SID_SYSTEM].sort());
  assert.ok(v.calls.includes(`mkdir:${dir}:false`), 'the leaf is created without recursive: a squatter makes it fail');
  assert.ok(v.calls.includes(`restrict:${dir}`));
  // The second session finds it locked down and does nothing else.
  v.calls.length = 0;
  await ensureSharedSpeechDir(root, dir, v.probe, v.fs);
  assert.deepEqual(v.calls, ['inspect:3']);
});

test('a folder another account created first is refused, never used nor deleted', async () => {
  const v = volume();
  const { dir, root } = leafOf();
  v.put(win32.dirname(win32.dirname(dir)), { owner: OTHER, protected: false, entries: inheritedFor(OTHER) });
  v.put(win32.dirname(dir), { owner: OTHER, protected: false, entries: inheritedFor(OTHER) });
  // The squatter even copies our protected ACL: the owner gives it away.
  v.put(dir, { owner: OTHER, protected: true, entries: [{ sid: ME, allow: true, inherited: false }] });
  await assert.rejects(ensureSharedSpeechDir(root, dir, v.probe, v.fs), /another account/);
  assert.ok(v.nodes.has(v.key(dir)));
  assert.ok(!v.calls.some((c) => c.startsWith('rm:') || c.startsWith('restrict:')));
});

test('a parent folder owned by another account is refused, even when the leaf looks ours', async () => {
  const v = volume();
  const { dir, root } = leafOf();
  v.put(win32.dirname(win32.dirname(dir)), { owner: OTHER, protected: false, entries: inheritedFor(OTHER) });
  v.put(win32.dirname(dir), { owner: ME, protected: false, entries: inheritedFor(ME) });
  v.put(dir, { owner: ME, protected: true, entries: [{ sid: ME, allow: true, inherited: false }] });
  await assert.rejects(ensureSharedSpeechDir(root, dir, v.probe, v.fs), /belongs to another account/);
});

test('a junction in the chain is refused', async () => {
  const v = volume();
  const { dir, root } = leafOf();
  v.put(win32.dirname(win32.dirname(dir)), { owner: ME, protected: false, entries: inheritedFor(ME), reparse: true });
  await assert.rejects(ensureSharedSpeechDir(root, dir, v.probe, v.fs), /not a plain folder/);
});

test('TODO #444: uninstall deletes only a models folder of ours, under plain parents of trust', () => {
  const dir = (owner: string, reparse = false): PathSecurity =>
    ({ exists: true, directory: true, reparse, owner, protected: true, entries: [] });
  const absent: PathSecurity = { exists: false };
  const removable = (...items: PathSecurity[]) => sharedSpeechDirRemovable({ user: ME, items });
  assert.equal(removable(dir(SID_SYSTEM), dir(ME), dir(ME)), true);
  assert.equal(removable(dir(ME), dir(ME), dir(SID_ADMINISTRATORS)), true);
  assert.equal(removable(dir(ME), dir(ME), dir(OTHER)), false, 'a squat is neither used nor deleted');
  assert.equal(removable(dir(OTHER), dir(ME), dir(ME)), false, 'parent of another account');
  assert.equal(removable(dir(ME, true), dir(ME), dir(ME)), false, 'junction in the chain');
  assert.equal(removable(dir(ME), dir(ME), dir(ME, true)), false, 'junction as the folder');
  assert.equal(removable(dir(ME), dir(ME), absent), false, 'nothing to delete');
  assert.equal(removable(dir(ME), dir(ME), { ...dir(ME), directory: false }), false);
  assert.equal(removable(dir(ME), dir(ME), { ...dir(ME), owner: null }), false, 'unreadable owner fails closed');
  assert.equal(removable(), false);
});

test('a folder of ours left open is deleted with what it holds, then created again empty and restricted', async () => {
  const v = volume();
  const { dir, root } = leafOf();
  await v.fs.mkdir(dir, { recursive: true });
  // Files another account could have dropped while the ACL was inherited.
  v.put(win32.join(dir, 'parakeet'), { owner: OTHER, protected: false, entries: inheritedFor(OTHER) });
  const logs: string[] = [];
  await ensureSharedSpeechDir(root, dir, v.probe, v.fs, (line) => logs.push(line));
  assert.ok(v.calls.includes(`rm:${dir}`));
  assert.ok(!v.nodes.has(v.key(win32.join(dir, 'parakeet'))));
  assert.equal(v.nodes.get(v.key(dir))?.protected, true);
  assert.match(logs.join('\n'), /downloaded again/);
});

test('a squatter racing the creation is caught: EEXIST, or files dropped before the ACL lands', async () => {
  const { dir, root } = leafOf();
  const raced = volume();
  raced.hooks.afterMkdir = (made) => {
    if (made === win32.dirname(dir)) raced.put(dir, { owner: OTHER, protected: false, entries: inheritedFor(OTHER) });
  };
  await assert.rejects(ensureSharedSpeechDir(root, dir, raced.probe, raced.fs), /EEXIST/);
  assert.equal(raced.nodes.get(raced.key(dir))?.owner, OTHER, 'not ours to delete');

  const dropped = volume();
  dropped.hooks.afterMkdir = (made) => {
    if (made === dir) dropped.put(win32.join(dir, 'parakeet'), { owner: OTHER, protected: false, entries: inheritedFor(OTHER) });
  };
  await assert.rejects(ensureSharedSpeechDir(root, dir, dropped.probe, dropped.fs), /received files from another account/);
  assert.ok(!dropped.nodes.has(dropped.key(dir)), 'the tainted folder is removed');
});

test('a restriction that does not take is refused and the folder removed', async () => {
  const v = volume();
  const { dir, root } = leafOf();
  const probe: SecurityProbe = { inspect: v.probe.inspect, restrict: async () => undefined };
  await assert.rejects(ensureSharedSpeechDir(root, dir, probe, v.fs), /could not be restricted/);
  assert.ok(!v.nodes.has(v.key(dir)));
});

test('on Windows with a non-ASCII home, a refused ProgramData folder falls back to the next place', async () => {
  const v = volume();
  const plan = speechModelsDirPlan(HOME, 'win32', ENV);
  const first = plan[0]!.dir;
  v.put(win32.dirname(win32.dirname(first)), { owner: OTHER, protected: false, entries: inheritedFor(OTHER) });
  const logs: string[] = [];
  const chosen = await prepareSpeechModels(HOME, { platform: 'win32', env: ENV, probe: v.probe, fs: v.fs, log: (line) => logs.push(line) });
  assert.notEqual(chosen.dir, first);
  assert.equal(chosen.dir, plan[1]!.dir);
  assert.ok(chosen.dir.startsWith('C:\\Users\\Public\\Documents\\'));
  assert.equal(v.nodes.get(v.key(chosen.dir))?.protected, true);
  assert.match(logs.join('\n'), /skipped: .*another account/);
});

test('when every shared place is refused, the home is used as before', async () => {
  const v = volume();
  const probe: SecurityProbe = { inspect: async () => { throw new Error('powershell missing'); }, restrict: v.probe.restrict };
  const chosen = await prepareSpeechModels(HOME, { platform: 'win32', env: ENV, probe, fs: v.fs, log: () => undefined });
  assert.equal(chosen.dir, 'C:\\Users\\Zoé\\.timon\\speech\\models');
  assert.equal(chosen.shared, null);
});

test('a plain home never starts the Windows probe', async () => {
  const v = volume();
  const probe: SecurityProbe = { inspect: async () => { throw new Error('must not run'); }, restrict: async () => { throw new Error('must not run'); } };
  const chosen = await prepareSpeechModels('C:\\Users\\Zoe\\.timon', { platform: 'win32', env: ENV, probe, fs: v.fs });
  assert.equal(chosen.dir, 'C:\\Users\\Zoe\\.timon\\speech\\models');
  assert.ok(v.calls.every((c) => c.startsWith('mkdir:')));
});

test('the PowerShell answer is parsed as SIDs, in both array shapes of Windows PowerShell 5.1', () => {
  const stdout = JSON.stringify({
    user: ME,
    items: { value: [
      { exists: false },
      { exists: true, directory: true, reparse: false, owner: ME, protected: true, entries: { value: [{ sid: ME, allow: true, inherited: false }], Count: 1 } },
      { exists: true, directory: true, reparse: false, owner: SID_SYSTEM, protected: false, entries: { sid: USERS, allow: true, inherited: true } },
    ], Count: 3 },
  });
  const snapshot = parseSecuritySnapshot(stdout, 3);
  assert.equal(snapshot.user, ME);
  assert.deepEqual(snapshot.items[0], { exists: false });
  assert.equal(lockedDown(snapshot.items[1]!, ME), true);
  assert.deepEqual((snapshot.items[2] as Extract<PathSecurity, { exists: true }>).entries, [{ sid: USERS, allow: true, inherited: true }]);
  assert.throws(() => parseSecuritySnapshot(stdout, 2), /incomplete/);
  assert.throws(() => parseSecuritySnapshot(JSON.stringify({ user: 'Zoé', items: [] }), 0), /SID/);
});

test('an unreadable entry or owner fails closed', () => {
  const snapshot = parseSecuritySnapshot(JSON.stringify({
    user: ME,
    items: [{ exists: true, directory: true, owner: 'BUILTIN\\Users', protected: true, entries: [{}] }],
  }), 1);
  const item = snapshot.items[0]!;
  assert.equal(lockedDown(item, ME), false);
  assert.ok(item.exists && item.reparse && item.owner === null);
});

test('the Windows probe calls System32 tools with the paths out of the script text', async () => {
  const seen: { file: string; args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
  const probe = windowsSecurityProbe({ SystemRoot: 'C:\\Windows' }, async (file, args, options) => {
    seen.push({ file, args, env: options.env });
    return file.endsWith('powershell.exe') ? JSON.stringify({ user: ME, items: [{ exists: false }, { exists: false }] }) : '';
  });
  const paths = ['C:\\ProgramData\\Timon', "C:\\ProgramData\\Timon\\it's"];
  await probe.inspect(paths);
  assert.equal(seen[0]?.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(seen[0]?.env?.TIMON_SPEECH_GUARD_PATHS, paths.join('|'));
  const encoded = seen[0]?.args.at(-1) ?? '';
  assert.equal(seen[0]?.args.at(-2), '-EncodedCommand');
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(script, /\$env:TIMON_SPEECH_GUARD_PATHS/);
  assert.match(script, /GetOwner\(\$sidType\)/);
  assert.ok(!script.includes("it's") && !seen[0]?.args.some((arg) => arg.includes("it's")));
  await probe.restrict('C:\\ProgramData\\Timon\\speech-models\\0123456789abcdef', ME);
  assert.equal(seen[1]?.file, 'C:\\Windows\\System32\\icacls.exe');
  assert.deepEqual(seen[1]?.args, [
    'C:\\ProgramData\\Timon\\speech-models\\0123456789abcdef', '/inheritance:r', '/grant:r', `*${ME}:(OI)(CI)F`, `*${SID_SYSTEM}:(OI)(CI)F`,
  ]);
  await assert.rejects(probe.restrict('C:\\x', 'Everyone'), /invalid account SID/);
});
