import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  BROWSER_ANNOTATE_EVENT_CHANNEL, BROWSER_ANNOTATE_PICK_AT_CHANNEL, BROWSER_ANNOTATE_STATE_CHANNEL, BROWSER_ANNOTATE_TOGGLE_CHANNEL,
  BROWSER_PROMPT_CHANNEL, BROWSER_RECORD_EVENT_CHANNEL, BROWSER_RECORD_STATE_CHANNEL, BROWSER_RECORD_TOGGLE_CHANNEL,
} from './native-browser-protocol.js';
import { BROWSER_ANNOTATE_TRACK_CHANNEL } from './native-browser-bubble.js';
import { SECRET_AUTOCOMPLETE_PATTERN, SECRET_INPUT_TYPES } from './native-browser-recorder.js';
import { CHROME_SHIM_SOURCE } from './native-browser-chrome-shim.js';

const source = await readFile(new URL('./native-browser-preload.cts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY']);

/** Just enough DOM for the recorder and the annotator: attributes, ancestry, values, and a clone. */
class FakeElement {
  id = '';
  parentElement: FakeElement | null = null;
  previousElementSibling: FakeElement | null = null;
  nextElementSibling: FakeElement | null = null;
  children: FakeElement[] = [];
  innerText = '';
  textContent = '';
  isContentEditable = false;
  labels: Array<{ textContent: string }> | null = null;
  type = '';
  checked = false;
  valueReads = 0;
  classList: string[] = [];
  rect = { x: 10, y: 20, width: 100, height: 30 };
  isConnected = true;
  private storedValue = '';
  constructor(readonly nodeName: string, readonly attributes: Record<string, string> = {}) {}
  get value(): string { this.valueReads++; return this.storedValue; }
  set value(value: string) { this.storedValue = value; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  hasAttribute(name: string): boolean { return name in this.attributes; }
  getAttributeNames(): string[] { return Object.keys(this.attributes); }
  removeAttribute(name: string): void { delete this.attributes[name]; }
  getBoundingClientRect() { return { ...this.rect }; }
  closest(): FakeElement | null {
    for (let element: FakeElement | null = this; element; element = element.parentElement) {
      if (INTERACTIVE_TAGS.has(element.nodeName) || element.attributes.role) return element;
    }
    return null;
  }
  append(...children: FakeElement[]): this {
    for (const child of children) {
      const last = this.children.at(-1);
      if (last) { last.nextElementSibling = child; child.previousElementSibling = last; }
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }
  remove(): void {
    const parent = this.parentElement;
    if (parent) parent.children = parent.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  private descendants(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  getElementsByTagName(): FakeElement[] { return this.descendants(); }
  querySelectorAll(selector: string): FakeElement[] {
    const tags = selector === '*' ? null : new Set(selector.split(',').map((tag) => tag.trim().toUpperCase()));
    return this.descendants().filter((element) => !tags || tags.has(element.nodeName));
  }
  cloneNode(deep: boolean): FakeElement {
    const clone = new (this.constructor as typeof FakeElement)(this.nodeName, { ...this.attributes });
    clone.textContent = this.textContent;
    if (deep) clone.append(...this.children.map((child) => child.cloneNode(true)));
    return clone;
  }
  get outerHTML(): string {
    const tag = this.nodeName.toLowerCase();
    const attributes = Object.entries(this.attributes).map(([name, value]) => ` ${name}="${value}"`).join('');
    return `<${tag}${attributes}>${this.children.length ? this.children.map((child) => child.outerHTML).join('') : this.textContent}</${tag}>`;
  }
}
class FakeSelect extends FakeElement {
  selectedOptions: Array<{ textContent: string }> = [];
}

function input(attributes: Record<string, string>, value = '', type = attributes.type ?? 'text'): FakeElement {
  const element = new FakeElement('INPUT', attributes);
  element.type = type;
  element.value = value;
  element.valueReads = 0;
  return element;
}

interface FakeEvent {
  type: string; isTrusted: boolean; composedPath(): unknown[]; key?: string; isComposing?: boolean;
  button?: number; detail?: number; clientX?: number; clientY?: number; cancelable?: boolean;
  changedTouches?: Array<{ clientX: number; clientY: number }>;
  stopped: boolean; prevented: boolean; stopImmediatePropagation(): void; preventDefault(): void;
}

function load(initialState: unknown = false, annotateState: unknown = false) {
  const capabilities = new Map<string, (...args: unknown[]) => unknown>();
  const syncCalls: unknown[][] = [];
  const mainWorld: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const annotated: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, Array<{ listener: (event: unknown) => void; options: unknown }>>();
  const ipcListeners = new Map<string, (event: unknown, value: unknown) => void>();
  const document = { getElementById: () => null, documentElement: null as FakeElement | null, elementFromPoint: (): FakeElement | null => null };
  runInNewContext(compiled, {
    exports: {},
    require: (name: string) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key: string, value: (...args: unknown[]) => unknown) => capabilities.set(key, value) },
        webFrame: { executeJavaScript: (code: string) => { mainWorld.push(code); return Promise.resolve(); } },
        ipcRenderer: {
          sendSync: (...args: unknown[]) => {
            syncCalls.push(args);
            return args[0] === BROWSER_RECORD_STATE_CHANNEL ? initialState : args[0] === BROWSER_ANNOTATE_STATE_CHANNEL ? annotateState : 'answer';
          },
          send: (channel: string, payload: Record<string, unknown>) => {
            if (channel === BROWSER_ANNOTATE_EVENT_CHANNEL) { annotated.push(payload); return; }
            assert.equal(channel, BROWSER_RECORD_EVENT_CHANNEL);
            sent.push(payload);
          },
          on: (channel: string, listener: (event: unknown, value: unknown) => void) => ipcListeners.set(channel, listener),
        },
      };
    },
    window: {
      innerWidth: 1366, innerHeight: 768, scrollX: 0, scrollY: 250,
      addEventListener: (type: string, listener: (event: unknown) => void, options: unknown) => {
        const capture = typeof options === 'object' && options ? (options as { capture?: unknown }).capture : options;
        assert.equal(capture, true, `${type} listens in capture`);
        listeners.set(type, [...listeners.get(type) ?? [], { listener, options }]);
      },
    },
    document,
    CSS: { escape: (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '\\$&') },
    Element: FakeElement,
    HTMLSelectElement: FakeSelect,
    WeakRef, setTimeout, setInterval, clearInterval,
  });
  const event = (type: string, target: FakeElement, extra: Record<string, unknown> = {}): FakeEvent => {
    const fake: FakeEvent = { type, isTrusted: true, composedPath: () => [target], cancelable: true, stopped: false, prevented: false,
      stopImmediatePropagation: () => { fake.stopped = true; }, preventDefault: () => { fake.prevented = true; }, ...extra };
    return fake;
  };
  const dispatch = (type: string, target: FakeElement, extra: Record<string, unknown> = {}) => {
    const fake = event(type, target, extra);
    for (const { listener } of listeners.get(type) ?? []) {
      listener(fake);
      if (fake.stopped) break;
    }
    return fake;
  };
  const toggle = (active: unknown) => ipcListeners.get(BROWSER_RECORD_TOGGLE_CHANNEL)!({}, active);
  const annotate = (active: unknown) => ipcListeners.get(BROWSER_ANNOTATE_TOGGLE_CHANNEL)!({}, active);
  const pickAt = (request: unknown) => ipcListeners.get(BROWSER_ANNOTATE_PICK_AT_CHANNEL)!({}, request);
  const track = (anchors: unknown) => ipcListeners.get(BROWSER_ANNOTATE_TRACK_CHANNEL)!({}, anchors);
  return { capabilities, syncCalls, mainWorld, sent, annotated, listeners, dispatch, toggle, annotate, pickAt, track, document };
}

