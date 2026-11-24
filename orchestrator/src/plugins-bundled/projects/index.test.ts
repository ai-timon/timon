/**
 * The projects module, really mounted, not only decided.
 *
 * "End of the core tier" gives it a namespaced id, and this module names
 * itself to Cordis: `ctx.provide('@timon/projects')`. A service
 * token holding `@` and `/` is checked by no typing (`declare
 * module` accepts any key), so a green `tsc` says nothing of what
 * Cordis does with it at boot. So the module is applied on a real context
 * and the token read back, otherwise the only way to discover a refusal would be a
 * daemon that does not start.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

const { createHttpPlugin } = await import('../../kernel/http-service.js');
const { apply, name } = await import('./index.js');
const { CATALOG } = await import('../../kernel/catalog.js');

test('the module applies under its namespaced id and serves its routes', async () => {
  const app = express();
  app.use(express.json());
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(app));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(name, '@timon/projects');
    apply(ctx);
    assert.ok(ctx['@timon/projects'], 'the service token must resolve under its namespaced name');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/projects`)).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await ctx.fiber.dispose();
  }
});

test('the module is in the catalogue, outside the kernel, hence can be disabled', () => {
  const entry = CATALOG.find((m) => m.id === '@timon/projects');
  assert.ok(entry, '@timon/projects must be in the catalogue');
  assert.equal(entry.tier, 'std');
  assert.equal(entry.name, './plugins-bundled/projects/index.js');
});
