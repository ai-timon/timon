/**
 * three.js (~600 kB) and the model data (~2 MB) must stay out of the page's
 * first bundle: only `engine.ts` imports three, only `model-data.ts` names the
 * data, and both are reached through dynamic `import()` from the light
 * modules a screen mounts.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'));
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8');
/** Static imports and re-exports, type-only ones excepted (erased at build). */
const staticImports = (src: string): string[] =>
  [...src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');

test('only the engine imports three.js', () => {
  for (const f of sources) {
    const hasThree = staticImports(read(f)).includes('three');
    assert.equal(hasThree, f === 'engine.ts', f);
  }
});

test('nothing imports the engine or the model data statically', () => {
  for (const f of sources) {
    for (const spec of staticImports(read(f))) {
      assert.notEqual(spec, './engine', `${f} imports the engine statically`);
      assert.ok(!spec.endsWith('agent-data.json'), `${f} imports the model data statically`);
    }
  }
  assert.match(read('tile.ts'), /import\('\.\/engine'\)/);
  assert.match(read('model-data.ts'), /import\('\.\/agent-data\.json'\)/);
});
