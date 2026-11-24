/**
 * "Choose your LLM" (docs/ONBOARDING-LLM.md): the header stays, only the
 * block under it changes; the subscription block shows the providers list's
 * own rows and opens "Continue" on the same rule as `/setup/agent`;
 * the local block shows Ollama; "Back" first returns to the two choices.
 * And the pure parts: what "Back" does, what the status line says, how the
 * legal sentence is cut around its links.
 */
import '@/lib/i18n-test-locales';
import assert from 'node:assert/strict';
import test from 'node:test';
import { getLocale, setLocale, t } from '@/lib/i18n';
import type { InstallJob, ProviderCli } from '@/lib/provider-clis';
import { waitUntil } from '@/lib/test-wait';
import { formatList } from '@/lib/intl';
import { LEGAL_LINKS, llmBack, llmOutcome, planStatus, readyNames, splitAtSlots, subscriptionProviders } from './llm-choice';

function cli(name: string, over: Partial<ProviderCli> = {}): ProviderCli {
  return {
    name, label: name, brand: null, path: null, bundled: false, signedIn: null, installable: true,
    installCommand: `curl -fsSL https://${name}.invalid/install | bash`, installDocs: null, signInCommand: `${name} login`,
    signInThen: null, seedsMainAgent: true, version: null, latest: null, updateAvailable: false, unsupportedVersion: false, ...over,
  };
}

test('"Back" leaves a block for the two choices, then the step', () => {
  assert.equal(llmBack('plan'), 'choose');
  assert.equal(llmBack('local'), 'choose');
  assert.equal(llmBack('choose'), null);
});

test('the status line and "Continue" follow the provider list', () => {
  assert.deepEqual(planStatus(undefined), { canContinue: false, anyway: false, line: null }, 'still looking: nothing to say yet');
  assert.deepEqual(planStatus(null), { canContinue: true, anyway: false, line: null }, 'a refused list does not hold the onboarding');
  const none = planStatus([cli('claude'), cli('codex', { path: '/bin/codex', signedIn: false })]);
  assert.deepEqual(none, { canContinue: false, anyway: true, line: { kind: 'none' } });
  const ready = planStatus([
    cli('claude', { label: 'Claude Code', path: '/bin/claude', signedIn: true }),
    cli('codex', { label: 'Codex', path: '/bin/codex', signedIn: false }),
  ]);
  assert.deepEqual(ready, { canContinue: true, anyway: false, line: { kind: 'ready', names: ['Claude Code'] } }, '"Continue anyway" goes once an AI is there');
});

test('the funnel hears the choice, the CLI the chat would start on, or why there is none', () => {
  assert.deepEqual(llmOutcome('local', undefined), { llmChoice: 'local', connection: 'unknown' });
  assert.deepEqual(llmOutcome('plan', null), { llmChoice: 'plan', connection: 'failed', failureCode: 'unreachable' });
  assert.deepEqual(llmOutcome('plan', [
    cli('codex', { path: '/bin/codex', signedIn: null }),
    cli('claude', { path: '/bin/claude', signedIn: true }),
  ]), { llmChoice: 'plan', connection: 'ok', backend: 'claude' }, 'a signed-in CLI first');
  assert.deepEqual(llmOutcome('plan', [cli('claude'), cli('codex', { path: '/bin/codex', signedIn: false })]),
    { llmChoice: 'plan', connection: 'failed', failureCode: 'signed_out', backend: 'codex' });
  assert.deepEqual(llmOutcome('plan', [cli('claude'), cli('codex')]),
    { llmChoice: 'plan', connection: 'failed', failureCode: 'not_installed' });
  // A name outside the shape the daemon accepts is left out, so the event is not refused whole.
  assert.deepEqual(llmOutcome('plan', [cli('My CLI', { path: '/opt/x', signedIn: true })]), { llmChoice: 'plan', connection: 'ok' });
  for (const detail of [llmOutcome('plan', [cli('claude', { path: '/home/someone/.local/bin/claude', signedIn: true })])]) {
    assert.equal(JSON.stringify(detail).includes('/'), false, 'never a path');
  }
});

