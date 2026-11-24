/**
 * The agent step, rendered (jsdom) against a fake daemon: the view follows the
 * profile and the switcher changes it, "Create" writes the main agent
 * (name, then one config PATCH) and opens the chat step, a refused name stays
 * on the step, "Customise" opens and closes, and a profile that could not
 * be read says so and can be read again.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendCatalog } from '@/lib/backends';
import {
  agentConfigPath, createMainAgent, loadMainAgent, loadSheetSkills, MAIN_AGENT_NAME_PATH, repickedSkills, sheetMcp, sheetSkills, sheetSkillsPath,
} from './agent-create';
import { resetOnboardingProfile } from './onboarding-profile';

type Call = { url: string; method: string; body: unknown };
type Answer = (call: Call) => Response | undefined;

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    { id: 'claude', label: 'Claude Code', vendor: 'Anthropic', brand: 'claude', defaultModel: 'sonnet', models: [{ slug: 'opus', label: 'Opus' }, { slug: 'sonnet', label: 'Sonnet' }] },
  ],
};

/** The daemon behind the proxy, as the step reads and writes it. `override` answers first. */
function daemon(profile: string | null, override: Answer = () => undefined): { calls: Call[]; fetcher: (input: string, init?: RequestInit) => Promise<Response> } {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: async (input, init) => {
      const call: Call = { url: input, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const special = override(call);
      if (special) return special;
      if (call.url === '/api/ui/onboarding/profile') return Response.json({ profile, at: profile ? 1 : null });
      if (call.url === '/api/ui/setup/main-agent') return Response.json({ status: 'pending', available: true, name: '_main', named: false });
      if (call.url === '/api/ui/agents/_main') return Response.json({ name: '_main', backend: 'claude', model: 'opus', skills: ['timon-task'], mcp_servers: ['sentry'], look: null });
      if (call.url.startsWith('/api/ui/backends/catalog')) return Response.json(CATALOG);
      if (call.url === '/api/ui/skills') {
        return Response.json({ skills: [{ id: 'timon-task', source: 'timon' }, { id: 'tests', title: 'Tests', source: 'timon' }, { id: 'old', source: 'project', shadowed: true }] });
      }
      if (call.url === '/api/ui/mcp') return Response.json({ servers: [{ id: 'github', name: 'GitHub' }, { id: 'gmail', source: 'claude_ai' }, { id: 'sentry' }] });
      if (call.url === MAIN_AGENT_NAME_PATH) return Response.json({ name: String((call.body as { name: string }).name).toLowerCase() });
      if (call.method === 'PATCH') return Response.json({ ok: true });
      return Response.json({ error: 'not_found' }, { status: 404 });
    },
  };
}

test('the creation names the agent, then writes its config on the name the daemon answered', async () => {
  const d = daemon(null);
  const result = await createMainAgent('Nova', { look: { shape: 'tri', color: '#7ed957', eyes: 'code', acc: 'coffee' }, directives: 'Never push.' }, d.fetcher);
  assert.deepEqual(result, { ok: true, name: 'nova' });
  assert.deepEqual(d.calls.map((c) => `${c.method} ${c.url}`), ['POST /api/ui/setup/main-agent/name', 'PATCH /api/ui/agents/nova/config']);
  assert.deepEqual(d.calls[0]?.body, { name: 'Nova' });
  assert.deepEqual(d.calls[1]?.body, { look: { shape: 'tri', color: '#7ed957', eyes: 'code', acc: 'coffee' }, directives: 'Never push.' });
  assert.equal(agentConfigPath('a b'), '/api/ui/agents/a%20b/config');
});

test('a refused name writes nothing else; a refused config is told apart', async () => {
  const taken = daemon(null, (c) => (c.url === MAIN_AGENT_NAME_PATH ? Response.json({ error: 'name_taken' }, { status: 409 }) : undefined));
  assert.deepEqual(await createMainAgent('Nova', { look: { shape: 'tri', color: '#7ed957', eyes: 'code', acc: 'none' } }, taken.fetcher), { ok: false, error: 'name_taken', stage: 'name' });
  assert.equal(taken.calls.length, 1);
  const odd = daemon(null, (c) => (c.url === MAIN_AGENT_NAME_PATH ? Response.json({ error: 'kaboom' }, { status: 500 }) : undefined));
  assert.equal((await createMainAgent('Nova', { look: { shape: 'tri', color: '#7ed957', eyes: 'code', acc: 'none' } }, odd.fetcher)).ok, false);
  const badConfig = daemon(null, (c) => (c.method === 'PATCH' ? Response.json({ error: 'look.acc: unknown value' }, { status: 400 }) : undefined));
  assert.deepEqual(await createMainAgent('Nova', { look: { shape: 'tri', color: '#7ed957', eyes: 'code', acc: 'none' } }, badConfig.fetcher), { ok: false, error: 'configFailed', stage: 'config' });
});

