'use client';

/**
 * The product's task form: the default occupant of the `task.form` slot,
 * painted inside the frame `TaskFormModal` holds (`task-form-modal.tsx`).
 *
 * Layout of the reference mock-up (header, large title, tabs with counters,
 * a summary on the right, footer), laid on `DetailShell` like the popup of a
 * TO DO idea (TODO #837): the body, the files and the rail are islands on the
 * chrome fill, nothing separated by a line (rule 16). The files have their own
 * zone, in view whatever the tab; the General tab still counts them.
 * Every field the former form edited is here, plus what the API took that it
 * did not show (fallback, pipeline, TO DO idea, attachments).
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { toast } from 'sonner';
import { ShieldAlert, ShieldCheck, Shuffle, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MergeRequestChip } from '@/plugins-client/kanban/merge-request-chip';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { resolveRole } from '@/lib/roles';
import { asBackend, capabilitiesFor, defaultModelFor, useBackendCatalog, type BackendCatalog } from '@/lib/backends';
import { BackendLimitsBadge } from '@/components/backend-limits-badge';
import { BrandMark } from '@/components/brand-mark';
import { ModelPickerPopover, pickLabel, type ModelPick, type ModelPickerTriggerProps } from '@/components/model-picker';
import { taskModelPick, taskOverrides } from '@/lib/task-model-pick';
import { runByTitle } from '@/lib/task-runner';
import { pendingPermissionLine } from '@/lib/kanban-card';
import { useTaskPendingPermission } from '@/lib/pending-permission-events';
import { MarkMergedSection } from '@/components/mark-merged-section';
import { canMarkMerged } from '@/lib/mark-merged';
import { DateTimePicker } from '@/components/date-time-picker';
import { WorktreeDetachSection } from '@/components/worktree-detach-section';
import { canDetachWorktree } from '@/lib/worktree-detach';
import type { TaskAttachment } from '@/lib/task-attachments';
import { useAttachmentItems } from '@/components/use-attachment-items';
import { DetailShell } from '@/components/detail-shell';
import { useTaskForm, type TaskFormAgent, type TaskFormValue } from './task-form-context';
import {
  buildBody, buildInitial, formProblems, NO_FALLBACK, PERMISSION_MODES, PIPELINES, PRIORITIES, tabCounts, tabOfProblem,
  TASK_FORM_TABS, TASK_TYPES, type FormProblem, type FormState, type TaskFormTab, type TaskStatus,
} from './task-form-model';
import {
  AgentPicker, AttachmentsField, ChoiceSelect, type ChoiceOption, ChipToggles, DepsList, DescriptionField, Field,
  FIELD_PAPER_CLASS, INPUT_CLASS, PAPER_CLASS, StatusLabel, type DepCandidate,
} from './task-form-parts';

type SkillSummary = { id: string };
type McpSummary = { id: string; name?: string };

/** What the screen passed, completed by the daemon's list (role, avatar, the agent's own model). */
function mergeAgents(given: readonly TaskFormAgent[], read: readonly TaskFormAgent[]): TaskFormAgent[] {
  if (read.length === 0) return [...given];
  const byName = new Map(read.map((a) => [a.name, a]));
  const named = given.length > 0 ? given.map((a) => ({ ...a, ...byName.get(a.name) })) : [...read];
  return named;
}

/** A file listed under an iteration's task but owned by the chain's root: shown, not removable. */
function inheritedFromRoot(attachment: TaskAttachment, taskId: string): boolean {
  return attachment.task_id !== taskId;
}

export function ProductTaskForm(): ReactElement | null {
  const host = useTaskForm();
  if (!host) return null;
  return <TaskForm host={host} />;
}

