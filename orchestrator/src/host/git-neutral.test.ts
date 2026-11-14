import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-git-neutral-'));
const HOME = process.env.TIMON_HOME;

const { TimonConfigSchema } = await import('../config/schema.js');
const { createGenericHost } = await import('./generic.js');
const {
  gitHooksNoneDir, gitmodulesScanArgs, gitScanArgs, gitToplevelArgs, neutralGitCall, neutralGitEnv, parseGitConfigList,
  localGitPath, localRemoteProblem, parseSubmoduleNames, reachedGitUrls, scannedGitConfig,
} = await import('./git-neutral.js');
type GitConfigEntry = import('./git-neutral.js').GitConfigEntry;

const host = createGenericHost(TimonConfigSchema.parse({}));
const hasGit = spawnSync('git', ['--version']).status === 0;

test('parseGitConfigList reads scoped and plain listings, a bare key included', () => {
  assert.deepEqual(parseGitConfigList('global\0user.name\nA B\0local\0core.bare\0', true), [
    { scope: 'global', key: 'user.name', value: 'A B' },
    { scope: 'local', key: 'core.bare', value: null },
  ]);
  assert.deepEqual(parseGitConfigList('a.b\nx\ny\0', false), [{ scope: 'unknown', key: 'a.b', value: 'x\ny' }]);
});

test('gitScanArgs skips pure ref reads and keeps where git works', () => {
  assert.equal(gitScanArgs(['-C', '/r', 'rev-parse', 'HEAD']), null);
  assert.equal(gitScanArgs(['--version']), null);
  assert.deepEqual(gitScanArgs(['-C', '/r', '-c', 'x.y=1', 'status'])?.scoped,
    ['-C', '/r', '--no-pager', 'config', '--list', '-z', '--show-scope']);
  assert.deepEqual(gitScanArgs(['--git-dir=/r/.git', 'merge', 'x'])?.plain,
    ['--git-dir=/r/.git', '--no-pager', 'config', '--list', '-z']);
});

test('a command a mission wrote is replaced, the trusted one kept', () => {
  const { config, env } = scannedGitConfig([
    { scope: 'global', key: 'core.sshcommand', value: 'ssh -i key' },
    { scope: 'local', key: 'core.sshcommand', value: 'evil' },
    { scope: 'local', key: 'filter.x.clean', value: 'evil' },
    { scope: 'global', key: 'filter.lfs.clean', value: 'git-lfs clean -- %f' },
    { scope: 'local', key: 'filter.lfs.smudge', value: 'git-lfs smudge -- %f' },
    { scope: 'local', key: 'merge.ours.driver', value: 'true' },
    { scope: 'worktree', key: 'merge.m.driver', value: 'evil %A' },
    { scope: 'global', key: 'credential.helper', value: '' },
    { scope: 'global', key: 'credential.helper', value: 'store' },
    { scope: 'local', key: 'credential.helper', value: '!evil' },
    { scope: 'local', key: 'remote.origin.uploadpack', value: 'evil' },
    { scope: 'local', key: 'remote.origin.url', value: '/elsewhere' },
    { scope: 'local', key: 'core.gitproxy', value: 'evil' },
  ]);
  assert.deepEqual(config, [
    'core.sshcommand=ssh -i key',
    'filter.x.clean=',
    'merge.m.driver=git merge-file --marker-size=%L %A %O %B',
    'credential.helper=',
    'credential.helper=',
    'credential.helper=store',
    'filter.x.required=false',
  ]);
  assert.deepEqual(env, { GIT_PROXY_COMMAND: '' });
});

// `remote.<name>.uploadpack` keeps the first value git reads: only the
// command-line option outranks a planted one.
test('a planted upload-pack or receive-pack is overridden on the command line', () => {
  const entries: GitConfigEntry[] = [
    { scope: 'local', key: 'remote.origin.uploadpack', value: 'evil' },
    { scope: 'local', key: 'remote.origin.receivepack', value: 'evil' },
  ];
  entries.push({ scope: 'local', key: 'remote.origin.url', value: 'https://example.com/r.git' });
  const fetch = neutralGitCall(['-C', '/r', 'fetch', 'origin'], entries, {});
  assert.ok(!('refused' in fetch) && fetch.args.join(' ').endsWith('fetch --no-recurse-submodules --upload-pack=git-upload-pack origin'));
  const push = neutralGitCall(['push', 'origin', 'main'], entries, {});
  assert.ok(!('refused' in push) && push.args.join(' ').endsWith('push --no-recurse-submodules --receive-pack=git-receive-pack origin main'));
  assert.ok('refused' in neutralGitCall(['remote', 'update'], entries, {}));
  const status = neutralGitCall(['status'], entries, {});
  assert.ok(!('refused' in status) && !status.args.some((a) => a.startsWith('--upload-pack')));
});

