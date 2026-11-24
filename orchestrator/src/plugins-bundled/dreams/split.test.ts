/**
 * The `dreams` / "TO DO" notebook split: who serves what.
 *
 * The risk of this extraction is not the moved code (verbatim), it is
 * a route left on both sides (double mount) or on neither (lost
 * route). So each router is mounted ALONE and we check that it serves
 * exactly its half: `dreams` the dreams and the project scoring,
 * `@timon/kanban` the "TO DO" notebook.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Router } from 'express';

const dreamRoutes = await import('./routes.js');
const backlogRoutes = await import('../kanban/project-todo-routes.js');
const { CATALOG } = await import('../../kernel/catalog.js');

/** One ephemeral server per router: no state shared between the two. */
async function serve(register: (r: Router) => void): Promise<{ url: (p: string) => string; close: () => void }> {
  const app = express();
  app.use(express.json());
  register(app);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { url: (p) => `http://127.0.0.1:${port}${p}`, close: () => server.close() };
}

test('the dreams module serves the dreams and the project scoring', async () => {
  const d = await serve(dreamRoutes.registerRoutes);
  try {
    assert.equal((await fetch(d.url('/api/dreams/config'))).status, 200);
    assert.equal((await fetch(d.url('/api/dreams'))).status, 200);
    assert.equal((await fetch(d.url('/api/projects/scores'))).status, 200);
    // The "later" notebook is not its own.
    assert.equal((await fetch(d.url('/api/project-todo'))).status, 404);
  } finally { d.close(); }
});

test('the "TO DO" notebook is served by @timon/kanban, not by dreams', async () => {
  const d = await serve(backlogRoutes.registerRoutes);
  try {
    assert.equal((await fetch(d.url('/api/project-todo'))).status, 200);
    assert.equal((await fetch(d.url('/api/dreams'))).status, 404);
    assert.equal((await fetch(d.url('/api/dreams/config'))).status, 404);
    assert.equal((await fetch(d.url('/api/projects/scores'))).status, 404);
  } finally { d.close(); }
});

test('dreams is a catalogue module, can be disabled like the others', () => {
  const entry = CATALOG.find((m) => m.id === '@timon/dreams');
  assert.ok(entry, 'dreams must be in the catalogue');
  assert.equal(entry.tier, 'std');
  assert.notEqual(entry.tier, 'core');
});
