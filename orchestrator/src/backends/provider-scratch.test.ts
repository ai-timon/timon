/**
 * `ctx.provider.scratch.link` reads from the credential folders a provider
 * declared and nowhere else: a plugin declaring the user\'s own key folders gets
 * no root out of them, whatever the registration let through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMON = mkdtempSync(join(tmpdir(), 'timon-provider-scratch-test-'));
process.env.TIMON_HOME = TIMON;

const { envCredentialRoots, openMissionScratch } = await import('./provider-scratch.js');
const { ScratchPathError } = await import('./scratch-dir.js');

const seal = { swap: (text: string) => text } as unknown as Parameters<typeof openMissionScratch>[0]['seal'];

test('link refuses ~/.ssh and friends even when a plugin declared them', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-scratch-home-'));
  for (const dir of ['.ssh', '.aws', '.config']) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
  writeFileSync(join(home, '.aws', 'credentials'), 'keys');
  mkdirSync(join(home, '.config', 'gcloud'), { recursive: true });
  writeFileSync(join(home, '.config', 'gcloud', 'credentials.db'), 'db');
  mkdirSync(join(home, '.acme'));
  writeFileSync(join(home, '.acme', 'auth.json'), '{}');

  const scratch = openMissionScratch({
    pluginId: 'acme', missionId: 'm1', seal, home,
    credentialDirs: ['.ssh', '.aws', '.config', '.acme'],
  });
  assert.throws(() => scratch.link(join(home, '.ssh', 'id_ed25519'), 'id'), ScratchPathError);
  assert.throws(() => scratch.link(join(home, '.aws', 'credentials'), 'c'), ScratchPathError);
  assert.throws(() => scratch.link(join(home, '.config', 'gcloud', 'credentials.db'), 'g'), ScratchPathError);
  assert.equal(scratch.has('id'), false);
  // The product\'s own folder in the same list still works.
  assert.ok(['symlink', 'hardlink', 'copy'].includes(scratch.link(join(home, '.acme', 'auth.json'), 'auth.json')));
});

test('link takes a source from the extra roots the daemon adds (an account folder, an operator-chosen folder), and from nowhere else', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-scratch-home-'));
  const account = mkdtempSync(join(tmpdir(), 'timon-scratch-account-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'timon-scratch-elsewhere-'));
  writeFileSync(join(account, 'auth.json'), '{}');
  writeFileSync(join(elsewhere, 'auth.json'), '{}');
  const scratch = openMissionScratch({ pluginId: 'acme', missionId: 'm2', seal, home, credentialDirs: [], extraLinkRoots: [account] });
  assert.ok(['symlink', 'hardlink', 'copy'].includes(scratch.link(join(account, 'auth.json'), 'auth.json')));
  assert.throws(() => scratch.link(join(elsewhere, 'auth.json'), 'other.json'), ScratchPathError);
});

test('an operator variable names a sign-in folder: absolute, a folder of its own, never the home or a parent of it', () => {
  const home = join(tmpdir(), 'timon-envroots-home');
  const env = {
    A_AUTH_DIR: join(tmpdir(), 'somewhere-else'),
    B_AUTH_DIR: 'relative/dir',
    C_AUTH_DIR: home,
    D_AUTH_DIR: tmpdir(),
    E_AUTH_DIR: join(home, '.codex-alt'),
    F_AUTH_DIR: '',
  };
  assert.deepEqual(envCredentialRoots(['A_AUTH_DIR', 'B_AUTH_DIR', 'C_AUTH_DIR', 'D_AUTH_DIR', 'E_AUTH_DIR', 'F_AUTH_DIR', 'G_AUTH_DIR'], env, home), [
    join(tmpdir(), 'somewhere-else'),
    join(home, '.codex-alt'),
  ]);
  assert.deepEqual(envCredentialRoots(['A_AUTH_DIR'], { A_AUTH_DIR: '/' }, home), [], 'a filesystem root');
});

test('a mission that was open across the update finds its CLI\'s session store again: the old folder moves to the plugin\'s, once', async () => {
  const { disposeProviderScratch, missionScratchPath } = await import('./provider-scratch.js');
  const { existsSync, readFileSync } = await import('node:fs');
  const legacy = join(TIMON, 'codex-runs', 'mission-moved');
  mkdirSync(join(legacy, 'sessions'), { recursive: true });
  writeFileSync(join(legacy, 'sessions', 'rollout-x.jsonl'), '{"thread":"t"}\n');
  const scratch = openMissionScratch({ pluginId: 'provider-codex', missionId: 'mission-moved', seal, credentialDirs: [] });
  assert.equal(scratch.path, missionScratchPath('provider-codex', 'mission-moved'));
  assert.equal(readFileSync(join(scratch.path, 'sessions', 'rollout-x.jsonl'), 'utf8'), '{"thread":"t"}\n');
  assert.equal(existsSync(legacy), false, 'moved, not copied');
  // A plugin that took nothing over, or a mission with no old folder, starts empty.
  const fresh = openMissionScratch({ pluginId: 'provider-codex', missionId: 'mission-new', seal, credentialDirs: [] });
  assert.equal(existsSync(join(fresh.path, 'sessions')), false);
  // A mission explicitly killed before it was ever relaunched leaves no old folder behind.
  const orphan = join(TIMON, 'codex-runs', 'mission-orphan');
  mkdirSync(orphan, { recursive: true });
  disposeProviderScratch('mission-orphan');
  assert.equal(existsSync(orphan), false);
});

test('the purge removes the folders of missions over for the retention, never a live one (TIM-0111)', async () => {
  const { purgeProviderScratch, missionScratchPath } = await import('./provider-scratch.js');
  const { existsSync, utimesSync } = await import('node:fs');
  const DAY = 86_400_000;
  const now = Date.now();
  const folder = (path: string, mtime = now): string => {
    mkdirSync(join(path, 'sessions'), { recursive: true });
    writeFileSync(join(path, 'sessions', 'rollout.jsonl'), '{}\n');
    utimesSync(path, new Date(mtime), new Date(mtime));
    return path;
  };
  const old = folder(missionScratchPath('provider-codex', 'purge-old'));
  const recent = folder(missionScratchPath('provider-codex', 'purge-recent'));
  const reopened = folder(missionScratchPath('provider-codex', 'purge-reopened'), now - 90 * DAY);
  const otherPlugin = folder(missionScratchPath('acme', 'purge-old'));
  const orphanOld = folder(missionScratchPath('provider-codex', 'summary-0ld'), now - 40 * DAY);
  const orphanFresh = folder(missionScratchPath('provider-codex', 'summary-fresh'), now - DAY);
  const legacy = folder(join(TIMON, 'codex-runs', 'purge-old'));
  const retired = folder(join(TIMON, 'grok-runs', 'purge-old'));
  const lives: Record<string, { live: boolean; endedAt: number | null }> = {
    'purge-old': { live: false, endedAt: now - 31 * DAY },
    'purge-recent': { live: false, endedAt: now - 29 * DAY },
    // A resume brought it back: running again, however old its folder.
    'purge-reopened': { live: true, endedAt: null },
  };
  const outcome = purgeProviderScratch((id) => lives[id] ?? null, 30 * DAY, now);

  for (const gone of [old, otherPlugin, orphanOld, legacy, retired]) assert.equal(existsSync(gone), false, gone);
  for (const kept of [recent, reopened, orphanFresh]) assert.equal(existsSync(join(kept, 'sessions', 'rollout.jsonl')), true, kept);
  assert.deepEqual([...outcome.removed].sort(), ['purge-old', 'purge-old', 'purge-old', 'purge-old', 'summary-0ld']);
  assert.ok(outcome.keptLive >= 1);
});

test('a Codex mission points its download caches to one folder every mission shares, outside the mission folders', async () => {
  const { missionScratchPath, providerCacheDir, providerRunsDir } = await import('./provider-scratch.js');
  const { existsSync, lstatSync, realpathSync } = await import('node:fs');
  const { relative } = await import('node:path');
  const scratch = openMissionScratch({ pluginId: 'provider-codex', missionId: 'share-a', seal, credentialDirs: [] });
  const shared = { cache: join(providerCacheDir(), 'provider-codex', 'cache'), plugins: join(providerCacheDir(), 'provider-codex', 'plugins-cache') };
  assert.ok(relative(providerRunsDir(), providerCacheDir()).startsWith('..'), 'the purge never reads the shared folder as a mission');
  for (const [name, target] of [['cache', shared.cache], [join('plugins', 'cache'), shared.plugins]] as const) {
    const at = join(scratch.path, name);
    assert.equal(lstatSync(at).isSymbolicLink(), true, `${name} is a link`);
    assert.equal(realpathSync(at), realpathSync(target));
  }
  // What one mission's CLI downloads, the next one finds.
  writeFileSync(join(scratch.path, 'cache', 'catalog.json'), '{}');
  const other = openMissionScratch({ pluginId: 'provider-codex', missionId: 'share-b', seal, credentialDirs: [] });
  assert.equal(existsSync(join(other.path, 'cache', 'catalog.json')), true);
  // Opening the folder again on the next turn leaves the link as it is.
  openMissionScratch({ pluginId: 'provider-codex', missionId: 'share-a', seal, credentialDirs: [] });
  assert.equal(lstatSync(join(scratch.path, 'cache')).isSymbolicLink(), true);
  // Another plugin's CLI gets nothing it did not ask for.
  const acme = openMissionScratch({ pluginId: 'acme', missionId: 'share-a', seal, credentialDirs: [] });
  assert.equal(existsSync(join(acme.path, 'cache')), false);
  // A mission begun before the shared caches keeps its own folder until it is over.
  const before = missionScratchPath('provider-codex', 'share-before');
  mkdirSync(join(before, 'cache'), { recursive: true });
  writeFileSync(join(before, 'cache', 'own.json'), '{}');
  openMissionScratch({ pluginId: 'provider-codex', missionId: 'share-before', seal, credentialDirs: [] });
  assert.equal(lstatSync(join(before, 'cache')).isSymbolicLink(), false);
  assert.equal(existsSync(join(before, 'cache', 'own.json')), true);
  assert.equal(lstatSync(join(before, 'plugins', 'cache')).isSymbolicLink(), true, 'the missing one is shared');
});

test('a link left dangling is made again: the CLI never writes into a link to nowhere', async () => {
  const { providerCacheDir } = await import('./provider-scratch.js');
  const { existsSync, rmSync } = await import('node:fs');
  const scratch = openMissionScratch({ pluginId: 'provider-codex', missionId: 'share-dangling', seal, credentialDirs: [] });
  rmSync(join(providerCacheDir(), 'provider-codex', 'cache'), { recursive: true, force: true });
  assert.equal(existsSync(join(scratch.path, 'cache')), false);
  openMissionScratch({ pluginId: 'provider-codex', missionId: 'share-dangling', seal, credentialDirs: [] });
  assert.equal(existsSync(join(scratch.path, 'cache')), true);
});

test('removing a mission folder in any way removes its links, never the shared caches they point to', async () => {
  const { disposeProviderScratch, parkProviderScratch, purgeProviderScratch, missionScratchPath, providerCacheDir } = await import('./provider-scratch.js');
  const { existsSync, lstatSync, readFileSync } = await import('node:fs');
  const sentinels = [
    join(providerCacheDir(), 'provider-codex', 'cache', 'remote_plugin_catalog', 'sentinel.json'),
    join(providerCacheDir(), 'provider-codex', 'plugins-cache', 'openai-curated-remote', 'sentinel.json'),
  ];
  const open = (missionId: string): string => {
    const scratch = openMissionScratch({ pluginId: 'provider-codex', missionId, seal, credentialDirs: [] });
    for (const sentinel of sentinels) {
      mkdirSync(join(sentinel, '..'), { recursive: true });
      writeFileSync(sentinel, 'shared');
    }
    writeFileSync(join(scratch.path, 'state_5.sqlite'), 'thread');
    return scratch.path;
  };
  const intact = (how: string): void => {
    for (const sentinel of sentinels) assert.equal(readFileSync(sentinel, 'utf8'), 'shared', `${how} kept ${sentinel}`);
  };
  const gone = (path: string): boolean => { try { lstatSync(path); return false; } catch { return true; } };

  const disposed = open('rm-dispose');
  disposeProviderScratch('rm-dispose');
  assert.equal(gone(disposed), true);
  intact('dispose');

  const dropped = open('rm-drop');
  parkProviderScratch('rm-drop').drop();
  assert.equal(gone(dropped), true);
  assert.equal(gone(`${dropped}.handover`), true);
  intact('park + drop');

  // A failed launch puts the old folder back, links included, and throws away what it wrote.
  const restored = open('rm-restore');
  const parked = parkProviderScratch('rm-restore');
  open('rm-restore');
  parked.restore();
  assert.equal(readFileSync(join(restored, 'state_5.sqlite'), 'utf8'), 'thread');
  assert.equal(lstatSync(join(restored, 'cache')).isSymbolicLink(), true);
  intact('park + restore');

  const purged = open('rm-purge');
  const outcome = purgeProviderScratch((id) => (id === 'rm-purge' ? { live: false, endedAt: 0 } : { live: true, endedAt: null }), 1, Date.now());
  assert.ok(outcome.removed.includes('rm-purge'));
  assert.equal(gone(purged), true);
  intact('purge');

  // The legacy folder a mission is adopted from goes the same way.
  const legacy = join(TIMON, 'codex-runs', 'rm-legacy');
  mkdirSync(join(legacy, 'sessions'), { recursive: true });
  const { linkDirectory } = await import('../host/directory-link.js');
  linkDirectory(join(providerCacheDir(), 'provider-codex', 'cache'), join(legacy, 'cache'));
  disposeProviderScratch('rm-legacy');
  assert.equal(existsSync(legacy), false);
  intact('dispose of a legacy folder');
  assert.equal(existsSync(missionScratchPath('provider-codex', 'rm-legacy')), false);
});

test('a finished mission loses its downloadable caches at once, never its conversation; a running one keeps everything', async () => {
  const { trimProviderCaches, missionScratchPath, providerCacheDir } = await import('./provider-scratch.js');
  const { existsSync, lstatSync, readFileSync, utimesSync } = await import('node:fs');
  const DAY = 86_400_000;
  const now = Date.now();
  // The shape of a Codex mission folder filled before the caches were shared.
  const mission = (path: string, mtime = now): string => {
    for (const [name, size] of [
      [join('cache', 'remote_plugin_catalog', 'catalog.json'), 3000],
      [join('cache', 'codex_apps_tools', 'tools.json'), 200],
      [join('plugins', 'cache', 'openai-curated-remote', 'sites', 'plugin.json'), 500],
      [join('sessions', '2026', 'rollout.jsonl'), 50],
      ['state_5.sqlite', 40],
      ['state_5.sqlite-wal', 30],
      ['config.toml', 10],
    ] as const) {
      mkdirSync(join(path, name, '..'), { recursive: true });
      writeFileSync(join(path, name), 'x'.repeat(size));
    }
    utimesSync(path, new Date(mtime), new Date(mtime));
    return path;
  };
  const kept = [join('sessions', '2026', 'rollout.jsonl'), 'state_5.sqlite', 'state_5.sqlite-wal', 'config.toml'];
  const ended = mission(missionScratchPath('provider-codex', 'trim-ended'));
  const live = mission(missionScratchPath('provider-codex', 'trim-live'));
  const unknownOld = mission(missionScratchPath('provider-codex', 'trim-unknown-old'), now - 2 * DAY);
  const unknownFresh = mission(missionScratchPath('provider-codex', 'trim-unknown-fresh'));
  const legacy = mission(join(TIMON, 'codex-runs', 'trim-legacy'));
  const otherPlugin = mission(missionScratchPath('acme', 'trim-ended'));
  // A mission already on the shared caches: its link stays, the shared folder is not counted.
  const linked = openMissionScratch({ pluginId: 'provider-codex', missionId: 'trim-linked', seal, credentialDirs: [] }).path;
  const sharedSentinel = join(providerCacheDir(), 'provider-codex', 'cache', 'sentinel.json');
  writeFileSync(sharedSentinel, 'x'.repeat(10_000));

  const lives: Record<string, { live: boolean; endedAt: number | null }> = {
    'trim-ended': { live: false, endedAt: now - 60_000 },
    'trim-live': { live: true, endedAt: null },
    'trim-legacy': { live: false, endedAt: now - 60_000 },
    'trim-linked': { live: false, endedAt: now - 60_000 },
  };
  const outcome = trimProviderCaches((id) => lives[id] ?? null, now);

  for (const trimmed of [ended, unknownOld, legacy]) {
    assert.equal(existsSync(join(trimmed, 'cache')), false, trimmed);
    assert.equal(existsSync(join(trimmed, 'plugins', 'cache')), false, trimmed);
    for (const name of kept) assert.equal(existsSync(join(trimmed, name)), true, `${trimmed} kept ${name}`);
  }
  for (const untouched of [live, unknownFresh, otherPlugin]) {
    assert.equal(existsSync(join(untouched, 'cache', 'remote_plugin_catalog', 'catalog.json')), true, untouched);
    assert.equal(existsSync(join(untouched, 'plugins', 'cache', 'openai-curated-remote', 'sites', 'plugin.json')), true, untouched);
  }
  assert.equal(lstatSync(join(linked, 'cache')).isSymbolicLink(), true);
  assert.equal(readFileSync(sharedSentinel, 'utf8').length, 10_000);
  assert.deepEqual(outcome, { missions: 3, bytes: 3 * (3000 + 200 + 500) });
  assert.deepEqual(trimProviderCaches((id) => lives[id] ?? null, now), { missions: 0, bytes: 0 }, 'nothing twice');
});
