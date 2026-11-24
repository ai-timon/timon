/**
 * A stand-in for the `ctx` a provider plugin receives, to run its `apply(ctx)`
 * and its dialect factory in a test, without the daemon.
 *
 * `ctx.provider.runtime` is a COPY of the daemon's runtime (the same code, read
 * from the package this test runs against): the behaviour the daemon would hand
 * the plugin, so what a test sees is what the plugin will run — down to the same
 * registration check. What a copy cannot be is the daemon's PRIVILEGES: this
 * object has no vault, no mission token and no process, which is also what a
 * third-party plugin gets. Whatever the plugin registers is recorded in
 * `registered`, for the conformance bench to pick up.
 */

import type {
  AnyDialect, BackendProfile, BuildSpawnOpts, Dialect, NativeProviderDefinition, ProviderGeneratedMedia, ProviderMcpOptions, ProviderMcpPlan,
  ProviderConversation, ProviderMcpServer, ProviderPluginContext, ProviderProbeResult, ProviderSettingValue, RegisteredProfile, RemoteDialect,
} from '../provider.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScratchDir, type ProviderScratchDir } from '../../../../orchestrator/src/backends/scratch-dir.js';
import { COMMAND_POLICY } from '../../../../orchestrator/src/backends/command-policy.js';
import { PRE_APPROVED_MCP_TOOLS } from '../../../../orchestrator/src/backends/mcp-preapproved.js';
import { ASK_MCP_FORMS_ONLY_ENV, ASK_MCP_SERVER, CLAUDE_PERMISSION_PROMPT_TOOL, claudeAskToolNames } from '../../../../orchestrator/src/ask-mcp.js';
import { providerRuntime } from './runtime.js';

/** What the stand-in answers to `ctx.provider.mcp()`: a reference where the daemon would put one, never a token. */
export const FAKE_TOKEN_REFERENCE = 'timon-seal-00000000000000000000000000000000';

/** How every reference the daemon mints starts (`launch-seal.ts`, kept out of the published SDK), the stand-in's included. */
const SEAL_REFERENCE_PREFIX = 'timon-seal-';

export type ProviderContextOptions = {
  /** What `ctx.settings.get` answers: the plugin's own settings, secrets included. */
  readonly settings?: Readonly<Record<string, ProviderSettingValue>>;
  /** The `apiVersion` the plugin's manifest declares. Default: 12, the contract `ctx.provider` belongs to. */
  readonly apiVersion?: number;
  /** The agent's own MCP servers `ctx.provider.mcp()` should list, after Timon's. */
  readonly userMcpServers?: readonly ProviderMcpServer[];
  /**
   * The programs `ctx.provider.binary` knows: where each is, which version it prints, and what a probe of it answers. A name
   * that is not here is "not installed". `serve` is not available in the stand-in (it needs a process): use a fake CLI.
   */
  readonly binaries?: Readonly<Record<string, {
    readonly path?: string;
    readonly version?: string;
    readonly probe?: (args: readonly string[]) => Partial<ProviderProbeResult>;
    /** A scripted answer to `ctx.provider.binary.converse`: a conversation over in-memory pipes. */
    readonly converse?: (args: readonly string[]) => ProviderConversation;
  }>>;
  /**
   * What `ctx.provider.osCredentials` holds, by `service` or `service|account`. A key that is not here reads as null.
   * `ctx.provider.account.osCredential(profile, service).read()` reads the same keys, and `remove(expected)`
   * deletes one while it still holds `expected`. `setOsCredential` changes them during a test.
   */
  readonly osCredentials?: Readonly<Record<string, string>>;
  /** Services whose `account.osCredential(...).remove()` the store refuses, as a locked keychain does. */
  readonly lockedOsCredentials?: readonly string[];
  /** Accounts (by id) a sign-in flow runs on: `account.osCredential(...).held()` and `remove` answer `signing-in`. */
  readonly signingInAccounts?: readonly string[];
  /**
   * Launches (by mission id) that run outside the fence: `held()` and `remove` answer `unfenced`.
   * Any other launch is taken as fenced, as a mission on macOS with isolation on.
   */
  readonly unfencedMissions?: readonly string[];
  /** Accounts (by id) another process runs on outside the fence: `held()` and `remove` answer `in-use`. `setAccountInUse` changes it. */
  readonly accountsInUse?: readonly string[];
  /** What `ctx.provider.media.adopt` returns for any directory. Default: nothing. */
  readonly generatedMedia?: readonly ProviderGeneratedMedia[];
  /** Values `ctx.provider.redact` masks (12 characters or more, like the daemon's). Default: none. */
  readonly secrets?: readonly string[];
  /** Absolute folders `scratch.link` may take a source from: stand for the home-relative `declares.credentialDirs` a real provider declared. */
  readonly credentialDirs?: readonly string[];
  /** What `ctx.provider.git.writableRoots` answers, by working directory. A folder that is not here is not a repository. */
  readonly gitRoots?: Readonly<Record<string, readonly string[]>>;
  /** What `ctx.provider.env()` answers on top of the identity pointers (the daemon's would add the system variables). */
  readonly baseEnv?: Readonly<Record<string, string>>;
};

