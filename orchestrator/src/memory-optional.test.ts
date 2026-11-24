/**
 * End of the core tier: `@timon/memory` is an `opt` module: what becomes of
 * TIMON when it is turned off.
 *
 * What is protected here, in the order of risk:
 *   1. Recall NO LONGER RUNS. That is the trap of this part: `buildMemoryBlock`
 *      reads `dbApi` directly, and the `memory_*` tables belong to
 *      `@timon/db`, so they stay perfectly readable with the module off. Without a
 *      guard, turning the memory off would only have turned the screen off.
 *   2. The preamble stays WELL FORMED: its "TIMON memory" section disappears
 *      (it prescribes a gesture whose routes are no longer mounted), the rest
 *      is intact and in order.
 *   3. `dreams`, which injects the `@timon/memory` service, turns off IN CASCADE instead
 *      of staying PENDING: a PENDING fiber makes `auditActivation` exit with code
 *      2, that is to say a daemon that refuses to start because an optional
 *      module was cut.
 *
 * Throwaway `TIMON_HOME`, no daemon, no bind.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { config, setConfig } = await import('./config/load.js');
await import('../tests/helpers/claude-provider.js');

const { setActiveModules, resetActiveModules, moduleActive } = await import('./kernel/module-state.js');
const { planEntries, toLoaderEntries } = await import('./kernel/registry.js');
const { CATALOG } = await import('./kernel/catalog.js');
const { buildEffectivePrompt, buildMemoryBlock, upsertAgent, loadConfig } = await import('./agent.js');
const { getBackend } = await import('./backends/index.js');
const { addMemoryRule } = await import('./memory-rule-add.js');

const MEMORY = '@timon/memory';

/**
 * Plays "the kernel booted with (or without) the memory". It is indeed the real tree
 * that decides, not the config: `setLiveDecisions` posts this set at each
 * boot AND at each hot switch.
 */
function withMemory<T>(enabled: boolean, fn: () => T): T {
  const ids = CATALOG.map((m) => m.id).filter((id) => enabled || id !== MEMORY);
  setActiveModules(ids);
  try { return fn(); } finally { resetActiveModules(); }
}

/** Switches `modules['@timon/memory']` in the in-memory config. */
function withMemoryConfig<T>(enabled: boolean, fn: () => T): T {
  const before = config();
  setConfig({ ...before, modules: { ...before.modules, [MEMORY]: enabled } });
  try { return fn(); } finally { setConfig(before); }
}

test('module off: no rule is recalled, even if the table holds some', () => {
  const agent = 'memoire-optionnelle';
  upsertAgent({ name: agent, system_prompt: '# temoin\n', config: { cwd: process.cwd(), project: 'timon-temoin' } });
  // The rule is written IN THE DATABASE: it is indeed the module, not the data, that is
  // turned off. Turning it back on must find everything again.
  addMemoryRule({ scope: 'project', project: 'timon-temoin', tier: 'core', kind: 'pitfall', text: 'temoin-de-recall-memoire' });
  const cfg = loadConfig(agent);

  const on = withMemory(true, () => buildMemoryBlock(agent, cfg, 'temoin de recall'));
  assert.match(on, /temoin-de-recall-memoire/, 'module on: the rule is indeed recalled');

  const off = withMemory(false, () => buildMemoryBlock(agent, cfg, 'temoin de recall'));
  assert.equal(off, '', 'module off: no memory block at all');
});

test('module off: the spawn preamble is well formed, without its memory section', () => {
  const agent = 'memoire-optionnelle-preambule';
  upsertAgent({ name: agent, system_prompt: '# temoin\n', config: { cwd: process.cwd() } });
  const cfg = loadConfig(agent);
  const backend = getBackend('claude');

  const off = withMemory(false, () => buildEffectivePrompt(agent, cfg, backend, 'une mission quelconque'));
  assert.match(off, /# Runtime context — Timon/, 'the head of the preamble stays');
  assert.match(off, /## Asking the user — hard rule/, 'the tail of the preamble stays');
  // The preamble only talks about Timon: the test command is the
  // user's, it lives in their memory rules or the project AGENTS.md.
  assert.doesNotMatch(off, /npm test/);
  assert.doesNotMatch(off, /## Timon memory/, 'the memory section is removed');
  assert.doesNotMatch(off, /timon memory rule add/, 'no memory gesture prescribed any more');
  assert.doesNotMatch(off, /🧠/, 'no recall block injected');
  // Order: the tail follows the head without a gap or a duplicate.
  assert.ok(off.indexOf('# Runtime context — Timon') < off.indexOf('## Asking the user — hard rule'));

  const on = withMemory(true, () => buildEffectivePrompt(agent, cfg, backend, 'une mission quelconque'));
  assert.match(on, /## Timon memory/, 'module on: the section comes back');
  assert.ok(on.length > off.length);
});

test('outside a booted kernel, everything counts as active: the CLI and the tests do not change behaviour', () => {
  resetActiveModules();
  assert.equal(moduleActive(MEMORY), true, 'no kernel spoke: nothing is cut');
  assert.equal(withMemory(false, () => moduleActive(MEMORY)), false);
  assert.equal(withMemory(true, () => moduleActive(MEMORY)), true);
});

test('memory off: dreams turns off with it rather than blocking the boot', () => {
  const decisions = withMemoryConfig(false, () => planEntries(CATALOG, {
    config: config(),
    capabilities: ['systemd', 'containers', 'traefik', 'git', 'grepai', 'uvx', 'gui'],
    licensed: CATALOG.filter((m) => m.licensed).map((m) => m.id),
  }));
  const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
  assert.equal(byId['@timon/memory'].disabled, true);
  assert.equal(byId['@timon/dreams'].reason, 'depends on @timon/memory, which is disabled');
  // The kernel does not move: turning the memory off must cost nothing else.
  assert.equal(byId['@timon/missions'].disabled, false);
  assert.equal(byId['@timon/agents'].disabled, false);

  // What the loader will receive: `@timon/dreams` is marked `disabled`, so Cordis does not
  // instantiate it and there is NO fiber to leave PENDING. That precise link
  // is what avoids the `process.exit(2)` of the activation audit.
  const entries = toLoaderEntries(decisions);
  assert.equal(entries.find((e) => e.id === '@timon/dreams')?.disabled, true);
  assert.equal(entries.find((e) => e.id === '@timon/memory')?.disabled, true);
});
