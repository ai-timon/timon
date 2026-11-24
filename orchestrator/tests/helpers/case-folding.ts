import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether the volume holding `dir` folds case, as macOS and Windows do by
 * default: `a` and `A` are one name there, so a test cannot lay out two.
 * Probed on the disk, not read from the platform: a Mac can format a
 * case-sensitive volume, and Linux can mount a folding one.
 */
export function foldsCase(dir: string): boolean {
  const probe = mkdtempSync(join(dir, 'case-probe-'));
  try {
    writeFileSync(join(probe, 'x'), '');
    return existsSync(join(probe, 'X'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