test('browser preload exposes only the synchronous prompt capability to the page', () => {
  const { capabilities, syncCalls, listeners } = load();
  assert.deepEqual([...capabilities.keys()], ['__timonNativePrompt']);
  assert.equal(capabilities.get('__timonNativePrompt')!('Question', 'Default'), 'answer');
  assert.deepEqual(syncCalls, [[BROWSER_RECORD_STATE_CHANNEL], [BROWSER_ANNOTATE_STATE_CHANNEL], [BROWSER_PROMPT_CHANNEL, 'Question', 'Default']]);
  assert.deepEqual([...listeners.keys()].sort(), ['auxclick', 'change', 'click', 'contextmenu', 'dblclick', 'input', 'keydown', 'keyup',
    'mousedown', 'mouseup', 'pointerdown', 'pointermove', 'pointerup', 'resize', 'scroll', 'touchcancel', 'touchend', 'touchmove', 'touchstart']);
});

test('the main frame runs the window.chrome shim, the very copy of native-browser-chrome-shim.ts, once', () => {
  const { mainWorld } = load();
  assert.equal(mainWorld.length, 1);
  assert.equal(mainWorld[0], CHROME_SHIM_SOURCE);
});

test('the recorder stays silent until the main process turns it on, and stops when turned off', () => {
  const { sent, dispatch, toggle } = load();
  const button = new FakeElement('BUTTON', { id: 'buy' });
  button.id = 'buy';
  button.innerText = 'Buy now';
  dispatch('click', button);
  assert.deepEqual(sent, []);
  toggle(true);
  dispatch('click', button);
  assert.equal(sent.length, 1);
  assert.deepEqual({ ...sent[0] }, { type: 'click', selector: 'button#buy', tag: 'button', inputType: '', autocomplete: '',
    role: 'button', name: 'Buy now', text: 'Buy now' });
  toggle('yes');
  dispatch('click', button);
  assert.equal(sent.length, 1, 'only a literal true turns it on');
});

