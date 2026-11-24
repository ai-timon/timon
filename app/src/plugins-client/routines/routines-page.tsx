'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { RoleBadge } from '@/components/role-badge';
import { resolveRole } from '@/lib/roles';
import { t } from '@/lib/i18n';
import { formatDate, formatTime } from '@/lib/intl';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { apiErrorMessage, responseErrorMessage } from '@/lib/api-error';
import { ChipToggles } from '@/components/task-form/task-form-parts';
import { parseJsonList } from '@/components/task-form/task-form-model';

type Routine = {
  id: string;
  name: string;
  agent_name: string;
  prompt: string;
  task_type: string;
  cron_expr: string;
  enabled: number;
  project: string | null;
  /** JSON list of the MCP server ids copied onto every task it opens; null = none. */
  extra_mcp_servers?: string | null;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
};

type Agent = { name: string; project?: string | null };
type McpSummary = { id: string };

const TASK_TYPES = ['code', 'review', 'merge', 'research', 'doc', 'chore'] as const;

// Cron presets — a simplified picker for the common cases. For truly custom
// stuff (5-field cron), the user types it directly.
export const CRON_PRESETS: { labelKey: string; expr: string }[] = [
  { labelKey: 'routinesPage.presets.every5',  expr: '*/5 * * * *' },
  { labelKey: 'routinesPage.presets.hourly',  expr: '0 * * * *' },
  { labelKey: 'routinesPage.presets.daily9',  expr: '0 9 * * *' },
  { labelKey: 'routinesPage.presets.daily2',  expr: '0 2 * * *' },
  { labelKey: 'routinesPage.presets.monday9', expr: '0 9 * * 1' },
  { labelKey: 'routinesPage.presets.monthly', expr: '0 9 1 * *' },
];

export function fmtDate(ms: number | null) {
  if (!ms) return '—';
  return `${formatDate(ms, { month: 'short', day: 'numeric' })} ${formatTime(ms)}`;
}

