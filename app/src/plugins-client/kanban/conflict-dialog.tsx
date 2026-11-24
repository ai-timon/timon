'use client';

/**
 * "Resolve the conflict" of a contributor's pull request
 * (`docs/FORGE-FLOW-PLAN.md` §3.3, §6): the daemon merges the pull request
 * here without a working tree (`forge-conflicts.ts`) and keeps what
 * conflicts; the person resolves each file, reads what the commit would
 * change on the contributor's branch, then proposes its publication, which
 * opens "Publish on GitHub". Nothing is pushed before that window.
 *
 * Every text shown here comes from the contributor or from an agent: React
 * paints it as text, never as markup, and the agent's suggestion is only
 * shown until the person applies it.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Check, GitMerge, Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { WidgetButton } from '@/components/widget-toolbar';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  discardConflict, getConflict, prepareConflict, proposeResolution, resolveFile, suggestResolution,
  type ConflictFile, type ConflictView, type FileResolution, type ResolutionDiff,
} from './forge-branch-api';
import { projectAccount } from './forge-proposals-api';
import {
  capLines, conflictBlocks, conflictHunks, hasConflictMarkers, shownDiff, type ShownLine,
} from './conflict-model';
import { diffLineKind } from './landing-api';
import { DIFF_LINE_CLASS } from './landing-preview-dialog';

export type ConflictDialogProps = {
  project: string;
  pull: { number: number; title: string };
  onClose: () => void;
  /** The resolution is proposed: open its publication (the dialog closes first). */
  onPublish: (proposalId: string) => void;
};

const ISLAND = 'rounded-lg bg-foreground/[0.035]';
const CHIP = 'inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[10.5px] font-medium';
const AMBER = 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
const GREEN = 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
const MUTED = 'bg-foreground/[0.06] text-muted-foreground';
const ERROR = 'text-[11.5px] text-red-600 dark:text-red-400';
/** The version a file keeps reads as chosen. */
const PRESSED = 'aria-pressed:bg-primary/15 aria-pressed:text-foreground';

const LINE_CLASS: Record<Exclude<ShownLine['kind'], 'gap'>, string> = {
  same: DIFF_LINE_CLASS.context,
  add: DIFF_LINE_CLASS.add,
  del: DIFF_LINE_CLASS.del,
  marker: 'text-amber-700 dark:text-amber-300',
  ours: DIFF_LINE_CLASS.context,
  base: 'text-muted-foreground',
  theirs: DIFF_LINE_CLASS.context,
};

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready' };
type Busy = { what: 'file' | 'suggest' | 'propose' | 'discard'; path?: string } | null;

/** Lines of a file or a diff, as code. */
function CodeLines({ lines, label }: { lines: readonly ShownLine[]; label: string }) {
  const { lines: shown, hidden } = capLines(lines);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {/* code-font: the text of a file in conflict */}
      <pre aria-label={label} className="scrollbar-thin max-h-[40vh] w-full overflow-auto rounded-md bg-background/60 py-1.5 font-mono text-[11px] leading-[1.5]">
        <div className="w-max min-w-full">
          {shown.map((line, i) => line.kind === 'gap' ? (
            <div key={i} data-line="gap" className="px-2 font-sans italic text-muted-foreground">
              {t('forgeConflict.gap', { count: line.count })}
            </div>
          ) : (
            <div key={i} data-line={line.kind} className={cn('whitespace-pre px-2', LINE_CLASS[line.kind])}>
              {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}{line.text || ' '}
            </div>
          ))}
        </div>
      </pre>
      {hidden > 0 && <p className="text-[11px] text-muted-foreground">{t('forgeConflict.hidden', { count: hidden })}</p>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
      <dt className="min-w-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 shrink-0 truncate text-right">{children}</dd>
    </div>
  );
}

/** The text a file's resolution leaves on the contributor's branch, or null when it cannot be read. */
function resolvedText(file: ConflictFile): string | null {
  const r = file.resolution;
  if (!r) return null;
  if (r.choice === 'contributor') return file.contributor;
  if (r.choice === 'target') return file.target;
  return r.text;
}

