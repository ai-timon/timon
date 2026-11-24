/**
 * The series planner form, mounted for real: workstreams grouped by the agent
 * become disclosures with their own model settings (TODO #433, part 3).
 *
 * What a pure helper could not prove: that a form with groups sends exactly
 * what it sent before when nobody touches a group, that a group's inherit
 * option names the general setting chosen below it, and that the disclosure
 * opens from the keyboard. Every cell is the shared ModelPicker
 * (`docs/MODEL-PICKER.md`): its inherit entry stands for "no setting", and a
 * subscription account is picked by its own instance id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import type { SeriesPlanAnswer, SeriesPlanFormPayload } from '../components/series-plan-form';

const CATALOG = {
  defaultBackend: 'claude',
  backends: [
    { id: 'claude', label: 'Claude', brand: 'anthropic', models: [{ slug: 'opus', label: 'Opus' }, { slug: 'sonnet', label: 'Sonnet' }] },
    { id: 'codex', label: 'Codex', brand: 'openai', models: [{ slug: 'gpt-5.5', label: 'GPT-5.5' }] },
    {
      id: 'claude@krz', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', instanceOf: 'claude',
      account: { id: 'krz', name: 'KRZDIGITAL' }, models: [{ slug: 'opus', label: 'Opus' }],
    },
    {
      id: 'claude@perso', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', instanceOf: 'claude',
      account: { id: 'perso', name: 'Perso', state: 'reauth' }, models: [{ slug: 'opus', label: 'Opus' }],
    },
  ],
};

/** What the daemon's branch check answers, and what it was asked. */
let branchRoute: (branch: string, kind?: string) => Response = () => new Response(null, { status: 404 });
const branchChecks: Array<{ url: string; branch: string; kind?: string }> = [];

// Catalog bodies read so far. The store caches the catalog for the whole
// process: only the first mount fetches it, later ones paint it at once.
let served = 0;

type MountOptions = {
  /** Scope of the session draft; none by default, as before the draft existed. */
  missionId?: string;
  /** Stands for the tab's `sessionStorage`, shared across mounts to play a reload. */
  storage?: Storage;
  /** What the card's `resolve` answers: `false` = the plan did not reach the daemon. */
  delivered?: boolean;
};

async function mount(form: SeriesPlanFormPayload, opts: MountOptions = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  if (opts.storage) Object.defineProperty(dom.window, 'sessionStorage', { value: opts.storage, configurable: true });
  const install = (key: string, v: unknown) => Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLInputElement',
    'HTMLDivElement', 'SVGElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent',
    'MutationObserver', 'getComputedStyle', 'DOMRect', 'DocumentFragment', 'Text', 'ShadowRoot',
  ] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
  install('cancelAnimationFrame', (id: number) => clearTimeout(id));
  // What Radix Select asks of a browser and jsdom does not have.
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const proto = dom.window.Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/ui/prefs/model-favorites') return Response.json({ favorites: [] });
    if (url.endsWith('/integration/branch')) {
      const { branch, kind } = JSON.parse(String(init?.body ?? '{}')) as { branch: string; kind?: string };
      branchChecks.push({ url, branch, kind });
      return branchRoute(branch, kind);
    }
    if (url !== '/api/ui/backends/catalog') return new Response(null, { status: 404 });
    const response = Response.json(CATALOG);
    const read = response.json.bind(response);
    response.json = async () => { const body: unknown = await read(); served += 1; return body; };
    return response;
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SeriesPlanForm } = await import('../components/series-plan-form');
  const answers: SeriesPlanAnswer[] = [];
  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await React.act(async () => {
    root.render(React.createElement(SeriesPlanForm, {
      form, pending: true, busy: false, missionId: opts.missionId, onCancel: () => {},
      onSubmit: async (a: SeriesPlanAnswer) => { answers.push(a); return opts.delivered ?? true; },
    }));
  });
  await until(() => served > 0, 'the backend catalog to be read');
  // One more turn: the store publishes the catalog after reading it.
  await until(() => true, 'the catalog to reach the form');
  const click = async (el: HTMLElement) => { await React.act(async () => { el.click(); }); };
  const key = async (el: HTMLElement, name: string) => {
    await React.act(async () => {
      el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
      el.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: name, bubbles: true, cancelable: true }));
    });
  };
  /** The rows of the open picker: the inherit entry first, then the models of the provider shown. */
  const options = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] [data-picker-row]'));
  /** A row's name, without the slug printed under it. */
  const optionLabel = (o: Element) => o.querySelector('span > span')?.textContent ?? '';
  const rail = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button'));
  const openMenu = async (trigger: HTMLElement) => {
    await click(trigger);
    await until(() => options().length > 0, 'the model picker to open');
  };
  const closeMenu = async () => {
    await key(document.activeElement as HTMLElement, 'Escape');
    await until(() => options().length === 0, 'the model picker to close');
  };
  /** Opens a picker and clicks the row named `label`, on the provider `provider`
   *  (its rail label, "Anthropic · KRZDIGITAL") or on the first one offering it. */
  const choose = async (trigger: HTMLElement, label: string, provider?: string) => {
    await openMenu(trigger);
    const find = () => options().find((o) => optionLabel(o) === label && !o.disabled);
    for (const button of rail().slice(1)) {
      if (!provider && find()) break;
      if (provider && button.getAttribute('aria-label') !== provider) continue;
      await click(button);
      if (provider) break;
    }
    const option = find();
    assert.ok(option, `option ${label} not offered (offered: ${options().map(optionLabel).join(', ')})`);
    await click(option);
    await until(() => options().length === 0, 'the model picker to close on its pick');
  };
  const headers = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-group-header]'));
  const panel = (header: HTMLButtonElement) => document.getElementById(header.getAttribute('aria-controls')!);
  const pickersIn = (el: Element) => Array.from(el.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]'));
  const modeButton = (header: HTMLButtonElement, which: 'sync' | 'override') =>
    panel(header)!.querySelector<HTMLButtonElement>(`button[data-group-mode="${which}"]`)!;
  const launch = async () => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Launch')!;
    const before = answers.length;
    await click(button);
    await until(() => answers.length > before, 'the plan to be submitted');
  };
  const type = async (el: HTMLTextAreaElement, value: string) => {
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  return { answers, click, key, type, options, optionLabel, rail, openMenu, closeMenu, choose, headers, panel, pickersIn, modeButton, launch, unmount, window: dom.window };
}

