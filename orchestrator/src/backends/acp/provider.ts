/**
 * An ACP agent as DATA (`docs/PROVIDERS-SDK.md` § 7.1, § 10.2): the table `AGENTS`
 * of the old `acp` dialect was closed — three rows in the core — and each new agent
 * meant a branch in the protocol code. Here an agent is a row a plugin writes
 * (`official-providers/provider-acp/lib/agents.js` carries opencode, Hermes and Pi):
 * the command that puts the binary in ACP mode, whether the agent arbitrates its
 * own tool uses, and the few things only it knows. The protocol — transport,
 * session driver, event mapper, permissions through the card and the classifier —
 * is the daemon's, supplied through `ctx.provider.runtime.acp`.
 *
 *   const runtime = ctx.provider.runtime;
 *   ctx.provider.registerProvider(runtime.acp.defineProvider(ctx.provider, {
 *     id: 'cursor', args: ['acp'], binary: { names: ['cursor-agent', 'agent'] },
 *   }));
 *
 * What an agent's own quirks need beyond a row is a hook in ITS plugin, never a
 * branch here (Orca's rule: "the lifecycle and the identity of the lines stay
 * shared"). The Timon MCP servers of the session come from `services.mcp`
 * (S1), so the identity travels as a reference the daemon swaps on the pipe.
 *
 * Leaf: the driver is given pipes, never a process.
 */

import type { NativeProviderDefinition } from '../engine/definition.js';
import { serializeAcpMcpServers } from '../mcp-serialize.js';
import type { ProviderDeclarations, ProviderBinaryDeclaration } from '../provider-declarations.js';
import type { ProviderMcpOptions, ProviderMcpPlan } from '../provider-services.js';
import type { BuildSpawnOpts } from '../types.js';
import type { ModelsStrategy, ProcessDriverCodec } from '../engine/definition.js';
import { AcpSessionDriver } from './driver.js';
import { discoverAcpModels } from './models.js';
import type { AcpConversation } from './conversation-transport.js';
import { extractAcpSessionId } from './events.js';
import type { AcpSignIn } from './auth.js';
import { acpExtensionMethodProblem, type AcpExtensionHandler } from './extensions.js';

/** What a plugin writes for an ACP agent. */
export type AcpAgentSpec = {
  /** The id of the provider (and of the dialect): `cursor`, `opencode`. */
  readonly id: string;
  /** Arguments that put the binary in ACP mode: `['acp']` for a CLI whose subcommand speaks the protocol, `[]` for a binary that speaks it as launched. */
  readonly args: readonly string[];
  /** The binary (C1), as for any provider. */
  readonly binary: ProviderBinaryDeclaration;
  /**
   * The agent arbitrates its own tool uses and never sends `session/request_permission`
   * (opencode refuses a write outside its working directory without asking). Declared,
   * not guarded: Timon adds no check of its own. Default false — the safe side, since a
   * request that never comes costs nothing and a guard assumed away would.
   */
  readonly permissionsByAgent?: boolean;
  /** What to tell a user whose agent answers `auth_required`: the command its own CLI offers to sign in (a browser flow or a terminal wizard Timon cannot run for them). Nothing the agent wrote is echoed. */
  readonly signIn?: AcpSignIn;
  /**
   * The id of the auth method to try, once, when `session/new` answers `auth_required` and the agent announced
   * that id (`authMethods` of `initialize`): Cursor's `cursor_login` reuses the sign-in `cursor-agent login` stored.
   * Absent = never call `authenticate`. A refusal falls back to `signIn`'s sentence.
   */
  readonly authenticateWith?: string;
  /** Everything else the provider declares (credential folders, passthrough variables, accounts, one-shot…). Spans are always the stream-json ones. */
  readonly declares?: Omit<ProviderDeclarations, 'binary' | 'spans'>;
  /** The models the agent lists without a session of its own (its own strategy). Exclusive with `modelProbe`. */
  readonly models?: ModelsStrategy;
  /**
   * Ask the agent itself for its models (`session/new`; needs `services.binary`): which models
   * opencode or Hermes offer depends on the account and on what the user configured, so a list
   * written in the product is right for nobody. The probe leaves an EMPTY session in the agent's
   * own history — hence a 12 h cache and a start in Timon's home, not in a project.
   */
  readonly modelProbe?: 'session-new';
  /** Environment for the agent's process, on top of the profile's. */
  env?(spawn: BuildSpawnOpts): Record<string, string>;
  /**
   * Environment that confines the agent in a daemon one-shot (`BuildSpawnOpts.oneShot`: summary,
   * title, memory pass), on top of `env`. It is the only lever on an agent that decides its tool
   * uses alone (`permissionsByAgent`): the one-shot refuses every permission request, and such an
   * agent sends none, so a prompt injection in the summarised transcript would otherwise run its
   * tools. Never applied to a mission.
   */
  readonly oneShotEnv?: Readonly<Record<string, string>>;
  /**
   * The agent's own blocking requests this provider answers, by method (`cursor/ask_question`): each handler
   * translates the request into a card the daemon lends (`cards.ask`, `cards.approvePlan`) and the answer into
   * the reply the agent expects. A method not listed keeps "method not found". The protocol's own methods
   * (`session/*`, `fs/*`, `terminal/*`, `initialize`, `authenticate`) are refused here.
   */
  readonly extensionRequests?: Readonly<Record<string, AcpExtensionHandler>>;
};

