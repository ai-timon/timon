/**
 * Routes of the Apps catalogue (docs/MCP-APPS.md §4). Every route says who it
 * admits:
 *  - listing: any authenticated caller — the catalogue is public data, the
 *    connection state is the same as `GET /api/mcp` already shows;
 *  - connecting and disconnecting: a person or the CLI holding `mcp:manage`,
 *    never a mission — an app acts with the user's account at the publisher,
 *    and the key a user pastes must not transit through an agent's context.
 *
 * The browser names an entry, never a url: the endpoint a server is created
 * for is the reviewed one, so this route cannot be used to point a stored key
 * at a host of the caller's choosing.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { deleteMcp, getMcp, listMcp, upsertMcp, type McpSummary } from '../../mcp.js';
import { vaultEnabled } from '../../secrets/availability.js';
import { createSecret, deleteSecret } from '../../secrets/store.js';
import { rejectIfDenied, requireAuth } from '../../users/identity.js';
import { isMissionToken } from '../../users/conversion-mission.js';
import { auditRequest } from '../../users/audit-actor.js';
import { APP_CATALOG, appEntry, appServerId } from './catalog.js';
import type { AppEntry } from './schema.js';
import { apiError } from '../../api-error.js';

/** What a card shows: the reviewed entry and where its server stands. */
export type AppView = AppEntry & {
  state: {
    /** The server `app-<slug>` exists and was connected from Apps. */
    connected: boolean;
    /** `app-<slug>` is taken by a server a user added by hand: Apps leaves it alone. */
    blocked: boolean;
    mcp_id: string;
    oauth_status: McpSummary['oauth_status'] | null;
    last_status: McpSummary['last_status'] | null;
  };
};

function viewOf(entry: AppEntry, servers: ReadonlyMap<string, McpSummary>): AppView {
  const id = appServerId(entry.slug);
  const server = servers.get(id);
  const ours = !!server && server.app_slug === entry.slug;
  return {
    ...entry,
    state: {
      connected: ours,
      blocked: !!server && !ours,
      mcp_id: id,
      oauth_status: ours ? server.oauth_status : null,
      last_status: ours ? server.last_status ?? null : null,
    },
  };
}

export function listAppViews(): AppView[] {
  const servers = new Map(listMcp().map((s) => [s.id, s]));
  return APP_CATALOG.map((entry) => viewOf(entry, servers));
}

// A header value: no line break (header injection), a bound that no real key reaches.
const connectBody = z.object({
  key: z.string().trim().min(8).max(4_096).regex(/^[\x21-\x7E]+$/, 'printable characters without spaces').optional(),
}).strict();

/** `MCP_APP_GITHUB_KEY`: the vault names secrets like environment variables. */
export function appSecretName(slug: string): string {
  return `MCP_APP_${slug.toUpperCase().replace(/-/g, '_')}_KEY`;
}

/** Admits a person or the CLI holding `mcp:manage`; answers and returns `true` otherwise. */
function rejectAppWrite(req: Request, res: Response): boolean {
  if (!requireAuth(req, res)) return true;
  if (isMissionToken(req)) {
    const reason = 'Connecting an app is a gesture of the user, not of an agent.';
    res.status(403).json({ ...apiError('mission_refused', reason), reason });
    return true;
  }
  return rejectIfDenied(req, res, 'mcp:manage');
}

export function registerMcpAppsRoutes(router: Router): void {
  router.get('/api/mcp-apps', (req, res) => {
    if (!requireAuth(req, res)) return;
    res.json({ apps: listAppViews(), vault: vaultEnabled() });
  });

  router.post('/api/mcp-apps/:slug/connect', (req, res) => {
    if (rejectAppWrite(req, res)) return;
    const entry = appEntry(req.params.slug ?? '');
    if (!entry) { res.status(404).json(apiError('mcp_app_unknown', 'unknown app')); return; }
    const parsed = connectBody.safeParse(req.body ?? {});
    if (!parsed.success) { const issues = parsed.error.issues.map((i) => i.message);
      res.status(400).json({ ...apiError('invalid_detail', 'invalid body', { detail: issues.join('; ') }), issues }); return; }
    const id = appServerId(entry.slug);
    const existing = getMcp(id);
    if (existing && existing.app_slug !== entry.slug) {
      const reason = `An MCP server named ${id} already exists and was not added from Apps.`;
      res.status(409).json({ ...apiError('mcp_app_id_taken', reason, { id }), reason });
      return;
    }
    const auth = entry.auth;
    const key = parsed.data.key;
    if (auth.type === 'key' && !key) { res.status(400).json(apiError('mcp_app_key_required', 'this app needs a key')); return; }
    if (auth.type !== 'key' && key) { res.status(400).json(apiError('mcp_app_takes_no_key', 'no key for this app')); return; }
    if (auth.type === 'key' && !vaultEnabled()) {
      const reason = 'The key is kept in the secrets vault, which is switched off.';
      res.status(409).json({ ...apiError('mcp_app_vault_off', reason), reason });
      return;
    }
    let secretId: string | null = null;
    try {
      if (auth.type === 'key' && key) {
        secretId = createSecret({ name: appSecretName(entry.slug), value: key, note: `Apps: ${entry.name} key (server ${id})` }).id;
      }
      // A new key replaces the old one: `upsertMcp` deletes the secret the
      // server no longer names once the new record is written, so a failed
      // write leaves the previous connection working.
      upsertMcp({
        id,
        name: id,
        description: entry.tagline.en,
        transport: { type: 'http', url: entry.mcp.url },
        appSlug: entry.slug,
        ...(auth.type === 'key' && secretId
          ? { headerSecrets: { [auth.header]: { secret_id: secretId, ...(auth.prefix ? { prefix: auth.prefix } : {}) } } }
          : {}),
      });
    } catch (err) {
      if (secretId) {
        try { deleteSecret(secretId); } catch { /* the server was not written: nothing names it */ }
      }
      res.status(500).json(apiError('mcp_app_connect_failed', (err as Error).message, { detail: (err as Error).message }));
      return;
    }
    auditRequest(req, 'mcp-apps.connect', `mcp:${id} — ${entry.name} (${auth.type})`);
    const view = listAppViews().find((app) => app.slug === entry.slug);
    // `oauth` still needs the consent page: the client starts it with
    // `POST /api/mcp/:id/oauth/start`, which owns discovery and registration.
    res.json({ app: view, next: auth.type === 'oauth' ? 'oauth' : null });
  });

  router.delete('/api/mcp-apps/:slug', (req, res) => {
    if (rejectAppWrite(req, res)) return;
    const entry = appEntry(req.params.slug ?? '');
    if (!entry) { res.status(404).json(apiError('mcp_app_unknown', 'unknown app')); return; }
    const id = appServerId(entry.slug);
    const existing = getMcp(id);
    if (!existing || existing.app_slug !== entry.slug) { res.status(404).json(apiError('mcp_app_not_connected', 'not connected')); return; }
    deleteMcp(id);
    auditRequest(req, 'mcp-apps.disconnect', `mcp:${id} — ${entry.name}`);
    res.json({ ok: true });
  });
}