const grouped: SeriesPlanFormPayload = {
  kind: 'series_plan',
  chantier: 'Big job',
  volets: [
    { title: 'Rename a label', group: 'simple' },
    { title: 'Fix a typo', group: 'simple', description: 'in the footer' },
    { title: 'Rewrite the scheduler', group: 'complex' },
    { title: 'Write the release note' },
  ],
  defaults: { code: { model: 'claude / sonnet', fallback: 'codex / gpt-5.5' } },
};

test('workstreams without any group render as the plain list, and the answer carries no groups', async () => {
  const r = await mount({ kind: 'series_plan', chantier: 'Job', volets: [{ title: 'A' }, { title: 'B' }] });
  try {
    assert.equal(r.headers().length, 0);
    assert.ok(!document.querySelector('[data-testid="plan-groups"]'));
    assert.equal(document.querySelector('ol')!.textContent, '1. A2. B');
    await r.launch();
    assert.deepEqual(r.answers, [{ mode: 'kanban-full', roles: {}, note: undefined }]);
    assert.equal('groups' in r.answers[0]!, false);
  } finally { await r.unmount(); }
});

test('groups render in order of first appearance, collapsed, with their count, the status and the inherit summary; the rest goes under Other', async () => {
  const r = await mount(grouped);
  try {
    const headers = r.headers();
    assert.deepEqual(headers.map((h) => h.getAttribute('aria-expanded')), ['false', 'false']);
    assert.match(headers[0]!.textContent!, /^simple2 workstreamsinherits the general settingsGeneral models$/);
    assert.match(headers[1]!.textContent!, /^complex1 workstreaminherits the general settingsGeneral models$/);
    assert.ok(!r.panel(headers[0]!));
    const other = document.querySelector('[data-testid="plan-ungrouped"]')!;
    assert.match(other.textContent!, /Other workstreams/);
    assert.match(other.textContent!, /4\. Write the release note/);
  } finally { await r.unmount(); }
});

test('a click or Enter / Space on the header opens the group: its workstreams, the mode switch, then one row per task role', async () => {
  const r = await mount(grouped);
  try {
    const header = r.headers()[0]!;
    await r.click(header);
    assert.equal(header.getAttribute('aria-expanded'), 'true');
    const panel = r.panel(header)!;
    assert.match(panel.textContent!, /1\. Rename a label2\. Fix a typo — in the footer/);
    // kanban-full: code, review, merge, doc — never orchestrator.
    assert.match(panel.textContent!, /Coder.*Reviewer.*Merger.*Docs/);
    assert.doesNotMatch(panel.textContent!, /Orchestrator/);
    await r.click(header);
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    assert.ok(!r.panel(header));
    header.focus();
    assert.equal(document.activeElement, header);
    await r.key(header, 'Enter');
    await r.click(header);
    assert.equal(header.getAttribute('aria-expanded'), 'true');
  } finally { await r.unmount(); }
});