test('the main agent is read as it stands; an unreachable daemon is an empty agent', async () => {
  const state = await loadMainAgent(daemon(null).fetcher);
  assert.deepEqual(state, { name: '_main', named: false, backend: 'claude', model: 'opus', skills: ['timon-task'], mcpServers: ['sentry'], look: null, role: null });
  const down = await loadMainAgent(async () => { throw new Error('offline'); });
  assert.equal(down.name, null);
});

test('the sheet offers the person\'s skills and opt-in MCP servers, not the product\'s own', () => {
  assert.deepEqual(sheetSkills([{ id: 'timon-task' }, { id: 'tests', title: 'Tests' }, { id: 'x', shadowed: true }, { nope: 1 }]), [{ id: 'tests', label: 'Tests' }]);
  assert.deepEqual(sheetMcp([{ id: 'github', name: 'GitHub' }, { id: 'gmail', source: 'claude_ai' }, { id: 'local', source: 'claude_cli' }]), [{ id: 'github', label: 'GitHub' }]);
  assert.deepEqual(sheetSkills('nope'), []);
});

test('a folder\'s skills are read with its path; a failed read keeps the list shown', async () => {
  assert.equal(sheetSkillsPath(''), '/api/ui/skills');
  assert.equal(sheetSkillsPath('/home/me/my app'), '/api/ui/skills?cwd=%2Fhome%2Fme%2Fmy%20app');
  const seen: string[] = [];
  const ok = await loadSheetSkills('/p', async (url) => { seen.push(url); return Response.json({ skills: [{ id: 'timon-task' }, { id: 'deploy', title: 'Deploy' }] }); });
  assert.deepEqual(ok, [{ id: 'deploy', label: 'Deploy' }]);
  assert.deepEqual(seen, ['/api/ui/skills?cwd=%2Fp']);
  assert.equal(await loadSheetSkills('/p', async () => Response.json({ error: 'nope' }, { status: 502 })), null);
  assert.equal(await loadSheetSkills('/p', async () => { throw new Error('offline'); }), null);
  const abort = new AbortController();
  abort.abort();
  assert.equal(await loadSheetSkills('/p', async () => Response.json({ skills: [{ id: 'late' }] }), abort.signal), null, 'a cancelled read changes nothing');
});

test('a new list drops the picks it no longer offers and checks what the agent already had', () => {
  const before = [{ id: 'tests', label: 'Tests' }, { id: 'lint', label: 'lint' }];
  const after = [{ id: 'tests', label: 'Tests' }, { id: 'deploy', label: 'deploy' }, { id: 'seo', label: 'seo' }];
  assert.deepEqual(repickedSkills(['tests', 'lint'], before, after, ['seo', 'timon-task']), ['tests', 'seo']);
  assert.deepEqual(repickedSkills([], before, before, ['tests']), [], 'an unchecked skill stays unchecked when the list is the same');
});

/* ---------- The step, rendered ---------- */

type Dom = { window: Window & typeof globalThis };