function TaskForm({ host }: { host: TaskFormValue }): ReactElement {
  const { task, mode } = host;
  const isEdit = mode === 'edit' && !!task;
  const ids = { title: useId(), description: useId(), todo: useId(), perm: useId(), pipeline: useId(),
    tools: useId(), schedule: useId(), type: useId(), priority: useId(), depsFilter: useId(), skillsFilter: useId(), tabs: useId() };

  const [readAgents, setReadAgents] = useState<TaskFormAgent[]>([]);
  const agents = useMemo(() => mergeAgents(host.agents, readAgents), [host.agents, readAgents]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [mcps, setMcps] = useState<McpSummary[]>([]);
  const [existingTasks, setExistingTasks] = useState<DepCandidate[]>([]);
  const catalog = useBackendCatalog();
  const live = useTaskPendingPermission(isEdit ? task : null);
  const waiting = live.pending ? pendingPermissionLine(live.pending, live.now) : null;
  const [form, setForm] = useState<FormState>(() => buildInitial(task, host.defaultAgent, host.agents));
  const [tab, setTab] = useState<TaskFormTab>('general');
  const [problems, setProblems] = useState<FormProblem[]>([]);
  const [saving, setSaving] = useState(false);
  const [filters, setFilters] = useState({ deps: '', skills: '' });
  const titleInput = useRef<HTMLInputElement>(null);
  const tabButtons = useRef<Partial<Record<TaskFormTab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    let cancelled = false;
    const read = <T,>(url: string, fallback: T) => fetch(url, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() as Promise<T> : fallback)).catch(() => fallback);
    void Promise.all([
      read<{ agents?: TaskFormAgent[] }>('/api/ui/agents', { agents: [] }),
      read<{ skills?: SkillSummary[] }>('/api/ui/skills', { skills: [] }),
      read<{ servers?: McpSummary[] }>('/api/ui/mcp', { servers: [] }),
      read<{ tasks?: DepCandidate[] }>('/api/ui/tasks', { tasks: [] }),
    ]).then(([ar, sr, mr, tr]) => {
      if (cancelled) return;
      const list = ar.agents ?? [];
      setReadAgents(list);
      setSkills(sr.skills ?? []);
      setMcps(mr.servers ?? []);
      setExistingTasks((tr.tasks ?? []).map((x) => ({ id: x.id, title: x.title, status: x.status })));
      // The agent list may land after the first paint, with no agent chosen yet.
      setForm((f) => (f.agent_name ? f : { ...f, agent_name: host.defaultAgent ?? host.agents[0]?.name ?? list[0]?.name ?? '' }));
    });
    return () => { cancelled = true; };
  }, [host.agents, host.defaultAgent]);

  // An edited task's files, its own and those inherited from the chain's root.
  const taskId = isEdit ? task.id : null;
  const files = useAttachmentItems(taskId, host.attachments, 'task', { inheritedOf: inheritedFromRoot });

  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setProblems([]);
  }, []);

  const toggleInList = useCallback((key: 'deps' | 'extra_skills' | 'extra_mcp_servers', value: string) => {
    setForm((f) => ({ ...f, [key]: f[key].includes(value) ? f[key].filter((x) => x !== value) : [...f[key], value] }));
  }, []);

  const agent = agents.find((a) => a.name === form.agent_name) ?? null;
  const depsCandidates = useMemo(
    // A finished task is a pointless dependency, unless it already is one.
    () => existingTasks.filter((x) => x.id !== task?.id && (x.status !== 'DONE' || form.deps.includes(x.id))),
    [existingTasks, task?.id, form.deps],
  );
  const counts = tabCounts(form, files.items.length);

  // The TO DO idea the task carries out, read for its text.
  const todoId = /^[1-9]\d*$/.test(form.todo_id.trim()) ? Number(form.todo_id.trim()) : null;
  const [todoText, setTodoText] = useState<string | null>(null);
  useEffect(() => {
    setTodoText(null);
    if (todoId === null) return;
    let cancelled = false;
    // By id: in a capped page of the whole notebook, an older idea is missing.
    fetch(`/api/ui/project-todo?status=all&ids=${todoId}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() as Promise<{ items?: { id: number; text: string }[] }> : { items: [] }))
      .then((j) => { if (!cancelled) setTodoText(j.items?.find((x) => x.id === todoId)?.text ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [todoId]);

  // ── Model ────────────────────────────────────────────────────────────────
  const pick = taskModelPick(catalog, form.backend_override, form.model_override);
  const inherited = inheritedPick(catalog, task, form.agent_name, agent);
  const fallbackNever = form.fallback_backend_override === NO_FALLBACK;
  const fallbackPick = fallbackNever ? null : taskModelPick(catalog, form.fallback_backend_override, form.fallback_model_override);
  const target = { agent: form.agent_name, project: agent?.project };

  // ── Submit ───────────────────────────────────────────────────────────────
  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    const found = formProblems(form);
    if (found.length > 0) {
      setProblems(found);
      const first = found[0]!;
      const where = tabOfProblem(first);
      if (where) setTab(where);
      if (first === 'title') titleInput.current?.focus();
      return;
    }
    setSaving(true);
    const result = await host.submit(buildBody(form, mode));
    if (!result.ok) {
      setSaving(false);
      toast.error(t('taskForm.toast.saveFailed', { error: result.error }));
      return;
    }
    // Files dropped before the task existed go now that it has an id.
    const failed = await files.sendQueued(result.id);
    toast.success(isEdit ? t('taskForm.toast.updated') : t('taskForm.toast.created'));
    if (failed.length > 0) toast.error(t('taskForm.attachments.partial', { names: failed.join(', ') }));
    host.finish();
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TASK_FORM_TABS.indexOf(tab);
    const next = e.key === 'ArrowRight' ? TASK_FORM_TABS[(i + 1) % TASK_FORM_TABS.length]
      : e.key === 'ArrowLeft' ? TASK_FORM_TABS[(i - 1 + TASK_FORM_TABS.length) % TASK_FORM_TABS.length]
      : e.key === 'Home' ? TASK_FORM_TABS[0]
      : e.key === 'End' ? TASK_FORM_TABS[TASK_FORM_TABS.length - 1]
      : undefined;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabButtons.current[next]?.focus();
  };
  const tabId = (key: TaskFormTab) => `${ids.tabs}-tab-${key}`;
  const panelId = (key: TaskFormTab) => `${ids.tabs}-panel-${key}`;
  const panel = (key: TaskFormTab) => ({
    role: 'tabpanel' as const,
    id: panelId(key),
    'aria-labelledby': tabId(key),
    hidden: tab !== key,
    // `flex` would override the `hidden` attribute (same specificity, later rule).
    className: tab === key ? 'flex flex-col gap-5' : 'hidden',
  });

  const permOptions = PERMISSION_MODES.includes(form.permission_mode_override)
    ? PERMISSION_MODES : [...PERMISSION_MODES, form.permission_mode_override];
  const typeOptions: ChoiceOption<FormState['type']>[] = TASK_TYPES.map((type) => {
    const rv = resolveRole(type);
    return { value: type, label: type, icon: rv?.icon, color: rv?.color };
  });
  const priorityOptions: ChoiceOption<number>[] = PRIORITIES.map((p) => ({
    value: p.value,
    label: `P${p.value} · ${t(`taskForm.priority.${p.key}`)}`,
    textClass: p.value >= 4 ? 'text-[hsl(var(--warning))]' : undefined,
  }));

  // One island for the right column: its blocks stand apart by the rail's gap.
  const rail = (
    <>
      <section className={ASIDE_BLOCK}>
        <div className="flex flex-col gap-1">
          <AgentPicker agents={agents} value={form.agent_name} onChange={(name) => update('agent_name', name)} invalid={problems.includes('agent')} />
          {problems.includes('agent') && <p className="text-xs text-destructive">{t('taskForm.agentRequired')}</p>}
          {/* The model below is this agent's: say who it is when the roles chose another one (#1109). */}
          {task?.run_by && task.agent_name === form.agent_name && (
            <p title={runByTitle(task.agent_name, task.run_by)} data-task-runner={task.run_by.agent} className="flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground">
              <Shuffle className="size-3 flex-none" aria-hidden />
              <span className="truncate">
                {task.run_by.planned
                  ? t('kanbanPage.runBy.detailPlanned', { agent: task.run_by.agent })
                  : t('kanbanPage.runBy.detail', { agent: task.run_by.agent })}
              </span>
            </p>
          )}
        </div>
        <dl className="flex flex-col gap-2.5 text-[13px]">
          <SummaryRow label={t('taskForm.summary.type')} htmlFor={ids.type}>
            <ChoiceSelect className={FIELD_PAPER_CLASS} id={ids.type} label={t('taskForm.summary.type')} value={form.type} options={typeOptions} onChange={(v) => update('type', v)} />
          </SummaryRow>
          <SummaryRow label={t('taskForm.summary.priority')} htmlFor={ids.priority}>
            <ChoiceSelect className={FIELD_PAPER_CLASS} id={ids.priority} label={t('taskForm.summary.priority')} value={form.priority} options={priorityOptions} onChange={(v) => update('priority', v)} />
          </SummaryRow>
          {form.type === 'code' && (
            <SummaryRow label={t('taskForm.pipeline.label')} htmlFor={isEdit ? undefined : ids.pipeline}>
              {isEdit ? (
                <span title={t('taskForm.pipeline.fixed')} className="truncate">{t(`taskForm.pipeline.${form.pipeline}`)}</span>
              ) : (
                <ChoiceSelect
                  className={FIELD_PAPER_CLASS}
                  id={ids.pipeline}
                  label={t('taskForm.pipeline.label')}
                  value={form.pipeline}
                  options={PIPELINES.map((p) => ({ value: p, label: t(`taskForm.pipeline.${p}`) }))}
                  onChange={(v) => update('pipeline', v)}
                />
              )}
            </SummaryRow>
          )}
          <SummaryRow label={t('taskForm.summary.deps')}>
            <button
              type="button"
              onClick={() => setTab('dependencies')}
              className="rounded text-right tabular-nums transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {form.deps.length > 0 ? t('taskForm.summary.depsCount', { count: form.deps.length }) : t('taskForm.summary.depsNone')}
            </button>
          </SummaryRow>
          <SummaryRow label={t('taskForm.todo.label')} htmlFor={ids.todo}>
            <input
              id={ids.todo}
              inputMode="numeric"
              value={form.todo_id}
              onChange={(e) => update('todo_id', e.target.value)}
              placeholder={t('taskForm.todo.placeholder')}
              title={t('taskForm.todo.hint')}
              aria-invalid={problems.includes('todo') || undefined}
              className={cn(SMALL_FIELD_CLASS, 'w-36 text-right tabular-nums', problems.includes('todo') && 'ring-2 ring-destructive/70')}
            />
          </SummaryRow>
          {problems.includes('todo') && <p className="text-xs text-destructive">{t('taskForm.todo.invalid')}</p>}
          {todoText && (
            <p data-task-todo="" className="line-clamp-3 rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">{todoText}</p>
          )}
          <SummaryRow label={t('taskForm.summary.status')}><StatusLabel status={isEdit ? task.status ?? null : null} /></SummaryRow>
          {/* What the running mission waits on, live: the board's line, the same words. */}
          {waiting && (
            <p
              data-pending-permission={live.pending?.tool_name}
              title={waiting.title}
              className="flex min-w-0 items-start gap-1.5 rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs text-warning"
            >
              <ShieldAlert className="mt-px size-3.5 flex-none animate-pulse" aria-hidden />
              <span className="min-w-0 tabular-nums">
                <span className="font-semibold">{waiting.label}</span>
                {waiting.deadline && <span className="whitespace-nowrap text-muted-foreground"> · {waiting.deadline}</span>}
              </span>
            </p>
          )}
          {files.items.length > 0 && (
            <SummaryRow label={t('taskForm.summary.attachments')}><span className="tabular-nums">{files.items.length}</span></SummaryRow>
          )}
        </dl>
      </section>

      <section className={ASIDE_BLOCK}>
        <Field label={t('taskForm.schedule.label')} htmlFor={ids.schedule}>
          <DateTimePicker
            id={ids.schedule}
            value={form.scheduled_at}
            onChange={(v) => update('scheduled_at', v)}
            placeholder={t('taskForm.summary.startAsap')}
            triggerClassName={FIELD_PAPER_CLASS}
          />
        </Field>
      </section>

      <section className={ASIDE_BLOCK}>
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-[13px]">
          <span className="text-muted-foreground">{t('taskForm.model')}</span>
          <ModelPickerPopover
            value={pick}
            onChange={(next) => {
              const o = taskOverrides(next);
              setForm((f) => ({ ...f, backend_override: o.backend_override ?? '', model_override: o.model_override ?? '' }));
            }}
            inherit={{ label: t('taskForm.modelInherit'), hint: t('taskForm.modelInheritHint') }}
            // What the vault sees at spawn: the agent's project, not `task.project`.
            target={target}
            align="start"
            label={t('taskForm.model')}
            renderTrigger={(props) => (
              <ModelChip
                trigger={props}
                catalog={catalog}
                value={pick}
                inherited={inherited}
                inheritLabel={t('taskForm.modelInherit')}
                hint={t('taskForm.modelInheritHint')}
              />
            )}
          />
          <span className="text-muted-foreground">{t('taskForm.fallback.short')}</span>
          <ModelPickerPopover
            value={fallbackPick}
            disabled={fallbackNever}
            onChange={(next) => {
              const o = taskOverrides(next);
              setForm((f) => ({ ...f, fallback_backend_override: o.backend_override ?? '', fallback_model_override: o.model_override ?? '' }));
            }}
            inherit={{ label: t('taskForm.fallback.inherit'), hint: t('taskForm.fallback.inheritHint') }}
            target={target}
            align="start"
            label={t('taskForm.fallback.label')}
            renderTrigger={(props) => (
              <ModelChip
                trigger={props}
                catalog={catalog}
                value={fallbackPick}
                inherited={null}
                inheritLabel={fallbackNever ? t('taskForm.fallback.never') : t('taskForm.fallback.inherit')}
                hint={fallbackNever ? undefined : t('taskForm.fallback.inheritHint')}
              />
            )}
          />
        </div>
          {/* Declared by the backend: the dispatcher blocks a code or
            * merge task on one that works outside Timon's folder, so
            * say it before the task is created. */}
          {form.backend_override && <BackendLimitsBadge catalog={catalog} backend={asBackend(form.backend_override)} />}
          {form.backend_override && (form.type === 'code' || form.type === 'merge')
            && !capabilitiesFor(catalog, asBackend(form.backend_override)).worktree && (
            <p className="text-xs text-destructive">{t('taskForm.worktreeBlocked')}</p>
          )}
          <label className="-mt-1 inline-flex cursor-pointer items-center gap-2 text-[13px] text-foreground">
            <input
              type="checkbox"
              checked={fallbackNever}
              onChange={(e) => setForm((f) => ({
                ...f,
                fallback_backend_override: e.target.checked ? NO_FALLBACK : (task?.fallback_backend_override !== NO_FALLBACK ? task?.fallback_backend_override ?? '' : ''),
                fallback_model_override: e.target.checked ? '' : (task?.fallback_backend_override !== NO_FALLBACK ? task?.fallback_model_override ?? '' : ''),
              }))}
              className="size-4 accent-[hsl(var(--primary))]"
            />
            {t('taskForm.fallback.never')}
          </label>
        <div className="flex items-center justify-between gap-3 text-[13px]">
          <label htmlFor={ids.perm} className="text-muted-foreground">{t('taskForm.permission')}</label>
          <ChoiceSelect
            className={FIELD_PAPER_CLASS}
            id={ids.perm}
            label={t('taskForm.permission')}
            value={form.permission_mode_override}
            options={permOptions.map((v) => ({ value: v, label: PERMISSION_MODES.includes(v) ? t(`taskForm.permissionModes.${v}`) : v }))}
            onChange={(v) => update('permission_mode_override', v)}
            icon={ShieldCheck}
          />
        </div>
      </section>
    </>
  );

  // The shell spreads its footer: deletion on the left, the closing pair on the right.
  const footer = (
    <>
      {isEdit && host.remove && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => { void host.remove?.(); }}
          className="mr-auto gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-3.5" aria-hidden />
          {t('taskForm.delete')}
        </Button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={host.close}>{t('taskForm.cancel')}</Button>
        <Button type="submit" size="sm" disabled={saving || files.uploading}>
          {saving ? (isEdit ? t('taskForm.saving') : t('taskForm.creating')) : isEdit ? t('taskForm.save') : t('taskForm.create')}
        </Button>
      </div>
    </>
  );

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <DetailShell
        header={(
          <div className="flex items-center gap-3">
            <h2 id={host.titleId} className="text-sm font-semibold text-foreground">
              {isEdit ? t('taskForm.editTitle') : t('taskForm.newTitle')}
            </h2>
            {isEdit && <span className="text-xs tabular-nums text-muted-foreground">{task.id.slice(0, 8)}</span>}
            <button
              type="button"
              onClick={host.close}
              aria-label={t('taskForm.close')}
              className="ml-auto grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        )}
        attachments={(
          <AttachmentsField
            items={files.items}
            errors={files.errors}
            url={host.attachments.url}
            onAdd={files.add}
            onRemove={files.remove}
            onDismissErrors={files.dismissErrors}
            disabled={saving}
          />
        )}
        attachmentsLabel={t('taskForm.attachments.label')}
        railLabel={t('taskForm.summary.label')}
        rail={rail}
        footer={footer}
      >
        <div className="flex flex-none flex-col gap-3">
          <div className="flex flex-col gap-2">
            <label htmlFor={ids.title} className="text-xs font-medium text-muted-foreground">{t('taskForm.title')}</label>
            <input
              ref={titleInput}
              id={ids.title}
              autoFocus
              required
              value={form.title}
              onChange={(e) => update('title', e.target.value)}
              aria-invalid={problems.includes('title') || undefined}
              aria-describedby={problems.includes('title') ? `${ids.title}-error` : undefined}
              placeholder={t('taskForm.titlePlaceholder')}
              autoComplete="off"
              className={cn(INPUT_CLASS, 'h-9 font-medium', PAPER_CLASS, problems.includes('title') && 'ring-2 ring-destructive/70')}
            />
            {problems.includes('title') && <p id={`${ids.title}-error`} className="text-xs text-destructive">{t('taskForm.titleRequired')}</p>}
          </div>

          <div role="tablist" aria-label={t('taskForm.tabs.label')} className="flex flex-wrap items-center gap-0.5 self-start rounded-lg bg-muted p-[3px]">
            {TASK_FORM_TABS.map((key) => {
              const active = tab === key;
              const count = counts[key];
              return (
                <button
                  key={key}
                  ref={(el) => { tabButtons.current[key] = el; }}
                  type="button"
                  role="tab"
                  id={tabId(key)}
                  aria-selected={active}
                  aria-controls={panelId(key)}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setTab(key)}
                  onKeyDown={onTabKey}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(`taskForm.tabs.${key}`)}
                  {count > 0 && (
                    <span className="min-w-[18px] rounded-full bg-muted-foreground/15 px-1.5 text-center text-[11px] tabular-nums text-foreground">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* The tabs stay in place while their panel scrolls; the negative
            margin keeps the focus rings of edge fields out of the clip. */}
        <div className="-mx-5 min-h-0 flex-1 overflow-y-auto px-5 pb-1 pt-1">
          {/* ── General ── */}
          <section {...panel('general')}>
            {isEdit && canMarkMerged(task) && (
              <MarkMergedSection taskId={task.id} done={task.status === 'DONE'} onMerged={host.finish} />
            )}
            {isEdit && task.worktree_path && canDetachWorktree(task) && (
              <WorktreeDetachSection taskId={task.id} path={task.worktree_path} branch={task.branch_name} onDetached={host.finish} />
            )}
            {isEdit && task.mr_url && (
              <Field label={t('kanbanPage.mergeRequest.label')}>
                <div><MergeRequestChip task={task} className="h-6 text-[12px]" /></div>
              </Field>
            )}
            <DescriptionField id={ids.description} value={form.description} onChange={(v) => update('description', v)} />
            {isEdit && task.done_comment && (
              <Field label={t('taskForm.report')}>
                <p data-task-report="" className={cn('whitespace-pre-wrap rounded-lg px-3.5 py-2.5 text-[13px] text-foreground/90', PAPER_CLASS)}>{task.done_comment}</p>
              </Field>
            )}
          </section>

          {/* ── Dependencies ── */}
          <section {...panel('dependencies')}>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <input
                  id={ids.depsFilter}
                  type="search"
                  value={filters.deps}
                  onChange={(e) => setFilters((f) => ({ ...f, deps: e.target.value }))}
                  aria-label={t('taskForm.deps.filter')}
                  placeholder={t('taskForm.deps.filter')}
                  className={INPUT_CLASS}
                />
                <span className="flex-none text-xs tabular-nums text-muted-foreground">
                  {t('taskForm.deps.count', { selected: form.deps.length, count: depsCandidates.length })}
                </span>
              </div>
              <DepsList candidates={depsCandidates} selected={form.deps} onToggle={(id) => toggleInList('deps', id)} filter={filters.deps} />
            </div>
          </section>

          {/* ── Capabilities ── */}
          <section {...panel('capabilities')}>
            <Field
              label={t('taskForm.skills')}
              aside={(
                <span className="text-xs tabular-nums text-muted-foreground">
                  {form.extra_skills.length > 0 ? t('taskForm.selectedCount', { count: form.extra_skills.length }) : t('taskForm.noneSelected')}
                </span>
              )}
            >
              <input
                id={ids.skillsFilter}
                type="search"
                value={filters.skills}
                onChange={(e) => setFilters((f) => ({ ...f, skills: e.target.value }))}
                aria-label={t('taskForm.skillsFilter')}
                placeholder={t('taskForm.skillsFilter')}
                className={INPUT_CLASS}
              />
              <ChipToggles
                label={t('taskForm.skills')}
                options={skills.map((s) => s.id)}
                values={form.extra_skills}
                onToggle={(v) => toggleInList('extra_skills', v)}
                empty={t('taskForm.noSkills')}
                noMatch={t('taskForm.noSkillMatch')}
                filter={filters.skills}
              />
            </Field>
            <Field
              label={t('taskForm.mcpServers')}
              aside={form.extra_mcp_servers.length > 0 && (
                <span className="text-xs tabular-nums text-muted-foreground">{t('taskForm.selectedCount', { count: form.extra_mcp_servers.length })}</span>
              )}
            >
              <ChipToggles
                label={t('taskForm.mcpServers')}
                options={mcps.map((m) => m.name || m.id)}
                values={form.extra_mcp_servers}
                onToggle={(v) => toggleInList('extra_mcp_servers', v)}
                empty={t('taskForm.noMcpServers')}
                noMatch={t('taskForm.noSkillMatch')}
                filter=""
              />
            </Field>
            <Field label={t('taskForm.extraAllowedTools')} htmlFor={ids.tools}>
              <input
                id={ids.tools}
                value={form.extra_allowed_tools}
                onChange={(e) => update('extra_allowed_tools', e.target.value)}
                // code-font: tool patterns such as Bash(git:*), read by the CLI as typed
                className={cn(INPUT_CLASS, 'font-mono text-xs')}
                placeholder={t('taskForm.allowedToolsPlaceholder')}
              />
            </Field>
          </section>

        </div>
      </DetailShell>
    </form>
  );
}

/**
 * The model the task runs on with no override of its own. An edited task kept
 * on its agent has it resolved by the daemon (project role included); a new
 * task, or one moved to another agent, shows that agent's own model.
 */
// A block of the rail: the rail is the island, its blocks are apart by its gap.
const ASIDE_BLOCK = 'flex flex-col gap-4';
const SMALL_FIELD_CLASS = cn('h-7 max-w-[10rem] rounded-md px-2 text-[13px] text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring', FIELD_PAPER_CLASS);

function inheritedPick(
  catalog: BackendCatalog,
  task: TaskFormValue['task'],
  agentName: string,
  agent: TaskFormAgent | null,
): ModelPick | null {
  if (task && task.agent_name === agentName && task.effective_backend && !task.backend_override && !task.model_override) {
    return { backend: task.effective_backend, model: task.effective_model || defaultModelFor(catalog, task.effective_backend) };
  }
  if (agent?.backend) return { backend: agent.backend, model: agent.model || defaultModelFor(catalog, agent.backend) };
  return null;
}

function ModelMark({ catalog, pick, className }: { catalog: BackendCatalog; pick: ModelPick; className?: string }) {
  const backend = catalog.backends.find((b) => b.id === pick.backend);
  const model = backend?.models.find((m) => m.slug === pick.model);
  return (
    <BrandMark icon={model?.icon} brand={model?.brand} slug={pick.model} fallbackIcon={backend?.icon} fallbackBrand={backend?.brand} className={className} />
  );
}

/** The model field's chip: the pick, or what "inherit" runs on, with its real logo. */
function ModelChip({ trigger, catalog, value, inherited, inheritLabel, hint }: {
  trigger: ModelPickerTriggerProps;
  catalog: BackendCatalog;
  value: ModelPick | null;
  inherited: ModelPick | null;
  inheritLabel: string;
  /** Said on hover while nothing is picked: what "inherit" means here. */
  hint?: string;
}) {
  const shown = value ?? inherited;
  const text = value ? pickLabel(catalog, value)
    : inherited ? t('taskForm.modelInherited', { model: pickLabel(catalog, inherited) })
    : inheritLabel;
  const { ref, ...rest } = trigger;
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      data-model-chip=""
      title={value ? undefined : hint}
      className="inline-flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg bg-white px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-white/60 dark:bg-muted/50 dark:hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {shown && <ModelMark catalog={catalog} pick={shown} className="size-4" />}
      <span className={cn('min-w-0 truncate', !value && 'text-muted-foreground')}>{text}</span>
    </button>
  );
}

/** One line of the right column's table: the label, then its value or its control. */
function SummaryRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  const Label = htmlFor ? 'label' : 'span';
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <dt className="flex-none text-muted-foreground"><Label htmlFor={htmlFor}>{label}</Label></dt>
      <dd className="m-0 flex min-w-0 justify-end text-right text-foreground">{children}</dd>
    </div>
  );
}