test('a group follows the general models until it is overridden: read-only values, then menus, and back with "Use general models"', async () => {
  const r = await mount(grouped);
  try {
    const header = r.headers()[0]!;
    await r.click(header);
    const panel = r.panel(header)!;
    // Following: the values are shown, nothing to pick, "General models" status.
    assert.equal(r.pickersIn(panel).length, 0);
    assert.equal(r.modeButton(header, 'sync').getAttribute('aria-pressed'), 'true');
    assert.equal(r.modeButton(header, 'override').getAttribute('aria-pressed'), 'false');
    assert.match(panel.textContent!, /SonnetGPT-5\.5/); // the resolved default of the coder row
    assert.equal(header.querySelector('[data-testid="group-status"]')!.textContent, 'General models');
    // Override: eight menus (code, review, merge, doc × model, fallback), status flips before any pick.
    await r.click(r.modeButton(header, 'override'));
    assert.equal(r.pickersIn(r.panel(header)!).length, 8);
    assert.equal(header.querySelector('[data-testid="group-status"]')!.textContent, 'Own models');
    assert.equal(document.querySelector('section[data-group-state]')!.getAttribute('data-group-state'), 'custom');
    // Nothing picked yet: the answer is still the untouched one.
    await r.launch();
    assert.equal('groups' in r.answers[0]!, false);
    // Back to the general models clears what the group had.
    await r.choose(r.pickersIn(r.panel(header)!)[0]!, 'Opus');
    assert.match(header.textContent!, /Coder · Opus/);
    await r.click(r.modeButton(header, 'sync'));
    assert.equal(r.pickersIn(r.panel(header)!).length, 0);
    assert.equal(header.querySelector('[data-testid="group-status"]')!.textContent, 'General models');
    await r.launch();
    assert.equal('groups' in r.answers[1]!, false);
  } finally { await r.unmount(); }
});

test('untouched groups leave the answer exactly as before; a setting on one group sends that group only', async () => {
  const r = await mount(grouped);
  try {
    await r.launch();
    assert.deepEqual(r.answers[0], { mode: 'kanban-full', roles: {}, note: undefined });
    assert.equal('groups' in r.answers[0]!, false);

    const header = r.headers()[1]!;
    await r.click(header);
    await r.click(r.modeButton(header, 'override'));
    const [codeMain, codeFallback] = r.pickersIn(r.panel(header)!);
    await r.choose(codeMain!, 'Opus');
    await r.choose(codeFallback!, 'GPT-5.5');
    assert.match(header.textContent!, /Coder · Opus, fallback GPT-5\.5/);
    await r.launch();
    assert.deepEqual(r.answers[1], {
      mode: 'kanban-full',
      roles: {},
      groups: { complex: { code: { backend: 'claude', model: 'opus', fallbackBackend: 'codex', fallbackModel: 'gpt-5.5' } } },
      note: undefined,
    });
  } finally { await r.unmount(); }
});

test('a menu shows the model logo and its name, never the provider name; the provider stays in the tooltip', async () => {
  const r = await mount(grouped);
  try {
    const header = r.headers()[0]!;
    await r.click(header);
    await r.click(r.modeButton(header, 'override'));
    const codeMain = r.pickersIn(r.panel(header)!)[0]!;
    assert.equal(codeMain.textContent, 'Sonnet'); // the inherited default, model only
    assert.ok(codeMain.querySelector('span[title]')!.firstElementChild, 'a logo precedes the model name');
    assert.doesNotMatch(codeMain.textContent!, /claude/i);
    await r.choose(codeMain, 'Opus');
    const picked = r.pickersIn(r.panel(header)!)[0]!;
    assert.equal(picked.textContent, 'Opus');
    assert.equal(picked.querySelector('span[title]')!.getAttribute('title'), 'Claude / Opus');
  } finally { await r.unmount(); }
});

test('opening a group closes the other one; the open group drops its fill for a primary ring and its workstreams get a light background', async () => {
  const r = await mount(grouped);
  try {
    const [first, second] = r.headers() as [HTMLButtonElement, HTMLButtonElement];
    const section = (h: HTMLButtonElement) => h.closest('section')!;
    await r.click(first);
    assert.equal(first.getAttribute('aria-expanded'), 'true');
    assert.match(section(first).className, /ring-primary/);
    assert.doesNotMatch(section(first).className, /bg-foreground/);
    assert.match(r.panel(first)!.querySelector('[data-testid="group-volets"]')!.className, /bg-foreground/);
    assert.doesNotMatch(section(second).className, /ring-primary/);
    await r.click(second);
    assert.equal(first.getAttribute('aria-expanded'), 'false');
    assert.equal(second.getAttribute('aria-expanded'), 'true');
    assert.ok(!r.panel(first));
    await r.click(second);
    assert.deepEqual(r.headers().map((h) => h.getAttribute('aria-expanded')), ['false', 'false']);
    // A setting does not hold its group open any more: the header still says it.
    await r.click(first);
    await r.click(r.modeButton(first, 'override'));
    await r.choose(r.pickersIn(r.panel(first)!)[0]!, 'Opus');
    await r.click(second);
    assert.equal(first.getAttribute('aria-expanded'), 'false');
    assert.match(first.textContent!, /Coder · Opus/);
    assert.equal(first.querySelector('[data-testid="group-status"]')!.textContent, 'Own models');
  } finally { await r.unmount(); }
});