async function withDom<T>(run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/onboarding?step=agent', pretendToBeVisual: true });
  // Reduced motion: no live mascot loop, and the step moves on without waiting for the jump.
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver', 'Event', 'KeyboardEvent', 'getComputedStyle', 'XMLSerializer']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  try {
    return await run(dom as unknown as Dom, React);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

type Rendered = { host: HTMLElement; calls: Call[]; nexts: () => number; react: typeof import('react'); dom: Dom };

async function renderStep(profile: string | null, run: (r: Rendered) => Promise<void>, override?: Answer): Promise<void> {
  await withDom(async (dom, React) => {
    resetOnboardingProfile();
    const { createRoot } = await import('react-dom/client');
    const { OnboardingProvider } = await import('./onboarding-context');
    const { AgentStep } = await import('./steps/agent');
    const fake = daemon(profile, override);
    const savedFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => fake.fetcher(String(input), init)) as typeof fetch;
    let nexts = 0;
    const nav = {
      step: 'agent' as const, direction: 1 as const,
      next: () => { nexts += 1; }, back: () => undefined, goTo: () => undefined,
      setLanguage: async (tag: string) => tag, setBackHandler: () => undefined, skip: () => undefined, setOutcome: () => undefined,
    };
    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    try {
      await React.act(async () => { root.render(React.createElement(OnboardingProvider, { value: nav }, React.createElement(AgentStep))); });
      await settle(React);
      await run({ host, calls: fake.calls, nexts: () => nexts, react: React, dom });
    } finally {
      await React.act(async () => { root.unmount(); });
      globalThis.fetch = savedFetch;
      resetOnboardingProfile();
    }
  });
}

const settle = (react: typeof import('react'), ms = 20): Promise<void> => react.act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const q = <T extends Element = HTMLElement>(host: HTMLElement, selector: string): T => {
  const el = host.querySelector<T>(selector) ?? document.querySelector<T>(selector);
  assert.ok(el, `${selector} is on screen`);
  return el;
};
const click = async (r: Rendered, selector: string): Promise<void> => {
  await r.react.act(async () => { q<HTMLElement>(r.host, selector).click(); });
  await settle(r.react);
};
const patchOf = (calls: readonly Call[]): Record<string, unknown> | undefined => calls.find((c) => c.method === 'PATCH')?.body as Record<string, unknown> | undefined;

test('each profile opens its view, starred; the switcher opens the others', async () => {
  for (const [profile, view] of [['developer', 'sheet'], ['automation', 'interview'], ['beginner', 'templates']] as const) {
    await renderStep(profile, async (r) => {
      assert.equal(q(r.host, '[data-onboarding-step="agent"]').getAttribute('data-agent-view'), view);
      assert.equal(q(r.host, '[data-recommended="true"]').getAttribute('data-view'), view, 'the star is on the profile\'s view');
      assert.equal(q(r.host, `[data-view="${view}"]`).getAttribute('aria-checked'), 'true');
    });
  }
  await renderStep('developer', async (r) => {
    await click(r, '[data-view="templates"]');
    assert.equal(q(r.host, '[data-onboarding-step="agent"]').getAttribute('data-agent-view'), 'templates');
    assert.equal(q(r.host, '[data-recommended="true"]').getAttribute('data-view'), 'sheet', 'the star stays on the recommended view');
  });
});

test('templates: "Create" waits for a profile, then writes the agent and opens the chat', async () => {
  await renderStep('beginner', async (r) => {
    assert.ok((q<HTMLInputElement>(r.host, '[data-agent-name]').value).length > 0, 'a name is drawn');
    assert.equal(q<HTMLButtonElement>(r.host, '[data-create]').disabled, true);
    await click(r, '[data-template="assist"]');
    assert.equal(q(r.host, '[data-role-pill]').textContent, 'Personal assistant');
    assert.deepEqual(Array.from(r.host.querySelectorAll('[data-cap]')).map((el) => el.getAttribute('data-cap')), ['base', 'mail', 'agenda']);
    assert.equal(q<HTMLButtonElement>(r.host, '[data-create]').disabled, false);
    const name = q<HTMLInputElement>(r.host, '[data-agent-name]').value;
    await click(r, '[data-create]');
    await settle(r.react, 40);
    const named = r.calls.find((c) => c.url === MAIN_AGENT_NAME_PATH);
    assert.deepEqual(named?.body, { name });
    const patch = patchOf(r.calls);
    assert.deepEqual(patch?.look, { shape: 'squircle', color: '#ff5fbf', eyes: 'pill', acc: 'clipboard' });
    assert.match(String(patch?.directives), /email/);
    assert.equal(r.calls.find((c) => c.method === 'PATCH')?.url, `/api/ui/agents/${encodeURIComponent(name.toLowerCase())}/config`);
    assert.equal(r.nexts(), 1, 'the chat step opens');
  });
});