test('a key that -c cannot reach refuses the call', () => {
  const entries = [{ scope: 'local', key: 'credential.https://a=b.helper', value: '!evil' }];
  assert.equal(scannedGitConfig(entries).refused, 'credential.https://a=b.helper');
  assert.ok('refused' in neutralGitCall(['push'], entries, {}));
});

test('alternate refs, configured hooks and Git LFS programs a mission named are neutralized', () => {
  const alt = scannedGitConfig([{ scope: 'local', key: 'core.alternaterefscommand', value: 'evil' }]);
  assert.deepEqual(alt.config, [`core.alternaterefscommand=git --git-dir="$1" for-each-ref --format='%(objectname)' #`]);
  assert.equal(scannedGitConfig([{ scope: 'worktree', key: 'hook.pre-commit.command', value: 'evil' }]).refused, 'hook.pre-commit.command');
  assert.equal(scannedGitConfig([{ scope: 'global', key: 'hook.x.command', value: 'mine' }]).refused, undefined);
  const lfs = scannedGitConfig([
    { scope: 'global', key: 'filter.lfs.process', value: 'git-lfs filter-process' },
    { scope: 'local', key: 'lfs.customtransfer.t.path', value: 'evil' },
  ]);
  assert.deepEqual(lfs.config, ['filter.lfs.clean=', 'filter.lfs.smudge=', 'filter.lfs.process=', 'filter.lfs.required=false']);
  assert.deepEqual(scannedGitConfig([{ scope: 'global', key: 'lfs.customtransfer.t.path', value: 'mine' }]).config, []);
});

test('git never runs inside a submodule, and the local transport is off by default', () => {
  const args = (call: ReturnType<typeof neutralGitCall>) => ('refused' in call ? [] : call.args);
  const fixed = args(neutralGitCall(['rev-parse', 'HEAD'], null, {}));
  for (const pair of ['protocol.file.allow=never', 'protocol.ext.allow=never', 'submodule.recurse=false']) {
    assert.ok(fixed.includes(pair), pair);
  }
  assert.ok(args(neutralGitCall(['status', '--porcelain'], [], {})).includes('--ignore-submodules=dirty'));
  assert.ok(args(neutralGitCall(['diff-index', 'HEAD'], [], {})).includes('--ignore-submodules=dirty'));
  assert.ok(args(neutralGitCall(['checkout', 'main'], [], {})).includes('--quiet'));
  assert.equal(args(neutralGitCall(['checkout', '-q', 'main'], [], {})).filter((a) => a === '--quiet' || a === '-q').length, 1);
  const origin = [{ scope: 'local', key: 'remote.origin.url', value: 'git@example.com:o/r.git' }];
  assert.ok(args(neutralGitCall(['fetch', 'origin'], origin, {})).includes('--no-recurse-submodules'));
  assert.ok(!args(neutralGitCall(['fetch', 'origin'], origin, {})).includes('protocol.file.allow=always'));
  // It would replace the protocol policy with its own list.
  const call = neutralGitCall(['push'], [], { GIT_ALLOW_PROTOCOL: 'file:ext', PATH: '/usr/bin' }, { platform: 'linux' });
  assert.ok(!('refused' in call) && call.env.GIT_ALLOW_PROTOCOL === undefined);
  const win = neutralGitCall(['push'], [], { Git_Allow_Protocol: 'file' }, { platform: 'win32' });
  assert.ok(!('refused' in win) && !Object.keys(win.env).some((k) => k.toUpperCase() === 'GIT_ALLOW_PROTOCOL'));
});

