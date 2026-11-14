'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ProjectBadge } from '@/components/project-badge';
import { resolveRole } from '@/lib/roles';
import { agentToOpen } from '@/lib/main-agent';
import { RoleManager } from '@/components/role-manager';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { reportDirectoryPick, useDirectoryPicker } from '@/components/directory-browser';
import { startAgentEditorDiagnostic } from '@/lib/agent-editor-diagnostic';
import { BrowserProfileSelect } from '@/components/browser-profile-select';
import { ModelPickerPanel, type ModelPick } from '@/components/model-picker';
import { SelfPermissionsBadge } from '@/components/self-permissions-badge';
import { PermissionModeField } from './permission-mode-field';
import { AgentApprovals } from '@/components/agent-editor/agent-approvals';
import { BackendLimitsBadge } from '@/components/backend-limits-badge';
import { t } from '@/lib/i18n';
import { renameFollowUps } from '@/lib/agent-rename';
import { TRIGGERS_ROUTE } from '@/plugins-client/triggers/model';
import { BRAND } from '@/lib/brand';
import { IdentityDocs } from '@/components/agent-editor/identity-docs';
import { ThinkingSlider, keepEffort } from '@/components/agent-editor/thinking-slider';
import { thinkingBarFor, thinkingValues } from '@/lib/thinking-bar';
import { AgentInjectionsTab } from '@/plugins-client/agent-injections/injections-tab';
import { announceAgentsChanged } from '@/lib/agents-changed';
import { openSkillIsland } from '@/lib/skill-island-content';
import { useAccess } from '@/hooks/use-me';
import {
  agentSkillModes, attachBody, attachFailure, attachmentSync, checkedSkills, effectiveSkills, inheritedSkills, parseSkillsPreview, skillsPreviewBody, weightsOnBackend,
  type ResolvedSkill, type SkillAttachment, type SkillMode, type SkillsPreview, type SkillWeights,
} from '@/lib/skill-attachments';
import { formatTokens } from '@/lib/agent-injections';
import { AgentAvatar, agentIdentity, avatarModeOf, lookOfAgent, type AgentAvatarMode } from '@/components/agent-avatar';
import { defaultLookFor, type AgentLook } from '@/components/mascot/agent-look';
import { AvatarTab, shownAvatarMode } from '@/components/agent-editor/avatar-tab';
import { OrchestrationSection, type OrchestrationAgent } from '@/components/agent-editor/orchestration-section';
import {
  useBackendCatalog,
  defaultModelFor,
  asBackend,
  canReadSkillOnDemand,
  capabilitiesFor,
  permissionHintKey,
  managesOwnPermissions,
  type BackendCatalog,
  type BackendName,
} from '@/lib/backends';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { deleteAgentAfterConfirm } from '@/components/agent-editor/delete-agent';
import { apiErrorMessage } from '@/lib/api-error';

type AgentSummary = {
  name: string;
  /** Which provider CLI runs this agent. Open registry on the orchestrator
   *  side (backend profiles) → no fixed union here. Default: the daemon's. */
  backend?: BackendName;
  model?: string;
  cwd?: string;
  system_prompt?: string;
  permission_mode?: string;
  allowed_tools?: string[];
  denied_tools?: string[];
  skills?: string[];
  mcp_servers?: string[];
  excluded_mcp_servers?: string[];
  reasoning_effort?: string | null;
  status?: string;
  missions?: number;
  project?: string | null;
  browser_profile_id?: string | null;
  emoji?: string | null;
  color?: string | null;
  icon_url?: string | null;
  /** Mascot look (`config.look`) and picked head (`config.avatar`), as the daemon reads them. */
  look?: unknown;
  avatar?: string | null;
  role?: string | null;
  role_emoji?: string | null;
  directives?: string | null;
  /** Injects the cross-project digest (hot projects + goals) at spawn. */
  global_context?: boolean;
  /** Explicit manager (the canvas sets it) and team of bots (an id). */
  reports_to?: string | null;
  team?: string | null;
  /** Delegation list, as the daemon states it (see orchestration-section). */
  orchestrates?: OrchestrationAgent['orchestrates'];
  effective_orchestrates?: OrchestrationAgent['effective_orchestrates'];
  orchestrates_source?: OrchestrationAgent['orchestrates_source'];
  /** Set by the daemon on the agent it records as the main one. */
  main?: boolean;
};

type ProjectSummary = { slug: string; name?: string; icon?: string | null; color?: string };

/** Who actually runs each kind of task for a project, as resolved by the
 *  daemon: the roles.json pin, else the agent carrying the role, else the
 *  name that would be created on the first task. */
type RoleResolution = {
  agent: string;
  source: 'pinned' | 'role' | 'convention';
  exists: boolean;
};
/** Task types the daemon resolves an agent for. `doc` is out: those tasks go
 *  to the librarian, whatever the project. */
const PROJECT_TASK_TYPES = ['code', 'review', 'merge', 'research', 'chore'] as const;

type RoleSpec = {
  id: string;
  label: string;
  iconName: string;
  iconSvg: string;
  color: string;
  default_directives: string;
  default_model: string;
  default_permission_mode: string;
  builtin?: boolean;
};

type SkillSource = 'timon' | 'claude-user' | 'project' | 'plugin';
type Skill = {
  id: string;
  title?: string;
  description?: string;
  source: SkillSource;
  format?: 'timon' | 'claude-skill' | 'claude-cmd';
  shadowed?: boolean;
};

// Keys, not strings: translated at render, once the interface language is set.
const EDIT_SKILL_SECTIONS: { source: SkillSource; label: string; hint: string }[] = [
  { source: 'timon', label: 'editPage.skillSectionTimonLabel', hint: 'editPage.skillSectionTimonHint' },
  { source: 'project', label: 'editPage.skillSectionProjectLabel', hint: 'editPage.skillSectionProjectHint' },
  { source: 'claude-user', label: 'editPage.skillSectionUserLabel', hint: 'editPage.skillSectionUserHint' },
  { source: 'plugin', label: 'editPage.skillSectionPluginLabel', hint: 'editPage.skillSectionPluginHint' },
];
type McpSummary = {
  id: string;
  name?: string;
  transport_type: 'stdio' | 'http' | 'external';
  tools_count: number;
  /** 'claude_ai' = imported from your Claude.ai account (Gmail, Drive,
   *   etc.); 'claude_cli' = from the user's own claude configuration. These
   *   servers are *enabled by default* on the CLI side and are disabled via
   *   excluded_mcp_servers (opt-out).
   *  Other/undefined = TIMON-managed (stdio/http defined in /mcp), opt-in
   *   via mcp_servers. */
  source?: string;
};

type Draft = {
  name: string;
  systemPrompt: string;
  cwd: string;
  project: string;
  browserProfileId: string | null | undefined;
  backend: BackendName;
  model: string;
  /** Default thinking level; '' = the model's own default. */
  reasoningEffort: string;
  mode: string;
  allowed: string[];
  denied: string[];
  skills: string[];
  /** Opt-in: TIMON-managed MCP servers enabled for this agent. */
  mcpServers: string[];
  /** Opt-out: Claude.ai externals disabled for this agent (externals
   *  are enabled by default on the claude CLI side). */
  excludedMcp: string[];
  emoji: string;
  color: string;
  iconUrl: string;
  /** The head picked in the Avatar tab; `null`: none, the historical order applies. */
  avatar: AgentAvatarMode | null;
  /** The mascot's look; `null` until the agent has one (the configurator starts from the role's). */
  look: AgentLook | null;
  role: string;
  /** Injects the cross-project digest at spawn (business agents / _main). */
  globalContext: boolean;
};

/** Auto-derive project slug from a cwd. Mirrors orchestrator helper. */
function projectFromCwd(cwd: string | null | undefined): string {
  if (!cwd) return '';
  const nested = /^\/workspace\/projects\/([A-Za-z0-9._-]+)/.exec(cwd);
  if (nested) return nested[1]!;
  const flat = /^\/workspace\/([A-Za-z0-9._-]+)/.exec(cwd);
  return flat ? flat[1]! : '';
}

// Backend/model lists come from the orchestrator catalog, loaded at
// runtime via `useBackendCatalog()` — nothing is hardcoded here.

