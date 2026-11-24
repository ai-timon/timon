import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTick } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { callIntegration, integrationId, integrationJson, parseIntegrationValue, PluginIntegrationError } from './integration-primitives.js';
import { createIntegrationRegistries, PluginIntegrationScope } from './integration-registry.js';
import type { PluginIntegrationDisposer, PluginWorkflowExecutorDefinition, PluginTransportDefinition } from './integration-types.js';

const configSchema = z.object({ label: z.string().default('ok') });
const event = { name: 'issue.created', version: 1, payloadSchema: z.object({ number: z.number().int() }) };
const executor = (): PluginWorkflowExecutorDefinition => ({
  name: 'lookup', version: 1, configSchema, outputPorts: ['done'],
  execute: () => ({ output: { found: true }, port: 'done' }),
});
const transport = (): PluginTransportDefinition => ({
  name: 'chat', version: 1, configSchema,
  receive: () => ({ externalId: 'msg-1', text: 'hello', replyContext: { thread: '1' } }),
  send: () => ({ done: true, checkpoint: { fragment: 1 } }),
});
const code = (expected: PluginIntegrationError['code']) => (error: unknown) => error instanceof PluginIntegrationError && error.code === expected;

test('qualified names separate owners and versions and cannot impersonate core nodes', () => {
  const { events } = createIntegrationRegistries();
  assert.equal(events.register('acme-plugin', event).id, 'acme-plugin:issue.created@1');
  events.register('other-plugin', event);
  events.register('acme-plugin', { ...event, version: 2 });
  assert.throws(() => events.register('acme-plugin', event), code('conflict'));
  assert.equal(events.list().length, 3);
  for (const name of ['trigger.manual:other', 'other:event@1', '../escape', '', 'UPPER', 'x'.repeat(81)]) {
    assert.throws(() => integrationId('acme-plugin', name, 1), code('invalid'));
  }
  for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => integrationId('acme-plugin', 'event', version), code('invalid'));
  }
  assert.throws(() => integrationId('../other', 'event', 1), code('invalid'));
});

test('registration rejects invalid schemas, callbacks, ports and deadlines atomically', () => {
  const registries = createIntegrationRegistries();
  assert.throws(() => registries.events.register('acme-plugin', { ...event, payloadSchema: {} } as never), code('invalid'));
  for (const invalid of [[], ['done', 'done'], ['bad.port'], [''], Array(33).fill('done')]) {
    assert.throws(() => registries.executors.register('acme-plugin', { ...executor(), outputPorts: invalid }), code('invalid'));
  }
  for (const timeoutMs of [0, -1, NaN, 0.5, 300_001]) {
    assert.throws(() => registries.executors.register('acme-plugin', { ...executor(), timeoutMs }), code('invalid'));
  }
  assert.throws(() => registries.executors.register('acme-plugin', { ...executor(), execute: null } as never), code('invalid'));
  assert.throws(() => registries.triggers.register('acme-plugin', { name: 'tick', version: 1, configSchema, start: null } as never), code('invalid'));
  assert.throws(() => registries.transports.register('acme-plugin', { ...transport(), receive: null } as never), code('invalid'));
  assert.throws(() => registries.transports.register('acme-plugin', { ...transport(), send: null } as never), code('invalid'));
  for (const registry of Object.values(registries)) assert.equal(registry.list().length, 0);
  registries.executors.register('acme-plugin', executor());
});

test('definitions are snapshotted and mutable port arrays cannot change an admitted executor', async () => {
  const { executors } = createIntegrationRegistries();
  const definition = executor();
  const registration = executors.register('acme-plugin', definition);
  definition.name = 'renamed';
  (definition.outputPorts as string[]).push('injected');
  definition.execute = () => { throw new Error('replaced'); };
  assert.equal(registration.definition.name, 'lookup');
  assert.deepEqual(registration.definition.outputPorts, ['done']);
  assert.equal(Object.isFrozen(registration.definition), true);
  const result = await registration.invoke((spec, signal) => spec.execute({
    signal, identity: { ownerUserId: 'owner-1' }, runId: 'run-1', nodeId: 'lookup-1',
    config: {}, input: null, idempotencyKey: 'run-1/lookup-1',
  }));
  assert.deepEqual(result, { output: { found: true }, port: 'done' });
});

