/**
 * Bootstrap of the test suites: isolates `TIMON_HOME` in a throwaway folder.
 *
 * To import FIRST, before any module that touches Timon state — ESM
 * imports run in declaration order, so this line sets the
 * variable before `paths.ts` reads it:
 *
 *   import './test-home.js';        // ← must stay at the top
 *   import { inspectMerge } from './merge-integrity.js';
 *
 * Why this exists: `db.ts` opens the database WHEN THE MODULE LOADS and runs
 * its migrations there. A test that imports it, even indirectly through an
 * intermediate module, therefore writes to `~/.timon/timon.db` — the real one.
 *
 * One folder PER PROCESS, and not the one inherited from `npm test`: `node --test`
 * runs the files in parallel, and `db.ts` runs its additive `ALTER TABLE`s
 * at load. Two processes on the SAME database both see the column
 * missing, both add it, and the loser dies on `duplicate column`.
 * A suite that wants to keep control sets its own folder and does not import
 * this module: ESM imports being hoisted, an assignment in the calling file
 * would run AFTER this line, never before.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Canonical, as the product resolves paths: on macOS the temporary folder is
// `/var/...`, a link to `/private/var/...`, and Windows may hand out an 8.3
// short name; a test comparing a path the product returned would see both.
process.env.TIMON_HOME = realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-test-home-')));
