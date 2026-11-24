/**
 * Oracle on real git: the host a conflict resolution's fetch and push reach
 * is the pinned host the publication dialog shows, whatever the project's
 * remote_url says.
 *
 * Every remote of a corpus of hostile forms (a backslash, a percent, a second
 * "@", a bracket in the ssh user, and what people really type) goes through
 * `pinnedRemote`. A refused one never reaches git. An accepted one gives a URL
 * the scratch repository hands the host's real git, with two witnesses
 * standing in for the network:
 * - https: a proxy (`https_proxy`) that records the host of git's CONNECT;
 * - ssh: a `GIT_SSH_COMMAND` that records the destination git gives ssh.
 * The host recorded must be the pinned one, or an SSH alias that resolves to
 * it. Skipped where git is missing: the witnesses replace ssh itself.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pinnedRemote } from './forge-conflicts.js';
import { forgeEndpointOf } from './forge-network-url.js';
import { openScratchRepo, type ScratchRepo } from './host/forge-scratch.js';
import { DEFAULT_PROJECT_INTEGRATION, type ProjectIntegration } from './project-integration.js';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const EVIL = 'evil.example';
/** What `ssh -G` answers for an alias in this test: github-acme is the user's alias of github.com. */
const ALIASES = new Map([['github-acme', 'github.com'], ['github-evil', EVIL]]);

/** The forms of the counter-audits (C1, S1) and their variants, and what people type. */
function corpus(): string[] {
  const urls = new Set<string>([
    'git@github.com:acme/app.git',
    'https://github.com/acme/app.git',
    'https://GitHub.com:443/acme/app',
    'ssh://git@ssh.github.com:443/acme/app.git',
    'ssh://git@github.com:22/acme/app.git',
    'git@github-acme:acme/app.git',
    'org-1@github.com:acme/app.git',
    'git@github-evil:acme/app.git',
    // C1: read as github.com by a URL parser, as evil.example by git.
    `https://github.com\\@${EVIL}/acme/app.git`,
    `https://github.com%5C@${EVIL}/acme/app.git`,
    `https://a@b@${EVIL}/acme/app.git`,
    `ssh://${EVIL}%2F@github.com/acme/app.git`,
    `ssh://git@${EVIL}@github.com/acme/app.git`,
    `github.com\\@${EVIL}:acme/app.git`,
    `https://${EVIL}#@github.com/acme/app.git`,
    `https://${EVIL}?@github.com/acme/app.git`,
    // S1: git's host_end() takes a bracket in the user for the host.
    `[${EVIL}]@github.com:acme/app.git`,
    `[${EVIL}]x@github.com:acme/app.git`,
    '[github-evil]@github.com:acme/app.git',
    `git@[${EVIL}]:acme/app.git`,
    `[${EVIL}]:acme/app.git`,
  ]);
  for (const scheme of ['ssh', 'git+ssh', 'ssh+git', 'https']) {
    for (const user of ['', 'git@', `[${EVIL}]@`, `[${EVIL}]x@`, `x[${EVIL}]@`, '[x]@', '[github-evil]@', `[git@${EVIL}]@`, '[@', ']@', `${EVIL}%2F@`, `git@${EVIL}@`]) {
      for (const host of ['github.com', 'github.com:22', 'github.com:443', 'ssh.github.com:443', 'github-acme', EVIL, `[${EVIL}]`, `github.com\\@${EVIL}`]) {
        urls.add(`${scheme}://${user}${host}/acme/app.git`);
      }
    }
  }
  return [...urls];
}

type Witness = { connects: string[]; sshCalls: string[][] };

