/** Agent roles combine shipped defaults with runtime custom roles and prompt overrides. */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { BUILTIN_ROLE_OVERRIDES_FILE, CUSTOM_ROLES_FILE } from './paths.js';

/** A role id is a free string (built-in OR custom defined by the UI). */
export type AgentRoleId = string;

export type AgentRole = {
  id: AgentRoleId;
  label: string;
  /** Pictogram: lucide icon name (PascalCase, e.g. "ChefHat") + its inner SVG
   *  markup (viewBox 0 0 24 24, stroke-based) captured at pick time.
   *  The iconSvg is rendered identically by the React badge AND the D3 canvas. */
  iconName: string;
  iconSvg: string;
  /** Accent colour (hex). The chip derives bg `${color}14` + border `${color}66`. */
  color: string;
  default_directives: string;
  default_model: string;
  default_permission_mode: string;
  /** Built-in identity is immutable; only its directives can be overridden. */
  builtin?: boolean;
  directives_overridden?: boolean;
};

/** Inner SVG of the built-in lucide icons (lucide-react v0.460), verbatim. */
const SVG = {
  Code2: '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
  ScanSearch:
    '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/>',
  GitMerge:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  BookOpen:
    '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  Wrench:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  Telescope:
    '<path d="m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44"/><path d="m13.56 11.747 4.332-.924"/><path d="m16 21-3.105-6.21"/><path d="M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z"/><path d="m6.158 8.633 1.114 4.456"/><path d="m8 21 3.105-6.21"/><circle cx="12" cy="13" r="2"/>',
  ChefHat:
    '<path d="M17 21a1 1 0 0 0 1-1v-5.35c0-.457.316-.844.727-1.041a4 4 0 0 0-2.134-7.589 5 5 0 0 0-9.186 0 4 4 0 0 0-2.134 7.588c.411.198.727.585.727 1.041V20a1 1 0 0 0 1 1Z"/><path d="M6 17h12"/>',
} as const;

export const ROLE_REGISTRY: readonly AgentRole[] = [
  {
    id: 'coder',
    label: 'Coder',
    iconName: 'Code2',
    iconSvg: SVG.Code2,
    color: '#3b82f6',
    default_directives: [
      "You write and modify code. Read a file before touching it.",
      "Clean commits, clear messages. No Claude / Anthropic / Co-Authored-By mention.",
      "Prefer editing what exists over creating something new. No premature abstraction.",
      "A full test suite runs in the foreground, with a 600000 ms timeout, never in the background (`run_in_background`): the turn would end while waiting for it and the mission would be released as idle. Beyond 10 min, split it by file.",
    ].join('\n'),
    default_model: 'opus',
    default_permission_mode: 'auto',
    builtin: true,
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    iconName: 'ScanSearch',
    iconSvg: SVG.ScanSearch,
    color: '#8b5cf6',
    default_directives: [
      "You audit a diff. You do not commit.",
      "Focus: security, quality, consistency with the original mission. Tests where relevant.",
      'You ALWAYS close with `timon task done` (never `block`). The first line of the done_comment, in plain text, is REQUIRED: `verdict: pass` or `verdict: changes_requested` (it alone carries the verdict and survives truncation). Optional details as JSON below it: {"findings": [...], "suggested_fixes": "..."}. Long comment → `--comment-file PATH` or `--comment-stdin < PATH` (redirected stdin, never a pipe), not a huge shell argument.',
    ].join('\n'),
    default_model: 'claude-sonnet-4-6',
    default_permission_mode: 'auto',
    builtin: true,
  },
  {
    id: 'merger',
    label: 'Merger',
    iconName: 'GitMerge',
    iconSvg: SVG.GitMerge,
    color: '#10b981',
    default_directives: [
      "You merge approved branches into the base. You check for conflicts before merging.",
      "Never force-push, never rebase shared branches.",
      "Push only when explicitly allowed in CLAUDE.md or the system prompt.",
    ].join('\n'),
    default_model: 'claude-sonnet-4-6',
    default_permission_mode: 'auto',
    builtin: true,
  },
  {
    id: 'librarian',
    label: 'Librarian',
    iconName: 'BookOpen',
    iconSvg: SVG.BookOpen,
    color: '#ec4899',
    default_directives: [
      "You do documentation and research. You produce structured, quotable markdown.",
      "Before writing: search the knowledge vault and the repo so as not to duplicate.",
      "Cross-link existing notes. No invention — cite the sources.",
    ].join('\n'),
    default_model: 'claude-sonnet-4-6',
    default_permission_mode: 'auto',
    builtin: true,
  },
  {
    id: 'ops',
    label: 'Ops',
    iconName: 'Wrench',
    iconSvg: SVG.Wrench,
    color: '#f97316',
    default_directives: [
      "You handle infra, chores and builds. You confirm every destructive action before running it.",
      "Always propose the command before a Docker rebuild / service restart.",
      "Preserve observability: clear logs, checked exit codes.",
    ].join('\n'),
    default_model: 'claude-sonnet-4-6',
    default_permission_mode: 'auto',
    builtin: true,
  },
  {
    id: 'research',
    label: 'Research',
    iconName: 'Telescope',
    iconSvg: SVG.Telescope,
    color: '#06b6d4',
    default_directives: [
      "You explore and synthesise. You produce sourced findings, not opinions.",
      "Cite every source. Tell verified facts from hypotheses.",
    ].join('\n'),
    default_model: 'claude-sonnet-4-6',
    default_permission_mode: 'auto',
    builtin: true,
  },
  {
    id: 'orchestrator',
    label: 'Orchestrator',
    iconName: 'ChefHat',
    iconSvg: SVG.ChefHat,
    color: '#64748b',
    default_directives: [
      "You coordinate sub-agents. You break the mission down into clear Kanban tasks.",
      "When the user asks you for a project, Kanban tasks or parallel work, open the `kanban_plan` planner first (MCP `timon_ask`) and apply the commands it returns.",
      "Create Kanban tasks with `mcp__timon__kanban_add` (fallback: `timon task create`) and isolated sub-agents with `mcp__timon__mission_spawn`. Never the native `Task`/`Agent`.",
      "Keep the big picture: status, deps, blockers. Regular summaries to the user.",
      "Before dispatching `code` tasks (git worktree), check the active branch of the target repo (`git branch --show-current`): worktrees inherit it as their merge base → from a feature branch, every merge lands there instead of main. If it is not the intended base, check out the right base (or create the target branch) BEFORE creating the tasks, or state the base in the brief of the merge tasks.",
    ].join('\n'),
    default_model: 'opus',
    default_permission_mode: 'auto',
    builtin: true,
  },
] as const;

