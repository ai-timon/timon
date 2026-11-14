'use client';

/**
 * Settings › System › Security: the mission fence (`host.isolation`).
 * Superadmin only, on the tab (`settings-layout.ts`) and on the daemon route.
 *
 * One card of rows. The first says what a mission launched now gets, from
 * the daemon's verdict, never from the mode: `auto` on a machine without the
 * mechanism reads as unprotected, in amber. The others set the mode, the
 * Unix sockets and the per-agent or per-project exceptions; the paths of an
 * exception only show in its dialog.
 */
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  draftsProblem, exceptionsSummary, fetchMissionIsolation, fromDrafts, isolationSummary, isolationTone,
  MissionIsolationError, saveMissionIsolation, toDrafts,
  type ExceptionDraft, type FenceExceptions, type IsolationMode, type IsolationPatch, type IsolationSettingsState, type IsolationTone,
} from '@/lib/mission-isolation';

const MODES: readonly IsolationMode[] = ['auto', 'enforce', 'off'];

const TONE: Record<IsolationTone, string> = {
  active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  inactive: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  off: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  altered: 'bg-destructive/15 text-destructive',
  refusing: 'bg-destructive/15 text-destructive',
};

const field = 'w-full rounded-md border border-border bg-background px-2 text-[12px]';

export function MissionIsolationSettings(): ReactElement {
  const [state, setState] = useState<IsolationSettingsState | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
  const [saving, setSaving] = useState(false);
  const [details, setDetails] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await fetchMissionIsolation());
      setStatus('ready');
    } catch (err) {
      setStatus(err instanceof MissionIsolationError && (err.status === 401 || err.status === 403) ? 'forbidden' : 'error');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (patch: IsolationPatch, done: string): Promise<boolean> => {
    setSaving(true);
    try {
      setState(await saveMissionIsolation(patch));
      toast.success(t(done));
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      void load();
      return false;
    } finally {
      setSaving(false);
    }
  };

  const setMode = async (mode: IsolationMode): Promise<void> => {
    if (mode === 'off' && !(await confirmAction({
      title: t('missionIsolation.confirmOff.title'),
      description: t('missionIsolation.confirmOff.description'),
      confirmLabel: t('missionIsolation.confirmOff.confirm'),
      destructive: true,
    }))) return;
    await save({ filesystem: mode }, 'missionIsolation.saved');
  };

  const setSockets = async (allow: boolean): Promise<void> => {
    if (allow && !(await confirmAction({
      title: t('missionIsolation.confirmSockets.title'),
      description: t('missionIsolation.confirmSockets.description'),
      confirmLabel: t('missionIsolation.confirmSockets.confirm'),
      destructive: true,
    }))) return;
    await save({ unixSockets: allow ? 'allow' : 'deny' }, 'missionIsolation.saved');
  };

  if (status === 'loading') return <section className="max-w-3xl" aria-busy="true" />;
  if (status === 'forbidden') return <Note>{t('missionIsolation.forbidden')}</Note>;
  if (status === 'error' || !state) return <Note>{t('missionIsolation.loadError')}</Note>;

  const { status: verdict, settings } = state;
  const tone = isolationTone(verdict);
  const exposed = !verdict.enforced;
  const socketsAllowed = settings.unixSockets === 'allow';

  return (
    <section className="max-w-3xl space-y-2" data-testid="mission-isolation-settings">
      <h3 className="px-1 text-[12px] font-medium text-muted-foreground">{t('missionIsolation.section')}</h3>
      <div className="rounded-xl bg-muted/40 px-4 py-1">
        <Row
          title={<>
            <span>{t('missionIsolation.status.title')}</span>
            <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px]', TONE[tone])} data-tone={tone}>
              {t(`missionIsolation.tone.${tone}`)}
            </span>
          </>}
          status={<>
            <span className={exposed ? 'text-amber-700 dark:text-amber-400' : undefined}>{isolationSummary(verdict)}</span>
            {exposed && <span className="text-amber-700 dark:text-amber-400"> {t('missionIsolation.exposed')}</span>}
            {!exposed && verdict.gaps.length > 0 && <span> · {t('missionIsolation.gapCount', { count: verdict.gaps.length })}</span>}
          </>}
          action={
            <Button type="button" size="sm" variant="ghost" className="h-8" aria-expanded={details} onClick={() => setDetails((open) => !open)}>
              {t(details ? 'missionIsolation.hideDetails' : 'missionIsolation.showDetails')}
            </Button>
          }
        >
          {details && (
            <div className="space-y-1.5 rounded-md bg-background/60 p-3 text-[12px] leading-snug" lang="en">
              <p className="m-0">{verdict.message}</p>
              {verdict.gaps.length > 0 && (
                <ul className="m-0 list-disc space-y-1 pl-4">
                  {verdict.gaps.map((gap) => <li key={gap}>{gap}</li>)}
                </ul>
              )}
            </div>
          )}
        </Row>

        <Row
          title={<label id="mission-isolation-mode-label">{t('missionIsolation.mode.title')}</label>}
          status={t(`missionIsolation.mode.${settings.filesystem}Hint`)}
          action={
            <Select value={settings.filesystem} disabled={saving} onValueChange={(value) => { void setMode(value as IsolationMode); }}>
              <SelectTrigger aria-labelledby="mission-isolation-mode-label" className="h-8 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((mode) => <SelectItem key={mode} value={mode}>{t(`missionIsolation.mode.${mode}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          }
        />

        <Row
          title={<label htmlFor="mission-isolation-sockets">{t('missionIsolation.sockets.title')}</label>}
          status={<span className={socketsAllowed ? 'text-amber-700 dark:text-amber-400' : undefined}>
            {t(socketsAllowed ? 'missionIsolation.sockets.allowed' : 'missionIsolation.sockets.denied')}
          </span>}
          action={
            <Switch
              id="mission-isolation-sockets"
              checked={socketsAllowed}
              disabled={saving}
              onCheckedChange={(checked) => { void setSockets(checked); }}
            />
          }
        />

        <Row
          title={t('missionIsolation.exceptions.title')}
          status={exceptionsSummary(settings.exceptions)}
          action={
            <Button type="button" size="sm" variant="outline" className="h-8" disabled={saving} onClick={() => setEditing(true)}>
              {t('missionIsolation.exceptions.manage')}
            </Button>
          }
        />
      </div>

      {editing && (
        <ExceptionsDialog
          exceptions={settings.exceptions}
          onCancel={() => setEditing(false)}
          onSave={async (exceptions) => {
            if (await save({ exceptions }, 'missionIsolation.exceptions.saved')) setEditing(false);
          }}
        />
      )}
    </section>
  );
}

