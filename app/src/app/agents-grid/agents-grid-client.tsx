'use client';

/**
 * "Project grid" view: an alternative to the constellation canvas of /agents.
 *
 * Why it exists: while working, you only talk to the project's orchestrator.
 * Secondary agents do not need a node of their own in a graph you then have to
 * pan and zoom to find the right project. Here, one card per project, vertical
 * scroll, sorted by recent activity: the project you are working on rises on
 * its own.
 *
 * The frame (hexagonal background, Notifications rail on the left, Tasks rail
 * on the right, bottom action bar) is the one of /agents: only the central area
 * changes, not the cockpit.
 *
 * This view is mounted by the /agents switcher (Canvas | Grid toggle); the
 * /agents-grid URL is now only a redirect to /agents?view=grid.
 */

import Link from 'next/link';
import { openAgentEditor } from '@/components/agent-editor/agent-editor-modal';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EyeOff, FolderPlus, ListTodo, MessageSquare, RefreshCw, Search, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAgentsContentClass } from '@/app/agents/agents-widget-rails';
import { t } from '@/lib/i18n';
import { compareText } from '@/lib/intl';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { MobileAgentList } from '@/components/mobile-agent-list';
import { TaskFormModal } from '@/components/task-form-modal';
import { ProjectEditDialog } from '@/components/project-edit-dialog';
import { useActiveAgents } from '@/lib/active-agents';
import { type ActiveState } from '@/lib/agent-state';
import { ProjectCard } from './project-card';
import { pendingFor } from '@/lib/command-requests';
import { usePendingCommandRequests } from '@/lib/use-pending-command-requests';
import type { Agent, Browser, Docker, GitRemote, Project, Watcher } from './types';
import { mainAgentOf } from '@/lib/main-agent';
import { machineScopedStorage } from '@/lib/machines/machine-storage';

const CORE_POLL_MS = 15_000;
const GREPAI_POLL_MS = 8_000;
/** Container state rarely changes on its own: no need to scan docker as often
 *  as the index. */
const DOCKER_POLL_MS = 10_000;
/** A browser only opens and closes explicitly (no idle timeout on the
 *  orchestrator side): polling it often would teach nothing. */
const BROWSER_POLL_MS = 20_000;
/** Each git status runs a handful of `git` on the orchestrator side: over ~25
 *  projects, a tight poll would cost more than it brings (the publication state
 *  only changes after a commit or a push). The card buttons refresh the entry
 *  concerned immediately, so the wait is never visible after an action. */
const GIT_POLL_MS = 120_000;
/** Git statuses read in parallel. Beyond that, the burst of `git` subprocesses
 *  on load is paid in latency on the whole rest of the API. */
const GIT_CONCURRENCY = 3;

/** Display order of the secondary roles: the pipeline in reading order (code,
 *  review, merge), the support roles after. */
const ROLE_ORDER = ['coder', 'reviewer', 'merger', 'ops', 'librarian', 'research'];

function roleRank(a: Agent): number {
  const key = (a.role ?? '').toLowerCase();
  const i = ROLE_ORDER.indexOf(key);
  return i === -1 ? ROLE_ORDER.length : i;
}

/** Rising priority: what waits for a human answer comes before what is
 *  running, which comes before what has just finished. */
const STATE_RANK: Record<ActiveState, number> = {
  needs_action: 3,
  thinking: 2,
  done: 1,
  idle: 0,
};

/** The project's orchestrator, by its ROLE. Its name used to count too
 *  (`globex`, `globex.main`), which forced an orchestrator to be named after
 *  its project; the daemon stamped the role on the historical ones. */
function isMainAgent(a: Agent): boolean {
  return a.role === 'orchestrator';
}

/** Same order as the daemon's `projectOrchestratorName`: the role holder, then
 *  an agent carrying only the `orchestrator` flag (TIM-0067). */
function isFlaggedOrchestrator(a: Agent): boolean {
  return a.orchestrator === true && a.ephemeral !== true;
}

/** `_main` and the workspace hubs `_main.<ws>`: never attached to a project, so
 *  never a card. They stay reachable in the /agents constellation. */
export const isGlobalAgent = (name: string) => name === '_main' || name.startsWith('_main.');

/** Projects hidden from the grid. A DISPLAY preference, deliberately local to
 *  the browser: hiding a finished project here must not touch its `status` in
 *  the database, which drives the memory digest and the hot/cold sorting of
 *  agents. Deleting for good stays an explicit gesture, in the identity popup
 *  opened by the card's pencil. */
const HIDDEN_LS = 'timon.agents-grid.hidden';

