/**
 * Tests of the pure logic of the embedded browsers (browser-sessions.ts).
 *
 * `node --test --import tsx src/browser-sessions.test.ts` (or `npm test`).
 *
 * Docker is NOT tested: what breaks silently here is the port
 * allocation (a collision only shows at bind time, with an unreadable message),
 * the reconciliation (never exercised by hand) and above all the CDP bind: a
 * debug port published on 0.0.0.0 works perfectly, it is just open to the whole
 * network.
 *
 * Exception: the docker network check (`ensureBrowserNetwork`) takes an
 * injectable runner, so its docker calls are faked here.
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sep } from 'node:path';
import {
  CDP_PORT_RANGE,
  GENERAL_BROWSER_SLUG,
  CHROME_DEVTOOLS_MCP_KEY,
  chromeDevtoolsMcpEntry,
  allocatePort,
  browserPath,
  containerName,
  diffSessions,
  ensureBrowserNetwork,
  hashPages,
  isIdleExpired,
  isRestorablePage,
  isValidSlug,
  missingTabs,
  noteBrowserSessionSpawned,
  parseStoredTabs,
  proxyArgs,
  proxyName,
  routerName,
  runArgs,
  projectMountArgs,
  dockerRunError,
  touchBrowserSessionActivity,
  traefikLabels,
  webProxyArgs,
  webProxyName,
} from './browser-sessions.js';
import type { BrowserSessionStatus, Run } from './browser-sessions.js';
import { dbApi } from './db.js';

/* ── validation du slug ──────────────────────────────────────────────────── */

test('slug: same grammar as projects.ts', () => {
  assert.ok(isValidSlug('timon'));
  assert.ok(isValidSlug('mail-watch'));
  assert.ok(isValidSlug('example-cms-php'));
  assert.ok(isValidSlug('a.b_c-1'));
});

test('slug: anything that could escape into a docker argument is refused', () => {
  assert.ok(!isValidSlug(''));
  assert.ok(!isValidSlug('../../etc'));
  assert.ok(!isValidSlug('timon; rm -rf /'));
  assert.ok(!isValidSlug('timon evil'));
  assert.ok(!isValidSlug('pk/os'));
  assert.ok(!isValidSlug('`whoami`'));
  assert.ok(!isValidSlug('a'.repeat(65)));
});

/* ── allocation de port ──────────────────────────────────────────────────── */

test('port: first free one of the range when nothing is taken', () => {
  assert.equal(allocatePort(CDP_PORT_RANGE, []), 9300);
});

test('port: skips the ports already taken', () => {
  assert.equal(allocatePort(CDP_PORT_RANGE, [9300, 9301, 9303]), 9302);
});

test('port: the port already assigned to the project is reused if it is free', () => {
  // That is what makes the port STABLE from one stop/start to the next: a CDP client
  // configured once keeps targeting the right browser.
  assert.equal(allocatePort(CDP_PORT_RANGE, [9300, 9301], 9307), 9307);
});

test('port: a busy preferred port does not win, otherwise two projects bind the same one', () => {
  assert.equal(allocatePort(CDP_PORT_RANGE, [9300, 9307], 9307), 9301);
});

test('port: a preferred port outside the range is ignored', () => {
  assert.equal(allocatePort(CDP_PORT_RANGE, [], 22), 9300);
});

test('port: saturated range → explicit error rather than a port outside the range', () => {
  const all = Array.from({ length: 100 }, (_, i) => 9300 + i);
  assert.throws(() => allocatePort(CDP_PORT_RANGE, all), /no free port in range/);
});

/* ── docker network of the browser ───────────────────────────────────── */

/** Fake docker: answers `network inspect` / `network create` from a script and
 *  records every call. */
