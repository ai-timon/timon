import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';

async function setup() {
  const dom = new JSDOM(`
    <main>
      <div id="thread">
        <div data-chat-quote-source>
          <p>Start. <strong>Exact excerpt</strong> elsewhere.</p>
          <p>Last paragraph.</p>
        </div>
        <div data-chat-quote-source>Another message</div>
        <div>Human message</div>
        <div data-chat-quote-source><pre id="multiline" data-lang="sh"></pre></div>
        <div data-chat-quote-source><ol start="4"><li>First item</li><li><em>Second item</em></li><li>Third item</li></ol></div>
      </div>
      <div id="other-thread"><div data-chat-quote-source>Other conversation</div></div>
      <textarea id="composer"></textarea>
      <textarea id="other-composer"></textarea>
      <div id="root"></div>
    </main>
  `, { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window, document: window.document, Node: window.Node, Element: window.Element,
    IS_REACT_ACT_ENVIRONMENT: true, React,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const { createRoot } = await import('react-dom/client');
  const { QuoteSelection } = await import('./quote-selection');

  const thread = document.querySelector<HTMLDivElement>('#thread')!;
  const otherThread = document.querySelector<HTMLDivElement>('#other-thread')!;
  const composer = document.querySelector<HTMLTextAreaElement>('#composer')!;
  const otherComposer = document.querySelector<HTMLTextAreaElement>('#other-composer')!;
  const beginning = thread.querySelector('p')!.firstChild!;
  const first = thread.querySelector('strong')!.firstChild!;
  const last = thread.querySelector('p:last-child')!.firstChild!;
  const second = thread.children.item(1)!.firstChild!;
  const human = thread.children.item(2)!.firstChild!;
  const other = otherThread.querySelector('[data-chat-quote-source]')!.firstChild!;
  const multilineElement = thread.querySelector('#multiline')!;
  multilineElement.textContent = '\n  # First line\n\nSecond line\n  ';
  const multiline = multilineElement.firstChild!;
  const listStart = thread.querySelector('li em')!.firstChild!;
  const listEnd = thread.querySelector('li:last-child')!.firstChild!;

  const rect = (x: number, y: number, width: number, height: number) => new window.DOMRect(x, y, width, height);
  thread.getBoundingClientRect = () => rect(10, 10, 500, 400);
  otherThread.getBoundingClientRect = () => rect(510, 10, 500, 400);
  Object.defineProperty(window.Range.prototype, 'getClientRects', {
    value: () => [rect(540, 80, 100, 15), rect(30, 80, 100, 15)],
  });

  const root = createRoot(document.getElementById('root')!);
  const drafts = { left: 'Can you explain this?', right: 'Separate draft' };
  const threadRef = { current: thread };
  const render = (key = 'first-mission', twoPanels = false) => React.act(async () => {
    root.render(React.createElement(React.Fragment, null,
      React.createElement(QuoteSelection, {
        key,
        threadRef,
        composerRef: { current: composer },
        setInput: (value) => { drafts.left = typeof value === 'function' ? value(drafts.left) : value; },
      }),
      twoPanels && React.createElement(QuoteSelection, {
        key: 'other-mission',
        threadRef: { current: otherThread },
        composerRef: { current: otherComposer },
        setInput: (value) => { drafts.right = typeof value === 'function' ? value(drafts.right) : value; },
      }),
    ));
  });

  function setRange(start: Node, end: Node, endOffset = end.textContent!.length) {
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, endOffset);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  const select = (start: Node, end: Node, endOffset?: number) => React.act(async () => {
    setRange(start, end, endOffset);
    document.dispatchEvent(new window.Event('selectionchange'));
  });

  const button = () => document.querySelector('button');
  const clickQuote = () => React.act(async () => button()!.click());
  const done = async () => {
    await React.act(async () => root.unmount());
    window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return {
    render, select, setRange, button, clickQuote, done, drafts,
    beginning, first, last, second, human, other, thread, composer, otherComposer, multiline, listStart, listEnd,
  };
}

test('quotes only a selection within one agent message in the current thread', async () => {
  const ui = await setup();
  try {
    await ui.render();
    await ui.select(ui.first, ui.second);
    assert.equal(ui.button(), null);
    await ui.select(ui.human, ui.human);
    assert.equal(ui.button(), null);
    await ui.select(ui.other, ui.other);
    assert.equal(ui.button(), null);
    await ui.select(ui.first, ui.first);
    assert.equal(ui.button()?.textContent?.trim(), 'Quote in chat');
    await ui.clickQuote();

    assert.equal(ui.drafts.left, '> **Exact excerpt**\n\nCan you explain this?');
    assert.equal(document.activeElement, ui.composer);
    assert.equal(ui.button(), null);
  } finally {
    await ui.done();
  }
});

test('quotes the last paragraph when the endpoint is at the start of the next block', async () => {
  const ui = await setup();
  try {
    await ui.render();
    await ui.select(ui.last, ui.second, 0);
    await ui.clickQuote();
    assert.equal(ui.drafts.left, '> Last paragraph.\n\nCan you explain this?');
  } finally {
    await ui.done();
  }
});

test('quotes multiple lines without adding empty lines at the edges', async () => {
  const ui = await setup();
  try {
    await ui.render();
    await ui.select(ui.multiline, ui.multiline);
    await ui.clickQuote();
    assert.equal(ui.drafts.left, '> ```sh\n>   # First line\n>\n> Second line\n> ```\n\nCan you explain this?');
  } finally {
    await ui.done();
  }
});

test('revalidates the excerpt when the click arrives before a selection event', async () => {
  const ui = await setup();
  try {
    await ui.render();
    const plain = ui.first.parentNode!.parentNode!.appendChild(document.createTextNode('Exact excerpt'));
    await ui.select(ui.first, ui.first);
    await React.act(async () => {
      ui.setRange(plain, plain);
      ui.button()!.click();
    });
    assert.equal(ui.drafts.left, 'Can you explain this?');
    await ui.clickQuote();
    assert.equal(ui.drafts.left, '> Exact excerpt\n\nCan you explain this?');
  } finally {
    await ui.done();
  }
});

test('each panel quotes only into its own draft', async () => {
  const ui = await setup();
  try {
    await ui.render('first-mission', true);
    await ui.select(ui.other, ui.other);
    assert.equal(document.querySelectorAll('button').length, 1);
    await ui.clickQuote();

    assert.equal(ui.drafts.left, 'Can you explain this?');
    assert.equal(ui.drafts.right, '> Other conversation\n\nSeparate draft');
    assert.equal(document.activeElement, ui.otherComposer);
  } finally {
    await ui.done();
  }
});

test('reads the selection at mount and drops it when a conversation is replaced', async () => {
  const ui = await setup();
  try {
    ui.setRange(ui.first, ui.first);
    await ui.render();
    assert.ok(ui.button());
    ui.thread.replaceChildren();
    await ui.render('next-mission');
    assert.equal(ui.button(), null);
    assert.equal(ui.drafts.left, 'Can you explain this?');
  } finally {
    await ui.done();
  }
});

test('reconstructs paragraph breaks, emphasis and ordered list markers', async () => {
  const ui = await setup();
  try {
    await ui.render();
    await ui.select(ui.beginning, ui.last);
    await ui.clickQuote();
    assert.equal(ui.drafts.left, '> Start. **Exact excerpt** elsewhere.\n>\n> Last paragraph.\n\nCan you explain this?');

    await ui.select(ui.listStart, ui.listEnd);
    await ui.clickQuote();
    assert.match(ui.drafts.left, /^> 5\. \*Second item\*\n> 6\. Third item\n\n/);
  } finally {
    await ui.done();
  }
});

test('the keyboard shortcut inserts the quote and updates the live status', async () => {
  const ui = await setup();
  try {
    await ui.render();
    const status = document.querySelector('[role="status"]')!;
    assert.equal(status.textContent, '');
    await ui.select(ui.last, ui.last);
    assert.equal(ui.button()?.getAttribute('aria-keyshortcuts'), 'Alt+Shift+C');
    const shortcut = new window.KeyboardEvent('keydown', {
      key: 'C', code: 'KeyC', altKey: true, shiftKey: true, bubbles: true, cancelable: true,
    });
    await React.act(async () => document.body.dispatchEvent(shortcut));
    assert.ok(shortcut.defaultPrevented);
    assert.equal(ui.drafts.left, '> Last paragraph.\n\nCan you explain this?');
    assert.equal(document.activeElement, ui.composer);
    assert.equal(status.textContent, 'Quote added to the draft.');
  } finally {
    await ui.done();
  }
});
