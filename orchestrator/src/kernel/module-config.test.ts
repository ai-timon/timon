/**
 * `timon module list|enable|disable`: what the CLI writes into
 * `timon.config.json`, and what it reads back.
 *
 * What these tests protect, in the order of risk:
 *   1. The write is SURGICAL: the rest of the file survives the switch,
 *      the options of the module itself included. A `timon module disable` that
 *      reset the configuration of a module on the way would be a
 *      silent data loss.
 *   2. An unknown id is REFUSED. A typo would set a dead key
 *      in the config, making one believe the setting is taken.
 *   3. `list` returns the REAL state (capabilities, tier), not only what the
 *      config asks for: that is the whole difference between "I enabled it" and
 *      "it runs".
 *
 * No daemon, no real `~/.timon`: `TIMON_HOME` is a throwaway folder and
 * the host capabilities are injected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'timon-module-config-test-'));
process.env.TIMON_HOME = HOME;
await import('../../tests/helpers/paid-license.js');

const { listModules, setModuleEnabled, UnknownModuleError, CoreModuleError } =
  await import('./module-config.js');

const CATALOG = [
  { id: '@timon/db', name: './core-db.js', tier: 'core' },
  { id: '@timon/web-app', name: './web-app.js', tier: 'std' },
  { id: '@timon/grepai', name: './grepai.js', tier: 'dev', requires: ['grepai'] },
  // `std`, as in the real catalogue: its lock does not come from the tier.
  { id: '@timon/ui-theme', name: './ui-theme/client.js', tier: 'std', clientOnly: true },
] as const;

let n = 0;
function cfgFile(obj: unknown = {}): string {
  const file = join(HOME, `cfg-${n++}.json`);
  writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

test('enable/disable writes modules.<id> into timon.config.json', () => {
  const file = cfgFile({ profile: 'linux-desktop' });

  setModuleEnabled('@timon/web-app', true, file, CATALOG);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    profile: 'linux-desktop',
    modules: { '@timon/web-app': true },
  });

  setModuleEnabled('@timon/web-app', false, file, CATALOG);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).modules['@timon/web-app'], false);
});

test('a missing config file is created, not required', () => {
  const file = join(HOME, 'jamais-ecrit.json');
  assert.equal(existsSync(file), false);
  setModuleEnabled('@timon/web-app', false, file, CATALOG);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { modules: { '@timon/web-app': false } });
});

test('the switch keeps the module options and the rest of the file', () => {
  const file = cfgFile({
    edition: 'expert',
    settings: { TIMON_ALLOW_HTTP: true },
    modules: { '@timon/grepai': { enabled: true, port: 4242 }, '@timon/web-app': false },
  });

  setModuleEnabled('@timon/grepai', false, file, CATALOG);
  const after = JSON.parse(readFileSync(file, 'utf8'));

  // The object survives: `port` is an option passed to `apply`, losing it by
  // disabling for five seconds would amount to reconfiguring the module.
  assert.deepEqual(after.modules['@timon/grepai'], { enabled: false, port: 4242 });
  assert.equal(after.modules['@timon/web-app'], false);
  assert.equal(after.edition, 'expert');
  assert.deepEqual(after.settings, { TIMON_ALLOW_HTTP: true });
});

/**
 * `timon module disable grepai` must keep working after the move to
 * `@timon/*` ids: the command is in people's fingers and in scripts. It
 * writes the current id: the config converges on its own.
 */
test('a legacy id stays accepted as input, and writes the current id', () => {
  const file = cfgFile({ modules: { grepai: { enabled: true, port: 4242 } } });

  setModuleEnabled('grepai', false, file, CATALOG);

  const after = JSON.parse(readFileSync(file, 'utf8')) as { modules: Record<string, unknown> };
  assert.deepEqual(after.modules['@timon/grepai'], { enabled: false, port: 4242 });
  assert.equal(after.modules['grepai'], undefined);
});

test('an unknown module is refused, and nothing is written', () => {
  const file = cfgFile({ modules: { '@timon/web-app': true } });
  assert.throws(() => setModuleEnabled('web-ap', true, file, CATALOG), UnknownModuleError);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).modules, { '@timon/web-app': true });
});

test('a core module cannot be disabled', () => {
  const file = cfgFile();
  assert.throws(() => setModuleEnabled('@timon/db', false, file, CATALOG), CoreModuleError);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
  // …but enabling it explicitly stays allowed (a no-op on the kernel side, not an error).
  setModuleEnabled('@timon/db', true, file, CATALOG);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).modules['@timon/db'], true);
});

test('the product theme cannot be disabled: it carries all the tokens', () => {
  // `std`, not `core`: the daemon does not need it. The browser is what
  // would end up without a single custom property, gallery included.
  const file = cfgFile();
  assert.throws(() => setModuleEnabled('@timon/ui-theme', false, file, CATALOG), CoreModuleError);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
  setModuleEnabled('@timon/ui-theme', true, file, CATALOG);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).modules['@timon/ui-theme'], true);
});

test('list tells what the config asks for from what would run', () => {
  const file = cfgFile({ modules: { '@timon/web-app': false } });
  const rows = listModules({ file, catalog: CATALOG, capabilities: [] });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));

  // core: the config has no say.
  assert.equal(by['@timon/db'].active, true);
  assert.equal(by['@timon/db'].wanted, 'auto');

  // disabled by hand.
  assert.equal(by['@timon/web-app'].wanted, false);
  assert.equal(by['@timon/web-app'].active, false);
  assert.match(by['@timon/web-app'].reason, /timon\.config\.json/);

  // wanted by default, but the capability is missing: `auto` ≠ active.
  assert.equal(by['@timon/grepai'].wanted, 'auto');
  assert.equal(by['@timon/grepai'].active, false);
  assert.deepEqual(by['@timon/grepai'].missing, ['grepai']);
});

test('list: a present capability makes the module active', () => {
  const rows = listModules({ file: cfgFile(), catalog: CATALOG, capabilities: ['grepai'] });
  const grepai = rows.find((r) => r.id === '@timon/grepai');
  assert.equal(grepai?.active, true);
  assert.equal(grepai?.reason, null);
});