test('"Ready with …" names only what "Continue" counts, signed-in ones first', () => {
  assert.deepEqual(readyNames([
    cli('grok', { label: 'Grok', path: '/bin/grok', signedIn: null }),
    cli('claude', { label: 'Claude Code', path: '/bin/claude', signedIn: true }),
    cli('helper', { label: 'Helper', path: '/bin/helper', signedIn: true, seedsMainAgent: false }),
    cli('codex', { label: 'Codex', path: null }),
  ]), ['Claude Code', 'Grok']);
});

test('the subscription choice names the CLIs the daemon declares, never a provider Timon has no CLI for', () => {
  const list = [
    cli('claude', { label: 'Claude Code', brand: 'claude' }),
    cli('codex', { label: 'Codex', brand: 'openai' }),
    cli('opencode', { label: 'opencode', brand: 'opencode', seedsMainAgent: false }),
    cli('grok', { label: 'Grok Build', brand: 'xai' }),
    cli('codex-app', { label: 'Codex app', brand: 'openai' }),
  ];
  assert.deepEqual(subscriptionProviders(list), {
    names: ['Claude Code', 'Codex', 'Grok Build', 'Codex app'],
    brands: ['claude', 'openai', 'xai'],
  }, 'what the chat can start on, in the daemon\'s order, each brand once');
  assert.deepEqual(subscriptionProviders([]), { names: [], brands: [] });
});

test('lists are joined the way the language joins them', () => {
  assert.equal(formatList(['Claude Code', 'Codex', 'Grok Build'], 'or', 'en'), 'Claude Code, Codex, or Grok Build');
  assert.equal(formatList(['Claude Code', 'Codex', 'Grok Build'], 'or', 'fr'), 'Claude Code, Codex ou Grok Build');
  assert.equal(formatList(['Claude Code', 'Codex'], 'and', 'fr'), 'Claude Code et Codex');
  assert.equal(formatList(['Codex'], 'and', 'en'), 'Codex');
});

test('the legal sentence is cut around its two links, in every language', () => {
  const before = getLocale();
  try {
    for (const tag of ['en', 'fr']) {
      setLocale(tag);
      const parts = splitAtSlots((vars) => t('onboarding.llm.legal', vars), ['terms', 'privacy']);
      assert.deepEqual(parts.filter((p) => p.kind === 'slot').map((p) => (p.kind === 'slot' ? p.name : '')), ['terms', 'privacy'], tag);
      assert.ok(parts.every((p) => p.kind === 'slot' || !p.text.includes('\u0000')), tag);
    }
  } finally {
    setLocale(before);
  }
  assert.match(LEGAL_LINKS.terms, /^https:\/\//);
  assert.match(LEGAL_LINKS.privacy, /^https:\/\//);
});

type Server = { list: ProviderCli[]; requests: number; job: InstallJob | null };

async function mountStep(server: Server, run: (ui: {
  click: (el: Element | null | undefined) => Promise<void>;
  until: (condition: () => boolean, what: string) => Promise<void>;
  $: (selector: string) => Element | null;
  text: () => string;
  steps: string[];
}) => Promise<void>): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/onboarding?step=llm', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event', 'CustomEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  // The header's mascots are live: their shared frame runs on the window's clock.
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string, init?: { method?: string }) => {
    const url = String(input);
    if (url === '/api/ui/plugins') return Response.json({ plugins: [] });
    if (url === '/api/ui/backends/provider-clis') {
      server.requests += 1;
      return Response.json({ backends: server.list, jobs: {}, updateCheck: true });
    }
    const match = /^\/api\/ui\/backends\/provider-clis\/([^/]+)\/install$/.exec(url);
    if (match && init?.method === 'POST') {
      server.job = { name: match[1]!, command: 'install', state: 'running', startedAt: 1, finishedAt: null, lines: ['downloading'], dropped: 0, result: null };
      return Response.json({ job: server.job }, { status: 202 });
    }
    if (match) return Response.json({ job: server.job });
    return new Response(null, { status: 404 });
  });
  const React = await import('react');
  install('React', React);
  const before = getLocale();
  setLocale('en');
  const { createRoot } = await import('react-dom/client');
  const { OnboardingShell } = await import('./onboarding-shell');
  const { useOnboarding } = await import('./onboarding-context');
  const { LlmStep } = await import('./steps/llm');
  const h = React.createElement;
  const steps: string[] = [];
  const plain = (id: string) => function Plain() {
    const { step } = useOnboarding();
    React.useEffect(() => { steps.push(step); }, [step]);
    return h('section', { 'data-step': id });
  };
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  try {
    await React.act(async () => {
      root.render(h(OnboardingShell, {
        steps: [
          { id: 'splash', Component: plain('splash') },
          { id: 'account', Component: plain('account') },
          { id: 'llm', Component: LlmStep },
          { id: 'profile', Component: plain('profile') },
          { id: 'agent', Component: plain('agent') },
        ],
        companions: [],
      }));
    });
    await run({
      click: async (el) => {
        assert.ok(el, 'element to click');
        await React.act(async () => { (el as HTMLElement).click(); });
      },
      until: (condition, what) => waitUntil(React.act, condition, what),
      $: (selector) => host.querySelector(selector),
      text: () => host.textContent ?? '',
      steps,
    });
  } finally {
    await React.act(async () => { root.unmount(); });
    setLocale(before);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

const backButton = (): Element | null =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === t('onboarding.back')) ?? null;