test('localGitPath tells the local transport from the others, as git does', () => {
  assert.equal(localGitPath('/srv/r.git', 'linux'), '/srv/r.git');
  assert.equal(localGitPath('../r', 'linux'), '../r');
  assert.equal(localGitPath('origin', 'linux'), 'origin');
  assert.equal(localGitPath('./a:b', 'linux'), './a:b');
  assert.equal(localGitPath('file:///srv/my%20r.git', 'linux'), '/srv/my r.git');
  // git drops the host of a `file://` URL outside Windows.
  assert.equal(localGitPath('file://host/srv/r.git', 'linux'), '/srv/r.git');
  for (const remote of ['git@example.com:o/r.git', 'https://example.com/r.git', 'ssh://example.com/r', 'ext::sh -c x', 'C:/repos/r.git']) {
    assert.equal(localGitPath(remote, 'linux'), null, remote);
  }
  assert.equal(localGitPath('C:\\repos\\r.git', 'win32'), 'C:\\repos\\r.git');
  assert.equal(localGitPath('D:/repos/r.git', 'win32'), 'D:/repos/r.git');
  assert.equal(localGitPath('file:///C:/repos/r.git', 'win32'), 'C:/repos/r.git');
  assert.equal(localGitPath('file://server/share/r.git', 'win32'), '//server/share/r.git');
  assert.equal(localGitPath('\\\\server\\share\\r.git', 'win32'), '\\\\server\\share\\r.git');
});

test('reachedGitUrls follows the remote a call names, its push URL and every rewrite', () => {
  const entries: GitConfigEntry[] = [
    { scope: 'local', key: 'remote.origin.url', value: 'gh:o/r' },
    { scope: 'local', key: 'remote.origin.pushurl', value: '/srv/push.git' },
    { scope: 'local', key: 'remote.mirror.url', value: 'https://example.com/m.git' },
    { scope: 'global', key: 'url.https://github.com/.insteadof', value: 'gh:' },
    { scope: 'local', key: 'url./srv/evil.git.pushinsteadof', value: 'https://example.com/m' },
  ];
  assert.equal(reachedGitUrls(['status'], entries), null);
  assert.deepEqual(reachedGitUrls(['push', '-u', 'origin', 'main'], entries), ['https://github.com/o/r', '/srv/push.git']);
  assert.deepEqual(reachedGitUrls(['fetch', '--prune', 'mirror'], entries), ['https://example.com/m.git', '/srv/evil.git.git']);
  assert.deepEqual(reachedGitUrls(['ls-remote', '--heads', '--', 'mirror'], entries), ['https://example.com/m.git', '/srv/evil.git.git']);
  assert.deepEqual(reachedGitUrls(['-C', '/r', 'fetch'], entries)?.length, 4);
  assert.deepEqual(reachedGitUrls(['fetch', '--all'], entries)?.length, 4);
  assert.deepEqual(reachedGitUrls(['fetch', '-o', 'x', 'unknown'], entries), ['unknown']);
  assert.deepEqual(reachedGitUrls(['clone', '-o', 'up', '/srv/a.git', 'dir'], entries), ['/srv/a.git']);
});