test('a new document reads the recording state before its first event', () => {
  const { sent, dispatch } = load(true);
  dispatch('keydown', input({ name: 'q' }), { key: 'Enter' });
  assert.equal(sent[0]!.type, 'enter');
  const notTrue = load('true');
  notTrue.dispatch('keydown', input({ name: 'q' }), { key: 'Enter' });
  assert.deepEqual(notTrue.sent, []);
});

test('events the page dispatches itself (isTrusted=false) are dropped', () => {
  const { sent, dispatch } = load(true);
  const field = input({ name: 'q' }, 'shoes');
  for (const type of ['click', 'change', 'keydown']) dispatch(type, field, { isTrusted: false, key: 'Enter' });
  assert.deepEqual(sent, []);
  assert.equal(field.valueReads, 0);
});

test('the value of a secret field is never read, by type or by autocomplete token list', () => {
  const { sent, dispatch } = load(true);
  for (const field of [input({ name: 'pw', type: 'password' }, 'hunter2'),
    input({ name: 'login', autocomplete: 'username current-password' }, 'hunter2'),
    input({ name: 'code', autocomplete: 'section-login one-time-code' }, '123456'),
    input({ name: 'cc', autocomplete: 'CC-NUMBER' }, '4111111111111111')]) {
    dispatch('change', field);
    dispatch('click', field);
    assert.equal(field.valueReads, 0, field.attributes.name);
  }
  assert.deepEqual(sent.filter((event) => event.type === 'input').map((event) => event.value),
    ['{SECRET:pw}', '{SECRET:login}', '{SECRET:code}', '{SECRET:cc}']);
  assert.ok(!JSON.stringify(sent).includes('hunter2'));
});

