'use client';

/**
 * Project card of the `/agents` grid view.
 *
 * One card = one project = one unit of work. The big circle opens the `.main`
 * (the only agent you really talk to), the small circles open the secondary
 * agents without putting them on the same visual level. The card foot carries
 * the three signals that ask for a human action: a frozen grepai index,
 * unpublished code, a docker stack down. Each is identified by its glyph (scan
 * magnifier, GitHub logo, Docker whale) rather than a text label: at this
 * size, three capital letters ate half the value.
 *
 * Colour rule: colour signals, it does not decorate. At rest the card is
 * monochrome; amber and red only appear on what waits for a gesture, and a
 * role's colour only appears when its agent works (or on hover). Without this
 * discipline, twenty gaudy cards all look alike and a glance no longer sorts
 * anything.
 */

import { ChatLink } from '@/components/chat/chat-link';
import { useState } from 'react';
import {
  CloudUpload,
  Eye,
  EyeOff,
  ExternalLink,
  GitBranch,
  Pencil,
  Globe,
  Play,
  RefreshCw,
  RotateCw,
  ScanSearch,
  Square,
  SquareTerminal,
  Upload,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ProjectEditDialog } from '@/components/project-edit-dialog';
import { t } from '@/lib/i18n';
import { chatHref } from '@/lib/chat-island-params';
import { useAccess } from '@/hooks/use-me';
import { responseErrorText, type PermissionAccess } from '@/lib/permission-refusal';
import { autoColor, isIconUrl } from '@/lib/project-visual';
import { accentVars } from '@/lib/accent-color';
import { resolveRole, type RoleVisual } from '@/lib/roles';
import { RoleSvg } from '@/components/role-svg';
import { STATE_VISUALS, type ActiveState } from '@/lib/agent-state';
import { avatarModeOf, lookOfAgent } from '@/components/agent-avatar';
import { LiveAgentMascot } from '@/components/mascot/live-agent-mascot';
import { DockerIcon, GithubIcon } from '@/components/brand-icons';
import {
  GitRemoteCreateDialog,
  type CreateRemoteOptions,
} from '@/components/git-remote-create-dialog';
import { cwdValue } from './cwd-value';
import type { Agent, Browser, Docker, GitRemote, Project, Watcher } from './types';
import { GREPAI_STALE_AFTER_MS, humanAge } from './types';
import { apiErrorMessage } from '@/lib/api-error';

export type ProjectCardProps = {
  project: Project;
  main: Agent | null;
  secondaries: Agent[];
  /** Live state by agent name (thinking / needs_action / done). */
  stateByAgent: Map<string, ActiveState>;
  watcher: Watcher | null;
  git: GitRemote | null;
  docker: Docker | null;
  /** Browser session of the project: `null` until the poll has returned. */
  browser: Browser | null;
  onWatcher: (w: Watcher) => void;
  onGit: (g: GitRemote) => void;
  onDocker: (d: Docker) => void;
  onBrowser: (b: Browser) => void;
  /** Hidden project, shown only because "show hidden" is on. */
  hidden: boolean;
  onToggleHidden: () => void;
  /** The record was written or deleted: the parent reloads its list. */
  onEdited: () => void;
  /** Commands its agents asked the user to decide, still waiting. */
  pendingCommands?: number;
};

type Severity = 'ok' | 'idle' | 'warn' | 'alert';


/** Pulsing ring taken from the active agents banner: same colour code, so the
 *  same reading from one screen to the next. */
function PulseRing({ state, inset }: { state: ActiveState; inset: string }) {
  const vis = STATE_VISUALS[state];
  if (!vis.pulse) return null;
  return (
    <span
      className="pointer-events-none absolute animate-[ping_1.7s_ease-out_infinite] rounded-full opacity-70"
      style={{ inset, border: `1.5px solid ${vis.colorVar}` }}
      aria-hidden
    />
  );
}