test('a resolution\'s fetch and push reach the pinned host on real git, or nothing at all', { skip: !hasGit() && 'git is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-url-oracle-'));
  const witness: Witness = { connects: [], sshCalls: [] };

  const proxy = createServer((socket: Socket) => {
    socket.on('error', () => {});
    socket.once('data', (data) => {
      const line = data.toString('latin1').split('\r\n')[0] ?? '';
      witness.connects.push(line);
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;

  const sshLog = join(dir, 'ssh.log');
  const sshWitness = join(dir, 'ssh-witness.cjs');
  writeFileSync(sshLog, '');
  writeFileSync(sshWitness, [
    "const fs = require('node:fs');",
    'fs.appendFileSync(process.env.TIMON_ORACLE_SSH_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
    'process.exit(1);',
  ].join('\n'));
  const saved = { ...process.env };
  // The scratch repository keeps the daemon's SSH variables and the proxy:
  // the witnesses take the place of the network.
  for (const key of ['no_proxy', 'NO_PROXY', 'all_proxy', 'ALL_PROXY']) delete process.env[key];
  process.env.https_proxy = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  // Forward slashes: git runs the command through sh, Git for Windows included.
  process.env.GIT_SSH_COMMAND = `"${process.execPath.replace(/\\/g, '/')}" "${sshWitness.replace(/\\/g, '/')}"`; // portability: a witness of ssh, run by git's own sh
  process.env.GIT_SSH_VARIANT = 'ssh';
  process.env.TIMON_ORACLE_SSH_LOG = sshLog;

  const opened = await openScratchRepo({ root: join(dir, 'scratch'), ghConfigDir: null });
  assert.ok('dir' in opened, 'reason' in opened ? opened.reason : '');
  const scratch: ScratchRepo = opened;

  /** The host git reached for `url`, through the witnesses. */
  const reach = async (url: string, gesture: 'ls-remote' | 'fetch'): Promise<{ host: string; user: string | null; path: string | null }> => {
    witness.connects.length = 0;
    writeFileSync(sshLog, '');
    const out = gesture === 'fetch'
      ? await scratch.fetch(url, ['refs/heads/main:refs/timon/base'])
      : await scratch.remoteHead(url, 'main');
    assert.equal(out.ok, false, `${url}: the witnesses answer nothing`);
    const connect = /^CONNECT (\S+) HTTP/.exec(witness.connects[0] ?? '');
    if (connect) return { host: connect[1]!.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase(), user: null, path: null };
    const call = readFileSync(sshLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
      .find((args) => args.some((a) => /^git-(upload|receive)-pack /.test(a)));
    assert.ok(call, `${url}: git reached neither witness`);
    // `[-o …] [-p <port>] <destination> <command>`: the destination is the one before the command.
    const destination = call[call.length - 2]!;
    const at = destination.lastIndexOf('@');
    const command = /^git-(?:upload|receive)-pack '(.*)'$/.exec(call[call.length - 1]!);
    return { host: destination.slice(at + 1).toLowerCase(), user: at >= 0 ? destination.slice(0, at) : null, path: command?.[1] ?? null };
  };

  try {
    // The oracle sees a divergence when there is one: a raw evil URL is recorded as such.
    assert.equal((await reach(`https://${EVIL}/acme/app.git`, 'ls-remote')).host, EVIL);
    assert.equal((await reach(`ssh://git@${EVIL}/acme/app.git`, 'ls-remote')).host, EVIL);

    const integration = (remote_url: string): ProjectIntegration =>
      ({ ...DEFAULT_PROJECT_INTEGRATION, mode: 'pr', account: 'ai-bot', gh_config_dir: null, remote_url, contributor_conflicts: 'resolve' });
    const resolved = async (alias: string) => ALIASES.get(alias) ?? null;
    let accepted = 0;
    const refused: string[] = [];
    for (const remote of corpus()) {
      const pinned = await pinnedRemote(integration(remote), { sshHostName: resolved });
      if (!pinned.ok) {
        refused.push(remote);
        continue;
      }
      accepted++;
      const endpoint = forgeEndpointOf(remote)!;
      for (const [repo, gesture] of [['acme/app', 'fetch'], ['contrib/app', 'ls-remote']] as const) {
        const url = pinned.urlOf(repo);
        assert.ok(url, `${remote}: no URL for ${repo}`);
        const got = await reach(url, gesture);
        const lands = got.host === pinned.host || ALIASES.get(got.host) === pinned.host;
        assert.ok(lands, `${remote} → ${url}: git reached ${got.host}, the dialog shows ${pinned.host}`);
        assert.equal(got.host, endpoint.host, `${remote}: the host or alias of the remote, nothing else`);
        if (endpoint.scheme === 'ssh') {
          assert.equal(got.user, endpoint.user, remote);
          assert.equal(got.path, `/${repo}.git`, remote);
        }
      }
    }
    assert.ok(accepted >= 8, `the corpus keeps what people type (${accepted} accepted)`);
    // Nothing plain is refused: an alias and ssh.github.com are SSH names only, an https user a credential.
    for (const remote of refused) {
      const hostile = remote.includes(EVIL) || remote.includes('github-evil')
        || /[[\]\\%#?]|^https:\/\/[^/]*@|^https:\/\/(?:github-acme|ssh\.github\.com)[:/]/.test(remote);
      assert.ok(hostile, `${remote} was refused`);
    }
    // Every form with a bracket in its user is refused before git runs.
    for (const remote of corpus().filter((u) => /^(?:[a-z+]+:\/\/)?[^/@]*[[\]][^/@]*@/.test(u))) {
      assert.ok(refused.includes(remote), `${remote} was accepted`);
    }
  } finally {
    scratch.dispose();
    proxy.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