test('a local remote opens the local transport only where no mission writes', () => {
  const outside = mkdtempSync(join(tmpdir(), 'timon-git-outside-'));
  const remote = (url: string): GitConfigEntry[] => [{ scope: 'local', key: 'remote.r.url', value: url }];
  const reached = (url: string, options: { fencedFolders?: string[]; cwd?: string } = {}) =>
    neutralGitCall(['push', 'r', 'main'], remote(url), {}, { fencedFolders: [], ...options });

  const ok = reached(outside);
  assert.ok(!('refused' in ok), JSON.stringify(ok));
  // The fixed `never` comes first: the later `-c` wins.
  assert.ok(ok.args.indexOf('protocol.file.allow=always') > ok.args.indexOf('protocol.file.allow=never'));
  assert.ok(!('refused' in reached(`file://${outside}`)));

  // A fence leaves the system temporary folders writable.
  assert.match(JSON.stringify(reached(outside, { fencedFolders: [tmpdir()] })), /refused.*inside /);
  // So is the folder git works in.
  assert.match(JSON.stringify(reached(join(outside, 'sub.git'), { cwd: outside })), /refused/);
  assert.match(JSON.stringify(reached('../r.git')), /refused.*relative path/);
  assert.match(JSON.stringify(reached('origin')), /refused.*relative path/);

  // A mission zone, named, rewritten into, or linked to.
  const zone = mkdtempSync(join(HOME, 'worktrees-'));
  assert.match(JSON.stringify(reached(zone)), /inside the Timon home/);
  assert.match(JSON.stringify(reached(`file://${zone}`)), /inside the Timon home/);
  const rewritten = neutralGitCall(['push', 'r', 'main'], [
    ...remote('https://example.invalid/r.git'),
    { scope: 'local', key: `url.${zone}.insteadof`, value: 'https://example.invalid/r.git' },
  ], {}, { fencedFolders: [] });
  assert.match(JSON.stringify(rewritten), /inside the Timon home/);
  if (process.platform !== 'win32') {
    const link = join(outside, 'link.git');
    symlinkSync(zone, link);
    assert.match(JSON.stringify(reached(link)), /inside the Timon home/);
    // A path that does not exist yet, behind a link: a mission creates it
    // once the check has passed.
    assert.match(JSON.stringify(reached(join(link, 'later.git'))), /inside the Timon home/);
    // git also tries `<path>.git`.
    symlinkSync(zone, join(outside, 'bare.git'));
    assert.match(JSON.stringify(reached(join(outside, 'bare'))), /inside the Timon home/);
  }
  // Every other protocol is left as it was.
  const ssh = reached('git@example.com:o/r.git');
  assert.ok(!('refused' in ssh) && !ssh.args.includes('protocol.file.allow=always'));
  assert.equal(localRemoteProblem(outside, { fencedFolders: [] }), null);
  rmSync(outside, { recursive: true, force: true });
});

test('a merge names every submodule git may read, so git never runs inside one', () => {
  assert.equal(gitToplevelArgs(['-C', '/r', 'status']), null);
  const top = gitToplevelArgs(['-C', '/r', 'merge', '--no-edit', 'x']);
  assert.deepEqual([top?.slice(0, 3), top?.slice(-2)], [['-C', '/r', '--no-pager'], ['rev-parse', '--show-toplevel']]);
  assert.ok(top?.includes('core.fsmonitor=false'));
  const reads = gitmodulesScanArgs(['-C', '/r', 'merge', 'x'], '/r');
  assert.deepEqual(reads.map((a) => a.slice(-2)), [['--file', join('/r', '.gitmodules')], ['--blob', ':.gitmodules'], ['--blob', 'HEAD:.gitmodules']]);
  assert.deepEqual(
    parseSubmoduleNames(['submodule.a.path\0submodule.a.url\0submodule.x.y.path\0', 'submodule.b.ignore\0core.bare\0submodule.\0', '']),
    ['a', 'x.y', 'b'],
  );
  const call = neutralGitCall(['merge', 'x'], [], {}, { submodules: ['a', 'x.y'] });
  assert.ok(!('refused' in call) && call.args.includes('submodule.a.ignore=dirty') && call.args.includes('submodule.x.y.ignore=dirty'));
  assert.ok('refused' in neutralGitCall(['merge', 'x'], [], {}, { submodules: ['a=b'] }));
});

test('a commit must carry its message: without one git builds a status of the submodules', () => {
  assert.ok('refused' in neutralGitCall(['-C', '/r', 'commit', '-a'], [], {}));
  assert.ok('refused' in neutralGitCall(['commit', '--amend'], [], {}));
  for (const ok of [['commit', '--quiet', '-m', 'x'], ['commit', '-qam', 'x'], ['commit', '--message=x'], ['commit', '-F', 'f'], ['commit', '--no-edit', '--amend']]) {
    assert.ok(!('refused' in neutralGitCall(ok, [], {})), ok.join(' '));
  }
  assert.ok(!('refused' in neutralGitCall(['-c', 'user.name=T', 'commit', '--quiet', '-m', 'Demo project'], [], {})));
});

