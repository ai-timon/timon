import assert from 'node:assert/strict';
import test from 'node:test';
import type { Capabilities } from './capabilities';

/**
 * TODO #645: every card of the chat's rails follows the `widget:` grant of its
 * plugin, and the narrow chat's way back to the missions list follows it too.
 */
function caps(over: Partial<Capabilities> = {}): Capabilities {
  return {
    edition: 'expert',
    profile: 'host',
    capabilities: [],
    modules: [],
    ui: { hidden: [], home: '/' },
    kernel: true,
    developer: { unsignedPlugins: false },
    ...over,
  };
}

const restricted = (widgets: string[], plugins: string[] = []): Capabilities['surfaces'] => ({
  pages: ['/chat'], widgets, nav: [], plugins, themes: [], layouts: [],
});

const CARDS: readonly { plugin: string; short: string; keys: readonly string[] }[] = [
  { plugin: '@timon/missions', short: 'missions', keys: ['Missions', 'agent-todos', 'mission'] },
  { plugin: '@timon/files-widget', short: 'files-widget', keys: ['Files'] },
  { plugin: '@timon/video-factory', short: 'video-factory', keys: ['video'] },
  { plugin: '@timon/git', short: 'git', keys: ['branches', 'graph', 'publish'] },
  { plugin: '@timon/docker-supervision', short: 'docker-supervision', keys: ['docker'] },
  { plugin: '@timon/orchestrator-self', short: 'orchestrator-self', keys: ['orchestrator'] },
  { plugin: '@timon/skills-widget', short: 'skills-widget', keys: ['skills'] },
  { plugin: '@timon/mcp-widget', short: 'mcp-widget', keys: ['mcp'] },
  { plugin: '@timon/workflows', short: 'workflows', keys: ['trace'] },
];

test('a role that opens the chat without any grant sees no card', async () => {
  const { visibleRegistrations } = await import('../components/chat/chat-rails');
  assert.deepEqual(visibleRegistrations(caps({ surfaces: restricted([]) })), []);
});

test('a card grant opens the cards of its plugin and no other', async () => {
  const { visibleRegistrations } = await import('../components/chat/chat-rails');
  for (const { plugin, short, keys } of CARDS) {
    const seen = (surfaces: Capabilities['surfaces']) => visibleRegistrations(caps({ surfaces })).map((i) => i.key).sort();
    assert.deepEqual(seen(restricted([short], [plugin])), [...keys].sort(), `widget:${short}`);
    assert.deepEqual(seen(restricted([], [plugin])), [...keys].sort(), `plugin:${plugin}`);
  }
});

test('nothing changes for a viewer without restrictions', async () => {
  const { visibleRegistrations } = await import('../components/chat/chat-rails');
  const all = CARDS.flatMap((card) => card.keys).sort();
  const keys = (c: Capabilities | null) => visibleRegistrations(c).map((i) => i.key).sort();
  assert.deepEqual(keys(null), all, 'capabilities not loaded yet');
  assert.deepEqual(keys(caps()), all, 'install without accounts');
  assert.deepEqual(keys(caps({ surfaces: { all: true } })), all, 'superadmin or *');
});

test('the narrow chat offers the missions list under the same grant', async () => {
  const { chatMissionsAllowed } = await import('../components/chat/chat-rails');
  assert.equal(chatMissionsAllowed(caps({ surfaces: restricted([]) })), false, 'deny by default');
  assert.equal(chatMissionsAllowed(caps({ surfaces: restricted(['git'], ['@timon/git']) })), false, 'another card opens nothing here');
  assert.equal(chatMissionsAllowed(caps({ surfaces: restricted(['missions'], ['@timon/missions']) })), true);
  assert.equal(chatMissionsAllowed(caps()), true);
});

test('the composer\'s branch bar follows the Git card, whose reads it shares (TODO #689)', async () => {
  const { composerGitAllowed } = await import('../components/chat/composer');
  const git = (active: boolean) => [{ id: '@timon/git', tier: 'std' as const, active, reason: null, missing: [] }];
  const on = (over: Partial<Capabilities>) => caps({ modules: git(true), ...over });
  assert.equal(composerGitAllowed(on({ surfaces: restricted([]) })), false, 'chat without the Git card');
  assert.equal(composerGitAllowed(on({ surfaces: restricted(['missions'], ['@timon/missions']) })), false, 'another card');
  assert.equal(composerGitAllowed(on({ surfaces: restricted(['git'], ['@timon/git']) })), true, 'widget:git');
  assert.equal(composerGitAllowed(on({ surfaces: restricted([], ['@timon/git']) })), true, 'plugin:@timon/git');
  assert.equal(composerGitAllowed(on({ surfaces: { all: true } })), true, 'unrestricted');
  assert.equal(composerGitAllowed(caps({ modules: git(false), surfaces: { all: true } })), false, 'module off');
});