test('the pipeline choice comes first, above the groups and the general settings', async () => {
  const r = await mount(grouped);
  try {
    const tile = document.querySelector('button[aria-pressed][title]')!;
    const groups = document.querySelector('[data-testid="plan-groups"]')!;
    const general = Array.from(document.querySelectorAll('div')).find((d) => d.textContent?.startsWith('General settings'))!;
    const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & 4); // b follows a
    assert.ok(before(tile, groups));
    assert.ok(before(groups, general));
  } finally { await r.unmount(); }
});

test('the inherit option of a group names the general setting when one is chosen, the resolved default otherwise', async () => {
  const r = await mount(grouped);
  try {
    const header = r.headers()[0]!;
    await r.click(header);
    await r.click(r.modeButton(header, 'override'));
    const inheritOf = async (trigger: HTMLElement) => {
      await r.openMenu(trigger);
      const text = r.options()[0]!.textContent;
      await r.closeMenu();
      return text;
    };
    const [codeMain, codeFallback] = r.pickersIn(r.panel(header)!);
    assert.equal(await inheritOf(codeMain!), 'claude / sonnet (current)');
    assert.equal(await inheritOf(codeFallback!), 'codex / gpt-5.5 (current)');
    // General rows sit below the groups: pick the general Coder model.
    const general = r.pickersIn(document.body).filter((s) => !r.panel(header)!.contains(s) && s.title === 'Primary model');
    await r.choose(general[0]!, 'GPT-5.5');
    assert.equal(await inheritOf(r.pickersIn(r.panel(header)!)[0]!), 'codex / gpt-5.5 (general setting)');
    // The inherited value shown in the closed group menu follows too.
    assert.equal(r.pickersIn(r.panel(header)!)[0]!.textContent, 'GPT-5.5');
  } finally { await r.unmount(); }
});

test('a group setting on a role outside the chosen mode is dropped at send time, not purged', async () => {
  const r = await mount(grouped);
  try {
    const header = r.headers()[0]!;
    await r.click(header);
    await r.click(r.modeButton(header, 'override'));
    const pickers = r.pickersIn(r.panel(header)!);
    // Row order follows the mode's roles: code, review, merge, doc.
    await r.choose(pickers[2]!, 'Sonnet'); // review main
    await r.choose(pickers[0]!, 'Opus'); // code main
    const codeSelf = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).find((b) => b.title.includes('merge as you go'))!;
    await r.click(codeSelf);
    assert.equal(r.pickersIn(r.panel(r.headers()[0]!)!).length, 4); // code, doc
    await r.launch();
    assert.deepEqual(r.answers[0]!.groups, { simple: { code: { backend: 'claude', model: 'opus' } } });
    const full = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).find((b) => b.title.includes('code → review → merge'))!;
    await r.click(full);
    await r.launch();
    assert.deepEqual(r.answers[1]!.groups, {
      simple: { code: { backend: 'claude', model: 'opus' }, review: { backend: 'claude', model: 'sonnet' } },
    });
  } finally { await r.unmount(); }
});

test('a sequential mode keeps the groups readable but offers no per-group model', async () => {
  const r = await mount(grouped);
  try {
    const sequential = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).find((b) => b.title === 'Sequential — in this mission')!;
    await r.click(sequential);
    const header = r.headers()[0]!;
    await r.click(header);
    assert.equal(r.pickersIn(r.panel(header)!).length, 0);
    assert.equal(r.panel(header)!.querySelectorAll('button[data-group-mode]').length, 0);
    assert.match(r.panel(header)!.textContent!, /no per-group model/);
  } finally { await r.unmount(); }
});

test('the inherit entry of a picker takes a setting back: the answer is the untouched one again', async () => {
  const r = await mount({ kind: 'series_plan', chantier: 'Job', volets: [{ title: 'A' }] });
  try {
    const codeMain = r.pickersIn(document.body).filter((s) => s.title === 'Primary model')[0]!;
    await r.choose(codeMain, 'Opus');
    await r.launch();
    assert.deepEqual(r.answers[0]!.roles, { code: { backend: 'claude', model: 'opus' } });
    await r.openMenu(codeMain);
    const inherit = r.options()[0]!;
    assert.equal(inherit.textContent, 'inherit project role');
    await r.click(inherit);
    assert.equal(codeMain.textContent, 'inherit project role');
    await r.launch();
    assert.deepEqual(r.answers[1], { mode: 'kanban-full', roles: {}, note: undefined });
  } finally { await r.unmount(); }
});