test('a password revealed by a "show" toggle before its change stays a secret', () => {
  const { sent, dispatch } = load(true);
  const field = input({ name: 'pw' }, 'hunter2', 'password');
  dispatch('input', field);
  field.type = 'text';
  dispatch('change', field);
  assert.equal(sent[0]!.value, '{SECRET:pw}');
  assert.equal(field.valueReads, 0);
});

test('a click never reads the value of a field, a textarea, a select or an editor', () => {
  const { sent, dispatch } = load(true);
  const text = input({ name: 'q' }, 'what I typed');
  const area = new FakeElement('TEXTAREA', { name: 'notes' });
  area.value = 'what I typed'; area.valueReads = 0; area.innerText = 'what I typed';
  const select = new FakeSelect('SELECT', { name: 'size' });
  select.innerText = 'S M L';
  const editor = new FakeElement('DIV', { class: 'editor' });
  editor.isContentEditable = true;
  editor.innerText = 'what I typed';
  for (const element of [text, area, select, editor]) dispatch('click', element);
  assert.equal(text.valueReads + area.valueReads, 0);
  assert.ok(sent.every((event) => event.text === ''), JSON.stringify(sent));
  assert.ok(!JSON.stringify(sent).includes('what I typed'));
});

test('a click on an input button keeps its label; a click inside a button reports the button', () => {
  const { sent, dispatch } = load(true);
  dispatch('click', input({ type: 'submit' }, 'Sign in', 'submit'));
  const button = new FakeElement('BUTTON', { 'aria-label': 'Close' });
  button.type = 'button';
  const icon = new FakeElement('SPAN');
  icon.parentElement = button;
  dispatch('click', icon);
  assert.deepEqual(sent.map((event) => [event.tag, event.text, event.role, event.name]),
    [['input', 'Sign in', 'button', ''], ['button', '', 'button', 'Close']]);
  assert.equal(sent[1]!.selector, 'button[aria-label="Close"]');
});

test('ordinary changes ship their value; checkboxes their state; selects their option; files nothing', () => {
  const { sent, dispatch } = load(true);
  dispatch('change', input({ name: 'user' }, 'alice'));
  const box = input({ name: 'terms', type: 'checkbox' }, 'on', 'checkbox');
  box.checked = true;
  dispatch('change', box);
  const select = new FakeSelect('SELECT', { name: 'size' });
  select.value = 'm';
  select.selectedOptions = [{ textContent: ' Medium ' }];
  dispatch('change', select);
  const file = input({ name: 'doc', type: 'file' }, 'C:\\fakepath\\passport.pdf', 'file');
  dispatch('change', file);
  assert.deepEqual(sent.map((event) => [event.value, event.text]),
    [['alice', undefined], ['checked', undefined], ['m', 'Medium'], [undefined, undefined]]);
  assert.equal(file.valueReads, 0);
  assert.equal(sent[0]!.selector, 'input[name="user"]');
});

test('only Enter is recorded among keys, not while an IME composes', () => {
  const { sent, dispatch } = load(true);
  const field = input({ name: 'q' });
  dispatch('keydown', field, { key: 'a' });
  dispatch('keydown', field, { key: 'Enter', isComposing: true });
  dispatch('keydown', field, { key: 'Enter' });
  assert.deepEqual(sent.map((event) => event.type), ['enter']);
});

test('the preload copies the exact secret rule of native-browser-recorder.ts', () => {
  const pattern = /const SECRET_AUTOCOMPLETE = new RegExp\('([^']+)', 'i'\);/.exec(source);
  assert.ok(pattern, 'the preload declares its secret autocomplete pattern as one literal');
  assert.equal(JSON.parse(`"${pattern[1]}"`), SECRET_AUTOCOMPLETE_PATTERN);
  const types = /const SECRET_TYPES = (\[[^\]]*\]);/.exec(source);
  assert.ok(types);
  assert.deepEqual(JSON.parse(types[1]!.replaceAll("'", '"')), [...SECRET_INPUT_TYPES]);
});