function FileBlock({ file, base, open, busy, editing, suggestion, onChoose, onEdit, onEditText, onCancelEdit, onSaveText, onSuggest, onApply, onIgnore }: {
  file: ConflictFile;
  base: string;
  open: boolean;
  busy: Busy;
  editing: string | undefined;
  suggestion: string | undefined;
  onChoose: (resolution: FileResolution) => void;
  onEdit: () => void;
  onEditText: (text: string) => void;
  onCancelEdit: () => void;
  onSaveText: () => void;
  onSuggest: () => void;
  onApply: () => void;
  onIgnore: () => void;
}) {
  const blocks = conflictBlocks(file.merged);
  const choice = file.resolution?.choice ?? null;
  const working = busy !== null;
  const state = choice === null ? 'todo' : choice;
  const resolved = resolvedText(file);
  // What the commit changes on the contributor's branch: their version against the resolution.
  const resolution = useMemo(
    () => (resolved !== null && file.contributor !== null ? shownDiff(file.contributor, resolved) : null),
    [resolved, file.contributor],
  );
  const suggested = useMemo(
    () => (suggestion !== undefined && file.contributor !== null ? shownDiff(file.contributor, suggestion) : null),
    [suggestion, file.contributor],
  );
  const hunks = useMemo(() => (file.merged !== null ? conflictHunks(file.merged) : null), [file.merged]);
  const markersLeft = editing !== undefined && hasConflictMarkers(editing);

  return (
    <section data-conflict-file={file.path} className={cn(ISLAND, 'flex min-w-0 flex-col gap-2 p-3')} aria-label={file.path}>
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 truncate text-[12px] font-medium text-foreground" title={file.path}>
          {file.path}<span className="font-normal text-muted-foreground"> · {t('forgeConflict.file.blocks', { count: blocks })}</span>
        </h3>
        {file.sensitive && (
          <span data-conflict-sensitive="" title={t('forgeConflict.file.sensitiveHint')} className={cn(CHIP, AMBER)}>{t('forgeConflict.file.sensitive')}</span>
        )}
        <span data-conflict-state={state} className={cn(CHIP, 'ml-auto', choice === null ? MUTED : GREEN)}>
          {t(`forgeConflict.file.state.${state}`, { base })}
        </span>
      </div>

      {editing !== undefined ? (
        <>
          {/* code-font: the person writes the resolved file */}
          <Textarea className="scrollbar-thin min-h-48 resize-y font-mono text-[11.5px] leading-[1.5]"
            data-conflict-editor=""
            value={editing}
            onChange={(e) => onEditText(e.target.value)}
            rows={14}
            autoFocus
            spellCheck={false}
            aria-label={t('forgeConflict.file.editLabel', { path: file.path })}
          />
          {markersLeft && <p className={ERROR}>{t('forgeConflict.file.markersLeft')}</p>}
          <div className="flex justify-end gap-2">
            <WidgetButton onClick={onCancelEdit} disabled={working} label={t('forgeConflict.file.cancel')} />
            <WidgetButton data-conflict-save="" onClick={onSaveText} disabled={working || markersLeft || editing.trim() === ''}
              label={busy?.what === 'file' && busy.path === file.path ? t('forgeConflict.file.saving') : t('forgeConflict.file.save')} />
          </div>
        </>
      ) : suggestion !== undefined ? (
        <>
          <p className="text-[11.5px] text-muted-foreground">{t('forgeConflict.file.suggestion')}</p>
          {suggested === null ? (
            <p className="text-[11.5px] text-muted-foreground">{t('forgeConflict.file.unreadable')}</p>
          ) : suggested.length === 0 ? (
            <p className="text-[11.5px] text-muted-foreground">{t('forgeConflict.file.noChange')}</p>
          ) : (
            <CodeLines lines={suggested} label={t('forgeConflict.file.suggestion')} />
          )}
          <div className="flex justify-end gap-2">
            <WidgetButton data-conflict-ignore="" onClick={onIgnore} disabled={working} label={t('forgeConflict.file.ignore')} />
            <WidgetButton data-conflict-apply="" onClick={onApply} disabled={working} label={t('forgeConflict.file.apply')} />
          </div>
        </>
      ) : choice !== null ? (
        <>
          <p className="text-[11.5px] text-muted-foreground">{t('forgeConflict.file.resolutionDiff')}</p>
          {resolution === null ? (
            <p className="text-[11.5px] text-muted-foreground">{t('forgeConflict.file.unreadable')}</p>
          ) : resolution.length === 0 ? (
            <p data-conflict-no-change="" className="text-[11.5px] text-muted-foreground">{t('forgeConflict.file.noChange')}</p>
          ) : (
            <CodeLines lines={resolution} label={t('forgeConflict.file.resolutionDiff')} />
          )}
        </>
      ) : hunks === null ? (
        <p className="text-[11.5px] text-muted-foreground">{t('forgeConflict.file.unreadable')}</p>
      ) : (
        <CodeLines lines={hunks} label={file.path} />
      )}

      {open && editing === undefined && suggestion === undefined && (
        <div className="flex flex-wrap gap-2">
          <WidgetButton data-conflict-keep="contributor" aria-pressed={choice === 'contributor'} className={PRESSED} onClick={() => onChoose({ choice: 'contributor' })}
            disabled={working || file.contributor === null} label={t('forgeConflict.file.keepContributor')} />
          <WidgetButton data-conflict-keep="target" aria-pressed={choice === 'target'} className={PRESSED} onClick={() => onChoose({ choice: 'target' })}
            disabled={working || file.target === null} label={t('forgeConflict.file.keepTarget', { base })} />
          <WidgetButton data-conflict-edit="" onClick={onEdit} disabled={working} label={t('forgeConflict.file.edit')} />
          <WidgetButton data-conflict-suggest="" onClick={onSuggest} disabled={working}
            icon={busy?.what === 'suggest' && busy.path === file.path ? <Loader2 className="size-3.5 animate-spin" /> : undefined}
            label={busy?.what === 'suggest' && busy.path === file.path ? t('forgeConflict.file.suggesting') : t('forgeConflict.file.suggest')} />
        </div>
      )}
    </section>
  );
}

