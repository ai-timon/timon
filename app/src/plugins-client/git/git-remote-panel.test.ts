/**
 * The Publish tab against `projects:manage` (TODO #560): the daemon refuses
 * push, fetch and creating a remote to an account without it (TODO #525), so
 * the tab greys them and says why — and a refusal that still comes back is
 * shown with its reason, not as the bare word "forbidden".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitRemote } from '@/lib/git-store';

type Call = { url: string; method: string; body?: string };

const remote: GitRemote = {
  slug: 'p', state: 'ahead', cwd: '/p', branch: 'main', remote_name: 'origin', remote_count: 1,
  remote: 'git@github.com:o/p.git', remote_web: 'https://github.com/o/p', upstream: 'origin/main',
  compare_ref: 'origin/main', branch_published: true, ahead: 2, behind: 0, dirty: 0, has_commits: true,
  last_commit_at: null, fetched_at: null, gh_available: true, gh_account: null, default_repo_name: 'p',
  branches: [{ name: 'main', upstream: 'origin/main', compare_ref: 'origin/main', ahead: 2, behind: 0, published: true }],
};

/** What a POST answers; the daemon refuses by default. */
let postAnswer: () => [number, unknown] = () => [403, REFUSAL];

const REFUSAL = {
  error: 'forbidden', code: 'account_lacks_permission', permission: 'projects:manage',
  reason: 'this account does not hold projects:manage',
  hint: 'Ask an administrator to add projects:manage to your role.', caller: 'session',
};

