/**
 * Declaring MCP servers to a CLI. Each CLI has its own file format for the same
 * list — claude (and copilot) a JSON blob passed on the command line, codex and
 * grok a TOML table written into the mission's config, an ACP agent the
 * `mcpServers` of `session/new` — and getting one wrong costs the agent its
 * tools without a visible error.
 *
 * These are PURE: they take the list already resolved (an OAuth server turned
 * into the daemon's relay, the key decided) and write text. Looking servers up and refreshing
 * their tokens is the daemon's, because only it holds them; a provider asks the
 * daemon for the list and serializes it here, so what a plugin writes for its
 * CLI and what the product writes for its own are one code path.
 */

import { CODEX_MCP_APPROVAL_TOML } from './codex-mcp-approval.js';
import { PACKAGE_CACHE_ENV_NAMES } from './package-cache-env.js';
import type { AcpMcpServer } from './acp/wire.js';

export type McpLaunchStdio = {
  readonly type: 'stdio';
  /** The key the CLI knows the server by (`mcp__<key>__<tool>`). */
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

export type McpLaunchHttp = {
  readonly type: 'http';
  readonly name: string;
  readonly url: string;
  /** Final headers. An OAuth server is the daemon's relay here: its relay token, never the bearer. */
  readonly headers: Readonly<Record<string, string>>;
};

export type McpLaunchServer = McpLaunchStdio | McpLaunchHttp;

function tomlString(v: string): string {
  return JSON.stringify(v); // JSON's string syntax is a strict subset of TOML basic-string syntax.
}

function tomlBareOrQuoted(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

/** A TOML bare-key safe table name. */
function tomlKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '_');
}

/** `{ mcpServers: { <name>: … } }` as claude's `--mcp-config` and copilot's
 *  `--additional-mcp-config` read it. `null` when there is nothing to declare. */
export function serializeMcpJson(servers: readonly McpLaunchServer[]): string | null {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    if (s.type === 'stdio') {
      mcpServers[s.name] = { command: s.command, args: [...s.args], env: { ...s.env } };
    } else {
      mcpServers[s.name] = {
        type: 'http',
        url: s.url,
        ...(Object.keys(s.headers).length ? { headers: { ...s.headers } } : {}),
      };
    }
  }
  if (Object.keys(mcpServers).length === 0) return null;
  return JSON.stringify({ mcpServers });
}

/**
 * `[mcp_servers.*]` blocks for a codex `config.toml`. Every block carries
 * `default_tools_approval_mode`: without it codex ≥ 0.147 cancels MCP tool calls
 * in `exec` mode for lack of an approval channel (`CODEX_MCP_APPROVAL_TOML`).
 * It is written BEFORE any sub-table, since in TOML a key after a `[header]`
 * belongs to that table.
 */
export type CodexMcpTomlOptions = {
  /**
   * The variables of codex's own environment to hand on to a stdio server (`env_vars`), by name: codex does
   * not let its MCP servers inherit its environment, so a server that needs the mission's token has to be
   * told which variable to ask for. The NAME is written, never a value. Every stdio server also asks for
   * the package cache variables (`PACKAGE_CACHE_ENV_NAMES`), which a fenced mission's CLI carries: an
   * `npx -y` server cannot write the user's cache under the fence. codex skips a name its environment
   * lacks (checked on codex 0.167), so an unfenced mission is unchanged.
   */
  readonly forward?: (server: McpLaunchServer) => readonly string[];
};

