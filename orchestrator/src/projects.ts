import { installedProfiles } from './backends/registry.js';
/**
 * Project metadata (agent roles per project, etc.) persisted under
 * ~/.timon/projects/<slug>/.
 *
 * Each role now carries a triplet `{ agent, model?, permission_mode? }`
 * instead of a mere `agent`. The dispatcher applies these overrides at
 * spawn time → the role becomes the source of truth for "who +
 * which model + which permission posture" on this project. The legacy
 * format is supported on read (string → { agent }); it is rewritten as an
 * object on each save.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECTS_DIR, projectDir, projectRolesFile, projectMetaFile, projectMemoryDir, projectMemoryFile } from './paths.js';
import { asBackendName, type BackendName } from './backends/index.js';
import { dbApi, type ProjectRow } from './db.js';
import { isServedIconUrl } from './uploads.js';
import type { TaskRole } from './plugins/contract/projects.js';
export type { TaskRole } from './plugins/contract/projects.js';

export type RoleSpec = {
  agent: string;
  /** LLM backend (`claude` | `codex`). Overrides the agent's `cfg.backend` at
   *  spawn → allows "code on Claude, review on Codex" by default without touching
   *  the agent config. NULL/absent = backend of the agent config. */
  backend?: BackendName | null;
  /** LLM model slug. Prefer an alias (`opus`/`sonnet` → follows the latest
   *  version) or a full slug (`gpt-5.5`).
   *  Overrides the agent's `cfg.model` at spawn. NULL/absent = agent config.
   *  Must be consistent with `backend` (see the anti-mismatch guard on the dispatcher side). */
  model?: string | null;
  /** `default` | `acceptEdits` | `bypassPermissions` | etc. Overrides the
   *  agent's `cfg.permission_mode` at spawn. */
  permission_mode?: string | null;
  /** Explicit list of MCP server ids allowed for this role.
   *  Merged with task.extra_mcp_servers at spawn — the resulting set
   *  replaces the agent's cfg.mcp_servers (zero MCP if both are empty). */
  mcp_servers?: string[] | null;
};

export type ProjectRoles = Partial<Record<TaskRole, RoleSpec>>;

const SLUG_RE = /^[A-Za-z0-9._-]{1,64}$/;

function validSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid project slug: "${slug}"`);
}

/** Normalises a value read from the JSON into a RoleSpec.
 *  - string → { agent }  (legacy v1 format)
 *  - object → agent/model/permission_mode kept, the rest filtered
 *  - other → null (corrupted entry ignored) */
function normalizeSpec(v: unknown): RoleSpec | null {
  if (typeof v === 'string' && v) return { agent: v };
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.agent !== 'string' || !o.agent) return null;
    const spec: RoleSpec = { agent: o.agent };
    const backend = asBackendName(o.backend) ?? installedProfiles().find((profile) => profile.id === o.backend)?.id;
    if (backend) spec.backend = backend;
    if (typeof o.model === 'string' && o.model) spec.model = o.model;
    if (typeof o.permission_mode === 'string' && o.permission_mode) {
      spec.permission_mode = o.permission_mode;
    }
    if (Array.isArray(o.mcp_servers)) {
      spec.mcp_servers = (o.mcp_servers as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      );
    }
    return spec;
  }
  return null;
}

export function readRoles(slug: string): ProjectRoles {
  validSlug(slug);
  const path = projectRolesFile(slug);
  if (!existsSync(path)) return {};
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return {};
    const out: ProjectRoles = {};
    for (const [role, raw] of Object.entries(j)) {
      const spec = normalizeSpec(raw);
      if (spec) out[role as TaskRole] = spec;
    }
    return out;
  } catch { /* corrupted JSON → treated as missing */ }
  return {};
}

export function writeRoles(slug: string, roles: ProjectRoles): ProjectRoles {
  validSlug(slug);
  mkdirSync(projectDir(slug), { recursive: true });
  writeFileSync(projectRolesFile(slug), JSON.stringify(roles, null, 2));
  return roles;
}

export function setRole(slug: string, role: TaskRole, spec: RoleSpec | null): ProjectRoles {
  const current = readRoles(slug);
  if (spec === null || !spec.agent) delete current[role];
  else current[role] = spec;
  return writeRoles(slug, current);
}

/** Project visuals and identity, persisted in `~/.timon/projects/<slug>/meta.json`.
 *  `workspace` is a free tag (e.g. "perso", "vibe", "clients") that filters
 *  the canvas display only — Kanban / Stats / Missions stay
 *  global. `name` / `cwd` / `speech` complete the project identity
 *  (display label, root working directory, short description). */
export type ProjectMeta = {
  /** Human display name. Falls back on the slug if absent. */
  name?: string | null;
  /** Signature colour (hex `#RRGGBB`). If absent, derived from the name at render. */
  color?: string | null;
  /** Emoji or short code (e.g. "🚀", "PK"), or an image served by Timon
   *  (`/api/uploads/projects/…`) — see `isProjectIcon`. Shown as the central
   *  glyph on the project's node; falls back on the initials otherwise. */
  icon?: string | null;
  workspace?: string | null;
  /** Root working directory of the project (absolute host path). Used
   *  as the default `cwd` when an agent is created under this project. */
  cwd?: string | null;
  /** Short description / explanatory speech. Shown on the project page
   *  and serves as possible context to paste into the agents' system prompt. */
  speech?: string | null;
  /** Project type (manual): 'client' | 'perso'. Serves the global digest
   *  (posture of the business agent) and the hot/cold sort. */
  kind?: string | null;
  /** Status (manual): 'active' | 'paused' | 'done' | 'archived'. A non-active
   *  project leaves the digest of hot projects. */
  status?: string | null;
  /** Last activity (epoch ms). READ-ONLY — automatic, touched on
   *  mission_complete. Ignored by writeMeta. */
  last_activity?: number | null;
  /** Supervision intent of the grepai index: 'auto' (default, null included)
   *  → reconciliation relaunches the dead watcher; 'off' → deliberate stop,
   *  it is not relaunched any more. Set by the /api/grepai/:slug/start|stop routes,
   *  not by the project form. */
  grepai_watch?: string | null;
};

