/**
 * GitHub issues — browser half: the Issues widget of the "Git" stack, the
 * Issue window, and the project's row in its settings.
 *
 * Written on `@timon/ui` and this plugin's own routes only, like any
 * third-party plugin. An issue's title, body, author and labels were written
 * by someone else: React prints them as text, never as markup, and the
 * window frames the body as outside data. Nothing here writes on GitHub; an
 * import creates one TO DO idea, once.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import * as ui from '@timon/ui';
import type { ClientContext, WidgetChromeProps } from '@timon-ai/sdk';
import messages from './messages.json';
import {
  errorKey, labelProblem, parseIssueInput, safeHref, shouldRead, sortCandidates, toImport,
  type Candidate, type Candidates, type IssueDetails, type IssueLabel, type IssueTodo, type ProjectLabel,
} from './issues-model.js';

const t = ui.createTranslator(messages);

// The SDK leaves React out of its types; narrowed at this boundary.
type Children = { children?: ReactNode };
type Aria = { title?: string; 'aria-label'?: string };
const Tile = ui.Tile as ComponentType<Children & { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string; bodyClassName?: string }>;
const Button = ui.Button as ComponentType<Children & Aria & {
  type?: 'button' | 'submit';
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'outline' | 'ghost' | 'secondary';
  size?: 'sm' | 'default';
  className?: string;
}>;
const Input = ui.Input as ComponentType<{
  id?: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  className?: string;
  'aria-invalid'?: boolean;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}>;
const Label = ui.Label as ComponentType<Children & { htmlFor?: string; className?: string }>;
const Dialog = ui.Dialog as ComponentType<Children & { open: boolean; onOpenChange: (open: boolean) => void }>;
const DialogContent = ui.DialogContent as ComponentType<Children & { className?: string } & Record<`data-${string}`, string>>;
const DialogTitle = ui.DialogTitle as ComponentType<Children & { className?: string }>;
const DialogDescription = ui.DialogDescription as ComponentType<Children & { className?: string }>;
const DropdownMenu = ui.DropdownMenu as ComponentType<Children & { modal?: boolean }>;
const DropdownMenuTrigger = ui.DropdownMenuTrigger as ComponentType<Children & { asChild?: boolean }>;
const DropdownMenuContent = ui.DropdownMenuContent as ComponentType<Children & { align?: 'start' | 'end'; sideOffset?: number; className?: string }>;
const DropdownMenuItem = ui.DropdownMenuItem as ComponentType<Children & { onSelect?: () => void; className?: string } & Record<`data-${string}`, string>>;
const NativeViewCover = ui.NativeViewCover as ComponentType<Record<string, never>>;
const GitStackProjectPicker = ui.GitStackProjectPicker as ComponentType<{ none: string; label: string; className?: string }>;
const cn = ui.cn;

type Api = ClientContext['api'];
type Failure = { code: string | null };
type Result<T> = { ok: true; value: T } | { ok: false; code: string | null };

async function call<T>(api: Api, path: string, init?: { method: string; body: unknown }): Promise<Result<T>> {
  try {
    const response = await api(path, init
      ? { method: init.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }
      : { cache: 'no-store' });
    const json = await response.json().catch(() => null) as (T & { error?: string }) | null;
    if (!response.ok || !json) return { ok: false, code: json?.error ?? null };
    return { ok: true, value: json };
  } catch {
    return { ok: false, code: null };
  }
}

const query = (project: string, extra: Record<string, string> = {}) => new URLSearchParams({ project, ...extra }).toString();

// Classes the app already ships: a plugin's own would not be in its stylesheet.
const ICON_BUTTON = 'inline-flex h-7 w-7 shrink-0 items-center justify-center gap-1 rounded-md text-[11px] font-medium outline-none transition-colors '
  + 'focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 text-muted-foreground hover:bg-muted hover:text-foreground';
const PRIMARY_ICON_BUTTON = 'inline-flex h-7 w-7 shrink-0 items-center justify-center gap-1 rounded-md text-[11px] font-medium outline-none transition-colors '
  + 'focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1]';
const CHIP = 'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium';
const LABEL_TONE = 'bg-sky-500/15 text-sky-700 dark:text-sky-300';
const TODO_TONE = 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
const PR_TONE = 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
const MENU_ITEM = 'flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 outline-none focus:bg-muted';
const MENU = 'z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-elev-2';
const ISLAND = 'rounded-lg bg-foreground/[0.035]';

/** Line icons, 24×24, drawn in the current colour. */
function Icon({ d, className = 'size-3.5' }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const ICONS = {
  import: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  todo: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  hide: 'M6 6l12 12M18 6L6 18',
  read: 'M4 5h7a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4zM20 5h-7a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h7z',
  issue: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v.01',
  pull: 'M6 4v16M18 10v10M6 4a2 2 0 1 0 0 .01M18 10a2 2 0 1 0 0 .01M14 6h2a2 2 0 0 1 2 2v2',
};
const ISSUES_PICTO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5"/></svg>';

function LabelChips({ labels }: { labels: readonly IssueLabel[] }) {
  return <>{labels.slice(0, 2).map((label) => (
    <span key={label.name} data-issue-label={label.name} className={cn(CHIP, LABEL_TONE, 'max-w-[8rem] truncate')} title={label.name}>{label.name}</span>
  ))}</>;
}

function TodoChips({ todo }: { todo: IssueTodo | null }) {
  if (!todo) return null;
  return (
    <>
      <span data-issue-todo={String(todo.id)} className={cn(CHIP, TODO_TONE)} title={`#${todo.id}`}>{t('chip.todo')}</span>
      {todo.pr && <span data-issue-pr={String(todo.pr.number)} className={cn(CHIP, PR_TONE)}>{t('chip.pr', { number: todo.pr.number })}</span>}
    </>
  );
}

const meta = (number: number, author: string | null) => `#${number} · ${author ?? t('deletedAuthor')}`;

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type Notice = { text: string; tone: 'info' | 'error' };

function IssueRow({ issue, busy, onImport, onOpenTodo, onRead, onCopy, onDismiss }: {
  issue: Candidate;
  busy: boolean;
  onImport: () => void;
  onOpenTodo: (id: number) => void;
  onRead: () => void;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  const imported = issue.todo !== null;
  const href = safeHref(issue.url);
  const pr = safeHref(issue.todo?.pr?.url);
  const action = imported ? t('openTodo') : busy ? t('importing') : t('import');
  return (
    <li data-issue-row={String(issue.number)} className="flex items-center gap-1 rounded-lg bg-muted/30 py-2 pl-2.5 pr-1 transition-colors hover:bg-muted/50">
      <div className="min-w-0 flex-1">
        <div className={cn('line-clamp-2 break-words text-[12.5px] font-medium leading-snug', imported ? 'text-muted-foreground' : 'text-foreground')} title={issue.title}>{issue.title}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate tabular-nums">{meta(issue.number, issue.author)}</span>
          {imported ? <TodoChips todo={issue.todo} /> : <LabelChips labels={issue.labels} />}
        </div>
      </div>
      {/* Icon only: the row's width belongs to the issue, not to its action. */}
      <button
        type="button"
        data-issue-action={imported ? 'open' : 'import'}
        onClick={imported ? () => onOpenTodo(issue.todo!.id) : onImport}
        disabled={busy}
        title={action}
        aria-label={action}
        className={imported ? ICON_BUTTON : PRIMARY_ICON_BUTTON}
      >
        <Icon d={imported ? ICONS.todo : ICONS.import} />
      </button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button type="button" data-issue-more="" title={t('more')} aria-label={t('more')} className={ICON_BUTTON}>
            <Icon d={ICONS.more} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent sideOffset={6} align="end" className={MENU}>
          <NativeViewCover />
          <DropdownMenuItem data-menu-read="" onSelect={onRead} className={MENU_ITEM}><Icon d={ICONS.read} />{t('readText')}</DropdownMenuItem>
          {href && (
            <DropdownMenuItem onSelect={() => { window.open(href, '_blank', 'noopener,noreferrer'); }} className={MENU_ITEM}>
              <Icon d={ICONS.external} />{t('openOnGitHub')}
            </DropdownMenuItem>
          )}
          {pr && issue.todo?.pr && (
            <DropdownMenuItem onSelect={() => { window.open(pr, '_blank', 'noopener,noreferrer'); }} className={MENU_ITEM}>
              <Icon d={ICONS.pull} />{t('openPullRequest', { number: issue.todo.pr.number })}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem data-menu-copy="" onSelect={onCopy} className={MENU_ITEM}><Icon d={ICONS.copy} />{t('copyLink')}</DropdownMenuItem>
          {!imported && (
            <DropdownMenuItem data-menu-dismiss="" onSelect={onDismiss} className={MENU_ITEM}><Icon d={ICONS.hide} />{t('dismiss')}</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-6">
      <Icon d={ICONS.issue} className="size-4 text-muted-foreground/60" />
      <span data-issues-empty="" className="text-center text-[12.5px] text-muted-foreground">{text}</span>
    </div>
  );
}

type Load = { kind: 'idle' | 'loading' } | { kind: 'error'; code: string | null } | { kind: 'ready'; list: Candidates };
/** What the Issue window opens on: an issue of the list, or a number to type. */
type Opened = { number: number } | { lookup: true };

/**
 * The last list read for each project, shared by every Issues widget of the
 * page (one per chat's rail): a tab kept mounted behind the front one shows
 * it rather than asking GitHub again (`shouldRead`).
 */
const lastRead = new Map<string, { list: Candidates; at: number }>();

function IssuesWidget({ api, handle, className }: { api: Api } & Partial<WidgetChromeProps>) {
  const { project } = ui.useGitStackProject();
  const { openTodo, todoModal } = ui.useTodoOpener();
  const [load, setLoad] = useState<Load>({ kind: 'idle' });
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const front = ui.useWidgetInFront();
  const frontNow = useRef(front);
  frontNow.current = front;

  const reload = useCallback(async (quiet = false) => {
    if (!project) { setLoad({ kind: 'idle' }); return; }
    if (!quiet) setLoad({ kind: 'loading' });
    const out = await call<Candidates>(api, `candidates?${query(project)}`);
    if (out.ok) lastRead.set(project, { list: out.value, at: Date.now() });
    setLoad(out.ok ? { kind: 'ready', list: out.value } : { kind: 'error', code: out.code });
  }, [api, project]);

  // Behind another tab, a list read less than a minute ago is enough for the
  // count; in front, or older, it is read again.
  useEffect(() => {
    setNotice(null);
    const known = project ? lastRead.get(project) : undefined;
    if (known) setLoad({ kind: 'ready', list: known.list });
    if (shouldRead(frontNow.current, known?.at ?? null, Date.now())) void reload(!!known);
  }, [reload, project]);
  // Brought to the front: what it shows is read again, behind what it had.
  const wasFront = useRef(front);
  useEffect(() => {
    if (front && !wasFront.current) void reload(true);
    wasFront.current = front;
  }, [front, reload]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const importIssue = useCallback(async (number: number): Promise<IssueTodo | Failure> => {
    if (!project) return { code: null };
    setBusy(number);
    const out = await call<{ created: boolean; todo: { id: number } }>(api, 'import', { method: 'POST', body: { project, issue: number } });
    setBusy(null);
    if (!out.ok) {
      setNotice({ text: t(errorKey(out.code)), tone: 'error' });
      return { code: out.code };
    }
    setNotice({ text: t(out.value.created ? 'notice.imported' : 'notice.known', { id: out.value.todo.id }), tone: 'info' });
    void reload(true);
    return { id: out.value.todo.id, status: 'open', progress: null, pr: null };
  }, [api, project, reload]);

  const dismiss = async (number: number) => {
    if (!project) return;
    const out = await call(api, 'dismiss', { method: 'POST', body: { project, issue: number } });
    setNotice(out.ok ? { text: t('notice.dismissed', { number }), tone: 'info' } : { text: t(errorKey(out.code)), tone: 'error' });
    if (out.ok) void reload(true);
  };

  const copyLink = async (url: string) => {
    setNotice((await copy(url)) ? { text: t('notice.copied'), tone: 'info' } : { text: t('notice.copyFailed'), tone: 'error' });
  };

  const issues = useMemo(() => (load.kind === 'ready' ? sortCandidates(load.list.issues) : []), [load]);
  // What is left to import: the only number shown, on the tab once stacked ("Issues 2"), else by the title.
  const left = load.kind === 'ready' ? toImport(load.list.issues) : null;
  const countOnTab = ui.useWidgetCount(left);
  const subtitle = left !== null && !countOnTab ? String(left) : undefined;
  // Stacked, the reload goes to the widget's menu, like the Jobs tab's: the tab strip has no room for it.
  const refreshInMenu = ui.useWidgetMenu(useMemo(() => (project ? [{
    key: 'refresh', label: t('refresh'), icon: <Icon d={ICONS.refresh} />, onSelect: () => { void reload(); },
  }] : []), [project, reload]));

  const actions = (
    <>
      <GitStackProjectPicker none={t('chooseProjectOption')} label={t('selectProject')} className="max-w-[8rem]" />
      {project && (
        <>
          <button type="button" data-issues-add="" onClick={() => setOpened({ lookup: true })} title={t('importByNumber')} aria-label={t('importByNumber')} className={ICON_BUTTON}>
            <Icon d={ICONS.plus} />
          </button>
          {!refreshInMenu && (
            <button type="button" data-issues-refresh="" onClick={() => void reload()} disabled={load.kind === 'loading'} title={t('refresh')} aria-label={t('refresh')} className={ICON_BUTTON}>
              <Icon d={ICONS.refresh} />
            </button>
          )}
        </>
      )}
      {handle as ReactNode}
    </>
  );

  return (
    <Tile
      title={t('widget.title')}
      subtitle={subtitle}
      className={cn(ui.HUD_SURFACE, className)}
      bodyClassName="px-1.5 pb-3 pt-1"
      actions={actions}
    >
      {notice && (
        <p data-issues-notice={notice.tone} role="status" className={cn('px-1 pb-1 text-[11px]', notice.tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
          {notice.text}
        </p>
      )}
      {!project ? (
        <Empty text={t('chooseProject')} />
      ) : load.kind === 'loading' || load.kind === 'idle' ? (
        <Empty text={t('loading')} />
      ) : load.kind === 'error' ? (
        <Empty text={t(errorKey(load.code))} />
      ) : issues.length === 0 ? (
        <Empty text={t('empty', { label: load.kind === 'ready' ? load.list.label : '' })} />
      ) : (
        <ul data-issues-list="" className="flex flex-col gap-1">
          {issues.map((issue) => (
            <IssueRow
              key={issue.number}
              issue={issue}
              busy={busy === issue.number}
              onImport={() => { void importIssue(issue.number); }}
              onOpenTodo={openTodo}
              onRead={() => setOpened({ number: issue.number })}
              onCopy={() => { void copyLink(issue.url); }}
              onDismiss={() => { void dismiss(issue.number); }}
            />
          ))}
        </ul>
      )}
      {opened && project && (
        <IssueDialog
          api={api}
          project={project}
          repo={load.kind === 'ready' ? load.list.repo : null}
          opened={opened}
          onImport={importIssue}
          onOpenTodo={(id) => { setOpened(null); openTodo(id); }}
          onClose={() => setOpened(null)}
        />
      )}
      {todoModal as ReactNode}
    </Tile>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 rounded-md bg-background/60 px-3 py-2 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

type Read = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; text: string } | { kind: 'ready'; issue: IssueDetails };

/**
 * The Issue window: the issue's text, framed as outside data, and one main
 * action, Import. Opened on an issue of the list, or on "+" with a field for
 * a number or a link, read before anything is imported.
 */
function IssueDialog({ api, project, repo, opened, onImport, onOpenTodo, onClose }: {
  api: Api;
  project: string;
  repo: string | null;
  opened: Opened;
  onImport: (number: number) => Promise<IssueTodo | Failure>;
  onOpenTodo: (id: number) => void;
  onClose: () => void;
}) {
  const lookup = 'lookup' in opened;
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [read, setRead] = useState<Read>({ kind: 'idle' });
  const [importing, setImporting] = useState(false);

  const readIssue = useCallback(async (number: number) => {
    setRead({ kind: 'loading' });
    const out = await call<IssueDetails>(api, `issue?${query(project, { issue: String(number) })}`);
    setRead(out.ok ? { kind: 'ready', issue: out.value } : { kind: 'error', text: t(errorKey(out.code)) });
  }, [api, project]);

  useEffect(() => { if ('number' in opened) void readIssue(opened.number); }, [opened, readIssue]);

  const submitLookup = () => {
    const parsed = parseIssueInput(typed, repo);
    if ('problem' in parsed) { setProblem(t(`problem.${parsed.problem}`, { repo: repo ?? '' })); return; }
    setProblem(null);
    void readIssue(parsed.number);
  };

  const issue = read.kind === 'ready' ? read.issue : null;
  const closed = issue?.state === 'closed';
  const runImport = async () => {
    if (!issue) return;
    setImporting(true);
    const out = await onImport(issue.number);
    setImporting(false);
    if ('id' in out) setRead({ kind: 'ready', issue: { ...issue, todo: out } });
    else setRead({ kind: 'error', text: t(errorKey(out.code)) });
  };
  const href = safeHref(issue?.url);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-issue-dialog="" className="flex max-h-[85vh] max-w-[900px] flex-col gap-3 overflow-hidden">
        <DialogTitle className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <Icon d={ICONS.issue} className="size-4 shrink-0 text-muted-foreground" />
          <span data-issue-title="" className="min-w-0 truncate">{issue ? issue.title : t('dialog.lookupTitle')}</span>
          {issue && <span className={cn(CHIP, 'bg-foreground/[0.06] text-muted-foreground')}>{meta(issue.number, issue.author)}</span>}
          {issue && <LabelChips labels={issue.labels} />}
        </DialogTitle>
        <DialogDescription className="sr-only">{t('dialog.text')}</DialogDescription>

        {lookup && (
          <div className="flex items-end gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Label htmlFor="github-issues-lookup" className="text-[11.5px] text-muted-foreground">{t('dialog.lookupLabel')}</Label>
              <Input
                id="github-issues-lookup"
                value={typed}
                autoFocus
                maxLength={300}
                placeholder={t('dialog.lookupPlaceholder')}
                aria-invalid={problem !== null}
                onChange={(e) => { setTyped(e.target.value); setProblem(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitLookup(); } }}
              />
            </div>
            <Button type="button" variant="outline" onClick={submitLookup} disabled={read.kind === 'loading'} className="shrink-0">
              {read.kind === 'loading' ? t('dialog.reading') : t('dialog.read')}
            </Button>
          </div>
        )}
        {problem && <p data-issue-problem="" className="text-[11.5px] text-red-600 dark:text-red-400">{problem}</p>}

        {(issue || read.kind === 'loading' || read.kind === 'error') && (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_19rem]">
            <section className={cn(ISLAND, 'flex min-h-0 min-w-0 flex-col gap-2 p-3')} aria-label={t('dialog.text')}>
              <h3 className="text-[11.5px] font-medium text-muted-foreground">{t('dialog.text')}</h3>
              {read.kind === 'loading' ? (
                <p className="text-xs text-muted-foreground">{t('loading')}</p>
              ) : read.kind === 'error' ? (
                <p data-issue-error="" className="text-xs text-red-600 dark:text-red-400">{read.text}</p>
              ) : issue && (
                <>
                  {/* Text, not markup: what an outsider wrote is shown, never interpreted. */}
                  <div data-issue-body="" className="scrollbar-thin max-h-[45vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-background/60 px-3 py-2 text-[12.5px] leading-relaxed">
                    {issue.body.trim() ? issue.body : <span className="text-muted-foreground">{t('dialog.noText')}</span>}
                  </div>
                  {issue.truncated && <p className="text-[11px] text-muted-foreground">{t('dialog.cut')}</p>}
                </>
              )}
            </section>
            {issue && (
              <section className={cn(ISLAND, 'flex min-w-0 flex-col gap-2 p-3')} aria-label={t('dialog.importSection')}>
                <h3 className="text-[11.5px] font-medium text-muted-foreground">{t('dialog.importSection')}</h3>
                <dl className="flex flex-col gap-2">
                  <Row label={t('dialog.project')}>{project}</Row>
                  <Row label={t('dialog.link')}>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">{`github · ${issue.repo}#${issue.number}`}</a>
                    ) : `github · ${issue.repo}#${issue.number}`}
                  </Row>
                  {closed && <Row label={t('dialog.state')}>{t('dialog.stateClosed')}</Row>}
                  {issue.todo && <Row label={t('chip.todo')}><span className={cn(CHIP, TODO_TONE)}>{`#${issue.todo.id}`}</span></Row>}
                </dl>
              </section>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('dialog.close')}</Button>
          {issue?.todo ? (
            <Button type="button" size="sm" onClick={() => onOpenTodo(issue.todo!.id)}>
              <span data-issue-dialog-open="" className="inline-flex items-center gap-1.5"><Icon d={ICONS.todo} />{t('openTodo')}</span>
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => { void runImport(); }}
              disabled={!issue || closed || importing}
              title={closed ? t('dialog.closedHint') : undefined}
            >
              <span data-issue-dialog-import="" className="inline-flex items-center gap-1.5"><Icon d={ICONS.import} />{importing ? t('importing') : t('import')}</span>
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Setting = { kind: 'loading' } | { kind: 'hidden' } | { kind: 'ready'; label: ProjectLabel; count: number | null };

/**
 * The project's row under "Integrations": its label and what is left to
 * import, one action (Configure), the way back to the default label in "…".
 * A project that does not open pull requests on GitHub gets no row.
 */
function SettingsRow({ api }: { api: Api }) {
  const settings = ui.useProjectSettings();
  const project = settings?.project ?? null;
  const [state, setState] = useState<Setting>({ kind: 'loading' });
  const [editing, setEditing] = useState(false);

  const reload = useCallback(async () => {
    if (!project) { setState({ kind: 'hidden' }); return; }
    const out = await call<ProjectLabel>(api, `project?${query(project)}`);
    if (!out.ok) { setState({ kind: 'hidden' }); return; }
    setState({ kind: 'ready', label: out.value, count: null });
    // The count asks GitHub: it follows the label, never holds the row back.
    const list = await call<Candidates>(api, `candidates?${query(project)}`);
    if (list.ok) setState({ kind: 'ready', label: out.value, count: toImport(list.value.issues) });
  }, [api, project]);

  useEffect(() => { void reload(); }, [reload]);

  const useDefault = async () => {
    if (!project) return;
    const out = await call(api, 'project', { method: 'PUT', body: { project, label: null } });
    if (out.ok) void reload();
  };

  if (state.kind !== 'ready' || !project) return null;
  const { label, count } = state;
  return (
    <div data-issues-settings={project} className="flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-foreground">{t('settings.title')}</div>
        <div data-issues-settings-status="" className="truncate text-[11px] text-muted-foreground">
          {count === null ? t('settings.statusNoCount', { label: label.label }) : t('settings.status', { label: label.label, count })}
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)} className="shrink-0">
        <span data-issues-configure="">{t('settings.configure')}</span>
      </Button>
      {label.custom && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button type="button" title={t('more')} aria-label={t('more')} className={ICON_BUTTON}><Icon d={ICONS.more} /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent sideOffset={6} align="end" className={MENU}>
            <NativeViewCover />
            <DropdownMenuItem data-menu-default-label="" onSelect={() => { void useDefault(); }} className={MENU_ITEM}>{t('settings.useDefault')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {editing && (
        <LabelDialog api={api} project={project} current={label.label} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void reload(); }} />
      )}
    </div>
  );
}

function LabelDialog({ api, project, current, onClose, onSaved }: {
  api: Api;
  project: string;
  current: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = labelProblem(value);
  const save = async () => {
    if (problem) return;
    setSaving(true);
    const out = await call(api, 'project', { method: 'PUT', body: { project, label: value.trim() } });
    setSaving(false);
    if (out.ok) onSaved();
    else setError(t(errorKey(out.code)));
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-issues-label-dialog="" className="max-w-[460px]">
        <DialogTitle className="text-sm">{t('settings.dialogTitle', { project })}</DialogTitle>
        <DialogDescription className="sr-only">{t('settings.label')}</DialogDescription>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="github-issues-label" className="text-[11.5px] text-muted-foreground">{t('settings.label')}</Label>
          <Input
            id="github-issues-label"
            value={value}
            autoFocus
            maxLength={60}
            aria-invalid={problem !== null && value !== ''}
            onChange={(e) => { setValue(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }}
          />
          {problem && value !== '' && <p className="text-[11.5px] text-red-600 dark:text-red-400">{t(`labelProblem.${problem}`)}</p>}
          {error && <p className="text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('settings.cancel')}</Button>
          <Button type="button" size="sm" onClick={() => { void save(); }} disabled={!!problem || saving}>
            <span data-issues-label-save="">{saving ? t('settings.saving') : t('settings.save')}</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function apply(ctx: ClientContext): () => void {
  const api: Api = (path, init) => ctx.api(path, init);
  const Widget = (props: Partial<WidgetChromeProps>) => <IssuesWidget api={api} {...props} />;
  const Settings = () => <SettingsRow api={api} />;
  const disposers = [
    ctx.slots.register({
      slot: 'cockpit.widget',
      key: 'issues',
      widget: {
        title: t('widget.title'),
        description: t('widget.description'),
        icon: ISSUES_PICTO,
        // Its count stays on its tab ("Issues 2") while another tab is in front.
        liveCount: true,
        zone: 'droite',
        frame: 'none',
        height: 320,
        minHeight: 160,
      },
    }, Widget as never),
    ctx.slots.register({ slot: 'project.settings' }, Settings),
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
