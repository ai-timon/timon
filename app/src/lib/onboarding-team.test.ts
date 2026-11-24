import assert from 'node:assert/strict';
import test from 'node:test';

test('team onboarding requires a choice, previews roles, and creates only on click', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/setup/team' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { default: TeamPage } = await import('../app/setup/team/page');
  const writes: unknown[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    assert.equal(input, '/api/ui/setup/team', 'onboarding never calls a mission endpoint');
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)));
      return Response.json({ status: 'complete', preset: 'team', configured: true, agents: [
        { name: 'assistant', reportsTo: null }, { name: 'researcher', reportsTo: null },
      ] });
    }
    return Response.json({ status: 'pending', preset: null, configured: true, agents: [] });
  });
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => { root.render(React.createElement(TeamPage)); });
    const submit = document.querySelector('button')!;
    assert.equal(submit.disabled, true);
    assert.equal(document.querySelectorAll('input[type="radio"]').length, 2);
    assert.equal(document.querySelectorAll('input:checked').length, 0);
    assert.deepEqual(writes, []);
    await React.act(async () => { (document.querySelector('input[value="team"]') as HTMLInputElement).click(); });
    assert.equal(submit.disabled, false);
    assert.equal(document.querySelectorAll('section li').length, 4);
    assert.match(document.querySelector('section')!.textContent!, /Personal Assistant/);
    assert.deepEqual(writes, []);
    await React.act(async () => { submit.click(); });
    assert.deepEqual(writes, [{ preset: 'team' }]);
    assert.match(document.querySelector('h1')!.textContent!, /Your team is ready/);
    // One exit, and it is step 5: the restart is mandatory, so no link into the
    // product is offered here any more.
    assert.ok(document.querySelector('a[href="/setup/restart"]'));
    assert.ok(!document.querySelector('a[href="/chat?agent=assistant"]'));
    assert.ok(!document.querySelector('a[href="/agents"]'));
    assert.equal(writes.length, 1);
  } finally {
    await React.act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