function fakeDocker(answers: { inspect: boolean[]; create?: Run }) {
  const calls: string[][] = [];
  const inspect = [...answers.inspect];
  const exec = (args: string[]): Run => {
    calls.push(args);
    if (args[1] === 'inspect') {
      const ok = inspect.shift() ?? false;
      return { ok, out: '', err: ok ? '' : 'Error response from daemon: network traefik_network not found' };
    }
    return answers.create ?? { ok: true, out: 'abc123', err: '' };
  };
  return { exec, calls };
}

test('network: present → nothing is created', () => {
  const d = fakeDocker({ inspect: [true] });
  ensureBrowserNetwork('traefik_network', d.exec);
  assert.deepEqual(d.calls, [['network', 'inspect', 'traefik_network']]);
});

test('network: missing → created under the configured name', () => {
  const d = fakeDocker({ inspect: [false] });
  ensureBrowserNetwork('my_net', d.exec);
  assert.deepEqual(d.calls[1], ['network', 'create', 'my_net']);
  assert.equal(d.calls.length, 2);
});

test('network: create lost a race but the network now exists → no error', () => {
  const d = fakeDocker({
    inspect: [false, true],
    create: { ok: false, out: '', err: 'network with name traefik_network already exists' },
  });
  assert.doesNotThrow(() => ensureBrowserNetwork('traefik_network', d.exec));
  assert.equal(d.calls.length, 3);
});

test('network: unusable → clear error naming the network, the setting and docker\'s message', () => {
  const d = fakeDocker({
    inspect: [false, false],
    create: { ok: false, out: '', err: 'Cannot connect to the Docker daemon' },
  });
  assert.throws(
    () => ensureBrowserNetwork('traefik_network', d.exec),
    (err: Error) => err.message.includes('"traefik_network"')
      && err.message.includes('TIMON_BROWSER_NETWORK')
      && err.message.includes('Cannot connect to the Docker daemon'),
  );
});

/* ── exposure guard ──────────────────────────────────────────────── */

test('CDP: published on 127.0.0.1 only, never on 0.0.0.0', () => {
  const args = runArgs('timon', 9312);
  const publish = args[args.indexOf('-p') + 1];
  // 9223 = the socat relay, not Chromium: the debugger only listens on the
  // container loopback (see the module header).
  assert.equal(publish, '127.0.0.1:9312:9223');
  // The guard is the address prefix: without it docker publishes on 0.0.0.0.
  assert.ok(!args.some((a) => a.includes('0.0.0.0:')));
});

test('the CDP relay shares the network stack of the browser and publishes nothing', () => {
  const args = proxyArgs('timon');
  assert.equal(args[args.indexOf('--network') + 1], 'container:timon-browser-timon');
  // A `-p` on the relay would be refused by docker: ports are published on
  // the container that owns the network stack.
  assert.ok(!args.includes('-p'));
  assert.equal(proxyName('timon'), 'timon-cdp-timon');
  assert.ok(args.includes('tcp-listen:9223,fork,reuseaddr'));
  assert.ok(args.includes('tcp:127.0.0.1:9222'));
  assert.ok(args.includes('timon.browser.proxy=1'));
});

test('the web port (noVNC) is NOT published on the host: Traefik reaches it through the docker network', () => {
  const args = runArgs('timon', 9312);
  const published = args.filter((a, i) => args[i - 1] === '-p');
  assert.equal(published.length, 1);
  assert.ok(!published.some((p) => p.endsWith(':3000')));
  assert.ok(args.includes('--network'));
});

test('the container does not come back to life on its own at reboot', () => {
  const args = runArgs('timon', 9300);
  assert.equal(args[args.indexOf('--restart') + 1], 'no');
});

test('the project profile is mounted on /config', () => {
  const args = runArgs('globex', 9300);
  const mount = args[args.indexOf('-v') + 1] ?? '';
  assert.match(mount, /[\\/]browser-profiles[\\/]globex:\/config$/, mount);
});

