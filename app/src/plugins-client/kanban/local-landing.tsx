'use client';

/**
 * What the "Git" stack's pull request widgets (Pull requests, Jobs) show while
 * their project merges its jobs locally: one short line, and an icon that
 * opens the "Pull requests" setting where it lives in the project's window
 * (`pull-request-setting.tsx`). The same dialog, not a copy: a field added
 * there reaches both.
 *
 * The setting is read only with `projects:manage`, the right that can change
 * it: without it the mode stays unknown, so the widgets keep the refusal or
 * the list the daemon answers, and no shortcut is offered.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Settings2 } from 'lucide-react';
import { WidgetButton } from '@/components/widget-toolbar';
import { useAccess } from '@/hooks/use-me';
import { t } from '@/lib/i18n';
import { PullRequestSetupDialog } from './pull-request-setting';
import {
  announceIntegrationChanged, onIntegrationChanged, readIntegration, type IntegrationRead,
} from './project-integration-api';

/** The landing setting of `project`, read again when its row changes it; `null` while unknown. */
export function useProjectIntegration(project: string | null): IntegrationRead | null {
  const manage = useAccess('projects:manage');
  const [read, setRead] = useState<{ project: string; value: IntegrationRead } | null>(null);

  const reload = useCallback(async (alive: () => boolean = () => true) => {
    if (!project || !manage.allowed) { setRead(null); return; }
    const out = await readIntegration(project);
    if (alive()) setRead(out.ok ? { project, value: out.value } : null);
  }, [project, manage.allowed]);

  useEffect(() => {
    let alive = true;
    void reload(() => alive);
    return () => { alive = false; };
  }, [reload]);
  useEffect(() => (project ? onIntegrationChanged(project, () => { void reload(); }) : undefined), [project, reload]);

  // An answer for the project picked before is not this one's.
  return read && read.project === project ? read.value : null;
}

/** True when the project's jobs merge locally: an invalid setting says so on its own. */
export function landsLocally(read: IntegrationRead | null): read is IntegrationRead {
  return !!read && !read.invalid && read.integration.mode === 'local';
}

export function LocalLandingEmpty({ project, read }: { project: string; read: IntegrationRead }): ReactElement {
  const [open, setOpen] = useState(false);
  const label = t('landings.local.setUp');
  return (
    <div data-local-landing={project} className="flex items-center gap-2 px-1 py-2">
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">{t('landings.local.text')}</span>
      <WidgetButton
        data-local-landing-setup=""
        title={label}
        aria-label={label}
        icon={<Settings2 className="size-3.5" aria-hidden />}
        onClick={() => setOpen(true)}
      />
      {open && (
        <PullRequestSetupDialog
          project={project}
          current={read}
          onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); announceIntegrationChanged(project); }}
        />
      )}
    </div>
  );
}
