import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RELEASE_MANIFEST_VERSION, digest, productFiles, verifyRelease } from '../scripts/release-integrity.mjs';
import { checkWithWindow, verifyReleaseInWorker } from './release-check.js';
import { waitingPage } from './waiting-page.js';

const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** A signed release as `prepare-daemon-release.mjs` lays it out. */
function release(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'timon-release-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['dist', 'bin', 'scripts', 'presets']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'dist/boot.js'), 'export {};');
  writeFileSync(join(root, 'bin/timon'), '#!/usr/bin/env node');
  const files = Object.fromEntries(productFiles(root).map((name) => [name, digest(join(root, name))]));
  const body = Buffer.from(JSON.stringify({ version: RELEASE_MANIFEST_VERSION, files }));
  writeFileSync(join(root, 'release-manifest.json'), body);
  writeFileSync(join(root, 'release-manifest.sig'), sign(null, body, pair.privateKey));
  return root;
}

function syncMessage(root: string): string {
  try { verifyRelease(root, publicKey); } catch (error) { return (error as Error).message; }
  throw new Error('the synchronous check accepted the release');
}

test('TODO #439: the worker accepts an intact release and returns the signed inventory', async (t) => {
  const root = release(t);
  assert.deepEqual(await verifyReleaseInWorker(root, publicKey), verifyRelease(root, publicKey));
});

const tampering: Record<string, (root: string) => void> = {
  'an edited file': (root) => writeFileSync(join(root, 'dist/boot.js'), 'export const cracked = 1;'),
  'an added file': (root) => writeFileSync(join(root, 'dist/injected.js'), ''),
  'a deleted file': (root) => rmSync(join(root, 'bin/timon')),
  'a forged signature': (root) => writeFileSync(join(root, 'release-manifest.sig'), 'fake'),
  'a missing signature': (root) => rmSync(join(root, 'release-manifest.sig')),
};
for (const [name, tamper] of Object.entries(tampering)) {
  test(`TODO #439: the worker refuses ${name} with the message of the synchronous check`, async (t) => {
    const root = release(t);
    tamper(root);
    const expected = syncMessage(root);
    await assert.rejects(verifyReleaseInWorker(root, publicKey), (error: Error) => error.message === expected);
  });
}

test('TODO #439: a worker that dies without a verdict is not a verified release', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-release-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'silent.mjs');
  writeFileSync(script, 'process.exit(0);');
  await assert.rejects(verifyReleaseInWorker(dir, publicKey, pathToFileURL(script)), /stopped before its verdict/);
});

type Timer = { fn: () => void; ms: number; cleared: boolean };
function clock() {
  const timers: Timer[] = [];
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (handle: unknown) => { (handle as Timer).cleared = true; },
  };
}

test('TODO #439: a quick check never opens the window', async () => {
  const c = clock();
  let shown = 0;
  assert.equal(await checkWithWindow({ verify: async () => 'ok', show: () => { shown++; return () => {}; }, ...c }), 'ok');
  assert.equal(shown, 0);
  assert.equal(c.timers.length, 1);
  assert.equal(c.timers[0]!.cleared, true);
});

test('TODO #439: a slow check shows the window, then closes it whether it passes or fails', async () => {
  for (const outcome of ['pass', 'fail'] as const) {
    const c = clock();
    const events: string[] = [];
    let finish!: () => void;
    const verdict = new Promise<void>((resolve) => { finish = resolve; });
    const run = checkWithWindow({
      verify: async () => { await verdict; if (outcome === 'fail') throw new Error('Release integrity failed: dist/boot.js'); return 'ok'; },
      show: () => { events.push('show'); return () => events.push('close'); },
      ...c,
    });
    c.timers[0]!.fn();
    assert.deepEqual(events, ['show']);
    finish();
    if (outcome === 'pass') assert.equal(await run, 'ok');
    else await assert.rejects(run, /^Error: Release integrity failed: dist\/boot\.js$/);
    assert.deepEqual(events, ['show', 'close']);
  }
});

test('TODO #439: the check page says the installation is being verified, before the service', () => {
  const html = waitingPage('en', 'dark', 'verifying');
  assert.match(html, /<li class="active">.*Checking the installation…/);
  assert.match(html, /<li class="pending">.*Service/);
  assert.match(html, /antivirus/);
  assert.doesNotMatch(html, /<script|src=|href=/);
  assert.match(waitingPage('fr-FR', 'dark', 'verifying'), /Vérification de l’installation…/); // french-ok: the French locale under test
});