test('neutralGitCall fixes hooks, fsmonitor, pager, and diff drivers', () => {
  const call = neutralGitCall(['-C', '/r', 'diff', '--numstat', 'HEAD'], null, { PATH: '/usr/bin' });
  assert.ok(!('refused' in call));
  if ('refused' in call) return;
  assert.equal(call.args[0], '--no-pager');
  assert.ok(call.args.includes('core.fsmonitor=false'));
  assert.ok(call.args.includes(`core.hooksPath=${gitHooksNoneDir()}`));
  const diff = call.args.indexOf('diff');
  assert.deepEqual(call.args.slice(diff, diff + 5), ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--numstat']);
  const status = neutralGitCall(['status'], null, {});
  assert.ok(!('refused' in status) && !status.args.includes('--no-ext-diff'));
});

test('the PATH git gets loses every folder a mission can write', () => {
  const sep = process.platform === 'win32' ? ';' : delimiter;
  const kept = join(HOME, 'plugins', 'x', 'bin');
  const env = neutralGitEnv({
    PATH: ['', '.', join(HOME, 'worktrees', 't', 'bin'), kept, join(tmpdir(), 'elsewhere')].join(sep),
  });
  assert.deepEqual(env.PATH?.split(sep), [kept, join(tmpdir(), 'elsewhere')]);
});

/** Every witness `trappedRepo` plants. */
const WITNESSES = [
  'alternate-refs', 'filter', 'fsmonitor', 'gpg', 'hook-post-checkout', 'hook-pre-commit',
  'hook-reference-transaction', 'merge-driver', 'planted-helper', 'pre-receive', 'pre-receive-inside', 'subfilter', 'uploadpack',
];

/** A repository whose configuration runs a witness for every hook, driver and
 *  helper git can be asked to run, a submodule and two local remotes. */
function trappedRepo(): { root: string; repo: string; env: NodeJS.ProcessEnv; witnesses: () => string[] } {
  const root = mkdtempSync(join(tmpdir(), 'timon-git-trap-'));
  const seen = join(root, 'seen');
  mkdirSync(seen);
  const touch = (name: string) => `touch '${join(seen, name).replaceAll('\\', '/')}'`;
  const globalFile = join(root, 'global.gitconfig');
  // The user's own credential helper: it must keep running.
  writeFileSync(globalFile, `[user]\n\tname = T\n\temail = t@example.com\n[credential]\n\thelper = "!${touch('trusted-helper')}; :"\n[init]\n\tdefaultBranch = main\n`);
  const env: NodeJS.ProcessEnv = {
    ...process.env, GIT_CONFIG_GLOBAL: globalFile, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    LANGUAGE: 'C', LC_ALL: 'C',
  };
  delete env.GIT_ALLOW_PROTOCOL;
  const run = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const repo = join(root, 'repo');
  const git = (...args: string[]) => run(repo, ...args);
  const subsrc = join(root, 'subsrc');
  mkdirSync(subsrc);
  run(subsrc, 'init', '-q');
  writeFileSync(join(subsrc, 'a.txt'), 'a\n');
  run(subsrc, 'add', 'a.txt');
  run(subsrc, 'commit', '-qm', 'sub');
  mkdirSync(repo);
  git('init', '-q');
  writeFileSync(join(repo, 'f.txt'), 'base\n');
  git('add', 'f.txt');
  git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subsrc, 'sub');
  git('commit', '-qm', 'base');
  git('branch', 'side');
  writeFileSync(join(repo, 'f.txt'), 'main\n');
  git('commit', '-qam', 'main');
  git('checkout', '-q', 'side');
  writeFileSync(join(repo, 'f.txt'), 'side\n');
  git('commit', '-qam', 'side');
  git('checkout', '-q', 'main');
  const upstream = join(root, 'upstream');
  run(root, 'clone', '-q', '--bare', repo, upstream);
  // Something to fetch, so the fetch negotiates (and asks the alternates).
  const extra = run(upstream, 'commit-tree', '-p', 'main', '-m', 'extra', 'main^{tree}');
  run(upstream, 'update-ref', 'refs/heads/extra', extra);
  const other = join(root, 'other');
  run(root, 'clone', '-q', '--bare', repo, other);
  // Bare repositories a mission prepared where it writes, to receive the
  // daemon's push: a folder of the Timon home, and the repository's own git
  // directory.
  const drop = mkdtempSync(join(HOME, 'worktrees-'));
  run(root, 'init', '-q', '--bare', drop);
  writeFileSync(join(drop, 'hooks', 'pre-receive'), `#!/bin/sh\n${touch('pre-receive')}\n`, { mode: 0o755 });

  // What a mission writes into the repository it works in.
  writeFileSync(join(repo, '.gitattributes'), '* filter=trap merge=trap\n');
  git('config', 'core.fsmonitor', `${touch('fsmonitor')}; exit 1`);
  git('config', 'filter.trap.clean', `${touch('filter')}; cat`);
  git('config', 'filter.trap.smudge', `${touch('filter')}; cat`);
  git('config', 'filter.trap.required', 'true');
  git('config', 'merge.trap.driver', `${touch('merge-driver')}; false`);
  git('config', 'credential.helper', `!${touch('planted-helper')}; :`);
  git('remote', 'add', 'origin', upstream);
  git('config', 'remote.origin.uploadpack', `${touch('uploadpack')}; git-upload-pack`);
  git('remote', 'add', 'drop', drop);
  const inside = join(repo, '.git', 'inside.git');
  run(root, 'init', '-q', '--bare', inside);
  writeFileSync(join(inside, 'hooks', 'pre-receive'), `#!/bin/sh\n${touch('pre-receive-inside')}\n`, { mode: 0o755 });
  git('remote', 'add', 'inside', inside);
  // The same prepared repository, reached through a rewrite and through a
  // link from a folder no mission writes.
  git('config', `url.${drop}.insteadOf`, 'https://example.invalid/r.git');
  git('remote', 'add', 'rewritten', 'https://example.invalid/r.git');
  const link = join(root, 'link.git');
  symlinkSync(drop, link);
  git('remote', 'add', 'linked', link);
  git('config', 'commit.gpgSign', 'true');
  // git starts `gpg.program` without a shell: a script stands in for it.
  const gpg = join(root, 'gpg-trap');
  writeFileSync(gpg, `#!/bin/sh\n${touch('gpg')}\nexit 1\n`, { mode: 0o755 });
  git('config', 'gpg.program', gpg);
  writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), `${join(other, 'objects')}\n`);
  git('config', 'core.alternateRefsCommand', `${touch('alternate-refs')}; true`);
  for (const hook of ['pre-commit', 'pre-merge-commit', 'post-merge', 'reference-transaction', 'post-checkout']) {
    writeFileSync(join(repo, '.git', 'hooks', hook), `#!/bin/sh\n${touch(`hook-${hook}`)}\n`, { mode: 0o755 });
  }
  // The submodule's own configuration, never scanned, and the setting that
  // outranks `diff.ignoreSubmodules`.
  const sub = join(repo, 'sub');
  // Its own filter name: the daemon's `-c filter.trap.clean=` reaches a git
  // started inside the submodule and would blank a filter of the same name.
  writeFileSync(join(sub, '.gitattributes'), '* filter=subtrap\n');
  run(sub, 'config', 'filter.subtrap.clean', `${touch('subfilter')}; cat`);
  git('config', 'submodule.sub.ignore', 'none');
  git('config', '-f', '.gitmodules', 'submodule.sub.ignore', 'none');
  // Same size, new stat: git must hash the file, through the clean filter.
  writeFileSync(join(sub, 'a.txt'), 'z\n');
  writeFileSync(join(repo, 'f.txt'), 'main\n');
  return { root, repo, env, witnesses: () => readdirSync(seen).sort() };
}

