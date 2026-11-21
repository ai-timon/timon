/**
 * `ctx.mcpServers`: the MCP servers declared on this install — what `GET/POST/
 * DELETE /api/mcp` and the `mcp_server_*` tools manage, and what an agent loads
 * once attached (`agents.update({ mcp_servers })` is the operator's gesture).
 * Not to be confused with `ctx.mcp`, which issues tokens to Timon's OWN tools.
 *
 * A declaration is a command the host runs (stdio) or an endpoint every
 * attached agent talks to, outside the permission classifier. A plugin is held
 * to the rules of a mission that is not the operator (`mcpDeclarationRefusal`):
 *
 *  - only an `http(s)` server, whose host resolves to public addresses that are
 *    not this host's own — no loopback, LAN, Tailscale or link-local address —
 *    whoever is the caller (judged again at each launch, `public_only`); a `stdio` one — a command on the
 *    host — needs a superadmin as the caller of the request, never a job, and
 *    its binary passes the `host:exec` policy (`pluginPolicy.exec.allow`, the
 *    product's own binaries and the generic launchers never);
 *  - a plugin changes or removes only the servers IT declared (`created_by`),
 *    a superadmin caller aside; what Timon injects, and the connectors the
 *    harness discovered, are never touched;
 *  - secrets are READ BACK MASKED, always, the superadmin's request included:
 *    the code that reads them is the plugin's. Writing back a masked value
 *    keeps the stored one while the server still points where it did, and is
 *    refused if it was moved;
 *  - OAuth is a browser round trip with the owner: `oauth` is never written
 *    here.
 *
 * A job reads and writes only the servers it declared; a request lists what the
 * page lists. Writing needs `mcp:manage` on the caller's account.
 */
import { z } from 'zod';
import {
  deleteMcp, getMcp, listMcp, missionTransport, redactMcpServer, upsertMcp, type McpHttpConfig,
  type McpServer, type McpStdioConfig, type McpStoredServer,
} from '../mcp.js';
import { mcpDeclarationRefusal } from '../users/skills-mcp-guard.js';
import { pluginAgentOrigin } from './agent-origin.js';
import { assertExecAllowed } from './policy.js';

import type { PluginMcpServer, PluginMcpServerErrorCode, ScopedMcpServers } from './contract/mcp-servers.js';
export type { ScopedMcpServers } from './contract/mcp-servers.js';
export type {
  PluginMcpServer, PluginMcpServerSummary, PluginMcpServerInput, PluginMcpServerErrorCode,
} from './contract/mcp-servers.js';

export class PluginMcpServerError extends Error {
  constructor(readonly code: PluginMcpServerErrorCode, message: string) {
    super(message);
    this.name = 'PluginMcpServerError';
  }
}

export type McpServerCallerScope = {
  pluginId: string;
  job: boolean;
  /** The request's caller is a superadmin: a stdio server and another's server are allowed. */
  superadmin: boolean;
};

const IdSchema = z.string().min(1).max(100).regex(/^[a-z0-9._-]+$/, 'invalid MCP server id');
const Strings = z.record(z.string().max(200), z.string().max(8_192));
const InputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2_000).optional(),
  transport: z.discriminatedUnion('type', [
    z.object({ type: z.literal('http'), url: z.string().min(1).max(2_048), headers: Strings.optional() }).strict(),
    z.object({
      type: z.literal('stdio'),
      command: z.string().min(1).max(4_096),
      args: z.array(z.string().max(4_096)).max(100).optional(),
      env: Strings.optional(),
    }).strict(),
  ]),
}).strict();

/**
 * Fields `get` returns that a write never takes: what the host stamps or
 * observes, never what a plugin declares. `put` drops these named keys so a
 * `get` result can be written back; any other unknown key still fails, so a
 * typo in a real field is not swallowed.
 */
const READ_ONLY_KEYS: readonly string[] = [
  'id', 'mine', 'createdBy', 'created_by', 'source', 'last_status', 'last_seen_at',
  'tools_cache', 'tools_cached_at', 'public_only', 'app_slug',
];

