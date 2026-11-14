/**
 * Module hooks for the app tests, registered by test-codemirror-preload.mjs.
 *
 * The app package is CommonJS under the test runner, so CodeMirror loads from
 * its `.cjs` builds. `@codemirror/language-data` loads each grammar with a
 * real `import()`, even in its `.cjs` build, and Node resolves that with the
 * `import` condition: the grammar and its own `@codemirror/state` come from
 * the ESM builds. Two copies of `@codemirror/state` break CodeMirror's
 * `instanceof` checks, and the editor throws "Unrecognized extension value"
 * as soon as the grammar arrives. A bundler never has two copies, so an
 * `import()` of a CodeMirror package from a CommonJS file resolves to its
 * CommonJS build here too.
 */
const REQUIRE_CONDITIONS = ['node', 'require', 'default'];

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@codemirror/') && context.parentURL?.endsWith('.cjs')) {
    try {
      return await nextResolve(specifier, { ...context, conditions: REQUIRE_CONDITIONS });
    } catch {
      // No CommonJS build: the default resolution below decides.
    }
  }
  return nextResolve(specifier, context);
}