// ---- Annotator (TODO #468) ------------------------------------------------------------------------

// Objects built in the vm realm: compare them as plain data.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const GESTURES = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu',
  'touchstart', 'touchmove', 'touchend', 'touchcancel'];

test('every pointer and touch gesture is swallowed in capture, non-passive, only while annotating', () => {
  const { listeners, dispatch, annotate } = load();
  for (const type of GESTURES) {
    const swallow = listeners.get(type)!.at(-1)!;
    assert.deepEqual({ ...swallow.options as object }, { capture: true, passive: false }, type);
  }
  const button = new FakeElement('BUTTON');
  for (const type of GESTURES) {
    const event = dispatch(type, button, { button: 0, detail: 1, changedTouches: [] });
    assert.deepEqual([event.stopped, event.prevented], [false, false], `${type} reaches the page when idle`);
  }
  annotate(true);
  for (const type of GESTURES) {
    const event = dispatch(type, button, { button: type === 'auxclick' || type === 'contextmenu' ? 2 : 0, detail: 2, changedTouches: [] });
    assert.deepEqual([event.stopped, event.prevented], [true, true], `${type} is swallowed`);
  }
  const passive = dispatch('touchmove', button, { cancelable: false });
  assert.deepEqual([passive.stopped, passive.prevented], [true, false], 'a non-cancelable event is still stopped');
  annotate('true');
  assert.equal(dispatch('click', button, { button: 0, detail: 1 }).stopped, false, 'only a literal true turns it on');
});

test('what the page dispatches itself is neither swallowed nor picked', () => {
  const { dispatch, annotated } = load(false, true);
  const event = dispatch('click', new FakeElement('BUTTON'), { isTrusted: false, button: 0, detail: 1 });
  assert.deepEqual([event.stopped, event.prevented], [false, false]);
  assert.deepEqual(annotated, []);
});

test('a left click picks the exact element; right, middle and double clicks pick nothing', () => {
  const { dispatch, annotated, document } = load(false, true);
  const html = new FakeElement('HTML');
  const body = new FakeElement('BODY');
  const main = new FakeElement('MAIN', { class: 'shop' });
  const first = new FakeElement('SPAN');
  const icon = new FakeElement('SPAN', { class: 'icon' });
  icon.classList = ['icon'];
  icon.innerText = 'Cart';
  html.append(body.append(main.append(first, new FakeElement('BUTTON', { 'aria-label': 'Cart' }).append(icon))));
  document.documentElement = html;
  for (const [type, button, detail] of [['auxclick', 1, 1], ['contextmenu', 2, 1], ['auxclick', 2, 1], ['click', 0, 2]] as const) {
    dispatch(type, icon, { button, detail });
  }
  assert.deepEqual(annotated, []);
  dispatch('click', icon, { button: 0, detail: 1, clientX: 44, clientY: 33 });
  assert.equal(annotated.length, 1);
  const picked = annotated[0]!;
  assert.deepEqual(plain({ type: picked.type, point: picked.point, tag: picked.tag, text: picked.text, xpath: picked.xpath,
    classes: picked.classes, rect: picked.rect, viewport: picked.viewport, scroll: picked.scroll }),
  { type: 'pick', point: { x: 44, y: 33 }, tag: 'span', text: 'Cart', xpath: '/html[1]/body[1]/main[1]/button[1]/span[1]',
    classes: ['icon'], rect: { x: 10, y: 20, width: 100, height: 30 }, viewport: { width: 1366, height: 768 }, scroll: { x: 0, y: 250 } });
  assert.equal(picked.selector, 'html > body > main > button[aria-label="Cart"] > span');
  assert.equal(picked.outerHtml, '<span class="icon"></span>');
  dispatch('click', icon, { button: 0, detail: 1, clientX: 44, clientY: 33 });
  assert.equal(annotated.length, 1, 'a second click within 400 ms is the same gesture');
});