export type LoggedLine = { readonly level: 'info' | 'warn' | 'error'; readonly message: string };

export type TestProviderContext = ProviderPluginContext & {
  /** What the plugin registered, in order. */
  readonly registered: {
    readonly profiles: readonly RegisteredProfile[];
    /** What it registered with `ctx.provider.registerProductProfile`, in order. */
    readonly productProfiles: readonly BackendProfile[];
    readonly dialects: ReadonlyMap<string, Dialect | RemoteDialect>;
    /** What it registered with `ctx.provider.registerProvider`, by id. */
    readonly providers: ReadonlyMap<string, NativeProviderDefinition>;
    /**
     * The dialect registered under `id`; for a provider registered natively, the dialect the
     * daemon adapts it to — the form the conformance bench takes. Throws, naming the ids it
     * has, if there is none.
     */
    dialect(id: string): AnyDialect;
  };
  /** Everything the plugin logged. */
  readonly logs: readonly LoggedLine[];
  /** The directories the plugin opened to `chat_show_media` (`media.allowShow`), by mission. */
  readonly shownFrom: ReadonlyMap<string, readonly string[]>;
  /**
   * Stands in for a CLI that writes the keychain while the plugin works (a sign-in, a renewal
   * outside any fence): sets the entry `key` (`service` or `service|account`), or deletes it on null.
   */
  setOsCredential(key: string, value: string | null): void;
  /** Stands in for a process on the account starting (true) or ending (false) outside the fence. */
  setAccountInUse(accountId: string, inUse: boolean): void;
  /** Removes the temporary folders `scratch.mission` and `scratch.profile` created. */
  cleanup(): void;
};

/** What the daemon masks: a value of 12 characters or more, replaced by `***`. */
const MASK_MIN_LENGTH = 12;

function fakeMcpPlan(spawn: BuildSpawnOpts, options: ProviderMcpOptions | undefined, user: readonly ProviderMcpServer[]): ProviderMcpPlan {
  const identityEnv = {
    TIMON_ORCH_URL: 'http://127.0.0.1:3001',
    TIMON_MISSION_ID: spawn.missionId,
    TIMON_AGENT: spawn.agentName,
    TIMON_API_TOKEN: FAKE_TOKEN_REFERENCE,
  };
  const prompt = options?.permissionPrompt === true;
  const timon: ProviderMcpServer[] = spawn.timonMcp === false ? [] : [
    { role: 'timon', type: 'stdio', name: 'timon', command: 'node', args: ['timon-mcp.mjs'], env: identityEnv },
    {
      role: 'forms', type: 'stdio', name: ASK_MCP_SERVER, command: 'node', args: ['permission-mcp.mjs'],
      env: { ...identityEnv, ...(prompt ? {} : { [ASK_MCP_FORMS_ONLY_ENV]: '1' }) },
    },
  ];
  return {
    servers: [...timon, ...user],
    identityEnv,
    daemonUrl: identityEnv.TIMON_ORCH_URL,
    scripts: { timon: 'timon-mcp.mjs', forms: 'permission-mcp.mjs' },
    permissionTool: prompt && spawn.timonMcp !== false ? CLAUDE_PERMISSION_PROMPT_TOOL : null,
    preApprovedTools: [...claudeAskToolNames(), ...PRE_APPROVED_MCP_TOOLS],
    commandPolicy: COMMAND_POLICY,
  };
}