function paletteFor(name: string) {
  const c = [
    'hsl(var(--primary))',
    'hsl(var(--agenda-2))',
    'hsl(var(--agenda-3))',
    'hsl(var(--agenda-4))',
    'hsl(var(--agenda-5))',
    'hsl(var(--agenda-6))',
    'hsl(var(--salmon-2))',
    'hsl(var(--success))',
  ];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return c[h % c.length]!;
}

/**
 * `<input type="color">` only accepts #rrggbb, but a palette entry is now a
 * token (`hsl(var(--primary))`). Resolving it needs a probe element in the
 * document, which is a side effect: it belongs to an effect, never to the
 * render pass — and it only makes sense once the theme plugin has painted
 * its tokens, i.e. on the client.
 */
function cssColorToHex(color: string): string {
  if (/^#([0-9a-f]{6})$/i.test(color)) return color;
  const probe = document.createElement('span');
  probe.style.color = color;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(computed);
  if (!m) return '#000000';
  const hex = (n: string) => Number(n).toString(16).padStart(2, '0');
  return `#${hex(m[1]!)}${hex(m[2]!)}${hex(m[3]!)}`;
}

/** Hex mirror of a possibly token-based color, resolved after mount. */
function useHexColor(color: string): string {
  const [hex, setHex] = useState(() => (/^#([0-9a-f]{6})$/i.test(color) ? color : '#000000'));
  useEffect(() => {
    setHex(cssColorToHex(color));
  }, [color]);
  return hex;
}

// Full details (incl. system_prompt content); falls back to the list-shaped
// row when the lookup fails (e.g. agent not yet on disk).
async function fetchAgentDetails(a: AgentSummary): Promise<AgentSummary> {
  try {
    const r = await fetch('/api/ui/agents/' + encodeURIComponent(a.name), { cache: 'no-store' });
    if (r.ok) return (await r.json()) as AgentSummary;
  } catch {}
  return a;
}


/**
 * The pair the picker lights up for the agent. An empty model is the
 * backend's default (what the daemon runs when the field is left out), so the
 * picker shows it rather than a blank slug. The backend is kept as stored,
 * account instance included: a `claude@<id>` the catalogue no longer lists
 * reads as gone, never as the default account.
 */
export function agentModelPick(
  cat: BackendCatalog, backend: BackendName, model: string | undefined,
): ModelPick | null {
  if (!backend) return null;
  return { backend, model: model || defaultModelFor(cat, backend) };
}

/** Long enough to send one request per burst of typing or clicks. */
const PREVIEW_DEBOUNCE_MS = 250;

function toDraft(a: AgentSummary, cat: BackendCatalog): Draft {
  const cwd = a.cwd || '';
  // Open registry: keep the value as-is (a third-party profile like `kimi`
  // is a legitimate backend), only the empty value falls back to the default.
  const backend: BackendName = asBackend(a.backend);
  return {
    name: a.name,
    systemPrompt: a.system_prompt || '',
    cwd,
    project: a.project ?? projectFromCwd(cwd),
    browserProfileId: a.browser_profile_id,
    backend,
    model: a.model || defaultModelFor(cat, backend),
    reasoningEffort: a.reasoning_effort ?? '',
    mode: a.permission_mode || 'auto',
    allowed: [...(a.allowed_tools || [])],
    denied: [...(a.denied_tools || [])],
    skills: [...(a.skills || [])],
    mcpServers: [...(a.mcp_servers || [])],
    excludedMcp: [...(a.excluded_mcp_servers || [])],
    emoji: a.emoji || '',
    color: a.color || '',
    iconUrl: a.icon_url || '',
    avatar: avatarModeOf(a.avatar),
    look: lookOfAgent({ look: a.look, role: a.role }),
    role: a.role || '',
    globalContext: a.global_context ?? false,
  };
}

const BLANK_AGENT: AgentSummary = {
  name: '',
  // The daemon's default backend and its default model fill these in (`toDraft`).
  backend: '',
  model: '',
  system_prompt: '',
  // Default role for a fresh agent — no roleless agents, and not
  // `orchestrator`: that role grants the orchestrator-only tools, and a
  // hand-made agent took the main agent's place on the Company canvas (#134).
  role: 'coder',
  permission_mode: 'auto',
  allowed_tools: [],
  denied_tools: [],
  skills: [],
  mcp_servers: [],
  // Note: the actual list of externals to exclude is computed dynamically
  // in startNewAgent() from the loaded MCP catalog.
  excluded_mcp_servers: [],
  status: 'idle',
  missions: 0,
};

/** The steps of the form, in the order the tab bar shows them (labels: `editPage.tabs.<key>`). */
export const AGENT_EDITOR_TABS = ['avatar', 'identity', 'orchestration', 'llm', 'workspace', 'permissions', 'skills', 'mcp', 'injections'] as const;
export type AgentEditorTab = (typeof AGENT_EDITOR_TABS)[number];
type TabKey = AgentEditorTab;

export type AgentEditorProps = {
  /** Agent to open. Ignored when `isNew`. Defaults to the main agent. */
  agent?: string | null;
  /** Open the blank-agent form instead of loading an existing agent. */
  isNew?: boolean;
  /** Set by the modal host: paints a close button and closes the overlay. */
  onClose?: () => void;
  /** Lets the host know whether closing right now would lose edits. */
  onDirtyChange?: (dirty: boolean) => void;
  /** The tab the form opens on ("Change avatar" opens `avatar`); Identity otherwise. */
  initialTab?: AgentEditorTab;
};

export function AgentEditor({ agent, isNew, onClose, onDirtyChange, initialTab }: AgentEditorProps) {
  const wantsNew = isNew === true;

  // Backend/model catalog (runtime, empty on first paint).
  const catalog = useBackendCatalog();
  // The cwd is read by the active machine's daemon (TIM-0136).
  const directoryPicker = useDirectoryPicker();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [mcpServers, setMcpServers] = useState<McpSummary[]>([]);
  const [roles, setRoles] = useState<RoleSpec[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [teams, setTeams] = useState<{ id: string; name: string; color: string | null }[]>([]);
  // Creation must accept input even while the supporting catalogs are pending.
  const [selected, setSelected] = useState<AgentSummary | null>(() => wantsNew ? BLANK_AGENT : null);
  const [draft, setDraft] = useState<Draft | null>(() => wantsNew ? toDraft(BLANK_AGENT, catalog) : null);
  const [dirty, setDirty] = useState(wantsNew);
  // The Orchestration tab keeps its own selection until Apply; it reports it
  // here so the close guard sees it. `orchestrationEpoch` remounts the tab
  // when the editor drops its edits (another agent, or the same one reloaded).
  const [orchestrationDirty, setOrchestrationDirty] = useState(false);
  const [orchestrationEpoch, setOrchestrationEpoch] = useState(0);
  const unsaved = dirty || orchestrationDirty;
  const [saving, setSaving] = useState(false);
  // Import mode of the checked skills (catalogue when absent), the agent's own
  // attachments as last read, and the skills a wider scope brings it.
  const [skillModes, setSkillModes] = useState<Record<string, SkillMode>>({});
  const [ownAttachments, setOwnAttachments] = useState<SkillAttachment[]>([]);
  const [inherited, setInherited] = useState<ResolvedSkill[]>([]);
  const [excludingSkill, setExcludingSkill] = useState<string | null>(null);
  const [skillExcludeError, setSkillExcludeError] = useState<string | null>(null);
  const selectedName = useRef(selected?.name);
  selectedName.current = selected?.name;
  // What each skill weighs per mode, and what the daemon says a spawn would send
  // with the draft as it stands.
  const [skillWeights, setSkillWeights] = useState<SkillWeights | null>(null);
  const [skillsPreview, setSkillsPreview] = useState<SkillsPreview | null>(null);

  /* ── What the selected backend can do ──────────────────────────────────
     Anything that varies from one backend to another is read from the
     catalog, never from a comparison of its id: the registry is open, and
     two profiles can share the same CLI (hence the same capabilities)
     under two names. */
  const draftBackend = asBackend(draft?.backend);
  const subscription = catalog.backends.find((b) => b.id === draftBackend)?.subscription;
  const modelPick = agentModelPick(catalog, draftBackend, draft?.model);
  const ownPermissions = managesOwnPermissions(catalog, draftBackend);
  const permissionHintId = permissionHintKey(catalog, draftBackend);
  const readsOnDemand = canReadSkillOnDemand(capabilitiesFor(catalog, draftBackend));
  const shownWeights = skillWeights ? weightsOnBackend(skillWeights, readsOnDemand, skillsPreview) : null;
  const permissionHint = permissionHintId ? t(permissionHintId) : null;
  // Extra .md docs at the agent root, excluding system-prompt.md (which lives
  // in the System prompt textarea above). Indexed by file name.
  const [extraDocs, setExtraDocs] = useState<Record<string, string>>({});
  // Which step of the form is on screen. The six sections used to be
  // stacked in one scroll — the tab bar is what made the page readable.
  const [tab, setTab] = useState<TabKey>(initialTab ?? 'identity');
  // The agent picker replaces the sidebar that listed all agents.
  const [projectRoles, setProjectRoles] = useState<Record<string, RoleResolution> | null>(null);
  const docSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const editorRoot = useRef<HTMLDivElement>(null);
  const draftReady = draft !== null;
  useEffect(() => {
    if (draftReady && editorRoot.current) return startAgentEditorDiagnostic(editorRoot.current);
  }, [draftReady]);

  const fetchAll = useCallback(async () => {
    try {
      const [ar, sr, mr, rr, pr, tr] = await Promise.all([
        fetch('/api/ui/agents', { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : { agents: [] },
        ),
        fetch('/api/ui/skills', { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : { skills: [] },
        ),
        fetch('/api/ui/mcp', { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : { servers: [] },
        ),
        fetch('/api/ui/agent-roles', { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : { roles: [] },
        ),
        fetch('/api/ui/projects', { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : { projects: [] },
        ),
        fetch('/api/ui/teams', { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : { teams: [] },
        ),
      ]);
      const list: AgentSummary[] = ar.agents || [];
      setAgents(list);
      setSkills(sr.skills || []);
      setMcpServers(mr.servers || []);
      setRoles(rr.roles || []);
      setProjects((pr.projects || []) as ProjectSummary[]);
      setTeams(tr.teams || []);
      return list;
    } catch {
      return [];
    }
  }, []);

  // Re-fetch roles only — after a custom role is created/edited/deleted.
  const refetchRoles = useCallback(async () => {
    try {
      const r = await fetch('/api/ui/agent-roles', { cache: 'no-store' });
      setRoles(r.ok ? (await r.json()).roles || [] : []);
    } catch {
      /* keep current */
    }
  }, []);

  /** Who runs each kind of task on this project. Read from the daemon rather
   *  than recomputed here: the arbitration (pin → role → naming default) has
   *  one owner, and a second copy in the browser would drift from it. */
  const refetchProjectRoles = useCallback(async (slug: string) => {
    if (!slug) { setProjectRoles(null); return; }
    try {
      const r = await fetch(`/api/ui/projects/${encodeURIComponent(slug)}/roles`, { cache: 'no-store' });
      setProjectRoles(r.ok ? ((await r.json()).resolved ?? {}) : null);
    } catch {
      setProjectRoles(null);
    }
  }, []);

  useEffect(() => {
    void refetchProjectRoles(draft?.project || '');
  }, [draft?.project, refetchProjectRoles]);

  // Re-fetch skills when the cwd changes: adds/removes skills of the
  // selected project (the API resolves them via `?cwd=`).
  useEffect(() => {
    const cwd = draft?.cwd;
    const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
    let cancelled = false;
    fetch(`/api/ui/skills${qs}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { skills: [] }))
      .then((j) => { if (!cancelled) setSkills(j.skills || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [draft?.cwd]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/ui/skill-weights', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Partial<SkillWeights> | null) => {
        if (!cancelled && j?.weights) setSkillWeights({ weights: j.weights });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Another agent's figure must not linger while this one's is on its way.
  useEffect(() => {
    setSkillsPreview(null);
    setExcludingSkill(null);
    setSkillExcludeError(null);
  }, [selected?.name]);

  // The daemon resolves the draft: only it knows the exclusions and the attachments
  // of every scope. Only on the tab that shows it, since it carries the system prompt.
  const previewBody = draft && tab === 'skills'
    ? JSON.stringify(skillsPreviewBody(selected?.name ?? null, draft, skillModes))
    : null;
  useEffect(() => {
    if (previewBody === null) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      fetch('/api/ui/skill-attachments/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: previewBody,
        signal: abort.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: unknown) => { if (!abort.signal.aborted) setSkillsPreview(parseSkillsPreview(j)); })
        .catch(() => { if (!abort.signal.aborted) setSkillsPreview(null); });
    }, PREVIEW_DEBOUNCE_MS);
    return () => { clearTimeout(timer); abort.abort(); };
    // `ownAttachments`: a save changes what the same draft resolves against.
  }, [previewBody, ownAttachments]);

  useEffect(() => {
    (async () => {
      const list = await fetchAll();
      // A late catalog response must never reset a new agent's typed fields.
      if (!wantsNew) {
        const initial = agentToOpen(agent, list);
        if (initial) await select(initial);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The host owns the overlay, so it is the one that must warn before
  // throwing away edits — it cannot read `dirty` from here.
  useEffect(() => { onDirtyChange?.(unsaved); }, [unsaved, onDirtyChange]);

  // Hex mirror of the agent color, for `<input type="color">`. Hook order
  // demands it sits above the early return, hence the optional draft.
  const colorInputHex = useHexColor(draft?.color || paletteFor(draft?.name || '?'));

  /** Reads the agent's attachments, then shows its attached skills as checked. */
  async function loadSkillState(name: string): Promise<SkillAttachment[]> {
    try {
      const [ar, rr] = await Promise.all([
        fetch(`/api/ui/skill-attachments?scope=agent&target=${encodeURIComponent(name)}`, { cache: 'no-store' }),
        fetch(`/api/ui/agents/${encodeURIComponent(name)}/skills`, { cache: 'no-store' }),
      ]);
      const own: SkillAttachment[] = ar.ok ? ((await ar.json()).attachments ?? []) : [];
      setOwnAttachments(own);
      setSkillModes(agentSkillModes(own));
      setInherited(rr.ok ? inheritedSkills((await rr.json()).skills ?? []) : []);
      setDraft((d) => (d ? { ...d, skills: checkedSkills(d.skills, own) } : d));
      return own;
    } catch {
      setOwnAttachments([]);
      setSkillModes({});
      setInherited([]);
      return [];
    }
  }

  /**
   * Makes the agent's attachments say what the Skills tab shows (after the
   * config is saved). Read again first: the save itself moves an old
   * `config.skills` into attachments, which the copy loaded with the editor lacks.
   */
  async function syncSkillAttachments(name: string, checked: string[]): Promise<void> {
    let own = ownAttachments;
    try {
      const r = await fetch(`/api/ui/skill-attachments?scope=agent&target=${encodeURIComponent(name)}`, { cache: 'no-store' });
      if (r.ok) own = (await r.json()).attachments ?? own;
    } catch { /* keep the copy loaded with the editor */ }
    const plan = attachmentSync(checked, skillModes, own);
    const failures: string[] = [];
    for (const a of plan.attach) {
      const r = await fetch('/api/ui/skill-attachments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skill: a.skill, scope: 'agent', target: name, mode: a.mode }),
      });
      if (!r.ok) failures.push(`${a.skill}: ${(await r.json().catch(() => ({}))).reason ?? r.statusText}`);
    }
    for (const id of plan.detach) {
      const r = await fetch(`/api/ui/skill-attachments/${id}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) failures.push(`#${id}: ${r.statusText}`);
    }
    if (failures.length) toast.error(t('editPage.skillAttachFailed', { error: failures.join('; ').slice(0, 140) }));
  }

  function setSkillMode(id: string, mode: SkillMode) {
    setSkillModes((m) => ({ ...m, [id]: mode }));
    setDirty(true);
  }

  async function excludeInheritedSkill(skill: string) {
    const name = selected?.name;
    if (!name || excludingSkill || saving) return;
    setExcludingSkill(skill);
    setSkillExcludeError(null);
    try {
      const r = await fetch('/api/ui/skill-attachments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(attachBody(skill, 'agent', name, 'exclude')),
      });
      const body: unknown = await r.json().catch(() => null);
      if (selectedName.current !== name) return;
      if (!r.ok) {
        const failure = attachFailure(r.status, body, { scope: 'agent', target: name });
        setSkillExcludeError(t(`skillAttach.error.${failure.key}`, failure.vars));
        return;
      }
      const row = body as SkillAttachment;
      setOwnAttachments((own) => [...own.filter((a) => a.skill !== skill), row]);
      setInherited((rows) => rows.filter((s) => s.id !== skill));
      // Invalidate the old total; the preview effect now reads the saved exclusion.
      // Preserve the other draft fields and modes, including unsaved edits.
      setSkillsPreview(null);
      setDraft((d) => d ? { ...d, skills: d.skills.filter((id) => id !== skill) } : d);
      toast.success(t('editPage.skillExcluded', { id: skill }));
    } catch {
      if (selectedName.current === name) setSkillExcludeError(t('skillAttach.error.network', { brand: BRAND.displayName }));
    } finally {
      if (selectedName.current === name) setExcludingSkill(null);
    }
  }

  async function openInheritedSkill(id: string) {
    // The modal traps focus above island popups: close it only after the
    // workspace accepted the skill, with the same discard guard as closing.
    if (onClose && unsaved && !(await confirmAction({ title: t('editPage.skillOpenDiscard'), confirmLabel: t('confirmDialog.discard'), destructive: true }))) return;
    if (openSkillIsland(id, 'preview', { source: 'timon' }, 'recipients') && onClose) {
      onDirtyChange?.(false);
      onClose();
    }
  }

  async function select(a: AgentSummary) {
    if (unsaved && !(await confirmAction({ title: t('confirmDialog.discardChanges'), confirmLabel: t('confirmDialog.discard'), destructive: true }))) return;
    const full = await fetchAgentDetails(a);
    setSelected(full);
    setDraft(toDraft(full, catalog));
    if (full.name) void loadSkillState(full.name);
    setDirty(false);
    setOrchestrationDirty(false);
    setOrchestrationEpoch((n) => n + 1);
    // Load every extra root .md (not system-prompt.md, which we already have).
    try {
      const lr = await fetch('/api/ui/agents/' + encodeURIComponent(a.name) + '/docs', {
        cache: 'no-store',
      });
      const j = lr.ok ? await lr.json() : { files: [] };
      const names = ((j.files || []) as Array<{ name: string }>)
        .map((f) => f.name)
        .filter((n) => n !== 'system-prompt.md');
      const entries = await Promise.all(
        names.map(async (n) => {
          const cr = await fetch(
            '/api/ui/agents/' + encodeURIComponent(a.name) + '/docs/' + encodeURIComponent(n),
            { cache: 'no-store' },
          );
          return [n, cr.ok ? await cr.text() : ''] as const;
        }),
      );
      setExtraDocs(Object.fromEntries(entries));
    } catch {
      setExtraDocs({});
    }
  }

  function autosaveDoc(agentName: string, file: string, body: string) {
    const key = agentName + '/' + file;
    if (docSaveTimers.current[key]) clearTimeout(docSaveTimers.current[key]);
    docSaveTimers.current[key] = setTimeout(async () => {
      try {
        const r = await fetch(
          '/api/ui/agents/' + encodeURIComponent(agentName) + '/docs/' + encodeURIComponent(file),
          {
            method: 'PUT',
            headers: { 'content-type': 'text/plain; charset=utf-8' },
            body,
          },
        );
        if (!r.ok) throw new Error('save failed: ' + r.status);
      } catch (e) {
        toast.error(String((e as Error).message || e));
      }
    }, 800);
  }

  /** Creates an identity doc from a starter text; false when it could not be created. */
  async function createDoc(name: string, template: string): Promise<boolean> {
    if (!selected?.name) {
      toast.error(t('identityDocs.saveFirst'));
      return false;
    }
    if (!/^[\w.-]+\.md$/.test(name)) {
      toast.error('Doc name must match [\\w.-]+\\.md');
      return false;
    }
    if (name.toLowerCase() === 'system-prompt.md' || Object.keys(extraDocs).some((n) => n.toLowerCase() === name.toLowerCase())) {
      toast.error('That doc already exists.');
      return false;
    }
    try {
      const r = await fetch(
        '/api/ui/agents/' + encodeURIComponent(selected.name) + '/docs/' + encodeURIComponent(name),
        {
          method: 'PUT',
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: template,
        },
      );
      if (!r.ok) throw new Error('create failed: ' + r.status);
      setExtraDocs((d) => ({ ...d, [name]: template }));
      return true;
    } catch (e) {
      toast.error(String((e as Error).message || e));
      return false;
    }
  }

  async function deleteDoc(name: string) {
    if (!selected?.name) return;
    if (!(await confirmAction({ title: t('confirmDialog.deleteDoc', { name }), confirmLabel: t('confirmDialog.delete'), destructive: true }))) return;
    try {
      const r = await fetch(
        '/api/ui/agents/' + encodeURIComponent(selected.name) + '/docs/' + encodeURIComponent(name),
        { method: 'DELETE' },
      );
      if (!r.ok) throw new Error('delete failed: ' + r.status);
      setExtraDocs((d) => {
        const next = { ...d };
        delete next[name];
        return next;
      });
    } catch (e) {
      toast.error(String((e as Error).message || e));
    }
  }

  /** Pins this agent on a kind of task for its project (or unpins it, with an
   *  empty name). The daemon refuses an agent whose cwd is not the project's —
   *  we surface its sentence rather than a generic failure. */
  async function pinProjectRole(type: string, agentName: string) {
    const slug = draft?.project?.trim();
    if (!slug) return;
    try {
      const r = await fetch(
        `/api/ui/projects/${encodeURIComponent(slug)}/roles/${encodeURIComponent(type)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent: agentName }),
        },
      );
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiErrorMessage(body, r.statusText));
      await refetchProjectRoles(slug);
      toast.success(agentName ? `${type} → ${agentName}` : `${type} unpinned`);
    } catch (e) {
      toast.error(String((e as Error).message || e).slice(0, 140));
    }
  }

  function updateDraft<K extends keyof Draft>(k: K, v: Draft[K]) {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
    setDirty(true);
  }

  function updateCwd(cwd: string) {
    setDraft((d) => d ? {
      ...d,
      cwd,
      project: !d.project || d.project === projectFromCwd(d.cwd)
        ? projectFromCwd(cwd) : d.project,
    } : d);
    setDirty(true);
  }

  async function browseCwd() {
    const picked = await directoryPicker.pick(draft?.cwd ?? '');
    if (picked.status === 'chosen') updateCwd(picked.path);
    else reportDirectoryPick(picked);
  }

  function toggleListItem(
    list: 'allowed' | 'denied' | 'skills' | 'mcpServers',
    item: string,
  ) {
    if (!draft) return;
    const cur = draft[list];
    const next = cur.includes(item) ? cur.filter((x) => x !== item) : [...cur, item];
    updateDraft(list, next);
  }

  /** Generic toggle for an MCP server. Externals (claude.ai) are enabled
   *  by default → flipped in excludedMcp (opt-out). Internals
   *  (TIMON-managed) are disabled by default → flipped in mcpServers
   *  (opt-in). Mirrors the same logic in chat-client.tsx toggleMcp(). */
  function toggleMcp(id: string) {
    if (!draft) return;
    const m = mcpServers.find((x) => x.id === id);
    const external = m?.source === 'claude_ai' || m?.transport_type === 'external';
    if (external) {
      const ex = draft.excludedMcp.includes(id)
        ? draft.excludedMcp.filter((x) => x !== id)
        : [...draft.excludedMcp, id];
      updateDraft('excludedMcp', ex);
    } else {
      const cur = draft.mcpServers.includes(id)
        ? draft.mcpServers.filter((x) => x !== id)
        : [...draft.mcpServers, id];
      updateDraft('mcpServers', cur);
    }
  }

  async function save() {
    if (!draft) return;
    if (!draft.name || !/^[A-Za-z0-9._-]+$/.test(draft.name)) {
      toast.error("Invalid name. Use letters, digits, '.', '_', '-'.");
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: draft.name,
        system_prompt: draft.systemPrompt,
        config: {
          cwd: draft.cwd || undefined,
          project: draft.project.trim() || undefined,
          browser_profile_id: draft.browserProfileId,
          // Only persist 'backend' when it deviates from the default to
          // keep config.json clean for the common case.
          backend: !draft.backend || draft.backend === catalog.defaultBackend ? undefined : draft.backend,
          model: draft.model || undefined,
          permission_mode: draft.mode || undefined,
          allowed_tools: draft.allowed.length ? draft.allowed : undefined,
          denied_tools: draft.denied.length ? draft.denied : undefined,
          // Checked skills are attachments (`syncSkillAttachments` below), never
          // `config.skills`: the daemon keeps the ones a save does not mention.
          mcp_servers: draft.mcpServers.length ? draft.mcpServers : undefined,
          excluded_mcp_servers: draft.excludedMcp.length ? draft.excludedMcp : undefined,
          emoji: draft.emoji.trim() || undefined,
          color: draft.color.trim() || undefined,
          icon_url: draft.iconUrl.trim() || undefined,
          // The picked head and the mascot's look. Absent, the daemon keeps
          // what is stored; every mode's setting is sent, so changing the head
          // never clears the others. A mascot picked without touching the
          // configurator is the one it showed: the role's default look.
          avatar: draft.avatar ?? undefined,
          look: draft.look ?? (draft.avatar === 'mascot' ? defaultLookFor(draft.role || 'coder') : undefined),
          // No agent without a role — the daemon applies the same default on
          // creation. The name is no longer read to guess one: an agent is a
          // reviewer because the field says so, whatever it is called.
          role: draft.role || 'coder',
          reasoningEffort: draft.reasoningEffort || undefined,
          global_context: draft.globalContext || undefined,
        },
      };
      // Rename: if the name changed, RENAME the agent (moves the folder +
      // updates DB/roles.json) BEFORE the upsert — otherwise the upsert would
      // create a clone under the new name and leave the old one behind
      // (rename = clone bug).
      if (selected?.name && selected.name !== draft.name) {
        const rr = await fetch('/api/ui/agents/' + encodeURIComponent(selected.name) + '/rename', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ newName: draft.name }),
        });
        if (!rr.ok) {
          const j = await rr.json().catch(() => ({}));
          throw new Error('rename failed: ' + (apiErrorMessage(j, rr.statusText)));
        }
        // Before the save below: the rename is done and stays done if that one fails.
        const followUps = renameFollowUps(await rr.json().catch(() => null));
        if (followUps.triggers.length) {
          toast.warning(t('agentsPage.renameTriggersToCheck', {
            old: selected.name, name: draft.name, count: followUps.triggers.length, names: followUps.triggers.join(', '),
          }), {
            duration: 20_000,
            action: { label: t('agentsPage.renameOpenTriggers'), onClick: () => window.location.assign(`${TRIGGERS_ROUTE}?tab=events`) },
          });
        }
        for (const warning of followUps.warnings) toast.warning(warning, { duration: 20_000 });
      }
      const r = await fetch('/api/ui/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      await syncSkillAttachments(draft.name, draft.skills);
      toast.success('Saved to ~/.timon/agents/' + draft.name + '/');
      announceAgentsChanged();
      const list = await fetchAll();
      const row = list.find((a) => a.name === draft.name);
      if (row) {
        // The list row carries no system_prompt content: rebuilding the draft
        // from it alone blanked the Identity box right after Save (TIM-0027).
        const fresh = await fetchAgentDetails(row);
        const shown = fresh.system_prompt == null ? { ...fresh, system_prompt: draft.systemPrompt } : fresh;
        setSelected(shown);
        setDraft(toDraft(shown, catalog));
        await loadSkillState(draft.name);
      }
      setDirty(false);
    } catch (e) {
      toast.error('Save failed: ' + String((e as Error).message || e).slice(0, 80));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selected?.name) return;
    if (!(await deleteAgentAfterConfirm(selected.name, { onRestored: fetchAll }))) return;
    // The host asks before discarding edits; there is nothing left to
    // discard once the agent is gone.
    if (onClose) { onDirtyChange?.(false); onClose(); return; }
    const list = await fetchAll();
    const next = list[0] || null;
    if (next) select(next);
    else {
      setSelected(null);
      setDraft(null);
    }
  }

  if (!draft || !selected) {
    return (
      <div className="grid h-full place-items-center text-[12.5px] text-muted-foreground">
        Loading…
      </div>
    );
  }

  const draftProject = projects.find((p) => p.slug === draft.project) ?? null;
  const draftIdentity = agentIdentity(
    {
      name: draft.name || '?',
      role: draft.role,
      emoji: draft.emoji,
      color: draft.color.trim() || null,
      icon_url: draft.iconUrl.trim() || null,
      look: draft.look ?? (draft.avatar === 'mascot' ? defaultLookFor(draft.role || 'coder') : null),
      avatar: draft.avatar,
    },
    draftProject ? { icon: draftProject.icon?.trim() || null, color: draftProject.color ?? null, name: draftProject.name ?? null } : null,
  );
  const tileBackground = draft.color.trim() || paletteFor(draft.name || '?');

  // Only Timon skills reach the prompt from here: project ones load natively
  // in a Claude Code agent only, the others never reach a mission.
  const checkedTimonSkills = draft.skills.filter((id) => skills.some((s) => s.id === id && s.source === 'timon'));

  return (
    <div ref={editorRoot} className="flex h-full min-h-0 flex-col">
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-center gap-4 px-6 py-4">
          {/* The head the agent shows everywhere, as the draft stands: it
              follows the mode picked in the Avatar tab, which a click opens. */}
          <button
            type="button"
            data-editor-avatar
            onClick={() => setTab('avatar')}
            title={t('editPage.changeAvatar')}
            aria-label={t('editPage.changeAvatar')}
            className="shrink-0 rounded-[var(--avatar-radius)] transition-transform hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AgentAvatar identity={draftIdentity} size="lg" roleBadge={false} />
          </button>
          <h1 className="m-0 min-w-0 truncate text-[18px] font-semibold">{draft.name || 'New agent'}</h1>
          <div className="ml-auto flex items-center gap-2">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label={t('common.close')}
                className="-mr-2 grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        </header>

        {/* The steps, as one centred island. Stacked in a single scroll, this
            form was unreadable — nobody ever created an agent from it. */}
        <div className="flex justify-center px-6 pb-3">
          <div
            role="tablist"
            aria-label={t('editPage.tabs.label')}
            className="inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1"
          >
            {AGENT_EDITOR_TABS.map((step) => (
              <button
                key={step}
                type="button"
                role="tab"
                data-tab={step}
                aria-selected={tab === step}
                onClick={() => setTab(step)}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-md px-3.5 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.1em] transition-all',
                  tab === step
                    ? 'bg-background text-foreground shadow'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`editPage.tabs.${step}`)}
              </button>
            ))}
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className={cn('mx-auto px-6 py-6', tab === 'injections' ? 'max-w-6xl' : tab === 'identity' || tab === 'avatar' ? 'max-w-5xl' : 'max-w-3xl')}>
            <TabPanel active={tab === 'avatar'}>
              <AvatarTab
                name={draft.name}
                role={draft.role}
                background={tileBackground}
                mode={shownAvatarMode(draft)}
                emoji={draft.emoji}
                iconUrl={draft.iconUrl}
                look={draft.look}
                onMode={(mode) => updateDraft('avatar', mode)}
                onEmoji={(emoji) => updateDraft('emoji', emoji)}
                onIconUrl={(url) => updateDraft('iconUrl', url)}
                onLook={(look) => updateDraft('look', look)}
              />
            </TabPanel>
            <TabPanel active={tab === 'identity'}>
              <FormRow label={t('editPage.name')} hint={t('editPage.nameHint')}>
                <Input
                  data-agent-editor-name
                  aria-label={t('editPage.name')}
                  
                  value={draft.name}
                  onChange={(e) => updateDraft('name', e.target.value)}
                />
              </FormRow>
              <FormRow label="Color" hint={t('editPage.colorHint')}>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={colorInputHex}
                    onChange={(e) => updateDraft('color', e.target.value)}
                    className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent"
                    title={t('editPage.colorTitle')}
                  />
                  <Input
                    /* code-font: hex colour value */ className="max-w-[140px] font-mono"
                    value={draft.color}
                    onChange={(e) => updateDraft('color', e.target.value)}
                    placeholder="auto"
                  />
                  {draft.color.trim() && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => updateDraft('color', '')}
                      title={t('editPage.colorAutoTitle')}
                    >
                      auto
                    </Button>
                  )}
                </div>
              </FormRow>
              <FormRow
                label="Role"
                hint="sets the icon, injects its default directives (shown in Injections) and suggests model + permission_mode"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={draft.role || '__none__'}
                    onValueChange={(v) => updateDraft('role', v === '__none__' ? '' : v)}
                  >
                    <SelectTrigger className="max-w-[280px]">
                      <SelectValue placeholder="(none)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">
                        (none)
                      </SelectItem>
                      {roles.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              className="grid size-3.5 place-items-center"
                              style={{ color: r.color }}
                              dangerouslySetInnerHTML={{
                                __html: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${r.iconSvg}</svg>`,
                              }}
                            />
                            {r.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {draft.role && (() => {
                    const r = roles.find((x) => x.id === draft.role);
                    if (!r) return null;
                    const modelMismatch = draft.model !== r.default_model;
                    const modeMismatch = draft.mode !== r.default_permission_mode;
                    if (!modelMismatch && !modeMismatch) return null;
                    return (
                      <button
                        type="button"
                        onClick={() => {
                          setDraft((d) =>
                            d
                              ? { ...d, model: r.default_model, mode: r.default_permission_mode }
                              : d,
                          );
                          setDirty(true);
                        }}
                        className="rounded-md border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                        title={`suggested model: ${r.default_model} · permission_mode: ${r.default_permission_mode}`}
                      >
                        apply suggestions ({r.default_model} / {r.default_permission_mode})
                      </button>
                    );
                  })()}
                  <RoleManager roles={roles} onChanged={refetchRoles} />
                </div>
              </FormRow>
              <div className="flex flex-col gap-2">
                <h2 className="text-[13px] font-semibold">Identity docs</h2>
                <p className="text-[11.5px] text-muted-foreground">{t('identityDocs.intro')}</p>
                <IdentityDocs
                  agent={selected?.name || null}
                  systemPrompt={draft.systemPrompt}
                  onSystemPrompt={(v) => updateDraft('systemPrompt', v)}
                  docs={extraDocs}
                  onDoc={(name, v) => {
                    setExtraDocs((d) => ({ ...d, [name]: v }));
                    if (selected?.name) autosaveDoc(selected.name, name, v);
                  }}
                  onCreate={createDoc}
                  onDelete={deleteDoc}
                />
              </div>
            </TabPanel>

            {/* The pair is an attribute of the agent, not a step of its
                personality — hence its own tab, with the billing copy its
                backend declares. */}
            <TabPanel active={tab === 'llm'}>
              <FormRow label={t('editPage.llmLabel')} hint={t('editPage.llmHint')}>
                {/* No `inherit` entry: an agent always runs on one pair. A
                    pinned account that is gone stays shown, selected and
                    disabled — never swapped for another one behind the
                    user's back. */}
                <ModelPickerPanel
                  className="h-[420px]"
                  value={modelPick}
                  // A new agent has no name a grant could hold yet.
                  target={{ project: draft.project, agent: wantsNew ? null : draft.name }}
                  onChange={(picked) => {
                    if (!picked) return;
                    const values = thinkingValues(thinkingBarFor(catalog, picked.backend, picked.model));
                    setDraft((d) => (d ? { ...d, backend: picked.backend, model: picked.model, reasoningEffort: keepEffort(d.reasoningEffort, values) } : d));
                    setDirty(true);
                  }}
                />
                {/* What this agent's backend cannot do, on the agent's own
                    sheet: a remote agent takes no code task and no files. */}
                <BackendLimitsBadge catalog={catalog} backend={draftBackend} className="mt-2" />
              </FormRow>
              <FormRow label={t('thinking.label')} hint={t('thinking.hint')}>
                <ThinkingSlider
                  bar={thinkingBarFor(catalog, draftBackend, draft.model)}
                  value={draft.reasoningEffort}
                  onChange={(effort) => updateDraft('reasoningEffort', effort)}
                />
              </FormRow>
              {/* Billing copy: DECLARED by the backend profile (catalog), not
                  derived from its id. A provider without a phrase shows
                  nothing — better than another provider's copy. */}
              {subscription && (
                <FormRow label={t('editPage.subscription')}>
                  <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-3 text-[11.5px] text-muted-foreground">
                    {subscription.note}
                  </div>
                </FormRow>
              )}
            </TabPanel>

            {/* Where the agent works: the directory its tools see, the
                project it is grouped under, the browser profile it drives. */}
            <TabPanel active={tab === 'workspace'}>
              <FormRow label="Working directory" hint="cwd for tool calls">
                <div className="flex gap-1.5">
                  <Input
                    /* code-font: file path */ className="font-mono"
                    value={draft.cwd}
                    onChange={(e) => updateCwd(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    onClick={() => void browseCwd()}
                  >
                    Browse…
                  </Button>
                  {directoryPicker.dialog}
                </div>
              </FormRow>
              <FormRow
                label="Project"
                hint="groups agents across the UI; auto-derived from cwd but you can override"
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={draft.project || '__none__'}
                    onValueChange={(v) => updateDraft('project', v === '__none__' ? '' : v)}
                  >
                    <SelectTrigger className="max-w-[240px]">
                      <SelectValue placeholder="(none)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">
                        (none)
                      </SelectItem>
                      {draft.project && !projects.some((p) => p.slug === draft.project) && (
                        <SelectItem value={draft.project} className="text-muted-foreground">
                          {t('editPage.projectUnregistered', { project: draft.project })}
                        </SelectItem>
                      )}
                      {projects.map((p) => (
                        <SelectItem key={p.slug} value={p.slug}>
                          {p.slug}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {draft.project ? (
                    <ProjectBadge project={draft.project} size="md" />
                  ) : (
                    <span className="text-[11.5px] text-muted-foreground/70">
                      orphan agent — won't be grouped
                    </span>
                  )}
                </div>
              </FormRow>
              <FormRow label={t('browserPanel.native.profile')} hint={t('browserPanel.native.profileHint')}>
                <BrowserProfileSelect value={draft.browserProfileId} onChange={(value) => updateDraft('browserProfileId', value)} />
              </FormRow>
              <FormRow
                label="Project tasks"
                hint="who runs each kind of task on this agent's project — by role, not by name"
              >
                {!draft.project ? (
                  <p className="text-[11.5px] text-muted-foreground/70">
                    No project on this agent — nothing to dispatch to it.
                  </p>
                ) : projectRoles === null ? (
                  <p className="text-[11.5px] text-muted-foreground/70">Loading…</p>
                ) : (
                  <div className="rounded-lg border border-border bg-muted/20 p-1.5">
                    {PROJECT_TASK_TYPES.map((type) => {
                      const row = projectRoles[type];
                      if (!row) return null;
                      const mine = row.agent === draft.name;
                      return (
                        <div
                          key={type}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11.5px]"
                        >
                          <span className="w-16 shrink-0 text-muted-foreground">{type}</span>
                          <span className={cn('min-w-0 flex-1 truncate', mine && 'text-primary')}>
                            {row.agent}
                          </span>
                          {/* Where the answer comes from. `convention` is the
                              only one that says "nobody holds this role yet —
                              this agent will be created on the first task". */}
                          <span
                            className="shrink-0 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground"
                            title={
                              row.source === 'pinned'
                                ? 'pinned in the project roles'
                                : row.source === 'role'
                                  ? 'carries the role'
                                  : 'nobody holds this role — will be created on the first task'
                            }
                          >
                            {row.source}
                          </span>
                          {mine && row.source === 'pinned' ? (
                            <button
                              type="button"
                              onClick={() => pinProjectRole(type, '')}
                              className="shrink-0 text-[10.5px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                            >
                              unpin
                            </button>
                          ) : mine ? null : (
                            <button
                              type="button"
                              onClick={() => pinProjectRole(type, draft.name)}
                              disabled={!selected?.name || dirty}
                              title={
                                dirty
                                  ? 'Save the agent first'
                                  : `Send ${type} tasks of ${draft.project} to ${draft.name}`
                              }
                              className="shrink-0 text-[10.5px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground disabled:opacity-40 disabled:no-underline"
                            >
                              assign here
                            </button>
                          )}
                        </div>
                      );
                    })}
                    <p className="px-2 pb-0.5 pt-1 text-[10.5px] text-muted-foreground/70">
                      Give this agent the matching role and it is picked up
                      automatically, whatever its name. Pin only to settle a tie
                      between two agents of the same role.
                    </p>
                  </div>
                )}
              </FormRow>
              <FormRow label="Global context">
                <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-3.5 py-3">
                  <Switch
                    checked={draft.globalContext}
                    onCheckedChange={(v) => updateDraft('globalContext', v)}
                  />
                  <div className="leading-tight">
                    <div className="text-[13px] font-medium">Inject cross-project digest</div>
                    <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                      adds your hottest projects + objectives to the system prompt at spawn.
                      Enable for <code>_main</code> and standalone “life” agents that orchestrate
                      priorities across projects.
                    </div>
                  </div>
                </label>
              </FormRow>
            </TabPanel>

            <TabPanel active={tab === 'permissions'}>
              {/* What `Mode` actually produces depends on the CLI: per-card
                  arbitration, or a sandbox level fixed at launch. We read the
                  backend's CAPABILITY — the same word doesn't have the same
                  effect everywhere, and staying silent implied otherwise. */}
              {ownPermissions && (
                <SelfPermissionsBadge
                  label={t('editPage.permissionsSelfBadge')}
                  hint={t('editPage.permissionsSelfBadgeHint')}
                  className="mb-2"
                />
              )}
              {permissionHint && !ownPermissions && (
                <p className="mb-3 text-[12px] text-muted-foreground">{permissionHint}</p>
              )}
              <FormRow label="Mode">
                <PermissionModeField
                  value={draft.mode}
                  onChange={(m) => updateDraft('mode', m)}
                  ignored={ownPermissions}
                />
              </FormRow>
              <FormRow label="Allowed tools" hint="green-list — agent can call">
                <ChipsInput
                  values={draft.allowed}
                  onChange={(v) => updateDraft('allowed', v)}
                  tone="allow"
                />
              </FormRow>
              <FormRow label="Denied tools" hint="red-list — never call">
                <ChipsInput
                  values={draft.denied}
                  onChange={(v) => updateDraft('denied', v)}
                  tone="deny"
                />
              </FormRow>
              {selected?.name && (
                <FormRow label={t('agentApprovals.title')} hint={t('agentApprovals.hint')}>
                  <AgentApprovals key={selected.name} agentName={selected.name} />
                </FormRow>
              )}
            </TabPanel>

            <TabPanel active={tab === 'skills'}>
              <p className="mb-3 text-[12px] text-muted-foreground">{t('editPage.skillsIntro')}</p>
              {!readsOnDemand && (
                <p className="mb-3 rounded-md bg-muted/30 px-2.5 py-2 text-[12px] text-foreground" data-testid="skills-whole-only">
                  {t('editPage.skillsWholeOnly', { brand: BRAND.displayName })}
                </p>
              )}
              {skills.length > 0 && skillsPreview && <SpawnContext preview={skillsPreview} />}
              {skills.length === 0 ? (
                <p className="text-[11.5px] text-muted-foreground/70">
                  No skills installed yet — create some from{' '}
                  <Link href="/skills" className="text-primary">
                    /skills
                  </Link>
                  .
                </p>
              ) : (
                <div className="space-y-3">
                  {EDIT_SKILL_SECTIONS.map((sec) => {
                    const items = skills.filter((s) => s.source === sec.source && !s.shadowed);
                    if (items.length === 0) return null;
                    return (
                      <div key={sec.source}>
                        <div className="mb-1.5 flex items-baseline gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground">
                            {t(sec.label)}
                          </span>
                          <span className="text-[10.5px] text-muted-foreground/60">{t(sec.hint)}</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {items.map((s) => {
                            const timon = s.source === 'timon';
                            const on = timon && draft.skills.includes(s.id);
                            // Unchecked, a box weighs what checking it would add: a catalogue line.
                            const weight = timon ? shownWeights?.weights[s.id]?.[!readsOnDemand ? 'import' : on ? (skillModes[s.id] ?? 'include') : 'include'] : undefined;
                            return (
                              <button
                                key={s.source + ':' + s.id}
                                type="button"
                                onClick={() => timon && toggleListItem('skills', s.id)}
                                title={timon
                                  ? t('editPage.skillAttachable')
                                  : s.source === 'project'
                                    ? t('editPage.skillNativeOnly')
                                    : t('skillMission.notAttachable', { brand: BRAND.displayName })}
                                className={cn(
                                  'rounded-md border px-2.5 py-1 text-[11.5px] transition-colors',
                                  on
                                    ? 'border-primary bg-primary/15 text-primary'
                                    : timon
                                      ? 'border-border bg-muted/40 text-muted-foreground hover:text-foreground'
                                      : 'cursor-default border-dashed border-border/70 bg-transparent text-muted-foreground/70',
                                )}
                              >
                                /{s.id}
                                {weight !== undefined && (
                                  <span className="ml-1.5 tabular-nums opacity-70" title={t('editPage.skillWeightHint')}>
                                    {t('editPage.skillWeightShort', { n: formatTokens(weight) })}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  <SkillModeList
                    checked={checkedTimonSkills}
                    modes={skillModes}
                    weights={shownWeights}
                    readsOnDemand={readsOnDemand}
                    excluded={skillsPreview?.excluded ?? []}
                    onChange={setSkillMode}
                  />
                  <InheritedSkills
                    skills={skillsPreview ? inheritedSkills(skillsPreview.skills) : effectiveSkills(inherited, readsOnDemand)}
                    weights={shownWeights}
                    readsOnDemand={readsOnDemand}
                    saved={Boolean(selected?.name)}
                    busy={excludingSkill !== null || saving}
                    excluding={excludingSkill}
                    error={skillExcludeError}
                    onOpen={openInheritedSkill}
                    onExclude={excludeInheritedSkill}
                  />
                </div>
              )}
            </TabPanel>

            <TabPanel active={tab === 'orchestration'}>
              <OrchestrationSection
                key={orchestrationEpoch}
                onDirtyChange={setOrchestrationDirty}
                agent={selected?.name ? selected : null}
                roster={agents}
                teams={teams}
                projects={projects}
                onSaved={(saved) => {
                  setSelected((prev) => (prev ? { ...prev, ...saved } : prev));
                  toast.success(t('orchestration.saved'));
                  announceAgentsChanged();
                }}
              />
            </TabPanel>

            <TabPanel active={tab === 'mcp'}>
              <div className="flex flex-col gap-1.5 rounded-md bg-muted/40 px-3 py-2.5">
                <p className="text-[12px] font-medium text-foreground">
                  {t('editPage.mcpBuiltinTitle')}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {BUILTIN_MCP_SERVERS.map((s) => (
                    <span
                      key={s.key}
                      title={t(s.hintKey)}
                      className="rounded-md bg-primary/10 px-2.5 py-1 text-[11.5px] text-primary"
                    >
                      {s.key}
                    </span>
                  ))}
                </div>
                <p className="text-[11.5px] text-muted-foreground">
                  {t('editPage.mcpBuiltinHint')}
                </p>
              </div>
              <p className="text-[12px] text-muted-foreground">
                {t('editPage.mcpIntro')}{' '}
                <Link href="/mcp" className="text-primary">
                  /mcp
                </Link>
                .
              </p>
              {mcpServers.length === 0 ? (
                <p className="text-[11.5px] text-muted-foreground/70">
                  {t('editPage.mcpEmpty')}{' '}
                  <Link href="/mcp" className="text-primary">
                    /mcp
                  </Link>
                  .
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {mcpServers.map((s) => {
                    const external = s.source === 'claude_ai' || s.transport_type === 'external';
                    // Externals: ON = not in excludedMcp. Internals: ON = in mcpServers.
                    const on = external
                      ? !draft.excludedMcp.includes(s.id)
                      : draft.mcpServers.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => toggleMcp(s.id)}
                        title={`${s.transport_type} · ${s.tools_count} tool${s.tools_count === 1 ? '' : 's'}`}
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-[11.5px] transition-colors',
                          on
                            ? 'border-primary bg-primary/15 text-primary'
                            : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {s.name || s.id}
                        <span className="ml-1.5 text-[10px] opacity-70">
                          ({s.tools_count})
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </TabPanel>

            <TabPanel active={tab === 'injections'}>
              {wantsNew || !selected?.name
                ? <p className="text-sm text-muted-foreground">{t('agentInjections.notCreated')}</p>
                : <AgentInjectionsTab agent={selected.name} />}
            </TabPanel>
          </div>
        </ScrollArea>

        <footer className="flex items-center gap-2 bg-muted/40 px-6 py-3">
          <Button
            variant="outline"
            onClick={remove}
            className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Delete
          </Button>
          <div className="flex-1" />
          <Button onClick={save} disabled={saving || excludingSkill !== null} className="font-semibold">
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </footer>
      </main>

    </div>
  );
}

/** The servers every dialect registers by itself (`INJECTED_MCP_SERVERS`,
 *  orchestrator/src/injected-mcp.ts). `/api/ui/mcp` hides them, so without
 *  this row the tab read as if `timon` could not be granted (TIM-0102). */
const BUILTIN_MCP_SERVERS: ReadonlyArray<{ key: string; hintKey: string }> = [
  { key: 'timon', hintKey: 'editPage.mcpBuiltinTimon' },
  { key: 'timon_ask', hintKey: 'editPage.mcpBuiltinAsk' },
  { key: 'timon-browser', hintKey: 'editPage.mcpBuiltinBrowser' },
  { key: 'grepai', hintKey: 'editPage.mcpBuiltinGrepai' },
];

/** One step of the form. Only the active one is mounted: an inactive panel
 *  kept in the DOM would still autofocus and still be tab-reachable. */
function TabPanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  if (!active) return null;
  return <section role="tabpanel" className="flex flex-col gap-4">{children}</section>;
}

function FormRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-[180px_1fr]">
      <div className="leading-tight">
        <div className="text-[12.5px] font-semibold">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-muted-foreground/80">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function ChipsInput({
  values,
  onChange,
  tone,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  tone: 'allow' | 'deny';
}) {
  const [text, setText] = useState('');
  function commit() {
    const v = text.trim();
    if (!v) return;
    if (!values.includes(v)) onChange([...values, v]);
    setText('');
  }
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/30 p-2',
        tone === 'deny' ? 'border-destructive/30' : 'border-border',
      )}
    >
      {values.map((v) => (
        <span
          key={v}
          className={cn(
            /* code-font: tool permission pattern */ 'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11.5px]',
            tone === 'deny'
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]',
          )}
        >
          {v}
          <button
            type="button"
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="text-muted-foreground hover:text-foreground"
            aria-label="remove"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Backspace' && !text && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        placeholder="Add tool…  ↵"
        className="min-w-[140px] flex-1 border-0 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/70"
      />
    </div>
  );
}

/**
 * The context a spawn of this agent carries once the draft is saved, as the
 * daemon resolves it. A new agent has no prompt yet, so only its skills are weighed.
 */
function SpawnContext({ preview }: { preview: SkillsPreview }) {
  const saved = preview.prompt_tokens !== null;
  return (
    <div className="mb-3 flex flex-col gap-0.5 rounded-md bg-muted/30 px-2.5 py-2" aria-live="polite">
      <p className="flex items-baseline justify-between gap-3 text-[12px] text-foreground">
        <span>{t(saved ? 'editPage.spawnContext' : 'editPage.spawnContextSkills')}</span>
        <span className="tabular-nums" data-testid="spawn-context-total">
          {t('agentInjections.tokens', { n: formatTokens(preview.prompt_tokens ?? preview.skills_tokens) })}
        </span>
      </p>
      {saved && (
        <p className="text-[11px] text-muted-foreground">
          {t('editPage.spawnContextSkillsPart', { n: formatTokens(preview.skills_tokens) })}
        </p>
      )}
      {preview.on_demand_tokens > 0 && (
        <p className="text-[11px] text-muted-foreground/80">{t('editPage.spawnContextOnDemand', { n: formatTokens(preview.on_demand_tokens) })}</p>
      )}
      {preview.excluded.length > 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="spawn-context-excluded">
          {t('editPage.spawnContextExcluded', { skills: preview.excluded.map((id) => `/${id}`).join(', ') })}
        </p>
      )}
    </div>
  );
}

/**
 * Catalogue or Import, per checked skill, with what each choice weighs. On a
 * backend that cannot read a skill on demand the choice is out of its hands: it
 * shows what is sent and cannot be changed, and the saved mode is left alone.
 */
function SkillModeList({ checked, modes, weights, readsOnDemand, excluded, onChange }: {
  checked: string[];
  modes: Record<string, SkillMode>;
  weights: SkillWeights | null;
  readsOnDemand: boolean;
  /** Checked but kept out by the agent's own exclusion: they weigh nothing. */
  excluded: string[];
  onChange: (id: string, mode: SkillMode) => void;
}) {
  if (checked.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground">
        {t('editPage.skillsChecked')}
      </div>
      <ul className="flex flex-col gap-1">
        {checked.map((id) => {
          const mode = readsOnDemand ? (modes[id] ?? 'include') : 'import';
          const w = excluded.includes(id) ? undefined : weights?.weights[id];
          const leftOut = readsOnDemand ? [] : (w?.left_out ?? []);
          return (
            <li key={id} className="rounded-md bg-muted/30 px-2.5 py-1.5">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[12px] text-foreground">/{id}</span>
                {w && (
                  <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground" data-testid={`skill-weight-${id}`}>
                    {t('agentInjections.tokens', { n: formatTokens(w[mode]) })}
                    {mode === 'include' && ` · ${t('editPage.skillOnDemand', { n: formatTokens(w.on_demand) })}`}
                  </span>
                )}
                <div role="group" aria-label={t('editPage.skillModeLabel', { id })} className="flex shrink-0 gap-0.5 rounded-full bg-muted p-0.5">
                {(['include', 'import'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    disabled={!readsOnDemand}
                    title={readsOnDemand ? t(m === 'include' ? 'editPage.skillModeIncludeHint' : 'editPage.skillModeImportHint') : undefined}
                    onClick={() => onChange(id, m)}
                    className={cn(
                      'rounded-full px-2.5 py-0.5 text-[11px] transition-colors disabled:cursor-default',
                      mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground disabled:opacity-60 disabled:hover:text-muted-foreground',
                    )}
                  >
                    {t(m === 'include' ? 'editPage.skillModeInclude' : 'editPage.skillModeImport')}
                  </button>
                ))}
                </div>
              </div>
              {leftOut.length > 0 && (
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400" data-testid={`skill-left-out-${id}`}>
                  {t('editPage.skillFilesLeftOut', { n: leftOut.length, files: leftOut.join(', ') })}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Skills a wider scope gives the agent, with a link to their recipients and a local exclusion. */
function InheritedSkills({ skills, weights, readsOnDemand, saved, busy, excluding, error, onOpen, onExclude }: {
  skills: ResolvedSkill[];
  weights: SkillWeights | null;
  readsOnDemand: boolean;
  saved: boolean;
  busy: boolean;
  excluding: string | null;
  error: string | null;
  onOpen: (id: string) => void;
  onExclude: (id: string) => Promise<void>;
}) {
  // The exclusion is an agent-scope attachment: its route needs agents:manage.
  const manage = useAccess('agents:manage');
  if (skills.length === 0 && !error) return null;
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground">{t('editPage.skillsInherited')}</span>
        <span className="text-[11px] text-muted-foreground">{t('editPage.skillsInheritedHint')}</span>
      </div>
      <ul className="space-y-1.5">
        {skills.map((s) => {
          const leftOut = readsOnDemand ? [] : (weights?.weights[s.id]?.left_out ?? []);
          return (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/30 px-2.5 py-1.5 text-[11.5px]">
              <button
                type="button"
                onClick={() => onOpen(s.id)}
                disabled={busy}
                aria-label={t('editPage.skillOpenRecipients', { id: s.id })}
                className="min-w-0 flex-1 rounded-sm text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <span className="break-all underline decoration-muted-foreground/40 underline-offset-2">/{s.id}</span>{' '}
                <span className="text-muted-foreground">
                  {t('editPage.skillInheritedFrom', { mode: t(`agentInjections.skillMode.${s.mode}`), via: t(`agentInjections.skillVia.${s.via}`) })}
                  {weights?.weights[s.id] && <span className="tabular-nums"> · {t('agentInjections.tokens', { n: formatTokens(weights.weights[s.id]![s.mode]) })}</span>}
                </span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 px-2 text-[11.5px]"
                disabled={!saved || busy || !manage.allowed}
                title={manage.denied ?? (saved ? t('editPage.skillExcludeHint') : t('editPage.skillExcludeSaveFirst'))}
                aria-label={t('editPage.skillExcludeLabel', { id: s.id })}
                onClick={() => void onExclude(s.id)}
              >
                {t(excluding === s.id ? 'editPage.skillExcluding' : 'editPage.skillExclude')}
              </Button>
              {leftOut.length > 0 && (
                <p className="w-full text-[11px] text-amber-600 dark:text-amber-400" data-testid={`skill-left-out-${s.id}`}>
                  {t('editPage.skillFilesLeftOut', { n: leftOut.length, files: leftOut.join(', ') })}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p role="alert" className="mt-1.5 text-[11.5px] text-destructive">{error}</p>}
    </div>
  );
}
