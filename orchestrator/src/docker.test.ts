/**
 * Tests of the local URL derivation from the Traefik labels (docker.ts).
 *
 * `node --test --import tsx src/docker.test.ts` (or `npm test`). It is the only
 * part of the module that can go wrong silently: a wrong URL gives a
 * link that looks valid and opens nothing.
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, missingNetwork, traefikUrl } from './docker.js';
import { getHost, type ExecResult } from './host/index.js';
import { writeMeta } from './projects.js';

test('no traefik label → no URL', () => {
  assert.equal(traefikUrl({}), null);
  assert.equal(traefikUrl({ 'com.docker.compose.service': 'db' }), null);
});

test('simple Host rule → http URL', () => {
  assert.equal(
    traefikUrl({ 'traefik.http.routers.app.rule': 'Host(`contoso.localhost`)' }),
    'http://contoso.localhost',
  );
});

test('tls router → https wins over the http twin of the same host', () => {
  const url = traefikUrl({
    'traefik.http.routers.app.rule': 'Host(`timon.localhost`)',
    'traefik.http.routers.app-secure.rule': 'Host(`timon.localhost`)',
    'traefik.http.routers.app-secure.tls': 'true',
  });
  assert.equal(url, 'https://timon.localhost');
});

test('entrypoint websecure vaut tls', () => {
  assert.equal(
    traefikUrl({
      'traefik.http.routers.app.rule': 'Host(`globex.localhost`)',
      'traefik.http.routers.app.entrypoints': 'web,websecure',
    }),
    'https://globex.localhost',
  );
});

test('on a tie, the shallowest host wins', () => {
  // Real TIMON case: `channels.timon.localhost` must not eclipse the app.
  const url = traefikUrl({
    'traefik.http.routers.channels.rule': 'Host(`channels.timon.localhost`)',
    'traefik.http.routers.app.rule': 'Host(`timon.localhost`)',
  });
  assert.equal(url, 'http://timon.localhost');
});

test('a .localhost host wins over a public or tailscale host', () => {
  const url = traefikUrl({
    'traefik.http.routers.ts.rule': 'Host(`my-laptop.tail0000.ts.net`)',
    'traefik.http.routers.app.rule': 'Host(`app.localhost`)',
  });
  assert.equal(url, 'http://app.localhost');
});

test('composite rule: multiple hosts and side clauses are handled', () => {
  const url = traefikUrl({
    'traefik.http.routers.app.rule': 'Host(`a.localhost`, `b.localhost`) && PathPrefix(`/api`)',
  });
  // Two hosts with the same score: either one is acceptable, what matters
  // is that no stray clause ends up in the URL.
  assert.ok(url === 'http://a.localhost' || url === 'http://b.localhost');
});

test('rule without Host (PathPrefix alone) → no made-up URL', () => {
  assert.equal(traefikUrl({ 'traefik.http.routers.app.rule': 'PathPrefix(`/api`)' }), null);
});

/* ── TIM-0104: start on a deleted network ─────────────────────────────── */

test("missingNetwork reads the network whatever docker's wording", () => {
  assert.equal(missingNetwork('Error response from daemon: network traefik_network not found'), 'traefik_network');
  assert.equal(
    missingNetwork('Error response from daemon: failed to set up container networking: network "traefik_network" not found'),
    'traefik_network',
  );
  assert.equal(missingNetwork('Error response from daemon: No such container: abc'), null);
});

type Fake = { calls: string[][]; restore: () => void };

/** Simulated docker: two stopped compose containers, created on a network that
 *  no longer exists. `start` fails as long as `up -d` has not recreated them;
 *  `upFails` simulates a compose that also references a missing network. */
function fakeDocker(cwd: string, opts: { composeFile: boolean; upFails?: boolean }): Fake {
  const composeFile = join(cwd, 'compose.yaml');
  if (opts.composeFile) writeFileSync(composeFile, 'services: {}\n');
  let running = false;
  const calls: string[][] = [];
  const containers = ['app', 'db'].map((service, i) => ({
    id: `${String(i + 1).repeat(12)}aaaa`,
    service,
  }));
  const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
  const ko = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });
  const cli = (args: string[]): ExecResult => {
    calls.push(args);
    if (args[0] === 'ps') return ok(containers.map((c) => c.id).join('\n'));
    if (args[0] === 'inspect') {
      return ok(containers.map((c) => JSON.stringify({
        id: c.id,
        name: `/proj-${c.service}-1`,
        state: running ? 'running' : 'exited',
        health: null,
        started: '0001-01-01T00:00:00Z',
        labels: {
          'com.docker.compose.project': 'proj',
          'com.docker.compose.service': c.service,
          'com.docker.compose.project.working_dir': cwd,
          'com.docker.compose.project.config_files': composeFile,
        },
        ports: {},
      })).join('\n'));
    }
    if (args.includes('up')) {
      if (opts.upFails) return ko('network proxy_net declared as external, but could not be found');
      running = true;
      return ok();
    }
    if (args.includes('start') || args.includes('restart')) {
      return ko('Error response from daemon: network traefik_network not found');
    }
    return ko(`unexpected docker ${args.join(' ')}`);
  };
  const host = getHost();
  const original = host.containers;
  host.containers = { cli };
  return { calls, restore: () => { host.containers = original; } };
}

let seq = 0;
function project(): { slug: string; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'tim0104-'));
  const slug = `tim0104-${++seq}`;
  writeMeta(slug, { cwd });
  return { slug, cwd };
}

/** The docker scan is cached for 1.5 s: we wait for it so that each test
 *  rereads the simulated docker it just set. */
const settle = () => new Promise((r) => setTimeout(r, 1600));

test('start on a deleted network → the stack is recreated by compose up -d', async () => {
  await settle();
  const { slug, cwd } = project();
  const fake = fakeDocker(cwd, { composeFile: true });
  try {
    const status = act(slug, 'start');
    assert.equal(status.state, 'running');
    const up = fake.calls.find((a) => a.includes('up'));
    assert.ok(up, 'compose up -d expected after the failed start');
    assert.deepEqual(up.slice(-2), ['up', '-d']);
    assert.ok(!up.includes('--build'), 'no image rebuild for a mere network change');
  } finally { fake.restore(); }
});

test('start of a single container → only its service is recreated', async () => {
  await settle();
  const { slug, cwd } = project();
  const fake = fakeDocker(cwd, { composeFile: true });
  try {
    act(slug, 'start', 'proj-db-1');
    const up = fake.calls.find((a) => a.includes('up'));
    assert.ok(up);
    assert.deepEqual(up.slice(-3), ['up', '-d', 'db']);
  } finally { fake.restore(); }
});

test('compose up -d fails too → a message naming the network and offering Rebuild', async () => {
  await settle();
  const { slug, cwd } = project();
  const fake = fakeDocker(cwd, { composeFile: true, upFails: true });
  try {
    assert.throws(() => act(slug, 'restart'), (err: Error) =>
      err.message.includes('"traefik_network" no longer exists')
      && err.message.includes('proxy_net')
      && err.message.includes('Rebuild'));
  } finally { fake.restore(); }
});

test('compose files gone → no fallback, a message giving the command', async () => {
  await settle();
  const { slug, cwd } = project();
  const fake = fakeDocker(cwd, { composeFile: false });
  try {
    assert.throws(() => act(slug, 'start'), (err: Error) =>
      err.message.includes('"traefik_network" no longer exists')
      && err.message.includes('docker compose up -d'));
    assert.ok(!fake.calls.some((a) => a.includes('up')));
  } finally { fake.restore(); }
});