/**
 * Reviewer briefs shipped before TODO #523 told the agent to close with
 * `timon task done --file PATH`, a flag the CLI never had: the close failed and
 * the verdict was lost. A seeded `system-prompt.md` is never rewritten (it may
 * carry the user's edits), and a role override may have been copied from the
 * old default, so the stale sentence is corrected where the prompt is read.
 * Exact sentences only: any other mention of `--file` is left alone.
 */
const STALE_CLOSE_FLAG_SENTENCES: ReadonlyArray<readonly [string, string]> = [
  [
    // french-ok: exact French sentences of seeded prompts, corrected in place
    'Comment long → `--file`/stdin, pas un gros arg shell.',
    'Comment long → `--comment-file PATH` ou `--comment-stdin < PATH` (stdin redirigé, jamais un pipe), pas un gros arg shell.',
  ],
  [
    // french-ok: same, the other seeded wording
    'Comment long → passe-le via `--file PATH` ou sur stdin, jamais en gros argument shell inline',
    'Comment long → passe-le via `--comment-file PATH` ou `--comment-stdin < PATH` (stdin redirigé, jamais un pipe), jamais en gros argument shell inline',
  ],
];

export function withCurrentCloseFlags(text: string): string {
  let out = text;
  for (const [stale, current] of STALE_CLOSE_FLAG_SENTENCES) out = out.split(stale).join(current);
  return out;
}

/* ── Role icon markup: a closed grammar, not free HTML ── */

/**
 * A custom role's `iconSvg` is injected as markup by every client that draws
 * the role, inside the operator's session. Any caller holding `agents:manage`
 * can write it, mission tokens included, so the field is limited to the shapes
 * a lucide icon is made of. Anything else is refused, never cleaned up: a
 * silently rewritten icon would hide the attempt.
 */
export const ROLE_ICON_SVG_MAX_LENGTH = 4096;
const ROLE_ICON_ELEMENTS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'g']);
// Geometry only: a paint attribute such as `fill` would accept `url(#id)` and
// let the icon reach other parts of the page. Clients draw a known lucide icon
// from its `iconName`, so this markup is only a stroke-drawn fallback.
const ROLE_ICON_ATTRIBUTES = new Set([
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'width', 'height', 'points', 'transform',
]);
const ROLE_ICON_VALUE_RE = /^[0-9a-zA-Z .,\-#()]*$/;
const ROLE_ICON_OPEN_RE = /^<([a-zA-Z][a-zA-Z0-9:_-]*)((?:\s+[^\s=/>]+\s*=\s*"[^"]*")*)\s*(\/?)>/;
const ROLE_ICON_CLOSE_RE = /^<\/([a-zA-Z][a-zA-Z0-9:_-]*)\s*>/;
const ROLE_ICON_ATTR_RE = /\s+([^\s=/>]+)\s*=\s*"([^"]*)"/g;
const ROLE_ICON_MAX_DEPTH = 8;

