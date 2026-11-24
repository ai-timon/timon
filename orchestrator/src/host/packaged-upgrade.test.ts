import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config/load.js';
import { serviceOptsFromEnvironment } from './service-environment.js';
import { installService, readServiceDefinition, restoreServiceDefinition, removeServiceDefinition, plistPath } from './service-install.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceOpts, ServiceResult } from './service-install.js';
import { upgradeDesktopService, upgradeSessionMode, type UpgradeDeps } from './packaged-upgrade.js';

const OLD = 'unit of 0.1.0';
const NEW = 'unit of 0.2.0';

/** A supervisor file in memory, and the order in which each step ran. */
function harness(overrides: Partial<UpgradeDeps> = {}, start: string | null = OLD) {
  const steps: string[] = [];
  let definition = start;
  const ok = (lines: string[]): ServiceResult => ({ ok: true, code: 0, lines });
  const deps: UpgradeDeps = {
    platform: 'linux',
    stage: async () => { steps.push('stage'); },
    options: () => ({ platform: 'linux' } as ServiceOpts),
    install: () => { steps.push('install'); definition = NEW; return ok(['installed']); },
    read: () => definition,
    restore: (_opts, previous) => { steps.push('restore'); definition = previous; return ok(['restored']); },
    remove: () => { steps.push('remove'); definition = null; return ok(['removed']); },
    healthy: async () => { steps.push('healthy'); return true; },
    mark: async () => { steps.push('mark'); },
    prune: async () => { steps.push('prune'); },
    warn: () => { steps.push('warn'); },
    ...overrides,
  };
  return { deps, steps, definition: () => definition };
}

test('the previous release is pruned only after the new service answered', async () => {
  const { deps, steps, definition } = harness();
  const result = await upgradeDesktopService(deps);
  assert.equal(result.ok, true);
  assert.deepEqual(steps, ['stage', 'install', 'healthy', 'mark', 'prune']);
  assert.equal(definition(), NEW);
});

test('a new service that never answers is rolled back, and nothing is marked or pruned', async () => {
  const { deps, steps, definition } = harness({ healthy: async () => false });
  const result = await upgradeDesktopService(deps);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /did not answer.*previous service was restored/);
  assert.deepEqual(steps, ['stage', 'install', 'restore']);
  assert.equal(definition(), OLD);
  assert.equal(result.fallback, false);
});

test('a refused rewrite restores only what it reports having written', async () => {
  // Written, then refused by systemd: put the previous unit back.
  const written = harness({
    install: () => { written.steps.push('install'); return { ok: false, code: 1, lines: ['systemctl refused: boom'] }; },
  });
  const refused = await upgradeDesktopService(written.deps);
  assert.equal(refused.ok, false);
  assert.equal(refused.fallback, false);
  assert.match(refused.reason!, /systemctl refused: boom.*restored/);
  assert.deepEqual(written.steps, ['stage', 'install', 'restore']);

  // Refused before any write (identity check): the running service is not touched.
  const untouched = harness({
    install: () => ({ ok: false, code: 3, lines: [], reason: 'belongs to another installation', written: false }),
  });
  const kept = await upgradeDesktopService(untouched.deps);
  assert.equal(kept.ok, false);
  assert.equal(kept.fallback, false);
  assert.match(kept.reason!, /another installation.*left in place/);
  assert.deepEqual(untouched.steps, ['stage']);
  assert.equal(untouched.definition(), OLD);

  // The same refusal without the promise is assumed to have written: restore.
  const unknown = harness({ install: () => ({ ok: false, code: 3, lines: [], reason: 'refused' }) });
  await upgradeDesktopService(unknown.deps);
  assert.deepEqual(unknown.steps, ['stage', 'restore']);

  // A throw may have happened after the write: restore too.
  const threw = harness({ install: () => { throw new Error('EACCES'); } });
  const thrown = await upgradeDesktopService(threw.deps);
  assert.match(thrown.reason!, /EACCES.*restored/);
  assert.deepEqual(threw.steps, ['stage', 'restore']);
});