test('the web relay puts Traefik at the end of the browser loopback', () => {
  const args = webProxyArgs('timon');
  // Same network stack as the browser: that is what makes this 127.0.0.1 bind
  // ITS loopback, the one where every `*.localhost` lands (RFC 6761).
  assert.equal(args[args.indexOf('--network') + 1], 'container:timon-browser-timon');
  assert.equal(webProxyName('timon'), 'timon-web-timon');
  const script = args[args.length - 1] ?? '';
  for (const port of [80, 443]) {
    assert.ok(
      script.includes(`TCP-LISTEN:${port},fork,reuseaddr,bind=127.0.0.1`),
      `port ${port} absent : ${script}`,
    );
    assert.ok(script.includes(`TCP:traefik:${port}`), `target ${port} missing: ${script}`);
  }
  // A relay never publishes a port: docker refuses it when the network stack
  // belongs to another container.
  assert.ok(!args.includes('-p'));
});

// Under Windows the target is the POSIX form of the path: the TIM-0120 test below.
test('the project is mounted at the SAME absolute path, read-only', { skip: process.platform === 'win32' }, () => {
  // The identical path on both sides is what makes `upload_file` usable
  // under Linux and macOS: the agent's path is valid in the container too.
  const args = runArgs('timon', 9300, process.cwd());
  const mounts = args.filter((a, i) => args[i - 1] === '--mount');
  assert.deepEqual(mounts, [`type=bind,source=${process.cwd()},target=${process.cwd()},readonly`]);
});

test('no project mount when the path is unknown or missing from disk', () => {
  // Without this guard, docker creates an empty root folder in place of the repository.
  for (const path of [null, undefined, '', '/n/existe/pas']) {
    const args = runArgs('timon', 9300, path);
    assert.ok(!args.includes('--mount'), `${path} → ${args.join(' ')}`);
    assert.equal(args.filter((a, i) => args[i - 1] === '-v').length, 1, `${path}`);
  }
});

test('TIM-0120: under Windows, Windows source and POSIX target, without a `:` to split', () => {
  const exists = () => true;
  assert.deepEqual(projectMountArgs('D:\\Projects\\SamothRAS', 'win32', exists),
    ['--mount', 'type=bind,source=D:\\Projects\\SamothRAS,target=/host/d/Projects/SamothRAS,readonly']);
  assert.deepEqual(projectMountArgs('\\\\nas\\work\\My Site', 'win32', exists),
    ['--mount', 'type=bind,source=\\\\nas\\work\\My Site,target=/host/unc/nas/work/My Site,readonly']);
  // A path that cannot be mounted (no drive) does not break the startup.
  assert.deepEqual(projectMountArgs('Projects\\X', 'win32', exists), []);
  assert.deepEqual(projectMountArgs('D:\\Projects\\X', 'win32', () => false), []);
});

test('--mount: a path holding a comma or a quote is quoted as CSV', () => {
  assert.deepEqual(projectMountArgs('/srv/a,b "c"', 'linux', () => true),
    ['--mount', 'type=bind,"source=/srv/a,b ""c""","target=/srv/a,b ""c""",readonly']);
});

test('failing docker run: its stderr goes up into the error, truncated', () => {
  const warn = console.warn;
  const logged: string[] = [];
  console.warn = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    const err = dockerRunError('globex', 'browser', { ok: false, out: '', err: 'docker: Error response from daemon: mount denied\n' });
    assert.equal(err.message, 'docker run of the browser failed: docker: Error response from daemon: mount denied');
    assert.match(logged[0] ?? '', /globex.*mount denied/);
    assert.ok(dockerRunError('globex', 'browser', { ok: false, out: '', err: 'x'.repeat(5000) }).message.length < 1100);
    assert.match(dockerRunError('globex', 'CDP relay', { ok: false, out: '', err: '' }).message, /exit without a message/);
  } finally {
    console.warn = warn;
  }
});

test('Chromium is launched with remote debugging open in the container', () => {
  const cli = runArgs('timon', 9300).find((a) => a.startsWith('CHROME_CLI='));
  assert.ok(cli?.includes('--remote-debugging-port=9222'));
  // No `--remote-debugging-address`: Chromium ignores it since M111 (checked
  // on Chrome 151, it listens on 127.0.0.1 whatever it is given). Leaving it
  // would suggest the port crosses the mapping while it does not.
  assert.ok(!cli?.includes('--remote-debugging-address'));
});

