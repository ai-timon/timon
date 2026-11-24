// french-ok-file: the French titles older notifications were stored with
import assert from 'node:assert/strict';
import test from 'node:test';

// The daemon titles its notifications in English since TODO #628: the picto
// of a notification must not depend on the language of its title.
async function source(title: string, type: 'report' | 'alert' | 'action_required' = 'report'): Promise<string> {
  const { notificationSource } = await import('@/plugins-client/notifications/notification-icon');
  return notificationSource({ anchor: null, title, type });
}

test('English titles of the daemon get the picto of their source', async () => {
  assert.equal(await source('Memory curated — timon'), 'memory');
  assert.equal(await source('Memory timon: 3 recurring fact(s) to review'), 'memory');
  assert.equal(await source('Dreaming: 2 track(s) to review'), 'dream');
  assert.equal(await source('Automatic deploy: `app` rebuilt ✅'), 'deploy');
  assert.equal(await source('Merge to repair by hand: Palette'), 'merge');
  assert.equal(await source('Task unblocked: Palette'), 'merge');
  assert.equal(await source('Task blocked: Palette'), 'blocked');
  assert.equal(await source('Weekly report'), 'report');
});

test('French titles kept in the history get the same picto', async () => {
  assert.equal(await source('Mémoire curée — timon'), 'memory');
  assert.equal(await source('Task bloquée : Palette'), 'blocked');
  assert.equal(await source('Rapport hebdo'), 'report');
});

test('RAM pressure is not agent memory: it falls back to its type', async () => {
  assert.equal(await source('Memory pressure (missions)', 'alert'), 'alert');
  assert.equal(await source('Memory ceiling reached (timon.coder)', 'alert'), 'alert');
});

test('every source has a picto, and no emoji is left in the notification surfaces', async () => {
  const { notificationIcon } = await import('@/plugins-client/notifications/notification-icon');
  for (const type of ['report', 'alert', 'action_required'] as const) {
    assert.ok(notificationIcon({ anchor: null, title: 'x', type }));
  }
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const emoji = /\p{Extended_Pictographic}/u;
  for (const file of ['app/agents/notification-rail.tsx', 'plugins-client/notifications/notification-feed.tsx', 'app/notifications/page.tsx']) {
    assert.doesNotMatch(readFileSync(join(process.cwd(), 'src', file), 'utf8'), emoji, file);
  }
});
