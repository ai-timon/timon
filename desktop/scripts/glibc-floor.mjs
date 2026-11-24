/**
 * The oldest glibc a Linux package promises to run on, and the check that a
 * native artefact keeps that promise.
 *
 * A native module compiled on the release machine links against that
 * machine's glibc and records every symbol version it uses (`GLIBC_x.y`, in
 * the `.gnu.version_r` section). The loader then refuses it on any system
 * with an older glibc: node-pty built on an Ubuntu with glibc 2.42 does not
 * load on Debian 13 (2.41), and the integrated terminal is gone, although the
 * requirements promise every Linux from glibc 2.28. Loading the artefact under
 * the bundled Node on the build machine cannot see this: that machine has the
 * newer glibc. Only the recorded versions can.
 */
import { execFileSync } from 'node:child_process';

/** The floor `public-docs/docs/installation/requirements.md` states. */
export const LINUX_GLIBC_FLOOR = '2.28';

/** Compares two dotted versions; negative when `a` is older. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * `readelf --version-info` of a file. `readelf` comes with binutils, which
 * the native rebuild (node-gyp, a C++ compiler) already needs.
 */
function versionInfo(file) {
  return execFileSync('readelf', ['--version-info', '--wide', file], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' },
  });
}

/** The newest `GLIBC_x.y` a file requires, or null when it requires none. */
export function newestGlibcRequired(file, read = versionInfo) {
  const versions = [...read(file).matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/g)].map((m) => m[1]);
  return versions.length ? versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b)) : null;
}

/** Refuses a Linux artefact that requires a newer glibc than the floor. */
export function assertGlibcFloor(file, { floor = LINUX_GLIBC_FLOOR, read = versionInfo } = {}) {
  const newest = newestGlibcRequired(file, read);
  if (newest && compareVersions(newest, floor) > 0) {
    throw new Error(`${file} requires GLIBC_${newest}, newer than the glibc ${floor} Linux packages support: `
      + `it would not load on older distributions. Build Linux native modules on a system whose glibc is ${floor}.`);
  }
}