test('a role points to a subscription account by its instance id; an account to sign in again is listed but not pickable', async () => {
  const r = await mount({ kind: 'series_plan', chantier: 'Job', volets: [{ title: 'A' }] });
  try {
    // The orchestrator row only has its fallback picker; the coder row comes next.
    const [codeMain, codeFallback] = r.pickersIn(document.body).slice(1);
    assert.equal(codeMain!.title, 'Primary model');
    await r.choose(codeMain!, 'Opus', 'Anthropic · KRZDIGITAL');
    assert.equal(codeMain!.querySelector('span[title]')!.getAttribute('title'), 'Anthropic · KRZDIGITAL / Opus');
    await r.openMenu(codeFallback!);
    const personal = r.rail().find((b) => b.getAttribute('aria-label') === 'Anthropic · Perso')!;
    assert.ok(personal, 'the account to sign in again stays on the rail');
    await r.click(personal);
    const rows = r.options().slice(1);
    assert.deepEqual(rows.map((o) => [r.optionLabel(o), o.disabled]), [['Opus', true]]);
    await r.closeMenu();
    await r.launch();
    assert.deepEqual(r.answers[0]!.roles, { code: { backend: 'claude@krz', model: 'opus' } });
  } finally { await r.unmount(); }
});

/** A `Storage` that outlives one jsdom window: the tab's sessionStorage across a reload. */
function tabStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
  };
}

const modeTile = (title: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).find((b) => b.title === title)!;

test('TODO #515: a reload of a pending plan card gives back the mode, the models, the group settings and the note', async () => {
  const storage = tabStorage();
  const long = 'Merge volet 2 before volet 3.\nKeep the migration out of tonight.';
  let r = await mount(grouped, { missionId: 'm1', storage });
  try {
    await r.click(modeTile('Kanban — code only, merge as you go'));
    // The general Coder row: the first primary-model picker (Orchestrator has none).
    await r.choose(r.pickersIn(document.body).filter((p) => p.title === 'Primary model')[0]!, 'GPT-5.5');
    const header = r.headers()[1]!;
    await r.click(header);
    await r.click(r.modeButton(header, 'override'));
    await r.type(document.querySelector('textarea')!, long);
  } finally { await r.unmount(); }

  r = await mount(grouped, { missionId: 'm1', storage });
  try {
    assert.equal(modeTile('Kanban — code only, merge as you go').getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('textarea')!.value, long);
    assert.equal(r.headers()[1]!.closest('section')!.getAttribute('data-group-state'), 'custom');
    await r.launch();
    assert.deepEqual(r.answers[0], {
      mode: 'kanban-code-self',
      roles: { code: { backend: 'codex', model: 'gpt-5.5' } },
      note: long,
    });
  } finally { await r.unmount(); }

  // Sent: the next card of the same plan starts fresh.
  r = await mount(grouped, { missionId: 'm1', storage });
  try {
    assert.equal(modeTile('Kanban — code only, merge as you go').getAttribute('aria-pressed'), 'false');
    assert.equal(document.querySelector('textarea')!.value, '');
  } finally { await r.unmount(); }
});

test('TODO #515: a plan the daemon did not receive keeps its draft; another mission or another plan starts empty', async () => {
  const storage = tabStorage();
  let r = await mount(grouped, { missionId: 'm1', storage, delivered: false });
  try {
    await r.type(document.querySelector('textarea')!, 'keep me');
    await r.launch();
  } finally { await r.unmount(); }

  r = await mount(grouped, { missionId: 'm1', storage });
  try { assert.equal(document.querySelector('textarea')!.value, 'keep me'); } finally { await r.unmount(); }
  r = await mount(grouped, { missionId: 'm2', storage });
  try { assert.equal(document.querySelector('textarea')!.value, ''); } finally { await r.unmount(); }
  r = await mount({ ...grouped, chantier: 'Another job' }, { missionId: 'm1', storage });
  try { assert.equal(document.querySelector('textarea')!.value, ''); } finally { await r.unmount(); }
});

/* The branch field: every project, a new branch or an existing one, and where it ends up. */
const landed = (landing: NonNullable<SeriesPlanFormPayload['landing']>): SeriesPlanFormPayload => ({
  kind: 'series_plan', chantier: 'Branch job', volets: [{ title: 'A' }], landing,
});
const LANDING = { project: 'acme', prefix: 'feat/', branch: 'feat/branch-job', base_ref: 'origin/main', locked: false };
const BRANCHES = [
  { name: 'feat/kanban-pr-landing', committed_at: 3 },
  { name: 'main', committed_at: 2 },
  { name: 'fix/old', committed_at: 1 },
];
const PR_LANDING = { ...LANDING, mode: 'pr' as const, target: 'main', kind: 'new' as const, finish: 'merge' as const, branches: BRANCHES };
const LOCAL_LANDING = { ...PR_LANDING, mode: 'local' as const, base_ref: 'main' };
const branchSection = () => document.querySelector<HTMLElement>('[data-testid="plan-branch"]');
const branchHeader = () => branchSection()!.querySelector('button')!;
const branchInput = () => branchSection()!.querySelector<HTMLInputElement>('[data-testid="plan-branch-input"]')!;
const segment = (group: 'plan-branch-kind' | 'plan-finish', value: string) =>
  branchSection()!.querySelector<HTMLButtonElement>(`[data-testid="${group}"] button[data-value="${value}"]`)!;
