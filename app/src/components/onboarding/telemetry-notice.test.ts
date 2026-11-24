/**
 * The onboarding's line about usage statistics: shown only while they are
 * sent, its "Turn them off" writes the same preference as Settings › System ›
 * Privacy, in one click, and the line goes away. No box to tick, nothing that
 * holds the step.
 */
import '@/lib/i18n-test-locales';
import assert from 'node:assert/strict';
import test from 'node:test';
import { t } from '@/lib/i18n';
import { waitUntil } from '@/lib/test-wait';
import type { TelemetryPreferenceView } from '@/lib/telemetry-preference';

const ON: TelemetryPreferenceView = { enabled: true, source: 'default', malformed: false, editable: true, active: true };

async function mount(answer: TelemetryPreferenceView) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/onboarding?step=llm', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const requests: { method: string; url: string; body: unknown }[] = [];
  let reads = 0;
  install('fetch', (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') reads += 1;
    const body = method === 'PUT' ? { ...answer, enabled: false, source: 'settings' } : answer;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch);

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { TelemetryNotice } = await import('./telemetry-notice');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(TelemetryNotice)); });
  await waitUntil(React.act, () => reads > 0, 'the preference read');
  // One more turn for the answer to land.
  await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  return { React, root, requests };
}

test('while statistics are sent: one line, and "Turn them off" switches them off in one click', async () => {
  const { React, root, requests } = await mount(ON);
  const line = () => document.querySelector('[data-telemetry-notice]');
  assert.ok(line(), 'the line shows');
  assert.equal(line()!.querySelectorAll('input').length, 0, 'no box to tick');
  const button = line()!.querySelector<HTMLButtonElement>('[data-telemetry-turn-off]')!;
  assert.equal(button.textContent, t('onboarding.llm.telemetryTurnOff'));
  assert.doesNotMatch(line()!.textContent ?? '', /[{}]/);

  await React.act(async () => { button.click(); });
  await waitUntil(React.act, () => line() === null, 'the line going away once statistics are off');
  assert.deepEqual(requests.filter((r) => r.method === 'PUT'), [{ method: 'PUT', url: '/api/ui/telemetry/preference', body: { enabled: false } }]);
  await React.act(async () => { root.unmount(); });
});

test('nothing to say when nothing is sent, and no button when the switch is not the one that decides', async () => {
  for (const pref of [{ ...ON, enabled: false, source: 'settings' as const }, { ...ON, active: false }]) {
    const { React, root } = await mount(pref);
    assert.ok(!document.querySelector('[data-telemetry-notice]'), JSON.stringify(pref));
    await React.act(async () => { root.unmount(); });
  }
  const { React, root } = await mount({ ...ON, source: 'env', editable: false });
  assert.ok(document.querySelector('[data-telemetry-notice]'), 'statistics are still sent: say so');
  assert.ok(!document.querySelector('[data-telemetry-turn-off]'), 'the environment decides: no button that would be refused');
  await React.act(async () => { root.unmount(); });
});
