#!/usr/bin/env node
/**
 * Prepares the Node runtime and the native dependencies that travel inside
 * the package (5.6.1/5.6.6).
 *
 * The packaged daemon, and the Next app it spawns, run on the Node the package
 * ships in `resources/node` (`fetch-node.mjs`, version pinned in
 * `node-runtime.json`), no longer on Electron's own Node: Electron 33's Node 20
 * has no `node:sqlite`, which third-party plugins need. The natives are built,
 * and checked, for that Node's module ABI. The host's Node may differ (Windows
 * builder on Node 24 → ABI 137): an artefact compiled for it fails at the first
 * `require`, the daemon crash-loops, and the shell shows "The daemon keeps
 * crashing". `node-pty` (terminals) and the app's own `better-sqlite3` (remote
 * API) are in the same situation.
 *
 * `electron-builder install-app-deps` does NOT fix this: it rebuilds the
 * dependencies of the `desktop/` package, which has none — the native module
 * belongs to another package that electron-builder only copies as a resource.
 *
 * Rebuilding `orchestrator/node_modules` in place is FORBIDDEN: the daemon the maintainer
 * runs from this repo (plain Node 22, systemd) loads that very file and would
 * break the moment we swap its ABI. So we work on a COPY:
 *
 *   <tree>/{package.json,package-lock.json,node_modules}
 *     → desktop/build-resources/<tree>/…   (rebuilt for the shipped Node's ABI)
 *
 * and `electron-builder.yml` ships that copy instead of the live tree.
 */
import { execFileSync } from 'node:child_process';
import { makeHelpersExecutable, missingConptyFiles } from './pty-helper.mjs';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEntriesResolve } from './entry-resolve.mjs';
import { assertGlibcFloor } from './glibc-floor.mjs';
import { bundledNodeExecutable, fetchNode, nodeRuntimeSpec } from './fetch-node.mjs';
import { SHELL_LOCALES_BUILD, copyShellLocales } from './shell-locales.mjs';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '..');
export const BUILD_RESOURCES = join(desktopDir, 'build-resources');

/**
 * Every native module that travels, and the tree it belongs to.
 *
 * `orchestrator` runs on the shipped Node, and so does the Next app it spawns
 * in a package (step 5.6.5) — both therefore need that Node's ABI.
 * Missing one of them is silent until runtime: the daemon crash-loops on
 * `better_sqlite3`, or the terminal dies on `pty`, or the app's remote API
 * throws on its own database.
 */
const TREES = [
  { name: 'orchestrator', modules: ['better-sqlite3', 'node-pty'] },
  // The app ships its traced `.next/standalone` (built with
  // `TIMON_NEXT_STANDALONE=1`, completed by `app/scripts/build-server.mjs`),
  // not its full `node_modules`: ~3 500 files instead of ~27 500, each one
  // scanned by Windows Defender at install time. The full tree is still
  // copied, but only as the workspace where `better-sqlite3` is rebuilt.
  {
    name: 'app',
    modules: ['better-sqlite3'],
    standalone: {
      dir: join('.next', 'standalone'),
      entries: [join('.next', 'timon', 'server.cjs'), join('.next', 'timon', 'workers', 'telegram-poll.cjs'), join('.next', 'timon', 'workers', 'mission-watcher.cjs')],
      // The daemon runs the entries through `tsx` (`web-app/index.ts`,
      // `appEntryArgs`), a habit of Electron's Node 20, which could not
      // require() the ES modules jsdom loads.
      runtime: [join('node_modules', 'tsx', 'dist', 'cli.mjs')],
    },
  },
];

/** Every `.node` of a directory: a module may ship several (node-pty on
 *  Windows: `pty`, `conpty`, `conpty_console_list`). */
function nativeFilesIn(dir) {
  return readdirSync(dir).filter((entry) => entry.endsWith('.node')).map((entry) => join(dir, entry));
}

/**
 * Where a module's native artefacts actually live, and therefore whether they
 * must be rebuilt at all.
 *
 * `better-sqlite3` is a NAN module with no prebuild in these trees: npm
 * compiles it at install time against the HOST's Node, and Electron's refuses
 * to load the result. Rebuilding it is the whole reason this script exists.
 *
 * `node-pty` 1.1.0 is a `node-addon-api` (N-API) module and ships prebuilt
 * binaries for Windows and macOS in `prebuilds/<platform>-<arch>/`. npm then
 * never compiles it, so `build/Release` does not exist there at all — and
 * N-API being ABI-stable by contract, those binaries load under Electron's
 * Node unchanged (proven below, never assumed). Forcing a source build is not
 * the answer either: node-pty's `binding.gyp` requires the Spectre-mitigated
 * MSVC libraries, and `--build-from-source` DELETES `prebuilds/` before
 * compiling, so a failed build leaves the live tree with no artefact at all
 * (observed 12/09/2026 on Windows). Linux has no node-pty prebuild: the tree
 * holds `build/Release` and the rebuild happens exactly as before.
 */