async function withDom(
  me: unknown,
  run: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const calls: Call[] = [];
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'DocumentFragment', 'HTMLSelectElement', 'HTMLOptionElement']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // Radix scrolls the focused option into view; jsdom has no layout.
  (dom.window.HTMLElement.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
    const [status, json] = url.startsWith('/api/ui/auth/me') ? [200, me]
      // The daemon refuses whatever the UI let through.
      : url.startsWith('/api/ui/git-remote/') && init?.method === 'POST' ? postAnswer()
        : [200, { git: remote }];
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  });
  const React = await import('react');
  install('React', React);
  const { refreshMe } = await import('@/hooks/use-me');
  await refreshMe();
  calls.length = 0;
  try {
    await run(calls);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

async function render(
  g: GitRemote,
  run: (host: HTMLElement, act: (fn: () => void | Promise<void>) => Promise<void>) => Promise<void>,
): Promise<void> {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { GitPublish } = await import('./git-remote-panel');
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  const act = async (fn: () => void | Promise<void>) => { await React.act(async () => { await fn(); }); };
  try {
    await act(() => { root.render(React.createElement(GitPublish, { g })); });
    await run(host, act);
  } finally {
    await act(() => { root.unmount(); });
  }
}

// Its text, or its aria-label for a button drawn as an icon (Fetch, Remotes).
const button = (host: HTMLElement, label: RegExp): HTMLButtonElement => {
  const found = Array.from(host.querySelectorAll('button')).find((b) => label.test(b.textContent || b.getAttribute('aria-label') || ''));
  assert.ok(found, `a button reads ${label}`);
  return found;
};

test('without projects:manage, push and fetch are greyed and the tab says why', async () => {
  await withDom({ user: null, can: { 'projects:manage': false } }, async (calls) => {
    await render(remote, async (host) => {
      const push = button(host, /Push/);
      const fetchButton = button(host, /Fetch/);
      assert.equal(push.disabled, true);
      assert.equal(fetchButton.disabled, true);
      assert.match(push.title, /projects:manage/);
      assert.match(fetchButton.title, /projects:manage/);
      assert.match(host.textContent ?? '', /does not hold projects:manage/);
      push.click();
      fetchButton.click();
      assert.ok(!calls.some((c) => c.method === 'POST'), 'nothing is posted');
    });
  });
});

test('without projects:manage, a project with no remote cannot be published from here', async () => {
  const none: GitRemote = { ...remote, state: 'no-remote', remote: null, remote_web: null, remote_name: null, remote_count: 0, upstream: null };
  await withDom({ user: null, can: { 'projects:manage': false } }, async () => {
    await render(none, async (host) => {
      assert.equal(button(host, /GitHub/).disabled, true);
      assert.equal(button(host, /remote/i).disabled, true);
    });
  });
});

test('with projects:manage the buttons are live, and a refusal reads its reason, not "forbidden"', async () => {
  const { answerConfirmsForTests } = await import('@/components/confirm-dialog/confirm-dialog-context');
  answerConfirmsForTests(() => true);
  try {
    await withDom({ user: null, can: { 'projects:manage': true } }, async (calls) => {
      await render(remote, async (host, act) => {
        const push = button(host, /Push/);
        assert.equal(push.disabled, false);
        assert.doesNotMatch(host.textContent ?? '', /does not hold/);
        await act(async () => { push.click(); await new Promise((r) => setTimeout(r, 10)); });
        assert.ok(calls.some((c) => c.url === '/api/ui/git-remote/p/push' && c.method === 'POST'));
        const text = host.textContent ?? '';
        assert.match(text, /does not hold projects:manage/);
        assert.doesNotMatch(text, /\bforbidden\b/);
      });
    });
  } finally {
    answerConfirmsForTests(null);
  }
});

const mirrored: GitRemote = {
  ...remote,
  remote_count: 2,
  remotes: [
    { name: 'mirror', url: '/srv/backup/p.git', web: null, branches: [{ name: 'main', published: true, ahead: 5 }] },
    { name: 'origin', url: 'git@github.com:o/p.git', web: 'https://github.com/o/p', branches: [{ name: 'main', published: true, ahead: 2 }] },
  ],
};

test('one remote: no destination picker; several: the upstream is preselected', async () => {
  await withDom({ user: null, can: { 'projects:manage': true } }, async () => {
    await render(remote, async (host) => {
      assert.ok(!host.querySelector('[aria-label="Push destination"]'), 'no picker with a single remote');
    });
    await render(mirrored, async (host) => {
      const picker = host.querySelector('[aria-label="Push destination"]');
      assert.ok(picker, 'the picker is shown');
      assert.match(picker.textContent ?? '', /origin/);
    });
  });
});

test('a push to the upstream is confirmed with its destination, and sends no remote', async () => {
  const { answerConfirmsForTests } = await import('@/components/confirm-dialog/confirm-dialog-context');
  const asked: Array<{ title: string; description?: string; destructive?: boolean }> = [];
  let answer = false;
  answerConfirmsForTests((r) => { asked.push(r); return answer; });
  postAnswer = () => [200, { git: remote }];
  try {
    await withDom({ user: null, can: { 'projects:manage': true } }, async (calls) => {
      await render(remote, async (host, act) => {
        await act(async () => { button(host, /Push/).click(); await new Promise((r) => setTimeout(r, 10)); });
        assert.equal(asked.length, 1, 'a single remote is confirmed too');
        assert.equal(asked[0]!.title, 'Push 2 commits of main to o/p?');
        assert.match(asked[0]!.description ?? '', /origin \(o\/p\)/);
        assert.equal(asked[0]!.destructive, false);
        assert.ok(!calls.some((c) => c.method === 'POST'), 'a no sends nothing');
        answer = true;
        await act(async () => { button(host, /Push/).click(); await new Promise((r) => setTimeout(r, 10)); });
        const sent = calls.find((c) => c.url === '/api/ui/git-remote/p/push');
        assert.deepEqual(JSON.parse(sent?.body ?? '{}'), { branch: 'main' });
      });
      await render(mirrored, async (host, act) => {
        calls.length = 0;
        await act(async () => { button(host, /Push/).click(); await new Promise((r) => setTimeout(r, 10)); });
        assert.equal(asked.length, 3);
        assert.match(asked[2]!.title, /o\/p/);
        const sent = calls.find((c) => c.url === '/api/ui/git-remote/p/push');
        assert.deepEqual(JSON.parse(sent?.body ?? '{}'), { branch: 'main' });
      });
    });
  } finally {
    answerConfirmsForTests(null);
    postAnswer = () => [403, REFUSAL];
  }
});

test('another remote is confirmed with its name and count, and a no sends nothing', async () => {
  const { answerConfirmsForTests } = await import('@/components/confirm-dialog/confirm-dialog-context');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { GitPublish } = await import('./git-remote-panel');
  const asked: Array<{ title: string; description?: string; destructive?: boolean }> = [];
  let answer = false;
  answerConfirmsForTests((r) => { asked.push(r); return answer; });
  postAnswer = () => [200, { git: mirrored }];
  try {
    await withDom({ user: null, can: { 'projects:manage': true } }, async (calls) => {
      // The picker is a Radix select: opened and answered from the keyboard,
      // which jsdom carries, unlike pointer capture.
      const host = document.getElementById('root')!;
      const root = createRoot(host);
      const act = async (fn: () => void | Promise<void>) => { await React.act(async () => { await fn(); }); };
      const key = (el: Element, k: string) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
      try {
        await act(() => { root.render(React.createElement(GitPublish, { g: mirrored })); });
        const trigger = host.querySelector('[aria-label="Push destination"]');
        assert.ok(trigger);
        await act(() => { key(trigger, 'ArrowDown'); });
        const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) => /mirror/.test(o.textContent ?? ''));
        assert.ok(option, 'the mirror is offered');
        assert.match(option.textContent ?? '', /5 to push/);
        assert.match(option.textContent ?? '', /backup\/p/);
        await act(() => { key(option, 'Enter'); });
        const push = button(host, /Push to mirror/);
        assert.match(push.textContent ?? '', /\(5\)/);
        await act(async () => { push.click(); await new Promise((r) => setTimeout(r, 10)); });
        assert.equal(asked.length, 1);
        assert.match(asked[0]!.title, /backup\/p/);
        assert.match(asked[0]!.description ?? '', /mirror is not the upstream/);
        assert.match(asked[0]!.description ?? '', /5 commit/);
        assert.match(asked[0]!.description ?? '', /backup\/p/);
        assert.equal(asked[0]!.destructive, true);
        assert.ok(!calls.some((c) => c.method === 'POST'), 'a no sends nothing');
        answer = true;
        await act(async () => { button(host, /Push to mirror/).click(); await new Promise((r) => setTimeout(r, 10)); });
        const sent = calls.find((c) => c.url === '/api/ui/git-remote/p/push');
        assert.deepEqual(JSON.parse(sent?.body ?? '{}'), { branch: 'main', remote: 'mirror' });
      } finally {
        await act(() => { root.unmount(); });
      }
    });
  } finally {
    answerConfirmsForTests(null);
    postAnswer = () => [403, REFUSAL];
  }
});
