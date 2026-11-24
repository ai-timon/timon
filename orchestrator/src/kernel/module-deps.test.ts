/**
 * The invariant that prevents the next "dreams": `inject` without `dependsOn`.
 *
 * `inject` is a HARD dependency in Cordis 4 and has no optional form.
 * If the module providing the service is turned off, the consumer stays
 * PENDING **silently**, and `auditActivation` then makes the daemon exit with
 * code 2. A module turned off on purpose must turn off those that depend on it
 * (`dependsOn` + `cascadeDependencies`), never make the boot fail.
 *
 * The trap is asymmetric: a service provided by a `core` module never turns
 * off, so injecting it asks for nothing. That is exactly why one does not
 * see it coming: `db`, `settings` and `http` work, then a `std` module
 * provides a service in turn and the rule changes without anybody rereading it.
 *
 * This test reads the truth on both sides: the `manifest.inject` are imported
 * from the modules themselves, the `ctx.provide` are read in their source.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { CATALOG } = await import('./catalog.js');
const { planEntries } = await import('./registry.js');
const { config } = await import('../config/load.js');
import type { ModuleDescriptor } from './registry.js';

/**
 * Services set by `boot.ts` before the loader: they come from no
 * catalogue entry and so never turn off.
 */
const ROOT_SERVICES = new Set(['http', 'host', 'timer', 'loader', 'logger']);

const hosted = CATALOG.filter((m) => !m.clientOnly);

/** `./plugins-bundled/x/index.js` (relative to `dist/`) → source path. */
function sourcePath(m: ModuleDescriptor): string {
  const url = new URL(m.name.replace('./', '../').replace(/\.js$/, '.ts'), import.meta.url);
  return fileURLToPath(url);
}

const injects = new Map<string, readonly string[]>();
for (const m of hosted) {
  const mod = (await import(m.name.replace('./', '../'))) as { manifest?: { inject?: string[] } };
  assert.ok(mod.manifest, `${m.id} does not export a manifest`);
  injects.set(m.id, mod.manifest.inject ?? []);
}

/** Service → id of the module that `provide`s it. */
const providers = new Map<string, string>();
for (const m of hosted) {
  const src = readFileSync(sourcePath(m), 'utf8');
  for (const match of src.matchAll(/ctx\.provide\('([^']+)'/g)) {
    providers.set(match[1], m.id);
  }
}

test('every injected service has a known provider', () => {
  for (const [id, list] of injects) {
    for (const service of list) {
      assert.ok(
        ROOT_SERVICES.has(service) || providers.has(service),
        `${id} injects "${service}" that nobody provides`,
      );
    }
  }
});

test('injecting a service that can be disabled requires a dependsOn on its provider', () => {
  const tierOf = new Map(CATALOG.map((m) => [m.id, m.tier]));
  for (const m of hosted) {
    for (const service of injects.get(m.id) ?? []) {
      if (ROOT_SERVICES.has(service)) continue;
      const provider = providers.get(service);
      if (provider === undefined || provider === m.id) continue;
      if (tierOf.get(provider) === 'core') continue; // a core module never turns off
      assert.ok(
        (m.dependsOn ?? []).includes(provider),
        `${m.id} injects "${service}" (provided by ${provider}, tier `
          + `${tierOf.get(provider)}) without dependsOn: turning ${provider} off would `
          + 'leave it PENDING and make the daemon exit with code 2',
      );
    }
  }
});

test('the dependsOn name catalogue modules', () => {
  const ids = new Set(CATALOG.map((m) => m.id));
  for (const m of CATALOG) {
    for (const dep of m.dependsOn ?? []) {
      assert.ok(ids.has(dep), `${m.id} depends on ${dep}, missing from the catalogue`);
    }
  }
});

/**
 * The same invariant, but played: each module that can be disabled is turned off, one
 * by one, and we check that NO entry still active injects a service whose
 * provider just disappeared. That is the requested boot test, without
 * booting thirty modules thirty times: what `planEntries` returns is exactly
 * what `boot.ts` gives the loader.
 */
test('turning off a module that can be disabled leaves no PENDING fiber', () => {
  const base = config();
  for (const target of CATALOG) {
    if (target.tier === 'core' || target.clientOnly) continue;
    const cfg = { ...base, modules: { ...base.modules, [target.id]: false } };
    const decisions = planEntries(CATALOG, { config: cfg, capabilities: [] });
    const off = new Set(decisions.filter((d) => d.disabled).map((d) => d.id));
    assert.ok(off.has(target.id), `${target.id} should have turned off`);
    for (const d of decisions) {
      if (d.disabled) continue;
      for (const service of injects.get(d.id) ?? []) {
        if (ROOT_SERVICES.has(service)) continue;
        const provider = providers.get(service);
        if (provider === undefined || provider === d.id) continue;
        assert.ok(
          !off.has(provider),
          `${target.id} off: ${d.id} stays active while its provider `
            + `${provider} ("${service}") is off: PENDING fiber, daemon at code 2`,
        );
      }
    }
  }
});

