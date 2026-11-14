/**
 * Permission strings (`docs/MULTI-USER.md` §4): `domain:object[:scope]`.
 *
 * Deny by default. A leading `-` is a deny that wins over grants — that is
 * how the Administration preset encodes `*` except `users:manage` without
 * a second table, and without any code keying off the role's name.
 *
 * The superadmin flag never reaches this evaluator: `userAllows` short-
 * circuits on `is_superadmin` and the daemon-token is already
 * `isSuperadmin` on the request.
 */

const PERMISSION_RE = /^-?(?:\*|[^\s:*]+)(?::(?:\*|[^\s:*]+))*$/;

export function isPermissionString(value: string): boolean {
  return value.length > 0 && value.length <= 200 && PERMISSION_RE.test(value);
}

export function normalizePermission(value: string): string {
  return value.trim();
}

/**
 * Whether a grant pattern covers a requested permission.
 *
 * - `*` matches everything
 * - `plugins:*` matches `plugins:manage` and `plugins:manage:all`
 * - `missions:read` does not match `missions:read:all` (own ≠ all)
 * - `missions:read:all` matches `missions:read` (all includes own)
 */
export function permissionCovers(pattern: string, request: string): boolean {
  if (pattern === '*') return true;
  if (pattern === request) return true;
  const p = pattern.split(':');
  const r = request.split(':');
  let i = 0;
  while (i < p.length && i < r.length) {
    if (p[i] === '*') return true;
    if (p[i] !== r[i]) return false;
    i++;
  }
  if (i < p.length) {
    return p.slice(i).every((seg) => seg === 'all' || seg === '*');
  }
  return i >= r.length;
}

/**
 * A deny of an action also denies its scopes (`users:manage` blocks
 * `users:manage:all`). A deny does not bleed into a sibling object
 * (`users:manage` does not block `users:read`).
 */
export function permissionDenies(pattern: string, request: string): boolean {
  if (permissionCovers(pattern, request)) return true;
  return request.startsWith(`${pattern}:`);
}

/** Flattened grants + denials from every assigned role. Deny wins. */
export function grantsAllow(permissions: readonly string[], request: string): boolean {
  if (!isPermissionString(request) || request.startsWith('-')) return false;
  const grants: string[] = [];
  const denies: string[] = [];
  for (const raw of permissions) {
    const permission = normalizePermission(raw);
    if (!isPermissionString(permission)) continue;
    if (permission.startsWith('-')) denies.push(permission.slice(1));
    else grants.push(permission);
  }
  if (denies.some((d) => permissionDenies(d, request))) return false;
  return grants.some((g) => permissionCovers(g, request));
}

/**
 * Superadmin carries `*` implicitly and never goes through the role
 * evaluator. Everyone else is deny-by-default on the flattened grants.
 */
export function userAllows(
  user: { is_superadmin: boolean },
  permissions: readonly string[],
  request: string,
): boolean {
  if (user.is_superadmin) return true;
  return grantsAllow(permissions, request);
}

/**
 * Stored in `api_tokens.scope` for a mission's egress proxy credential
 * (TODO #590): it opens the proxy and nothing else — `getLiveApiToken` never
 * resolves it and the REST auth refuses it outright. Here, not in
 * `api-tokens.ts`, because `db.ts` reads it and that module imports `db.ts`.
 */
export const EGRESS_PROXY_TOKEN_SCOPE = 'egress-proxy';

