

// Moved from `plugins/mcp-servers-facade.ts`, which re-exports it (TODO #512, volet 3).
export type ScopedMcpServers = {
  list(): Promise<PluginMcpServerSummary[]>;
  get(id: string): Promise<PluginMcpServer | undefined>;
  put(id: string, input: PluginMcpServerInput): Promise<PluginMcpServer>;
  /** `true` when the server existed. */
  rm(id: string): Promise<boolean>;
};
/** Public plugin types, extracted from the host implementations (TODO #512). */

// Moved from `oauth.ts`, which re-exports it (TODO #512, volet 3).
export type OAuthClient = {
  client_id: string;
  client_secret?: string;
};

export type OAuthMetadata = {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
};

export type OAuthTokens = {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  /** Absolute epoch ms when access_token expires (computed from expires_in). */
  expires_at?: number;
  scope?: string;
};

// Moved from `mcp.ts`, which re-exports it (TODO #512, volet 3).
export type McpServer = {
  id: string;
  /** Display name. Defaults to id when not set. */
  name?: string;
  /** Free-form description shown on /mcp. */
  description?: string;
  transport: McpStdioConfig | McpHttpConfig | McpExternalConfig;
  /** Last-seen connection status, populated from system:init events. */
  last_status?: 'connected' | 'needs-auth' | 'failed' | 'unknown';
  last_seen_at?: number;
  /** Cached tool names belonging to this server (from system:init.tools[]). */
  tools_cache?: string[];
  tools_cached_at?: number;
  /** Origin of this entry. 'timon' = user added via /mcp; 'claude_ai' =
   *  auto-discovered from claude's system:init, a claude.ai account connector;
   *  'claude_cli' = auto-discovered too, but declared in the user's own claude
   *  configuration (~/.claude.json, a project's .mcp.json, a claude plugin). */
  source?: McpSource;
  /** Set when a mission declared the server: which one, and for which agent. */
  created_by?: { mission_id: string; agent: string };
  /** `true`: its url was admitted only because it resolved to public addresses
   *  (a mission or a plugin without agents:privileged-config wrote it): each
   *  launch resolves it again, leaves the server out if it no longer does, and
   *  routes the agent through a proxy pinned to the address it checked.
   *  `false`: a mission holding agents:privileged-config wrote it last. Absent
   *  on a server a mission declared: written before the rule, held to it at
   *  boot (TODO #577). */
  public_only?: boolean;
  /** Set when the server was connected from the Apps catalogue
   *  (`@timon/mcp-apps`): the slug of its entry. Disconnecting from Apps only
   *  ever removes a server that carries it, never one a user added by hand. */
  app_slug?: string;
};

export type McpSummary = Omit<McpServer, 'transport'> & {
  transport_type: McpTransport;
  tools_count: number;
  oauth_status: OAuthStatus;
  /** Set when agents are not given the server: `vault_off`, it carries a
   *  credential (OAuth, headers) that only the daemon's relay hands on, and the
   *  relay needs the secrets vault, which is switched off. */
  held_back?: 'vault_off';
};

/**
 * External MCPs are loaded by claude itself (claude.ai account-level
 * connectors) and surface in system:init even though TIMON never spawned
 * them. We auto-persist a stub so they show up in the list and can be
 * toggled per agent — but the toggle goes through agent.disallowed_tools,
 * not the .mcp.json blob, since we can't unload them from claude.
 */
export type McpExternalConfig = {
  type: 'external';
  /** The exact server name claude uses (becomes the tool prefix
   *  mcp__<key>__*, with non-alnum replaced by underscores). */
  claude_key: string;
};

export type McpHttpConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  /**
   * OAuth state for this server. Populated by the /api/mcp/:id/oauth/* routes.
   * When present, a launch hands the CLI the daemon's relay instead of the
   * server (`mcp-relay.ts`): the relay adds the bearer, refreshed when due.
   */
  oauth?: {
    metadata: OAuthMetadata;
    client: OAuthClient;
    tokens?: OAuthTokens;
    redirect_uri: string;
  };
};

export type McpSource = 'timon' | 'claude_ai' | 'claude_cli';

export type McpStdioConfig = {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpTransport = 'stdio' | 'http' | 'external';

export type OAuthStatus = 'none' | 'pending' | 'authorized' | 'expired';

/** A server as a plugin reads it: no secret value, `mine` for its own. */
export type PluginMcpServer = Omit<McpServer, 'created_by'> & {
  /** Declared by THIS plugin: `put` and `rm` accept it. */
  mine: boolean;
  /** `plugin:<id>` for a plugin, the agent's name for a mission, `null` for a human. */
  createdBy: string | null;
};

export type PluginMcpServerSummary = Omit<McpSummary, 'created_by'> & { mine: boolean; createdBy: string | null };

export type PluginMcpServerInput = {
  name?: string;
  description?: string;
  /** `http`; `stdio` only for a superadmin's request. */
  transport:
    | { type: 'http'; url: string; headers?: Record<string, string> }
    | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };
};

export type PluginMcpServerErrorCode = 'invalid' | 'not_found' | 'forbidden';
