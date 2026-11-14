/**
 * The startup check of the backend CLI binaries.
 *
 * What it protects: an install whose CLI is nowhere only discovered it through
 * empty missions (beta tester's Mac mini, 20/09/2026). The check must see the
 * absence, name it, and tell a detected binary from a broken `host.binaries`
 * pin — the two call for a different gesture.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { checkBackendBinaries, backendBinaryNotice, backendBinaryAnchor, backendBinaryPresentation } from './binary-check.js';
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

/** Lookup options of a machine where NOTHING is installed: no PATH, no desktop
 *  app. The verdict then no longer depends on the machine running the test. */
const EMPTY_MACHINE = { path: '', homeDir: join('/', 'nowhere'), env: {} as NodeJS.ProcessEnv };

test('no CLI installed: every backend is reported, once per binary', () => {
  const statuses = checkBackendBinaries(EMPTY_MACHINE);
  assert.ok(statuses.length > 0, 'at least one backend in the catalog');
  assert.ok(statuses.every((s) => s.path === null), 'nothing must resolve here');
  const cmds = statuses.map((s) => s.cmd);
  assert.deepEqual([...new Set(cmds)], cmds, 'one verdict per binary, not per profile');
  assert.ok(statuses.every((s) => s.backends.length > 0), 'every binary names its backends');
});

test('a pinned binary resolves, and the verdict says so', () => {
  const cfg = TimonConfigSchema.parse({});
  const target = checkBackendBinaries(EMPTY_MACHINE)[0];
  // `process.execPath` rather than a real CLI: the verdict must not depend on
  // what happens to be installed on the machine running the test.
  setConfig({ ...cfg, host: { ...cfg.host, binaries: { [target.cmd]: process.execPath } } });
  try {
    const pinned = checkBackendBinaries(EMPTY_MACHINE).find((s) => s.cmd === target.cmd);
    assert.ok(pinned);
    assert.equal(pinned.path, process.execPath);
    assert.equal(pinned.pinned, true);
  } finally {
    resetConfig();
  }
});

test('broken pin: the notice sends you to fix the path, not to reinstall', () => {
  const cfg = TimonConfigSchema.parse({});
  const target = checkBackendBinaries(EMPTY_MACHINE)[0];
  setConfig({ ...cfg, host: { ...cfg.host, binaries: { [target.cmd]: join('/', 'nowhere', target.cmd) } } });
  try {
    const broken = checkBackendBinaries(EMPTY_MACHINE).find((s) => s.cmd === target.cmd);
    assert.ok(broken);
    assert.equal(broken.path, null);
    assert.equal(broken.pinned, true);
    const notice = backendBinaryNotice(broken);
    assert.match(notice.title, new RegExp(target.cmd));
    assert.match(notice.body, new RegExp(`host\\.binaries\\.${target.cmd}`));
    assert.doesNotMatch(notice.body, /^Install it/m);
    // The repair is a screen of the app, not a JSON file to edit (TODO #413).
    assert.match(notice.body, /Settings › AI models › Providers › CLI binaries/);
  } finally {
    resetConfig();
  }
});

test('binary simply absent: the notice says what to install', () => {
  const missing = checkBackendBinaries(EMPTY_MACHINE)[0];
  const notice = backendBinaryNotice(missing);
  assert.match(notice.title, new RegExp(missing.backends[0]));
  assert.match(notice.body, /Action needed/);
  assert.match(notice.body, /Check again/);
  assert.doesNotMatch(notice.body, /undefined/);
});

test('backend warning metadata recognizes canonical stored warnings, not arbitrary same-anchor text', () => {
  const status = { cmd: 'custom-cli', backends: ['custom-provider'], path: null, pinned: false };
  const notice = backendBinaryNotice(status);
  assert.doesNotMatch(notice.body, /\*\*/);
  const row = {
    ...notice, type: 'alert', anchor: backendBinaryAnchor(status.cmd),
    source: null, task_id: null, mission_id: null, owner_user_id: null,
  };
  assert.equal(backendBinaryPresentation(row, [status])?.kind, 'backend-binary');
  assert.equal(backendBinaryPresentation({ ...row, owner_user_id: 'admin-1' }, [status])?.kind, 'backend-binary');
  for (const change of [
    { title: 'My CLI notes' }, { body: `${notice.body}\nUser-authored detail **keep me**` },
    { anchor: 'backend-binary:another-cli' }, { source: 'plugin:custom' },
    { task_id: 'task-1' }, { mission_id: 'mission-1' }, { type: 'report' },
  ]) {
    assert.equal(backendBinaryPresentation({ ...row, ...change }, [status]), undefined);
  }
  assert.equal(backendBinaryPresentation(row, []), undefined);
  assert.equal(backendBinaryPresentation({ ...row, owner_user_id: 'admin-1', body: 'My own **notes**' }, [status]), undefined);
});

test('legacy Markdown warning and its original pinned diagnosis remain recognizable', () => {
  for (const pinned of [false, true]) {
    const status = { cmd: 'custom-cli', backends: ['custom-provider'], path: null, pinned };
    const notice = backendBinaryNotice(status);
    const body = notice.body
      .replace('Action needed:', '**Action needed:**')
      .replace('Check again', '**Check again**')
      .replace('Settings › AI models › Providers › CLI binaries', '**Settings › AI models › Providers › CLI binaries**');
    const presentation = backendBinaryPresentation({
      title: notice.title, body, type: 'alert', anchor: backendBinaryAnchor(status.cmd),
      source: null, task_id: null, mission_id: null, owner_user_id: null,
    }, [{ ...status, pinned: !pinned, path: '/a/new/path/custom-cli' }]);
    assert.equal(presentation?.pinned, pinned);
    assert.equal(presentation?.cmd, status.cmd);
  }
});

test('known binary install commands are passed to the UI without rewriting', () => {
  const status = { cmd: 'claude', backends: ['claude'], path: null, pinned: false };
  const notice = backendBinaryNotice(status);
  const presentation = backendBinaryPresentation({
    ...notice, type: 'alert', anchor: backendBinaryAnchor(status.cmd),
    source: null, task_id: null, mission_id: null, owner_user_id: null,
  }, [status]);
  assert.ok(presentation);
  if (presentation.installCommand) assert.ok(notice.body.includes(`\`${presentation.installCommand}\``));
});
