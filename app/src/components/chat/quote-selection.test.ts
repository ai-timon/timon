import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';

test('quotes only a selection within one agent message in the current thread', async () => {
  const dom = new JSDOM(`
    <main>
      <div id="thread">
        <div data-chat-quote-source><p>Start. <strong>Exact excerpt</strong> elsewhere.</p></div>
        <div data-chat-quote-source>Another message</div>
      </div>
      <div id="other-thread"><div data-chat-quote-source>Other conversation</div></div>
      <textarea></textarea>
      <div id="root"></div>
    </main>
  `, { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  Object.assign(globalThis, {
    window, document: window.document, Node: window.Node, Element: window.Element,
    IS_REACT_ACT_ENVIRONMENT: true, React,
  });
  const { createRoot } = await import('react-dom/client');
  const { QuoteSelection } = await import('./quote-selection');
  const thread = document.querySelector<HTMLDivElement>('#thread')!;
  const composer = document.querySelector('textarea')!;
  const first = thread.querySelector('strong')!.firstChild!;
  const second = thread.children.item(1)!.firstChild!;
  const other = document.querySelector('#other-thread [data-chat-quote-source]')!.firstChild!;
  const rect = (x: number, y: number, width: number, height: number) => new window.DOMRect(x, y, width, height);
  thread.getBoundingClientRect = () => rect(10, 10, 500, 400);
  Object.defineProperty(window.Range.prototype, 'getClientRects', {
    value: () => [rect(30, 80, 100, 15)],
  });
  const root = createRoot(document.getElementById('root')!);
  let draft = 'Can you explain this?';
  const select = async (start: Node, end: Node) => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.textContent!.length);
    await React.act(async () => {
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new window.Event('selectionchange'));
    });
  };
  const button = () => document.querySelector('button');

  try {
    await React.act(async () => root.render(React.createElement(QuoteSelection, {
      threadRef: { current: thread },
      composerRef: { current: composer },
      setInput: (next) => { draft = typeof next === 'function' ? next(draft) : next; },
    })));

    await select(first, second);
    assert.equal(button(), null);
    await select(other, other);
    assert.equal(button(), null);
    await select(first, first);
    assert.equal(button()?.textContent?.trim(), 'Quote in chat');
    await React.act(async () => button()!.click());

    assert.equal(draft, '> Exact excerpt\n\nCan you explain this?');
    assert.equal(document.activeElement, composer);
    assert.equal(button(), null);
  } finally {
    await React.act(async () => root.unmount());
    window.close();
  }
});