test('a refused name is said on the step, which stays', async () => {
  await renderStep('beginner', async (r) => {
    await click(r, '[data-template="dev"]');
    await click(r, '[data-create]');
    await settle(r.react, 40);
    assert.ok(q(r.host, '[data-create-hint][role="alert"]').textContent);
    assert.equal(patchOf(r.calls), undefined, 'nothing else written');
    assert.equal(r.nexts(), 0);
    assert.equal(q<HTMLButtonElement>(r.host, '[data-create]').disabled, false, 'it can be tried again');
  }, (c) => (c.url === MAIN_AGENT_NAME_PATH ? Response.json({ error: 'name_taken' }, { status: 409 }) : undefined));
});

test('sheet: an engine that honours only some modes offers only those, and says what another mode runs as', async () => {
  const withGrok: BackendCatalog = {
    ...CATALOG,
    backends: [
      ...CATALOG.backends,
      { id: 'grok', label: 'Grok Build', vendor: 'xAI', brand: 'grok', defaultModel: 'grok-4.6', models: [{ slug: 'grok-4.6', label: 'Grok 4.6' }], supportedPermissionModes: ['plan', 'bypassPermissions'] },
    ],
  };
  const answer: Answer = (c) => (c.url.startsWith('/api/ui/backends/catalog') ? Response.json(withGrok) : undefined);
  // The catalogue is cached per page: an earlier test left the one without grok.
  const { invalidateBackendCatalog } = await import('@/lib/backends');
  invalidateBackendCatalog();
  await renderStep('developer', async (r) => {
    await click(r, '[data-tab="perms"]');
    // On claude, every mode.
    assert.deepEqual(Array.from(r.host.querySelectorAll('[data-permission]')).map((el) => el.getAttribute('data-permission')), ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
    assert.ok(!r.host.querySelector('[data-permission-runs-as]'));
    await click(r, '[data-tab="engine"]');
    await click(r, 'button[aria-label="xAI"]');
    const grok = Array.from(r.host.querySelectorAll<HTMLButtonElement>('[data-picker-row]')).find((b) => b.textContent?.includes('Grok 4.6'));
    assert.ok(grok, 'the grok model is offered');
    await r.react.act(async () => { grok.click(); });
    await settle(r.react);
    await click(r, '[data-tab="perms"]');
    assert.deepEqual(Array.from(r.host.querySelectorAll('[data-permission]')).map((el) => el.getAttribute('data-permission')), ['plan', 'bypassPermissions']);
    // The sheet's default (acceptEdits) is not one of them: it runs read-only, and the sheet says so.
    const note = q(r.host, '[data-permission-runs-as="plan"]');
    assert.match(note.textContent ?? '', /acceptEdits/);
    assert.match(note.textContent ?? '', /read-only/);
    await click(r, '[data-permission="bypassPermissions"]');
    assert.ok(!r.host.querySelector('[data-permission-runs-as]'), 'a supported mode needs no note');
    assert.ok(q(r.host, '[data-bypass-warning]'));
  }, answer);
  invalidateBackendCatalog();
});

test('sheet: the engine tab offers the model\'s reasoning efforts, resets one a new model lacks, and writes it', async () => {
  const withLevels: BackendCatalog = {
    ...CATALOG,
    backends: [{
      ...CATALOG.backends[0]!,
      models: [{ slug: 'opus', label: 'Opus', supportedReasoningLevels: ['low', 'high'] }, { slug: 'sonnet', label: 'Sonnet' }],
    }],
  };
  const answer: Answer = (c) => (c.url.startsWith('/api/ui/backends/catalog') ? Response.json(withLevels) : undefined);
  const { invalidateBackendCatalog } = await import('@/lib/backends');
  invalidateBackendCatalog();
  const row = (r: Rendered, label: string): HTMLButtonElement => {
    const found = Array.from(r.host.querySelectorAll<HTMLButtonElement>('[data-picker-row]')).find((b) => b.textContent?.includes(label));
    assert.ok(found, `${label} is offered`);
    return found;
  };
  await renderStep('developer', async (r) => {
    await click(r, '[data-tab="engine"]');
    // The agent runs on opus: its levels, after the model's default.
    assert.deepEqual(Array.from(r.host.querySelectorAll('[data-effort]')).map((el) => el.getAttribute('data-effort')), ['', 'low', 'high']);
    assert.equal(q(r.host, '[data-effort=""]').getAttribute('aria-pressed'), 'true', 'the model\'s default first');
    await click(r, '[data-effort="high"]');
    assert.equal(q(r.host, '[data-effort="high"]').getAttribute('aria-pressed'), 'true');
    await r.react.act(async () => { row(r, 'Sonnet').click(); });
    await settle(r.react);
    assert.ok(!r.host.querySelector('[data-effort-section]'), 'a model without levels shows no segment');
    await r.react.act(async () => { row(r, 'Opus').click(); });
    await settle(r.react);
    assert.equal(q(r.host, '[data-effort=""]').getAttribute('aria-pressed'), 'true', 'the level sonnet lacked went back to the default');
    await click(r, '[data-effort="low"]');
    await click(r, '[data-create]');
    await settle(r.react, 40);
    const patch = patchOf(r.calls);
    assert.equal(patch?.model, 'opus');
    assert.equal(patch?.reasoningEffort, 'low');
  }, answer);
  invalidateBackendCatalog();
});

test('sheet: line of work, exact permission mode with its warning, the daemon\'s lists, all written', async () => {
  await renderStep('developer', async (r) => {
    assert.equal(q(r.host, '[data-role="orchestrator"]').getAttribute('aria-pressed'), 'true', 'the sheet opens on the pilot');
    assert.equal(r.host.querySelector('[data-role]')?.getAttribute('data-role'), 'orchestrator', 'first of the list');
    assert.equal(q(r.host, '[data-role-pill]').textContent, 'Orchestrator / pilot');
    assert.match(q(r.host, '[data-role-hint]').textContent ?? '', /main agent/);
    await click(r, '[data-role="review"]');
    assert.equal(q(r.host, '[data-role-pill]').textContent, 'Reviewer');
    await click(r, '[data-tab="engine"]');
    // The product's model picker, not a list of the step's own.
    const sonnet = Array.from(r.host.querySelectorAll<HTMLButtonElement>('[data-picker-row]')).find((b) => b.textContent?.includes('Sonnet'));
    assert.ok(sonnet, 'the catalogue\'s models are offered');
    await r.react.act(async () => { sonnet.click(); });
    await settle(r.react);
    assert.match(q(r.host, '[data-model]').getAttribute('data-model') ?? '', /claude\/sonnet/, 'the card names the picked model');
    await click(r, '[data-tab="perms"]');
    assert.deepEqual(Array.from(r.host.querySelectorAll('[data-permission]')).map((el) => el.getAttribute('data-permission')), ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
    assert.ok(!r.host.querySelector('[data-bypass-warning]'));
    await click(r, '[data-permission="bypassPermissions"]');
    assert.ok(q(r.host, '[data-bypass-warning]'));
    await click(r, '[data-tab="tools"]');
    assert.deepEqual(Array.from(r.host.querySelectorAll('[data-skill]')).map((el) => el.getAttribute('data-skill')), ['tests']);
    assert.deepEqual(Array.from(r.host.querySelectorAll('[data-mcp]')).map((el) => el.getAttribute('data-mcp')), ['github', 'sentry']);
    assert.equal(q(r.host, '[data-mcp="sentry"]').getAttribute('aria-pressed'), 'true', 'what the agent had starts checked');
    await click(r, '[data-skill="tests"]');
    await click(r, '[data-mcp="github"]');
    await click(r, '[data-create]');
    await settle(r.react, 40);
    const patch = patchOf(r.calls);
    assert.ok(patch && !('role' in patch), 'the main agent stays the pilot: no role written');
    assert.match(String(patch?.directives), /^Main line of work: reviewing/);
    assert.equal(patch?.permission_mode, 'bypassPermissions');
    assert.equal(patch?.backend, 'claude');
    assert.equal(patch?.model, 'sonnet');
    assert.deepEqual(patch?.skills, ['timon-task', 'tests'], 'the product\'s own skill is kept');
    assert.deepEqual(patch?.mcp_servers, ['sentry', 'github']);
    assert.equal((patch?.look as { acc?: string } | undefined)?.acc, 'pen', 'a reviewer holds the red pen');
    assert.equal(r.nexts(), 1);
  });
});

test('sheet: a picked folder brings its project\'s skills, debounced, and only the last folder lands', async () => {
  const lists: Record<string, { id: string; title?: string }[]> = {
    '/projects/first': [{ id: 'first-only' }],
    '/projects/acme': [{ id: 'tests', title: 'Tests' }, { id: 'deploy', title: 'Deploy' }, { id: 'seo' }],
    '/projects/slow': [{ id: 'slow-only' }],
  };
  const answer: Answer = (c) => {
    if (c.url === '/api/ui/agents/_main') return Response.json({ name: '_main', backend: 'claude', model: 'opus', skills: ['timon-task', 'seo'], mcp_servers: [], look: null });
    if (!c.url.startsWith('/api/ui/skills?')) return undefined;
    const cwd = new URL(c.url, 'http://x').searchParams.get('cwd') ?? '';
    return Response.json({ skills: lists[cwd] ?? [] });
  };
  await renderStep('developer', async (r) => {
    const picks: string[] = [];
    let slowAnswered = false;
    // The desktop's folder dialog: the step picks through it on this computer.
    (r.dom.window as unknown as { timonDesktop?: unknown }).timonDesktop = {
      restartAfterSetup: async () => false,
      selectDirectory: async () => picks.shift() ?? null,
    };
    // The slow folder's answer arrives after the next folder was picked.
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await savedFetch(input, init);
      if (String(input).includes('slow')) { await new Promise((ok) => setTimeout(ok, 300)); slowAnswered = true; }
      return res;
    }) as typeof fetch;
    const shown = (): (string | null)[] => Array.from(r.host.querySelectorAll('[data-skill]')).map((el) => el.getAttribute('data-skill'));
    const cwdReads = (): string[] => r.calls.filter((c) => c.url.startsWith('/api/ui/skills?')).map((c) => c.url);
    try {
      await click(r, '[data-tab="tools"]');
      assert.deepEqual(shown(), ['tests'], 'no folder: the person\'s own skills');
      await click(r, '[data-tab="base"]');
      picks.push('/projects/first', '/projects/acme');
      await click(r, '[data-pick-folder]');
      await click(r, '[data-pick-folder]');
      await settle(r.react, 320);
      assert.equal(q(r.host, '[data-folder]').textContent, '/projects/acme');
      assert.deepEqual(cwdReads(), ['/api/ui/skills?cwd=%2Fprojects%2Facme'], 'two quick picks, one read: the last folder\'s');
      await click(r, '[data-tab="tools"]');
      assert.deepEqual(shown(), ['tests', 'deploy', 'seo'], 'the project\'s skills join the list');
      assert.equal(q(r.host, '[data-skill="seo"]').getAttribute('aria-pressed'), 'true', 'a skill the agent already had starts checked');
      await click(r, '[data-skill="deploy"]');

      await click(r, '[data-tab="base"]');
      picks.push('/projects/slow');
      await click(r, '[data-pick-folder]');
      await settle(r.react, 280);
      assert.ok(cwdReads().includes('/api/ui/skills?cwd=%2Fprojects%2Fslow'), 'the slow read is on its way');
      picks.push('/projects/first');
      await click(r, '[data-pick-folder]');
      await settle(r.react, 400);
      assert.ok(slowAnswered, 'the slow answer came back');
      await click(r, '[data-tab="tools"]');
      assert.deepEqual(shown(), ['first-only'], 'the cancelled read does not overwrite the last folder\'s list');
      await click(r, '[data-skill="first-only"]');
      await click(r, '[data-create]');
      await settle(r.react, 40);
      const patch = patchOf(r.calls);
      assert.equal(patch?.cwd, '/projects/first');
      assert.deepEqual(patch?.skills, ['timon-task', 'seo', 'first-only'], 'a pick of a folder left behind is not written; the agent\'s own are kept');
    } finally {
      globalThis.fetch = savedFetch;
      delete (r.dom.window as unknown as { timonDesktop?: unknown }).timonDesktop;
    }
  }, answer);
});