/**
 * TODO #275: the project's git routes lived in `kanban-code` (licensed,
 * dependent on the board), so switching Kanban off killed the Git cards.
 * They now belong to `@timon/git`, which nothing about the board can switch off.
 */
test('@timon/git survives the Kanban switched off; kanban-code follows git', () => {
  const base = config();
  const byId = (modules: Record<string, boolean>) => new Map(
    planEntries(CATALOG, { config: { ...base, modules: { ...base.modules, ...modules } }, capabilities: ['git'] })
      .map((d) => [d.id, d]),
  );

  const kanbanOff = byId({ '@timon/kanban': false });
  assert.equal(kanbanOff.get('@timon/git')?.disabled, false, 'git must not depend on the board');
  assert.equal(kanbanOff.get('@timon/kanban-code')?.disabled, true);

  const gitOff = byId({ '@timon/git': false });
  assert.equal(gitOff.get('@timon/kanban-code')?.reason, 'depends on @timon/git, which is disabled');
  assert.equal(gitOff.get('@timon/kanban')?.disabled, false);
});

/**
 * TIM-0147: workflows never touch a Kanban task. They inject only core
 * services, spawn their own missions and plug into `triggers` through an
 * optional sub-fiber, so a board switched off, or one the reconciler is still
 * retrying after a reboot, must leave every workflow running.
 */
test('@timon/workflows survives the Kanban switched off', () => {
  const entry = CATALOG.find((m) => m.id === '@timon/workflows');
  assert.ok(entry, '@timon/workflows is in the catalogue');
  for (const id of ['@timon/kanban', '@timon/triggers', '@timon/routines']) {
    assert.ok(!(entry.dependsOn ?? []).includes(id), `a dependsOn on ${id} would switch every workflow off with it`);
  }
  const base = config();
  const byId = (modules: Record<string, boolean>) => new Map(
    planEntries(CATALOG, { config: { ...base, modules: { ...base.modules, ...modules } }, capabilities: [] })
      .map((d) => [d.id, d]),
  );
  const kanbanOff = byId({ '@timon/kanban': false });
  assert.equal(kanbanOff.get('@timon/triggers')?.disabled, true, 'triggers follow the board');
  assert.equal(kanbanOff.get('@timon/workflows')?.disabled, false, 'workflows do not');
});

/**
 * TODO #356: the Files card reads `/api/agents/:name/files`, served by the
 * core agents module. Its dependency is declared, so the card can never be
 * on while the route it reads is off; switching it off touches nothing else.
 */
test('@timon/files-widget depends on @timon/agents and switches off alone', () => {
  const entry = CATALOG.find((m) => m.id === '@timon/files-widget');
  assert.deepEqual(entry?.dependsOn, ['@timon/agents']);
  assert.equal(entry?.clientOnly, true, 'the route stays in the core: no host half');
  const base = config();
  const byId = new Map(
    planEntries(CATALOG, { config: { ...base, modules: { ...base.modules, '@timon/files-widget': false } }, capabilities: ['git'] })
      .map((d) => [d.id, d]),
  );
  assert.equal(byId.get('@timon/files-widget')?.disabled, true);
  assert.equal(byId.get('@timon/agents')?.disabled, false);
});

/**
 * TODO #357: the Skills and MCP cards read the skills and MCP routes of the
 * core agents module, like Files. Each switches off on its own.
 */
test('@timon/skills-widget and @timon/mcp-widget depend on @timon/agents and switch off alone', () => {
  for (const id of ['@timon/skills-widget', '@timon/mcp-widget']) {
    const entry = CATALOG.find((m) => m.id === id);
    assert.deepEqual(entry?.dependsOn, ['@timon/agents'], id);
    assert.equal(entry?.clientOnly, true, `${id}: the routes stay in the core, no host half`);
  }
  const base = config();
  const byId = new Map(
    planEntries(CATALOG, { config: { ...base, modules: { ...base.modules, '@timon/skills-widget': false } }, capabilities: ['git'] })
      .map((d) => [d.id, d]),
  );
  assert.equal(byId.get('@timon/skills-widget')?.disabled, true);
  assert.equal(byId.get('@timon/mcp-widget')?.disabled, false, 'the MCP card does not follow the Skills card');
  assert.equal(byId.get('@timon/files-widget')?.disabled, false);
  assert.equal(byId.get('@timon/agents')?.disabled, false);
});
