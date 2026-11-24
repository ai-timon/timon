'use client';

import { KanbanSquare } from 'lucide-react';
import dynamic from 'next/dynamic';
import { registerNavItem } from './nav';
import { registerPage } from './page';
import { registerWidget } from './widget';
import { t } from '@/lib/i18n';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import type { BundledClientPlugin } from './types';
import { widgetPicto } from './widget-pictos';
import {
  JOB_DIALOG_SLOT, KANBAN_CARD_SLOT, PROJECT_SETTINGS_SLOT, PUBLISH_DIALOG_SLOT, TASK_FORM_SLOT, TODO_FORM_SLOT, TODO_LANDING_SLOT,
} from '@/lib/plugin-host/slots';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const KanbanTodoColumn = dynamic(() => import('./kanban/kanban-todo-column').then((m) => m.KanbanTodoColumn), { ssr: false });
const ProjectTodoTile = dynamic(() => import('./kanban/project-todo-tile').then((m) => m.ProjectTodoTile), { ssr: false });
const ProjectTodoWidget = dynamic(() => import('./kanban/project-todo-project-widget').then((m) => m.ProjectTodoWidget), { ssr: false });
const PullRequestsWidget = dynamic(() => import('./kanban/pull-requests-widget').then((m) => m.PullRequestsWidget), { ssr: false });
const LandingWidget = dynamic(() => import('./kanban/landing-widget').then((m) => m.LandingWidget), { ssr: false });

// Loaded on demand: statically imported, it weighed on every page of the app.
const KanbanPage = dynamic(() => import('./kanban/page').then((m) => m.KanbanPage), { ssr: false });
const ProductTaskForm = dynamic(() => import('@/components/task-form/task-form').then((m) => m.ProductTaskForm), { ssr: false });
const ProductTodoForm = dynamic(() => import('./kanban/product-todo-form').then((m) => m.ProductTodoForm), { ssr: false });
const ProductKanbanCard = dynamic(() => import('./kanban/product-kanban-card').then((m) => m.ProductKanbanCard), { ssr: false });
const ProductTodoLanding = dynamic(() => import('./kanban/product-todo-landing').then((m) => m.ProductTodoLanding), { ssr: false });
const ProductJobDialog = dynamic(() => import('./kanban/landing-preview-dialog').then((m) => m.ProductJobDialog), { ssr: false });
const ProductPublishDialog = dynamic(() => import('./kanban/product-publish-dialog').then((m) => m.ProductPublishDialog), { ssr: false });
const PullRequestSetting = dynamic(() => import('./kanban/pull-request-setting').then((m) => m.PullRequestSetting), { ssr: false });
const ContributorConflictsSetting = dynamic(() => import('./kanban/contributor-conflicts-setting').then((m) => m.ContributorConflictsSetting), { ssr: false });

/**
 * Client half of `@timon/kanban`: the board page, and its "TO DO" column.
 *
 * The ideas notebook was `@timon/backlog`, a separate module whose option
 * (`surfaces`) chose between the column and a cockpit tile. Since part 2/4
 * it belongs to the Kanban: the column is no longer a surface to turn on, it
 * is the board's first. What it keeps: the orchestrator NEVER takes work from
 * it — that is what sets it apart from PENDING.
 *
 * The notebook tile came back in part 4/4, no longer as an ALTERNATIVE to the
 * column but as a widget in its own right: a registration in
 * `cockpit.widget`, movable to any widget zone, which takes nothing away from
 * the board.
 */