function ProjectAvatar({ project }: { project: Project }) {
  if (isIconUrl(project.icon)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={project.icon as string} alt="" className="size-full rounded-full object-cover" />
    );
  }
  if (project.icon) return <span className="text-[24px] leading-none">{project.icon}</span>;
  return (
    <span className="text-[15px] font-semibold uppercase text-[var(--accent)] dark:text-[var(--accent-dark)]">
      {(project.name || project.slug).slice(0, 2)}
    </span>
  );
}

function RoleGlyph({ role, className }: { role: RoleVisual | null; className?: string }) {
  const Icon = role?.icon;
  if (Icon) return <Icon className={className} />;
  if (role?.iconSvg) {
    return <RoleSvg svg={role.iconSvg} className={className} />;
  }
  return <Zap className={className} />;
}

/** Secondary agent circle: the job glyph alone. Monochrome at rest; the role
 *  colour only comes out on hover or when the agent works.
 *  An agent that picked its mascot as its head (`avatar: 'mascot'`) shows it
 *  instead, alive; without that pick the role glyph stays, so no existing
 *  agent changes its face here. */
function SecondaryAgent({ agent, state }: { agent: Agent; state: ActiveState | undefined }) {
  const role = resolveRole(agent.role);
  const mascot = avatarModeOf(agent.avatar) === 'mascot' ? lookOfAgent(agent) : null;
  const color = agent.color || role?.color || 'hsl(var(--muted-foreground))';
  const lit = state === 'thinking' || state === 'needs_action';
  return (
    <ChatLink
      href={chatHref(agent.name)}
      title={`${agent.name}${role ? ` — ${role.label}` : ''}${state ? ` · ${STATE_VISUALS[state].label}` : ''}`}
      className={cn(
        'relative grid size-8 shrink-0 place-items-center rounded-full transition-colors',
        // A mascot is its own frame: no disc behind it; its pulse still says it works.
        mascot
          ? 'text-muted-foreground hover:text-foreground'
          : lit
            ? 'border border-transparent'
            : 'border border-border/70 bg-muted/30 text-muted-foreground hover:border-foreground/30 hover:text-foreground',
      )}
      style={lit && !mascot ? { borderColor: color, background: `${color}1a`, color } : undefined}
    >
      {mascot
        ? <LiveAgentMascot name={agent.name} look={mascot} size={28} />
        : <RoleGlyph role={role} className="size-3.5" />}
      {state && <PulseRing state={state} inset="-3px" />}
      {state === 'done' && (
        <span
          className="absolute -right-px -top-px size-1.5 rounded-full"
          style={{ background: STATE_VISUALS.done.colorVar }}
          aria-hidden
        />
      )}
    </ChatLink>
  );
}

/** At rest the glyph stays discreet; only what waits for a gesture is coloured. */
const ICON: Record<Severity, string> = {
  ok: 'text-muted-foreground/55',
  idle: 'text-muted-foreground/35',
  warn: 'text-amber-500',
  alert: 'text-red-500',
};

const VALUE: Record<Severity, string> = {
  ok: 'text-foreground/75',
  idle: 'text-muted-foreground/60',
  warn: 'text-amber-600 dark:text-amber-400',
  alert: 'text-red-600 dark:text-red-400',
};

function SignalRow({
  severity,
  label,
  icon,
  value,
  children,
}: {
  severity: Severity;
  /** The signal's nature in plain words: used as tooltip and accessible label,
   *  since the glyph alone says nothing to a screen reader. */
  label: string;
  icon: React.ReactNode;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      {/* The glyph carries the severity: the colour dot it replaces was
          redundant and stole 30 px of label from the value, which ended up
          truncated on half the cards. */}
      <span
        className={cn('flex size-3.5 shrink-0 items-center justify-center', ICON[severity])}
        title={label}
      >
        {icon}
        <span className="sr-only">{label}</span>
      </span>
      <span className={cn('min-w-0 flex-1 truncate text-[11.5px]', VALUE[severity])} title={value}>
        {value}
      </span>
      <span className="flex shrink-0 items-center gap-1">{children}</span>
    </div>
  );
}

