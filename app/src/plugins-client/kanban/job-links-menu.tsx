'use client';

/**
 * The way back from a job or a pull request to its ideas and its pilot
 * mission, as entries of a row's "…" menu (`docs/FORGE-FLOW-PLAN.md` §2 (d)):
 * "Show the TO DO (#n)" for each idea it carries, "Open the job" for the
 * mission that pilots its series. Nothing when the daemon sent no links.
 */

import type { ReactElement } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { ListTodo, MessageSquare } from 'lucide-react';
import { chatMissionHref } from '@/lib/chat-island-params';
import { t } from '@/lib/i18n';
import { requestNavigation } from '@/lib/navigate-proposals';
import type { JobLinks } from './landing-api';

/** Ideas named in a menu: past that, the job's dialog lists them all. */
const MENU_TODOS = 3;

export function JobLinksMenuItems({ links, onOpenTodo, itemClassName }: {
  links: JobLinks | undefined;
  onOpenTodo: (id: number) => void;
  itemClassName: string;
}): ReactElement | null {
  if (!links || (links.todos.length === 0 && !links.pilot_mission_id)) return null;
  const pilot = links.pilot_mission_id;
  return (
    <>
      {links.todos.slice(0, MENU_TODOS).map((todo) => (
        <Dropdown.Item key={todo.id} data-menu-todo={todo.id} onSelect={() => onOpenTodo(todo.id)} className={itemClassName} title={todo.text}>
          <ListTodo className="size-3.5" />{t('landings.links.showTodo', { id: todo.id })}
        </Dropdown.Item>
      ))}
      {pilot && (
        <Dropdown.Item data-menu-pilot={pilot} onSelect={() => requestNavigation(chatMissionHref(pilot))} className={itemClassName}>
          <MessageSquare className="size-3.5" />{t('landings.links.openJob')}
        </Dropdown.Item>
      )}
    </>
  );
}
