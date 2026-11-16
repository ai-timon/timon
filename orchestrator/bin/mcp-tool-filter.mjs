/**
 * Optional allowlist of the stdio server's tools, read from `TIMON_MCP_TOOLS`.
 *
 * Outside a mission the stdio server acts with the operator's daemon token: an
 * MCP client the user starts himself (a desktop assistant, an IDE) then holds
 * every tool of the catalog, deletions, agent creation and secrets included.
 * Such a client often reads untrusted content too (mail, pages, tickets), so
 * the user can narrow it to the gestures it needs.
 *
 * Same grammar as the scopes of a remote MCP token (`src/remote-mcp/tokens.ts`):
 * an exact tool name or a `<prefix>_*` family, never a bare `*`.
 */

const SCOPE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:_\*)?$/;

/**
 * `undefined` (variable unset): no filter, every tool. A value that is set
 * but lists nothing usable is an error rather than "every tool": a typo must
 * not widen what the client holds.
 */
export function parseToolFilter(raw) {
  if (raw === undefined) return null;
  const scopes = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (scopes.length === 0) throw new Error('TIMON_MCP_TOOLS is set but lists no tool');
  const invalid = scopes.filter((s) => !SCOPE_RE.test(s));
  if (invalid.length > 0) {
    throw new Error(`TIMON_MCP_TOOLS: invalid entry ${invalid.join(', ')} (a tool name or a <prefix>_* family)`);
  }
  return scopes;
}

/** Whether `name` falls under the filter; no filter allows everything. */
export function toolAllowed(scopes, name) {
  if (scopes === null) return true;
  return scopes.some((scope) => scope.endsWith('_*')
    ? name.startsWith(scope.slice(0, -1))
    : scope === name);
}

/** Entries that match no tool of the catalog: probably a typo, worth a warning. */
export function unmatchedScopes(scopes, toolNames) {
  if (scopes === null) return [];
  return scopes.filter((scope) => !toolNames.some((name) => toolAllowed([scope], name)));
}