test('unload revokes all capabilities of one generation, preserving another plugin', async () => {
  const registries = createIntegrationRegistries();
  const scope = new PluginIntegrationScope('acme-plugin');
  const other = new PluginIntegrationScope('other-plugin');
  const leases = [
    scope.register(registries.events, event),
    scope.register(registries.triggers, { name: 'tick', version: 1, configSchema, start: () => () => {} }),
    scope.register(registries.executors, executor()),
    scope.register(registries.transports, transport()),
  ];
  other.register(registries.events, event);
  let operationSignal: AbortSignal | undefined;
  const pending = leases[2]!.invoke((_definition, signal) => {
    operationSignal = signal;
    return new Promise<never>(() => {});
  });
  await nextTick();
  scope.dispose();
  scope.dispose();
  await assert.rejects(pending, code('unloaded'));
  assert.equal(operationSignal?.aborted, true);
  assert.equal(registries.events.list().length, 1);
  for (const lease of leases) {
    assert.equal(lease.signal.aborted, true);
    await assert.rejects(lease.invoke(() => assert.fail('must not run')), code('unloaded'));
  }
  assert.throws(() => scope.register(registries.events, event), code('unloaded'));
  other.dispose();
});

test('an old disposer does not revoke a reloaded registration', () => {
  const { events } = createIntegrationRegistries();
  const oldScope = new PluginIntegrationScope('acme-plugin');
  const old = oldScope.register(events, event);
  old.dispose();
  const newScope = new PluginIntegrationScope('acme-plugin');
  const replacement = newScope.register(events, event);
  old.dispose();
  oldScope.dispose();
  assert.equal(events.get(replacement.id)?.signal.aborted, false);
  newScope.dispose();
  assert.equal(events.get(replacement.id), undefined);
});

test('a Cordis plugin effect releases its integration scope on real fiber unload', async () => {
  const root = new Context();
  const registries = createIntegrationRegistries();
  const scope = new PluginIntegrationScope('acme-plugin');
  const fiber = await root.plugin((ctx: Context) => {
    ctx.effect(() => () => scope.dispose());
    scope.register(registries.events, event);
    scope.register(registries.transports, transport());
  });
  try {
    assert.equal(registries.events.list().length, 1);
    await fiber.dispose();
    assert.equal(registries.events.list().length, 0);
    assert.equal(registries.transports.list().length, 0);
    assert.throws(() => scope.register(registries.events, event), code('unloaded'));
  } finally { await root.fiber.dispose(); }
});

test('schema validation snapshots input and output and supports Zod defaults', () => {
  const input = { number: 42 };
  const parsed = parseIntegrationValue(event.payloadSchema, input);
  input.number = 43;
  assert.deepEqual(parsed, { number: 42 });
  assert.deepEqual(parseIntegrationValue(configSchema, {}), { label: 'ok' });
  assert.throws(() => parseIntegrationValue(event.payloadSchema, { number: 'bad' }));
  assert.throws(() => parseIntegrationValue({ parse: () => new Date() } as never, {}), code('invalid'));
});

test('JSON rejects silent data loss, getters, cycles, sparse arrays and oversized payloads', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const sparse = new Array(3); sparse[1] = 'hello';
  let getterCalls = 0;
  const accessor = { get value() { getterCalls++; return 'hidden'; } };
  let deep: unknown = null;
  for (let n = 0; n < 34; n++) deep = { child: deep };
  const symbolKey = { [Symbol('hidden')]: 1 };
  for (const input of [undefined, NaN, Infinity, 1n, () => {}, new Date(), cycle, sparse, accessor, symbolKey,
    { missing: undefined }, { toJSON: () => 'hidden' }, Object.defineProperty({}, 'hidden', { value: 1 }),
    'é'.repeat(140_000), Array(10_001).fill(0), deep]) { // french-ok: a two-byte letter that doubles the UTF-8 size
    assert.throws(() => integrationJson(input), code('invalid'));
  }
  assert.equal(getterCalls, 0);
});

