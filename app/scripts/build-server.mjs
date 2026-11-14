#!/usr/bin/env node
/**
 * Compiles the app's hand-written entry points — the HTTP server and the two
 * channel workers — to plain JavaScript, next to the Next build.
 *
 * In a checkout they run through `tsx`, which compiles TypeScript on the fly.
 * A desktop package cannot afford that: `tsx` and its `esbuild` are
 * devDependencies, and shipping the devDependencies is what put 25 000 files
 * in `resources/app/node_modules` (Windows Defender scans each of them at
 * install time). Compiled once here, the entry points need nothing but the
 * runtime dependencies, and the daemon launches them with plain Node
 * (`orchestrator/src/plugins-bundled/web-app/index.ts`, `appEntry`).
 *
 * Output: `<distDir>/timon/{server,workers/<name>}.cjs`. Inside the Next build
 * on purpose: `next build` wipes that directory, so a compiled server can
 * never outlive the build it was made with.
 *
 * Local imports (`./lib/…`, `@/…`) are bundled in; packages stay external and
 * resolve from `node_modules` at runtime, exactly as they do under `tsx`.
 * CommonJS, like `tsx` runs these files (the package has no `"type"`).
 *
 * When `next build` produced a standalone output (desktop packages, see
 * `next.config.mjs`), this script also completes it into an app directory
 * the daemon can start as is: see `completeStandalone`.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Entry points, relative to the app, and their output name. Mirrored by
 *  `APP_ENTRIES` in `orchestrator/src/plugins-bundled/web-app/index.ts`. */
const ENTRIES = [
  { source: join('src', 'server.ts'), out: 'server.cjs' },
  { source: join('src', 'workers', 'telegram-poll.ts'), out: join('workers', 'telegram-poll.cjs') },
  { source: join('src', 'workers', 'mission-watcher.ts'), out: join('workers', 'mission-watcher.cjs') },
];

/**
 * `esbuild` is not a dependency of the app: it arrives with `tsx`. Resolving
 * it from `tsx` itself follows that edge instead of relying on npm hoisting
 * it to the top of `node_modules`.
 */
function loadEsbuild() {
  const tsxCli = join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(tsxCli)) throw new Error(`tsx is not installed (${tsxCli}) — run npm install in app/`);
  return createRequire(tsxCli)('esbuild');
}

/**
 * Traced, never loaded: Next's image optimizer requires sharp, but it is off
 * (`images.unoptimized` in `next.config.mjs`), and sharp's libvips binaries
 * are ~37 MB of native decoders. `next.config.mjs` keeps them out of Next's
 * own trace; this keeps the entries' trace from bringing them back.
 */
const UNSHIPPED = ['sharp', '@img'].map((name) => join('node_modules', name) + sep);

/** Where Node would find package `name` from `fromDir`, without leaving the app. */
function packageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const rel = relative(appDir, dir);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  }
}

/**
 * Copies a package and everything it depends on, as installed, into the
 * standalone output. Optional dependencies that npm skipped (the esbuild
 * binaries of other platforms) are skipped too.
 */
function copyPackageClosure(name, standalone) {
  const seen = new Set();
  const queue = [{ name, from: appDir, optional: false }];
  while (queue.length) {
    const { name: dep, from, optional } = queue.shift();
    const dir = packageDir(dep, from);
    if (!dir) {
      if (optional) continue;
      throw new Error(`${dep} is not installed (needed from ${relative(appDir, from) || 'the app'})`);
    }
    if (seen.has(dir)) continue;
    seen.add(dir);
    cpSync(dir, join(standalone, relative(appDir, dir)), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const next of Object.keys(manifest.dependencies ?? {})) queue.push({ name: next, from: dir, optional: false });
    for (const next of Object.keys(manifest.optionalDependencies ?? {})) queue.push({ name: next, from: dir, optional: true });
  }
  return seen.size;
}

/**
 * Turns `.next/standalone` into a complete app directory.
 *
 * Next traces what ITS generated `server.js` needs, not our custom server nor
 * the workers, and leaves `static` and `public` out by design. A module
 * missing from a package only shows at runtime, so the entries are traced
 * here with the tracer Next itself uses (`@vercel/nft`, compiled into
 * `next`), and every file they reach that the standalone lacks is copied in.
 *
 * `tsx` travels whole, with esbuild and the binary of this platform: the
 * daemon runs the compiled entries through it (`appEntryArgs`), because
 * Electron's Node 20 cannot `require()` the ES modules jsdom pulls in and
 * `tsx` transpiles them on the fly. Its loaders are resolved at runtime,
 * which a trace would not follow.
 */
async function completeStandalone(distDir, entries) {
  const standalone = join(appDir, distDir, 'standalone');
  if (!existsSync(standalone)) return;
  const { nodeFileTrace } = createRequire(join(appDir, 'package.json'))('next/dist/compiled/@vercel/nft');
  const { fileList } = await nodeFileTrace(entries, { base: appDir });
  let added = 0;
  for (const file of fileList) {
    if (file.startsWith('..') || isAbsolute(file)) throw new Error(`${file} lies outside the app: a package could not ship it`);
    if (UNSHIPPED.some((prefix) => file.startsWith(prefix))) continue;
    const to = join(standalone, file);
    if (existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(appDir, file), to);
    added++;
  }
  const tsxPackages = copyPackageClosure('tsx', standalone);
  cpSync(join(appDir, distDir, 'static'), join(standalone, distDir, 'static'), { recursive: true });
  if (existsSync(join(appDir, 'public'))) cpSync(join(appDir, 'public'), join(standalone, 'public'), { recursive: true });
  console.log(`[build-server] standalone completed: ${added} traced file(s) added, tsx with ${tsxPackages - 1} package(s), static and public copied → ${relative(appDir, standalone)}`);
}

async function main() {
  const esbuild = loadEsbuild();
  const distDir = process.env.NEXT_DIST_DIR || '.next';
  const outDir = join(appDir, distDir, 'timon');
  mkdirSync(outDir, { recursive: true });
  for (const entry of ENTRIES) {
    const result = await esbuild.build({
      absWorkingDir: appDir,
      entryPoints: [join(appDir, entry.source)],
      outfile: join(outDir, entry.out),
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'cjs',
      // Electron 33 runs Node 20 — the runtime of a package.
      target: 'node20',
      tsconfig: join(appDir, 'tsconfig.json'),
      logLevel: 'warning',
    });
    // A warning here is a runtime surprise later (an `import.meta` that
    // CommonJS turns into `{}`, a require that cannot resolve): refuse it.
    if (result.warnings.length) throw new Error(`${entry.source}: ${result.warnings.length} esbuild warning(s)`);
    console.log(`[build-server] ${entry.source} → ${join(outDir, entry.out)}`);
  }
  await completeStandalone(distDir, ENTRIES.map((entry) => join(outDir, entry.out)));
}

main().catch((err) => {
  console.error(`[build-server] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