export const kanbanClient: BundledClientPlugin = {
  module: '@timon/kanban',
  apply(ctx) {
    const TodoColumn = () => <KanbanTodoColumn realtime={ctx.realtime} />;
    const TodoWidget = (props: WidgetProps) => (
      <ProjectTodoTile {...props} realtime={ctx.realtime} scope={{ kind: 'all' }} titre={t('projectTodo.titleAll')} />
    );
    const ProjectWidget = (props: WidgetProps) => <ProjectTodoWidget {...props} realtime={ctx.realtime} />;

    registerNavItem(ctx, { href: '/kanban', labelKey: 'nav.kanban', icon: KanbanSquare, order: 60, zone: 'nav.kanban' });
    // Default occupant of `task.form` (a boot slot): the task form of the board,
    // the Agents page and the agents grid. A plugin that takes the slot replaces
    // it on the three screens at once; with this module off, each host still
    // paints the product's form.
    ctx.register({ slot: TASK_FORM_SLOT, fallback: true }, ProductTaskForm);
    // Default occupant of `kanban.card` (a boot slot): the tiles of the board and
    // of the TO DO widgets, ideas and tasks alike. A plugin that takes the slot
    // replaces every tile at once.
    ctx.register({ slot: KANBAN_CARD_SLOT, fallback: true }, ProductKanbanCard);
    // Default occupant of `todo.form` (a boot slot), the twin of `task.form`:
    // the creation and edition of a TO DO idea.
    ctx.register({ slot: TODO_FORM_SLOT, fallback: true }, ProductTodoForm);
    // Default occupant of `kanban.todo.landing` (a boot slot): where the branch
    // of an idea's jobs stands, beside its tags. A plugin that takes the slot
    // repaints it on every line and in the detail.
    ctx.register({ slot: TODO_LANDING_SLOT, fallback: true }, ProductTodoLanding);
    // Default occupant of `kanban.job.dialog` (a boot slot): a job's diff,
    // commits, pre-checks and links, opened from the Jobs and Pull requests
    // widgets and from an idea's landing badge.
    ctx.register({ slot: JOB_DIALOG_SLOT, fallback: true }, ProductJobDialog);
    // Default occupant of `forge.publish.dialog` (a boot slot): the one dialog
    // through which a text of Timon's reaches GitHub, read and approved first.
    ctx.register({ slot: PUBLISH_DIALOG_SLOT, fallback: true }, ProductPublishDialog);
    // A row of a project's window: whether the project's jobs merge locally
    // or land through a pull request, and where it goes.
    ctx.register({ slot: PROJECT_SETTINGS_SLOT, key: 'pull-requests', order: 10 }, PullRequestSetting);
    // A row of a project's window: whether Timon asks a contributor to
    // resolve a conflict of their pull request, or may resolve it itself.
    // It paints nothing for a project that does not open pull requests on GitHub.
    ctx.register({ slot: PROJECT_SETTINGS_SLOT, key: 'contributor-conflicts', order: 20 }, ContributorConflictsSetting);
    registerPage(ctx, { route: '/kanban', Component: KanbanPage });

    // First in the list: the ideas column comes before the statuses. A
    // negative `order` keeps it in front even if a third-party plugin
    // registers without declaring one (those sort last).
    if (ctx.zoneVisible('kanban.todo')) {
      ctx.register({ slot: 'kanban.column', key: 'todo', order: -10 }, TodoColumn);
    }

    // `frame: 'none'`: the tile paints its own chassis, whose bar under the
    // title counts the ideas — framing it as well would give two headers.
    registerWidget(ctx, {
      key: 'todo',
      widget: {
        title: t('widgetCatalog.allTodo.title'), icon: widgetPicto('allTodo'), description: t('widgetCatalog.allTodo.description'),
        zone: 'droite',
        height: 320,
        minHeight: 160,
        frame: 'none',
      },
      Component: TodoWidget,
    });

    // A second registration of the SAME identity, not a second plugin: the
    // notebook of a single project, which fits just as well in a chat's rail
    // (the project comes from the agent) as elsewhere (it asks which one).
    registerWidget(ctx, {
      key: 'project-todo',
      widget: {
        title: t('widgetCatalog.projectTodo.title'), icon: widgetPicto('projectTodo'), description: t('widgetCatalog.projectTodo.description'),
        zone: 'droite',
        height: 300,
        minHeight: 160,
        frame: 'none',
      },
      Component: ProjectWidget,
    });

    // The pull requests open on the repository of one project in `pr` mode,
    // and their read-only relecture: "Review" prepares a brief the person
    // reads and sends; the verdict comes back on the row. With the jobs
    // widget below, part of the chat's "Git" stack (`widget-defaults.ts`).
    registerWidget(ctx, {
      key: 'pull-requests',
      widget: {
        title: t('widgetCatalog.pullRequests.title'), icon: widgetPicto('pullRequests'), description: t('widgetCatalog.pullRequests.description'),
        tabTitle: t('widgetCatalog.pullRequests.tab'),
        liveCount: true,
        zone: 'droite',
        height: 320,
        minHeight: 160,
        frame: 'none',
      },
      Component: PullRequestsWidget,
    });

    // The jobs that land through a pull request, grouped by what they wait
    // for: their state, the forge's checks and a preview of the diff before
    // the push. In a chat's rail it narrows to the conversation's project.
    // The key stays `landings`: it is the widget's placement id.
    registerWidget(ctx, {
      key: 'landings',
      widget: {
        title: t('widgetCatalog.jobs.title'), icon: widgetPicto('jobs'), description: t('widgetCatalog.jobs.description'),
        liveCount: true,
        zone: 'droite',
        height: 320,
        minHeight: 160,
        frame: 'none',
      },
      Component: LandingWidget,
    });
  },
};