test('the two choices, the legal links and no statistics box under a fixed header', async () => {
  const list = [cli('claude', { label: 'Claude Code', brand: 'claude' }), cli('codex', { label: 'Codex', brand: 'openai' })];
  await mountStep({ list, requests: 0, job: null }, async (ui) => {
    await ui.until(() => ui.$('[data-choice="plan"]')?.textContent?.includes('Claude Code or Codex') === true, 'the names read from the daemon');
    assert.notEqual(ui.$('[data-choice="plan"]')?.querySelectorAll('svg, img').length ?? 0, 0, 'their marks');
    assert.equal(ui.text().includes('Gemini'), false);
    assert.ok(ui.$('[data-llm-step] h1')?.textContent?.includes('LLM'), 'the title');
    assert.ok(ui.text().includes(t('onboarding.llm.subtitle')));
    assert.equal(ui.$('[data-view]')?.getAttribute('data-view'), 'choose');
    assert.ok(ui.$('[data-choice="plan"]') && ui.$('[data-choice="local"]'));
    const links = Array.from(ui.$('[data-legal]')?.querySelectorAll('a') ?? []).map((a) => [a.textContent, a.getAttribute('href')]);
    assert.deepEqual(links, [[t('onboarding.llm.terms'), LEGAL_LINKS.terms], [t('onboarding.llm.privacy'), LEGAL_LINKS.privacy]]);
    assert.equal(ui.$('input[type="checkbox"]'), null, 'no statistics box: sharing is turned off in the settings');
    assert.equal(ui.$('[role="checkbox"]'), null);
  });
});

