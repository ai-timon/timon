'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Quote } from 'lucide-react';

import { t } from '@/lib/i18n';
import type { ComposerDraftSetter } from '@/lib/composer-draft';
import { selectionMarkdown, trimBlankLines } from './quote-markdown';

const SOURCE = '[data-chat-quote-source]';
const QUOTE_SHORTCUT = 'Alt+Shift+C';

function sourceOf(node: Node) {
  return (node instanceof Element ? node : node.parentElement)?.closest(SOURCE);
}

function readSelection(thread: HTMLElement | null) {
  const selection = window.getSelection();
  if (!thread || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;

  const range = selection.getRangeAt(0).cloneRange();
  const source = sourceOf(range.startContainer);
  if (!source || !thread.contains(source) || !thread.contains(range.endContainer)) return null;

  if (!source.contains(range.endContainer)) {
    // Chromium can end a paragraph selection at the start of the next block.
    const trailing = range.cloneRange();
    trailing.setStart(source, source.childNodes.length);
    if (trailing.toString().trim()) return null;
    range.setEnd(source, source.childNodes.length);
  }

  // Selection preserves rendered paragraph breaks that Range.toString drops.
  const excerpt = trimBlankLines(selection.toString());
  if (!excerpt.trim()) return null;

  const bounds = thread.getBoundingClientRect();
  const viewport = window.visualViewport;
  const left = Math.max(bounds.left, viewport?.offsetLeft ?? 0);
  const top = Math.max(bounds.top, viewport?.offsetTop ?? 0);
  const right = Math.min(bounds.right, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth));
  const bottom = Math.min(bounds.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight));
  const line = Array.from(range.getClientRects()).find((rect) =>
    rect.width > 0 && rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom);
  if (!line) return null;

  const above = line.top - top >= 36;
  return {
    source,
    range,
    excerpt,
    above,
    left: Math.max(left, line.left),
    top: above ? line.top - 4 : line.bottom + 4,
  };
}

export function QuoteSelection({ threadRef, composerRef, setInput }: {
  threadRef: RefObject<HTMLDivElement | null>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  setInput: ComposerDraftSetter;
}) {
  const [selection, setSelection] = useState<ReturnType<typeof readSelection>>(null);
  const [quotesAdded, setQuotesAdded] = useState(0);

  const insert = useCallback((current: NonNullable<ReturnType<typeof readSelection>>) => {
    const markdown = selectionMarkdown(current.range, current.source, current.excerpt);
    const block = markdown.split(/\r?\n/).map((line) => line ? `> ${line}` : '>').join('\n');
    setInput((draft) => `${block}\n\n${draft}`);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    composerRef.current?.focus({ preventScroll: true });
    setQuotesAdded((count) => count + 1);
  }, [composerRef, setInput]);

  useEffect(() => {
    const update = () => setSelection(readSelection(threadRef.current));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey ||
          !event.altKey || !event.shiftKey || (event.code !== 'KeyC' && event.key.toLowerCase() !== 'c')) return;
      const current = readSelection(threadRef.current);
      if (!current) return;
      event.preventDefault();
      insert(current);
    };
    const viewport = window.visualViewport;
    update();
    document.addEventListener('selectionchange', update);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, [insert, threadRef]);

  const quote = () => {
    // The selection can change before its event reaches the button.
    const current = readSelection(threadRef.current);
    if (!selection || !current || current.source !== selection.source || current.excerpt !== selection.excerpt ||
        current.range.compareBoundaryPoints(window.Range.START_TO_START, selection.range) !== 0 ||
        current.range.compareBoundaryPoints(window.Range.END_TO_END, selection.range) !== 0) {
      setSelection(current);
      return;
    }
    insert(current);
  };

  const button = selection && createPortal(
    <button
      type="button"
      aria-keyshortcuts={QUOTE_SHORTCUT}
      className="fixed z-[60] inline-flex max-w-[calc(100vw-16px)] select-none items-center gap-1.5 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-elev-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      style={{
        left: `clamp(8px, ${selection.left}px, max(8px, calc(100vw - 11rem)))`,
        top: selection.top,
        transform: selection.above ? 'translateY(-100%)' : undefined,
      }}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={quote}
    >
      <Quote className="size-3.5 shrink-0" aria-hidden />
      {t('chatPage.quoteSelection')}
    </button>,
    document.body,
  );
  return (
    <>
      <span role="status" aria-atomic="true" className="sr-only">
        {quotesAdded > 0 && <span key={quotesAdded}>{t('chatPage.quoteAdded')}</span>}
      </span>
      {button}
    </>
  );
}