const text = (args: unknown[]): string => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');

export function createProviderContext(options: ProviderContextOptions = {}): TestProviderContext {
  const apiVersion = options.apiVersion ?? 12;
  const settings = options.settings ?? {};
  const profiles: RegisteredProfile[] = [];
  const dialects = new Map<string, Dialect | RemoteDialect>();
  const providers = new Map<string, NativeProviderDefinition>();
  const productProfiles: BackendProfile[] = [];
  const logs: LoggedLine[] = [];
  const scratches = new Map<string, ProviderScratchDir>();
  const profileScratches = new Map<string, ProviderScratchDir>();
  const shownFrom = new Map<string, string[]>();
  const osStore = new Map<string, string>(Object.entries(options.osCredentials ?? {}));
  const accountsInUse = new Set<string>(options.accountsInUse ?? []);
  const temporaryRoots: string[] = [];
  const secrets = (options.secrets ?? []).filter((value) => value.length >= MASK_MIN_LENGTH);
  const maskText = (value: string): string => secrets.reduce((out, secret) => out.split(secret).join('***'), value);
  const maskDeep = <T,>(value: T): T => {
    if (typeof value === 'string') return maskText(value) as T;
    if (Array.isArray(value)) return value.map(maskDeep) as T;
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, maskDeep(inner)])) as T;
    }
    return value;
  };
  const log = (level: LoggedLine['level']) => (...args: unknown[]): void => { logs.push({ level, message: text(args) }); };

  return {
    backends: {
      registerProfile(profile) {
        if (profiles.some((p) => p.id === profile.id)) throw new Error(`backend \`${profile.id}\` is already registered`);
        profiles.push(profile);
        return () => { const i = profiles.indexOf(profile); if (i >= 0) profiles.splice(i, 1); };
      },
      registerDialect(id, dialect) {
        if (dialects.has(id)) throw new Error(`dialect \`${id}\` is already registered`);
        // The daemon's own rule: from apiVersion 11 a dialect that contradicts itself is refused.
        const problems = providerRuntime.check.dialectProblems(dialect);
        if (problems.length > 0) {
          const message = `dialect \`${id}\` contradicts itself: ${problems.join('; ')}`;
          if (apiVersion >= 11) throw new Error(message);
          logs.push({ level: 'warn', message });
        }
        dialects.set(id, dialect);
        return () => { dialects.delete(id); };
      },
    },
    settings: { get: (key) => settings[key] },
    log: { info: log('info'), warn: log('warn'), error: log('error') },
    provider: {
      credentialStore() {
        let token: string | null = null;
        return {
          read: () => token, status: () => ({ configured: token !== null, readable: token !== null }),
          parseBody: (body: unknown) => body && typeof body === 'object' && Object.keys(body).length === 1 && 'token' in body && typeof body.token === 'string' ? body.token : null,
          write: (value: string) => { token = value; }, clear: () => { const had = token !== null; token = null; return had; }, syncMarker() {},
        };
      },
      async modelReasoning() { return undefined; },
      get runtime() {
        if (apiVersion < 12) {
          throw new Error(`plugin: ctx.provider.runtime needs apiVersion 12 or later (the manifest declares ${apiVersion})`);
        }
        return providerRuntime;
      },
      scratch: {
        async mission(spawn) {
          let dir = scratches.get(spawn.missionId);
          if (!dir) {
            const root = mkdtempSync(join(tmpdir(), 'provider-scratch-'));
            temporaryRoots.push(root);
            dir = createScratchDir({ root: join(root, spawn.missionId), linkRoots: options.credentialDirs ?? [] });
            scratches.set(spawn.missionId, dir);
          }
          return dir;
        },
        // One temporary folder per profile, the same across missions, as the daemon's. The
        // stand-in launches every profile it is handed: it has no registry to say who does.
        profile(profile) {
          if (apiVersion < 18) {
            throw new Error(`plugin: ctx.provider.scratch.profile needs apiVersion 18 or later (the manifest declares ${apiVersion})`);
          }
          if (profile.id.includes('@')) {
            throw new Error('scratch.profile: a launch on an account keeps its state in account.of(profile).configDir');
          }
          let dir = profileScratches.get(profile.id);
          if (!dir) {
            const root = mkdtempSync(join(tmpdir(), 'provider-profile-'));
            temporaryRoots.push(root);
            dir = createScratchDir({
              root: join(root, profile.id),
              // The daemon's folder outlives every mission: a launch's reference is refused there too.
              swap: (content) => {
                if (content.includes(SEAL_REFERENCE_PREFIX)) throw new Error('scratch.profile: this text carries a launch\'s reference, write it in scratch.mission() instead');
                return content;
              },
            });
            profileScratches.set(profile.id, dir);
          }
          return dir;
        },
      },
      binary: {
        async resolve(name) { return options.binaries?.[name]?.path ?? null; },
        async version(name) { return options.binaries?.[name]?.version ?? null; },
        async probe(name, args) {
          const known = options.binaries?.[name];
          if (!known) return { code: 127, stdout: '', stderr: `${name}: not installed`, timedOut: false };
          return { code: 0, stdout: '', stderr: '', timedOut: false, ...(known.probe?.(args) ?? {}) };
        },
        async serve(name) {
          throw new Error(`ctx.provider.binary.serve(${name}) needs a process: the stand-in has none — drive a fake CLI (createFakeCli) instead`);
        },
        async converse(name, args) {
          const known = options.binaries?.[name]?.converse;
          if (!known) throw new Error(`ctx.provider.binary.converse(${name}) needs a process: give \`binaries.${name}.converse\` a scripted conversation to test against`);
          return known(args);
        },
      },
      git: { writableRoots: (cwd) => options.gitRoots?.[cwd] ?? [] },
      account: {
        // The launch's account rides on the profile's runtime, as the daemon's does; the stand-in only reads it.
        of(profile) {
          const account = (profile as { account?: { id: string; name: string; configDir: string } }).account;
          return account ? { id: account.id, name: account.name, configDir: account.configDir } : undefined;
        },
        osCredential(profile, service, missionId) {
          if (apiVersion < 18) {
            throw new Error(`plugin: ctx.provider.account.osCredential needs apiVersion 18 or later (the manifest declares ${apiVersion})`);
          }
          const account = (profile as { account?: { id: string; configDir: string } }).account;
          if (!account) return undefined;
          // The daemon's rule: a name followed by THIS account's suffix, never the host's own entry nor another account's.
          const suffix = `-${createHash('sha256').update(account.configDir.normalize('NFC')).digest('hex').slice(0, 8)}`;
          if (!service.endsWith(suffix) || service.length === suffix.length) {
            throw new Error(`plugin: \`${service}\` is not this account's entry (a declared service followed by the suffix of the account's folder)`);
          }
          if (typeof missionId !== 'string' || !missionId) {
            throw new Error('plugin: `osCredential(profile, service, missionId)` takes the id of the launch being built');
          }
          // The daemon's order: a sign-in first, then this launch's fence, then the other processes on the account.
          const held = () => {
            if (options.signingInAccounts?.includes(account.id)) return 'signing-in' as const;
            if (options.unfencedMissions?.includes(missionId)) return 'unfenced' as const;
            return accountsInUse.has(account.id) ? 'in-use' as const : null;
          };
          return {
            held,
            async read() { return osStore.get(service) ?? null; },
            async remove(expected) {
              const hold = held();
              if (hold) return hold;
              const current = osStore.get(service);
              if (current === undefined) return 'removed';
              if (current !== expected) return 'changed';
              if (options.lockedOsCredentials?.includes(service)) return 'refused';
              osStore.delete(service);
              return 'removed';
            },
          };
        },
      },
      media: {
        async adopt() { return options.generatedMedia ?? []; },
        adoptSync() { return options.generatedMedia ?? []; },
        allowShow(missionId, directory) { shownFrom.set(missionId, [...(shownFrom.get(missionId) ?? []), directory]); },
      },
      osCredentials: {
        invalidate() {},
        async read(service, account) {
          return osStore.get(account ? `${service}|${account}` : service) ?? null;
        },
      },
      redact: { text: maskText, deep: maskDeep },
      async mcp(spawn, mcpOptions) {
        return fakeMcpPlan(spawn, mcpOptions, options.userMcpServers ?? []);
      },
      registerProvider(definition) {
        // The daemon refuses a definition that contradicts itself, naming the declaration and the missing piece.
        const problems = providerRuntime.check.definitionProblems(definition);
        if (problems.length > 0) throw new Error(`provider \`${String((definition as { id?: unknown })?.id)}\` is refused: ${problems.join('; ')}`);
        if (providers.has(definition.id) || dialects.has(definition.id)) throw new Error(`provider \`${definition.id}\` is already registered`);
        providers.set(definition.id, definition);
        return () => { providers.delete(definition.id); };
      },
      registerProductProfile(profile) {
        if (productProfiles.some((p) => p.id === profile.id) || profiles.some((p) => p.id === profile.id)) throw new Error(`backend \`${profile.id}\` is already registered`);
        productProfiles.push(profile);
        return () => { const i = productProfiles.indexOf(profile); if (i >= 0) productProfiles.splice(i, 1); };
      },
      replaceProvider(definition) {
        const before = providers.get(definition.id);
        if (!before) throw new Error(`provider \`${definition.id}\` is not registered by this plugin: register it first`);
        const problems = providerRuntime.check.definitionProblems(definition);
        if (problems.length > 0) throw new Error(`provider \`${definition.id}\` is refused: ${problems.join('; ')}`);
        // What the daemon refuses on a hot update: a mission could not keep working across it.
        if (before.transport.kind !== definition.transport.kind) {
          throw new Error(`provider \`${definition.id}\`: its transport changed (${before.transport.kind} → ${definition.transport.kind}) — restart the missions to apply this version`);
        }
        if (before.session.store !== definition.session.store) {
          throw new Error(`provider \`${definition.id}\`: its session store changed (${before.session.store} → ${definition.session.store}) — restart the missions to apply this version`);
        }
        providers.set(definition.id, definition);
        return () => { providers.delete(definition.id); };
      },
      async env(spawn) {
        return {
          env: {
            ...(options.baseEnv ?? {}),
            TIMON_MISSION_ID: spawn.missionId,
            TIMON_AGENT: spawn.agentName,
          },
          project: spawn.cfg.project ?? null,
        };
      },
    },
    registered: {
      profiles,
      productProfiles,
      dialects,
      providers,
      dialect(id) {
        const found = dialects.get(id);
        if (found) return found;
        const native = providers.get(id);
        if (native) return providerRuntime.engine.dialectFromDefinition(native);
        throw new Error(`no dialect \`${id}\` was registered (registered: ${[...dialects.keys(), ...providers.keys()].join(', ') || 'none'})`);
      },
    },
    logs,
    shownFrom,
    setOsCredential(key, value) {
      if (value === null) osStore.delete(key);
      else osStore.set(key, value);
    },
    setAccountInUse(accountId, inUse) {
      if (inUse) accountsInUse.add(accountId);
      else accountsInUse.delete(accountId);
    },
    cleanup() {
      for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
      scratches.clear();
      profileScratches.clear();
    },
  };
}
