import { lstatSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

export function linkDirectory(target: string, destination: string): void {
  // Junctions do not require Windows symlink privileges or Developer Mode.
  symlinkSync(resolve(target), destination, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Whether `path` is a folder link (a symbolic link, or a junction: Node reports both as links), dangling ones included. */
export function isDirectoryLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/**
 * Removes the link at `path` and never what it points to. A recursive `rm` is
 * not trusted with this: whether it follows a junction has varied across
 * runtimes, and the target can be a folder other missions share.
 */
export function removeDirectoryLink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows may refuse to unlink a junction, a folder entry: rmdir removes the entry, not its target.
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EISDIR')) throw error;
    rmdirSync(path);
  }
}