/* ── nommage et labels Traefik ───────────────────────────────────────────── */

test('deterministic container name', () => {
  assert.equal(containerName('timon'), 'timon-browser-timon');
});

test('router name: the dots of the slug are neutralised', () => {
  // Traefik label keys are split on the dot: `routers.a.b.rule`
  // would be read as router `a`, field `b`, and ignored.
  assert.equal(routerName('mon.projet'), 'timon-browser-mon-projet');
  assert.equal(routerName('Mail_Watch'), 'timon-browser-mail-watch');
  assert.ok(/^[a-z0-9-]+$/.test(routerName('a.b_C')));
});

test('Traefik labels: rule on the prefix, prefix strip, internal web port', () => {
  const labels = traefikLabels('timon');
  const rule = labels.find((l) => l.startsWith('traefik.http.routers.timon-browser-timon.rule='));
  assert.ok(rule?.includes('PathPrefix(`/browser/timon`)'), rule);
  assert.ok(rule?.includes('Host(`timon.localhost`)'), rule);
  assert.ok(labels.includes('traefik.enable=true'));
  assert.ok(labels.some((l) => l.endsWith('.stripprefix.prefixes=/browser/timon')));
  assert.ok(labels.some((l) => /loadbalancer\.server\.port=\d+$/.test(l)));
  // The ownership marker: the reconciliation filter.
  assert.ok(labels.includes('timon.browser=1'));
});

test('Traefik labels: an http router and an https router, like the app', () => {
  const labels = traefikLabels('timon');
  assert.ok(labels.includes('traefik.http.routers.timon-browser-timon.entrypoints=web'));
  assert.ok(labels.includes('traefik.http.routers.timon-browser-timon-secure.entrypoints=websecure'));
  assert.ok(labels.includes('traefik.http.routers.timon-browser-timon-secure.tls=true'));
});

test('HTTP path derived from the slug', () => {
  assert.equal(browserPath('mail-watch'), '/browser/mail-watch');
});

/* ── reconciliation ──────────────────────────────────────────────────────── */

const row = (project: string, status: 'running' | 'stopped') => ({
  project,
  container_name: `timon-browser-${project}`,
  status,
});

test('reconciliation: no gap → no correction', () => {
  const d = diffSessions(
    [row('timon', 'running'), row('globex', 'stopped')],
    new Set(['timon-browser-timon']),
  );
  assert.deepEqual(d, { toStop: [], toStart: [] });
});

test('reconciliation: database "running" but container gone → stopped', () => {
  const d = diffSessions([row('timon', 'running')], new Set());
  assert.deepEqual(d.toStop, ['timon']);
  assert.deepEqual(d.toStart, []);
});

test('reconciliation: container alive but database "stopped" → running', () => {
  // The dangerous case: without this direction, a `start` would destroy a browser
  // that is very much alive, work session included.
  const d = diffSessions([row('globex', 'stopped')], new Set(['timon-browser-globex']));
  assert.deepEqual(d.toStart, ['globex']);
  assert.deepEqual(d.toStop, []);
});

test("reconciliation: another project's container does not validate mine", () => {
  const d = diffSessions([row('timon', 'running')], new Set(['timon-browser-globex']));
  assert.deepEqual(d.toStop, ['timon']);
});

test('reconciliation: idempotent, replayed on the corrected state it does nothing', () => {
  const rows = [row('timon', 'running'), row('globex', 'stopped')];
  const live = new Set<string>();
  const first = diffSessions(rows, live);
  assert.deepEqual(first.toStop, ['timon']);
  const corrected = rows.map((r) =>
    first.toStop.includes(r.project) ? { ...r, status: 'stopped' as const } : r);
  assert.deepEqual(diffSessions(corrected, live), { toStop: [], toStart: [] });
});