test('JSON snapshots preserve prototype-looking keys and shared values without invoking toJSON', () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":"literal"}');
  assert.deepEqual(integrationJson(payload), payload);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  const shared = { value: 1 };
  const result = integrationJson([shared, shared]);
  shared.value = 2;
  assert.deepEqual(result, [{ value: 1 }, { value: 1 }]);
  class CustomArray extends Array { toJSON() { assert.fail('must not call toJSON'); } }
  const custom = new CustomArray(); custom.push(1, 2);
  assert.deepEqual(integrationJson(custom), [1, 2]);
});

test('a timeout rejects a stalled callback and aborts its signal', async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(callIntegration((currentSignal) => {
    signal = currentSignal;
    return new Promise<never>(() => {});
  }, { timeoutMs: 10 }), code('timeout'));
  assert.equal(signal?.aborted, true);
});

test('a callback observes caller cancellation, including cancellation before its first microtask', async () => {
  const caller = new AbortController();
  const reason = new Error('request cancelled');
  const pending = callIntegration(() => assert.fail('must not run'), { signals: [caller.signal] });
  caller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  await assert.rejects(callIntegration(() => assert.fail('must not run'), { signals: [caller.signal] }), (error) => error === reason);
});

test('normal completion and errors remove abort listeners and clear the deadline', async () => {
  const caller = new AbortController();
  let adds = 0; let removes = 0;
  const add = caller.signal.addEventListener.bind(caller.signal);
  const remove = caller.signal.removeEventListener.bind(caller.signal);
  caller.signal.addEventListener = (...args: Parameters<AbortSignal['addEventListener']>) => { adds++; add(...args); };
  caller.signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => { removes++; remove(...args); };
  assert.equal(await callIntegration(() => 42, { signals: [caller.signal] }), 42);
  const failure = new Error('provider failure');
  await assert.rejects(callIntegration(() => { throw failure; }, { signals: [caller.signal] }), (error) => error === failure);
  await assert.rejects(callIntegration(async () => { throw failure; }, { signals: [caller.signal] }), (error) => error === failure);
  assert.equal(adds, 3);
  assert.equal(removes, adds);
});

test('late async setup releases its resource once and reports cleanup failure', async () => {
  let finish!: (dispose: PluginIntegrationDisposer) => void;
  let cleaned = 0;
  let reported: unknown;
  const failure = new Error('cleanup failed');
  const pending = callIntegration(() => new Promise<PluginIntegrationDisposer>((resolve) => { finish = resolve; }), {
    timeoutMs: 10,
    onLateResult: (dispose) => dispose(),
    onCleanupError: (error) => { reported = error; },
  });
  await assert.rejects(pending, code('timeout'));
  finish(async () => { cleaned++; throw failure; });
  await nextTick();
  assert.equal(cleaned, 1);
  assert.equal(reported, failure);
});

test('late provider rejection after unload is consumed and never changes the result', async () => {
  const { transports } = createIntegrationRegistries();
  const lease = transports.register('acme-plugin', transport());
  let fail!: (error: Error) => void;
  const pending = lease.invoke(() => new Promise((_resolve, reject) => { fail = reject; }));
  await nextTick();
  lease.dispose();
  await assert.rejects(pending, code('unloaded'));
  fail(new Error('late provider failure'));
  await nextTick();
});

test('callers may shorten but cannot extend the registered timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { executors } = createIntegrationRegistries();
  const lease = executors.register('acme-plugin', { ...executor(), timeoutMs: 10 });
  const long = assert.rejects(lease.invoke(() => new Promise<never>(() => {}), { timeoutMs: 100 }), code('timeout'));
  t.mock.timers.tick(10);
  await long;
  const short = assert.rejects(lease.invoke(() => new Promise<never>(() => {}), { timeoutMs: 2 }), code('timeout'));
  t.mock.timers.tick(2);
  await short;
  assert.equal(lease.signal.aborted, false, 'one timeout does not unload the registration');
  assert.equal(await lease.invoke(() => 'recovered'), 'recovered');
  lease.dispose();
});
