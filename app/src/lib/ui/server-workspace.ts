/**
 * The workspace, resolved during the server render.
 *
 * The browser used to do this itself, and it cost two chained round trips
 * before anything stored could even be requested: `/api/ui/auth/me` (plus the
 * agent's project on `/chat`) to learn the scope, then the value under that
 * scope. Until both landed, every consumer painted its defaults — the second
 * of stock cockpit and stock canvas seen at every reload.
 *
 * Here, the session cookie is already at hand and the daemon is one hop away,
 * so the same two reads happen before the first byte of HTML. What the browser
 * receives is the answer, not the questions.
 *
 * Every failure returns `null`: the client then behaves exactly as it did
 * before this module existed. A slow daemon must cost a flash, never a page.
 */

import { headers, type UnsafeUnwrappedHeaders } from 'next/headers';
import { relayFetch, targetFor, type Target } from '@/lib/machines/target';
import { sessionProxyHeaders } from '@/lib/ui/proxy';
import { workspaceKeys } from '@/lib/workspace-scope';
import { URL_HEADER, WORKSPACE_LAYOUT_ROWS, workspaceRoute, workspaceRowHandover, type InitialWorkspace } from '@/lib/workspace-route';
import { handoverOf, readHandover, type LayoutHandoverInput } from '@/lib/layout-handover';

/**
 * One read of the active machine during the server render, with the caller's
 * session. The budget is the target's: a loopback daemon answers in
 * milliseconds, a machine across the internet does not, and a budget sized for
 * the first would fail every read on the second — silently, as empty seeds.
 * `pinned` overrides the active machine for a read that only the local daemon
 * may answer.
 */
export async function fetchForRender(path: string, pinned?: Target): Promise<globalThis.Response> {
  const target = pinned ?? await targetFor(path);
  return relayFetch(target, path, {
    headers: sessionProxyHeaders(),
    cache: 'no-store',
    signal: AbortSignal.timeout(target.timeoutMs),
  });
}

async function fetchJson(path: string): Promise<unknown | null> {
  try {
    const res = await fetchForRender(path);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The URL the browser asked for, as the middleware forwarded it. */
function requestedUrl(): { view: string; params: URLSearchParams } | null {
  // Synchronous on purpose: Next 15 still unwraps `headers()` in place.
  const raw = (headers() as unknown as UnsafeUnwrappedHeaders).get(URL_HEADER);
  if (!raw) return null;
  const [view, query = ''] = raw.split('?');
  return { view: view || '/', params: new URLSearchParams(query) };
}

/**
 * Resolves the workspace of the page being served, or `null`.
 *
 * `owner` comes from the session, never from the URL: a scope is per account,
 * and seeding one resolved from anything else would show a stranger's layout
 * for the split second before the client's own read lands. On a remote
 * machine it is the account this computer acts as there (`workspaceOwner`),
 * the one the browser's own read resolves too (`workspaceOwnerOf`).
 * `previousOwner` is the id that remote's rows were hashed with before
 * (`previousLayoutOwner`, TIM-0137).
 */
export async function resolveWorkspace(owner: string | null, previousOwner: string | null = null): Promise<InitialWorkspace | null> {
  if (!owner) return null;
  const url = requestedUrl();
  if (!url) return null;
  const { view, params } = url;
  const { agent, explicitProject, route } = workspaceRoute(view, params);

  let project = explicitProject;
  if (agent) {
    const body = await fetchJson(`/api/agents/${encodeURIComponent(agent)}`) as
      { agent?: { project?: string | null }; project?: string | null } | null;
    // An unreadable agent is not a project-less agent: seeding the scope of
    // "no project" would point at another workspace's cards entirely.
    if (!body) return null;
    project = body.agent?.project ?? body.project ?? null;
  }

  const keys = await workspaceKeys(owner, previousOwner, view, project);
  return { route, ...keys, previousOwner, owner, project, view };
}

/**
 * Everything the first paint needs, keyed by scope.
 *
 * The account's canvas hangs on the session alone; the cards, the chat's
 * columns and its skin hang on the workspace, so they are only read once one
 * has been resolved. All in parallel: they are independent rows behind the
 * same socket, and chaining them here would rebuild, on the server, the very
 * waterfall this module exists to remove.
 *
 * `cockpit` is the pre-workspace placement — the same fallback the browser
 * applies, after the row the view held under its previous key on a remote
 * machine (`workspaceRowHandover`). Without it, an account that has not
 * migrated yet would be seeded with nothing and would flash the stock cockpit
 * exactly as before. Read only: the hook's first read copies, and erases what
 * it consumes.
 *
 * An account scope comes alone, or with its own chain (the rail's row on a
 * remote machine, hashed with the previous owner).
 */
export async function resolveLayoutSeeds(
  workspace: InitialWorkspace | null,
  accountScopes: ReadonlyArray<string | { scope: string; legacy: LayoutHandoverInput }>,
): Promise<Record<string, unknown>> {
  const wanted: Array<{ scope: string; legacy?: LayoutHandoverInput }> = accountScopes.map((entry) => (typeof entry === 'string' ? { scope: entry } : entry));
  if (workspace) {
    wanted.push(...WORKSPACE_LAYOUT_ROWS.map(({ suffix, legacy }) => ({
      scope: `${workspace.key}.${suffix}`,
      legacy: workspaceRowHandover(workspace.previousKey, suffix, legacy),
    })));
  }
  const entries = await Promise.all(wanted.map(async ({ scope, legacy }) => {
    const own = await loadLayoutValue(scope);
    if (own !== null) return [scope, own] as const;
    const old = await readHandover(handoverOf(legacy), async (source) => ({ ok: true, raw: await loadLayoutValue(source) }));
    return [scope, old.ok ? old.raw : null] as const;
  }));
  return Object.fromEntries(entries);
}

/** One stored value, read with the caller's session. `null` when there is
 *  none, or when the daemon could not answer — a seed is never worth a page. */
async function loadLayoutValue(scope: string): Promise<unknown> {
  const body = await fetchJson(`/api/layout?scope=${encodeURIComponent(scope)}`) as { layout?: unknown } | null;
  return body?.layout ?? null;
}
