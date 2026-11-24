/**
 * `@timon-ai/sdk/provider` — what a provider author writes an LLM provider
 * AGAINST: the contract's types, its constants, and the few guards that decide
 * nothing by themselves.
 *
 * The BEHAVIOUR is not here. Codecs, the usage-limit detector, the session
 * drivers, the MCP serializers and the ACP client come from the daemon, through
 * `ctx.provider.runtime` (API 12): one copy, the daemon's, so a fix reaches every
 * installed plugin without its author publishing again. Your dialect is built from
 * `ctx.provider.runtime` (its `events`, `jsonLines`, `limits`…), usually by a factory
 * the plugin's `apply` calls (`createMyDialect(ctx.provider.runtime)`), so that your
 * tests can hand it the same object — `@timon-ai/sdk/testing` builds a stand-in `ctx` that carries a
 * copy of the daemon's runtime for tests run outside the daemon.
 *
 * This entry point is built to run outside the repository: every module it
 * reaches is free of the daemon (no database, no host adapter, no settings),
 * which a test in the repository enforces. Because nothing here holds state or
 * behaviour, nothing depends on identity: errors are recognised by `code`,
 * drivers by brand (`isLineSessionDriver`), never by `instanceof`.
 *
 * Declare `apiVersion: 12` in the plugin manifest to use `ctx.provider`: from that
 * version the daemon also refuses, at registration, a dialect whose declarations
 * contradict each other (`runtime.check.dialectProblems` tells you the same thing
 * before you ship).
 * @packageDocumentation
 */

/* ── The contract: constants, guards, and the types a dialect is written against ── */
export {
  APPROVAL_SCOPES,
  ASSISTANT_DELTA,
  BACKEND_CAPABILITIES,
  DEFAULT_BACKEND_CAPABILITIES,
  NO_SESSION_CAPABILITIES,
  PERMISSION_MODELS,
  PROVIDER_RETRY,
  PROVIDER_RETRY_KINDS,
  RATE_LIMIT_REPORTINGS,
  REMOTE_RESUME_MAX_BYTES,
  SESSION_STORES,
  isRemoteDialect,
  probeLaunchContext,
} from '../../../orchestrator/src/backends/types.js';
export type {
  AccountUsage, AnyDialect, ApprovalScope, AssistantDeltaPayload, Backend, BackendCapabilities, BackendCapability,
  BackendLaunchContext, BackendName, BackendProfile, BuildSpawnOpts, Dialect, DiscoveredModel, EnvResolver,
  EnvValue, ImageAttachment, LocalEnvPolicy, NormalizedEvent, OpenSpan, PermissionDecision, PermissionModel,
  PermissionRequest, PermissionWait, ProfileRuntime, ProviderConfig, ProviderRetryKind, ProviderRetryPayload, RateLimitReporting, RegisteredProfile, RemoteDialect,
  RemoteResumeState, RemoteSessionHost, RemoteSessionOpenArgs, RemoteSessionResume, SecretRef, SessionCapabilities,
  SessionAnswer, SessionAskOutcome, SessionAskRequest, SessionDriver, SessionEnd, SessionHost, SessionInfo, SessionOpenArgs,
  SessionQuestion, SessionQuestionOption, SessionStdio, SessionStore, SpanOp,
  SpanState, SpawnResult, TurnOutcome, UsageProbeOptions, UsageWindow,
} from '../../../orchestrator/src/backends/types.js';
export type { ProviderAgentConfig } from '../../../orchestrator/src/backends/provider-agent-config.js';
export type {
  ProviderPluginContext, ProviderServices, ProviderSettingValue,
} from '../../../orchestrator/src/backends/provider-plugin-context.js';
export type {
  ProviderScratchDir, ScratchLinkMethod, ScratchWriteOptions,
} from '../../../orchestrator/src/backends/scratch-dir.js';
export type { ProviderRuntime } from '../../../orchestrator/src/backends/provider-runtime.js';
export type {
  ProviderEnvPlan, ProviderMcpOptions, ProviderMcpPlan, ProviderMcpRole, ProviderMcpServer, ProviderRedact, ProviderScratch,
  ProviderAccount, ProviderAccountContext, ProviderAccountOsCredential, ProviderAccountOsCredentialHold, ProviderAccountOsCredentialRemoval, ProviderBinary, ProviderGeneratedMedia, ProviderMedia, ProviderOsCredentials, ProviderProbeOptions, ProviderProbeResult,
  ProviderCredentialStore, ProviderConversation, ProviderConverseOptions, ProviderGit, ProviderServeOptions, ProviderServer,
} from '../../../orchestrator/src/backends/provider-services.js';
export type { CatalogModel } from '../../../orchestrator/src/backends/catalog-model.js';
export type {
  DeclaredReasoningControl, ModelReasoning, ReasoningControl,
} from '../../../orchestrator/src/backends/reasoning-control.js';
export type { SpanKind, SpanStatus } from '../../../orchestrator/src/backends/span-types.js';
export { SPAN_KINDS, SPAN_STATUSES } from '../../../orchestrator/src/backends/span-types.js';