function artefactsOf(treeDir, moduleName) {
  const moduleDir = join(treeDir, 'node_modules', moduleName);
  const built = join(moduleDir, 'build', 'Release');
  if (existsSync(built) && nativeFilesIn(built).length) return { kind: 'built', dir: built };
  const prebuilt = join(moduleDir, 'prebuilds', `${process.platform}-${process.arch}`);
  if (existsSync(prebuilt) && nativeFilesIn(prebuilt).length) return { kind: 'prebuilt', dir: prebuilt };
  throw new Error(`${moduleName} has no native artefact under ${moduleDir} — run npm install in that tree`);
}

/**
 * Mechanical form of the prohibition in the header: a target inside a live
 * tree would rebuild what the daemon on this machine reads.
 */
function assertOutsideRepo(dir) {
  const rel = relative(repoRoot, resolve(dir));
  const outside = rel.startsWith('..') || isAbsolute(rel);
  if (!outside && !resolve(dir).startsWith(BUILD_RESOURCES)) {
    throw new Error(`refusing to rebuild inside ${repoRoot}: the daemon running from this repo loads it`);
  }
}

/** npm's own CLI, to run `npm rebuild` on the shipped Node. Set by npm for
 *  `npm run prepare:deps`; a direct `node scripts/…` run has to name it. */
function npmCli() {
  const cli = process.env.npm_execpath;
  if (!cli || !existsSync(cli)) throw new Error('npm_execpath is not set — run this through `npm run prepare:deps`');
  return cli;
}

/** The environment of a rebuild on the shipped Node: its folder first on the
 *  PATH, so an install script's `node` (prebuild-install, node-gyp) is it. */
function runtimeEnv(node) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [dirname(node), env[pathKey]].filter(Boolean).join(delimiter);
  return env;
}

/**
 * Skips every symlink whose target is absolute.
 *
 * `orchestrator/node_modules` holds `node_modules/node_modules`, an absolute
 * link back to itself (an npm accident of an earlier rename). Copied
 * verbatim, it turns the staging area into a door onto the live tree:
 * a rebuild walks through it and rebuilds the daemon the maintainer runs, which
 * is precisely what this whole script exists to avoid. Relative links (the
 * `.bin/*` entries) stay: they resolve inside the copy.
 */
function copyFilter(src) {
  const st = lstatSync(src);
  return !(st.isSymbolicLink() && isAbsolute(readlinkSync(src)));
}

/** Loads an artefact exactly as the packaged runtime will. Exit code 0 from
 *  the rebuild is not proof; only the shipped Node can tell the ABI. */
function loadUnderRuntime(artefact) {
  // Loading proves the ABI, on this machine's glibc only: the versions the
  // artefact recorded say whether the systems the package promises can load it.
  if (process.platform === 'linux') assertGlibcFloor(artefact);
  const node = bundledNodeExecutable();
  execFileSync(node, ['-e', `require(${JSON.stringify(artefact)})`], { stdio: 'inherit', env: runtimeEnv(node) });
}

/**
 * The directory that ships for a standalone tree: the traced output, with the
 * native artefacts just rebuilt in the staged full tree swapped in. The trace
 * carries the host's `.node` (compiled for the host Node, maybe another ABI), and
 * none of the sources a rebuild would need.
 */
function assembleStandalone(name, source, standalone, staged, modules, into) {
  cpSync(join(source, standalone.dir), into, { recursive: true, verbatimSymlinks: true, filter: copyFilter });
  for (const moduleName of modules) {
    const rebuilt = artefactsOf(staged, moduleName).dir;
    const shipped = join(into, relative(staged, rebuilt));
    if (!existsSync(join(into, 'node_modules', moduleName))) {
      throw new Error(`${name}: the standalone trace does not include ${moduleName} — nothing in the app would load it`);
    }
    rmSync(shipped, { recursive: true, force: true });
    cpSync(rebuilt, shipped, { recursive: true });
    for (const artefact of nativeFilesIn(shipped)) loadUnderRuntime(artefact);
  }
  assertEntriesResolve(into, standalone.entries.map((entry) => join(into, entry)));
  for (const file of standalone.runtime) {
    if (!existsSync(join(into, file))) throw new Error(`${name}: ${file} is missing from the standalone output — rebuild the app with its build script`);
  }
  console.log(`[prepare] ${name}: standalone output assembled with the rebuilt ${modules.join(', ')}`);
}

