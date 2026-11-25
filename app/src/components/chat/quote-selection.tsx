'use client';

import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Quote } from 'lucide-react';

import { t } from '@/lib/i18n';
import type { ComposerDraftSetter } from '@/lib/composer-draft';

const SOURCE = '[data-chat-quote-source]';

function sourceOf(node: Node) {
  return (node instanceof Element ? node : node.parentElement)?.closest(SOURCE);
}

function readSelection(thread: HTMLElement | null) {
  const selection = window.getSelection();
  if (!thread || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;

  const range = selection.getRangeAt(0);
  const source = sourceOf(range.startContainer);
  if (!source || source !== sourceOf(range.endContainer) || !thread.contains(source)) return null;

  const excerpt = selection.toString();
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

  useEffect(() => {
    const update = () => setSelection(readSelection(threadRef.current));
    const viewport = window.visualViewport;
    document.addEventListener('selectionchange', update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, [threadRef]);

  if (!selection) return null;

  function quote() {
    // Recheck the selection in case the conversation changed before the click.
    const current = readSelection(threadRef.current);
    if (!current) return;
    const block = current.excerpt.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
    setInput((draft) => `${block}\n\n${draft}`);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    composerRef.current?.focus({ preventScroll: true });
  }

  return createPortal(
    <button
      type="button"
      className="fixed z-[60] inline-flex max-w-[calc(100vw-16px)] select-none items-center gap-1.5 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-elev-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      style={{
        left: `clamp(8px, ${selection.left}px, max(8px, calc(100vw - 11rem)))`,
        top: selection.top,
        transform: selection.above ? 'translateY(-100%)' : undefined,
      }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={quote}
    >
      <Quote className="size-3.5 shrink-0" aria-hidden />
      {t('chatPage.quoteSelection')}
    </button>,
    document.body,
  );
}