/* ── Transports: the shape of a provider, and the guards that read it ── */
export { isRemoteDefinition, PROVIDER_TRANSPORTS } from '../../../orchestrator/src/backends/engine/definition.js';
export { isLineSessionDriver, LINE_SESSION_DRIVER } from '../../../orchestrator/src/backends/engine/driver-brand.js';
export { DEFAULT_MAX_LINE_CHARS } from '../../../orchestrator/src/backends/engine/line-splitter.js';
export type {
  LegacyLaunch, LifecycleStrategy, LimitsStrategy, LineSessionOptions, LineSplitterOptions, LinesCodec, McpStrategy,
  LaunchStrategy, ModelsStrategy, NativeProviderDefinition, PermissionStrategy, ProcessDriverCodec, ProcessProviderDefinition,
  ProcessSessionArgs, ProviderDefinition, ReasoningStrategy,
  ProviderTransportKind, RemoteDriverCodec, RemoteProviderDefinition, SessionStrategy, UsageStrategy,
} from '../../../orchestrator/src/backends/engine/index.js';

/* ── Vocabulary: the types and constants of what a codec produces and the daemon reads ── */
export type {
  ProviderAuthStatus, ProviderBinaryDeclaration, ProviderBinaryIdentity, ProviderBrand, ProviderUnverified, UnverifiedSubject, ProviderDeclarations, ProviderDesktopBuild,
  ProviderAccountsDeclaration, ProviderInstallPlan, ProviderLoginDriver, ProviderLoginIdentity, ProviderLoginPrompt,
  ProviderLoginRun, ProviderServiceNeed, InstallPlatform, PackageManagerName, TemplateContext,
} from '../../../orchestrator/src/backends/provider-declarations.js';
export {
  BINARY_IDENTITY_MAX_PATTERN, INSTALL_PLATFORMS, MAX_BRAND_SVG_BYTES, PACKAGE_MANAGERS, SERVICE_NEEDS, UNVERIFIED_NOTE_MAX_CHARS,
  UNVERIFIED_SUBJECTS,
} from '../../../orchestrator/src/backends/provider-declarations.js';
export { MODEL_TIERS } from '../../../orchestrator/src/backends/catalog-model.js';
export type { ModelTier } from '../../../orchestrator/src/backends/catalog-model.js';
export type { TokenUsage } from '../../../orchestrator/src/backends/codecs/events.js';
export type { RpcId, RpcMessage } from '../../../orchestrator/src/backends/codecs/acp-rpc.js';
export {
  RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND,
} from '../../../orchestrator/src/backends/acp/wire.js';
export type { AcpMcpServer, AcpRecord, AcpUsage } from '../../../orchestrator/src/backends/acp/wire.js';
export type { AcpAgentSpec, AcpProviderServices } from '../../../orchestrator/src/backends/acp/provider.js';
export type { AcpSignIn } from '../../../orchestrator/src/backends/acp/auth.js';
export type {
  AcpCardAnswer, AcpCardOption, AcpCardOutcome, AcpCardQuestion, AcpExtensionCards, AcpExtensionHandler, AcpPlanApproval, AcpPlanVerdict,
} from '../../../orchestrator/src/backends/acp/extensions.js';
export type { RateLimitHit } from '../../../orchestrator/src/rate-limit.js';
export { USAGE_NOT_SIGNED_IN } from '../../../orchestrator/src/backends/usage-error.js';
export type { McpLaunchHttp, McpLaunchServer, McpLaunchStdio } from '../../../orchestrator/src/backends/mcp-serialize.js';
export type { RefreshedToken } from '../../../orchestrator/src/backends/oauth-store.js';

/* ── Names Timon's MCP servers and tools go by, and what each permission model asks of a provider ── */
export {
  ASK_MCP_FORMS_ONLY_ENV, ASK_MCP_SERVER, ASK_TOOL_KANBAN_PLAN, ASK_TOOL_QUESTION, ASK_TOOL_REQUEST,
  CLAUDE_PERMISSION_PROMPT_TOOL,
} from '../../../orchestrator/src/ask-mcp.js';
export { PERMISSION_MODEL_OBLIGATIONS, PERMISSION_MODES } from '../../../orchestrator/src/backends/permission-models.js';
export type { NestedSandboxDeclaration, PermissionMode } from '../../../orchestrator/src/backends/permission-models.js';