function prepareTree({ name, modules, standalone }, version) {
  const source = join(repoRoot, name);
  const target = join(BUILD_RESOURCES, name);
  assertOutsideRepo(target);
  if (!existsSync(join(source, 'node_modules'))) {
    throw new Error(`${source}/node_modules is missing — run npm install in ${name}/`);
  }
  if (standalone) {
    // A regular build would ship without `tsx`, which the daemon falls back
    // to when the compiled entries are missing: refuse it here.
    for (const path of [standalone.dir, ...standalone.entries.map((entry) => join(standalone.dir, entry))]) {
      if (!existsSync(join(source, path))) {
        throw new Error(`${join(source, path)} is missing — build the app for a package: cd ${name} && TIMON_NEXT_STANDALONE=1 npm run build`);
      }
    }
  }
  const live = Object.fromEntries(modules.map((m) => [m, artefactsOf(source, m)]));
  const witnesses = modules.flatMap((m) => nativeFilesIn(live[m].dir).map((path) => ({ path, ctime: statSync(path).ctimeMs })));

  // Staged OUTSIDE the repository, on purpose. A rebuild walks the
  // dependency tree around the directory it is given, and a staging area
  // inside the repo let it reach the live `node_modules` and swap its
  // artefacts for Electron builds (observed 04/09/2026 — the daemon the maintainer runs
  // then refused to load its own database driver).
  const stage = mkdtempSync(join(tmpdir(), `timon-${name}-deps-`));
  const staged = join(stage, name);
  try {
    console.log(`[prepare] ${name}: copying the dependency tree → ${staged}`);
    mkdirSync(staged, { recursive: true });
    for (const entry of ['package.json', 'package-lock.json', 'node_modules']) {
      const from = join(source, entry);
      if (existsSync(from)) {
        cpSync(from, join(staged, entry), { recursive: true, verbatimSymlinks: true, filter: copyFilter });
      }
    }

    for (const moduleName of modules) {
      if (live[moduleName].kind === 'prebuilt') {
        // Nothing to rebuild — but "N-API travels across ABIs" is checked
        // against the shipped Node itself before this copy is allowed to ship.
        console.log(`[prepare] ${name}: ${moduleName} ships an N-API prebuild — verifying it under Node ${version}`);
        const keep = artefactsOf(staged, moduleName).dir;
        for (const artefact of nativeFilesIn(keep)) loadUnderRuntime(artefact);
        for (const path of makeHelpersExecutable(keep)) console.log(`[prepare] ${name}: made ${path} executable`);
        if (moduleName === 'node-pty' && process.platform === 'win32') {
          const missing = missingConptyFiles(keep);
          if (missing.length) throw new Error(`${moduleName}: ${missing.join(', ')} missing under ${keep} — Windows terminals would not start`);
        }
        // A prebuild directory holds EVERY platform the module publishes:
        // node-pty carries a 28 MB win32-arm64 tree that an x64 package can
        // only fail to load. Ship the one that was just proven, drop the rest.
        for (const other of readdirSync(dirname(keep))) {
          const dir = join(dirname(keep), other);
          if (dir !== keep) rmSync(dir, { recursive: true, force: true });
        }
        continue;
      }
      // The copy still holds the host artefact and a populated `build/`, which
      // is exactly what makes a rebuild decide it has nothing to do. Remove it
      // so a silent no-op cannot pass for a rebuild.
      rmSync(join(staged, 'node_modules', moduleName, 'build'), { recursive: true, force: true });
      // `npm rebuild` run BY the shipped Node: the module's install script
      // (prebuild-install, else node-gyp) targets the Node that runs it.
      console.log(`[prepare] ${name}: rebuilding ${moduleName} for Node ${version}`);
      const node = bundledNodeExecutable();
      execFileSync(node, [npmCli(), 'rebuild', moduleName, '--foreground-scripts'], { stdio: 'inherit', cwd: staged, env: runtimeEnv(node) });
      const rebuilt = artefactsOf(staged, moduleName);
      if (rebuilt.kind !== 'built') throw new Error(`rebuild produced no artefact under ${join(staged, 'node_modules', moduleName, 'build', 'Release')}`);
      for (const artefact of nativeFilesIn(rebuilt.dir)) loadUnderRuntime(artefact);
    }

    // The prohibition, checked rather than trusted: if a live artefact moved,
    // the rebuild escaped its staging area and the daemon on this machine is
    // now broken. Say it here, loudly, instead of letting it be discovered at
    // the next restart.
    for (const w of witnesses) {
      if (statSync(w.path).ctimeMs !== w.ctime) {
        throw new Error(`the rebuild modified ${w.path} — restore it with: cd ${name} && npm rebuild`);
      }
    }

    let ship = staged;
    if (standalone) {
      ship = join(stage, `${name}-standalone`);
      assembleStandalone(name, source, standalone, staged, modules, ship);
    }

    rmSync(target, { recursive: true, force: true });
    mkdirSync(BUILD_RESOURCES, { recursive: true });
    try {
      renameSync(ship, target);
    } catch {
      // Different filesystems (temp on tmpfs): fall back to a copy.
      cpSync(ship, target, { recursive: true, verbatimSymlinks: true, filter: copyFilter });
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  console.log(`[prepare] ${name}: ok → ${target}`);
}

async function main() {
  await fetchNode();
  const { version } = nodeRuntimeSpec();
  for (const tree of TREES) prepareTree(tree, version);
  // The shell's menus and dialogs, in every language of the app.
  console.log(`[prepare] shell languages: ${copyShellLocales().length} files → ${SHELL_LOCALES_BUILD}`);
  console.log(`[prepare] done — ${BUILD_RESOURCES} is ready for electron-builder`);
}

main().catch((error) => {
  console.error(`[prepare] ${error.message}`);
  process.exit(1);
});