const listed = () => Array.from(branchSection()!.querySelectorAll<HTMLButtonElement>('[data-testid="plan-branch-list"] [role="option"]'));
const summary = () => `${branchSection()!.querySelector('[data-testid="plan-branch-summary"]')!.textContent} ${branchSection()!.querySelector('[data-testid="plan-finish-summary"]')!.textContent}`;
const launchButton = () => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Launch')!;

async function typeTopic(r: Awaited<ReturnType<typeof mount>>, value: string, input: HTMLInputElement = branchInput()) {
  const React = await import('react');
  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(r.window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new r.window.Event('input', { bubbles: true }));
  });
}

test('a job without a project shows no branch field and sends no branch', async () => {
  const r = await mount({ kind: 'series_plan', chantier: 'Job', volets: [{ title: 'A' }] });
  try {
    assert.equal(branchSection(), null);
    await r.launch();
    assert.equal('branch' in r.answers[0]!, false);
    assert.equal('finish' in r.answers[0]!, false);
  } finally { await r.unmount(); }
});

test('a project that merges locally gets the field too: a new branch merged into its target by default', async () => {
  const r = await mount(landed(LOCAL_LANDING));
  try {
    assert.equal(branchHeader().getAttribute('aria-expanded'), 'false');
    assert.equal(summary(), 'feat/branch-job · merged into main');
    await r.click(branchHeader());
    assert.equal(segment('plan-branch-kind', 'new').getAttribute('aria-pressed'), 'true');
    assert.equal(branchSection()!.querySelector('[data-testid="plan-branch-prefix"]')!.textContent, 'feat/');
    assert.equal(segment('plan-finish', 'merge').textContent, 'Merge into main');
    assert.equal(segment('plan-finish', 'merge').getAttribute('aria-pressed'), 'true');
    assert.ok(!branchSection()!.querySelector('[data-testid="plan-resolves-issues"]'), 'no pull request, no issues to close');
    await r.launch();
    assert.deepEqual(r.answers[0]!.branch, { kind: 'new', name: 'feat/branch-job' });
    assert.equal(r.answers[0]!.finish, 'merge');
    assert.equal('resolves_issues' in r.answers[0]!, false);
  } finally { await r.unmount(); }
});

test('a pull request project folds the branch under Advanced, prefix shown, and sends the full name', async () => {
  branchChecks.length = 0;
  const r = await mount(landed(PR_LANDING));
  try {
    assert.match(branchHeader().textContent!, /^Advanced.*feat\/branch-job.*· PR to main$/);
    await r.click(branchHeader());
    assert.equal(branchSection()!.querySelector('[data-testid="plan-branch-prefix"]')!.textContent, 'feat/');
    assert.equal(branchInput().value, 'branch-job');
    assert.equal(segment('plan-finish', 'merge').textContent, 'Open a PR to main');
    await r.launch();
    assert.deepEqual(r.answers[0]!.branch, { kind: 'new', name: 'feat/branch-job' });
    assert.equal(r.answers[0]!.finish, 'merge');
    assert.deepEqual(branchChecks, [], 'the proposal judged at opening is not checked again');
  } finally { await r.unmount(); }
});

test('a payload without mode nor target reads as the pull request project it was', async () => {
  const r = await mount(landed(LANDING));
  try {
    assert.equal(summary(), 'feat/branch-job · PR to main');
    await r.click(branchHeader());
    assert.ok(branchSection()!.querySelector('[data-testid="plan-resolves-issues"]'));
  } finally { await r.unmount(); }
});

test('a sequential mode keeps the branch field: the job lands the same way', async () => {
  const r = await mount(landed(PR_LANDING));
  try {
    const sequential = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).find((b) => b.title === 'Sequential — in this mission')!;
    await r.click(sequential);
    assert.ok(branchSection());
    await r.launch();
    assert.equal(r.answers[0]!.mode, 'sequential-here');
    assert.deepEqual(r.answers[0]!.branch, { kind: 'new', name: 'feat/branch-job' });
  } finally { await r.unmount(); }
});