/** Why `svg` is not an acceptable role icon, or null when it is. */
export function roleIconSvgProblem(svg: unknown): string | null {
  if (typeof svg !== 'string') return 'icon must be a string';
  if (svg.length > ROLE_ICON_SVG_MAX_LENGTH) return `icon longer than ${ROLE_ICON_SVG_MAX_LENGTH} characters`;
  const stack: string[] = [];
  let rest = svg;
  let shapes = 0;
  while (rest.length > 0) {
    const lt = rest.indexOf('<');
    const text = lt < 0 ? rest : rest.slice(0, lt);
    // Text, entities and CDATA have no place between shapes.
    if (text.trim() !== '') return 'icon may only contain shapes';
    if (lt < 0) break;
    rest = rest.slice(lt);
    const close = ROLE_ICON_CLOSE_RE.exec(rest);
    if (close) {
      if (stack.pop() !== close[1]) return 'icon has an unbalanced tag';
      rest = rest.slice(close[0].length);
      continue;
    }
    const open = ROLE_ICON_OPEN_RE.exec(rest);
    if (!open) return 'icon has a malformed or forbidden tag';
    const tag = open[1]!;
    if (!ROLE_ICON_ELEMENTS.has(tag)) return `icon element <${tag}> is not allowed`;
    const seen = new Set<string>();
    for (const attr of open[2]!.matchAll(ROLE_ICON_ATTR_RE)) {
      const name = attr[1]!;
      if (!ROLE_ICON_ATTRIBUTES.has(name)) return `icon attribute "${name}" is not allowed`;
      if (seen.has(name)) return `icon attribute "${name}" is repeated`;
      seen.add(name);
      if (!ROLE_ICON_VALUE_RE.test(attr[2]!)) return `icon attribute "${name}" has a forbidden character`;
    }
    const parent = stack[stack.length - 1];
    if (parent !== undefined && parent !== 'g') return `icon element <${parent}> cannot hold children`;
    shapes += 1;
    if (open[3] !== '/') {
      if (stack.length >= ROLE_ICON_MAX_DEPTH) return 'icon is nested too deeply';
      stack.push(tag);
    }
    rest = rest.slice(open[0].length);
  }
  if (stack.length > 0) return 'icon has an unclosed tag';
  if (shapes === 0) return 'icon required';
  return null;
}

export function isSafeRoleIconSvg(svg: unknown): svg is string {
  return roleIconSvgProblem(svg) === null;
}

/* ── Custom roles: persisted in ~/.timon/roles.json (cache invalidated on write) ── */

let cache: AgentRole[] | null = null;
let cacheMtime = 0;

function readCustomRoles(): AgentRole[] {
  if (!existsSync(CUSTOM_ROLES_FILE)) return [];
  try {
    const mtime = statSync(CUSTOM_ROLES_FILE).mtimeMs;
    if (cache && mtime === cacheMtime) return cache;
    const raw = JSON.parse(readFileSync(CUSTOM_ROLES_FILE, 'utf8')) as AgentRole[];
    // A file written before the icon grammar existed, or edited by hand, may
    // carry markup the routes now refuse: the icon is dropped, the role kept.
    cache = Array.isArray(raw)
      ? raw.map((r) => ({ ...r, iconSvg: isSafeRoleIconSvg(r.iconSvg) ? r.iconSvg : '', builtin: false }))
      : [];
    cacheMtime = mtime;
    return cache;
  } catch {
    return [];
  }
}

function writeCustomRoles(roles: AgentRole[]): void {
  mkdirSync(dirname(CUSTOM_ROLES_FILE), { recursive: true });
  writeFileSync(
    CUSTOM_ROLES_FILE,
    JSON.stringify(roles.map((r) => ({ ...r, builtin: undefined })), null, 2),
  );
  cache = null; // force re-read on next access
  cacheMtime = 0;
}

const promptOverridesSchema = z.record(z.string(), z.string());
let promptOverridesCache: Record<string, string> | null = null;
let promptOverridesMtime = 0;