function RoutineDialog({
  agents,
  routine,
  onSaved,
  onClose,
}: {
  agents: Agent[];
  routine?: Routine | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const isEdit = !!routine;
  const [name, setName] = useState(routine?.name ?? '');
  const [agent, setAgent] = useState(routine?.agent_name ?? agents[0]?.name ?? '');
  const [prompt, setPrompt] = useState(routine?.prompt ?? '');
  const [taskType, setTaskType] = useState(routine?.task_type ?? 'chore');
  const [cron, setCron] = useState(routine?.cron_expr ?? '0 9 * * *');
  const [project, setProject] = useState(routine?.project ?? '');
  const [enabled, setEnabled] = useState(routine ? routine.enabled === 1 : true);
  const [mcpServers, setMcpServers] = useState<string[]>(() => parseJsonList(routine?.extra_mcp_servers));
  const [mcps, setMcps] = useState<McpSummary[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/ui/mcp', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() as Promise<{ servers?: McpSummary[] }> : { servers: [] }))
      .catch(() => ({ servers: [] }))
      .then((j) => { if (!cancelled) setMcps(j.servers ?? []); });
    return () => { cancelled = true; };
  }, []);

  function toggleMcp(id: string) {
    setMcpServers((list) => (list.includes(id) ? list.filter((v) => v !== id) : [...list, id]));
  }

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!name.trim() || !agent || !prompt.trim() || !cron.trim()) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        agent_name: agent,
        prompt: prompt.trim(),
        task_type: taskType,
        cron_expr: cron.trim(),
        project: project.trim() || null,
        enabled,
        extra_mcp_servers: mcpServers,
      };
      const res = await fetch(
        isEdit ? `/api/ui/routines/${routine!.id}` : '/api/ui/routines',
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        throw new Error(await responseErrorMessage(res, t('routinesPage.failed', { status: res.status })));
      }
      toast.success(t(isEdit ? 'routinesPage.updated' : 'routinesPage.created'));
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-xl border border-border bg-popover p-5 shadow-elev-3"
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-semibold">{t(isEdit ? 'routinesPage.edit' : 'routinesPage.new')}</span>
          <button type="button" onClick={onClose} aria-label={t('routinesPage.close')} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">{t('routinesPage.name')}</label>
            <input
              autoFocus required value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder={t('routinesPage.namePlaceholder')}
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">{t('routinesPage.prompt')}</label>
            <textarea
              required value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder={t('routinesPage.promptPlaceholder')}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[11px] text-muted-foreground">{t('routinesPage.agent')}</label>
              <select
                required value={agent}
                onChange={(e) => setAgent(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>{a.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-muted-foreground">{t('routinesPage.taskType')}</label>
              <select
                value={taskType}
                onChange={(e) => setTaskType(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {TASK_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">{t('routinesPage.cron')}</label>
            <input
              required value={cron}
              onChange={(e) => setCron(e.target.value)}
              // code-font: a cron expression
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="0 9 * * *"
            />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.expr}
                  type="button"
                  onClick={() => setCron(p.expr)}
                  className="rounded-md border border-border bg-muted/30 px-2 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground"
                >
                  {t(p.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[11px] text-muted-foreground">{t('routinesPage.project')}</label>
              <input
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                // i18n-exempt: sample project slug
                placeholder="timon"
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                {t('routinesPage.enabled')}
              </label>
            </div>
          </div>

          <div>
            <span className="mb-1 block text-[11px] text-muted-foreground">{t('routinesPage.mcpServers')}</span>
            <ChipToggles
              label={t('routinesPage.mcpServers')}
              options={mcps.map((m) => m.id)}
              values={mcpServers}
              onToggle={toggleMcp}
              empty={t('routinesPage.noMcpServers')}
              noMatch={t('routinesPage.noMcpServers')}
              filter=""
            />
            <p className="mt-1 text-[11px] text-muted-foreground">{t('routinesPage.mcpServersHint')}</p>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('routinesPage.cancel')}</Button>
          <Button type="submit" size="sm" disabled={saving}>
            {t(saving ? (isEdit ? 'routinesPage.saving' : 'routinesPage.creating') : (isEdit ? 'routinesPage.save' : 'routinesPage.create'))}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function RoutinesClient() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [edit, setEdit] = useState<Routine | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [rr, ar] = await Promise.all([
        fetch('/api/ui/routines', { cache: 'no-store' }).then((r) => r.ok ? r.json() : { routines: [] }),
        fetch('/api/ui/agents',   { cache: 'no-store' }).then((r) => r.ok ? r.json() : { agents: [] }),
      ]);
      setRoutines(rr.routines || []);
      setAgents(ar.agents || []);
    } catch { /* keep last */ }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 10_000);
    return () => clearInterval(id);
  }, [fetchData]);

  async function toggle(r: Routine) {
    const res = await fetch(`/api/ui/routines/${r.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: r.enabled === 0 }),
    });
    if (res.ok) fetchData(); else toast.error(t('routinesPage.toggleFailed'));
  }

  async function del(id: string) {
    if (!(await confirmAction({ title: t('routinesPage.deleteConfirm'), confirmLabel: t('confirmDialog.delete'), destructive: true }))) return;
    const r = await fetch(`/api/ui/routines/${id}`, { method: 'DELETE' });
    if (r.ok) { toast.success(t('routinesPage.deleted')); fetchData(); }
    else toast.error(t('routinesPage.deleteFailed'));
  }

  async function convert(routine: Routine) {
    if (!(await confirmAction({ title: t('workflows.convertConfirm'), confirmLabel: t('confirmDialog.convert') }))) return;
    const response = await fetch(`/api/ui/workflows/import/routine/${routine.id}`, { method: 'POST' });
    const value = await response.json();
    if (!response.ok) { toast.error(apiErrorMessage(value, t('routinesPage.conversionFailed'))); return; }
    toast.success(t('routinesPage.workflowCreated'));
    fetchData();
    location.assign(`/workflows/${value.workflow.slug}`);
  }

  return (
    <>
      {showNew && <RoutineDialog agents={agents} onSaved={fetchData} onClose={() => setShowNew(false)} />}
      {edit && <RoutineDialog agents={agents} routine={edit} onSaved={fetchData} onClose={() => setEdit(null)} />}

      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" onClick={() => setShowNew(true)} className="h-7 px-3 text-[12px]">{t('routinesPage.newButton')}</Button>
        <span className="text-[11.5px] text-muted-foreground">{t('routinesPage.count', { count: routines.length })}</span>
      </div>

      <div className="mt-3 space-y-2">
        {routines.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-[12px] text-muted-foreground/70">
            {t('routinesPage.empty')}
          </div>
        )}
        {routines.map((r) => (
          <article
            key={r.id}
            className={cn(
              'group flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3',
              r.enabled === 0 && 'opacity-60',
            )}
          >
            <button
              type="button"
              onClick={() => convert(r)}
              className="rounded border border-border bg-muted/30 px-2 py-1 text-[10.5px] text-muted-foreground opacity-0 transition-opacity hover:border-primary hover:text-primary group-hover:opacity-100"
            >
              {t('workflows.convertToWorkflow')}
            </button>
            <button
              type="button"
              onClick={() => toggle(r)}
              className={cn(
                'h-2 w-2 flex-none rounded-full',
                r.enabled === 1
                  ? 'bg-[hsl(var(--success))] shadow-[0_0_0_3px_hsl(var(--success)/0.18)]'
                  : 'bg-muted-foreground/40',
              )}
              title={t(r.enabled ? 'routinesPage.disable' : 'routinesPage.enable')}
            />
            <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setEdit(r)}>
              <div className="text-[13px] font-medium leading-snug">{r.name}</div>
              <div className="text-[11.5px] text-muted-foreground/80 line-clamp-1 mt-0.5">{r.prompt}</div>
            </div>
            {/* code-font: a cron expression */}
            <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
              {r.cron_expr}
            </span>
            {resolveRole(r.task_type) ? (
              <RoleBadge role={r.task_type} size="sm" uppercase={false} />
            ) : (
              <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                {r.task_type}
              </span>
            )}
            <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
              → {r.agent_name}
            </span>
            <div className="hidden md:flex flex-col items-end text-[10.5px] text-muted-foreground/70 tabular-nums leading-tight">
              <span>{t('routinesPage.next', { date: fmtDate(r.next_run_at) })}</span>
              <span>{t('routinesPage.last', { date: fmtDate(r.last_run_at) })}</span>
            </div>
            <button
              type="button"
              onClick={() => del(r.id)}
              className="rounded border border-border bg-muted/30 px-2 py-1 text-[10.5px] text-muted-foreground opacity-0 transition-opacity hover:border-destructive hover:text-destructive group-hover:opacity-100"
            >
              {t('routinesPage.delete')}
            </button>
          </article>
        ))}
      </div>

    </>
  );
}