/** What the daemon does in a repository, in the order it would. */
async function gestures(t: ReturnType<typeof trappedRepo>, git: (args: string[], input?: string) => Promise<{ code: number; stderr: string }>) {
  const r = (args: string[], input?: string) => git(['-C', t.repo, ...args], input);
  return {
    status: await r(['status', '--porcelain']),
    diff: await r(['diff', '--numstat', 'HEAD']),
    checkout: await r(['checkout', 'side']),
    back: await r(['checkout', 'main']),
    // The refresh merge of `worktree.ts`.
    merge: await r(['merge', '--no-edit', '-m', 'refresh', 'side']),
    abort: await r(['merge', '--abort']),
    commit: await r(['commit', '-qam', 'x', '--allow-empty']),
    fill: await r(['credential', 'fill'], 'protocol=https\nhost=example.com\n\n'),
    fetch: await r(['fetch', '-q', 'origin']),
    push: await r(['push', '-q', 'drop', 'main']),
    pushInside: await r(['push', '-q', 'inside', 'main']),
    pushRewritten: await r(['push', '-q', 'rewritten', 'main']),
    pushLinked: await r(['push', '-q', 'linked', 'main']),
  };
}

test('the trap fires under a plain git: every witness is real', { skip: !hasGit || process.platform === 'win32' }, async () => {
  const t = trappedRepo();
  const done = await gestures(t, async (args, input) => {
    const r = spawnSync('git', args, { env: t.env, encoding: 'utf8', input, timeout: 30_000 });
    return { code: r.status ?? 1, stderr: r.stderr };
  });
  assert.equal(done.fetch.code, 0, done.fetch.stderr);
  assert.equal(done.push.code, 0, done.push.stderr);
  assert.equal(done.pushInside.code, 0, done.pushInside.stderr);
  assert.equal(done.pushRewritten.code, 0, done.pushRewritten.stderr);
  assert.equal(done.pushLinked.code, 0, done.pushLinked.stderr);
  assert.deepEqual(t.witnesses().filter((w) => w !== 'trusted-helper'), WITNESSES);
  rmSync(t.root, { recursive: true, force: true });
});