/** Hex colour derived from a text (slug or name). HSL → hex, stable hue
 *  by hash 31, fixed saturation/lightness to stay readable on dark
 *  as on light. Serves as the default when `meta.color` is absent.
 *  Algorithm identical to the UI's `ProjectBadge` `hueFor` so that the derivation
 *  stays consistent even when the DB has no value. */
export function autoColorFor(input: string): string {
  let h = 0;
  for (const ch of input) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return hslToHex(hue, 65, 55);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Longest emoji or short code a project icon may be: a ZWJ emoji sequence
 *  with skin tones fits, a sentence does not. */
export const PROJECT_ICON_TEXT_MAX = 32;

/** A scheme (`https:`, `data:`, `javascript:`) or a path (`/x`, `//host`, `\\x`). */
const URL_LIKE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|[/\\])/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** What a project's `icon` may hold: a picture this daemon serves, or an
 *  emoji / short code drawn as text. Any web address is out: the window CSP
 *  (`img-src 'self' data: blob:`) blocks other origins — an image request is
 *  also a way out for data — so it would be stored only to never show. Same
 *  rule as an agent's `icon_url` (#586), plus the text form. The empty string
 *  is the "no logo" a form sends. */
export function isProjectIcon(icon: unknown): icon is string {
  return typeof icon === 'string' && (isIconText(icon) || isServedIconUrl(icon));
}

function isIconText(text: string): boolean {
  return text.length <= PROJECT_ICON_TEXT_MAX && !URL_LIKE.test(text.trim()) && !CONTROL_CHARS.test(text);
}

/** What the API exposes of a stored icon: a value set before the rule above
 *  (an http(s) logo) reads as no icon, so the UI shows the initials and an
 *  edit round-trip does not send it back to be refused. */
export function projectIcon(icon: string | null | undefined): string | null {
  return isProjectIcon(icon) ? icon : null;
}

function rowToMeta(row: ProjectRow): ProjectMeta {
  return {
    name: row.name, color: row.color, icon: projectIcon(row.icon), workspace: row.workspace,
    cwd: row.cwd, speech: row.speech, kind: row.kind, status: row.status,
    last_activity: row.last_activity, grepai_watch: row.grepai_watch,
  };
}

/** Legacy read of meta.json (transition + backfill). Null if missing/corrupted. */
export function readMetaFile(slug: string): ProjectMeta | null {
  const path = projectMetaFile(slug);
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return null;
    const out: ProjectMeta = {};
    if (typeof j.name === 'string' && j.name) out.name = j.name;
    if (typeof j.color === 'string' && j.color) out.color = j.color;
    if (typeof j.icon === 'string' && j.icon) out.icon = j.icon;
    if (typeof j.workspace === 'string' && j.workspace) out.workspace = j.workspace;
    if (typeof j.cwd === 'string' && j.cwd) out.cwd = j.cwd;
    if (typeof j.speech === 'string' && j.speech) out.speech = j.speech;
    if (typeof j.kind === 'string' && j.kind) out.kind = j.kind;
    if (typeof j.status === 'string' && j.status) out.status = j.status;
    return out;
  } catch { /* corrupted JSON → treated as missing */ }
  return null;
}

/** Project meta (DB). Transition fallback: if not migrated yet, reads the
 *  meta.json, persists it in the DB, and returns the result. */
export function readMeta(slug: string): ProjectMeta {
  validSlug(slug);
  const row = dbApi.getProjectRow(slug);
  if (row) return rowToMeta(row);
  const legacy = readMetaFile(slug);
  if (legacy && Object.keys(legacy).length) return writeMeta(slug, legacy);
  return {};
}

/** Upserts meta into the DB. `last_activity` is ignored (automatic). Auto-color kept.
 *  Only the fields PRESENT in `meta` are written (merge). `kind` nullable
 *  (clearable); `status` NOT NULL → an empty string falls back on 'active'. */
