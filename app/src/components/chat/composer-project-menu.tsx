'use client';

/**
 * The conversation's project, at the left of the strip above the composer,
 * and its menu: "Project settings…" opens the project's window (name, folder,
 * integrations), the one the agents grid opens, without leaving the chat.
 *
 * The pill already names the project the conversation runs in: its menu is
 * where a person looks for that project's gestures, the column menu being
 * about the layout and the header about the agent. Nothing is painted for a
 * conversation without a project.
 *
 * Editing a project is `projects:manage`: without it the entry stays, greyed,
 * with the reason under the pointer and for a screen reader.
 */

import { useState, type ReactElement } from 'react';
import { Folder, Settings2 } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ProjectEditDialog } from '@/components/project-edit-dialog';
import { useAccess } from '@/hooks/use-me';
import { useProjectMeta } from '@/hooks/use-project-meta';
import { t } from '@/lib/i18n';

export function ComposerProjectMenu({ project }: { project: string | null }): ReactElement | null {
  const manage = useAccess('projects:manage');
  const [editing, setEditing] = useState(false);
  const name = useProjectMeta().get(project ?? '')?.name || project;
  if (!project || !name) return null;
  const label = t('chatPage.composerProject', { name });
  const reasonId = `composer-project-reason-${project}`;
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-composer-project={project}
            title={label}
            aria-label={label}
            className="-mx-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 outline-none transition-colors hover:bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Folder className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate text-foreground">{name}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          {/* A disabled item takes no pointer events: the wrapper carries the reason's tooltip. */}
          <span title={manage.denied ?? undefined} data-composer-project-reason={manage.denied ? '' : undefined} className="block">
            <DropdownMenuItem
              data-composer-project-settings=""
              disabled={!manage.allowed}
              aria-describedby={manage.denied ? reasonId : undefined}
              onSelect={() => setEditing(true)}
            >
              <Settings2 aria-hidden />
              {t('chatPage.projectSettings')}
            </DropdownMenuItem>
            {manage.denied && <span id={reasonId} className="sr-only">{manage.denied}</span>}
          </span>
        </DropdownMenuContent>
      </DropdownMenu>
      {editing && <ProjectEditDialog slug={project} onSaved={() => undefined} onClose={() => setEditing(false)} />}
    </>
  );
}
