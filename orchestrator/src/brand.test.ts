/**
 * The brand: the internal identifier follows Timon (Phase R).
 *
 * An `id` that was no longer `timon` would break the `~/.timon` home, the
 * `TIMON_*` keys and the CLI binary. This test fails in CI rather than silently.
 */
// Isolates TIMON_HOME BEFORE any module that touches state (see test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from './brand.js';

test('the internal identifier is `timon`', () => {
  assert.equal(BRAND.id, 'timon');
});

test('the public name and the CLI binary are Timon / timon', () => {
  assert.equal(BRAND.displayName, 'Timon');
  assert.equal(BRAND.cliName, 'timon');
  assert.equal(BRAND.cliName, BRAND.id);
});

test('the public surface frozen in Phase P does not move without a decision', () => {
  // These three values are contracts: an already published plugin carries
  // `manifestKey` in its package.json and imports `sdkPackage`. Changing them
  // breaks everything that is distributed.
  assert.equal(BRAND.npmScope, '@timon-ai');
  assert.equal(BRAND.sdkPackage, '@timon-ai/sdk');
  assert.equal(BRAND.manifestKey, 'timon');
  assert.ok(BRAND.sdkPackage.startsWith(BRAND.npmScope + '/'), 'the SDK lives under the brand scope');
});

test('the constant is frozen: nobody mutates it at runtime', () => {
  assert.throws(() => {
    (BRAND as { displayName: string }).displayName = 'autre';
  }, TypeError);
});