test('a tap picks from its touch point; a keyboard click points at the element', async () => {
  const { dispatch, annotated } = load(false, true);
  const button = new FakeElement('BUTTON');
  dispatch('touchend', button, { changedTouches: [{ clientX: 7, clientY: 9 }] });
  assert.deepEqual({ ...annotated[0]!.point as object }, { x: 7, y: 9 });
  await new Promise((resolve) => setTimeout(resolve, 420));
  dispatch('click', button, { button: 0, detail: 0, clientX: 0, clientY: 0 });
  assert.deepEqual({ ...annotated[1]!.point as object }, { x: 60, y: 35 });
});

test('a pick never reads a field value and strips scripts, styles and values from the markup', () => {
  const { dispatch, annotated } = load(false, true);
  const password = input({ name: 'pw', type: 'password', value: 'hunter2' }, 'hunter2', 'password');
  dispatch('click', password, { button: 0, detail: 1, clientX: 1, clientY: 1 });
  assert.equal(password.valueReads, 0);
  assert.deepEqual([annotated[0]!.secret, annotated[0]!.text, annotated[0]!.outerHtml], [true, '', '']);

  const loaded = load(false, true);
  const form = new FakeElement('FORM', { onsubmit: 'steal()' });
  const field = input({ name: 'email', value: 'ada@example.com' }, 'ada@example.com');
  const area = new FakeElement('TEXTAREA', { name: 'note' });
  area.textContent = 'my diary';
  const editor = new FakeElement('DIV', { contenteditable: 'true' });
  editor.textContent = 'draft';
  const script = new FakeElement('SCRIPT');
  script.textContent = 'alert(1)';
  form.append(field, area, editor, script, new FakeElement('STYLE'), new FakeElement('IFRAME', { srcdoc: '<b>x</b>' }));
  form.innerText = 'my diary draft';
  loaded.dispatch('click', form, { button: 0, detail: 1, clientX: 1, clientY: 1 });
  const markup = loaded.annotated[0]!.outerHtml as string;
  assert.equal(markup, '<form><input name="email"></input><textarea name="note"></textarea><div contenteditable="true"></div></form>');
  assert.equal(field.valueReads, 0);
  assert.equal(form.attributes.onsubmit, 'steal()', 'the page itself is untouched: only the clone is stripped');
  assert.equal(script.parentElement, form);
});

test('a subtree too big to clone whole ships its element alone, marked truncated', () => {
  const { dispatch, annotated } = load(false, true);
  const list = new FakeElement('UL');
  list.append(...Array.from({ length: 2_001 }, () => new FakeElement('LI')));
  dispatch('click', list, { button: 0, detail: 1, clientX: 1, clientY: 1 });
  assert.equal(annotated[0]!.outerHtml, '<ul></ul><!--timon:truncated-->');
});

test('an element under a shadow root gets no XPath', () => {
  const { dispatch, annotated, document } = load(false, true);
  document.documentElement = new FakeElement('HTML');
  const orphan = new FakeElement('DIV').append(new FakeElement('BUTTON'));
  dispatch('click', orphan.children[0]!, { button: 0, detail: 1, clientX: 1, clientY: 1 });
  assert.equal(annotated[0]!.xpath, '');
});

test('hover reports each element entered once; Escape leaves and the page never sees it', () => {
  const { dispatch, annotated, annotate } = load();
  const button = new FakeElement('BUTTON');
  dispatch('pointermove', button);
  const idleEscape = dispatch('keydown', button, { key: 'Escape' });
  assert.deepEqual([annotated, idleEscape.stopped], [[], false]);
  annotate(true);
  dispatch('pointermove', button);
  dispatch('pointermove', button);
  assert.deepEqual(annotated.map((event) => [event.type, event.tag]), [['hover', 'button']]);
  for (const type of ['keydown', 'keyup']) {
    const event = dispatch(type, button, { key: 'Escape' });
    assert.deepEqual([event.stopped, event.prevented], [true, true], type);
  }
  const typed = dispatch('keydown', button, { key: 'a' });
  assert.equal(typed.stopped, false, 'other keys reach the page');
  assert.deepEqual(plain(annotated.at(-1)), { type: 'exit', reason: 'escape' });
  assert.equal(annotated.filter((event) => event.type === 'exit').length, 1);
});