/**
 * Cap on ordinary mission-bound `api_tokens` row (secu-3 / AUDIT-SECU #3).
 *
 * An ordinary spawned agent authenticates as its launcher but does not inherit
 * `isSuperadmin` or `*`. The snapshot is this list ∩ the launcher's
 * grants (a superadmin's implicit `*` yields the whole cap). Kanban reads /
 * notify / mission GET stay owner-scoped rather than `rejectIfDenied`
 * so plugin/system tokens and the Employee preset keep working; the cap
 * is what `requestHasPermission` sees when a route does check. Writing a
 * task (`POST`/`PUT`/`DELETE /api/tasks`, a TO DO promotion) does check
 * `kanban:write` since TODO #752: owner scoping alone let a `kanban:read`
 * account rewrite the agent, the permission mode or the tools of its tasks.
 * TODO #787 extended it to the other Kanban writes: closing another task,
 * mark-merged, the worktree and merged-sha routes, pipelines. A mission keeps
 * closing the task it runs without it (`plugins-bundled/kanban/own-task.ts`).
 *
 * Verified developer-owner missions bypass this cap (agent-permissions.ts).
 * `missions:spawn` is deliberately absent: an injected agent must not
 * use the unrestricted spawn route. The separate delegation route checks a
 * running owned mission and explicit account communication/spawn denials.
 * It preserves the owner. Since TIM-0074 (11/10/2026) it also takes the
 * `model` / `backend` / `extra_*` / `idempotency_key` overrides, through
 * the same guard as a task a mission creates: refusing them left a mission no
 * way at all to use them. Both transports reach it in-mission — the MCP
 * `mission_spawn` and the CLI `timon spawn` (bin/timon `cmdSpawn`), which
 * since 12/10/2026 routes there instead of the unrestricted spawn route it
 * could never pass. `timon task` / `timon notify` stay in the cap.
 *
 * `agents:manage` / `projects:manage` entered the cap on 16/09/2026 (TIM-0013):
 * the runtime preamble sends an orchestrator to `POST /api/agents` and
 * `/api/projects`, and on every beta install (no `internal` licence, so no
 * developer-owner bypass) both answered 403. Still ∩ the launcher's grants —
 * an employee without them stays refused — and still non-privileged on the
 * route: `agentConfigRefusal` bounds what such a caller may put in an agent,
 * and a project cwd it creates must already exist on the host.
 *
 * `agents:privileged-config`: the power-user path of the override guards
 * (`privileged-overrides.ts`). Still ∩ the launcher's grants, so a superadmin's
 * missions carry it and an employee's do not; what it lifts is bounded by the
 * calling agent's own permission level. It lifts the backend and the level,
 * never the tools: since the maintainer's decision of 08/11/2026, adding a tool to an
 * agent (its `allowed_tools`, a lifted `disallowed_tools`, a skill's
 * `allowed-tools`, a spawn's or a task's `extra_allowed_tools`) or attaching
 * a stdio MCP server takes a person, whatever a mission token holds — a
 * developer-owner mission included (`agentWideningRefusal`). Narrowing, or
 * sending the list unchanged, stays open. The daemon-token is the operator's
 * CLI, not a mission: it is not bounded by these guards.
 *
 * `skills:manage` entered the cap on 12/10/2026: the runtime preamble sends an
 * agent to `skill_put` / `skill_rm`, and the route answered 403 to every mission
 * (same shape as TIM-0013). Still ∩ the launcher's grants — an employee without
 * it stays refused — and bounded on the route (`skills-mcp-guard.ts`): a mission
 * writes `<skills>/<id>/SKILL.md` only, never a product skill, and cannot
 * pre-authorise tools it could not give an agent.
 *
 * `mcp:manage` entered it the same day, on the maintainer's decision (12/10/2026) to open
 * `mcp_server_put` / `mcp_server_rm` to agents. Still ∩ the launcher's grants,
 * and bounded on the route (`skills-mcp-guard.ts`, `mcpWriteRefusal`): a stdio
 * server is a command run on the host outside the permission classifier, so no
 * mission token declares or rewrites one, `agents:privileged-config` or not
 * (a person does, from the MCP servers page); an http one needs a plain http(s)
 * URL off this host unless the mission holds `agents:privileged-config`; what
 * Timon injects, what claude.ai discovered and, without that permission, what a
 * human declared are never rewritten. A mission token is never shown the secret
 * values of a server, `mcp:manage` or not.
 *
 * `triggers:manage` (TODO #216): an agent may create a trigger, but the
 * trigger's actions are frozen to what the token itself holds, and an agent
 * can never create an unauthenticated webhook (`plugins-bundled/triggers`).
 *
 * `missions:stop`: an orchestrator told "STOP" by its user must be able to
 * turn it into the technical stop (`POST /api/stop`). Owner-bounded like every
 * other row it touches, and a stop only switches things off.
 */
export const MISSION_TOKEN_PERMISSIONS = [
  'kanban:read',
  'kanban:write',
  'notify',
  'missions:read',
  'missions:stop',
  'trace:read',
  'agents:manage',
  'agents:privileged-config',
  'projects:manage',
  'skills:manage',
  'mcp:manage',
  'triggers:manage',
  // The broker routes were pulled out of the `secrets:manage` guard (audit CLI/MCP P2-6):
  // a mission must be able to call an API under a secret it is GRANTED, without
  // being able to read/create/delete the vault. The broker's own grant + host
  // resolution still decides whether the call goes out; this only opens the door.
  'secrets:broker',
  // An agent may DEPOSIT a new secret (`POST /api/secrets/provision`) — one the
  // daemon generates for it or one it generated itself — but never read, replace
  // or delete one: the route refuses an existing name, grants nothing, and
  // answers without the value. Still ∩ the launcher's grants (the Employee preset
  // does not hold it).
  'secrets:create',
] as const;

/** Intersection of the mission cap with a launcher's grants. Never `:all`. */
export function intersectMissionTokenPermissions(
  user: { is_superadmin: boolean } | null,
  grants: readonly string[],
): string[] {
  if (!user) return [];
  return MISSION_TOKEN_PERMISSIONS.filter((permission) => userAllows(user, grants, permission));
}