function StepItem({ index, label, state }: { index: number; label: string; state: 'done' | 'current' | 'next' }) {
  return (
    <li data-conflict-step={index} data-state={state}
      aria-current={state === 'current' ? 'step' : undefined}
      className={cn('flex items-center gap-2.5 rounded-md px-2 py-2 text-[12.5px]', state === 'current' ? 'bg-foreground/[0.06] text-foreground' : 'text-muted-foreground')}>
      <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] tabular-nums', state === 'done' ? GREEN : 'bg-foreground/[0.06]')}>
        {state === 'done' ? <Check className="size-3" aria-hidden /> : index}
      </span>
      {label}
    </li>
  );
}

function PreviewDiff({ diff }: { diff: ResolutionDiff | null }) {
  if (!diff) return <p className="text-[11.5px] text-muted-foreground">{t('forgeConflict.preview.unavailable')}</p>;
  const lines = diff.text.split('\n');
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {/* code-font: a diff */}
      <pre data-conflict-preview="" className="scrollbar-thin max-h-[48vh] w-full overflow-auto rounded-md bg-background/60 py-1.5 font-mono text-[11px] leading-[1.5]">
        <div className="w-max min-w-full">
          {lines.slice(0, 3000).map((line, i) => (
            <div key={i} className={cn('whitespace-pre px-2', DIFF_LINE_CLASS[diffLineKind(line)])}>{line || ' '}</div>
          ))}
        </div>
      </pre>
      {(diff.truncated || lines.length > 3000) && <p className="text-[11px] text-muted-foreground">{t('forgeConflict.preview.cut')}</p>}
    </div>
  );
}

