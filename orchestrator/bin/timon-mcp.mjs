#!/usr/bin/env node
/**
 * TIMON MCP server (official).
 *
 * Spawned by Claude Code as a stdio MCP server, alongside `timon_ask`.
 * Exposes a small set of TIMON-specific tools (Kanban + missions) with
 * explicit names to avoid any confusion with Claude Code harness's internal
 * tools (notably `TaskCreate`, which is the agent's local todo-list, NOT the
 * TIMON Kanban).
 *
 * Tools exposed:
 *   - kanban_add     : creates a TIMON task (visible in the Kanban UI)
 *   - kanban_update  : edits an existing task
 *   - kanban_mark_as_done   : THE closing gesture of a task (resolved from the
 *                      current mission — no id to copy), comment mandatory
 *   - kanban_mark_as_failed : closes a task as BLOCKED with a mandatory reason
 *   - kanban_list    : lists tasks (filterable by status)
 *   - kanban_delete  : deletes a task
 *   - project_todo_* : a project's idea notebook (list/add/update/delete).
 *                      NOTHING is executed from there: no agent is spawned, no
 *                      task is dispatched. `project_todo_promote` turns a ripe
 *                      idea into a PENDING Kanban task, and keeps the link.
 *                      The `todo_later_*` names are DEPRECATED aliases, kept
 *                      only so missions started before the rename keep working.
 *   - trigger_*      : native triggers (create/list/test/remove): schedule,
 *                      signed webhook or internal event → TO DO idea, task or
 *                      notification. The daemon freezes what a trigger may do
 *                      to what the calling token holds.
 *   - memory_rule_add : durably memorizes a rule (writes to memory_rules,
 *                      the table injected at recall — not a dead .md file)
 *   - memory_rule_list : lists memory rules for a scope
 *   - mission_search : full-text search over mission history
 *                      (initial prompt + assistant/user turns)
 *   - timon_http_call : performs an HTTP call under a BROKERED secret identity.
 *                      The daemon checks the grant, checks the host against the
 *                      identity's allowlist, injects the credential and returns
 *                      status + body. The value never reaches the agent.
 *   - secret_create  : deposits a NEW secret (`POST /api/secrets/provision`),
 *                      daemon-generated (the agent never sees it) or supplied.
 *                      Daemon-only until a human grants it; never readable back.
 *   - secret_request : asks the USER for a secret through a masked card
 *                      (`POST /api/secrets/requests`); the value goes from their
 *                      browser to the vault, the agent only learns { name, status }.
 *   - mission_spawn  : launches an agent in an isolated mission (equivalent
 *                      of the CLI `timon spawn`). The sub-agent's stream
 *                      stays in its own mission → no duplication into
 *                      the parent's context.
 *   - agent_create   : creates (or updates) an agent — `POST /api/agents`,
 *                      the same route as `timon agent create`, for packaged
 *                      installs where the CLI is not on the PATH.
 *   - project_create : registers a project — `POST /api/projects`. Its cwd
 *                      must already exist on the host; its workspace must be
 *                      an existing one (or explicitly created).
 *   - project_update : edits a project's metadata — `PUT /api/projects/:slug/meta`.
 *   - workspace_list : lists the workspaces (poles) — `GET /api/workspaces`.
 *   - docs_search / docs_read : the Timon user documentation of the INSTALLED
 *                      version, read locally (bin/docs-local.mjs) — no daemon
 *                      call, no network.
 *
 *
 * The tools that mirror the CLI (agents, skills, MCP servers, missions, Kanban extras,
 * projects, memory, notify, browser, system) live in `mcp-tools-*.mjs`, one module per
 * domain, and are merged into this server at load (`EXTRA_MODULES`).
 *
 * All calls go through the orchestrator's REST endpoints on
 * TIMON_ORCH_URL (default http://localhost:3000).
 * TIMON_MCP_TOOLS (optional): comma-separated tool names or `<prefix>_*`
 * families; only those are listed and callable (`mcp-tool-filter.mjs`).
 * Token (4.2b): TIMON_API_TOKEN, otherwise ~/.timon/daemon-token (under TIMON_HOME),
 * the latter only when TIMON_ORCH_URL is this home's own local listener.
 */
import readline from 'node:readline';
import { TOOLS, runTool, stdioContext, TextResult } from './timon-mcp-catalog.mjs';
import { parseToolFilter, toolAllowed, unmatchedScopes } from './mcp-tool-filter.mjs';

let toolFilter;
try {
  toolFilter = parseToolFilter(process.env.TIMON_MCP_TOOLS);
} catch (err) {
  // A misconfigured filter must not start a server with more tools than meant.
  process.stderr.write(`[timon-mcp] ${err.message}\n`);
  process.exit(1);
}
for (const scope of unmatchedScopes(toolFilter, TOOLS.map((t) => t.name))) {
  process.stderr.write(`[timon-mcp] TIMON_MCP_TOOLS: ${scope} matches no tool\n`);
}
const LISTED_TOOLS = TOOLS.filter((t) => toolAllowed(toolFilter, t.name));

const rl = readline.createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const id = msg.id;

  if (msg.method === 'initialize') {
    return send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'timon', version: '1.0.0' },
      },
    });
  }

  if (msg.method === 'notifications/initialized') return;

  if (msg.method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: LISTED_TOOLS } });
  }

  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    if (toolFilter !== null && (typeof name !== 'string' || !toolAllowed(toolFilter, name))) {
      return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `tool not allowed by TIMON_MCP_TOOLS: ${name}` } });
    }
    try {
      const result = await runTool(name, args, stdioContext());
      return send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: result instanceof TextResult ? result.text : JSON.stringify(result) }] },
      });
    } catch (err) {
      return send({
        jsonrpc: '2.0', id,
        result: {
          isError: true,
          content: [{ type: 'text', text: String(err?.message || err) }],
        },
      });
    }
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
});

process.stdin.resume();