test('a typed name goes to the daemon: its refusal shows under the field and blocks the launch; its numbering is shown', async () => {
  branchChecks.length = 0;
  branchRoute = (branch) => (branch.includes('timon')
    ? Response.json({ error: 'reserved', code: 'plan_branch_refused', params: { detail: 'reserved for Timon' }, ok: false, refusal: 'reserved for Timon' }, { status: 400 })
    : Response.json({ ok: true, branch: `${branch}-2` }));
  const r = await mount(landed(PR_LANDING));
  const React = await import('react');
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  try {
    await r.click(branchHeader());
    await typeTopic(r, 'timon-thing');
    await until(() => branchSection()!.querySelector('[data-testid="plan-branch-error"]') !== null, 'the refusal to show');
    assert.match(branchSection()!.querySelector('[data-testid="plan-branch-error"]')!.textContent!, /reserved for Timon/);
    assert.equal(branchInput().getAttribute('aria-invalid'), 'true');
    assert.equal(launchButton().disabled, true);
    assert.deepEqual(branchChecks.map((c) => [c.branch, c.kind]), [['feat/timon-thing', 'new']]);
    await typeTopic(r, 'taken');
    await until(() => /Created as feat\/taken-2/.test(branchSection()!.textContent!), 'the numbered name to show');
    assert.equal(launchButton().disabled, false);
    await r.launch();
    assert.deepEqual(r.answers[0]!.branch, { kind: 'new', name: 'feat/taken' });
  } finally { await r.unmount(); }
});

test('an empty name or a refused proposal opens the field with its error', async () => {
  const r = await mount(landed({ ...PR_LANDING, branch: 'feat/fix-bfd1c111de16', refusal: 'it carries an id' }));
  try {
    assert.equal(branchHeader().getAttribute('aria-expanded'), 'true');
    assert.match(branchSection()!.querySelector('[data-testid="plan-branch-error"]')!.textContent!, /it carries an id/);
    assert.equal(launchButton().disabled, true);
  } finally { await r.unmount(); }
  const unnamed = await mount(landed({ ...PR_LANDING, branch: 'feat/<topic>' }));
  try {
    assert.equal(branchInput().value, '');
    assert.match(branchSection()!.querySelector('[data-testid="plan-branch-error"]')!.textContent!, /Name the branch/);
  } finally { await unnamed.unmount(); }
});

test('"Existing" lists the repository\'s branches but the target, checks the pick and sends it as it is', async () => {
  for (const landing of [LOCAL_LANDING, PR_LANDING]) {
    branchChecks.length = 0;
    branchRoute = (branch, kind) => (branch === 'fix/old'
      ? Response.json({ error: 'landed', code: 'plan_branch_refused', params: { detail: 'fix/old already landed in main' } }, { status: 400 })
      : Response.json({ ok: true, branch, kind }));
    const r = await mount(landed(landing));
    const React = await import('react');
    const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
    try {
      await r.click(branchHeader());
      await r.click(segment('plan-branch-kind', 'existing'));
      assert.equal(segment('plan-branch-kind', 'existing').getAttribute('aria-pressed'), 'true');
      assert.deepEqual(listed().map((o) => o.textContent), ['feat/kanban-pr-landing', 'fix/old'], 'newest first, never the target');
      assert.ok(!branchSection()!.querySelector('[data-testid="plan-branch-search"]'), 'a short list needs no search');
      assert.match(branchSection()!.querySelector('[data-testid="plan-branch-error"]')!.textContent!, /Pick the branch/);
      assert.equal(launchButton().disabled, true, 'nothing picked yet');
      await r.click(listed()[1]!);
      await until(() => branchSection()!.querySelector('[data-testid="plan-branch-error"]')?.textContent?.includes('already landed') === true, 'the refusal to show');
      assert.equal(launchButton().disabled, true);
      await r.click(listed()[0]!);
      await until(() => !launchButton().disabled, 'the pick to be accepted');
      assert.equal(listed()[0]!.getAttribute('aria-selected'), 'true');
      assert.deepEqual(branchChecks.map((c) => [c.branch, c.kind]), [['fix/old', 'existing'], ['feat/kanban-pr-landing', 'existing']]);
      assert.match(summary(), /^feat\/kanban-pr-landing · /);
      await r.launch();
      assert.deepEqual(r.answers[0]!.branch, { kind: 'existing', name: 'feat/kanban-pr-landing' });
    } finally { await r.unmount(); }
  }
});

test('a long branch list gets a search field; an empty one says so', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `feat/topic-${i}`, committed_at: 100 - i }));
  const r = await mount(landed({ ...LOCAL_LANDING, branches: [...many, { name: 'fix/needle', committed_at: 1 }] }));
  try {
    await r.click(branchHeader());
    await r.click(segment('plan-branch-kind', 'existing'));
    assert.equal(listed().length, 13);
    const search = branchSection()!.querySelector<HTMLInputElement>('[data-testid="plan-branch-search"]')!;
    await typeTopic(r, 'NEED', search);
    assert.deepEqual(listed().map((o) => o.textContent), ['fix/needle']);
    await typeTopic(r, 'nothing-like-it', search);
    assert.equal(listed().length, 0);
    assert.match(branchSection()!.textContent!, /No branch matches/);
  } finally { await r.unmount(); }
  const none = await mount(landed({ ...LOCAL_LANDING, branches: [{ name: 'main', committed_at: 1 }] }));
  try {
    await none.click(branchHeader());
    await none.click(segment('plan-branch-kind', 'existing'));
    assert.match(branchSection()!.querySelector('[data-testid="plan-branch-none"]')!.textContent!, /no other branch/);
    assert.equal(launchButton().disabled, true);
  } finally { await none.unmount(); }
});

