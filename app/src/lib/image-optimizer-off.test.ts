import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The image optimizer (`/_next/image`) must stay switched off: on the Next
 * line this app ships, it is an unauthenticated entry point to image decoding
 * with critical advisories against it (see `next.config.mjs`).
 *
 * Asserting `images.unoptimized` in the config file is not enough: what
 * matters is that Next's own handler refuses the request before it fetches or
 * decodes anything. So the second test runs the handler shipped in
 * `node_modules` (`NextNodeServer#handleNextImageRequest`) against the config
 * as Next itself loads it, on a stand-in server whose optimizer, cache and
 * fetch all fail the test if they are reached. If a Next upgrade moves or
 * drops that early exit, this suite fails instead of silently reopening the
 * route.
 */

const appDir = join(__dirname, '..', '..');
const nextRequire = createRequire(join(appDir, 'package.json'));

type ImagesConfig = { unoptimized?: boolean; loader?: string };
type LoadedConfig = { images: ImagesConfig; output?: string };
type LoadConfig = (phase: string, dir: string, opts?: { silent?: boolean }) => Promise<LoadedConfig>;
type ImageHandler = (req: unknown, res: unknown, parsedUrl: { pathname: string; query: Record<string, string> }) => Promise<boolean>;

async function loadNextConfig(): Promise<LoadedConfig> {
  const configModule = nextRequire('next/dist/server/config') as { default: LoadConfig };
  const constants = nextRequire('next/dist/shared/lib/constants') as { PHASE_PRODUCTION_SERVER: string };
  return configModule.default(constants.PHASE_PRODUCTION_SERVER, appDir, { silent: true });
}

/**
 * Lifts the arrow function the `NextNodeServer` constructor assigns to
 * `this.handleNextImageRequest` out of the shipped file, and rebinds its
 * lexical `this` to `server`. Building a real server would need a full
 * production build on disk; the handler only reads the fields given below.
 */
function shippedImageHandler(server: object): ImageHandler {
  const file = nextRequire.resolve('next/dist/server/next-server.js');
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf('this.handleNextImageRequest = async (req, res, parsedUrl)=>{');
  const end = source.indexOf('this.handleCatchallRenderRequest =', start);
  assert.ok(start > 0 && end > start, 'handleNextImageRequest not found where Next 15.5 defines it');
  // Next 15 chains the constructor's assignments with commas: the slice ends
  // on `},` there, and on `};` in the older layout.
  const body = source.slice(start, end).replace('this.handleNextImageRequest =', '').trim().replace(/[;,]$/, '');
  const fileRequire = createRequire(file);
  // The handler reads one module binding of `next-server.js` (`getRequestMeta`).
  const factory = new Function('require', 'process', '_requestmeta', `return function () { return ${body}; };`) as (
    req: NodeRequire,
    proc: NodeJS.Process,
    requestMeta: unknown,
  ) => () => ImageHandler;
  return factory(fileRequire, process, fileRequire('./request-meta')).call(server);
}

test('next.config.mjs switches the image optimizer off', () => {
  const nextConfig = require('../../next.config.mjs').default as { images?: ImagesConfig };
  assert.equal(nextConfig.images?.unoptimized, true);
});

test('/_next/image answers 404 before any fetch or decoding', async () => {
  const config = await loadNextConfig();
  assert.equal(config.images.unoptimized, true, 'Next dropped images.unoptimized while loading the config');

  let notFound = 0;
  const reached = (what: string) => () => {
    throw new Error(`the image optimizer reached ${what}`);
  };
  const server = {
    minimalMode: false,
    nextConfig: config,
    distDir: mkdtempSync(join(tmpdir(), 'timon-next-image-')),
    renderOpts: { dev: false },
    imageResponseCache: { get: reached('its response cache') },
    imageOptimizer: reached('the decoder'),
    render404: async () => {
      notFound += 1;
    },
  };
  const handler = shippedImageHandler(server);
  const res = { body: reached('a response body other than the 404 page') };

  const handled = await handler(
    { originalRequest: { headers: { accept: 'image/avif,image/webp' } }, url: '/_next/image' },
    res,
    { pathname: '/_next/image', query: { url: '/logo-192.png', w: '64', q: '75' } },
  );
  assert.equal(handled, true);
  assert.equal(notFound, 1);
  // Next 15 installs sharp as an optional dependency: the refusal must come
  // before the decoder is even loaded.
  assert.equal(Object.keys(require.cache).some((k) => /[\\/]node_modules[\\/]sharp[\\/]/.test(k)), false);
});
