/**
 * TIM-0126 — a backend that arbitrates its own tool uses never reads the
 * agent's permission mode: the choice is frozen and says so, instead of
 * letting a user pick `plan` and believe the agent is read-only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

test('the mode is frozen with a warning only when the backend ignores it', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    const { PermissionModeField } = await import('./permission-mode-field');
    const picked: string[] = [];
    const render = (ignored: boolean) => React.act(async () => {
      root.render(React.createElement(PermissionModeField, { value: 'auto', onChange: (m: string) => picked.push(m), ignored }));
    });
    const plan = () => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'plan')!;

    await render(false);
    assert.ok(!document.querySelector('[data-permission-mode-ignored]'));
    await React.act(async () => { plan().click(); });
    assert.deepEqual(picked, ['plan']);

    await render(true);
    const note = document.querySelector('[data-permission-mode-ignored]');
    assert.ok(note, 'the warning is shown');
    assert.match(note.textContent ?? '', /opencode\.json/);
    assert.match(note.textContent ?? '', /ignored/);
    assert.ok(Array.from(document.querySelectorAll('button')).every((b) => b.disabled), 'every mode is disabled');
    await React.act(async () => { plan().click(); });
    assert.deepEqual(picked, ['plan'], 'a disabled mode cannot be picked');
    // The saved choice stays visible, so switching backend restores it.
    const checked = document.querySelector('[aria-checked="true"]');
    assert.equal(checked?.textContent, 'auto');

    // A backend that honours only some modes offers only those…
    const show = (value: string, supported: readonly string[] | null) => React.act(async () => {
      root.render(React.createElement(PermissionModeField, { value, onChange: (m: string) => picked.push(m), ignored: false, supported }));
    });
    const offered = () => Array.from(document.querySelectorAll('button')).map((b) => b.textContent);
    await show('auto', ['plan', 'bypassPermissions']);
    assert.deepEqual(offered(), ['plan', 'bypassPermissions']);
    // …and a stored mode outside them says what it runs as, with nothing checked.
    const runsAs = document.querySelector('[data-permission-mode-runs-as="plan"]');
    assert.ok(runsAs, 'the runs-as note is shown');
    assert.match(runsAs.textContent ?? '', /cannot run auto/);
    assert.match(runsAs.textContent ?? '', /read-only/);
    assert.ok(!document.querySelector('[aria-checked="true"]'), 'no mode is checked');
    await React.act(async () => { Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'bypassPermissions')!.click(); });
    assert.equal(picked.at(-1), 'bypassPermissions');
    await show('bypassPermissions', ['plan', 'bypassPermissions']);
    assert.ok(!document.querySelector('[data-permission-mode-runs-as]'), 'a supported mode needs no note');
    // No list (claude): every mode, no note.
    await show('auto', null);
    assert.deepEqual(offered(), ['auto', 'acceptEdits', 'plan', 'bypassPermissions']);
    assert.ok(!document.querySelector('[data-permission-mode-runs-as]'));
  } finally {
    await React.act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
