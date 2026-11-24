/**
 * `agent-name-rule.ts` is a verbatim copy of the daemon's
 * `orchestrator/src/agent-name.ts` (two independent packages, as for
 * `brand.ts`): the screen must refuse exactly what the daemon refuses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isValidAgentName } from './agent-name-rule';

test('the copy is the daemon file, byte for byte', () => {
  const here = readFileSync(new URL('./agent-name-rule.ts', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../../../orchestrator/src/agent-name.ts', import.meta.url), 'utf8');
  assert.equal(here, source, 'copy orchestrator/src/agent-name.ts over app/src/lib/agent-name-rule.ts');
});

test('the copy accepts every script and refuses what a folder cannot hold', () => {
  for (const name of ['马斯克', 'Нова', 'مرحبا', 'Zoë', '_main']) assert.equal(isValidAgentName(name), true, name); // french-ok: non-Latin names, all valid
  for (const name of ['..', '.x', '-x', 'a b', '😀', 'CON', 'foo.', '马'.repeat(27)]) assert.equal(isValidAgentName(name), false, name);
});
