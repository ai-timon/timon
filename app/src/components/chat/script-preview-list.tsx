'use client';

/**
 * What a shell command on a permission card would run from the project: each
 * local file with its first lines, so the human approves content they have
 * read and not only a familiar name (`./run_tests.sh`). A file the daemon
 * would not read (outside the folder, behind a link out of it, a path only the
 * shell can resolve) is named with the reason, never shown.
 */

import { useState, type ReactElement } from 'react';
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';
import { formatBytes } from '@/lib/intl';
import { t } from '@/lib/i18n';
import { FOLDED_LINES, startsFolded, type ScriptPreview } from '@/lib/script-preview';

function PreviewItem({ preview }: { preview: ScriptPreview }): ReactElement {
  const foldable = startsFolded(preview);
  const [open, setOpen] = useState(!foldable);
  const lines = preview.excerpt?.split('\n') ?? [];
  const shown = open ? lines : lines.slice(0, FOLDED_LINES);
  const unread = preview.status !== 'ok' && preview.status !== 'binary';
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg bg-muted/40 p-2" data-script-preview={preview.path}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]">
        {/* code-font: a file path */}
        <code className="break-all font-mono text-[11.5px] text-foreground">{preview.path}</code>
        {preview.kind !== 'file' && (
          <span className="text-muted-foreground">
            {t(`chatSurface.scriptPreview.kind.${preview.kind}`, { name: preview.name ?? '' })}
          </span>
        )}
        {preview.size !== undefined && (
          <span className="tabular-nums text-muted-foreground">{formatBytes(preview.size)}</span>
        )}
      </div>
      {unread || preview.status === 'binary' ? (
        <div className={unread ? 'text-[12px] font-medium text-[hsl(var(--warning))]' : 'text-[12px] text-muted-foreground'}>
          {t(`chatSurface.scriptPreview.status.${preview.status}`)}
        </div>
      ) : null}
      {shown.length > 0 && (
        // code-font: the excerpt of the script the command runs
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-foreground/85">
          {shown.join('\n')}
        </pre>
      )}
      {(foldable || (open && preview.truncated)) && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {foldable && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
              aria-expanded={open}
            >
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              {open ? t('chatSurface.scriptPreview.fold') : t('chatSurface.scriptPreview.unfold', { count: lines.length })}
            </button>
          )}
          {open && preview.truncated && <span>{t('chatSurface.scriptPreview.truncated')}</span>}
        </div>
      )}
      {preview.sha256 && (
        // code-font: a fingerprint, compared by eye
        <div className="break-all font-mono text-[10px] text-muted-foreground/70" title={preview.sha256}>
          {/* i18n-exempt: the name of a hash algorithm, the same in every language */}
          SHA-256 {preview.sha256.slice(0, 16)}
        </div>
      )}
    </div>
  );
}

/**
 * `remembered`: the card offers to remember the approval. The daemon binds it
 * to the state of these files, so the card says it lapses when they change.
 */
export function ScriptPreviewList(
  { previews, remembered = false }: { previews: ScriptPreview[]; remembered?: boolean },
): ReactElement | null {
  if (previews.length === 0) return null;
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-1.5" data-script-previews="">
      <div className="flex items-start gap-1.5 text-[12px] text-[hsl(var(--warning))]">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>{t('chatSurface.scriptPreview.warning')}</span>
      </div>
      {previews.map((p) => (
        <PreviewItem key={`${p.kind}:${p.path}:${p.name ?? ''}`} preview={p} />
      ))}
      {remembered && (
        <div className="text-[11.5px] text-muted-foreground" data-script-remembered="">
          {t('chatSurface.scriptPreview.remembered')}
        </div>
      )}
    </div>
  );
}

/** Shown on a card whose Allow was turned down because a file changed since it showed it. */
export function ScriptChangedNotice({ paths }: { paths: string[] }): ReactElement | null {
  if (paths.length === 0) return null;
  return (
    <div className="mt-2 text-[12px] font-medium text-destructive" data-script-changed="">
      {t('chatSurface.scriptPreview.changed', { paths: paths.join(', ') })}
    </div>
  );
}
