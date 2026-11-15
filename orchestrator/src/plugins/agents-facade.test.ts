/**
 * `ctx.agents` — a plugin lists, creates and updates Timon agents within the
 * rights of the account that acts. Refusals come first: manifest, anonymous,
 * account without the right; then what the facade never lets through.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-agents-'));
await import('../../tests/helpers/paid-license.js');
await import('../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError, PluginAgentError } = await import('./context.js');
const { runPluginRequest } = await import('./als.js');
const { upsertAgent, patchAgentConfig, getAgent } = await import('../agent.js');
const { loadConfig } = await import('../agent-config.js');
const { agentsCreatedBy } = await import('./agent-origin.js');
const { agentConfig } = await import('../paths.js');
const { registerProfile } = await import('../backends/registry.js');
const { syncAgents } = await import('../../../examples/plugin-agent-sync/lib/index.js');

type Identity = Parameters<typeof runPluginRequest>[0];
const caller = (id: string, permissions: string[], isSuperadmin = false): Identity => ({
  viewer: { id, isSuperadmin, permissions },
  user: { id, email: `${id}@example.com`, name: id, is_superadmin: isSuperadmin },
  ownerUserId: id,
});
const manager = caller('ada', ['agents:manage']);
const reader = caller('rita', ['agents:read']);
const nobody = caller('bob', []);
const admin = caller('root', [], true);
const anonymous: Identity = { viewer: null, user: undefined, ownerUserId: null };
const as = <T>(who: Identity, fn: () => Promise<T>) => runPluginRequest(who, fn);

async function pluginWith(permissions: string[], id = 'acme-agents') {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

const input = (name: string, over: Record<string, unknown> = {}) => ({
  name, systemPrompt: `You are ${name}.`, role: 'research', backend: 'claude', ...over,
});

const code = (c: string) => (err: unknown) => err instanceof PluginAgentError && err.code === c;

upsertAgent({ name: 'Human.Agent', system_prompt: 'secret prompt of a human', config: { role: 'coder', cwd: tmpdir(), mcp_servers: ['internal'] } });

{
  const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('without `agents:*` in the manifest the facade refuses', async () => {
  const { plugin, dispose } = await pluginWith(['storage']);
  await assert.rejects(as(manager, () => plugin.agents.list()), PluginPermissionError);
  await assert.rejects(as(manager, () => plugin.agents.create(input('no-perm'))), PluginPermissionError);
  await assert.rejects(as(manager, () => plugin.agents.update('Human.Agent', { model: 'opus' })), PluginPermissionError);
  await dispose();
});

test('`agents:read` lists but does not write', async () => {
  const { plugin, dispose } = await pluginWith(['agents:read']);
  assert.ok((await as(reader, () => plugin.agents.list())).some((a) => a.name === 'Human.Agent'));
  await assert.rejects(as(manager, () => plugin.agents.create(input('read-only'))), PluginPermissionError);
  await dispose();
});

test('an anonymous request is refused', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await assert.rejects(as(anonymous, () => plugin.agents.list()), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.agents.create(input('anon'))), PluginCallerError);
  assert.equal(getAgent('anon'), null);
  await dispose();
});

test('an account without the right is refused even when the plugin holds the permission', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await assert.rejects(as(nobody, () => plugin.agents.list()), PluginCallerError);
  await assert.rejects(as(nobody, () => plugin.agents.create(input('sneaky'))), PluginCallerError);
  await assert.rejects(as(reader, () => plugin.agents.create(input('sneaky'))), PluginCallerError);
  assert.equal(getAgent('sneaky'), null);
  await dispose();
});

test('create marks the origin and reads back identity only', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  const made = await as(manager, () => plugin.agents.create(input('hermes-alpha', { model: 'opus', directives: 'Be brief.' })));
  assert.deepEqual(made, {
    name: 'hermes-alpha', backend: 'claude', model: 'opus', project: null, role: 'research',
    hasSystemPrompt: true, createdBy: 'plugin:acme-agents', mine: true, look: null, avatar: null,
  });
  assert.equal(loadConfig('hermes-alpha').created_by, 'plugin:acme-agents');

  const listed = await as(manager, () => plugin.agents.list());
  const human = listed.find((a) => a.name === 'Human.Agent');
  assert.ok(human);
  assert.equal(human.mine, false);
  const leaked = JSON.stringify(listed);
  for (const secret of ['secret prompt of a human', 'internal', tmpdir()]) {
    assert.ok(!leaked.includes(secret), `list must not expose ${secret}`);
  }
  await dispose();
});

test('a name already taken, whatever its case, is a conflict and the agent is untouched', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await assert.rejects(as(admin, () => plugin.agents.create(input('human.agent'))), code('conflict'));
  await assert.rejects(as(admin, () => plugin.agents.create(input('Human.Agent'))), code('conflict'));
  assert.equal(getAgent('Human.Agent')?.system_prompt, 'secret prompt of a human');
  assert.equal(loadConfig('Human.Agent').created_by, undefined);
  await dispose();
});

test('the input is strict: no protected or privileged field, a registered backend, a known role', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  for (const extra of [{ createdBy: 'plugin:other' }, { created_by: 'x' }, { mcp_servers: ['a'] }, { orchestrator: true }, { allowed_tools: ['Bash'] }, { permission_mode: 'bypassPermissions' }]) {
    await assert.rejects(as(admin, () => plugin.agents.create(input('strict', extra))), code('invalid'));
  }
  await assert.rejects(as(manager, () => plugin.agents.create(input('strict', { backend: 'no-such-backend' }))), code('invalid'));
  await assert.rejects(as(manager, () => plugin.agents.create(input('strict', { role: 'no-such-role' }))), code('invalid'));
  await assert.rejects(as(manager, () => plugin.agents.create(input('_eph-strict'))), code('invalid'));
  await assert.rejects(as(manager, () => plugin.agents.create({ name: 'strict', systemPrompt: 'x' } as never)), code('invalid'));
  assert.equal(getAgent('strict'), null);
  await dispose();
});

test('an orchestrator is a superadmin decision', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await assert.rejects(as(manager, () => plugin.agents.create(input('pilot', { role: 'orchestrator' }))), code('forbidden'));
  assert.equal(getAgent('pilot'), null);
  const made = await as(admin, () => plugin.agents.create(input('pilot', { role: 'orchestrator' })));
  assert.equal(made.role, 'orchestrator');
  await dispose();
});

test('secu-4 binds a non-admin caller: a cwd outside every project is refused', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await assert.rejects(as(manager, () => plugin.agents.create(input('rooted', { cwd: tmpdir() }))), code('forbidden'));
  assert.equal(getAgent('rooted'), null);
  await dispose();
});

test('update reaches only this plugin\'s agents, unless the caller is a superadmin', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  const other = await pluginWith(['agents:manage'], 'other-plugin');
  await as(manager, () => plugin.agents.create(input('hermes-beta')));

  const updated = await as(manager, () => plugin.agents.update('hermes-beta', { model: 'sonnet', systemPrompt: 'New prompt.' }));
  assert.equal(updated.model, 'sonnet');
  assert.equal(getAgent('hermes-beta')?.system_prompt, 'New prompt.');
  assert.equal(loadConfig('hermes-beta').created_by, 'plugin:acme-agents', 'the mark survives a prompt rewrite');

  await assert.rejects(as(manager, () => other.plugin.agents.update('hermes-beta', { model: 'opus' })), code('forbidden'));
  await assert.rejects(as(manager, () => plugin.agents.update('Human.Agent', { model: 'opus' })), code('forbidden'));
  await assert.rejects(as(manager, () => plugin.agents.update('ghost', { model: 'opus' })), code('not_found'));
  await assert.rejects(as(manager, () => plugin.agents.update('hermes-beta', { name: 'renamed' } as never)), code('invalid'));
  assert.equal(loadConfig('Human.Agent').model, undefined);

  const byAdmin = await as(admin, () => plugin.agents.update('Human.Agent', { model: 'opus' }));
  assert.equal(byAdmin.model, 'opus');
  assert.equal(loadConfig('Human.Agent').created_by, undefined, 'an admin edit does not adopt the agent');
  await other.dispose();
  await dispose();
});

test('the look: read back, written with the daemon\'s lists, cleared by null', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  const made = await as(manager, () => plugin.agents.create(input('hermes-look', {
    look: { shape: 'gem', color: '#D4A373', eyes: 'happy' },
  })));
  assert.deepEqual(made.look, { shape: 'gem', color: '#d4a373', eyes: 'happy', acc: 'none' });
  assert.deepEqual(loadConfig('hermes-look').look, { shape: 'gem', color: '#d4a373', eyes: 'happy', acc: 'none' });

  const changed = await as(manager, () => plugin.agents.update('hermes-look', {
    look: { shape: 'hex', color: '#3fa9ff', eyes: 'star', acc: 'loupe' },
  }));
  assert.deepEqual(changed.look, { shape: 'hex', color: '#3fa9ff', eyes: 'star', acc: 'loupe' });
  const listed = (await as(manager, () => plugin.agents.list())).find((a) => a.name === 'hermes-look');
  assert.deepEqual(listed?.look, changed.look);

  // With the prompt, the write goes through the full rewrite: the look survives it.
  await as(manager, () => plugin.agents.update('hermes-look', { systemPrompt: 'Still me.' }));
  assert.deepEqual(loadConfig('hermes-look').look, changed.look);

  const cleared = await as(manager, () => plugin.agents.update('hermes-look', { look: null }));
  assert.equal(cleared.look, null);
  assert.equal('look' in loadConfig('hermes-look'), false);
  await dispose();
});

test('the look: a value off the lists or an extra key is refused, and nothing is written', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await as(manager, () => plugin.agents.create(input('hermes-look-strict', {
    look: { shape: 'round', color: '#7ed957', eyes: 'big', acc: 'pen' },
  })));
  const before = loadConfig('hermes-look-strict').look;
  const refused = async (look: unknown, says: RegExp) => {
    await assert.rejects(
      as(manager, () => plugin.agents.update('hermes-look-strict', { look } as never)),
      (err: unknown) => code('invalid')(err) && says.test((err as Error).message),
    );
  };
  await refused({ shape: 'star', color: '#7ed957', eyes: 'big' }, /look\.shape: unknown value "star" \(expected one of squircle/);
  // Any `#rrggbb` is a fur now: only a value that is not one is off the lists.
  await refused({ shape: 'round', color: '#12345', eyes: 'big' }, /look\.color: unknown value "#12345"/);
  await refused({ shape: 'round', color: 'red', eyes: 'big' }, /look\.color: unknown value "red"/);
  await refused({ shape: 'round', color: '#gggggg', eyes: 'big' }, /look\.color: unknown value "#gggggg"/);
  await refused({ shape: 'round', color: '#7ed957', eyes: 'laser' }, /look\.eyes/);
  await refused({ shape: 'round', color: '#7ed957', eyes: 'big', acc: 'sword' }, /look\.acc/);
  await refused({ shape: 'round', color: '#7ed957', eyes: 'big', hat: 'top' }, /unknown field\(s\): hat/);
  await refused('gem', /look must be an object/);
  assert.deepEqual(loadConfig('hermes-look-strict').look, before);
  const custom = await as(manager, () => plugin.agents.update('hermes-look-strict', {
    look: { shape: 'round', color: '#00AbC9', eyes: 'big' },
  }));
  assert.deepEqual(custom.look, { shape: 'round', color: '#00abc9', eyes: 'big', acc: 'none' });
  assert.deepEqual(loadConfig('hermes-look-strict').look, { shape: 'round', color: '#00abc9', eyes: 'big', acc: 'none' });
  await assert.rejects(
    as(manager, () => plugin.agents.create(input('hermes-look-bad', { look: { shape: 'blob', color: '#7ed957', eyes: 'big' } }))),
    code('invalid'),
  );
  assert.equal(getAgent('hermes-look-bad'), null);
  await dispose();
});

test('the avatar mode: read back, kept apart from the look, cleared by null, refused off the list', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  const look = { shape: 'gem', color: '#d4a373', eyes: 'happy', acc: 'none' } as const;
  const made = await as(manager, () => plugin.agents.create(input('hermes-avatar', { look, avatar: 'mascot' })));
  assert.equal(made.avatar, 'mascot');
  assert.equal(loadConfig('hermes-avatar').avatar, 'mascot');
  const emoji = await as(manager, () => plugin.agents.update('hermes-avatar', { avatar: 'emoji' }));
  assert.equal(emoji.avatar, 'emoji');
  assert.deepEqual(emoji.look, look);
  const listed = (await as(manager, () => plugin.agents.list())).find((a) => a.name === 'hermes-avatar');
  assert.equal(listed?.avatar, 'emoji');
  await as(manager, () => plugin.agents.update('hermes-avatar', { systemPrompt: 'Still me.' }));
  assert.equal(loadConfig('hermes-avatar').avatar, 'emoji');
  await assert.rejects(
    as(manager, () => plugin.agents.update('hermes-avatar', { avatar: 'photo' } as never)),
    (err: unknown) => code('invalid')(err) && /avatar: unknown value "photo"/.test((err as Error).message),
  );
  assert.equal(loadConfig('hermes-avatar').avatar, 'emoji');
  const cleared = await as(manager, () => plugin.agents.update('hermes-avatar', { avatar: null }));
  assert.equal(cleared.avatar, null);
  assert.equal('avatar' in loadConfig('hermes-avatar'), false);
  assert.deepEqual(loadConfig('hermes-avatar').look, look);
  await dispose();
});

test('the look: no write without `agents:manage`, nor on an agent of somebody else', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  const readOnly = await pluginWith(['agents:read'], 'acme-reader');
  const look = { shape: 'bean', color: '#ff5fbf', eyes: 'wink' } as const;
  await as(manager, () => plugin.agents.create(input('hermes-look-own')));
  await assert.rejects(as(manager, () => readOnly.plugin.agents.update('hermes-look-own', { look })), PluginPermissionError);
  await assert.rejects(as(reader, () => plugin.agents.update('hermes-look-own', { look })), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.agents.update('hermes-look-own', { look })));
  await assert.rejects(as(manager, () => plugin.agents.update('Human.Agent', { look })), code('forbidden'));
  assert.equal(loadConfig('hermes-look-own').look, undefined);
  assert.equal(loadConfig('Human.Agent').look, undefined);
  // The reader still sees the look it may not change.
  patchAgentConfig('hermes-look-own', { look: { ...look, acc: 'none' } });
  const seen = (await as(reader, () => readOnly.plugin.agents.list())).find((a) => a.name === 'hermes-look-own');
  assert.deepEqual(seen?.look, { ...look, acc: 'none' });
  await readOnly.dispose();
  await dispose();
});

test('a job acts as the plugin: its own agents only', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  const made = await plugin.agents.create(input('hermes-job'));
  assert.equal(made.createdBy, 'plugin:acme-agents');
  const names = (await plugin.agents.list()).map((a) => a.name);
  assert.ok(names.includes('hermes-job'));
  assert.ok(!names.includes('Human.Agent'), 'a job does not see the agents of the accounts');
  await assert.rejects(plugin.agents.update('Human.Agent', { model: 'opus' }), code('not_found'));
  await assert.rejects(plugin.agents.create(input('job-pilot', { role: 'orchestrator' })), code('forbidden'));
  await dispose();
});

test('the origin mark cannot be forged and survives an editor save', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await as(manager, () => plugin.agents.create(input('hermes-gamma')));
  // The agent editor rewrites the whole config without the mark.
  upsertAgent({ name: 'hermes-gamma', system_prompt: 'edited by hand', config: { role: 'research', model: 'haiku' } });
  assert.equal(loadConfig('hermes-gamma').created_by, 'plugin:acme-agents');
  // Neither path lets a payload claim an agent for a plugin.
  patchAgentConfig('Human.Agent', { created_by: 'plugin:acme-agents' });
  upsertAgent({ name: 'forged', system_prompt: 'x', config: { role: 'coder', created_by: 'plugin:acme-agents' } });
  assert.equal(loadConfig('Human.Agent').created_by, undefined);
  assert.equal(JSON.parse(readFileSync(agentConfig('forged'), 'utf8')).created_by, undefined);
  await dispose();
});

test('the agents of a plugin are named, never deleted, at uninstall', async () => {
  const names = agentsCreatedBy('plugin:acme-agents');
  assert.ok(names.includes('hermes-alpha') && names.includes('hermes-job'));
  assert.ok(!names.includes('Human.Agent') && !names.includes('forged'));
  assert.ok(getAgent('hermes-alpha'));
});

test('examples/plugin-agent-sync: creates, then refreshes, and never touches a person\'s agent', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage'], 'agent-sync-example');
  upsertAgent({ name: 'sync.taken', system_prompt: 'a person made me', config: { role: 'coder' } });
  const profiles = [{ id: 'Support', prompt: 'You answer tickets.' }, { id: 'taken', prompt: 'x' }];
  const first = await as(manager, () => syncAgents(plugin, profiles));
  assert.deepEqual(first, { created: ['sync.support'], updated: [], skipped: ['sync.taken'] });
  const again = await as(manager, () => syncAgents(plugin, [{ id: 'support', prompt: 'You answer tickets, briefly.' }]));
  assert.deepEqual(again, { created: [], updated: ['sync.support'], skipped: [] });
  assert.equal(getAgent('sync.support')?.system_prompt, 'You answer tickets, briefly.');
  assert.equal(getAgent('sync.taken')?.system_prompt, 'a person made me');
  await assert.rejects(as(nobody, () => syncAgents(plugin, profiles)), PluginCallerError);
  await dispose();
});

test('a backend a plugin registered: per-call arbitration for any manager, sandbox for a superadmin only', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  const profile = (id: string, dialect: string) => ({
    id, dialect, label: id, defaultModel: 'acme-1', models: [{ slug: 'acme-1', label: 'acme-1' }], env: {},
  });
  const offBridge = registerProfile('acme-provider', profile('acme-bridge', 'claude'));
  const offSandbox = registerProfile('acme-provider', profile('acme-sandbox', 'codex'));
  try {
    const bridged = await as(manager, () => plugin.agents.create(input('acme.bridged', { backend: 'acme-bridge', model: 'acme-1' })));
    assert.equal(bridged.backend, 'acme-bridge');
    await assert.rejects(as(manager, () => plugin.agents.create(input('acme.sandboxed', { backend: 'acme-sandbox', model: 'acme-1' }))), code('forbidden'));
    const sandboxed = await as(admin, () => plugin.agents.create(input('acme.sandboxed', { backend: 'acme-sandbox', model: 'acme-1' })));
    assert.equal(sandboxed.backend, 'acme-sandbox');
  } finally { offBridge(); offSandbox(); }
  await assert.rejects(as(admin, () => plugin.agents.create(input('acme.gone', { backend: 'acme-bridge' }))), code('invalid'));
  await dispose();
});
