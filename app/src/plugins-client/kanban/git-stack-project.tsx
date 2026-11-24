'use client';

/**
 * The project the "Git" stack's Kanban widgets (Pull requests, Jobs) talk
 * about, chosen once for both.
 *
 * In a chat's rail it is the conversation's project and nothing is asked.
 * Elsewhere a picker asks, and the choice is remembered per browser and per
 * machine: picking it in one widget shows it in the other, mounted or not.
 * The key the pull requests widget used before is still read, so a choice
 * made there is not lost.
 */

import { useCallback, useEffect, useState, useSyncExternalStore, type ChangeEvent } from 'react';
import { useChatRail } from '@/components/chat/chat-rails';
import { WIDGET_SELECT } from '@/components/widget-toolbar';
import { machineScopedStorage } from '@/lib/machines/machine-storage';
import { sharedGet } from '@/lib/shared-read';
import { cn } from '@/lib/utils';

const PROJECT_KEY = 'timon.git-stack.project';
const FORMER_KEY = 'timon.pull-requests.project';

const listeners = new Set<() => void>();

function storage(): Storage | null {
  return typeof window === 'undefined' ? null : machineScopedStorage(window.localStorage);
}

function readPicked(): string | null {
  const s = storage();
  return s ? s.getItem(PROJECT_KEY) || s.getItem(FORMER_KEY) || null : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function pickStackProject(slug: string | null): void {
  const s = storage();
  if (!s) return;
  if (slug) s.setItem(PROJECT_KEY, slug);
  else s.removeItem(PROJECT_KEY);
  // An empty choice is a choice too: the former key must not bring an old
  // project back.
  s.removeItem(FORMER_KEY);
  for (const listener of listeners) listener();
}

type Project = { slug: string; name?: string | null };

export type StackProject = {
  /** The chat's project, when the widget sits in a chat's rail. */
  context: string | null;
  /** The project shown: the chat's, else the one picked; null = none. */
  slug: string | null;
  /** The projects to pick from; empty in a chat, where nothing is asked. */
  projects: Project[];
};

export function useStackProject(): StackProject {
  const chat = useChatRail();
  const context = chat?.slug ?? null;
  const picked = useSyncExternalStore(subscribe, readPicked, () => null);
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    if (context) return;
    let alive = true;
    void (async () => {
      try {
        const r = await sharedGet('/api/ui/projects');
        const j = (await r.json()) as { projects?: Project[] };
        if (alive) setProjects(j.projects ?? []);
      } catch {
        // The picker stays empty: the widget says it waits for a project.
      }
    })();
    return () => { alive = false; };
  }, [context]);
  return { context, slug: context ?? picked, projects: context ? [] : projects };
}

/** The picker, outside a chat only. `none` names the empty choice: "choose a
 *  project" for a widget that needs one, "all projects" for one that does not. */
export function StackProjectPicker({ project, none, label, className }: {
  project: StackProject;
  none: string;
  label: string;
  className?: string;
}) {
  const onChange = useCallback((e: ChangeEvent<HTMLSelectElement>) => pickStackProject(e.target.value || null), []);
  if (project.context) return null;
  return (
    <select
      data-stack-project=""
      value={project.slug ?? ''}
      aria-label={label}
      title={label}
      onChange={onChange}
      className={cn(WIDGET_SELECT, 'max-w-[9rem]', className)}
    >
      <option value="">{none}</option>
      {project.projects.map((p) => <option key={p.slug} value={p.slug}>{p.name || p.slug}</option>)}
    </select>
  );
}

/** What `useGitStackProject()` gives a plugin's widget of the "Git" stack (client API 19). */
export type GitStackProject = {
  /** The project shown: the chat's, else the one picked; null = none. */
  project: string | null;
  /** True in a chat's rail, where the project is the conversation's and nothing is asked. */
  inChat: boolean;
};

/** The project the "Git" stack talks about, for a widget that is not the product's own. */
export function useGitStackProject(): GitStackProject {
  const { context, slug } = useStackProject();
  return { project: slug, inChat: context !== null };
}

/** The stack's project picker, for a plugin's widget header: nothing in a chat. */
export function GitStackProjectPicker({ none, label, className }: { none: string; label: string; className?: string }) {
  const project = useStackProject();
  return <StackProjectPicker project={project} none={none} label={label} className={className} />;
}