/* ── branchement de chrome-devtools-mcp ──────────────────────────────────── */

/** A fake `getBrowserSession`: the wiring is tested without docker or a database, which
 *  is the whole point of having moved the resolution into a pure function. */
function fakeLookup(sessions: Record<string, { status: string; cdp_url: string }>) {
  const calls: string[] = [];
  const lookup = (slug: string) => {
    calls.push(slug);
    return (sessions[slug] ?? null) as { status: BrowserSessionStatus; cdp_url: string } | null;
  };
  return { lookup, calls };
}

const RUNNING = { timon: { status: 'running', cdp_url: 'http://127.0.0.1:9300' } };

test('mcp: browser up → --browserUrl on the project CDP', () => {
  const { lookup } = fakeLookup(RUNNING);
  const entry = chromeDevtoolsMcpEntry({ project: 'timon' }, lookup);
  assert.ok(entry);
  assert.equal(entry.command, 'npx');
  // The URL must IMMEDIATELY follow the flag: it is an argv, not an object.
  const i = entry.args.indexOf('--browserUrl');
  assert.ok(i >= 0, '--browserUrl absent');
  assert.equal(entry.args[i + 1], 'http://127.0.0.1:9300');
  assert.ok(entry.args.some((a) => a.startsWith('chrome-devtools-mcp')));
});

test("mcp: the key does not take the one of the user's chrome-devtools", () => {
  // Timon imposes nothing: `chrome-devtools` stays the user's, a fallback if the
  // built-in browser breaks.
  assert.equal(CHROME_DEVTOOLS_MCP_KEY, 'timon-browser');
});

test('mcp: no session → null (fallback on the local Chrome of the CLI)', () => {
  const { lookup } = fakeLookup({});
  assert.equal(chromeDevtoolsMcpEntry({ project: 'timon' }, lookup), null);
});

test('mcp: "stopped" session → null, even if it still carries its port', () => {
  // The row survives the stop of the container (it carries the assigned port):
  // without this test, the MCP would be wired to a closed port, a mute failure.
  const { lookup } = fakeLookup({
    timon: { status: 'stopped', cdp_url: 'http://127.0.0.1:9300' },
  });
  assert.equal(chromeDevtoolsMcpEntry({ project: 'timon' }, lookup), null);
});

test('mcp: the project is inferred from the cwd when the agent declares none', () => {
  const { lookup, calls } = fakeLookup(RUNNING);
  assert.ok(chromeDevtoolsMcpEntry({ cwd: '/home/user/webdev/projects/timon' }, lookup));
  assert.deepEqual(calls, ['timon']);
});

test('mcp: the declared project wins over the cwd', () => {
  // The case of tasks: their cwd is a `~/.timon/worktrees/<id>` worktree, from which
  // no slug can be inferred; without the precedence, no task would have a
  // browser.
  const { lookup, calls } = fakeLookup(RUNNING);
  assert.ok(chromeDevtoolsMcpEntry(
    { project: 'timon', cwd: '/home/user/.timon/worktrees/abc-123' }, lookup));
  assert.deepEqual(calls, ['timon']);
});

test('mcp: agents without a project use the general browser if it runs', () => {
  const { lookup, calls } = fakeLookup({ [GENERAL_BROWSER_SLUG]: RUNNING.timon });
  for (const ref of [null, {}, { cwd: '/home/user/.timon/worktrees/abc-123' }, { project: '', cwd: '' }]) {
    assert.ok(chromeDevtoolsMcpEntry(ref, lookup));
  }
  assert.deepEqual(calls, Array(4).fill(GENERAL_BROWSER_SLUG));
  assert.equal(chromeDevtoolsMcpEntry({}, () => null), null);
  assert.equal(chromeDevtoolsMcpEntry({}, () => ({ ...RUNNING.timon, status: 'stopped' })), null);
});

