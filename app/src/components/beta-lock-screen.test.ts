import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The locked beta screen calls only what the daemon's wall lets through, says
 * why in words a tester can act on, and never offers Free.
 */
async function withDom<T>(run: (env: { React: typeof import('react'); root: import('react-dom/client').Root; dom: import('jsdom').JSDOM; install: (key: string, value: unknown) => void }) => Promise<T>): Promise<T> {
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
    return await run({ React, root, dom, install });
  } finally {
    await React.act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

// What the wall leaves open for a browser, as the Next proxy names them.
const REACHABLE = new Set(['/api/ui/license', '/api/ui/license/activate', '/api/ui/export', '/api/ui/auth/logout', '/api/ui/auth/me', '/api/ui/updates']);
// The one read the screen makes on its own: the update offer.
const OFFER_READ = '/api/ui/updates';

function buttons(label: RegExp): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button')).filter((b) => label.test(b.textContent ?? ''));
}

test('an expired build names its end date, offers no key and no Free, and exports', async () => {
  await withDom(async ({ React, root, install }) => {
    const calls: string[] = [];
    install('fetch', async (input: string) => {
      assert.ok(REACHABLE.has(input), `the locked screen called ${input}, which the wall refuses`);
      if (input === OFFER_READ) return Response.json({ error: 'forbidden' }, { status: 403 });
      calls.push(input);
      return Response.json({ ok: true, out: '/home/t/.timon/timon-export-2026-10-01.tar.gz' });
    });
    const { BetaLockScreen } = await import('./beta-lock-screen');
    await React.act(async () => {
      root.render(React.createElement(BetaLockScreen, { lock: { kind: 'build_expired', buildExpiresAt: '2026-09-30T12:00:00.000Z' } }));
    });
    const text = document.body.textContent ?? '';
    assert.match(text, /This build has expired/);
    assert.match(text, /expired on .*2026.*install the latest version/i);
    assert.ok(!document.querySelector('textarea'), 'no key can revive a build that ended');
    assert.doesNotMatch(text, /\bfree\b/i);
    assert.equal(calls.length, 0, 'nothing but the update offer is fetched just by showing the screen');

    await React.act(async () => { buttons(/Export my data/)[0]!.click(); });
    assert.deepEqual(calls, ['/api/ui/export']);
    assert.match(document.body.textContent ?? '', /Archive saved: \/home\/t\/\.timon\/timon-export-2026-10-01\.tar\.gz/);
  });
});