test('the subscription: rows, "Continue anyway" until an AI is ready, then "Ready with …"', async () => {
  const server: Server = {
    list: [
      cli('claude', { label: 'Claude Code', path: '/bin/claude', signedIn: false }),
      cli('codex', { label: 'Codex' }),
    ],
    requests: 0,
    job: null,
  };
  await mountStep(server, async (ui) => {
    await ui.click(ui.$('[data-choice="plan"]'));
    await ui.until(() => ui.$('section[aria-label="Codex"]') !== null, 'the provider rows');
    const header = ui.$('[data-llm-step] h1');
    assert.ok(header, 'the header stays on screen');
    assert.equal(ui.$('[data-view]')?.getAttribute('data-view'), 'plan');
    assert.equal(ui.$('section[aria-label="Claude Code"]')?.getAttribute('data-state'), 'signIn');
    assert.equal(ui.$('section[aria-label="Codex"]')?.getAttribute('data-state'), 'missing');
    assert.ok(ui.$('section[aria-label="Claude Code"] button')?.textContent?.includes(t('providerClis.signIn')));
    assert.equal(ui.$('section[aria-label="Codex"] button')?.textContent, t('providerClis.rows.installAndSignIn'));
    // The providers list's own row: one status line, no path, no version.
    assert.ok(ui.$('section[aria-label="Claude Code"] [data-provider-row]'), 'the shared provider row');
    assert.equal(ui.$('section[aria-label="Claude Code"] [data-provider-status]')?.getAttribute('data-provider-status'), 'not-connected');
    assert.equal(ui.$('section[aria-label="Codex"] [data-provider-status]')?.getAttribute('data-provider-status'), 'not-installed');
    assert.equal(ui.text().includes('/bin/claude'), false, 'no path on the onboarding');
    assert.equal((ui.$('[data-continue]') as HTMLButtonElement | null)?.disabled, true);
    assert.ok(ui.$('[data-anyway]'), '"Continue anyway" while no AI is connected');
    assert.ok(ui.text().includes(t('onboarding.llm.plan.none')));

    // One click starts the vendor's installer from its row.
    await ui.click(ui.$('section[aria-label="Codex"] button'));
    await ui.until(() => ui.$('section[aria-label="Codex"]')?.getAttribute('data-state') === 'installing', 'the install running');

    // Claude signed in elsewhere; "Try again" reads the list again.
    server.list = [cli('claude', { label: 'Claude Code', path: '/bin/claude', signedIn: true }), cli('codex', { label: 'Codex' })];
    const retry = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(t('providerClis.retry')));
    await ui.click(retry);
    await ui.until(() => ui.$('section[aria-label="Claude Code"]')?.getAttribute('data-state') === 'ready', 'Claude connected');
    assert.equal(ui.$('section[aria-label="Claude Code"] [data-provider-status]')?.getAttribute('data-provider-status'), 'connected');
    assert.ok(!ui.$('section[aria-label="Claude Code"] button'), 'nothing left to do on a connected row');
    assert.equal(ui.$('[data-plan-status]')?.getAttribute('data-plan-status'), 'ready');
    assert.ok(ui.text().includes(t('onboarding.llm.plan.ready', { names: 'Claude Code' })));
    assert.equal(ui.$('[data-anyway]'), null, '"Continue anyway" is gone once an AI is connected');
    assert.equal((ui.$('[data-continue]') as HTMLButtonElement | null)?.disabled, false);

    await ui.click(ui.$('[data-continue]'));
    await ui.until(() => ui.$('[data-step="profile"]') !== null, 'the next step');
  });
});

test('"Back" returns to the two choices on the same screen before leaving the step', async () => {
  await mountStep({ list: [], requests: 0, job: null }, async (ui) => {
    await ui.click(ui.$('[data-choice="local"]'));
    assert.equal(ui.$('[data-view]')?.getAttribute('data-view'), 'local');
    assert.ok(ui.$('[data-ollama]'), 'the Ollama block');
    assert.ok(ui.$('[data-ollama] a[href^="https://"]'), 'its install link');
    await ui.click(backButton());
    assert.equal(ui.$('[data-view]')?.getAttribute('data-view'), 'choose', 'back to the two choices');
    assert.ok(ui.$('[data-llm-step]'), 'still on this step');
    await ui.click(backButton());
    await ui.until(() => ui.$('[data-step="account"]') !== null, 'the previous step');
  });
});

test('the local block moves on without any subscription', async () => {
  const server: Server = { list: [], requests: 0, job: null };
  await mountStep(server, async (ui) => {
    await ui.click(ui.$('[data-choice="local"]'));
    await ui.click(ui.$('[data-continue]'));
    await ui.until(() => ui.$('[data-step="profile"]') !== null, 'the next step');
    assert.ok(server.requests <= 1, 'read once at most, for the names on the choice: the local block does not wait for it');
  });
});
