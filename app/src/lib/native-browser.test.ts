import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';
import { coverNativeViews, resetNativeViewCoversForTests } from './native-view-cover';
import { browserPanelBounds, browserPointer, browserRectOnSurface, nativeBrowserCommand, nativeBrowserRequest, shouldAutoClaim } from './native-browser';

test('native bounds round inward and clip the surface to the content window', () => {
  assert.deepEqual(browserPanelBounds({ left: 600.5, top: 263.5, width: 519.5, height: 474.5 }, { width: 1120, height: 738 }), { x: 601, y: 264, width: 519, height: 474 });
  assert.deepEqual(browserPanelBounds({ left: -1, top: 250, width: 521, height: 600 }, { width: 520, height: 738 }), { x: 0, y: 250, width: 520, height: 488 });
});

const ZOOMS = [0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.33, 1.5, 1.75, 2];

test('native bounds under the interface size are window DIPs: the CSS rectangle times the zoom, rounded inward', () => {
  assert.deepEqual(browserPanelBounds({ left: 600.5, top: 263.5, width: 519.5, height: 474.5 }, { width: 1120, height: 738 }, 1),
    browserPanelBounds({ left: 600.5, top: 263.5, width: 519.5, height: 474.5 }, { width: 1120, height: 738 }), 'zoom 1 is the old answer');
  // 1250×800 DIPs at 125 %: the page lays out 1000×640 CSS pixels.
  assert.deepEqual(browserPanelBounds({ left: 600, top: 40, width: 400, height: 600 }, { width: 1000, height: 640 }, 1.25), { x: 750, y: 50, width: 500, height: 750 });
  assert.deepEqual(browserPanelBounds({ left: 600.3, top: 40.1, width: 399.4, height: 599.6 }, { width: 1000, height: 640 }, 1.25), { x: 751, y: 51, width: 498, height: 748 });
  assert.deepEqual(browserPanelBounds({ left: 500, top: 0, width: 600, height: 700 }, { width: 1000, height: 640 }, 1.25), { x: 625, y: 0, width: 625, height: 800 }, 'clipped to the window');
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(browserPanelBounds({ left: 10, top: 10, width: 100, height: 100 }, { width: 500, height: 500 }, bad), { x: 10, y: 10, width: 100, height: 100 }, `zoom ${bad} reads as 100 %`);
  }
});

test('native bounds never pass the real content window, at any stop and any window size', () => {
  for (const zoom of ZOOMS) {
    for (let contentWidth = 400; contentWidth <= 3840; contentWidth += 1) {
      // The content window is a whole number of DIPs; the page measures it in CSS pixels, here the whole ones that fit in it.
      const innerWidth = Math.floor(contentWidth / zoom);
      const contentHeight = Math.round(contentWidth * 0.6);
      const innerHeight = Math.floor(contentHeight / zoom);
      for (const [left, width] of [[0, innerWidth], [innerWidth - 333.3, 333.3], [innerWidth * 0.5 + 0.7, innerWidth], [-12.5, 80.25]] as const) {
        const b = browserPanelBounds({ left, top: innerHeight * 0.1, width, height: innerHeight }, { width: innerWidth, height: innerHeight }, zoom);
        assert.ok(b.x >= 0 && b.y >= 0 && b.width >= 0 && b.height >= 0, `${zoom} @ ${contentWidth}: ${JSON.stringify(b)}`);
        assert.ok(b.x + b.width <= contentWidth, `${zoom} @ ${contentWidth}: ${JSON.stringify(b)} passes the width`);
        assert.ok(b.y + b.height <= contentHeight, `${zoom} @ ${contentWidth}: ${JSON.stringify(b)} passes the height`);
        // Inside the CSS surface too: rounded inward, never outward.
        assert.ok(b.x >= Math.max(0, left * zoom) - 1e-9 && b.x + b.width <= Math.max(b.x, (left + width) * zoom) + 1e-9);
      }
    }
  }
});