test('mcp: under Windows, the relay translates the upload_file paths (TIM-0120)', () => {
  const lookup = () => ({ ...RUNNING.timon, status: 'running' as const, project_path: 'D:\\Projects\\X' });
  const entry = chromeDevtoolsMcpEntry({ project: 'timon' }, lookup, 'win32');
  assert.ok(entry);
  assert.equal(entry.command, process.execPath);
  assert.match(entry.args[0] ?? '', /browser-upload-relay-runner\.js$/);
  const spec = JSON.parse(entry.env?.TIMON_BROWSER_RELAY_SPEC ?? '{}');
  assert.equal(spec.command, 'npx');
  assert.deepEqual(spec.args.slice(-2), ['--browserUrl', 'http://127.0.0.1:9300']);
  assert.deepEqual(spec.mount, { source: 'D:\\Projects\\X', target: '/host/d/Projects/X' });
  assert.equal(spec.platform, 'win32');
});

test('mcp: Linux, macOS or Windows without a mounted project → chrome-devtools-mcp directly', () => {
  const withPath = () => ({ ...RUNNING.timon, status: 'running' as const, project_path: '/home/user/x' });
  for (const platform of ['linux', 'darwin'] as const) {
    assert.equal(chromeDevtoolsMcpEntry({ project: 'timon' }, withPath, platform)?.command, 'npx');
  }
  const noPath = () => ({ ...RUNNING.timon, status: 'running' as const, project_path: null });
  assert.equal(chromeDevtoolsMcpEntry({ project: 'timon' }, noPath, 'win32')?.command, 'npx');
});

test('the general profile persists under TIMON_HOME without mounting the cwd', () => {
  const args = runArgs(GENERAL_BROWSER_SLUG, 9300);
  const mounts = args.filter((_, i) => args[i - 1] === '-v');
  assert.equal(mounts.length, 1);
  assert.ok(mounts[0]?.endsWith(`${sep}browser-profiles${sep}${GENERAL_BROWSER_SLUG}:/config`), mounts[0]);
});

test('mcp: a slug outside the grammar is refused before any resolution', () => {
  // The slug ends up in an argv: it must never reach the database or docker
  // without going through `isValidSlug`.
  const { lookup, calls } = fakeLookup(RUNNING);
  assert.equal(chromeDevtoolsMcpEntry({ project: 'timon; rm -rf /' }, lookup), null);
  assert.deepEqual(calls, []);
});

/* ── idle threshold (isIdleExpired) ──────────────────────────────────── */

test('idle: disabled (≤0) → never expired, whatever the age', () => {
  assert.equal(isIdleExpired({ last_used_at: 0, started_at: 0 }, Date.now(), 0), false);
  assert.equal(isIdleExpired({ last_used_at: 0, started_at: 0 }, Date.now(), -5), false);
});

test('idle: under the threshold → not expired', () => {
  const now = 1_000_000_000_000;
  assert.equal(isIdleExpired({ last_used_at: now - 29 * 60_000, started_at: null }, now, 30), false);
});

test('idle: beyond the threshold → expired', () => {
  const now = 1_000_000_000_000;
  assert.equal(isIdleExpired({ last_used_at: now - 31 * 60_000, started_at: null }, now, 30), true);
});

test('idle: exactly at the threshold → expired (inclusive bound)', () => {
  const now = 1_000_000_000_000;
  assert.equal(isIdleExpired({ last_used_at: now - 30 * 60_000, started_at: null }, now, 30), true);
});

test('idle: a session never touched falls back on started_at', () => {
  // That is the case of a session that just opened: no signal has bumped it
  // yet, it must not look infinitely old for all that.
  const now = 1_000_000_000_000;
  assert.equal(
    isIdleExpired({ last_used_at: null, started_at: now - 2 * 60_000 }, now, 30),
    false,
    'ouverte il y a 2 minutes : jamais en retard',
  );
  assert.equal(
    isIdleExpired({ last_used_at: null, started_at: now - 45 * 60_000 }, now, 30),
    true,
    'opened 45 minutes ago, never touched since: expired',
  );
});

