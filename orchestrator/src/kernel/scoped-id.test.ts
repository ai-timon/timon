/**
 * A module id now carries a `/` (`@timon/db`, §10.14). This test holds
 * the three places where a `/` can derail an identifier that had
 * never had one: a URL, a path on disk, a database key.
 *
 * None would fail loudly. A route would return 404 (the `/` cuts the
 * segment), a file would land in a missing subfolder, a key
 * would go into the wrong row. Hence three assertions rather than a
 * reread.
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sep } from 'node:path';

const { CATALOG } = await import('./catalog.js');
const { PLUGINS_DATA_DIR, pluginDataDir, childPidFile, RUN_DIR } = await import('../paths.js');
const { dbApi } = await import('../db.js');
const { LABEL, MODULE_ID } = await import('../plugins-bundled/web-app/control.js');

const SCOPED = '@timon/secrets-vault';

test('a scoped id only crosses a URL encoded', () => {
  assert.ok(CATALOG.some((m) => m.id === SCOPED), 'reference id of the test');

  // What the front end must write. The `/` disappears from the raw form: without it,
  // Express sees `/api/plugins/@timon/secrets-vault/enabled` as four
  // segments and no route matches.
  const encoded = encodeURIComponent(SCOPED);
  assert.equal(encoded.includes('/'), false);
  assert.equal(new URL(`http://timon.invalid/api/plugins/${encoded}/enabled`).pathname.split('/').length, 5);
  // The server finds the exact id back: the round trip loses neither the scope nor the
  // case.
  assert.equal(decodeURIComponent(encoded), SCOPED);
});

test('a scoped id stays under its data folder, and never serves as a pidfile name', () => {
  // The `/` creates a subfolder; what matters is that it does not LEAVE
  // `plugins-data/` (no `..`, no absolute path).
  const dir = pluginDataDir(SCOPED);
  assert.ok(dir.startsWith(PLUGINS_DATA_DIR + sep), `${dir} must stay under ${PLUGINS_DATA_DIR}`);
  assert.equal(dir.includes('..'), false);

  // The pidfile is a flat FILE: it cannot carry the id. Hence
  // the LABEL / MODULE_ID pair of web-app.
  assert.equal(MODULE_ID, '@timon/web-app');
  assert.equal(LABEL.includes('/'), false);
  assert.equal(childPidFile(LABEL), `${RUN_DIR}${sep}${LABEL}.pid`);
});

test('a scoped id is a database key like any other, and stays partitioned', () => {
  // french-ok-file: free-text sample values
  dbApi.pluginKvSet(SCOPED, 'k', 'à moi');
  dbApi.pluginKvSet('secrets-vault', 'k', 'à un autre');

  assert.equal(dbApi.pluginKvGet(SCOPED, 'k'), 'à moi');
  assert.equal(dbApi.pluginKvGet('secrets-vault', 'k'), 'à un autre');
  assert.deepEqual(dbApi.pluginKvList(SCOPED).map((r) => r.value), ['à moi']);

  dbApi.pluginKvClear(SCOPED);
  assert.equal(dbApi.pluginKvGet(SCOPED, 'k'), undefined);
  assert.equal(dbApi.pluginKvGet('secrets-vault', 'k'), 'à un autre', 'erasing one does not touch the other');
});
