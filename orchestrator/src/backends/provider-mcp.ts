/**
 * S1 — `ctx.provider.mcp()`: Timon's MCP servers for one mission, as the daemon
 * composes them for its own providers (the official provider plugins),
 * in a neutral shape a plugin serializes for its CLI.
 *
 * The daemon composes; the plugin writes. What the plugin must not hold travels as
 * a reference (`launch-seal.ts`): the mission's token in the identity environment,
 * and every value of the user's own servers that could be a credential (the
 * variables of a stdio server, the headers of an HTTP one). A server connected
 * by OAuth is not even that: its bearer stays in the daemon, and the CLI is
 * handed the daemon's relay with a token for this agent and mission (`mcp-relay.ts`). Outside a launch there is no seal, hence nothing to swap: the plan
 * carries no identity token and none of the user's servers — a probe has no
 * mission whose servers to list, and a caller could otherwise name any server.
 */

import { apiBaseUrl } from '../api-url.js';
import { TIMON_HOME } from '../paths.js';
import { config } from '../config/load.js';
import { searchPolicy, PARALLEL_SEARCH_SERVER } from '../web-search.js';
import { settingStr } from '../settings.js';
import { nodeRuntime, type NodeRuntime } from '../host/node-runtime.js';
import { ASK_MCP_FORMS_ONLY_ENV, ASK_MCP_SERVER, CLAUDE_PERMISSION_PROMPT_TOOL, claudeAskToolNames } from '../ask-mcp.js';
import { CHROME_DEVTOOLS_MCP_KEY, chromeDevtoolsMcpEntry, noteBrowserSessionSpawned } from '../browser-mcp.js';
import { getMcp, grepaiMcpEntry, resolveLaunchServers, listMcp, isDiscoveredMcp } from '../mcp.js';
import { isInjectedMcpServer } from '../injected-mcp.js';
import { mcpRelayLaunchTarget } from '../mcp-relay.js';
import { COMMAND_POLICY } from './command-policy.js';
import type { LaunchSeal } from './launch-seal.js';
import { PRE_APPROVED_MCP_TOOLS, configuredPreApprovedMcpTools } from './mcp-preapproved.js';
import type { McpLaunchServer } from './mcp-serialize.js';
import type { ProviderMcpOptions, ProviderMcpPlan, ProviderMcpServer } from './provider-services.js';
import type { BuildSpawnOpts } from './types.js';
import { resolve } from 'node:path';
import { mcpScriptPaths } from './mcp-paths.js';
const { timon: TIMON_MCP_PATH, forms: PERMISSION_MCP_PATH } = mcpScriptPaths(resolve(import.meta.dirname, '..', '..'), { timon: process.env.TIMON_MCP_PATH, forms: process.env.TIMON_PERMISSION_MCP_PATH });

/** The agent's own servers, minus the ones Timon injects itself: an entry of the agent's named like the project's index or browser would shadow the one bound to this project. */
function userServerIds(spawn: BuildSpawnOpts): string[] {
  const { cfg } = spawn;
  return (cfg.mcp_servers ?? []).filter((id) => {
    if (id === 'grepai') return false;
    if (cfg.browser_profile_id === undefined) return true;
    const server = getMcp(id);
    const key = (server?.name && /^[A-Za-z0-9_-]+$/.test(server.name) ? server.name : id).replace(/[^A-Za-z0-9_-]+/g, '_');
    return key !== CHROME_DEVTOOLS_MCP_KEY;
  });
}

/** Every value of a user server that could be a credential, swapped for a reference. */
function withoutSecrets(server: McpLaunchServer, seal: LaunchSeal): McpLaunchServer {
  const hide = (value: string): string => seal.protect(value);
  const map = (record: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, hide(value)]));
  return server.type === 'stdio'
    ? { ...server, env: map(server.env) }
    : { ...server, headers: map(server.headers) };
}