/** Action to take: always visible, tinted with the severity. */
function ActionButton({
  onClick,
  disabled,
  title,
  tone,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  tone: 'warn' | 'alert';
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex h-[22px] items-center gap-1 rounded border px-1.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'alert'
          ? 'border-red-500/35 text-red-600 hover:bg-red-500/10 dark:text-red-400'
          : 'border-amber-500/35 text-amber-600 hover:bg-amber-500/10 dark:text-amber-400',
      )}
    >
      {children}
    </button>
  );
}

/** Comfort action (fetch, stopping a healthy watcher): discreet at rest,
 *  revealed on card hover so it does not clutter the reading. */
function QuietButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex size-[22px] items-center justify-center rounded border border-transparent text-muted-foreground/50 transition-all hover:border-border hover:text-foreground focus-visible:opacity-100 disabled:opacity-30 sm:opacity-0 sm:group-hover:opacity-100"
    >
      {children}
    </button>
  );
}

export function ProjectCard({
  project,
  main,
  secondaries,
  stateByAgent,
  watcher,
  git,
  docker,
  browser,
  onWatcher,
  onGit,
  onDocker,
  onBrowser,
  hidden,
  onToggleHidden,
  onEdited,
  pendingCommands = 0,
}: ProjectCardProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // Publish, push and fetch are `projects:manage` (TODO #525).
  const manage = useAccess('projects:manage');
  const [editOpen, setEditOpen] = useState(false);

  const color = project.color || autoColor(project.name || project.slug);
  const mainState = main ? stateByAgent.get(main.name) : undefined;

  async function grepaiAct(action: 'start' | 'stop' | 'init') {
    setBusy(`grepai:${action}`);
    setErr(null);
    try {
      const r = await fetch(`/api/ui/grepai/${encodeURIComponent(project.slug)}/${action}`, {
        method: 'POST',
      });
      const j = (await r.json()) as { watcher?: Watcher; error?: string };
      if (!r.ok) throw new Error(apiErrorMessage(j, { status: r.status }));
      if (j.watcher) onWatcher(j.watcher);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function dockerAct(action: 'start' | 'stop' | 'restart') {
    setBusy(`docker:${action}`);
    setErr(null);
    try {
      const r = await fetch(`/api/ui/docker/${encodeURIComponent(project.slug)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const j = (await r.json()) as { docker?: Docker; error?: string };
      if (!r.ok) throw new Error(apiErrorMessage(j, { status: r.status }));
      if (j.docker) onDocker(j.docker);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // The first start pulls the Chromium image: possibly several minutes, hence
  // no client-side timeout; the button simply stays busy.
  async function browserAct(action: 'start' | 'stop') {
    setBusy(`browser:${action}`);
    setErr(null);
    try {
      const r = await fetch(`/api/ui/browser/${encodeURIComponent(project.slug)}/${action}`, {
        method: 'POST',
      });
      const j = (await r.json()) as { session?: Browser; error?: string };
      if (!r.ok) throw new Error(apiErrorMessage(j, { status: r.status }));
      if (j.session) onBrowser(j.session);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function gitAct(
    action: 'push' | 'fetch' | 'create-remote',
    body: unknown = {},
  ): Promise<boolean> {
    setBusy(`git:${action}`);
    setErr(null);
    let ok = false;
    try {
      const r = await fetch(`/api/ui/git-remote/${encodeURIComponent(project.slug)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as { git?: GitRemote; error?: string };
      if (!r.ok) throw new Error(responseErrorText(j, `HTTP ${r.status}`));
      if (j.git) {
        onGit(j.git);
        ok = true;
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
    return ok;
  }

  // Same rule as the chat rail: close only on success, otherwise "name already
  // taken" forces retyping the description and visibility.
  const submitCreate = async (opts: CreateRemoteOptions) => {
    if (await gitAct('create-remote', opts)) setCreateOpen(false);
  };

  return (
    <article
      className={cn(
        'group relative flex flex-col gap-2.5 rounded-xl border border-border/60 bg-card/70 p-3.5 shadow-lg backdrop-blur transition-colors hover:border-primary/40',
        // Dashes alone: a reduced opacity made hidden cards unreadable, while they
        // are shown precisely to be read again.
        hidden && 'border-dashed border-border',
      )}
    >
      <div className="absolute right-2 top-2 z-[1] flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          title={t('projectsPage.editTitle', { slug: project.slug })}
          aria-label={t('projectsPage.editTitle', { slug: project.slug })}
          className="inline-flex size-[22px] items-center justify-center rounded border border-transparent text-muted-foreground/50 transition-all hover:border-border hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onToggleHidden}
          title={hidden ? t('agentsGrid.showProject') : t('agentsGrid.hideProject')}
          aria-label={hidden ? t('agentsGrid.showProject') : t('agentsGrid.hideProject')}
          className={cn(
            'inline-flex size-[22px] items-center justify-center rounded border border-transparent text-muted-foreground/50 transition-all hover:border-border hover:text-foreground',
            !hidden && 'sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100',
          )}
        >
          {hidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        </button>
      </div>

      <div className="flex items-center gap-3">
        {main ? (
          <ChatLink
            href={chatHref(main.name)}
            title={t('agentsGrid.openAgent', { name: main.name })}
            // The ring and the initials follow the theme: a near-black project
            // colour would draw a ring nobody sees on the dark background.
            className="relative grid size-16 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--accent-soft)] shadow-[0_0_0_1.5px_var(--accent-border)] transition-transform hover:scale-[1.05] dark:bg-[var(--accent-soft-dark)] dark:shadow-[0_0_0_1.5px_var(--accent-border-dark)]"
            style={accentVars(color)}
          >
            <ProjectAvatar project={project} />
            {mainState && <PulseRing state={mainState} inset="-4px" />}
          </ChatLink>
        ) : (
          // Same identity as with an orchestrator (logo, colour); the dashed
          // ring alone says there is nobody to talk to.
          <span
            title={t('agentsGrid.noOrchestrator')}
            className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-full border-[1.5px] border-dashed border-[var(--accent-border)] bg-[var(--accent-soft)] dark:border-[var(--accent-border-dark)] dark:bg-[var(--accent-soft-dark)]"
            style={accentVars(color)}
          >
            <ProjectAvatar project={project} />
          </span>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="min-w-0 pr-12">
            {/* Without an orchestrator there is nobody to talk to: the title
                stays text. It pointed to /projects, which gave a link that looks
                like it opens the project and leaves the page. */}
            {main ? (
              <ChatLink
                href={chatHref(main.name)}
                className="block truncate text-[14.5px] font-semibold leading-tight tracking-tight hover:underline"
              >
                {project.name || project.slug}
              </ChatLink>
            ) : (
              <span
                title={t('agentsGrid.noOrchestratorNothingToOpen')}
                className="block truncate text-[14.5px] font-semibold leading-tight tracking-tight text-muted-foreground"
              >
                {project.name || project.slug}
              </span>
            )}
            <span className="block truncate text-[10px] text-muted-foreground/60">
              {project.slug}
              {project.workspace ? ` · ${project.workspace}` : ''}
            </span>
            {pendingCommands > 0 && (
              // Where they are decided is the mission's conversation, reached from the notification.
              <span
                role="status"
                className="mt-1.5 inline-flex max-w-full items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300"
              >
                <SquareTerminal className="size-3 shrink-0" />
                <span className="truncate">{t('terminal.request.pendingBadge', { count: pendingCommands })}</span>
              </span>
            )}
          </div>

          {secondaries.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {secondaries.map((a) => (
                <SecondaryAgent key={a.name} agent={a} state={stateByAgent.get(a.name)} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1 pt-2">
        <GrepaiRow watcher={watcher} busy={busy} onAct={grepaiAct} />
        <GitRow
          git={git}
          busy={busy}
          manage={manage}
          onPush={() => gitAct('push')}
          onFetch={() => gitAct('fetch')}
          onCreate={() => {
            setErr(null);
            setCreateOpen(true);
          }}
        />
        <DockerRow docker={docker} busy={busy} onAct={dockerAct} />
        <BrowserRow browser={browser} busy={busy} onAct={browserAct} />
        {err && <p className="break-words pl-[42px] text-[10px] text-red-500">{err}</p>}
      </div>

      {git && (
        <GitRemoteCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          defaultName={git.default_repo_name ?? project.slug}
          branch={git.branch}
          commits={git.ahead}
          ghAccount={git.gh_account}
          busy={busy === 'git:create-remote'}
          error={err}
          onSubmit={submitCreate}
        />
      )}

      {editOpen && (
        <ProjectEditDialog
          slug={project.slug}
          onSaved={onEdited}
          onClose={() => setEditOpen(false)}
        />
      )}
    </article>
  );
}

function GrepaiRow({
  watcher,
  busy,
  onAct,
}: {
  watcher: Watcher | null;
  busy: string | null;
  onAct: (a: 'start' | 'stop' | 'init') => void;
}) {
  if (!watcher || watcher.state === 'no-cwd') {
    return (
      <SignalRow
        severity={watcher?.cwd_error ? 'warn' : 'idle'}
        label={t('agentsGrid.grepaiIndex')}
        icon={<ScanSearch className="size-3.5" />}
        value={cwdValue(watcher)}
      />
    );
  }

  const age = watcher.index_age_ms !== null ? humanAge(watcher.index_age_ms) : null;
  const stale = watcher.index_age_ms !== null && watcher.index_age_ms > GREPAI_STALE_AFTER_MS;

  if (watcher.state === 'running') {
    return (
      <SignalRow
        severity={stale ? 'warn' : 'ok'}
        label={t('agentsGrid.grepaiIndex')}
        icon={<ScanSearch className="size-3.5" />}
        value={stale ? t('agentsGrid.staleSince', { age: age ?? '' }) : t('agentsGrid.upToDate', { age: age ? ` · ${age}` : '' })}
      >
        <QuietButton
          onClick={() => onAct('stop')}
          disabled={busy !== null}
          title={t('agentsGrid.stopGrepaiWatcher')}
        >
          <Square className="size-3" />
        </QuietButton>
      </SignalRow>
    );
  }

  if (watcher.state === 'not-indexed') {
    return (
      <SignalRow
        severity="idle"
        label={t('agentsGrid.grepaiIndex')}
        icon={<ScanSearch className="size-3.5" />}
        value={t('agentsGrid.neverIndexed')}
      >
        <ActionButton
          onClick={() => onAct('init')}
          disabled={busy !== null}
          title={t('agentsGrid.indexProject')}
          tone="warn"
        >
          <Zap className="size-2.5" />
          {busy === 'grepai:init' ? '…' : t('agentsGrid.index')}
        </ActionButton>
      </SignalRow>
    );
  }

  return (
    <SignalRow
      severity="alert"
      label={t('agentsGrid.grepaiIndex')}
      icon={<ScanSearch className="size-3.5" />}
      value={t('agentsGrid.watcherStopped', { age: age ? ` · ${age}` : '' })}
    >
      <ActionButton
        onClick={() => onAct('start')}
        disabled={busy !== null}
        title={t('agentsGrid.restartGrepaiWatcher')}
        tone="alert"
      >
        <Play className="size-2.5" />
        {busy === 'grepai:start' ? '…' : t('agentsGrid.start')}
      </ActionButton>
    </SignalRow>
  );
}

/** Docker line: present only when the project really has containers. Unlike
 *  the grepai index or the git remote, the absence of Docker is not a gap to
 *  fix; showing it would put a dead line on half the cards. */
function DockerRow({
  docker,
  busy,
  onAct,
}: {
  docker: Docker | null;
  busy: string | null;
  onAct: (a: 'start' | 'stop' | 'restart') => void;
}) {
  if (!docker || docker.state === 'no-cwd' || docker.state === 'none') return null;
  if (docker.state === 'no-docker') {
    return (
      <SignalRow
        severity="idle"
        label={t('agentsGrid.dockerContainers')}
        icon={<DockerIcon className="size-3.5" />}
        value={t('agentsGrid.daemonUnreachable')}
      />
    );
  }

  const total = docker.containers.length;
  const up = docker.containers.filter((c) => c.state === 'running').length;
  const running = docker.state === 'running';
  const host = docker.url?.replace(/^https?:\/\//, '') ?? null;
  const value = running
    ? t('agentsGrid.dockerRunning', { host: host ?? t('agentsGrid.containerCount', { count: total }) })
    : docker.state === 'partial'
      ? t('agentsGrid.dockerPartial', { up, total })
      : t('agentsGrid.dockerStopped', { count: total });

  return (
    <SignalRow
      severity={running ? 'ok' : docker.state === 'partial' ? 'warn' : 'idle'}
      label={t('agentsGrid.dockerContainers')}
      icon={<DockerIcon className="size-3.5" />}
      value={value}
    >
      {docker.state !== 'running' && (
        <ActionButton
          onClick={() => onAct('start')}
          disabled={busy !== null}
          title={t('agentsGrid.startProjectContainers')}
          tone="warn"
        >
          <Play className="size-2.5" />
          {busy === 'docker:start' ? '…' : t('agentsGrid.start')}
        </ActionButton>
      )}
      <QuietButton
        onClick={() => onAct('restart')}
        disabled={busy !== null || docker.state === 'stopped'}
        title={t('agentsGrid.restartContainers')}
      >
        <RotateCw className={cn('size-3', busy === 'docker:restart' && 'animate-spin')} />
      </QuietButton>
      {up > 0 && (
        <QuietButton
          onClick={() => onAct('stop')}
          disabled={busy !== null}
          title={t('agentsGrid.stopContainers')}
        >
          <Square className="size-3" />
        </QuietButton>
      )}
      {docker.url && (
        <a
          href={docker.url}
          target="_blank"
          rel="noreferrer"
          title={t('agentsGrid.openUrl', { url: docker.url })}
          className="inline-flex size-[22px] items-center justify-center rounded border border-transparent text-muted-foreground/50 transition-all hover:border-border hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100"
        >
          <ExternalLink className="size-3" />
        </a>
      )}
    </SignalRow>
  );
}

/** Browser line: present on EVERY card, even without a known session. It is
 *  the only place where a glance tells whether an agent of this project will
 *  be able to drive a real browser: without a browser up at spawn time, its
 *  `chrome-devtools` MCP falls back on a local Chrome opened on the screen,
 *  which we never want. */
function BrowserRow({
  browser,
  busy,
  onAct,
}: {
  browser: Browser | null;
  busy: string | null;
  onAct: (a: 'start' | 'stop') => void;
}) {
  const running = browser?.status === 'running';
  const port = browser ? `:${browser.cdp_port}` : '';

  return (
    <SignalRow
      severity={running ? 'ok' : 'idle'}
      label={t('agentsGrid.projectBrowser')}
      icon={<Globe className="size-3.5" />}
      value={running ? t('agentsGrid.browserRunning', { port }) : t('agentsGrid.browserStopped')}
    >
      {!running && (
        <QuietButton
          onClick={() => onAct('start')}
          disabled={busy !== null}
          title={t('agentsGrid.startProjectBrowser')}
        >
          {busy === 'browser:start' ? <RefreshCw className="size-3 animate-spin" /> : <Play className="size-3" />}
        </QuietButton>
      )}
      {running && (
        <QuietButton
          onClick={() => onAct('stop')}
          disabled={busy !== null}
          title={t('agentsGrid.stopBrowser')}
        >
          <Square className="size-3" />
        </QuietButton>
      )}
      {running && browser?.url && (
        <a
          href={browser.url}
          target="_blank"
          rel="noreferrer"
          title={t('agentsGrid.openBrowserDesktop', { url: browser.url })}
          className="inline-flex size-[22px] items-center justify-center rounded border border-transparent text-muted-foreground/50 transition-all hover:border-border hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100"
        >
          <ExternalLink className="size-3" />
        </a>
      )}
    </SignalRow>
  );
}

function GitRow({
  git,
  busy,
  manage,
  onPush,
  onFetch,
  onCreate,
}: {
  git: GitRemote | null;
  busy: string | null;
  manage: PermissionAccess;
  onPush: () => void;
  onFetch: () => void;
  onCreate: () => void;
}) {
  // GitHub logo only when the remote really is one: a GitLab repository or a
  // home-grown remote under the octocat would be a misreading.
  const gitIcon = /github\.com/.test(git?.remote ?? '') ? (
    <GithubIcon className="size-3.5" />
  ) : (
    <GitBranch className="size-3.5" />
  );

  if (!git) return <SignalRow severity="idle" label={t('agentsGrid.gitPublication')} icon={gitIcon} value="…" />;
  if (git.state === 'no-cwd') {
    return (
      <SignalRow
        severity={git.cwd_error ? 'warn' : 'idle'}
        label={t('agentsGrid.gitPublication')}
        icon={gitIcon}
        value={cwdValue(git)}
      />
    );
  }
  if (git.state === 'not-a-repo') {
    return (
      <SignalRow severity="idle" label={t('agentsGrid.gitPublication')} icon={gitIcon} value={t('agentsGrid.notGitRepository')} />
    );
  }
  if (git.state === 'no-remote') {
    return (
      <SignalRow
        severity="alert"
        label={t('agentsGrid.gitPublication')}
        icon={gitIcon}
        value={git.has_commits ? t('agentsGrid.unpublishedLocalOnly') : t('agentsGrid.unpublishedNoCommits')}
      >
        <ActionButton
          onClick={onCreate}
          disabled={busy !== null || !manage.allowed || !git.has_commits || !git.gh_available}
          title={
            manage.denied
              ? manage.denied
              : !git.gh_available
                ? t('agentsGrid.ghCliMissing')
                : !git.has_commits
                  ? t('agentsGrid.noCommitToPublish')
                  : t('agentsGrid.createRemoteAndPush')
          }
          tone="alert"
        >
          <CloudUpload className="size-2.5" />
          {t('agentsGrid.publish')}
        </ActionButton>
      </SignalRow>
    );
  }

  const pending = git.ahead ?? 0;
  // The remote is only named when there is room for confusion: several remotes,
  // or a tracked remote that is not `origin`. Otherwise it is noise.
  const namedRemote =
    git.remote_name && (git.remote_count > 1 || git.remote_name !== 'origin') ? git.remote_name : null;
  const value = [
    git.branch ?? '—',
    pending > 0 ? t('agentsGrid.pendingPush', { count: pending }) : t('agentsGrid.upToDate', { age: '' }),
    namedRemote,
    git.dirty ? t('agentsGrid.uncommitted', { count: git.dirty }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <SignalRow
      severity={pending > 0 ? 'warn' : 'ok'}
      label={t('agentsGrid.gitPublication')}
      icon={gitIcon}
      value={value}
    >
      {pending > 0 && (
        <ActionButton
          onClick={onPush}
          disabled={busy !== null || !manage.allowed}
          title={manage.denied ?? t('agentsGrid.gitPush', { count: pending })}
          tone="warn"
        >
          <Upload className="size-2.5" />
          {busy === 'git:push' ? '…' : t('agentsGrid.push', { count: pending })}
        </ActionButton>
      )}
      <QuietButton
        onClick={onFetch}
        disabled={busy !== null || !manage.allowed}
        title={manage.denied ?? t('agentsGrid.gitFetch')}
      >
        <RefreshCw className={cn('size-3', busy === 'git:fetch' && 'animate-spin')} />
      </QuietButton>
      {git.remote_web && (
        <a
          href={git.remote_web}
          target="_blank"
          rel="noreferrer"
          title={git.remote ?? undefined}
          className="inline-flex size-[22px] items-center justify-center rounded border border-transparent text-muted-foreground/50 transition-all hover:border-border hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100"
        >
          <ExternalLink className="size-3" />
        </a>
      )}
    </SignalRow>
  );
}
