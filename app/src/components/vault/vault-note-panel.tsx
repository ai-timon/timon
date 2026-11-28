'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { mdToSafeHtml } from '@/lib/markdown';
import {
  parseVaultNote,
  wikilinkLabel,
  wikilinkTarget,
  type VaultProp,
} from '@/lib/vault-frontmatter';
import { NativeViewCover } from '@/lib/native-view-cover';
import { t } from '@/lib/i18n';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}

interface VaultNote {
  id: string;
  title: string;
  folder: string;
  content: string;
  mtime: number;
}

export interface VaultNotePanelProps {
  noteId: string;
  onClose: () => void;
  /**
   * Click on a wikilink in the body. Receives the RAW TARGET (`[[cockpit-hud]]` →
   * `cockpit-hud`), not an id: only the caller, which holds the node list,
   * can resolve it to a full path.
   */
  onFollowLink: (target: string) => void;
}

/** Keys whose values are tags, shown as `#` pills. */
const TAG_KEYS = new Set(['tags', 'tag', 'keywords']);

/**
 * Front matter property table, modelled on Obsidian's: one row per key, tags
 * as pills and clickable wikilinks — this is what makes the popup enough to
 * navigate without opening the application.
 */
function NoteProperties({
  props,
  onFollowLink,
}: {
  props: VaultProp[];
  onFollowLink: (target: string) => void;
}) {
  if (props.length === 0) return null;

  const renderValue = (key: string, value: string, i: number) => {
    const target = wikilinkTarget(value);
    if (target) {
      return (
        <button
          key={`${value}-${i}`}
          type="button"
          onClick={() => onFollowLink(target)}
          className="max-w-full truncate rounded text-[11px] text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid"
        >
          {wikilinkLabel(value)}
        </button>
      );
    }
    if (TAG_KEYS.has(key.toLowerCase())) {
      return (
        <span
          key={`${value}-${i}`}
          className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          #{value.replace(/^#/, '')}
        </span>
      );
    }
    return (
      <span key={`${value}-${i}`} className="text-[11px] text-foreground">
        {value}
      </span>
    );
  };

  return (
    <dl className="grid grid-cols-[minmax(72px,auto)_1fr] gap-x-4 gap-y-1.5 bg-muted/20 px-4 py-3">
      {props.map((prop) => (
        <div key={prop.key} className="contents">
          <dt className="truncate pt-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {prop.key}
          </dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
            {prop.values.map((v, i) => renderValue(prop.key, v, i))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Note reading panel, overlaid on the graph — the equivalent of Obsidian's
 * preview pane.
 */
export default function VaultNotePanel({ noteId, onClose, onFollowLink }: VaultNotePanelProps) {
  const [note, setNote] = useState<VaultNote | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNote(null);
    setError(null);

    fetch(`/api/ui/vault/note?id=${encodeURIComponent(noteId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 404 ? t('vault.noteNotFound') : `HTTP ${res.status}`);
        return res.json() as Promise<VaultNote>;
      })
      .then((json) => { if (!cancelled) setNote(json); })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('vault.unknownError'));
      });

    return () => { cancelled = true; };
  }, [noteId]);

  // Escape closes the panel — the expected reflex on an overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Front matter is metadata: rendered in the body it would show as a
  // paragraph of `key: value`. It feeds the property table instead.
  const { props, body } = parseVaultNote(note?.content ?? '');

  // Body wikilinks become jumps to the target note: without that the panel
  // would be a dead end, while the vault is made of cross-references.
  const html = note
    ? mdToSafeHtml(body).replace(
        /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (_m, target: string, label?: string) =>
          `<a href="#" data-wikilink="${encodeURIComponent(target.split(/[#^]/)[0]!.trim())}">${escapeHtml(label ?? target)}</a>`,
      )
    : '';

  // Portal to `body`: the panel used to live in the graph tile, which has
  // `overflow-hidden` and is only 374 px wide — a note was unreadable there,
  // and any overflow would have been clipped anyway. A portal is the only way
  // out that does not depend on positioned ancestors.
  return createPortal(
    <div
      className="timon-window-layer fixed inset-0 z-50 grid place-items-center bg-background/60 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
    <NativeViewCover />
    <div
      // A click on the backdrop closes; one on the panel must not bubble up.
      onClick={(e) => e.stopPropagation()}
      className="flex max-h-[85vh] w-[min(760px,92vw)] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-elev-3"
    >
      <header className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm text-foreground">
            {note?.title ?? noteId.split('/').pop()}
          </div>
          <div /* code-font: note file path */ className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {noteId}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('vault.closeNote')}
          className="shrink-0 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ✕
        </button>
      </header>

      {note && <NoteProperties props={props} onFollowLink={onFollowLink} />}

      <div
        // The `.chat-bubble` rules are tuned for the width of chat bubbles;
        // this panel is narrower, hence the containment of code blocks and
        // long URLs that overflowed horizontally.
        className="chat-bubble min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm text-foreground [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_a]:break-words [&_code]:break-words"
        onClick={(e) => {
          const target = (e.target as HTMLElement).closest('[data-wikilink]');
          if (!target) return;
          e.preventDefault();
          const id = target.getAttribute('data-wikilink');
          if (id) onFollowLink(decodeURIComponent(id));
        }}
        dangerouslySetInnerHTML={{
          __html: error
            ? `<p style="opacity:.5">${escapeHtml(error)}</p>`
            : note
              ? html
              : `<p style="opacity:.5">${escapeHtml(t('vault.loadingNote'))}</p>`,
        }}
      />
    </div>
    </div>,
    document.body,
  );
}