test('"Customise" opens the panel; a pick is kept and sent; Escape closes it', async () => {
  await renderStep('developer', async (r) => {
    assert.equal(q(r.host, '[data-look-styler]').getAttribute('data-look-styler'), 'closed');
    await click(r, '[data-customise]');
    assert.equal(q(r.host, '[data-look-styler]').getAttribute('data-look-styler'), 'open');
    await click(r, '[data-shape="bean"]');
    await click(r, '[data-acc="globe"]');
    await r.react.act(async () => { window.dispatchEvent(new r.dom.window.KeyboardEvent('keydown', { key: 'Escape' })); });
    await settle(r.react);
    assert.equal(q(r.host, '[data-look-styler]').getAttribute('data-look-styler'), 'closed');
    await click(r, '[data-role="chore"]');
    await click(r, '[data-create]');
    await settle(r.react, 40);
    const look = patchOf(r.calls)?.look as { shape?: string; acc?: string } | undefined;
    assert.equal(look?.shape, 'bean', 'the styled look survives a change of role');
    assert.equal(look?.acc, 'globe');
  });
});

test('interview: five questions, answered ones reopen, then "Create" writes the autonomy', async () => {
  await renderStep('automation', async (r) => {
    assert.equal(q<HTMLButtonElement>(r.host, '[data-create]').disabled, true);
    await click(r, '[data-mission="mail"]');
    await click(r, '[data-next-question]');
    assert.equal(q(r.host, '[data-tool="gmail"]').getAttribute('aria-pressed'), 'true', 'the tool its mission needs');
    await click(r, '[data-next-question]');
    await click(r, '[data-next-question]');
    await click(r, '[data-autonomy="report"]');
    await click(r, '[data-next-question]');
    await click(r, '[data-edit-question="1"]');
    assert.equal(q(r.host, '[data-question]').getAttribute('data-question'), '1', 'a past answer reopens');
    for (let i = 0; i < 5; i += 1) await click(r, '[data-next-question]');
    assert.ok(!r.host.querySelector('[data-question]'));
    await click(r, '[data-create]');
    await settle(r.react, 40);
    const patch = patchOf(r.calls);
    assert.equal(patch?.permission_mode, 'auto');
    assert.match(String(patch?.directives), /Gmail/);
    assert.equal((patch?.look as { acc?: string } | undefined)?.acc, 'envelope');
  });
});