/** Without the read-only keys. `oauth` is not one: forged tokens in a write stay refused, a plugin never declares that state. */
function withoutReadOnly(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([key]) => !READ_ONLY_KEYS.includes(key)));
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const res = schema.safeParse(value);
  if (!res.success) {
    const issue = res.error.issues[0];
    throw new PluginMcpServerError('invalid', `${issue?.path.length ? `${issue.path.join('.')}: ` : ''}${issue?.message ?? 'invalid input'}`);
  }
  return res.data;
}

export function mcpServersFor(scope: McpServerCallerScope): ScopedMcpServers {
  const origin = pluginAgentOrigin(scope.pluginId);
  const mine = (s: { created_by?: McpServer['created_by'] }): boolean => s.created_by?.agent === origin;
  const createdBy = (s: { created_by?: McpServer['created_by'] }): string | null => s.created_by?.agent ?? null;
  const stored = (id: string): McpStoredServer | null => getMcp(id);
  /** A job answers `not_found` for what it did not declare. */
  const visible = (s: McpServer | { created_by?: McpServer['created_by'] }): boolean => !scope.job || mine(s);
  // Through `redactMcpServer` and nothing else: secret values masked, and the
  // storage-only fields (which vault secret holds a key) never handed out.
  const publicServer = (s: McpStoredServer): PluginMcpServer => {
    const { created_by: _stamp, ...rest } = redactMcpServer(s);
    return { ...rest, mine: mine(s), createdBy: createdBy(s) };
  };
  const assertMayWrite = async (id: string, existing: McpServer | null, transport?: unknown, name?: string): Promise<void> => {
    const refusal = await mcpDeclarationRefusal({ id, name, transport, existing }, {
      relaxed: scope.superadmin,
      // Even a superadmin's request does not point an agent at the daemon's own
      // API through a plugin: the plugin's code is not the operator.
      allowLocalHttp: false,
      ownsExisting: mine,
      who: 'a plugin',
      owner: 'this plugin',
      need: 'that needs a superadmin as the caller of the request, or do it from the MCP servers page of the app',
    });
    if (refusal) throw new PluginMcpServerError('forbidden', refusal);
  };

  return {
    async list() {
      return listMcp().filter(visible).map((s) => {
        const { created_by: _stamp, ...rest } = s;
        return { ...rest, mine: mine(s), createdBy: createdBy(s) };
      });
    },

    async get(id) {
      const server = stored(parse(IdSchema, id));
      return server && visible(server) ? publicServer(server) : undefined;
    },

    async put(id, input) {
      const serverId = parse(IdSchema, id);
      const fields = parse(InputSchema, withoutReadOnly(input));
      const existing = stored(serverId);
      if (existing && scope.job && !mine(existing)) {
        throw new PluginMcpServerError('not_found', `MCP server not found: ${serverId}`);
      }
      await assertMayWrite(serverId, existing, fields.transport, fields.name);
      // A command on the host is a `host:exec`: the operator's allowlist and the
      // denylist of the product's own binaries apply, whoever is the caller.
      if (fields.transport.type === 'stdio') {
        try { assertExecAllowed(scope.pluginId, fields.transport.command); } catch (err) {
          throw new PluginMcpServerError('forbidden', (err as Error).message);
        }
      }
      // The plugin only ever read masked secrets: keep the stored ones where the
      // server still points at the same place, refuse to carry them elsewhere.
      const restored = missionTransport(existing, fields.transport as McpStdioConfig | McpHttpConfig);
      if ('refusal' in restored) throw new PluginMcpServerError('forbidden', restored.refusal);
      let saved: McpServer;
      try {
        saved = upsertMcp({
          id: serverId,
          name: fields.name,
          description: fields.description,
          transport: restored.transport,
          // Stamped at creation only: a later write must not hand an agent's
          // missions a server a human declared as this plugin's.
          createdBy: existing ? existing.created_by : { mission_id: origin, agent: origin },
          // `allowLocalHttp: false` above, whoever the caller.
          publicOnly: true,
        });
      } catch (err) {
        throw new PluginMcpServerError('invalid', (err as Error).message);
      }
      return publicServer(saved);
    },

    async rm(id) {
      const serverId = parse(IdSchema, id);
      const existing = stored(serverId);
      if (!existing) return false;
      if (scope.job && !mine(existing)) throw new PluginMcpServerError('not_found', `MCP server not found: ${serverId}`);
      await assertMayWrite(serverId, existing);
      return deleteMcp(serverId);
    },
  };
}
