/**
 * The way out of step 3, mounted for real: what a tester stuck on a chat whose
 * tools are refused actually sees, and what the click sends.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SetupTrouble } from '@/components/onboarding/setup-trouble';

type Sent = { url: string; method: string; body: unknown };

async function mount() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/setup/agent', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle'] as const) {
    install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const sent: Sent[] = [];
  let answer: () => Response = () => Response.json({ status: 'complete' });
  install('fetch', async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    return answer();
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SetupEscape } = await import('./setup-escape');
  const { requestSkip } = await import('@/components/onboarding/setup-skip');
  const root = createRoot(document.getElementById('root')!);
  const calls = { skip: 0, restart: 0 };
  const render = async (trouble: SetupTrouble) => {
    await React.act(async () => {
      root.render(React.createElement(SetupEscape, {
        trouble, busy: false, error: null,
        onSkip: () => { calls.skip += 1; },
        onRestart: () => { calls.restart += 1; },
      }));
    });
  };
  const buttons = () => Array.from(document.querySelectorAll('button')).map((b) => b.textContent?.trim());
  const click = async (label: string) => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
    assert.ok(button, `no "${label}" button`);
    await React.act(async () => { button.click(); });
  };
  const unmount = async () => { await React.act(async () => { root.unmount(); }); };
  return { sent, calls, render, buttons, click, unmount, requestSkip, setAnswer: (fn: () => Response) => { answer = fn; } };
}

test('"Skip" is on screen while all goes well, and put forward after a refused tool', async () => {
  const ui = await mount();
  try {
    await ui.render({ level: 'quiet' });
    assert.deepEqual(ui.buttons(), ['Skip this step']);
    assert.equal(document.querySelector('[data-setup-escape]')?.getAttribute('data-setup-escape'), 'quiet');

    await ui.render({ level: 'prominent', reason: 'tool_error', canRestart: false });
    assert.equal(document.querySelector('[data-setup-escape]')?.getAttribute('data-setup-escape'), 'prominent');
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /cannot use Timon/);
    // A restart would meet the same refusal: not offered.
    assert.deepEqual(ui.buttons(), ['Skip this step']);
    await ui.click('Skip this step');
    assert.equal(ui.calls.skip, 1);
  } finally { await ui.unmount(); }
});

test('a finished mission offers to start the conversation over, beside "Skip"', async () => {
  const ui = await mount();
  try {
    await ui.render({ level: 'prominent', reason: 'ended', canRestart: true });
    assert.deepEqual(ui.buttons(), ['Skip this step', 'Restart the conversation']);
    await ui.click('Restart the conversation');
    assert.equal(ui.calls.restart, 1);
    assert.equal(ui.calls.skip, 0);
  } finally { await ui.unmount(); }
});

test('the skip call answers step 3, and only a step the daemon calls complete lets the wizard leave', async () => {
  const ui = await mount();
  try {
    assert.equal(await ui.requestSkip(), true);
    assert.deepEqual(ui.sent.at(-1), { url: '/api/ui/setup/main-agent', method: 'POST', body: { skip: true } });
    // A refusal used to navigate anyway, and the gate sent the person straight back.
    ui.setAnswer(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
    assert.equal(await ui.requestSkip(), false);
    ui.setAnswer(() => Response.json({ status: 'pending' }));
    assert.equal(await ui.requestSkip(), false);
    ui.setAnswer(() => { throw new TypeError('network down'); });
    assert.equal(await ui.requestSkip(), false);
  } finally { await ui.unmount(); }
});