/** A row of the card: title and status on the left, one action on the right, its fold below. */
function Row({ title, status, action, children }: {
  title: ReactNode;
  status: ReactNode;
  action: ReactNode;
  children?: ReactNode;
}): ReactElement {
  return (
    <div className="space-y-2 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium leading-snug">{title}</div>
          <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{status}</div>
        </div>
        <div className="shrink-0">{action}</div>
      </div>
      {children}
    </div>
  );
}

/**
 * The exceptions, edited as a whole and saved in one write: a name, whether
 * it may open Unix sockets, and the extra paths it may write, one per line.
 */
function ExceptionsDialog({ exceptions, onCancel, onSave }: {
  exceptions: FenceExceptions;
  onCancel: () => void;
  onSave: (exceptions: FenceExceptions) => Promise<void>;
}): ReactElement {
  const [drafts, setDrafts] = useState<ExceptionDraft[]>(() => toDrafts(exceptions));
  const [busy, setBusy] = useState(false);
  const problem = draftsProblem(drafts);

  const update = (index: number, patch: Partial<ExceptionDraft>): void => {
    setDrafts((current) => current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  };
  const add = (kind: ExceptionDraft['kind']): void => {
    setDrafts((current) => [...current, { kind, name: '', unixSockets: false, writable: '' }]);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="max-h-[min(720px,calc(100dvh-3rem))] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('missionIsolation.dialog.title')}</DialogTitle>
          <DialogDescription>{t('missionIsolation.dialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {drafts.length === 0 && <p className="m-0 text-[12px] text-muted-foreground">{t('missionIsolation.dialog.empty')}</p>}
          {drafts.map((draft, index) => (
            <div key={index} className="space-y-2 rounded-lg bg-muted/50 p-3" data-exception-row={index}>
              <div className="flex items-center gap-2">
                <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                  {t(`missionIsolation.dialog.kind.${draft.kind}`)}
                </span>
                <input
                  className={cn(field, 'h-7')}
                  value={draft.name}
                  maxLength={128}
                  spellCheck={false}
                  aria-label={t(`missionIsolation.dialog.nameLabel.${draft.kind}`)}
                  placeholder={t(`missionIsolation.dialog.namePlaceholder.${draft.kind}`)}
                  onChange={(event) => update(index, { name: event.target.value })}
                />
                <Button
                  type="button" size="sm" variant="ghost" className="h-7 shrink-0 px-2"
                  aria-label={t('missionIsolation.dialog.remove', { name: draft.name || '…' })}
                  onClick={() => setDrafts((current) => current.filter((_, i) => i !== index))}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>
              <label className="flex items-center justify-between gap-3 text-[12px]">
                <span>{t('missionIsolation.dialog.sockets')}</span>
                <Switch checked={draft.unixSockets} onCheckedChange={(checked) => update(index, { unixSockets: checked })} />
              </label>
              <label className="block space-y-1">
                <span className="text-[12px]">{t('missionIsolation.dialog.writable')}</span>
                <textarea
                  // code-font: one filesystem path per line, typed as the OS spells it
                  className={cn(field, 'min-h-14 py-1 font-mono')}
                  rows={2}
                  spellCheck={false}
                  value={draft.writable}
                  // i18n-exempt: sample filesystem path, spelled the same in every language
                  placeholder="~/.npm"
                  onChange={(event) => update(index, { writable: event.target.value })}
                />
              </label>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => add('agent')}>
              <Plus className="mr-1 size-3.5" aria-hidden />{t('missionIsolation.dialog.addAgent')}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => add('project')}>
              <Plus className="mr-1 size-3.5" aria-hidden />{t('missionIsolation.dialog.addProject')}
            </Button>
          </div>
          {problem && drafts.length > 0 && (
            <p role="alert" className="m-0 flex items-start gap-1.5 text-[12px] text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{problem}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{t('missionIsolation.dialog.cancel')}</Button>
          <Button
            type="button" size="sm" disabled={busy || problem !== null}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(fromDrafts(drafts));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('missionIsolation.dialog.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Note({ children }: { children: string }): ReactElement {
  return <p className="max-w-[65ch] text-[13px] leading-snug text-muted-foreground">{children}</p>;
}
