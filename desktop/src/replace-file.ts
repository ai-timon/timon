import { rename as renameFile } from 'node:fs/promises';

/** Seams for the tests: the rename call, the platform and the pause between attempts. */
export type ReplaceFileOps = {
  rename?: (from: string, to: string) => Promise<void>;
  platform?: NodeJS.Platform;
  attempts?: number;
  wait?: (ms: number) => Promise<void>;
};

const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);
const DEFAULT_ATTEMPTS = 10;
const MAX_DELAY_MS = 250;

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? '';
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Moves `from` over `to`, replacing it in one step.
 *
 * On Windows, Defender, the indexer or a reader that has just opened the
 * destination can hold it for a moment, and the rename then fails with
 * EPERM, EBUSY or EACCES. The rename is retried with a bounded backoff (about
 * 1.6 s in all with the default attempts) before the last error is rethrown.
 * Elsewhere these codes are a real refusal that waiting will not lift, so the
 * first error is thrown at once.
 */
export async function replaceFile(from: string, to: string, ops: ReplaceFileOps = {}): Promise<void> {
  const rename = ops.rename ?? renameFile;
  const windows = (ops.platform ?? process.platform) === 'win32';
  const attempts = Math.max(1, ops.attempts ?? DEFAULT_ATTEMPTS);
  const wait = ops.wait ?? pause;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!windows || !LOCKED.has(errorCode(error)) || attempt >= attempts - 1) throw error;
      await wait(Math.min(25 * 2 ** attempt, MAX_DELAY_MS));
    }
  }
}