export function writeMeta(slug: string, meta: ProjectMeta): ProjectMeta {
  validSlug(slug);
  const cur = dbApi.getProjectRow(slug);
  const fields: Parameters<typeof dbApi.upsertProject>[1] = {};
  if ('name' in meta) fields.name = meta.name ?? null;
  if ('icon' in meta) fields.icon = meta.icon ?? null;
  if ('workspace' in meta) fields.workspace = meta.workspace ?? null;
  if ('cwd' in meta) fields.cwd = meta.cwd ?? null;
  if ('speech' in meta) fields.speech = meta.speech ?? null;
  if ('kind' in meta) fields.kind = meta.kind ?? null;
  if ('status' in meta) fields.status = meta.status || 'active';
  if ('grepai_watch' in meta) fields.grepai_watch = meta.grepai_watch ?? null;
  fields.color = meta.color || cur?.color || autoColorFor(meta.name || slug);
  dbApi.upsertProject(slug, fields);
  return rowToMeta(dbApi.getProjectRow(slug)!);
}

/** Creates a project: validates the slug, refuses if it already exists (DB or folder),
 *  writes the initial meta (auto-color if needed). The folder stays the home
 *  of roles.json + the .md memory. Returns the normalised meta. */
export function createProject(slug: string, meta: ProjectMeta): ProjectMeta {
  validSlug(slug);
  if (dbApi.getProjectRow(slug) || existsSync(projectDir(slug))) {
    throw new Error(`project already exists: "${slug}"`);
  }
  mkdirSync(projectDir(slug), { recursive: true });
  return writeMeta(slug, meta);
}

/** Deletes the project: folder ~/.timon/projects/<slug>/ then DB row. Idempotent —
 *  does not touch the associated agents: `removeProject` (project-removal.ts) decides about them.
 *  The folder goes first: if Windows locks it (EBUSY, antivirus), the error
 *  comes up BEFORE the row disappears, and the project stays whole instead of half deleted. */
export function deleteProject(slug: string): void {
  validSlug(slug);
  const dir = projectDir(slug);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  dbApi.deleteProjectRow(slug);
}

/** Lists the existing workspaces inferred from the projects' metas. No
 *  workspace entity persisted elsewhere — a workspace exists as soon as
 *  at least one project references it. */
export function listWorkspaces(): string[] {
  const set = new Set<string>();
  for (const slug of listProjects()) {
    const m = readMeta(slug);
    if (m.workspace) set.add(m.workspace);
  }
  return [...set].sort();
}

/* ────────────────────────────────────────────────────────────────────────────
   Project memory (~/.timon/projects/<slug>/memory/) — shared by all the
   project's agents. instructions.md + decisions.md are injected at spawn by
   buildEffectivePrompt; proposals.md is filled by the promotion. Counterpart
   of the per-agent memory helpers in agent.ts, but keyed by project slug.
   ──────────────────────────────────────────────────────────────────────────── */

const MEMORY_FILE_RE = /^[\w.-]+\.(md|jsonl|txt|json)$/;

function validMemoryFile(file: string): void {
  if (!MEMORY_FILE_RE.test(file)) throw new Error(`invalid memory file: ${file}`);
}

export type ProjectMemoryFile = { name: string; size: number; modified: number };

export function listProjectMemory(slug: string): ProjectMemoryFile[] {
  validSlug(slug);
  const dir = projectMemoryDir(slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => MEMORY_FILE_RE.test(f))
    .map((f) => {
      const st = statSync(join(dir, f));
      return { name: f, size: st.size, modified: st.mtimeMs };
    })
    .sort((a, b) => b.modified - a.modified);
}

export function readProjectMemory(slug: string, file: string): string | null {
  validSlug(slug);
  validMemoryFile(file);
  const path = projectMemoryFile(slug, file);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function writeProjectMemory(slug: string, file: string, content: string): ProjectMemoryFile {
  validSlug(slug);
  validMemoryFile(file);
  mkdirSync(projectMemoryDir(slug), { recursive: true });
  writeFileSync(projectMemoryFile(slug, file), content);
  const st = statSync(projectMemoryFile(slug, file));
  return { name: file, size: st.size, modified: st.mtimeMs };
}

/** ADD-only : append (promotion → proposals.md, decisions.md). */
export function appendProjectMemory(slug: string, file: string, content: string): void {
  validSlug(slug);
  validMemoryFile(file);
  mkdirSync(projectMemoryDir(slug), { recursive: true });
  appendFileSync(projectMemoryFile(slug, file), content);
}

export function deleteProjectMemory(slug: string, file: string): boolean {
  validSlug(slug);
  validMemoryFile(file);
  const path = projectMemoryFile(slug, file);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Project slugs: union of the DB (source of truth for meta) ∪ the folders
 *  ~/.timon/projects/ (transition safety + projects that only have roles/memory). */
export function listProjects(): string[] {
  const set = new Set<string>();
  for (const r of dbApi.listProjectRows()) set.add(r.slug);
  if (existsSync(PROJECTS_DIR)) {
    for (const name of readdirSync(PROJECTS_DIR)) {
      if (!SLUG_RE.test(name)) continue;
      try { if (statSync(join(PROJECTS_DIR, name)).isDirectory()) set.add(name); } catch { /* skip */ }
    }
  }
  return [...set].sort();
}