test('an ended beta asks for a new key and posts it to the activation route', async () => {
  await withDom(async ({ React, root, install, dom }) => {
    const posted: Array<{ url: string; method?: string; body: unknown }> = [];
    let reloaded = false;
    install('fetch', async (input: string, init?: RequestInit) => {
      assert.ok(REACHABLE.has(input), `the locked screen called ${input}, which the wall refuses`);
      if (input === OFFER_READ) return Response.json({ error: 'forbidden' }, { status: 403 });
      posted.push({ url: input, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ status: 'valid' });
    });
    const { BetaLockScreen } = await import('./beta-lock-screen');
    await React.act(async () => { root.render(React.createElement(BetaLockScreen, { lock: { kind: 'beta_ended', buildExpiresAt: '2027-01-01T00:00:00.000Z' }, onActivated: () => { reloaded = true; } })); });
    assert.match(document.body.textContent ?? '', /The beta is over: enter a new key/);
    assert.doesNotMatch(document.body.textContent ?? '', /\bfree\b/i);
    const field = document.querySelector('textarea')!;
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(field, ' TMN-AAAA-BBBB-CCCC-DDDD ');
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await React.act(async () => { document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.deepEqual(posted, [{ url: '/api/ui/license/activate', method: 'POST', body: { key: 'TMN-AAAA-BBBB-CCCC-DDDD' } }]);
    assert.equal(reloaded, true, 'the event stream is walled: the page has to reload to see the new state');
  });
});

test('a refused key stays on the screen with its reason; a non-admin is told to ask one', async () => {
  await withDom(async ({ React, root, install, dom }) => {
    let status = 400;
    install('fetch', async () => Response.json(status === 403 ? { error: 'forbidden' } : { error: 'invalid license', reason: 'invalid:machine' }, { status }));
    const { BetaLockScreen } = await import('./beta-lock-screen');
    await React.act(async () => { root.render(React.createElement(BetaLockScreen, { lock: { kind: 'other', buildExpiresAt: null } })); });
    assert.match(document.body.textContent ?? '', /needs a valid licence/);
    const submit = async (value: string) => {
      const field = document.querySelector('textarea')!;
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      await React.act(async () => { document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
    };
    await submit('TMN-BAD');
    assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /invalid license/);
    status = 403;
    await submit('TMN-BAD');
    assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /Only an administrator can enter a key/);
  });
});

test('a remote machine\'s lock says whose licence it is and goes back to this computer through the app only', async () => {
  await withDom(async ({ React, root, install }) => {
    const posted: Array<{ url: string; body: unknown }> = [];
    install('fetch', async (input: string, init?: RequestInit) => {
      // The switch is answered by this app and the local daemon: the locked
      // remote is never asked anything but its update offer.
      if (input === OFFER_READ) return Response.json({ error: 'forbidden' }, { status: 403 });
      assert.equal(input, '/api/ui/machines/active');
      posted.push({ url: input, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ error: 'cross_origin' }, { status: 403 });
    });
    const { BetaLockScreen } = await import('./beta-lock-screen');
    await React.act(async () => {
      root.render(React.createElement(BetaLockScreen, { lock: { kind: 'beta_ended', buildExpiresAt: null }, machine: { name: 'VPS' } }));
    });
    assert.match(document.body.textContent ?? '', /This licence is the one of VPS, the machine this window drives/);
    await React.act(async () => { buttons(/Back to this computer/)[0]!.click(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.deepEqual(posted, [{ url: '/api/ui/machines/active', body: { id: 'local' } }]);
    // A refusal is shown, and the button can be pressed again.
    assert.ok(document.querySelector('[role="alert"]'));
    assert.equal(buttons(/Back to this computer/)[0]!.disabled, false);
  });
});

test('this computer\'s own lock offers no machine switch', async () => {
  await withDom(async ({ React, root }) => {
    const { BetaLockScreen } = await import('./beta-lock-screen');
    await React.act(async () => { root.render(React.createElement(BetaLockScreen, { lock: { kind: 'beta_ended', buildExpiresAt: null } })); });
    assert.equal(buttons(/Back to this computer/).length, 0);
  });
});

const LOCKED_OFFER = {
  installed: '0.1.6', channel: 'beta', enabled: true, state: 'available', checkedAt: '2026-10-01T00:00:00.000Z',
  available: {
    version: '0.1.8', publishedAt: '2026-10-01T00:00:00.000Z', notes: 'Faster boot.', notesUrl: 'https://docs.timon-ai.com/changelog',
    artifacts: [
      { key: 'linux-x64-appimage', os: 'linux', arch: 'x64', format: 'appimage', name: 'Timon.AppImage', url: 'https://github.com/acme/r/releases/download/v0.1.8/Timon.AppImage', size: 1 },
      { key: 'win-x64-nsis', os: 'win', arch: 'x64', format: 'nsis', name: 'Timon.Setup.exe', url: 'https://github.com/acme/r/releases/download/v0.1.8/Timon.Setup.exe', size: 1 },
    ],
  },
  host: { os: 'linux', arch: 'x64' },
  buildExpiresAt: '2026-09-30T12:00:00.000Z',
};

test('an expired build with a newer version published opens its installer, and Later cannot hide it', async () => {
  await withDom(async ({ React, root, install }) => {
    install('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Timon/0.1.6' });
    // "Later" pressed on this version in a page before the lock: the way out stays.
    window.localStorage.setItem('timon-update-later', '0.1.8');
    const calls: string[] = [];
    install('fetch', async (input: string) => {
      calls.push(input);
      assert.ok(REACHABLE.has(input), `the locked screen called ${input}, which the wall refuses`);
      return Response.json(LOCKED_OFFER);
    });
    const opened: string[] = [];
    window.open = ((url: string) => { opened.push(url); return null; }) as typeof window.open;
    const { BetaLockScreen } = await import('./beta-lock-screen');
    await React.act(async () => {
      root.render(React.createElement(BetaLockScreen, { lock: { kind: 'build_expired', buildExpiresAt: '2026-09-30T12:00:00.000Z' } }));
    });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.deepEqual(calls, [OFFER_READ], 'one read of the offer, no event stream');
    const offer = document.querySelector('[data-lock-update-offer]');
    assert.ok(offer, 'the offer is on the lock screen');
    assert.match(offer.textContent ?? '', /Timon 0\.1\.8 is available/);
    const actions = Array.from(offer.querySelectorAll('[data-update-action]'), (el) => el.getAttribute('data-update-action'));
    assert.deepEqual(actions, ['update'], 'one way out, and it cannot be put off');
    await React.act(async () => { buttons(/^Update$/)[0]!.click(); });
    assert.deepEqual(opened, ['https://github.com/acme/r/releases/download/v0.1.8/Timon.AppImage'], 'the installer of this system');
  });
});

test('in the desktop app the locked build downloads the newer version through the shell, nothing but a gesture sent', async () => {
  await withDom(async ({ React, root, install }) => {
    install('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Timon/0.1.6' });
    install('fetch', async (input: string) => {
      assert.ok(REACHABLE.has(input), `the locked screen called ${input}, which the wall refuses`);
      return Response.json(LOCKED_OFFER);
    });
    const shellCalls: unknown[][] = [];
    Object.assign(window, { timonDesktop: { restartAfterSetup: async () => undefined, updates: {
      state: async () => { shellCalls.push(['state']); return { phase: 'idle' }; },
      start: async (...args: unknown[]) => { shellCalls.push(['start', ...args]); return { phase: 'verifying', version: '0.1.8', name: 'Timon.AppImage', format: 'appimage', total: 1 }; },
      cancel: async () => ({ phase: 'idle' }),
      open: async () => ({ status: 'opened' }),
      onState: () => () => undefined,
    } } });
    const { BetaLockScreen } = await import('./beta-lock-screen');
    await React.act(async () => {
      root.render(React.createElement(BetaLockScreen, { lock: { kind: 'build_expired', buildExpiresAt: '2026-09-30T12:00:00.000Z' } }));
    });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const offer = document.querySelector('[data-lock-update-offer]');
    assert.ok(offer, 'the offer is on the lock screen');
    const start = offer.querySelector<HTMLButtonElement>('[data-update-action="update"]');
    assert.ok(start, 'the shell downloads it');
    await React.act(async () => { start.click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.deepEqual(shellCalls.filter(([name]) => name === 'start'), [['start']]);
    assert.match(offer.textContent ?? '', /Verifying the installer/);
  });
});

test('a locked build with no newer version shows nothing more', async () => {
  await withDom(async ({ React, root, install }) => {
    const calls: string[] = [];
    install('fetch', async (input: string) => {
      calls.push(input);
      return Response.json({ ...LOCKED_OFFER, state: 'up_to_date', available: null });
    });
    const { BetaLockScreen } = await import('./beta-lock-screen');
    await React.act(async () => {
      root.render(React.createElement(BetaLockScreen, { lock: { kind: 'build_expired', buildExpiresAt: '2026-09-30T12:00:00.000Z' } }));
    });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.deepEqual(calls, [OFFER_READ]);
    assert.ok(!document.querySelector('[data-lock-update-offer]'));
    assert.doesNotMatch(document.body.textContent ?? '', /is available/);
  });
});

test('a lock screen opened before the daemon\'s first check shows the offer once it lands, without a reload', async () => {
  await withDom(async ({ React, root, install }) => {
    install('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Timon/0.1.6' });
    const answers = [
      { ...LOCKED_OFFER, state: 'unchecked', available: null, checkedAt: null },
      { ...LOCKED_OFFER, state: 'failed', available: null },
      LOCKED_OFFER,
    ];
    const calls: string[] = [];
    install('fetch', async (input: string) => {
      calls.push(input);
      assert.equal(input, OFFER_READ);
      return Response.json(answers[Math.min(calls.length, answers.length) - 1]);
    });
    const { LockScreenUpdateOffer } = await import('./updates/update-notice');
    await React.act(async () => { root.render(React.createElement(LockScreenUpdateOffer, { retryMs: 20 })); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    assert.ok(!document.querySelector('[data-lock-update-offer]'), 'nothing checked yet: no offer');
    for (let i = 0; i < 50 && !document.querySelector('[data-lock-update-offer]'); i += 1) {
      await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    assert.match(document.querySelector('[data-lock-update-offer]')?.textContent ?? '', /Timon 0\.1\.8 is available/);
    assert.equal(calls.length, 3, 'unchecked, then failed, then the offer');
    // A settled state: no further read.
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    assert.equal(calls.length, 3);
  });
});

test('the lock screen stops reading once the check settles with nothing newer, and on unmount', async () => {
  await withDom(async ({ React, root, install }) => {
    let calls = 0;
    let state = 'unchecked';
    install('fetch', async () => { calls += 1; return Response.json({ ...LOCKED_OFFER, state, available: null }); });
    const { LockScreenUpdateOffer } = await import('./updates/update-notice');
    await React.act(async () => { root.render(React.createElement(LockScreenUpdateOffer, { retryMs: 20 })); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 70)); });
    assert.ok(calls >= 2, 'a pending status is read again');
    state = 'up_to_date';
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const settled = calls;
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    assert.equal(calls, settled, 'up to date: no further read');
    assert.ok(!document.querySelector('[data-lock-update-offer]'));

    // Unmounted while pending: the timer goes with it.
    state = 'unchecked';
    await React.act(async () => { root.render(React.createElement('div')); });
    await React.act(async () => { root.render(React.createElement(LockScreenUpdateOffer, { retryMs: 20 })); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await React.act(async () => { root.render(React.createElement('div')); });
    const atUnmount = calls;
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    assert.equal(calls, atUnmount, 'no read after unmount');
  });
});