/** What the session needs: the MCP servers of the mission, and for a `'session-new'` model probe the declared program's pipes. */
export type AcpProviderServices = {
  mcp(spawn: BuildSpawnOpts, options?: ProviderMcpOptions): Promise<ProviderMcpPlan>;
  readonly binary?: {
    converse(name: string, args: readonly string[], options?: { readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number }): Promise<AcpConversation>;
  };
};

/**
 * Whether a mission's current process runs inside the mission fence. The daemon sets it at load
 * (`mission-fence-state.ts`); this module is also part of the published SDK, where nothing sets it
 * and every session keeps the `authenticateWith` detour.
 */
let fenceSource: (missionId: string) => boolean = () => false;

export function setAcpFenceSource(source: (missionId: string) => boolean): void {
  fenceSource = source;
}

/** The probe stops itself at 30 s (`models.ts`); the daemon's deadline is the backstop. */
const PROBE_CONVERSATION_MS = 40_000;

function modelsOf(services: AcpProviderServices, spec: AcpAgentSpec): ModelsStrategy | undefined {
  if (spec.modelProbe === undefined) return spec.models;
  if (spec.models) throw new Error(`provider \`${spec.id}\`: \`models\` and \`modelProbe\` are exclusive`);
  const { binary } = services;
  if (!binary) throw new Error(`provider \`${spec.id}\`: \`modelProbe\` needs \`services.binary\` (pass \`ctx.provider\`)`);
  return {
    discover: (profile) => discoverAcpModels({
      // The profile's own command when the manifest declared it, the canonical name otherwise.
      open: () => binary.converse(
        spec.binary.names.includes(profile.cmd) ? profile.cmd : spec.binary.names[0]!, spec.args,
        { env: profile.env, timeoutMs: PROBE_CONVERSATION_MS },
      ),
      command: profile.cmd,
      profileId: profile.id,
      ...(spec.signIn ? { signIn: spec.signIn } : {}),
      ...(spec.authenticateWith ? { authenticateWith: spec.authenticateWith } : {}),
      keep: profile.knownModels,
    }),
  };
}

export function defineProvider(services: AcpProviderServices, spec: AcpAgentSpec): NativeProviderDefinition {
  const permissionsByAgent = spec.permissionsByAgent ?? false;
  const extensionRequests = spec.extensionRequests ? { ...spec.extensionRequests } : undefined;
  for (const [method, handler] of Object.entries(extensionRequests ?? {})) {
    const problem = acpExtensionMethodProblem(method);
    if (problem) throw new Error(`provider \`${spec.id}\`: extension request ${problem}`);
    if (typeof handler !== 'function') throw new Error(`provider \`${spec.id}\`: extension request \`${method}\` has no handler`);
  }
  const models = modelsOf(services, spec);
  // Open sessions by mission, so that killing a mission lets go of its pipes.
  const sessions = new Map<string, AcpSessionDriver>();
  return {
    id: spec.id,
    // The agent is one process for the whole conversation; its exit ends the chat.
    transport: { kind: 'stdio-persistent' },
    codec: {
      kind: 'driver',
      extractSessionId: extractAcpSessionId,
      openSession: ({ io, spawn, host, profileId }: Parameters<ProcessDriverCodec['openSession']>[0]) => {
        const driver: AcpSessionDriver = new AcpSessionDriver({
          io,
          host,
          // The process starts in `cfg.cwd` (or the daemon's own when unset): the session must say the same.
          cwd: spawn.cfg.cwd ?? process.cwd(),
          systemPrompt: spawn.systemPrompt,
          model: spawn.cfg.model ?? null,
          reasoningEffort: spawn.cfg.reasoningEffort ?? null,
          resumeSession: spawn.resumeSession,
          // Only the stdio servers are declared: the HTTP shape of ACP was not verified on any agent, and a wrong one
          // fails the whole `session/new`, not that server alone.
          mcpServers: async () => serializeAcpMcpServers((await services.mcp(spawn)).servers).servers,
          permissionsByAgent,
          profileId: profileId ?? spec.id,
          ...(spec.signIn ? { signIn: spec.signIn } : {}),
          ...(spec.authenticateWith ? { authenticateWith: spec.authenticateWith } : {}),
          fenced: () => fenceSource(spawn.missionId),
          ...(extensionRequests ? { extensionRequests } : {}),
          onClose: () => {
            if (sessions.get(spawn.missionId) === driver) sessions.delete(spawn.missionId);
          },
        });
        sessions.set(spawn.missionId, driver);
        return driver;
      },
    },
    launch: async (spawn, profile) => ({
      cmd: profile.cmd,
      args: [...spec.args],
      cwd: spawn.cfg.cwd,
      env: { ...profile.env, ...(spec.env?.(spawn) ?? {}), ...(spawn.oneShot ? spec.oneShotEnv : undefined) },
      // The driver writes the handshake; the system prompt and the first message travel through the session.
      initialStdin: null,
    }),
    // opencode and Hermes both keep sessions in their own global store, found again by `session/resume` or `session/load` from any process.
    session: { store: 'global', resumable: true },
    // Shared by an agent that asks and one that never does: the channel exists, `permissionsByAgent` says which this is.
    permission: { model: 'protocol', byAgent: permissionsByAgent },
    // Provider errors come back as text in the reply, never as a reset time.
    limits: { reporting: 'textual' },
    mcp: { timon: true },
    // Lets go of the pipes; the runner kills the process.
    lifecycle: {
      dispose(missionId: string): void {
        sessions.get(missionId)?.close();
        sessions.delete(missionId);
      },
    },
    ...(models ? { models } : {}),
    declares: { ...spec.declares, binary: spec.binary, spans: 'stream-json' },
  };
}