test('an open panel on a free running browser claims it by itself; a browser held by another device is left alone', () => {
  const open = { visible: true, hasProfile: true, running: true };
  assert.equal(shouldAutoClaim({ ...open, holder: null }), true);
  assert.equal(shouldAutoClaim({ ...open, holder: 'you' }), false);
  assert.equal(shouldAutoClaim({ ...open, holder: 'other' }), false, 'taking over from another device takes a click');
  assert.equal(shouldAutoClaim({ ...open, holder: null, visible: false }), false);
  assert.equal(shouldAutoClaim({ ...open, holder: null, running: false }), false);
});

test('pointer mapping excludes portrait letterboxing and preserves CSS viewport coordinates', () => {
  const box = { left: 40, top: 100, width: 390, height: 700 };
  assert.equal(browserPointer(100, 120, box, { width: 1366, height: 768 }), null);
  assert.deepEqual(browserPointer(235, 450, box, { width: 1366, height: 768 }), { x: 683, y: 384 });
  assert.deepEqual(browserPointer(235, 450, box, { width: 390, height: 700 }), { x: 195, y: 350 });
  assert.equal(browserPointer(430, 450, box, { width: 390, height: 700 }), null);
  assert.equal(browserPointer(235, 450, { ...box, height: 0 }, { width: 390, height: 700 }), null);
});

test('a page rectangle lands where the pointer mapping reads it back, clipped to the picture', () => {
  const box = { left: 40, top: 100, width: 390, height: 700 };
  const viewport = { width: 1366, height: 768 };
  const on = browserRectOnSurface({ x: 683, y: 384, width: 100, height: 50 }, box, viewport);
  assert.ok(on);
  assert.deepEqual(browserPointer(box.left + on.left + 0.01, box.top + on.top + 0.01, box, viewport), { x: 683, y: 384 });
  assert.ok(Math.abs(on.width - 100 * 390 / 1366) < 1e-9);
  assert.deepEqual(browserRectOnSurface({ x: -50, y: 0, width: 100, height: 10 }, { width: 1366, height: 768 }, viewport), { left: 0, top: 0, width: 50, height: 10 });
  assert.equal(browserRectOnSurface({ x: 2000, y: 0, width: 10, height: 10 }, box, viewport), null, 'off the picture');
  assert.equal(browserRectOnSurface({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 10 }, viewport), null);
});

test('native browser client stays same-origin, preserves selected profile, and surfaces access failures', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1 ? Response.json({ result: { running: true } }) : Response.json({ error: 'Profile access denied' }, { status: 403 });
  };
  try {
    assert.deepEqual(await nativeBrowserCommand('profile / private', 'status', { clientId: 'client' }), { running: true });
    assert.equal(calls[0]?.url, '/api/ui/native-browser/profile%20%2F%20private/command');
    assert.equal(calls[0]?.init?.credentials, 'same-origin');
    assert.equal(new Headers(calls[0]?.init?.headers).has('Authorization'), false);
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { clientId: 'client', action: 'status' });
    await assert.rejects(nativeBrowserRequest('profiles'), /Profile access denied/);
    assert.equal(calls.length, 2, 'an error never retries another browser or profile');
  } finally { globalThis.fetch = original; }
});