test('idle: neither last_used_at nor started_at → refuse to close rather than guess', () => {
  const now = 1_000_000_000_000;
  assert.equal(isIdleExpired({ last_used_at: null, started_at: null }, now, 30), false);
});

/* ── activity (dbApi, real table isolated by test-home.js) ─────────────── */

function seedRunningSession(project: string, startedAt: number): void {
  dbApi.upsertBrowserSession({
    project,
    containerName: containerName(project),
    cdpPort: 9300,
    novncPort: 3000,
    status: 'running',
    startedAt,
    stoppedAt: null,
  });
}

test('activity: a starting session is seeded on started_at, not NULL', () => {
  seedRunningSession('seed-a', 12345);
  const row = dbApi.getBrowserSession('seed-a');
  assert.equal(row?.last_used_at, 12345);
});

test('activity: touchBrowserSessionActivity bumps last_used_at of a running session', () => {
  seedRunningSession('seed-b', 1000);
  touchBrowserSessionActivity('seed-b', 99999);
  assert.equal(dbApi.getBrowserSession('seed-b')?.last_used_at, 99999);
});

test('activity: touchBrowserSessionActivity is a no-op on a stopped session', () => {
  seedRunningSession('seed-c', 1000);
  dbApi.setBrowserSessionStatus('seed-c', 'stopped', 2000);
  touchBrowserSessionActivity('seed-c', 99999);
  // A late signal must not revive the freshness of a stopped
  // row: `last_used_at` stays the one from before the stop.
  assert.equal(dbApi.getBrowserSession('seed-c')?.last_used_at, 1000);
});

test('activity: touchBrowserSessionActivity on a project without a session does not blow up', () => {
  assert.doesNotThrow(() => touchBrowserSessionActivity('jamais-ouvert'));
});

test('noteBrowserSessionSpawned: bumps the resolved project, running only', () => {
  seedRunningSession('seed-d', 1000);
  noteBrowserSessionSpawned({ project: 'seed-d' });
  assert.ok((dbApi.getBrowserSession('seed-d')?.last_used_at ?? 0) > 1000);
});

test('noteBrowserSessionSpawned: an orphan agent keeps the general browser active', () => {
  seedRunningSession(GENERAL_BROWSER_SLUG, 1000);
  noteBrowserSessionSpawned({});
  assert.ok((dbApi.getBrowserSession(GENERAL_BROWSER_SLUG)?.last_used_at ?? 0) > 1000);
});

test('noteBrowserSessionSpawned: a slug outside the grammar is refused before any resolution', () => {
  assert.doesNotThrow(() => noteBrowserSessionSpawned({ project: 'timon; rm -rf /' }));
});

/* ── CDP pages: filtering, fingerprint ─────────────────────────────────────── */

test('isRestorablePage: keeps a real http/https page', () => {
  assert.ok(isRestorablePage({ type: 'page', url: 'https://example.com/dashboard' }));
});

test('isRestorablePage: drops about:blank, internal pages and non-pages', () => {
  assert.ok(!isRestorablePage({ type: 'page', url: 'about:blank' }));
  assert.ok(!isRestorablePage({ type: 'page', url: '' }));
  assert.ok(!isRestorablePage({ type: 'page', url: 'chrome://settings' }));
  assert.ok(!isRestorablePage({ type: 'page', url: 'devtools://devtools/bundled/inspector.html' }));
  assert.ok(!isRestorablePage({ type: 'page', url: 'chrome-extension://abc/popup.html' }));
  assert.ok(!isRestorablePage({ type: 'background_page', url: 'https://example.com' }));
  assert.ok(!isRestorablePage({ type: 'service_worker', url: 'https://example.com/sw.js' }));
});

test('hashPages: insensitive to the order of tabs', () => {
  const a = [{ url: 'https://a.test', title: 'A' }, { url: 'https://b.test', title: 'B' }];
  const b = [{ url: 'https://b.test', title: 'B' }, { url: 'https://a.test', title: 'A' }];
  assert.equal(hashPages(a), hashPages(b));
});