test('a profile that could not be read says so, and "Retry" reads it again', async () => {
  let up = false;
  await renderStep(null, async (r) => {
    assert.equal(q(r.host, '[data-onboarding-step="agent"]').getAttribute('data-agent-view'), 'templates');
    assert.ok(q(r.host, '[data-profile-error]'));
    up = true;
    await click(r, '[data-profile-error] button');
    await settle(r.react, 40);
    assert.ok(!r.host.querySelector('[data-profile-error]'));
    assert.equal(q(r.host, '[data-onboarding-step="agent"]').getAttribute('data-agent-view'), 'sheet');
  }, (c) => (c.url === '/api/ui/onboarding/profile'
    ? (up ? Response.json({ profile: 'developer', at: 1 }) : Response.json({ error: 'unreachable' }, { status: 502 }))
    : undefined));
});

test('"Customise" opens the shared configurator: a plugin that takes `agent.lookstyler` paints inside the panel', async () => {
  const { register, resetSlotsForTests, AGENT_LOOK_STYLER_SLOT } = await import('@/lib/plugin-host/slots');
  const { useLookStyler } = await import('@/components/mascot/look-styler/look-styler-context');
  const React = await import('react');
  resetSlotsForTests();
  function Replacement() {
    const v = useLookStyler();
    return React.createElement('button', {
      type: 'button',
      'data-plugin-styler': v?.name,
      onClick: () => v?.onChange({ shape: 'cloud', color: '#3fa9ff', eyes: 'star', acc: 'telescope' }),
    });
  }
  const dispose = register({ slot: AGENT_LOOK_STYLER_SLOT, pluginId: 'acme-styler' }, Replacement);
  try {
    await renderStep('developer', async (r) => {
      assert.ok(!r.host.querySelector('[data-plugin-styler]') && !document.querySelector('[data-plugin-styler]'), 'nothing painted while the panel is closed');
      await click(r, '[data-customise]');
      const name = q<HTMLInputElement>(r.host, '[data-agent-name]').value;
      assert.equal(q(r.host, '[data-plugin-styler]').getAttribute('data-plugin-styler'), name, 'the plugin reads the agent\'s name');
      assert.ok(!document.querySelector('[data-look-styler-content]'), 'the product\'s grids stepped aside');
      assert.ok(q(r.host, '[data-style-done]'), 'the panel and its "Done" stay the step\'s');
      await click(r, '[data-plugin-styler]');
      await click(r, '[data-style-done]');
      await click(r, '[data-create]');
      await settle(r.react, 40);
      assert.deepEqual(patchOf(r.calls)?.look, { shape: 'cloud', color: '#3fa9ff', eyes: 'star', acc: 'telescope' });
    });
  } finally {
    dispose();
    resetSlotsForTests();
  }
});