export function serializeCodexMcpToml(servers: readonly McpLaunchServer[], options: CodexMcpTomlOptions = {}): string | null {
  const blocks: string[] = [];
  for (const s of servers) {
    const key = tomlKey(s.name);
    const lines: string[] = [`[mcp_servers.${key}]`];
    if (s.type === 'stdio') {
      lines.push(`command = ${tomlString(s.command)}`);
      if (s.args.length) lines.push(`args = [${s.args.map(tomlString).join(', ')}]`);
      const forwarded = [...new Set([...(options.forward?.(s) ?? []), ...PACKAGE_CACHE_ENV_NAMES])];
      if (forwarded.length) lines.push(`env_vars = [${forwarded.map(tomlString).join(', ')}]`);
      lines.push(CODEX_MCP_APPROVAL_TOML);
      const envKeys = Object.keys(s.env);
      if (envKeys.length) {
        lines.push('');
        lines.push(`[mcp_servers.${key}.env]`);
        for (const k of envKeys) lines.push(`${tomlBareOrQuoted(k)} = ${tomlString(s.env[k] ?? '')}`);
      }
    } else {
      lines.push(`url = ${tomlString(s.url)}`);
      lines.push(CODEX_MCP_APPROVAL_TOML);
      const headerKeys = Object.keys(s.headers);
      if (headerKeys.length) {
        const entries = headerKeys.map((k) => `${tomlString(k)} = ${tomlString(s.headers[k] ?? '')}`).join(', ');
        lines.push(`http_headers = { ${entries} }`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  if (!blocks.length) return null;
  return blocks.join('\n\n') + '\n';
}

/**
 * The same for a grok `config.toml`, whose vocabulary differs from codex's on
 * three points checked against the CLI: each server carries `enabled = true`,
 * HTTP headers live in a `[mcp_servers.<x>.headers]` sub-table, and there is no
 * approval key (grok does not cancel MCP calls for lack of a channel).
 */
export function serializeGrokMcpToml(servers: readonly McpLaunchServer[]): string | null {
  const blocks: string[] = [];
  for (const s of servers) {
    const key = tomlKey(s.name);
    const lines: string[] = [`[mcp_servers.${key}]`];
    if (s.type === 'stdio') {
      lines.push(`command = ${tomlString(s.command)}`);
      if (s.args.length) lines.push(`args = [${s.args.map(tomlString).join(', ')}]`);
      lines.push('enabled = true');
      const envKeys = Object.keys(s.env);
      if (envKeys.length) {
        // Sub-table AFTER the parent's pairs: whatever follows a `[header]` belongs to it.
        lines.push('');
        lines.push(`[mcp_servers.${key}.env]`);
        for (const k of envKeys) lines.push(`${tomlBareOrQuoted(k)} = ${tomlString(s.env[k] ?? '')}`);
      }
    } else {
      lines.push(`url = ${tomlString(s.url)}`);
      lines.push('enabled = true');
      const headerKeys = Object.keys(s.headers);
      if (headerKeys.length) {
        lines.push('');
        lines.push(`[mcp_servers.${key}.headers]`);
        for (const k of headerKeys) lines.push(`${tomlBareOrQuoted(k)} = ${tomlString(s.headers[k] ?? '')}`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  if (!blocks.length) return null;
  return blocks.join('\n\n') + '\n';
}

/** `env` as the `[{ name, value }]` pairs ACP wants. */
export function mcpEnvPairs(env: Readonly<Record<string, string>> | undefined): Array<{ name: string; value: string }> {
  return Object.entries(env ?? {}).map(([name, value]) => ({ name, value }));
}

/**
 * The stdio servers of `session/new.mcpServers`. An HTTP server is returned in
 * `skipped` rather than declared: its ACP shape was not verified on any agent,
 * and a wrong one fails the whole `session/new`, not that server alone.
 */
export function serializeAcpMcpServers(servers: readonly McpLaunchServer[]): { servers: AcpMcpServer[]; skipped: string[] } {
  const out: AcpMcpServer[] = [];
  const skipped: string[] = [];
  for (const s of servers) {
    if (s.type !== 'stdio') { skipped.push(s.name); continue; }
    out.push({ name: s.name, command: s.command, args: [...s.args], env: mcpEnvPairs(s.env) });
  }
  return { servers: out, skipped };
}