test('hashPages: sensitive to a title change (navigation in the same tab)', () => {
  const before = [{ url: 'https://a.test', title: 'Chargement…' }];
  const after = [{ url: 'https://a.test', title: 'Tableau de bord' }];
  assert.notEqual(hashPages(before), hashPages(after));
});

test('hashPages: sensitive to one tab more or less', () => {
  const one = [{ url: 'https://a.test', title: 'A' }];
  const two = [{ url: 'https://a.test', title: 'A' }, { url: 'https://b.test', title: 'B' }];
  assert.notEqual(hashPages(one), hashPages(two));
});

/* ── tab restoration (parseStoredTabs, missingTabs, dedup) ────── */

test('parseStoredTabs: reads a valid JSON', () => {
  const raw = JSON.stringify([{ url: 'https://a.test', title: 'A' }]);
  assert.deepEqual(parseStoredTabs(raw), [{ url: 'https://a.test', title: 'A' }]);
});

test('parseStoredTabs: null, invalid JSON, non-array or malformed entries → empty list', () => {
  assert.deepEqual(parseStoredTabs(null), []);
  assert.deepEqual(parseStoredTabs('{ pas du json'), []);
  assert.deepEqual(parseStoredTabs('{"url":"https://a.test"}'), [], 'an object, not an array');
  assert.deepEqual(parseStoredTabs('[{"url":"https://a.test"}]'), [], 'title manquant');
  assert.deepEqual(parseStoredTabs('[{"title":"A"}]'), [], 'url manquante');
  assert.deepEqual(parseStoredTabs('[null, 42, "x"]'), []);
});

test('parseStoredTabs: filters invalid entries without dropping the valid ones', () => {
  const raw = JSON.stringify([
    { url: 'https://a.test', title: 'A' },
    { url: 42, title: 'B' },
    { url: 'https://c.test', title: 'C' },
  ]);
  assert.deepEqual(parseStoredTabs(raw), [
    { url: 'https://a.test', title: 'A' },
    { url: 'https://c.test', title: 'C' },
  ]);
});

test('dedup: a tab already restored by Chromium is not reopened', () => {
  // That is the bug explicitly to avoid: the natural path + the active safety net at
  // the same time must never double a tab.
  const stored = [{ url: 'https://a.test', title: 'A' }, { url: 'https://b.test', title: 'B' }];
  const alreadyOpen = [{ url: 'https://a.test' }, { url: 'https://b.test' }];
  assert.deepEqual(missingTabs(stored, alreadyOpen), []);
});

test('dedup: only the missing tabs are kept', () => {
  const stored = [{ url: 'https://a.test', title: 'A' }, { url: 'https://b.test', title: 'B' }];
  const alreadyOpen = [{ url: 'https://a.test' }];
  assert.deepEqual(missingTabs(stored, alreadyOpen), [{ url: 'https://b.test', title: 'B' }]);
});

test('dedup: nothing stored or nothing open → consistent edge cases', () => {
  assert.deepEqual(missingTabs([], [{ url: 'https://a.test' }]), []);
  const stored = [{ url: 'https://a.test', title: 'A' }];
  assert.deepEqual(missingTabs(stored, []), stored);
});

test('dedup: comparison on the EXACT URL, one more parameter is not a duplicate', () => {
  // Documents the deliberate choice: one more `?utm=` would give a false
  // "missing" and would open a duplicate anyway (see the comment of
  // `missingTabs`). Not ideal, but an occasional false "missing" is a
  // much lesser evil than a fuzzy comparison that would hide a really
  // vanished tab.
  const stored = [{ url: 'https://a.test/?utm=1', title: 'A' }];
  const alreadyOpen = [{ url: 'https://a.test/' }];
  assert.deepEqual(missingTabs(stored, alreadyOpen), stored);
});
