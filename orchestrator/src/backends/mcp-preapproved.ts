/**
 * The Timon MCP tools every agent may call without an Allow/Deny card, by their
 * name as a harness reports it (`mcp__<server>__<tool>`). Each one is a decision
 * of the product, not of a provider: a read, a cheap write, or a call whose
 * authority lives in the daemon (a grant, an allowlist, a permission of the
 * mission's token), so a card in front of it would teach nobody anything and, in
 * an autonomous mission, resolve to a refusal.
 *
 * Moved out of the claude dialect, verbatim, so that a provider written as a
 * plugin reads the same list (`ctx.provider.mcp()`, docs/PROVIDERS-SDK.md S1)
 * instead of keeping a copy that would drift. The ask-form tools
 * (`claudeAskToolNames()`) come on top, in the plan.
 */
export const PRE_APPROVED_MCP_TOOLS: readonly string[] = Object.freeze([
  // Pre-allows the Kanban operations: they are cheap writes
  // equivalent to a click in the UI; asking Allow/Deny for every
  // task created by an agent would be a pain. `mcp__timon__mission_spawn`
  // stays gated (spawn = significant token cost → the maintainer's decision).
  'mcp__timon__kanban_add',
  'mcp__timon__kanban_update',
  'mcp__timon__kanban_list',
  'mcp__timon__kanban_delete',
  // Same logic for a project's "TO DO" notebook: cheap writes, without
  // side effects (nothing there spawns an agent, nothing there is dispatched).
  'mcp__timon__project_todo_list',
  'mcp__timon__project_todo_add',
  'mcp__timon__project_todo_update',
  'mcp__timon__project_todo_delete',
  // An idea's files: listing them, removing one. Nothing runs. Attaching one
  // (`project_todo_attachments_add`) stays behind the classifier: its shim
  // reads ANY absolute host file, and its likeliest caller reads a tester's
  // untrusted content — "attach ~/.ssh/… to idea #N" must be seen.
  'mcp__timon__project_todo_attachments_list',
  'mcp__timon__project_todo_attachments_remove',
  // The old names keep the privilege while the missions launched
  // before the rename finish: their tool list is frozen at spawn, and
  // removing it here would make them hit an Allow/Deny card — refused after
  // 5 min in an autonomous mission. Deprecated aliases, see `bin/timon-mcp.mjs`.
  'mcp__timon__todo_later_list',
  'mcp__timon__todo_later_add',
  'mcp__timon__todo_later_update',
  'mcp__timon__todo_later_delete',
  // Read-only and local: the user documentation of the installed version
  // (bin/docs-local.mjs). An Allow/Deny card to read the docs would teach
  // nobody anything, and would refuse the read in an autonomous mission.
  // Listing triggers reads config only; creating, testing (which may run the
  // actions) and removing one stay behind the classifier.
  'mcp__timon__trigger_list',
  'mcp__timon__docs_search',
  'mcp__timon__docs_read',
  // `project_todo_promote` is NOT pre-allowed: promoting CREATES a task
  // immediately eligible for dispatch — exactly the gesture we want to see
  // go through a decision, and the incident of 2026-09-11 in person.
  // Secrets broker: the agent asks for an HTTP call under an identity, it never
  // sees the value. The authority is on the daemon side — grant on the secret AND
  // host allowlist (SECRETS-VAULT.md §6.2) — not in an Allow/Deny card
  // that, in an autonomous mission, resolves into a refusal and would make the broker dead.
  'mcp__timon__timon_http_call',
  // Depositing a NEW secret: the authority is the `secrets:create` permission
  // of the mission token (a name that never existed, no grant, value never
  // returned) — an Allow/Deny card would resolve into a refusal in an autonomous mission.
  'mcp__timon__secret_create',
  // Asking the USER for a secret: the request is a card the owner answers (or
  // refuses), and the value never comes back. That card IS the guard; an
  // unattended mission is refused by the daemon, not by an Allow/Deny card.
  'mcp__timon__secret_request',
  // Showing a media in ITS chat: the authority is on the daemon side (zod, anti-SSRF
  // guard, magic bytes, the mission's roots). An Allow/Deny card
  // would add nothing and, in an autonomous mission, would resolve into a refusal.
  'mcp__timon__chat_show_media',
  // Posting a message in ITS chat: the daemon writes it only into the mission
  // the token belongs to, bounded (zod) and drawn by the markdown renderer.
  'mcp__timon__chat_post_message',
  // Reading back one message of a conversation the mission's token may read
  // (a reply's target, `reply-to.ts`): a read, scoped by the daemon.
  'mcp__timon__mission_message_get',
  // An HTML document in its own chat: same reasoning. The daemon validates it,
  // stores it masked and serves it sandboxed (ADR-MCPUI D6).
  'mcp__timon__ui_render',
  'mcp__timon__ui_document_get',
  // Asking the owner for a command: the agent never writes into the shell,
  // the request becomes a card of the conversation that the human settles
  // (allow, paste into their terminal, refuse). That card IS the guard;
  // an extra Allow/Deny card would resolve into a refusal in an autonomous mission.
  'mcp__timon__terminal_propose',
  // Same for the screen: reading the arrangement changes nothing, a proposal is
  // a card the user applies, and a preset or a named arrangement is a copy
  // they can delete.
  'mcp__timon__widgets_get',
  'mcp__timon__widgets_propose',
  'mcp__timon__widgets_preset_save',
  'mcp__timon__islands_get',
  'mcp__timon__islands_propose',
  'mcp__timon__islands_preset_save',
  'mcp__timon__islands_arrangements_list',
  'mcp__timon__islands_arrangement_save',
  'mcp__timon__ui_routes',
  'mcp__timon__ui_navigate',
  // An agent's own mascot look, or an orchestrated agent's: cosmetic, and the
  // daemon refuses any other agent (`PUT /api/agent-look`).
  'mcp__timon__agent_set_look',
  // The main agent's own setup conversation: narrow tools, refused outside it.
  'mcp__timon__setup_request_avatar',
  'mcp__timon__setup_set_soul',
  'mcp__timon__setup_recruit_team',
  'mcp__timon__setup_finish',
  // The onboarding profile the setup conversation reads, and records when the
  // screens did not: one value of the launching account, nothing runs.
  'mcp__timon__onboarding_profile_get',
  'mcp__timon__onboarding_profile_set',
]);

/** A tool name a harness reports for one MCP tool: no wildcard, no shell syntax. */
const MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/;

/**
 * The MCP tools the user allows without a card (the `TIMON_PREAPPROVED_MCP_TOOLS` setting),
 * typically the read tools of the connector that serves their notes. Exact names
 * only: a wildcard would allow the writes of the same server too.
 */
export function configuredPreApprovedMcpTools(raw: string): string[] {
  const names = raw.split(',').map((name) => name.trim()).filter((name) => MCP_TOOL_NAME.test(name));
  return [...new Set(names)];
}