test('without a previous definition, a new service that never answers is removed and the embedded daemon takes over', async () => {
  const { deps, steps, definition } = harness({ healthy: async () => { steps.push('healthy'); return false; } }, null);
  const result = await upgradeDesktopService(deps);
  assert.equal(result.ok, false);
  assert.equal(result.fallback, true);
  assert.match(result.reason!, /did not answer.*no previous service definition.*new one was removed/);
  assert.deepEqual(steps, ['stage', 'install', 'healthy', 'remove']);
  assert.equal(definition(), null);

  const stuck = harness({
    healthy: async () => false,
    remove: () => ({ ok: false, code: 1, lines: [], reason: 'Failed to connect to bus' }),
  }, null);
  const failed = await upgradeDesktopService(stuck.deps);
  assert.equal(failed.fallback, true);
  assert.match(failed.reason!, /removing the new one failed: Failed to connect to bus/);
  assert.equal(stuck.definition(), NEW);

  // Refused before writing, no definition either: nothing to remove.
  const untouched = harness({ install: () => ({ ok: false, code: 3, lines: [], reason: 'refused', written: false }) }, null);
  const kept = await upgradeDesktopService(untouched.deps);
  assert.equal(kept.fallback, false);
  assert.deepEqual(untouched.steps, ['stage']);
});

test('a release that answers but cannot be recorded is kept running, and nothing is pruned', async () => {
  const { deps, steps, definition } = harness({ mark: async () => { steps.push('mark'); throw new Error('ENOSPC'); } });
  const result = await upgradeDesktopService(deps);
  assert.equal(result.ok, false);
  assert.equal(result.fallback, false);
  assert.match(result.reason!, /answers, but it could not be recorded as active: ENOSPC.*retried at the next launch/);
  assert.deepEqual(steps, ['stage', 'install', 'healthy', 'mark']);
  assert.equal(definition(), NEW);
});

test('a failed copy changes nothing, and a failed restore is reported as such', async () => {
  const copy = harness({ stage: async () => { throw new Error('ENOSPC'); } });
  const copied = await upgradeDesktopService(copy.deps);
  assert.equal(copied.ok, false);
  assert.match(copied.reason!, /ENOSPC/);
  assert.deepEqual(copy.steps, []);

  const broken = harness({
    healthy: async () => false,
    restore: () => ({ ok: false, code: 1, lines: [], reason: 'No bus' }),
  });
  const result = await upgradeDesktopService(broken.deps);
  assert.match(result.reason!, /Restoring the previous service also failed: No bus/);
  assert.equal(result.fallback, true);
});

test('a prune failure does not fail an upgrade that succeeded', async () => {
  const { deps, steps } = harness({ prune: async () => { throw new Error('EACCES'); } });
  assert.equal((await upgradeDesktopService(deps)).ok, true);
  assert.deepEqual(steps.slice(-2), ['mark', 'warn']);
});

/**
 * Windows has no release copy: the NSIS update already replaced the files the
 * task runs. What it cannot replace is the task itself, and a revision-1 task
 * dies at logoff (backlog #141) — so the upgrade rewrites only that, and puts
 * the previous task back when the new one does not answer.
 */
test('windows rewrites the task only, without staging, marking or pruning a release', async () => {
  const { deps, steps, definition } = harness({ platform: 'win32' });
  assert.equal((await upgradeDesktopService(deps)).ok, true);
  assert.deepEqual(steps, ['install', 'healthy']);
  assert.equal(definition(), NEW);

  const silent = harness({ platform: 'win32', healthy: async () => false });
  const result = await upgradeDesktopService(silent.deps);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /previous service was restored/);
  assert.deepEqual(silent.steps, ['install', 'restore']);
  assert.equal(silent.definition(), OLD);
});