function loadHidden(): Set<string> {
  try {
    const raw = machineScopedStorage(localStorage).getItem(HIDDEN_LS);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

type Group = {
  project: Project;
  main: Agent | null;
  secondaries: Agent[];
  /** Live state rank of the project (all agents together): first sort key. */
  rank: number;
  /** Last known TIMON activity, epoch ms: second sort key. */
  at: number;
};

export function AgentsGridClient() {
  const contentClass = useAgentsContentClass();
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activity, setActivity] = useState<Record<string, number>>({});
  const [watchers, setWatchers] = useState<Record<string, Watcher>>({});
  const [gits, setGits] = useState<Record<string, GitRemote>>({});
  const [dockers, setDockers] = useState<Record<string, Docker>>({});
  const [browsers, setBrowsers] = useState<Record<string, Browser>>({});
  const [query, setQuery] = useState('');
  const [workspace, setWorkspace] = useState('all');
  const [loading, setLoading] = useState(true);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  // Empty set on first render: localStorage does not exist on the server and
  // reading it in the initialiser would break hydration.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => setHidden(loadHidden()), []);

  const toggleHidden = useCallback((slug: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      try {
        machineScopedStorage(localStorage).setItem(HIDDEN_LS, JSON.stringify([...next]));
      } catch {
        /* quota / private mode: hiding then lasts for the session */
      }
      return next;
    });
  }, []);

  const active = useActiveAgents();
  const pendingCommands = usePendingCommandRequests();
  const stateByAgent = useMemo(() => {
    const m = new Map<string, ActiveState>();
    for (const a of active) m.set(a.name, a.state);
    return m;
  }, [active]);

  /* ── Projects + agents + activity ─────────────────────────────────────── */
  const loadCore = useCallback(async () => {
    try {
      const [pr, ar, actr] = await Promise.all([
        fetch('/api/ui/projects', { cache: 'no-store' }),
        fetch('/api/ui/agents', { cache: 'no-store' }),
        // Recent endpoint: until the orchestrator has been restarted, it answers 404
        // and we fall back on `projects.last_activity` (less precise but never
        // missing) rather than breaking the sort.
        fetch('/api/ui/projects/activity', { cache: 'no-store' }).catch(() => null),
      ]);
      if (pr.ok) {
        const j = (await pr.json()) as { projects?: Project[] };
        setProjects(j.projects ?? []);
      }
      if (ar.ok) {
        const j = (await ar.json()) as { agents?: Agent[] };
        setAgents(j.agents ?? []);
      }
      if (actr?.ok) {
        const j = (await actr.json()) as { activity?: Record<string, number> };
        setActivity(j.activity ?? {});
      }
    } catch {
      /* Silent: a failed poll has no reason to empty the grid already shown. */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCore();
    const t = setInterval(() => void loadCore(), CORE_POLL_MS);
    return () => clearInterval(t);
  }, [loadCore]);

  /* ── grepai watchers (a single call for all projects) ─────────────────── */
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/ui/grepai', { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as { watchers?: Watcher[] };
        if (cancelled) return;
        const next: Record<string, Watcher> = {};
        for (const w of j.watchers ?? []) next[w.slug] = w;
        setWatchers(next);
      } catch {
        /* same: keep the last known state */
      }
    }
    void load();
    const t = setInterval(() => void load(), GREPAI_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  /* ── Docker containers (a single call for all projects) ───────────────── */
  // Same shape as grepai: the orchestrator scans docker once and splits by
  // project; one call per card would rerun a full `docker inspect`.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/ui/docker', { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as { services?: Docker[] };
        if (cancelled) return;
        const next: Record<string, Docker> = {};
        for (const d of j.services ?? []) next[d.slug] = d;
        setDockers(next);
      } catch {
        /* keep the last known state */
      }
    }
    void load();
    const t = setInterval(() => void load(), DOCKER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  /* ── Embedded browsers (a single call for all projects) ───────────────── */
  // Same shape as docker: the orchestrator already holds the session table, one
  // call is enough to colour every card.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/ui/browser', { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as { sessions?: Browser[] };
        if (cancelled) return;
        const next: Record<string, Browser> = {};
        for (const b of j.sessions ?? []) next[b.project] = b;
        setBrowsers(next);
      } catch {
        /* keep the last known state */
      }
    }
    void load();
    const t = setInterval(() => void load(), BROWSER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  /* ── Git statuses (one call per project, in a bounded queue) ──────────── */
  // A hidden project costs nothing: its git status is not fetched until it is
  // shown again.
  const gitSlugs = useMemo(
    () =>
      projects
        .filter((p) => !!p.cwd && (showHidden || !hidden.has(p.slug)))
        .map((p) => p.slug)
        .sort(),
    [projects, hidden, showHidden],
  );
  const gitSlugsKey = gitSlugs.join(',');
  const gitSlugsRef = useRef<string[]>([]);
  gitSlugsRef.current = gitSlugs;

  useEffect(() => {
    if (!gitSlugsRef.current.length) return;
    let cancelled = false;

    async function loadAll() {
      const queue = [...gitSlugsRef.current];
      const worker = async () => {
        for (;;) {
          const slug = queue.shift();
          if (!slug || cancelled) return;
          try {
            const r = await fetch(`/api/ui/git-remote/${encodeURIComponent(slug)}`, {
              cache: 'no-store',
            });
            if (!r.ok) continue;
            const j = (await r.json()) as { git?: GitRemote };
            if (j.git && !cancelled) setGits((prev) => ({ ...prev, [slug]: j.git! }));
          } catch {
            /* an unreadable project must not stop the queue */
          }
        }
      };
      await Promise.all(Array.from({ length: GIT_CONCURRENCY }, worker));
    }

    void loadAll();
    const t = setInterval(() => void loadAll(), GIT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [gitSlugsKey]);

  /* ── Grouping: project → agents ───────────────────────────────────────── */
  const { groups, workspaces } = useMemo(() => {
    const bySlug = new Map<string, Project>();
    for (const p of projects) bySlug.set(p.slug.toLowerCase(), p);

    const agentsBySlug = new Map<string, Agent[]>();
    for (const a of agents) {
      if (isGlobalAgent(a.name)) continue;
      const slug = a.project?.toLowerCase() ?? null;
      if (!slug) continue;
      // An agent can reference a slug missing from the projects table (deleted
      // project, or agent created before the record): we materialise a minimal card
      // rather than make it disappear from the UI.
      if (!bySlug.has(slug)) bySlug.set(slug, { slug });
      const list = agentsBySlug.get(slug);
      if (list) list.push(a);
      else agentsBySlug.set(slug, [a]);
    }

    const built: Group[] = [];
    for (const [slug, project] of bySlug) {
      const list = agentsBySlug.get(slug) ?? [];
      const main = list.find(isMainAgent) ?? list.find(isFlaggedOrchestrator) ?? null;
      const secondaries = list
        .filter((a) => a !== main)
        .sort((a, b) => roleRank(a) - roleRank(b) || compareText(a.name, b.name));
      const rank = list.reduce((best, a) => {
        const s = stateByAgent.get(a.name);
        return s ? Math.max(best, STATE_RANK[s]) : best;
      }, 0);
      built.push({
        project,
        main,
        secondaries,
        rank,
        at: Math.max(activity[slug] ?? 0, project.last_activity ?? 0),
      });
    }

    built.sort(
      (a, b) =>
        b.rank - a.rank ||
        b.at - a.at ||
        compareText(a.project.name || a.project.slug, b.project.name || b.project.slug),
    );

    const ws = [...new Set(projects.map((p) => p.workspace).filter(Boolean))] as string[];
    ws.sort();

    return {
      groups: built,
      workspaces: ws,
    };
  }, [projects, agents, activity, stateByAgent]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups.filter((g) => {
      if (!showHidden && hidden.has(g.project.slug)) return false;
      if (workspace !== 'all' && g.project.workspace !== workspace) return false;
      if (!q) return true;
      return (
        g.project.slug.toLowerCase().includes(q) ||
        (g.project.name ?? '').toLowerCase().includes(q) ||
        (g.project.workspace ?? '').toLowerCase().includes(q)
      );
    });
  }, [groups, query, workspace, hidden, showHidden]);

  // Counted on `groups` and not on `visible`: the button must announce
  // everything hidden, including what a workspace filter would exclude anyway.
  const hiddenCount = useMemo(
    () => groups.filter((g) => hidden.has(g.project.slug)).length,
    [groups, hidden],
  );

  const setWatcher = useCallback((w: Watcher) => {
    setWatchers((prev) => ({ ...prev, [w.slug]: w }));
  }, []);
  const setGit = useCallback((g: GitRemote) => {
    setGits((prev) => ({ ...prev, [g.slug]: g }));
  }, []);
  const setDocker = useCallback((d: Docker) => {
    setDockers((prev) => ({ ...prev, [d.slug]: d }));
  }, []);
  const setBrowser = useCallback((b: Browser) => {
    setBrowsers((prev) => ({ ...prev, [b.project]: b }));
  }, []);

  const agentNames = useMemo(() => agents.map((a) => ({ name: a.name })), [agents]);

  return (
    // `h-full`: the route's height, the viewport's alone, an island's in the workspace (§1).
    <div className="relative z-[1] h-full overflow-hidden">




      {/* Central column: the only scrollable area. The side margins
          keep room for the fixed rails (Notifications on the left from md,
          Tasks on the right from lg) and the bottom for the action bar. */}
      <div className={cn(contentClass, "absolute inset-0 overflow-y-auto overflow-x-hidden pb-24")}>
        <div className="mx-auto flex w-full max-w-[1020px] flex-col gap-4">
          {/* Workspaces centred, on the grid's axis. */}
          {workspaces.length > 0 && (
            <div className="flex flex-wrap justify-center gap-1">
              {['all', ...workspaces].map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setWorkspace(w)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-[10px] transition-colors',
                    workspace === w
                      ? 'border-primary/60 bg-primary/10 text-primary'
                      : 'border-border/60 bg-card/60 text-muted-foreground backdrop-blur hover:text-foreground',
                  )}
                >
                  {w}
                </button>
              ))}
            </div>
          )}

          {/* Search centred under the workspaces. A 1fr/auto/1fr grid rather
              than a plain flex: the counters do not push the input off the
              axis, it stays centred whatever the sides show. */}
          <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
            <div className="hidden sm:block" aria-hidden />

            <div className="flex items-center justify-center gap-2">
              <div className="relative w-full sm:w-[240px]">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('agentsGrid.filterProject')}
                  className="h-8 border-border/60 bg-card/70 pl-8 text-[12.5px] backdrop-blur"
                />
              </div>
            </div>

            <div className="flex items-center justify-center gap-2 sm:justify-end">
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setShowHidden((v) => !v)}
                title={
                  showHidden
                    ? t('agentsGrid.hideHiddenProjects')
                    : t('agentsGrid.showHiddenProjects')
                }
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-[10px] transition-colors',
                  showHidden
                    ? 'border-primary/60 bg-primary/10 text-primary'
                    : 'border-border/60 bg-card/60 text-muted-foreground backdrop-blur hover:text-foreground',
                )}
              >
                <EyeOff className="size-3.5" />
                {t('agentsGrid.hiddenProjects', { count: hiddenCount })}
              </button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-[10.5px] text-muted-foreground"
              onClick={() => void loadCore()}
              title={t('agentsGrid.refreshProjectsAgents')}
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              {t('agentsGrid.projectCount', { count: visible.length })}
            </Button>
            </div>
          </div>

          {/* Grid: auto-fill bounded by the container width → 3 columns on a
              large screen, 2 then 1 when the rails eat the room. */}
          {visible.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 p-10 text-center text-[12.5px] text-muted-foreground">
              {loading ? t('agentsGrid.loading') : t('agentsGrid.noMatchingProject')}
            </p>
          ) : (
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(290px,1fr))]">
              {visible.map((g) => (
                <ProjectCard
                  key={g.project.slug}
                  project={g.project}
                  main={g.main}
                  secondaries={g.secondaries}
                  stateByAgent={stateByAgent}
                  watcher={watchers[g.project.slug] ?? null}
                  git={gits[g.project.slug] ?? null}
                  docker={dockers[g.project.slug] ?? null}
                  browser={browsers[g.project.slug] ?? null}
                  onWatcher={setWatcher}
                  onGit={setGit}
                  onDocker={setDocker}
                  onBrowser={setBrowser}
                  hidden={hidden.has(g.project.slug)}
                  onToggleHidden={() => toggleHidden(g.project.slug)}
                  onEdited={() => void loadCore()}
                  pendingCommands={pendingFor(pendingCommands, g.project.slug)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bottom action bar, identical to /agents. */}
      <div className="fixed bottom-4 left-1/2 z-[5] flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-2 overflow-x-auto rounded-xl border border-border bg-card/80 px-2 py-1.5 shadow-lg backdrop-blur scrollbar-none">
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1.5 px-2.5 text-[11.5px] font-medium"
          onClick={() => setShowNewTask(true)}
        >
          <ListTodo className="size-3.5" />
          {t('agentsGrid.newTask')}
        </Button>
        <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1.5 px-2.5 text-[11.5px] font-medium" asChild>
          <Link
            href="/edit?new=1"
            onClick={(e) => {
              e.preventDefault();
              openAgentEditor({ isNew: true });
            }}
          >
            <UserPlus className="size-3.5" />
            {t('agentsGrid.newAgent')}
          </Link>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1.5 px-2.5 text-[11.5px] font-medium"
          onClick={() => setShowNewProject(true)}
        >
          <FolderPlus className="size-3.5" />
          {t('agentsGrid.newProject')}
        </Button>
        <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1.5 px-2.5 text-[11.5px] font-medium" asChild>
          <Link href="/chat">
            <MessageSquare className="size-3.5" />
            {t('agentsGrid.askAgent', { name: mainAgentOf(agents) ?? t('agentsGrid.mainAgentFallback') })}
          </Link>
        </Button>

      </div>


      <MobileAgentList />


      {showNewTask && (
        <TaskFormModal
          agents={agentNames}
          onClose={() => setShowNewTask(false)}
          onSaved={() => setShowNewTask(false)}
        />
      )}

      {showNewProject && (
        <ProjectEditDialog
          slug={null}
          onSaved={() => void loadCore()}
          onClose={() => setShowNewProject(false)}
        />
      )}

    </div>
  );
}
