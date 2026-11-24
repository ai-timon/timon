/**
 * The TIMs list follows an agent saved elsewhere: "New TIM" opens the shared
 * agent editor, which announces the save (`AGENTS_CHANGED_EVENT`), and the
 * list re-reads at once — the new TIM no longer waits for a reload.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

type Dom = { window: Window & typeof globalThis };

async function withDom<T>(run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/bots', pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
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

test('a TIM saved from the agent editor shows in the list without a reload', async () => {
  await withDom(async (_dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { useBots } = await import('./use-bots');
    const { announceAgentsChanged } = await import('@/lib/agents-changed');

    let agents = [{ name: 'nova', main: true }];
    let reads = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/ui/agents')) {
        reads += 1;
        return new Response(JSON.stringify({ agents }), { status: 200 });
      }
      return new Response(JSON.stringify({ teams: [] }), { status: 200 });
    }) as typeof fetch;

    let names: string[] = [];
    function Probe(): null {
      names = useBots().bots.map((bot) => bot.name);
      return null;
    }
    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    try {
      await React.act(async () => { root.render(React.createElement(Probe)); });
      assert.deepEqual(names, ['nova']);

      agents = [...agents, { name: 'scout', main: false }];
      await React.act(async () => { announceAgentsChanged(); });
      assert.deepEqual(names, ['nova', 'scout'], 'the new TIM is listed at once');
      assert.equal(reads, 2);

      await React.act(async () => { root.unmount(); });
      announceAgentsChanged();
      assert.equal(reads, 2, 'an unmounted list stops listening');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

type FakeServer = {
  agents: Array<{ name: string; main: boolean; team?: string }>;
  teams: Array<{ id: string; name: string }>;
  agentReads: number;
  teamReads: number;
  /** When set, `/api/ui/agents` waits on it before answering. */
  gate: Promise<void> | null;
};

function installServer(server: FakeServer): () => void {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/ui/agents')) {
      server.agentReads += 1;
      // The answer reflects the server at the moment the request left.
      const body = JSON.stringify({ agents: server.agents });
      if (server.gate) await server.gate;
      return new Response(body, { status: 200 });
    }
    server.teamReads += 1;
    return new Response(JSON.stringify({ teams: server.teams }), { status: 200 });
  }) as typeof fetch;
  return () => { globalThis.fetch = savedFetch; };
}

test('the rail and the page share one read of each list', async () => {
  await withDom(async (_dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { useBots } = await import('./use-bots');
    const server: FakeServer = { agents: [{ name: 'nova', main: true }], teams: [], agentReads: 0, teamReads: 0, gate: null };
    const restore = installServer(server);

    const seen: Record<string, string[]> = {};
    function Probe({ id }: { id: string }): null {
      seen[id] = useBots().bots.map((bot) => bot.name);
      return null;
    }
    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    try {
      await React.act(async () => {
        root.render(React.createElement(React.Fragment, null,
          React.createElement(Probe, { id: 'rail' }),
          React.createElement(Probe, { id: 'page' })));
      });
      assert.deepEqual(seen, { rail: ['nova'], page: ['nova'] });
      assert.equal(server.agentReads, 1, 'one read of the agents for two readers');
      assert.equal(server.teamReads, 1, 'one read of the teams for two readers');
    } finally {
      await React.act(async () => { root.unmount(); });
      restore();
    }
  });
});

test('a team move refreshed by the rail shows in the page at once', async () => {
  await withDom(async (_dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { useBots } = await import('./use-bots');
    const server: FakeServer = {
      agents: [{ name: 'nova', main: true }, { name: 'scout', main: false }],
      teams: [{ id: 't1', name: 'Writers' }],
      agentReads: 0,
      teamReads: 0,
      gate: null,
    };
    const restore = installServer(server);

    const rail: { refresh: () => Promise<void> } = { refresh: async () => {} };
    let pageTeams: Record<string, string | undefined> = {};
    function Rail(): null {
      rail.refresh = useBots().refresh;
      return null;
    }
    function Page(): null {
      pageTeams = Object.fromEntries(useBots().bots.map((bot) => [bot.name, bot.team ?? undefined]));
      return null;
    }
    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    try {
      await React.act(async () => {
        root.render(React.createElement(React.Fragment, null, React.createElement(Rail), React.createElement(Page)));
      });
      assert.equal(pageTeams.scout, undefined);

      server.agents = [{ name: 'nova', main: true }, { name: 'scout', main: false, team: 't1' }];
      await React.act(async () => { await rail.refresh(); });
      assert.equal(pageTeams.scout, 't1', 'the page sees the move made in the rail');
    } finally {
      await React.act(async () => { root.unmount(); });
      restore();
    }
  });
});

test('a refresh asked during a read is not lost in it', async () => {
  await withDom(async (_dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { useBots } = await import('./use-bots');
    const server: FakeServer = { agents: [{ name: 'nova', main: true }], teams: [], agentReads: 0, teamReads: 0, gate: null };
    const restore = installServer(server);

    const probe: { data: ReturnType<typeof useBots> | null } = { data: null };
    function Probe(): null {
      probe.data = useBots();
      return null;
    }
    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    try {
      await React.act(async () => { root.render(React.createElement(Probe)); });
      assert.equal(server.agentReads, 1);

      // A read leaves before the mutation and is still in flight when the
      // caller, its mutation done, asks for a refresh.
      const data = probe.data;
      assert.ok(data);
      let open: () => void = () => {};
      server.gate = new Promise<void>((resolve) => { open = resolve; });
      const first = data.refresh();
      server.agents = [{ name: 'nova', main: true }, { name: 'scout', main: false }];
      const second = data.refresh();
      const third = data.refresh();
      server.gate = null;
      open();
      await React.act(async () => { await Promise.all([first, second, third]); });

      assert.deepEqual(probe.data?.bots.map((bot) => bot.name), ['nova', 'scout']);
      assert.equal(server.agentReads, 3, 'the in-flight read, then one more for both late calls');
    } finally {
      await React.act(async () => { root.unmount(); });
      restore();
    }
  });
});