function readPromptOverrides(): Record<string, string> {
  try {
    const mtime = statSync(BUILTIN_ROLE_OVERRIDES_FILE).mtimeMs;
    if (promptOverridesCache && mtime === promptOverridesMtime) return promptOverridesCache;
    promptOverridesCache = promptOverridesSchema.parse(JSON.parse(readFileSync(BUILTIN_ROLE_OVERRIDES_FILE, 'utf8')));
    promptOverridesMtime = mtime;
    return promptOverridesCache;
  } catch {
    // Unreadable overrides must never prevent agents from spawning with shipped defaults.
    promptOverridesCache = null;
    return {};
  }
}

function writePromptOverride(id: string, prompt: string | null): AgentRole {
  const role = ROLE_REGISTRY.find((entry) => entry.id === id);
  if (!role) throw new Error('Only built-in roles have prompt overrides');
  const overrides = { ...readPromptOverrides() };
  if (prompt === null) delete overrides[id];
  else overrides[id] = prompt;
  mkdirSync(dirname(BUILTIN_ROLE_OVERRIDES_FILE), { recursive: true });
  writeFileSync(BUILTIN_ROLE_OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
  promptOverridesCache = null;
  return getRole(id)!;
}

export function resetRoleDirectives(id: string): AgentRole {
  return writePromptOverride(id, null);
}

/** Built-ins ⊕ custom. Built-ins d'abord, custom ensuite. */
export function listRoles(): AgentRole[] {
  const overrides = readPromptOverrides();
  return [...ROLE_REGISTRY.map((role) => ({
    ...role,
    default_directives: overrides[role.id] ?? role.default_directives,
    directives_overridden: Object.hasOwn(overrides, role.id),
  })), ...readCustomRoles()];
}

export function getRole(id: string | null | undefined): AgentRole | null {
  if (!id) return null;
  return listRoles().find((r) => r.id === id) ?? null;
}

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

export type CustomRoleInput = {
  id: string;
  label: string;
  iconName: string;
  iconSvg: string;
  color: string;
  default_directives?: string;
  default_model?: string;
  default_permission_mode?: string;
};

/** Creates a custom role. Throws if the id is invalid or already taken (built-in/custom). */
export function createRole(input: CustomRoleInput): AgentRole {
  if (!ID_RE.test(input.id)) {
    throw new Error('invalid id (lowercase letters, digits, dashes; 2-32 chars, starting with a letter)');
  }
  if (getRole(input.id)) throw new Error(`role "${input.id}" already exists`);
  if (!input.label?.trim()) throw new Error('label required');
  const iconProblem = roleIconSvgProblem(input.iconSvg);
  if (iconProblem) throw new Error(iconProblem);
  const role: AgentRole = {
    id: input.id,
    label: input.label.trim(),
    iconName: input.iconName,
    iconSvg: input.iconSvg,
    color: input.color || '#64748b',
    default_directives: input.default_directives ?? '',
    default_model: input.default_model || 'claude-sonnet-4-6',
    default_permission_mode: input.default_permission_mode || 'auto',
    builtin: false,
  };
  writeCustomRoles([...readCustomRoles(), role]);
  return role;
}

/** Built-ins accept only a prompt override; custom roles retain their editable fields. */
export function updateRole(id: string, patch: Partial<CustomRoleInput>): AgentRole {
  const existing = ROLE_REGISTRY.find((r) => r.id === id);
  if (existing) {
    const prompt = z.object({ default_directives: z.string() }).strict().parse(patch);
    return writePromptOverride(id, prompt.default_directives);
  }
  if (patch.iconSvg !== undefined) {
    const iconProblem = roleIconSvgProblem(patch.iconSvg);
    if (iconProblem) throw new Error(iconProblem);
  }
  const custom = readCustomRoles();
  const idx = custom.findIndex((r) => r.id === id);
  if (idx < 0) throw new Error(`role not found: ${id}`);
  const next: AgentRole = { ...custom[idx]!, ...patch, id, builtin: false };
  custom[idx] = next;
  writeCustomRoles(custom);
  return next;
}

/** Deletes a custom role (built-in forbidden). */
export function deleteRole(id: string): void {
  if (ROLE_REGISTRY.find((r) => r.id === id)) {
    throw new Error(`"${id}" is a built-in role and cannot be deleted`);
  }
  const custom = readCustomRoles();
  if (!custom.find((r) => r.id === id)) throw new Error(`role not found: ${id}`);
  writeCustomRoles(custom.filter((r) => r.id !== id));
}