test('"Keep on the branch" is sent, said in the summary, and drops the issues box', async () => {
  for (const [landing, merged] of [[LOCAL_LANDING, 'merged into main'], [PR_LANDING, 'PR to main']] as const) {
    const r = await mount(landed(landing));
    try {
      await r.click(branchHeader());
      assert.equal(summary(), `feat/branch-job · ${merged}`);
      if (landing.mode === 'pr') await r.click(branchSection()!.querySelector<HTMLInputElement>('[data-testid="plan-resolves-issues"]')!);
      await r.click(segment('plan-finish', 'keep'));
      assert.equal(segment('plan-finish', 'keep').getAttribute('aria-pressed'), 'true');
      assert.equal(summary(), 'feat/branch-job · kept on the branch');
      assert.ok(!branchSection()!.querySelector('[data-testid="plan-resolves-issues"]'));
      await r.launch();
      assert.equal(r.answers[0]!.finish, 'keep');
      assert.equal('resolves_issues' in r.answers[0]!, false, 'no pull request, nothing to close');
    } finally { await r.unmount(); }
  }
});

test('a branch the job already started from is read-only, its kind fixed, and sent back as it is', async () => {
  for (const landing of [PR_LANDING, LOCAL_LANDING]) {
    const r = await mount(landed({ ...landing, branch: 'feat/started', locked: true, finish: 'keep' }));
    try {
      await r.click(branchHeader());
      assert.equal(branchInput().readOnly, true);
      assert.equal(branchInput().value, 'feat/started');
      assert.equal(segment('plan-branch-kind', 'new').disabled, true);
      assert.equal(segment('plan-branch-kind', 'existing').disabled, true);
      assert.match(branchSection()!.textContent!, /already started from this branch/);
      assert.equal(summary(), 'feat/started · kept on the branch', 'the destination the series chose');
      await r.click(segment('plan-finish', 'merge'));
      await r.launch();
      // The daemon keeps the kind it recorded; a local project needs the name to keep the job on its branch.
      assert.deepEqual(r.answers[0]!.branch, { kind: 'existing', name: 'feat/started' });
      assert.equal(r.answers[0]!.finish, 'merge');
    } finally { await r.unmount(); }
  }
});

test('"Resolves its issues entirely" sits under Advanced, only for a pull request, off by default, and is sent only when ticked', async () => {
  const r = await mount(landed(PR_LANDING));
  try {
    await r.launch();
    assert.equal('resolves_issues' in r.answers[0]!, false, 'untouched, the answer is the previous one');
  } finally { await r.unmount(); }
  const ticked = await mount(landed(PR_LANDING));
  try {
    await ticked.click(branchHeader());
    const box = branchSection()!.querySelector<HTMLInputElement>('[data-testid="plan-resolves-issues"]')!;
    assert.equal(box.checked, false);
    assert.match(box.closest('div')!.textContent!, /Resolves its issues entirely/);
    const resolves = () => branchSection()!.querySelector('[data-testid="plan-resolves-summary"]');
    assert.ok(!resolves(), 'unticked, the summary says nothing of it');
    await ticked.click(box);
    // Folded again, the summary still shows the box is ticked.
    await ticked.click(branchHeader());
    assert.ok(!branchSection()!.querySelector('[data-testid="plan-resolves-issues"]'), 'folded');
    assert.equal(resolves()?.textContent, 'resolves its issues');
    await ticked.launch();
    assert.equal(ticked.answers[0]!.resolves_issues, true);
  } finally { await ticked.unmount(); }
});

test('the session draft keeps the kind of branch, the pick and the destination', async () => {
  const storage = tabStorage();
  branchRoute = (branch) => Response.json({ ok: true, branch });
  let r = await mount(landed(LOCAL_LANDING), { missionId: 'm1', storage });
  const React = await import('react');
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  try {
    await r.click(branchHeader());
    await r.click(segment('plan-branch-kind', 'existing'));
    await r.click(listed()[0]!);
    await r.click(segment('plan-finish', 'keep'));
  } finally { await r.unmount(); }

  r = await mount(landed(LOCAL_LANDING), { missionId: 'm1', storage });
  try {
    assert.equal(summary(), 'feat/kanban-pr-landing · kept on the branch');
    await until(() => !launchButton().disabled, 'the restored pick to be checked again');
    await r.launch();
    assert.deepEqual(r.answers[0]!.branch, { kind: 'existing', name: 'feat/kanban-pr-landing' });
    assert.equal(r.answers[0]!.finish, 'keep');
  } finally { await r.unmount(); }
});
