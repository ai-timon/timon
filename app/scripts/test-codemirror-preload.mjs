/**
 * Test preload (package.json `timonTests.imports`): one copy of each
 * CodeMirror package per test process. Why: test-codemirror-hooks.mjs.
 */
import { register } from 'node:module';

register('./test-codemirror-hooks.mjs', import.meta.url);
