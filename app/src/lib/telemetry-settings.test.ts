/**
 * Settings › System › Privacy, the usage statistics row: its status line, its
 * one action, and the words of a refusal. When the environment or the
 * configuration file decides, the daemon answers `telemetry_preference_forced`:
 * the row must say where to change it, in the reader's language, never the
 * raw code or a `{placeholder}`.
 */
import './i18n-test-locales';
import assert from 'node:assert/strict';
import test from 'node:test';
import { getLocale, setLocale, t } from './i18n';
import { putTelemetryPreference, telemetryStatusKeys, type TelemetryPreferenceView } from './telemetry-preference';
import { waitUntil } from './test-wait';

const ON: TelemetryPreferenceView = { enabled: true, source: 'default', malformed: false, editable: true, active: true };
const FORCED = { error: 'the statistics preference is set outside Timon (environment or configuration file)', code: 'telemetry_preference_forced', source: 'env' };

function answering(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

test('the status line: the state first, then who decides, then a build that sends nothing', () => {
  assert.deepEqual(telemetryStatusKeys(ON), ['telemetrySettings.statusOn']);
  assert.deepEqual(telemetryStatusKeys({ ...ON, enabled: false, source: 'settings' }), ['telemetrySettings.statusOff']);
  assert.deepEqual(
    telemetryStatusKeys({ ...ON, enabled: false, source: 'env', editable: false, active: false }),
    ['telemetrySettings.statusOff', 'telemetrySettings.lockedEnv', 'telemetrySettings.inactiveBuild'],
  );
});

test('a refusal is worded from the daemon\'s code, in each language, without a placeholder', async () => {
  const before = getLocale();
  try {
    for (const tag of ['en', 'fr']) {
      setLocale(tag);
      const result = await putTelemetryPreference(false, answering(409, FORCED));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.message, t('apiErrors.telemetry_preference_forced'), tag);
      assert.notEqual(result.message, FORCED.error, `${tag}: the dictionary speaks, not the daemon's English`);
      assert.doesNotMatch(result.message, /[{}]/, tag);
    }
  } finally {
    setLocale(before);
  }
  const denied = await putTelemetryPreference(false, answering(403, { error: 'forbidden' }));
  assert.deepEqual(denied, { ok: false, message: t('telemetrySettings.forbidden') });
  const offline = await putTelemetryPreference(false, (async () => { throw new TypeError('fetch failed'); }) as typeof fetch);
  assert.deepEqual(offline, { ok: false, message: t('telemetrySettings.saveFailed') });
  const saved = await putTelemetryPreference(false, answering(200, { ...ON, enabled: false, source: 'settings' }));
  assert.deepEqual(saved, { ok: true, pref: { ...ON, enabled: false, source: 'settings' } });
});

test('the row: one "Turn off" at the right, and the forced refusal rendered as words', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const puts: unknown[] = [];
  install('fetch', (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      puts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(FORCED), { status: 409 });
    }
    return new Response(JSON.stringify(ON), { status: 200 });
  }) as typeof fetch);

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { TelemetrySettings } = await import('../plugins-client/telemetry/settings');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(TelemetrySettings)); });

  const toggle = () => document.querySelector<HTMLButtonElement>('[data-telemetry-toggle]');
  await waitUntil(React.act, () => toggle() !== null, 'the row\'s action');
  const row = document.querySelector('[data-telemetry-row]')!;
  assert.match(row.textContent ?? '', new RegExp(t('telemetrySettings.statusOn').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(toggle()!.textContent, t('telemetrySettings.turnOff'));
  assert.equal(row.querySelectorAll('button').length, 2, 'one action and the "…" menu, nothing else');
  assert.ok(!document.querySelector('[data-telemetry-settings] p:not([role="alert"])'), 'no paragraph on the page');

  await React.act(async () => { toggle()!.click(); });
  await waitUntil(React.act, () => document.querySelector('[role="alert"]') !== null, 'the refusal');
  assert.deepEqual(puts, [{ enabled: false }]);
  const alert = document.querySelector('[role="alert"]')!.textContent ?? '';
  assert.equal(alert, t('apiErrors.telemetry_preference_forced'));
  assert.doesNotMatch(alert, /[{}]|telemetry_preference_forced/);
  await React.act(async () => { root.unmount(); });
});
