/**
 * `agents:privileged-config`: the power-user path of the override guards.
 * Without it the conservative rules stand; with it any known mode/backend/tool
 * passes, bounded by the caller's own permission level.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-privconf-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { agentConfigRefusal, llmChoiceRefusal, permissionModeRefusal, spawnOverrideRefusal, taskOverrideRefusal, RESTRICTED } = await import('./privileged-overrides.js');
const { MISSION_TOKEN_PERMISSIONS } = await import('./permissions.js');
const { catalogBackend, resolvedPermissionModeFor, supportedPermissionModesOf } = await import('../backends/catalog.js');
const { saveBackendOverlay } = await import('../backends/overlays.js');
const { inactiveProfiles } = await import('../backends/registry.js');
const { db } = await import('../db.js');

{
  // grok's profile exists only where its CLI is found: without the stand-in the
  // suite reads the developer's own install and fails on a clean machine (the CI).
  const { mountOfficialProviders, stubCliBinaries } = await import('../../tests/helpers/official-providers.js');
  await stubCliBinaries('grok');
  await mountOfficialProviders();
}

const relaxed = (ceiling: string | null) => ({ relaxed: true, ceiling });
const sandbox = ['codex', 'grok', 'copilot'].find((id) => catalogBackend(id)?.permissionModel === 'sandbox');

test('the mission token cap carries the permission', () => {
  assert.ok((MISSION_TOKEN_PERMISSIONS as readonly string[]).includes('agents:privileged-config'));
});

test('restricted: bypassPermissions, a sandbox backend and new tools stay refused', () => {
  assert.match(agentConfigRefusal({ permission_mode: 'bypassPermissions' }, null, RESTRICTED) ?? '', /not allowed/);
  assert.ok(sandbox, 'the catalogue must hold a sandbox backend');
  assert.match(agentConfigRefusal({ backend: sandbox }, null, RESTRICTED) ?? '', /cannot arbitrate/);
  assert.match(agentConfigRefusal({ allowed_tools: ['Bash'] }, null, RESTRICTED) ?? '', /widens/);
});

test('relaxed: a sandbox backend and free tools pass', () => {
  assert.equal(agentConfigRefusal({ backend: sandbox, allowed_tools: ['Bash'], mcp_servers: ['x'] }, null, relaxed('default')), null);
});

test('relaxed: the level never exceeds the caller\'s own', () => {
  assert.equal(agentConfigRefusal({ permission_mode: 'acceptEdits' }, null, relaxed('auto')), null);
  assert.equal(agentConfigRefusal({ permission_mode: 'auto' }, null, relaxed('auto')), null);
  assert.match(agentConfigRefusal({ permission_mode: 'auto' }, null, relaxed('default')) ?? '', /above the caller's own level/);
  assert.match(agentConfigRefusal({ permission_mode: 'bypassPermissions' }, null, relaxed('acceptEdits')) ?? '', /above/);
});

test('supportedModes: a backend that declares them runs every other mode in plan, and only there', () => {
  assert.deepEqual(catalogBackend('grok')?.supportedPermissionModes, ['plan', 'bypassPermissions']);
  assert.deepEqual(supportedPermissionModesOf('grok'), ['plan', 'bypassPermissions']);
  for (const mode of ['default', 'auto', 'acceptEdits', 'dontAsk', 'read-only', 'workspace-write', 'typo', undefined]) {
    assert.equal(resolvedPermissionModeFor('grok', mode), 'plan', String(mode));
  }
  assert.equal(resolvedPermissionModeFor('grok', 'bypassPermissions'), 'bypassPermissions');
  assert.equal(resolvedPermissionModeFor('grok', 'danger-full-access'), 'bypassPermissions');
  // The other providers declare nothing: the mode goes through untouched.
  for (const backend of ['claude', 'codex', 'copilot', 'unknown-backend']) {
    assert.equal(supportedPermissionModesOf(backend), undefined, backend);
    for (const mode of ['default', 'auto', 'acceptEdits', 'bypassPermissions']) {
      assert.equal(resolvedPermissionModeFor(backend, mode), mode, `${backend} ${mode}`);
    }
  }
});

test('supportedModes: the ceiling judges the mode asked for, never lowered by the backend that resolves it', () => {
  const onGrok = { backend: 'grok' } as const;
  // Without the bypass right: a guarded mode passes, as on any backend…
  for (const mode of ['default', 'acceptEdits', 'auto']) {
    assert.equal(agentConfigRefusal({ permission_mode: mode }, onGrok, RESTRICTED), null, mode);
    assert.equal(spawnOverrideRefusal({ permission_mode: mode }, onGrok, RESTRICTED), null, mode);
    assert.equal(taskOverrideRefusal({ permission_mode_override: mode }, onGrok, RESTRICTED), null, mode);
    assert.equal(permissionModeRefusal(mode, RESTRICTED, 'grok'), null, mode);
  }
  // …and what it would refuse elsewhere stays refused, even though grok runs it read-only.
  for (const mode of ['dontAsk', 'bypassPermissions']) {
    assert.match(agentConfigRefusal({ permission_mode: mode }, onGrok, RESTRICTED) ?? '', /not allowed/, mode);
    assert.match(spawnOverrideRefusal({ permission_mode: mode }, onGrok, RESTRICTED) ?? '', /not allowed/, mode);
    assert.match(taskOverrideRefusal({ permission_mode_override: mode }, onGrok, RESTRICTED) ?? '', /not allowed/, mode);
    assert.match(permissionModeRefusal(mode, RESTRICTED, 'grok') ?? '', /not allowed/, mode);
  }
  // The message still says what the agent would really get.
  assert.match(agentConfigRefusal({ permission_mode: 'dontAsk' }, onGrok, RESTRICTED) ?? '', /dontAsk \(runs as plan on backend grok\)/);
  // A caller that runs read-only hands out read-only, whatever the backend makes of more.
  assert.match(agentConfigRefusal({ permission_mode: 'default' }, onGrok, relaxed('plan')) ?? '', /above/);
  assert.match(agentConfigRefusal({ permission_mode: 'default' }, { backend: 'claude' }, relaxed('plan')) ?? '', /above/);
  assert.equal(agentConfigRefusal({ permission_mode: 'plan' }, onGrok, relaxed('plan')), null);
  assert.match(agentConfigRefusal({ permission_mode: 'bypassPermissions' }, onGrok, relaxed('default')) ?? '', /above/);
  assert.match(spawnOverrideRefusal({ permission_mode: 'bypassPermissions', backend_override: 'grok' }, null, relaxed('auto')) ?? '', /above/);
  // The right holder gets it.
  assert.equal(agentConfigRefusal({ permission_mode: 'bypassPermissions' }, onGrok, relaxed('bypassPermissions')), null);
  assert.equal(agentConfigRefusal({ backend: 'grok', permission_mode: 'bypassPermissions' }, null, relaxed(null)), null);
  // A name nobody knows is still refused: once stored it would reach the next backend.
  assert.match(agentConfigRefusal({ permission_mode: 'typo' }, onGrok, relaxed(null)) ?? '', /not a known permission mode/);
  assert.match(agentConfigRefusal({ permission_mode: 'typo' }, onGrok, RESTRICTED) ?? '', /not allowed/);
});

test('supportedModes: a stored override is judged as asked, since a backend fallback runs it unjudged', () => {
  // A spawn or task override is stored as asked, and the mission or task can
  // later fall back to another backend (quota run dry) without a new judgement:
  // judged as the `plan` grok would run it, this `auto` would run as `auto` on claude.
  const onGrok = { backend: 'grok' } as const;
  assert.match(spawnOverrideRefusal({ permission_mode: 'auto' }, onGrok, relaxed('plan')) ?? '', /above/);
  assert.match(taskOverrideRefusal({ permission_mode_override: 'auto' }, onGrok, relaxed('plan')) ?? '', /above/);
});

test('supportedModes: moving an agent off grok judges the mode it will then run as written', () => {
  // `dontAsk` ran read-only on grok; on claude it runs as itself.
  assert.match(agentConfigRefusal({ backend: 'claude' }, { backend: 'grok', permission_mode: 'dontAsk' }, RESTRICTED) ?? '', /not allowed/);
  assert.match(agentConfigRefusal({ backend: 'claude' }, { backend: 'grok', permission_mode: 'auto' }, relaxed('default')) ?? '', /above/);
  assert.equal(agentConfigRefusal({ backend: 'claude' }, { backend: 'grok', permission_mode: 'auto' }, RESTRICTED), null);
  // Moving onto grok lowers the level: nothing to judge.
  assert.equal(agentConfigRefusal({ backend: 'grok' }, { backend: 'claude', permission_mode: 'auto' }, relaxed('plan')), null);
});

test('supportedModes: an installed backend that is inactive right now is still judged by what it runs', () => {
  // Disabled in settings (or its CLI uninstalled, or signed out): the catalogue
  // no longer lists grok, but an agent stored on it ran read-only there, and
  // moving it elsewhere is still a raise to judge.
  try {
    saveBackendOverlay('grok', { disabled: true });
    assert.equal(catalogBackend('grok'), undefined);
    assert.ok(inactiveProfiles().some((p) => p.id === 'grok'));
    assert.deepEqual(supportedPermissionModesOf('grok'), ['plan', 'bypassPermissions']);
    assert.equal(resolvedPermissionModeFor('grok', 'auto'), 'plan');
    assert.match(agentConfigRefusal({ backend: 'claude' }, { backend: 'grok', permission_mode: 'auto' }, relaxed('default')) ?? '', /above/);
    assert.match(agentConfigRefusal({ permission_mode: 'dontAsk' }, { backend: 'grok' }, RESTRICTED) ?? '', /dontAsk \(runs as plan on backend grok\)/);
  } finally { db.prepare('DELETE FROM backend_overlays').run(); }
  assert.ok(catalogBackend('grok'));
});

test('supportedModes: claude and codex keep the grid they had', () => {
  assert.equal(agentConfigRefusal({ backend: 'claude', permission_mode: 'default' }, null, RESTRICTED), null);
  assert.match(agentConfigRefusal({ backend: 'claude', permission_mode: 'dontAsk' }, null, RESTRICTED) ?? '', /not allowed/);
  assert.equal(agentConfigRefusal({ backend: 'claude', permission_mode: 'acceptEdits' }, null, relaxed('acceptEdits')), null);
  assert.match(agentConfigRefusal({ backend: 'claude', permission_mode: 'bypassPermissions' }, null, relaxed('default')) ?? '', /above/);
  assert.equal(agentConfigRefusal({ backend: 'codex', permission_mode: 'auto' }, null, relaxed('auto')), null);
  assert.match(agentConfigRefusal({ backend: 'codex', permission_mode: 'auto' }, null, relaxed('default')) ?? '', /above/);
  assert.equal(permissionModeRefusal('auto', RESTRICTED, 'claude'), null);
  // A backend change between two providers that honour every mode judges nothing new.
  assert.equal(agentConfigRefusal({ backend: 'codex' }, { backend: 'claude', permission_mode: 'bypassPermissions' }, relaxed('default')), null);
});

test('relaxed: the codex sandbox names share the ladder with the claude modes', () => {
  const ask = (mode: string, ceiling: string | null) => agentConfigRefusal({ permission_mode: mode }, null, relaxed(ceiling));
  assert.equal(ask('read-only', 'plan'), null);
  assert.equal(ask('plan', 'read-only'), null);
  assert.equal(ask('workspace-write', 'auto'), null);
  assert.equal(ask('auto', 'workspace-write'), null);
  assert.equal(ask('danger-full-access', 'bypassPermissions'), null);
  assert.equal(ask('bypassPermissions', 'danger-full-access'), null);
  assert.match(ask('workspace-write', 'acceptEdits') ?? '', /above/);
  assert.match(ask('workspace-write', 'read-only') ?? '', /above/);
  assert.match(ask('danger-full-access', 'workspace-write') ?? '', /above/);
  assert.match(ask('workspace_write', 'workspace-write') ?? '', /not a known permission mode/);
});

test('a value the agent already holds is never refused, whatever the caller may pick', () => {
  const current = { backend: sandbox, model: 'unlisted-model', permission_mode: 'danger-full-access', cwd: process.cwd() };
  // The whole current config sent back, from the weakest caller there is.
  assert.equal(agentConfigRefusal({ ...current }, current, RESTRICTED), null);
  assert.equal(agentConfigRefusal({ ...current }, current, relaxed('plan')), null);
  // One changed field is judged on its own.
  assert.match(agentConfigRefusal({ ...current, permission_mode: 'acceptEdits' }, current, relaxed('plan')) ?? '', /above/);
  // The same level under its other name is not a change either.
  assert.equal(agentConfigRefusal({ ...current, permission_mode: 'bypassPermissions' }, current, relaxed('plan')), null);
  assert.match(agentConfigRefusal({ ...current, model: 'other-unlisted' }, current, RESTRICTED) ?? '', /catalogue/);
  assert.match(agentConfigRefusal({ ...current, cwd: '/' }, current, RESTRICTED) ?? '', /register the project first/i);
});

test('relaxed: an agent already in bypassPermissions may pass it on', () => {
  assert.equal(agentConfigRefusal({ permission_mode: 'bypassPermissions' }, null, relaxed('bypassPermissions')), null);
});

test('relaxed: no mission behind the call (human) means no ceiling, but a typo is refused', () => {
  assert.equal(agentConfigRefusal({ permission_mode: 'bypassPermissions' }, null, relaxed(null)), null);
  assert.match(agentConfigRefusal({ permission_mode: 'byPassPermission' }, null, relaxed(null)) ?? '', /not a known permission mode/);
});

test('relaxed: an unknown ceiling hands nothing out', () => {
  assert.match(agentConfigRefusal({ permission_mode: 'default' }, null, relaxed('weird')) ?? '', /above/);
});

test('tasks take the spawn rules', () => {
  const bypass = { permission_mode_override: 'bypassPermissions' };
  assert.match(taskOverrideRefusal(bypass, null, RESTRICTED) ?? '', /not allowed/);
  assert.match(taskOverrideRefusal(bypass, null, relaxed('default')) ?? '', /above/);
  assert.equal(taskOverrideRefusal(bypass, null, relaxed('bypassPermissions')), null);
  assert.match(taskOverrideRefusal({ backend_override: sandbox }, null, RESTRICTED) ?? '', /cannot arbitrate/);
  assert.equal(taskOverrideRefusal({ backend_override: sandbox }, null, relaxed('default')), null);
  assert.equal(taskOverrideRefusal({ permission_mode_override: null, backend_override: null }, null, RESTRICTED), null);
});

test('spawn: relaxed lifts the tool and sandbox rules, keeps the ceiling', () => {
  assert.match(spawnOverrideRefusal({ extra_allowed_tools: ['Bash'] }, null, RESTRICTED) ?? '', /widens/);
  assert.equal(spawnOverrideRefusal({ extra_allowed_tools: ['Bash'], backend_override: sandbox }, null, relaxed('default')), null);
  assert.match(spawnOverrideRefusal({ permission_mode: 'bypassPermissions' }, null, relaxed('default')) ?? '', /above/);
});

test('restricted: a remote backend is selectable — it starts nothing on this host — a local sandbox still is not', async () => {
  const { registerDialect, registerProfile } = await import('../backends/registry.js');
  const { memoryDialect } = await import('../../tests/helpers/example-dialects.js') as {
    memoryDialect: import('../backends/types.js').RemoteDialect;
  };
  const OWNER = 'privileged-config-remote-test';
  const offs = [
    registerDialect(OWNER, 'privileged-remote', memoryDialect),
    registerProfile(OWNER, {
      id: 'privileged-remote-gateway', dialect: 'privileged-remote', label: 'Remote gateway',
      defaultModel: null, models: [], env: {},
    }),
  ];
  try {
    assert.equal(catalogBackend('privileged-remote-gateway')?.remote, true);
    assert.equal(agentConfigRefusal({ backend: 'privileged-remote-gateway' }, null, RESTRICTED), null);
    // Nothing else is relaxed by it: the permission mode is still capped.
    assert.match(
      agentConfigRefusal({ backend: 'privileged-remote-gateway', permission_mode: 'bypassPermissions' }, null, RESTRICTED) ?? '',
      /bypassPermissions/,
    );
    // And a local backend that cannot arbitrate stays refused.
    assert.match(agentConfigRefusal({ backend: sandbox }, null, RESTRICTED) ?? '', /cannot arbitrate/);
  } finally {
    for (const off of offs) off();
  }
});

test('a backend chosen for later (fallback, series rule) takes the backend_override grid (TODO #561)', () => {
  assert.ok(sandbox);
  assert.match(llmChoiceRefusal({ backend: sandbox }, RESTRICTED, 'fallback') ?? '', /^fallback: backend .* cannot arbitrate/);
  assert.match(taskOverrideRefusal({ fallback_backend_override: sandbox }, null, RESTRICTED) ?? '', /cannot arbitrate/);
  assert.equal(llmChoiceRefusal({ backend: sandbox }, relaxed(null), 'fallback'), null);
  // Naming no backend selects none: the sentinel, null, '' and a model alone.
  for (const backend of ['none', null, '', undefined]) {
    assert.equal(llmChoiceRefusal({ backend, model: 'whatever' }, RESTRICTED, 'fallback'), null, String(backend));
  }
  assert.match(llmChoiceRefusal({ backend: 'claude', model: 'gpt-5.6-sol' }, relaxed(null), 'fallback') ?? '', /not in the catalogue/);
  assert.match(llmChoiceRefusal({ backend: 42 }, RESTRICTED, 'fallback') ?? '', /must be a string/);
});