export async function providerMcpPlan(input: {
  spawn: BuildSpawnOpts;
  /** The launch in progress, if the caller is the plugin of its backend. */
  seal: LaunchSeal | undefined;
  options?: ProviderMcpOptions;
  /** Tests only: the Node that runs Timon's own servers. */
  node?: NodeRuntime;
}): Promise<ProviderMcpPlan> {
  const { spawn, seal } = input;
  const { cfg } = spawn;
  const daemonUrl = apiBaseUrl();
  const permissionPrompt = input.options?.permissionPrompt === true;
  const tokenRef = seal?.tokenRef();
  const identityEnv: Record<string, string> = {
    TIMON_ORCH_URL: daemonUrl,
    TIMON_MISSION_ID: spawn.missionId,
    TIMON_AGENT: spawn.agentName,
    ...(tokenRef ? { TIMON_API_TOKEN: tokenRef } : {}),
  };

  const servers: ProviderMcpServer[] = [];
  // Timon's own servers, unless the backend declares `timonMcp: false`.
  if (spawn.timonMcp !== false) {
    // The Node the daemon itself runs on when packaged (Electron's binary as Node): a CLI
    // installed without Node — claude's native installer — cannot start `node <script>`,
    // and the permission tool is then reported missing (TODO #486). `node` from sources.
    const node = input.node ?? nodeRuntime(config());
    // `TIMON_HOME` explicitly: a CLI that filters its MCP servers' environment
    // (codex) would otherwise leave the shim guessing where the daemon keeps
    // the files it points a local agent at (`project_todo_attachments_list`).
    servers.push({
      role: 'timon', type: 'stdio', name: 'timon', command: node.command, args: [TIMON_MCP_PATH],
      env: { ...identityEnv, TIMON_HOME, ...node.env },
    });
    servers.push({
      role: 'forms', type: 'stdio', name: ASK_MCP_SERVER, command: node.command, args: [PERMISSION_MCP_PATH],
      // `request` is listed only for a CLI that routes permission prompts to it:
      // otherwise nothing calls it, and it is kept out of the model's tool list.
      env: { ...identityEnv, ...node.env, ...(permissionPrompt ? {} : { [ASK_MCP_FORMS_ONLY_ENV]: '1' }) },
    });
  }
  // The project's index serves file contents: a mission that must read no file (the conversion of a
  // browser recording, TODO #471) is not handed it.
  const grepai = spawn.readOnlyTools ? null : grepaiMcpEntry(cfg.cwd);
  if (grepai) servers.push({ role: 'grepai', type: 'stdio', name: 'grepai', command: grepai.command, args: grepai.args, env: {} });
  const browser = chromeDevtoolsMcpEntry(cfg);
  if (browser) {
    servers.push({
      role: 'browser', type: 'stdio', name: CHROME_DEVTOOLS_MCP_KEY, command: browser.command, args: browser.args,
      env: { ...(browser.env ?? {}), ...identityEnv },
    });
    // The one moment we know an agent just hooked onto the project's browser for
    // this mission. A probe asks for the plan without launching anything.
  }
  const ids = seal ? userServerIds(spawn) : [];
  if (seal && ids.length) {
    // An OAuth server becomes the daemon's relay, bound to this agent and this mission:
    // the CLI's configuration holds a relay token, never the bearer.
    const relay = (server: { id: string; url: string }) =>
      mcpRelayLaunchTarget(server, { agent: spawn.agentName, missionId: spawn.missionId });
    for (const server of await resolveLaunchServers(ids, relay)) {
      servers.push({ ...withoutSecrets(server, seal), role: 'user' });
    }
  }

  const webSearch = searchPolicy(spawn, seal?.backend, servers);
  seal?.injectedMcpServers.delete(PARALLEL_SEARCH_SERVER.name);
  if (webSearch.mode === 'parallel') {
    // Only the managed search one-shot needs this isolation; preserve other
    // providers' and native one-shots' existing server composition.
    if (spawn.oneShot) {
      for (let i = servers.length - 1; i >= 0; i--) {
        if (servers[i]!.role === 'grepai' || servers[i]!.role === 'browser') servers.splice(i, 1);
      }
    }
    servers.push(PARALLEL_SEARCH_SERVER);
    seal?.injectedMcpServers.add(PARALLEL_SEARCH_SERVER.name);
  }
  if (seal && servers.some((server) => server.role === 'browser')) noteBrowserSessionSpawned(cfg);

  return Object.freeze({
    webSearch,
    servers: Object.freeze(servers),
    identityEnv: Object.freeze(identityEnv),
    daemonUrl,
    scripts: Object.freeze({ timon: TIMON_MCP_PATH, forms: PERMISSION_MCP_PATH }),
    permissionTool: permissionPrompt && spawn.timonMcp !== false ? CLAUDE_PERMISSION_PROMPT_TOOL : null,
    preApprovedTools: Object.freeze([...claudeAskToolNames(), ...PRE_APPROVED_MCP_TOOLS, ...configuredPreApprovedMcpTools(settingStr('TIMON_PREAPPROVED_MCP_TOOLS'))]),
    excludedServers: Object.freeze(seal ? listMcp().flatMap((summary) => {
      if (!isDiscoveredMcp(summary) || !cfg.excluded_mcp_servers?.includes(summary.id)) return [];
      const full = getMcp(summary.id);
      const name = full?.transport.type === 'external' ? full.transport.claude_key : summary.name || summary.id;
      return isInjectedMcpServer(name) ? [] : [name];
    }) : []),
    commandPolicy: COMMAND_POLICY,
  });
}
