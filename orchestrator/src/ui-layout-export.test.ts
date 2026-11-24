/**
 * The placement of widgets must travel with `timon export` / `timon import`.
 *
 * No code puts it there: it lives in `ui_layout`, and the database leaves whole through
 * `VACUUM INTO`. This test exists so that this freebie stays true: the day
 * someone filters tables at export, this is where it breaks.
 *
 * Method trap: `export.test.ts` passes `vacuumInto: () => {}`, which
 * takes NO database. Copying that shape would give a green test that
 * proves nothing. The real path is exercised here, the one of `/api/admin/export`.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { db, dbApi } = await import('./db.js');
const { exportTimon, importTimon } = await import('./export.js');

test('an export takes the placement of widgets, and an import restores it', () => {
  const home = process.env.TIMON_HOME!;
  const layout = [{ id: 'agenda', rail: 'droite', rang: 1, hauteur: 320 }];
  dbApi.uiLayoutSet('', 'cockpit', JSON.stringify(layout));

  const out = join(mkdtempSync(join(tmpdir(), 'timon-layout-archive-')), 'export.tar.gz');
  exportTimon({
    out,
    home,
    // Exactly what the /api/admin/export route does: the open database of the
    // daemon, copied hot without its -wal, would be truncated.
    vacuumInto: (dest) => { db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); },
  });

  const to = mkdtempSync(join(tmpdir(), 'timon-layout-import-'));
  importTimon({ file: out, to });

  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const restored = new Database(join(to, 'timon.db'), { readonly: true });
  try {
    const row = restored.prepare(`SELECT value FROM ui_layout WHERE scope=?`).get('cockpit') as
      { value: string } | undefined;
    assert.ok(row, 'the ui_layout table must have travelled with the database');
    assert.deepEqual(JSON.parse(row.value), layout);
  } finally {
    restored.close();
  }
});
