/**
 * TIM-0063. Under `--no-ask-user` the copilot CLI answers a command off its
 * allowlist with "retry in an interactive session": the model retried in vain,
 * or marked its task failed over a read it could have done another way. The
 * backend block of the preamble tells a copilot agent what that refusal means.
 *
 * Its own file: the copilot profile only exists when a `copilot` binary is
 * found, so a stand-in goes on PATH before anything reads it.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// Beside the Timon home, not in it: no binary is ever resolved from there.
const binDir = mkdtempSync(`${process.env.TIMON_HOME!}-bin-`);
const stub = join(binDir, process.platform === 'win32' ? 'copilot.cmd' : 'copilot');
writeFileSync(stub, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
if (process.platform !== 'win32') chmodSync(stub, 0o755);
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`;

const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
await mountOfficialProviders();
const { upsertAgent } = await import('./agent.js');
const { buildInjections } = await import('./prompt-injections.js');

function backendBlock(backend: string): string {
  return buildInjections('inj-copilot-perm', '', { backend_override: backend, model_override: 'm' })
    .blocks.find((b) => b.id === 'backend')!.content;
}

test('a copilot agent is told that an allowlist refusal is final, other backends are not', () => {
  upsertAgent({ name: 'inj-copilot-perm', system_prompt: '# base prompt\n', config: { role: 'coder', project: 'inj-proj-cp' } });
  const copilot = backendBlock('copilot');
  assert.match(copilot, /Your LLM backend \(`copilot`\)/);
  assert.match(copilot, /no interactive user response was available/);
  assert.match(copilot, /nobody can approve it/);
  assert.doesNotMatch(backendBlock('claude'), /no interactive user response/);
});