export function ConflictDialog({ project, pull, onClose, onPublish }: ConflictDialogProps): ReactElement {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [conflict, setConflict] = useState<ConflictView | null>(null);
  const [diff, setDiff] = useState<ResolutionDiff | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [prepared, acc] = await Promise.all([prepareConflict(project, pull.number), projectAccount(project)]);
      if (!alive) return;
      setAccount(acc);
      if (!prepared.ok) { setLoad({ kind: 'error', message: prepared.message }); return; }
      setConflict(prepared.value);
      if (prepared.value.state === 'proposed') {
        const read = await getConflict(project, prepared.value.id);
        if (!alive) return;
        if (read.ok) { setConflict(read.value.conflict); setDiff(read.value.diff); }
      }
      setLoad({ kind: 'ready' });
    })();
    return () => { alive = false; };
  }, [project, pull.number]);

  const run = useCallback(async <T,>(what: Busy, step: () => Promise<{ ok: true; value: T } | { ok: false; message: string }>): Promise<T | null> => {
    setBusy(what);
    setError(null);
    const out = await step();
    setBusy(null);
    if (!out.ok) { setError(out.message); return null; }
    return out.value;
  }, []);

  const without = (map: Record<string, string>, path: string) => {
    const next = { ...map };
    delete next[path];
    return next;
  };

  const choose = async (path: string, resolution: FileResolution) => {
    if (!conflict) return;
    const view = await run({ what: 'file', path }, () => resolveFile(project, conflict.id, path, resolution));
    if (!view) return;
    setConflict(view);
    setEditing((m) => without(m, path));
    setSuggestions((m) => without(m, path));
  };

  const suggest = async (path: string) => {
    if (!conflict) return;
    const text = await run({ what: 'suggest', path }, () => suggestResolution(project, conflict.id, path));
    if (text !== null) setSuggestions((m) => ({ ...m, [path]: text }));
  };

  const propose = async () => {
    if (!conflict) return;
    const out = await run({ what: 'propose' }, () => proposeResolution(project, conflict.id));
    if (!out) return;
    setConflict(out.conflict);
    setDiff(out.diff);
  };

  const discard = async () => {
    if (!conflict) { onClose(); return; }
    const state = await run({ what: 'discard' }, () => discardConflict(project, conflict.id));
    if (state === null) return;
    toast.success(t('forgeConflict.discarded'));
    onClose();
  };

  const files = conflict?.files ?? [];
  const left = files.filter((f) => !f.resolution).length;
  const step = !conflict || conflict.state === 'open' ? 2 : conflict.state === 'proposed' ? 3 : 4;
  const branch = conflict ? `${conflict.head.repository.split('/')[0] ?? ''}:${conflict.head.ref}` : '';
  const base = conflict?.base.ref ?? 'main';
  const working = busy !== null;
  const stepState = (i: number) => (i < step ? 'done' : i === step ? 'current' : 'next') as 'done' | 'current' | 'next';

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !working) onClose(); }}>
      <DialogContent data-conflict-dialog="" className="flex max-h-[88vh] max-w-[900px] flex-col gap-3 overflow-hidden">
        <DialogTitle className="flex min-w-0 items-center gap-2 text-sm">
          <GitMerge className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">
            {conflict ? t('forgeConflict.title', { number: pull.number, branch }) : t('forgeConflict.titleLoading', { number: pull.number })}
          </span>
          {conflict && <span data-conflict-count="" className={cn(CHIP, AMBER)}>{t('forgeConflict.files', { count: files.length })}</span>}
        </DialogTitle>
        <DialogDescription className="sr-only">{pull.title}</DialogDescription>

        {load.kind === 'loading' ? (
          <div className="flex items-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />{t('forgeConflict.preparing')}
          </div>
        ) : load.kind === 'error' || !conflict ? (
          <p data-conflict-load-error="" className={cn(ERROR, 'py-6')}>{load.kind === 'error' ? load.message : t('forgeConflict.preparing')}</p>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[14rem_minmax(0,1fr)]">
            <section className={cn(ISLAND, 'p-3')} aria-label={t('forgeConflict.steps.title')}>
              <h3 className="px-2 pb-1.5 text-[11.5px] font-medium text-muted-foreground">{t('forgeConflict.steps.title')}</h3>
              <ol className="flex flex-col gap-0.5">
                <StepItem index={1} label={t('forgeConflict.steps.checks')} state="done" />
                <StepItem index={2} label={t('forgeConflict.steps.resolution')} state={stepState(2)} />
                <StepItem index={3} label={t('forgeConflict.steps.preview')} state={stepState(3)} />
                <StepItem index={4} label={t('forgeConflict.steps.publish')} state={stepState(4)} />
              </ol>
            </section>

            <div className="scrollbar-thin flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto">
              <section className={cn(ISLAND, 'flex flex-col gap-2 p-3')} aria-label={t('forgeConflict.checks.title')}>
                <h3 className="text-[11.5px] font-medium text-muted-foreground">{t('forgeConflict.checks.title')}</h3>
                <dl className="flex flex-col gap-2">
                  <Row label={t('forgeConflict.checks.account')}>
                    {account ?? <span className="text-red-600 dark:text-red-400">{t('forgeConflict.checks.noAccount')}</span>}
                  </Row>
                  <Row label={t('forgeConflict.checks.method')}>{t('forgeConflict.checks.methodValue')}</Row>
                </dl>
              </section>

              {step === 2 ? files.map((file) => (
                <FileBlock
                  key={file.path}
                  file={file}
                  base={base}
                  open
                  busy={busy}
                  editing={editing[file.path]}
                  suggestion={suggestions[file.path]}
                  onChoose={(r) => { void choose(file.path, r); }}
                  onEdit={() => setEditing((m) => ({ ...m, [file.path]: file.resolution?.choice === 'text' && file.resolution.text !== null ? file.resolution.text : file.merged ?? '' }))}
                  onEditText={(text) => setEditing((m) => ({ ...m, [file.path]: text }))}
                  onCancelEdit={() => setEditing((m) => without(m, file.path))}
                  onSaveText={() => { void choose(file.path, { choice: 'text', text: editing[file.path] ?? '' }); }}
                  onSuggest={() => { void suggest(file.path); }}
                  onApply={() => { void choose(file.path, { choice: 'text', text: suggestions[file.path] ?? '' }); }}
                  onIgnore={() => setSuggestions((m) => without(m, file.path))}
                />
              )) : (
                <section className={cn(ISLAND, 'flex min-w-0 flex-col gap-2 p-3')} aria-label={t('forgeConflict.preview.title')}>
                  <h3 className="text-[11.5px] font-medium text-muted-foreground">{t('forgeConflict.preview.title')}</h3>
                  {conflict.commit_sha && (
                    <dl><Row label={t('forgeConflict.preview.commit')}><span className="tabular-nums" title={conflict.commit_sha}>{conflict.commit_sha.slice(0, 12)}</span></Row></dl>
                  )}
                  <PreviewDiff diff={diff} />
                </section>
              )}
            </div>
          </div>
        )}

        {error && <p data-conflict-error="" className={ERROR}>{error}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="mr-auto text-[11.5px] text-muted-foreground">{t('forgeConflict.note')}</p>
          {conflict && step < 4 && (
            <WidgetButton data-conflict-discard="" onClick={() => { void discard(); }} disabled={working}
              label={busy?.what === 'discard' ? t('forgeConflict.discarding') : t('forgeConflict.discard')} />
          )}
          <WidgetButton data-conflict-close="" onClick={onClose} disabled={working} label={t('forgeConflict.close')} />
          {step === 2 && conflict && (
            <WidgetButton
              primary
              data-conflict-next=""
              onClick={() => { void propose(); }}
              disabled={working || left > 0}
              title={left > 0 ? t('forgeConflict.left', { count: left }) : undefined}
              icon={busy?.what === 'propose' ? <Loader2 className="size-3.5 animate-spin" /> : undefined}
              label={busy?.what === 'propose' ? t('forgeConflict.committing') : t('forgeConflict.next')}
            />
          )}
          {step === 3 && conflict?.proposal_id && (
            <WidgetButton
              primary
              data-conflict-publish=""
              onClick={() => onPublish(conflict.proposal_id!)}
              icon={<Send className="size-3.5" />}
              label={t('forgeConflict.publish')}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
