'use client';

/**
 * `project.settings` (client API 19): the rows plugins add to a project's
 * settings, in the project's window, under one short label ("Integrations").
 *
 * Each occupant paints ONE row of the settings grammar: a title and a status
 * line on the left, one action on the right, the rest in a "…" menu; a form
 * opens in a dialog, never in the row. The occupant reads the project from
 * `useProjectSettings()`, never from props: one entry, every project.
 * Nothing at all is painted while no plugin holds a row, and the section
 * hides itself while every row it holds paints nothing (a project without a
 * GitHub repository gets none).
 */

import React, { createContext, useContext, useMemo } from 'react';
import { renderSlotEntries, useSlotEntries } from '@/lib/plugin-host/render';
import { PROJECT_SETTINGS_SLOT } from '@/lib/plugin-host/slots';
import { t } from '@/lib/i18n';

export type ProjectSettingsValue = {
  /** Slug of the project whose settings are open. */
  project: string;
};

const ProjectSettingsContext = createContext<ProjectSettingsValue | null>(null);

/** The project a `project.settings` occupant is painted for; `null` outside one. */
export function useProjectSettings(): ProjectSettingsValue | null {
  return useContext(ProjectSettingsContext);
}

export function ProjectSettingsSlot({ project }: { project: string }): React.ReactElement | null {
  const entries = useSlotEntries(PROJECT_SETTINGS_SLOT);
  const value = useMemo(() => ({ project }), [project]);
  if (entries.length === 0) return null;
  return (
    <section data-project-settings="" className="flex flex-col gap-1.5 has-[>div:empty]:hidden">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('projectsPage.integrations')}</div>
      <div className="flex flex-col gap-1 rounded-lg bg-muted/40 p-1">
        <ProjectSettingsContext.Provider value={value}>{renderSlotEntries(entries)}</ProjectSettingsContext.Provider>
      </div>
    </section>
  );
}