/**
 * TODO #342: Windows registered the new task but never launched it
 * for this account (S4U refused). The old one runs under the same S4U
 * session: restoring it would give back a refused task whose `/Run` answers
 * "SUCCESS", and the desktop would wait for it. Neither restore nor removal
 * (the batch already removed it): the embedded daemon takes over.
 */
test('windows: a task Windows never started is not restored, the embedded daemon takes over', async () => {
  const reason = 'Windows registered the TimonOrchestrator task but never started it for this account.';
  const { deps, steps } = harness({
    platform: 'win32',
    install: () => { steps.push('install'); return { ok: false, code: 1, lines: [], refused: true, reason }; },
  });
  const result = await upgradeDesktopService(deps);
  assert.equal(result.ok, false);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, reason);
  assert.deepEqual(steps, ['install']);
});

for (const previous of [null, OLD]) {
  test(`missing launchctl falls back to the embedded daemon (${previous ? 'restore' : 'remove'})`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'timon-missing-supervisor-'));
    const calls: string[] = [];
    try {
      const cfg = loadConfig(undefined, { readonly: true });
      const opts: ServiceOpts = {
        ...serviceOptsFromEnvironment(cfg, () => ({ exec: (command) => {
          calls.push(command);
          throw new Error(`${command} not found`);
        } })),
        platform: 'darwin', homeDir: home, timonHome: home, installDir: home,
        unitContent: undefined, unitName: undefined,
      };
      if (previous !== null) {
        mkdirSync(dirname(plistPath(home)), { recursive: true });
        writeFileSync(plistPath(home), previous);
      }
      for (const command of ['launchctl', 'systemctl']) {
        assert.deepEqual(opts.exec(command, []), { code: 127, stdout: '', stderr: `${command} not found` });
      }
      const { deps, steps } = harness({
        platform: 'darwin', options: () => opts,
        install: installService, read: readServiceDefinition,
        restore: restoreServiceDefinition, remove: removeServiceDefinition,
      });
      const result = await upgradeDesktopService(deps);
      assert.equal(result.ok, false);
      assert.equal(result.fallback, true);
      assert.match(result.reason!, /launchctl not found/);
      assert.match(result.reason!, previous ? /Restoring the previous service also failed/ : /removing the new one failed/);
      assert.equal(readServiceDefinition(opts), previous);
      assert.deepEqual(steps, ['stage']);
      assert.ok(calls.length >= 4);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

/**
 * #116: a task switched to the interactive token by hand keeps the boot
 * trigger of an off-session task. The desktop hands the runner that intent;
 * the user's recorded answer always wins over it.
 */
test('windows #116: the desktop\'s session intent is used only when the user never answered', () => {
  assert.equal(upgradeSessionMode('always', null), 'always');
  assert.equal(upgradeSessionMode('session', null), 'session');
  assert.equal(upgradeSessionMode('always', 'session'), undefined, 'the recorded answer wins');
  assert.equal(upgradeSessionMode('session', 'always'), undefined, 'the recorded answer wins');
  assert.equal(upgradeSessionMode(undefined, null), undefined, 'no intent: the task in place decides');
  assert.equal(upgradeSessionMode('boot', null), undefined, 'an unknown intent is ignored');
});

test('windows #116: a rewrite kept for the session only says so in its result', async () => {
  const notice = 'it stops at logout';
  const { deps } = harness({
    platform: 'win32',
    install: () => ({ ok: true, code: 0, lines: [notice], sessionFallback: true }),
  });
  const result = await upgradeDesktopService(deps);
  assert.equal(result.ok, true);
  assert.equal(result.sessionFallback, true);
  assert.deepEqual(result.lines, [notice]);
  const plain = await upgradeDesktopService(harness({ platform: 'win32' }).deps);
  assert.equal(plain.sessionFallback, undefined, 'an off-session task kept as asked says nothing');
});
