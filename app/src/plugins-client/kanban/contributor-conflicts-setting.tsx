'use client';

/**
 * The project's row "Contributors' conflicts", under "Integrations" in the
 * project's window (`project.settings`): whether Timon asks the contributor
 * to resolve a conflict (the default) or may resolve it itself, without a
 * working tree (`forge-conflicts.ts`). One action, "Configure", opens the
 * choice in a dialog. Only a project that opens pull requests on GitHub gets
 * the row; the daemon lets only a signed-in person turn resolving on.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useProjectSettings } from '@/components/project-settings-slot';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { readContributorConflicts, writeContributorConflicts, type ContributorConflicts } from './forge-branch-api';
import { onIntegrationChanged } from './project-integration-api';

const MODES: readonly ContributorConflicts[] = ['ask', 'resolve'];

function ModeDialog({ project, current, onClose, onSaved }: {
  project: string;
  current: ContributorConflicts;
  onClose: () => void;
  onSaved: (mode: ContributorConflicts) => void;
}) {
  const [mode, setMode] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (mode === current) { onClose(); return; }
    setSaving(true);
    setError(null);
    const out = await writeContributorConflicts(project, mode);
    setSaving(false);
    if (out.ok) onSaved(out.value);
    else setError(out.message);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-contributor-conflicts-dialog="" className="max-w-[460px]">
        <DialogTitle className="text-sm">{t('contributorConflicts.dialogTitle', { project })}</DialogTitle>
        <DialogDescription className="sr-only">{t('contributorConflicts.title')}</DialogDescription>
        <div role="radiogroup" aria-label={t('contributorConflicts.title')} className="flex flex-col gap-1.5">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              data-contributor-conflicts-mode={m}
              onClick={() => setMode(m)}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                mode === m ? 'bg-primary/10 text-foreground' : 'bg-muted/40 text-foreground hover:bg-muted/70',
              )}
            >
              <span className="text-[12.5px] font-medium">{t(`contributorConflicts.mode.${m}`)}</span>
              <span className="text-[11.5px] text-muted-foreground">{t(`contributorConflicts.hint.${m}`)}</span>
            </button>
          ))}
        </div>
        {error && <p data-contributor-conflicts-error="" className="text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('contributorConflicts.cancel')}</Button>
          <Button type="button" size="sm" onClick={() => { void save(); }} disabled={saving}>
            <span data-contributor-conflicts-save="">{saving ? t('contributorConflicts.saving') : t('contributorConflicts.save')}</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ContributorConflictsSetting(): ReactElement | null {
  const settings = useProjectSettings();
  const project = settings?.project ?? null;
  const [mode, setMode] = useState<ContributorConflicts | null>(null);
  const [editing, setEditing] = useState(false);

  const reload = useCallback(async () => {
    if (!project) { setMode(null); return; }
    const out = await readContributorConflicts(project);
    setMode(out.ok ? out.value : null);
  }, [project]);

  useEffect(() => { void reload(); }, [reload]);
  // The row comes and goes with the pull request mode, set in the row above.
  useEffect(() => (project ? onIntegrationChanged(project, () => { void reload(); }) : undefined), [project, reload]);

  if (!project || mode === null) return null;
  return (
    <div data-contributor-conflicts={project} className="flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-foreground">{t('contributorConflicts.title')}</div>
        <div data-contributor-conflicts-status={mode} className="truncate text-[11px] text-muted-foreground">{t(`contributorConflicts.mode.${mode}`)}</div>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)} className="shrink-0">
        <span data-contributor-conflicts-configure="">{t('contributorConflicts.configure')}</span>
      </Button>
      {editing && (
        <ModeDialog
          project={project}
          current={mode}
          onClose={() => setEditing(false)}
          onSaved={(next) => { setMode(next); setEditing(false); }}
        />
      )}
    </div>
  );
}