test('the PWA point is resolved with elementFromPoint, only while annotating', () => {
  const { pickAt, annotated, annotate, document } = load();
  const button = new FakeElement('BUTTON', { id: 'buy' });
  button.id = 'buy';
  const points: number[][] = [];
  document.elementFromPoint = (x: number, y: number) => { points.push([x, y]); return x < 500 ? button : null; };
  pickAt({ requestId: 'r1', x: 5, y: 6 });
  assert.deepEqual(annotated, [], 'ignored while not annotating');
  annotate(true);
  for (const request of [null, 'x', { requestId: 1, x: 1, y: 1 }, { requestId: 'r', x: '1', y: 1 }]) pickAt(request);
  assert.deepEqual(points, []);
  pickAt({ requestId: 'r2', x: 5, y: 6 });
  pickAt({ requestId: 'r3', x: 7, y: 8, preview: true });
  pickAt({ requestId: 'r4', x: 900, y: 8 });
  assert.deepEqual(annotated.map((event) => [event.type, event.requestId, event.selector ?? event.tag]),
    [['pick', 'r2', 'button#buy'], ['hover', 'r3', 'button'], ['miss', 'r4', undefined]]);
  assert.deepEqual({ ...annotated[0]!.point as object }, { x: 5, y: 6 });
  // The PWA's pick is remembered for its pin to follow (TODO #491); a preview names nothing.
  assert.deepEqual(annotated.map((event) => event.anchor), ['a1', undefined, undefined]);
});

test('a pick names its element, and only the elements the main process follows report their rectangle (TODO #481)', async () => {
  const { dispatch, annotated, annotate, track, listeners } = load(false, true);
  const first = new FakeElement('BUTTON');
  const second = new FakeElement('A', { href: '/x' });
  dispatch('click', first, { button: 0, detail: 1, clientX: 20, clientY: 30 });
  await new Promise((resolve) => setTimeout(resolve, 450));
  dispatch('click', second, { button: 0, detail: 1, clientX: 40, clientY: 50 });
  const [a1, a2] = annotated.map((event) => event.anchor);
  assert.deepEqual([a1, a2], ['a1', 'a2']);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
  const rects = () => annotated.filter((event) => event.type === 'rects');
  track(['a1', 'a9', 7]);
  await settle();
  assert.deepEqual(plain(rects().at(-1)), { type: 'rects', rects: [{ anchor: 'a1', rect: { x: 10, y: 20, width: 100, height: 30 } }] },
    'an anchor this preload never gave is ignored');
  first.rect = { x: 10, y: -380, width: 100, height: 30 };
  for (const { listener } of listeners.get('scroll') ?? []) listener({});
  for (const { listener } of listeners.get('scroll') ?? []) listener({});
  await settle();
  assert.equal(rects().length, 2, 'two scroll events in a frame: one report');
  assert.deepEqual(plain(rects().at(-1)?.rects), [{ anchor: 'a1', rect: { x: 10, y: -380, width: 100, height: 30 } }]);
  first.isConnected = false;
  track(['a1', 'a2']);
  await settle();
  assert.deepEqual(plain(rects().at(-1)?.rects), [{ anchor: 'a1', rect: null }, { anchor: 'a2', rect: { x: 10, y: 20, width: 100, height: 30 } }]);
  annotate(false);
  for (const { listener } of listeners.get('scroll') ?? []) listener({});
  await settle();
  assert.equal(rects().length, 3, 'silent outside annotate mode');
  track([]);
});
