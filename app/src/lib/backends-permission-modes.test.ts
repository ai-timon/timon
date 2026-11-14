/**
 * The modes a backend honours, as the catalogue says (`supportedPermissionModes`):
 * the selectors offer only those, and any other mode runs in plan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportedPermissionModesFor, unsupportedModeRunsAs, type BackendCatalog } from './backends';

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    { id: 'claude', label: 'Claude Code', models: [], defaultModel: null },
    { id: 'grok', label: 'Grok Build', models: [], defaultModel: null, supportedPermissionModes: ['plan', 'bypassPermissions'] },
    { id: 'grok@acct1', label: 'Grok Build', models: [], defaultModel: null, supportedPermissionModes: ['plan', 'bypassPermissions'] },
  ],
};

test('a backend that declares its modes is read from the catalogue, its account instances too', () => {
  assert.deepEqual(supportedPermissionModesFor(CATALOG, 'grok'), ['plan', 'bypassPermissions']);
  assert.deepEqual(supportedPermissionModesFor(CATALOG, 'grok@acct1'), ['plan', 'bypassPermissions']);
  for (const backend of ['claude', 'unknown', null, undefined]) {
    assert.equal(supportedPermissionModesFor(CATALOG, backend), null, String(backend));
  }
});

test('a mode outside the list runs as plan; a listed one, or no list, says nothing', () => {
  const two = ['plan', 'bypassPermissions'];
  for (const mode of ['default', 'acceptEdits', 'auto', 'dontAsk', 'workspace-write', '', null, undefined]) {
    assert.equal(unsupportedModeRunsAs(two, mode), 'plan', String(mode));
  }
  for (const mode of ['plan', 'bypassPermissions', 'read-only', 'danger-full-access']) {
    assert.equal(unsupportedModeRunsAs(two, mode), null, mode);
  }
  assert.equal(unsupportedModeRunsAs(['plan', 'auto'], 'workspace-write'), null);
  assert.equal(unsupportedModeRunsAs(null, 'auto'), null);
});
