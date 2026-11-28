'use client';

/**
 * The attached files of a Kanban item, a task or a TO DO idea: thumbnails,
 * drop zone, file picker, download and removal. The owner is the caller's
 * business: it hands the stored files, their URL and the gestures, the field
 * only reads what every file has (`StoredAttachment`).
 */

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { FileText, ImageIcon, Loader2, Paperclip, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getLocale, t } from '@/lib/i18n';
import { formatBytes } from '@/lib/intl';
import {
  isImageName, TASK_ATTACHMENT_ACCEPT, type StoredAttachment, type TaskAttachment,
} from '@/lib/task-attachments';
import { Field, PAPER_CLASS } from '@/components/form-field';

// ─── Attachments ────────────────────────────────────────────────────────────

/** A file of the form: stored on the daemon, or held until it can be sent. */
export type AttachmentItem<A extends StoredAttachment = TaskAttachment> =
  | { key: string; state: 'stored'; attachment: A; inherited: boolean }
  | { key: string; state: 'queued' | 'uploading'; file: File; preview: string | null };

/**
 * The files a paste carries, for a surface that takes them (`onPaste`). A
 * paste of text carries none, and must be left to the field it lands in.
 */
export function pastedFiles(e: ClipboardEvent<Element>): File[] {
  return Array.from(e.clipboardData?.files ?? []);
}

export function AttachmentsField<A extends StoredAttachment = TaskAttachment>({
  items, errors, url, onAdd, onRemove, onDismissErrors, disabled, queuedLabel,
}: {
  items: AttachmentItem<A>[];
  errors: string[];
  url: (attachment: A, download?: boolean) => string;
  onAdd: (files: File[]) => void;
  onRemove: (item: AttachmentItem<A>) => void;
  onDismissErrors: () => void;
  disabled?: boolean;
  /** What a file waiting for its owner to exist says; the task form's wording by default. */
  queuedLabel?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [enlarged, setEnlarged] = useState<{ src: string; name: string } | null>(null);
  const locale = getLocale();

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) onAdd(files);
  };

  return (
    <Field label={t('taskForm.attachments.label')}>
      <div
        data-attachment-drop=""
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
        // Moving onto a file of the list is not leaving the zone.
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
        onDrop={onDrop}
        className={cn(
          'flex flex-col gap-3 rounded-lg border border-dashed px-3 py-3 text-[13px] text-muted-foreground transition-colors',
          over ? 'border-primary/60 bg-primary/10 text-foreground' : cn('border-muted-foreground/30', PAPER_CLASS),
        )}
      >
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <Paperclip className="size-4" aria-hidden />
          {over ? t('taskForm.attachments.dropActive') : (
            <>
              <span>{t('taskForm.attachments.drop')}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => input.current?.click()}
                className="rounded-md px-1 font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                {t('taskForm.attachments.browse')}
              </button>
            </>
          )}
        </div>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={TASK_ATTACHMENT_ACCEPT}
          data-attachment-input=""
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length > 0) onAdd(files);
          }}
        />
        {items.length > 0 && (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(220px,100%),1fr))] gap-2">
            {items.map((item) => {
              const name = item.state === 'stored' ? item.attachment.name : item.file.name;
              const size = item.state === 'stored' ? item.attachment.size : item.file.size;
              const image = item.state === 'stored' ? item.attachment.kind === 'image' : isImageName(name);
              const src = item.state === 'stored' ? url(item.attachment) : item.preview;
              const note = item.state === 'uploading' ? t('taskForm.attachments.uploading')
                : item.state === 'queued' ? queuedLabel ?? t('taskForm.attachments.queued')
                : item.state === 'stored' && item.inherited ? t('taskForm.attachments.inherited') : null;
              return (
                <li key={item.key} data-attachment={name} className="flex items-center gap-3 rounded-lg bg-muted/40 p-2">
                  {image && src ? (
                    <button
                      type="button"
                      onClick={() => setEnlarged({ src, name })}
                      aria-label={t('taskForm.attachments.enlarge', { name })}
                      className="size-12 flex-none overflow-hidden rounded-md bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- served by the daemon or a local blob, sizes unknown */}
                      <img src={src} alt="" className="size-full object-cover" />
                    </button>
                  ) : (
                    <span className="grid size-12 flex-none place-items-center rounded-md bg-muted text-muted-foreground" aria-hidden>
                      {image ? <ImageIcon className="size-5" /> : <FileText className="size-5" />}
                    </span>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col">
                    {item.state === 'stored' ? (
                      <a
                        href={url(item.attachment, !image && item.attachment.mime !== 'application/pdf')}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={t('taskForm.attachments.open', { name })}
                        className="truncate text-[13px] font-medium text-foreground hover:underline"
                      >
                        {name}
                      </a>
                    ) : (
                      <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
                    )}
                    <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                      {item.state === 'uploading' && <Loader2 className="size-3 animate-spin" aria-hidden />}
                      {formatBytes(size, locale)}{note ? ` · ${note}` : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemove(item)}
                    disabled={disabled || item.state === 'uploading'}
                    aria-label={t('taskForm.attachments.remove', { name })}
                    className="grid size-7 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {errors.length > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <ul className="flex flex-1 flex-col gap-0.5">
            {errors.map((error, i) => <li key={i}>{error}</li>)}
          </ul>
          <button type="button" onClick={onDismissErrors} aria-label={t('taskForm.attachments.dismiss')} className="rounded p-0.5 hover:bg-destructive/15">
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}


      {enlarged && <ImageLightbox src={enlarged.src} name={enlarged.name} onClose={() => setEnlarged(null)} />}
    </Field>
  );
}

/** An attached image, shown large over the form; Escape closes it and leaves the form open. */
function ImageLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('taskForm.attachments.enlarged', { name })}
      className="timon-below-window-band fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-6"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        if (e.key === 'Tab') { e.preventDefault(); closeButton.current?.focus(); }
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- served by the daemon or a local blob, sizes unknown */}
      <img src={src} alt={name} className="max-h-full max-w-full rounded-lg object-contain shadow-elev-3" />
      <button
        ref={closeButton}
        type="button"
        onClick={onClose}
        aria-label={t('taskForm.attachments.closePreview')}
        className="absolute right-4 top-4 grid size-9 place-items-center rounded-lg bg-background/80 text-foreground hover:bg-background"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
