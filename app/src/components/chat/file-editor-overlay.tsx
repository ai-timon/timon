'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Eye, FileText, Pencil, Save, X } from 'lucide-react';
import { toast } from 'sonner';


import { cn } from '@/lib/utils';
import { t as i18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { hljsLanguageFor } from '@/lib/file-icons';
import { highlightCode, mdToSafeHtml, splitHighlightedLines } from '@/lib/markdown';
import { formatJson } from '@/lib/format-json';
import { fileTypeFor, fileTypeIcon } from '@/lib/file-type-icons';
import { fmtSize } from './chat-format';
import { focusedWithin } from './file-preview-overlay';
import type { FileBody } from './chat-types';
import { apiErrorMessage } from '@/lib/api-error';

// The editor (CodeMirror + its grammar) only loads when switching to
// `edit` mode: the read-only preview doesn't need it and stays instant.
const CodeEditor = dynamic(() => import('@/components/code-editor'), {
  ssr: false,
  loading: () => (
    <div className="grid flex-1 place-items-center text-[12px] text-muted-foreground">
      {i18n('fileSurface.loadingEditor')}
    </div>
  ),
});

/** The coloured glyph of the file's family; a plain page when the name says nothing. */
function TypeIcon({ name, className }: { name: string; className?: string }) {
  const type = fileTypeFor(name);
  if (!type) return <FileText className={className} />;
  const Icon = fileTypeIcon(type);
  return <Icon className={className} />;
}

export type EditorMode = 'view' | 'edit';

/** Writes `draft` over the file; says so in a toast either way. */
export async function saveAgentFile(agentId: string, file: FileBody, draft: string): Promise<boolean> {
  const r = await fetch(
    '/api/ui/agents/' + encodeURIComponent(agentId)
    + (file.external ? '/files/external' : '/files') + '?path=' + encodeURIComponent(file.path),
    {
      method: 'PUT',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: draft,
    },
  );
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    toast.error(i18n('fileSurface.saveFailed', { error: apiErrorMessage(j, r.statusText) }));
    return false;
  }
  toast.success(i18n('fileSurface.saved', { path: file.path }));
  return true;
}

/** One file's toolbar and content, without the window and its tabs. */
export function FileEditorPane({
  file,
  draft,
  onDraft,
  mode,
  onMode,
  dirty,
  saving,
  onSave,
  readOnly = false,
}: {
  file: FileBody;
  draft: string;
  onDraft: (text: string) => void;
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  /** No edit mode and no Save: a file the viewer may read only. */
  readOnly?: boolean;
}) {
  const path = file.path;
  // An absolute path (a skill's, an external file's) is `\`-separated on Windows.
  const name = path.split(/[\\/]/).pop() || path;
  const lang = useMemo(() => hljsLanguageFor(name), [name]);
  const activeMode: EditorMode = readOnly ? 'view' : mode;
  const isMarkdown = lang === 'markdown';

  // One line = one <li>, so the line-number gutter is pure CSS (counter
  // + ::before) rather than a second stream to keep in sync with
  // scrolling.
  const codeLines = useMemo(() => {
    if (file.binary) return [];
    // Minified JSON is unreadable as one line: the view re-indents it (the
    // file itself, and the editor, keep the stored text).
    const shown = lang === 'json' ? formatJson(draft) : draft;
    return splitHighlightedLines(highlightCode(shown, lang));
  }, [draft, lang, file.binary]);

  // Front matter is metadata: rendered as markdown it comes out as a
  // `key: value` paragraph stuck to the title — we isolate it as a code
  // block.
  const renderedMd = useMemo(() => {
    if (file.binary || !isMarkdown) return '';
    const fm = draft.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    const body = fm ? draft.slice(fm[0].length) : draft;
    const head = fm ? `\`\`\`yaml\n${fm[1]}\n\`\`\`\n\n` : '';
    return mdToSafeHtml(head + body);
  }, [draft, isMarkdown, file.binary]);

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 bg-muted/20 px-3 py-1.5">
        <span className="shrink-0 rounded bg-muted/50 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {fmtSize(file.size)}
        </span>
        {lang && (
          <span className="shrink-0 rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {lang}
          </span>
        )}
        {file.truncated && (
          <span className="shrink-0 rounded bg-[hsl(var(--warning)/0.1)] px-1.5 py-0.5 text-[10px] text-[hsl(var(--warning))]">
            {i18n('fileSurface.truncated')}
          </span>
        )}
        {dirty && (
          <span className="shrink-0 rounded bg-[hsl(var(--primary)/0.1)] px-1.5 py-0.5 text-[10px] text-[hsl(var(--primary))]">
            {i18n('fileEditor.modified')}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {!file.binary && !readOnly && (
            <div className="inline-flex rounded-md bg-background/60 p-0.5 ring-1 ring-border">
              {([['view', Eye], ['edit', Pencil]] as const).map(([m, Icon]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => onMode(m)}
                  aria-pressed={mode === m}
                  aria-label={i18n('fileEditor.' + m)}
                  title={i18n('fileEditor.' + m)}
                  className={cn(
                    'grid size-6 place-items-center rounded transition-colors',
                    mode === m
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5" />
                </button>
              ))}
            </div>
          )}
          {activeMode === 'edit' && (
            <Button
              size="icon"
              className="size-7"
              disabled={!dirty || saving}
              onClick={onSave}
              aria-label={saving ? i18n('fileEditor.saving') : i18n('fileEditor.save')}
              title={saving ? i18n('fileEditor.saving') : i18n('fileEditor.save')}
            >
              <Save className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      {file.binary ? (
        <div className="flex-1 overflow-auto p-8 text-center text-[12.5px] text-muted-foreground">
          {i18n('fileSurface.binaryPreviewOmitted')}
        </div>
      ) : activeMode === 'view' && isMarkdown ? (
        <div
          className="chat-bubble min-h-0 flex-1 overflow-y-auto px-6 py-4 text-[13.5px] text-foreground [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_a]:break-words [&_code]:break-words"
          dangerouslySetInnerHTML={{ __html: renderedMd }}
        />
      ) : activeMode === 'edit' ? (
        <div className="code-view flex min-h-0 flex-1 flex-col overflow-hidden">
          <CodeEditor
            value={draft}
            key={file.path}
            filename={name}
            onChange={onDraft}
          />
        </div>
      ) : (
        <div className="code-view min-h-0 flex-1 overflow-auto">
          <ol className={cn('code-lines hljs', lang && 'language-' + lang)}>
            {codeLines.map((line, i) => (
              <li key={i} dangerouslySetInnerHTML={{ __html: line }} />
            ))}
          </ol>
        </div>
      )}
    </>
  );
}