test('the daemon git runs nothing a mission wrote: status, diff, checkout, merge, commit, credentials, fetch, push',
  { skip: !hasGit || process.platform === 'win32' }, async () => {
    const t = trappedRepo();
    const opts = { env: t.env, timeout: 30_000 };
    const done = await gestures(t, (args, input) => (input === undefined
      ? host.execAsync('git', args, opts)
      : Promise.resolve(host.exec('git', args, { ...opts, input }))));
    assert.equal(done.status.code, 0, done.status.stderr);
    assert.equal(done.diff.code, 0, done.diff.stderr);
    assert.equal(done.checkout.code, 0, done.checkout.stderr);
    // The planted driver gives way to a plain text merge, which conflicts on
    // the line both sides changed.
    assert.notEqual(done.merge.code, 0);
    // A local remote runs ITS hooks: the one no mission writes is reached,
    // the ones a mission prepared are refused before git starts.
    assert.equal(done.fetch.code, 0, done.fetch.stderr);
    assert.match(done.push.stderr, /^git refused: the remote ".*" is a local repository in a place a mission can write \(inside the Timon home\)/);
    assert.match(done.pushInside.stderr, /^git refused: the remote ".*inside\.git" is a local repository in a place a mission can write \(inside /);
    assert.match(done.pushRewritten.stderr, /^git refused: .*\(inside the Timon home\)/);
    assert.match(done.pushLinked.stderr, /^git refused: the remote ".*link\.git" .*\(inside the Timon home\)/);
    const seen = t.witnesses();
    assert.deepEqual(seen.filter((w) => w !== 'trusted-helper'), [], `ran: ${seen.join(', ')}`);
    assert.ok(seen.includes('trusted-helper'), 'the credential helper of the global configuration still runs');
    rmSync(t.root, { recursive: true, force: true });
  });

test('the neutral alternate-refs command still lets a fetch through', { skip: !hasGit || process.platform === 'win32' }, () => {
  const t = trappedRepo();
  const scanned = scannedGitConfig([{ scope: 'local', key: 'core.alternaterefscommand', value: 'evil' }]);
  const pair = scanned.config.find((c) => c.startsWith('core.alternaterefscommand='));
  assert.ok(pair);
  // A plain git, the file transport allowed: only the neutral value differs.
  const r = spawnSync('git', ['-C', t.repo, '-c', pair, '-c', 'remote.origin.uploadpack=git-upload-pack', 'fetch', '-q', '--upload-pack=git-upload-pack', 'origin'],
    { env: t.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(spawnSync('git', ['-C', t.repo, 'rev-parse', '--verify', '-q', 'origin/extra'], { env: t.env }).status, 0);
  assert.ok(!t.witnesses().includes('alternate-refs'), t.witnesses().join(','));
  rmSync(t.root, { recursive: true, force: true });
});

test('the hooks folder cannot exist: it lies under a regular file', () => {
  assert.ok(statSync(process.execPath).isFile());
  assert.equal(dirname(gitHooksNoneDir()), process.execPath);
});

test('a configuration scan that fails stops the call', { skip: !hasGit }, async () => {
  const missing = join(tmpdir(), 'timon-no-such-repo-', String(process.pid));
  const r = await host.execAsync('git', ['-C', missing, 'status'], { timeout: 30_000 });
  assert.notEqual(r.code, 0);
});