for (const mode of ['web', 'native', 'refused', 'declined', 'remote'] as const) test(`${mode}: browser claims control and keeps the selected profile when native presentation is unavailable`, async () => {
  const electron = mode === 'native';
  const desktop = mode !== 'web';
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat?agent=orphan', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('ResizeObserver', class { constructor(private callback: () => void) {} observe() { this.callback(); } disconnect() {} });
  if (mode === 'remote') dom.window.document.documentElement.setAttribute('data-timon-machine', 'vps');
  dom.window.innerWidth = 390;
  dom.window.innerHeight = 1000;
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as Window['matchMedia'];
  let surfaceTop = 200;
  let surfaceHeight = 700;
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: surfaceTop, left: 0, top: surfaceTop, width: 390, height: surfaceHeight, right: 390, bottom: surfaceTop + surfaceHeight, toJSON() {} });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('../components/workspace-layout-provider');
  const { NativeBrowserView, useNativeBrowserCapability } = await import('../components/native-browser-panel');
  // What the browser island paints, with the island's own state held here: the
  // mission follows the chat's context event, the display is a param.
  function Harness() {
    const [mission, setMission] = React.useState<string | null>(null);
    const [display, setDisplay] = React.useState<'auto' | 'desktop' | 'mobile'>('auto');
    const capability = useNativeBrowserCapability();
    React.useEffect(() => {
      const onContext = (event: Event) => setMission((event as CustomEvent<{ missionId: string | null }>).detail.missionId);
      window.addEventListener('timon:browser-context', onContext);
      return () => window.removeEventListener('timon:browser-context', onContext);
    }, []);
    return React.createElement('div', { 'data-dock-mode': 'floating' }, React.createElement(NativeBrowserView, {
      agent: 'orphan', mission, visible: true, available: capability.available, capabilityError: capability.error,
      retryCapability: capability.retry, display, onDisplay: setDisplay, placement: 0,
    }));
  }
  const original = globalThis.fetch;
  const commands: Record<string, unknown>[] = [];
  const attachments: unknown[] = [];
  let engineViewport = { width: 390, height: 700, mobile: false };
  let pauseResize = electron;
  let resumeResize: () => void = () => {};
  let detachments = 0;
  let attachmentAttempts = 0;
  if (desktop) window.timonDesktop = { restartAfterSetup: async () => {}, browser: {
    attach: async (input) => {
      attachmentAttempts++;
      if (mode === 'remote') throw new Error('A remote page must never attach a local tab');
      if (mode === 'refused') throw new Error('The built-in browser shows in the first Timon window only.');
      if (mode === 'declined') return { attached: false };
      assert.equal(input.viewToken, 'presentation-ticket');
      assert.equal(input.bounds.width, engineViewport.width);
      assert.equal(input.bounds.height, engineViewport.height, 'attachment must use the latest completed viewport');
      assert.ok(input.bounds.y + input.bounds.height <= window.innerHeight);
      attachments.push(input);
    },
    detach: async () => { detachments++; },
  } };
  const requests: string[] = [];
  const profile = { id: 'limited-profile', name: 'Only CRM', scope_kind: 'custom', scope_ref: null };
  let controls = false;
  let showPrompt = false;
  let dialog: { id: string; tabId: string; type: string; message: string; url: string } | null = null;
  let providerAvailable = false;
  let layout = { open: true, display: 'auto', width: 520 };
  const state = () => ({ profileId: profile.id, running: true, tabs: [{ id: 'tab-1', url: 'https://crm.example', title: 'CRM' }], activeTabId: 'tab-1', ...engineViewport, dialog, control: { holder: controls ? 'you' : 'other', kind: 'human' } });
  globalThis.fetch = async (input, init) => {
    const url = String(input); requests.push(url);
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'owner' } });
    if (url === '/api/ui/agents/orphan') return Response.json({ agent: { project: null } });
    if (url.startsWith('/api/ui/layout?')) { if (init?.method === 'PUT') layout = JSON.parse(String(init.body)).layout; return Response.json({ layout }); }
    assert.ok(url.startsWith('/api/ui/native-browser/'), `unexpected backend: ${url}`);
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    if (url.endsWith('/capabilities')) return Response.json({ available: providerAvailable });
    if (url.endsWith('/profiles')) return Response.json({ profiles: [profile] });
    if (url.includes('/resolve?')) { const params = new URL(url, 'http://localhost').searchParams; assert.equal(params.get('agent'), 'orphan'); return Response.json({ profile: params.get('mission') === 'disabled-mission' ? null : profile }); }
    assert.ok(url.endsWith('/limited-profile/command'));
    const body = JSON.parse(String(init?.body)); commands.push(body);
    assert.match(body.clientId, /^[\da-f-]{36}$/i);
    if (body.action === 'claimControl') { controls = true; return Response.json({ result: { control: state().control } }); }
    if (body.action === 'releaseControl') { controls = false; return Response.json({ result: { control: state().control } }); }
    if (body.action === 'presentation') return Response.json({ result: { viewToken: 'presentation-ticket' } });
    if (body.action === 'mediaOffer') return Response.json({ result: { mediaId: crypto.randomUUID(), answer: { type: 'answer', sdp: 'v=0' } } });
    if (body.action === 'newTab' && showPrompt) dialog = { id: 'prompt', tabId: 'tab-1', type: 'prompt', message: 'Name?', url: 'https://crm.example' };
    if (body.action === 'dialogRespond') dialog = null;
    if (body.action === 'resize') {
      if (pauseResize) { pauseResize = false; await new Promise<void>((resolve) => { resumeResize = resolve; }); }
      engineViewport = { width: body.width, height: body.height, mobile: body.mobile };
    }
    if (body.action === 'screenshot') return Response.json({ result: { data: 'AAAA', mimeType: 'image/jpeg', width: 390, height: 700 } });
    if (body.action === 'reload') return Response.json({ error: 'Native browser unavailable' }, { status: 503 });
    return Response.json({ result: state() });
  };
  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  // Every gesture waits for what it should produce; a gesture that must
  // produce nothing (local audio, a second toggle) only lets one turn pass.
  const click = async (label: string, done: () => boolean = () => true, what = `"${label}" to take effect`) => {
    const find = () => Array.from(document.querySelectorAll('button')).find((node) => node.getAttribute('aria-label') === label || node.textContent === label);
    if (!find()) {
      const options = document.querySelector<HTMLButtonElement>('button[aria-label="Browser options and profile"]');
      assert.ok(options); await React.act(async () => options.click());
      await until(() => !!find(), `"${label}" in the options menu`);
    }
    const button = find();
    assert.ok(button, label); await React.act(async () => button.click());
    await until(done, what);
  };
  const alert = () => document.querySelector('[role="alert"]')?.textContent ?? '';
  const sent = (action: string, from = 0) => commands.slice(from).some((call) => call.action === action);
  try {
    await React.act(async () => root.render(React.createElement(PathnameContext.Provider, { value: '/chat' }, React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams('agent=orphan') }, React.createElement(WorkspaceLayoutProvider, { children: React.createElement(Harness) })))));
    await until(() => /native browser is unavailable/.test(alert()), 'the unavailable provider to be reported');
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /native browser is unavailable/);
    assert.equal(commands.length, 0, 'an unavailable native provider cannot launch a legacy profile');
    providerAvailable = true;
    await click('Retry', () => /does not support live video playback/.test(alert()), 'the session to start and its video to fail');
    assert.equal(commands.some((call) => call.action === 'screenshot'), false, 'video failure never silently selects JPEG');
    await click('Use screenshots', () => !!document.querySelector('img[src^="data:image/jpeg"]'), 'a screenshot to be shown');
    assert.ok(document.querySelector('img[src^="data:image/jpeg"]'));
    assert.equal(commands.some((call) => call.action === 'resize' || call.action === 'input'), false, 'viewing never takes control or changes viewport');
    install('RTCPeerConnection', class extends dom.window.EventTarget {
      iceGatheringState = 'complete'; connectionState = 'new'; localDescription = { toJSON: () => ({ type: 'offer', sdp: 'v=0' }) };
      ontrack: ((event: { track: object }) => void) | null = null;
      addTransceiver() {} async createOffer() { return {}; } async setLocalDescription() {}
      async setRemoteDescription() { this.connectionState = 'connected'; this.ontrack?.({ track: {} }); }
      close() { this.connectionState = 'closed'; } async getStats() { return new Map(); }
    });
    install('MediaStream', class { addTrack() {} });
    dom.window.HTMLMediaElement.prototype.play = async () => {};
    await click('Reconnect video', () => sent('mediaOffer'), 'the video to be offered');
    assert.ok(commands.some((call) => call.action === 'mediaOffer'), 'the test starts a real mocked video transport before opening a prompt');
    await click('Browser audio');
    assert.equal(commands.some((call) => call.action === 'audio'), false, 'spectator audio changes only the local player');
    await click('Browser audio');
    assert.equal(commands.some((call) => call.action === 'claimControl'), false, 'another device holds the browser: viewing never takes it');
    // No "take control" button: a click in the panel takes the browser over from the other device.
    assert.equal(Array.from(document.querySelectorAll('button')).some((node) => /control/i.test(node.getAttribute('aria-label') ?? '')), false);
    await React.act(async () => { document.querySelector('[data-browser-chrome="controls"]')!.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })); });
    await until(() => sent('claimControl') && sent('resize'), 'a click in the panel to claim the browser and size it');
    if (electron) {
      surfaceTop = 220; surfaceHeight = 680;
      await React.act(async () => window.dispatchEvent(new Event('resize')));
      // Nothing may leave while the first resize is held: one turn shows it.
      await until(() => true, 'the window resize to be handled');
      assert.equal(commands.filter((call) => call.action === 'resize').length, 1, 'a pending resize serializes later dimensions');
      assert.equal(attachments.length, 0, 'an old measurement cannot attach while its resize is pending');
      await React.act(async () => resumeResize());
      await until(() => engineViewport.height === 680 && attachments.length > 0, 'the held resize to finish and the view to attach');
      assert.equal(engineViewport.height, 680);
      assert.equal((attachments[0] as { bounds: { height: number } }).bounds.height, 680, 'only the freshly measured surface attaches');
      // The desktop's annotation bubble posts to the conversation the panel is open for (TODO #481).
      const presented = attachments[0] as { conversation?: unknown; locale?: unknown; scheme?: unknown };
      assert.deepEqual(presented.conversation, { agent: 'orphan', mission: null });
      assert.equal(presented.locale, 'en');
      assert.ok(presented.scheme === 'light' || presented.scheme === 'dark');
    }
    if (mode === 'refused' || mode === 'declined') {
      await until(() => commands.some((call) => call.action === 'resize' && call.mobile === true), 'native refusal to select the remote surface');
      assert.equal(attachmentAttempts, 1, 'a refused presentation does not loop');
      assert.doesNotMatch(alert(), /first Timon window/);
    }
    if (mode === 'remote') assert.equal(attachmentAttempts, 0, 'remote tickets never reach the local engine');
    assert.ok(commands.some((call) => call.action === 'resize' && call.mobile === !electron && call.width === 390), 'narrow PWA auto uses mobile emulation; Electron auto keeps its normal user agent');
    assert.equal(attachments.length > 0, electron, 'only Electron attaches a native view after claiming control');
    assert.equal(commands.some((call) => call.action === 'audio'), false, 'opening a view does not mute another user’s host audio');
    showPrompt = true;
    const beforePrompt = commands.length;
    const beforeDetach = detachments;
    await click('New tab', () => !!document.querySelector('[data-dock-mode] [role="dialog"]'), 'the page prompt to show');
    assert.ok(document.querySelector('[data-dock-mode] [role="dialog"]'));
    surfaceTop += 20; surfaceHeight -= 20;
    await React.act(async () => window.dispatchEvent(new Event('resize')));
    await until(() => (electron ? detachments > beforeDetach : sent('mediaStop', beforePrompt)), 'the view to step aside for the prompt');
    assert.equal(commands.slice(beforePrompt).some((call) => ['resize', 'mediaOffer', 'mediaStart', 'screenshot'].includes(String(call.action))), false, 'a modal never resizes or starts capture against the blocked renderer');
    if (electron) assert.ok(detachments > beforeDetach, 'the native view detaches so the prompt can be answered');
    else assert.ok(commands.slice(beforePrompt).some((call) => call.action === 'mediaStop'), 'an existing remote stream stops for the prompt');
    const beforeAnswer = commands.length;
    const attachedBeforeAnswer = attachments.length;
    await click('OK', () => !document.querySelector('[data-dock-mode] [role="dialog"]') && sent('resize', beforeAnswer) && (electron || sent('mediaOffer', beforeAnswer)), 'the answered prompt to resume the view');
    assert.ok(!document.querySelector('[data-dock-mode] [role="dialog"]'));
    assert.ok(commands.slice(beforeAnswer).some((call) => call.action === 'resize'), 'viewport synchronization resumes after answering');
    if (!electron) assert.ok(commands.slice(beforeAnswer).some((call) => call.action === 'mediaOffer'), 'remote video resumes after answering');
    // A dialog or a menu of the app opened above the browser (TIM-0130): the
    // native view is painted above the DOM, so it steps aside until it closes.
    if (electron) await until(() => attachments.length > attachedBeforeAnswer, 'the view to attach again after the prompt');
    const beforeCover = { commands: commands.length, detachments, attachments: attachments.length };
    let uncover: () => void = () => {};
    await React.act(async () => { uncover = coverNativeViews(); });
    if (electron) {
      await until(() => detachments > beforeCover.detachments, 'the native view to step aside for the app dialog');
      assert.ok(!sent('resize', beforeCover.commands), 'a covered view is never resized under the dialog');
      await React.act(async () => uncover());
      await until(() => attachments.length > beforeCover.attachments, 'the native view to come back once the dialog closes');
    } else {
      await until(() => true, 'the cover to be seen');
      assert.equal(detachments, beforeCover.detachments);
      assert.ok(!sent('mediaStop', beforeCover.commands), 'on the web the stream is DOM, which the dialog covers: the video keeps playing');
      await React.act(async () => uncover());
    }
    await click('Browser audio', () => !electron || commands.some((call) => call.action === 'audio' && call.muted === false), 'the native overlay to enable host audio');
    assert.equal(commands.some((call) => call.action === 'audio' && call.muted === false), electron, 'only the native overlay enables host audio');
    await click('Mobile view', () => commands.some((call) => call.action === 'resize' && call.mobile === true && call.width === 390), 'the mobile viewport');
    assert.ok(commands.some((call) => call.action === 'resize' && call.mobile === true && call.width === 390));
    await click('Desktop view (1366 × 768)', () => commands.some((call) => call.action === 'resize' && call.width === 1366)
      && (!electron || commands.some((call) => call.action === 'audio' && call.muted === true)), 'the desktop viewport');
    assert.ok(commands.some((call) => call.action === 'resize' && call.mobile === false && call.width === 1366 && call.height === 768));
    assert.equal(detachments > 0, desktop && mode !== 'remote', 'a contained desktop uses the authenticated stream and detaches the native overlay');
    assert.equal(commands.some((call) => call.action === 'audio' && call.muted === true), electron, 'leaving native playback mutes only host audio this panel enabled');
    const audioCalls = commands.filter((call) => call.action === 'audio').length;
    await click('Browser audio');
    await click('Browser audio');
    assert.equal(commands.filter((call) => call.action === 'audio').length, audioCalls, 'remote control does not change host audio');
    await click('Reload page', () => /Native browser unavailable/.test(alert()), 'the reload failure to be shown');
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Native browser unavailable/);
    assert.equal(requests.some((url) => url.startsWith('/api/ui/browser') || url.startsWith('/browser/')), false);
    await React.act(async () => window.dispatchEvent(new CustomEvent('timon:browser-context', { detail: { agent: 'orphan', missionId: 'disabled-mission' } })));
    await until(() => sent('releaseControl') && requests.some((url) => url.includes('mission=disabled-mission'))
      && !document.querySelector('img[src^="data:image/jpeg"]'), 'the panel to leave its browser for the mission\'s');
    assert.ok(commands.some((call) => call.action === 'releaseControl'), 'control is released by itself when the panel leaves its browser');
    assert.ok(requests.some((url) => url.includes('mission=disabled-mission')));
    assert.ok(!document.querySelector('img[src^="data:image/jpeg"]'), 'the previous profile image disappears as the mission changes');
    await click('Browser options and profile', () => !!document.querySelector('select[aria-label="Browser profile"]'), 'the profile menu');
    assert.equal((document.querySelector('select[aria-label="Browser profile"]') as HTMLSelectElement).disabled, true, 'a mission binding cannot silently edit the agent defaults');
    assert.match(document.querySelector('[data-dock-mode]')!.textContent!, /This mission keeps its selected profile/);
  } finally {
    resumeResize();
    resetNativeViewCoversForTests();
    await React.act(async () => root.unmount());
    globalThis.fetch = original;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  }
});
