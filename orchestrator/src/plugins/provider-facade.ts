/**
 * `ctx.provider`: what the daemon puts at a provider plugin's disposal
 * (`docs/PROVIDERS-SDK.md` § 6). API 12, permission `backends:register`.
 *
 * A provider is the one kind of plugin that sits on the prompt path: it writes
 * the code that talks to an agent CLI, for a mission whose owner, project and
 * secrets the daemon knows. So the services here follow one rule, from
 * `SECURITY.md` § 6.4.1: the daemon DOES what needs a privilege (the vault, the
 * mission's token, the process, the OS credential store) and hands the plugin a
 * RESULT that carries none — or a reference the daemon alone can swap for the
 * value on the way to the process. Nothing here ever returns the mission's
 * token or a vault value to a plugin that is not the product's own.
 *
 * `trusted` is `spec.builtin`: a plugin shipped inside the release, whose files
 * the signed manifest vouched for (`builtin.ts`). A third-party plugin gets the
 * same services with less in them; each service says what.
 */
import { openProviderCredentialStore } from '../backends/provider-credential-store.js';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { ProviderRuntime } from '../backends/provider-runtime.js';
import { providerRuntime } from '../backends/provider-runtime.js';
import type { ProviderServices } from '../backends/provider-plugin-context.js';
import { sealFor, type LaunchSeal } from '../backends/launch-seal.js';
import { providerEnvPlan } from '../backends/provider-env.js';
import { providerMcpPlan } from '../backends/provider-mcp.js';
import {
  activeProfiles, backendOwnerPlugin, isProductBackend, registerTrustedProfile, ownerCredentialDirEnv, ownerCredentialDirs, profileDeclarations, registeredBackendOwners, registerProvider,
  replaceProvider,
} from '../backends/registry.js';
import { envCredentialRoots, missionScratchPath, openMissionScratch, openProfileScratch } from '../backends/provider-scratch.js';
import { accountConfigDir } from '../backends/accounts.js';
import { adoptGeneratedMedia, allowShowFrom } from '../backends/provider-media.js';
import { gitWritableRoots } from '../backends/provider-git.js';
import { readOsCredential, readOsCredentialNow, removeOsCredentialIf, resetOsCredentialMisses } from '../host/os-credentials.js';
import { accountSigningIn } from '../backends/account-signin.js';
import { accountCredentialHold } from '../mission-fence-state.js';
import { getHost } from '../host/index.js';
import { ensurePrivateDir } from '../host/private-dir.js';
import { runtimeAccount } from '../backends/instance-id.js';
import { redactDeep, redactText } from '../secrets/redact.js';
import { baseBackendId, isAccountInstanceId } from '../backends/instance-id.js';
import { assertProviderExecAllowed, PluginPolicyError } from './policy.js';
import { createProviderBinary } from '../backends/provider-binary.js';
import type { ProviderAccountOsCredentialHold, ProviderBinary, ProviderGeneratedMedia } from '../backends/provider-services.js';
import type { NativeProviderDefinition } from '../backends/engine/definition.js';

/** The contract version `ctx.provider` appeared in. */
export const PROVIDER_FACADE_API_VERSION = 12;

/** The contract version `ctx.provider.scratch.profile` appeared in. */
export const PROVIDER_PROFILE_SCRATCH_API_VERSION = 18;

/** The contract version `ctx.provider.account.osCredential` appeared in. */
export const PROVIDER_ACCOUNT_OS_CREDENTIAL_API_VERSION = 18;

/**
 * The suffix a CLI that keys its keychain entry on its config folder puts after the service name
 * (Claude Code: the first 8 hex of sha256 of the folder, NFC). Computed here from the account's own
 * folder, so a provider reaches that account's entry and no other, another user's included.
 */
export function accountEntrySuffix(configDir: string): string {
  return `-${createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}`;
}

/** A plugin that declared an older contract calls a member it was not promised. */
export class PluginApiVersionError extends Error {
  constructor(readonly pluginId: string, readonly member: string, readonly required: number, readonly declared: number) {
    super(`plugin \`${pluginId}\`: ${member} needs apiVersion ${required} or later (the manifest declares ${declared})`);
    this.name = 'PluginApiVersionError';
  }
}

export type ProviderFacadeScope = {
  readonly pluginId: string;
  /** What the manifest declared: the daemon accepts less than its own version. */
  readonly apiVersion: number;
  /** Throws `PluginPermissionError` when `backends:register` is not granted. */
  assertPermission(): void;
  /** Shipped with the product and verified against the signed release. */
  readonly trusted: boolean;
  /** The program names the manifest's `provider.binaries` lists, aliases included: what the operator authorized. */
  readonly authorizedBinaries: readonly string[];
  /** The folders the manifest's `provider.credentialDirs` lists: the operator saw them, a definition cannot declare others. */
  readonly authorizedCredentialDirs: readonly string[];
  /** The `provider.osCredentials` entries the manifest declared: the only ones `ctx.provider.osCredentials` reads. */
  readonly osCredentials: ReadonlyArray<{ readonly service: string; readonly account?: string }>;
  /** Ties a registration to the plugin's lifetime (`ctx.effect`). */
  effect(register: () => () => void): () => void;
};

/** Whether `pluginId` registered the backend `backend` (its profile, or the dialect the profile runs on). */
function ownsBackend(pluginId: string, backend: string): boolean {
  const id = baseBackendId(backend);
  const owners = registeredBackendOwners();
  if (owners.profiles[id] === pluginId) return true;
  const dialect = activeProfiles().find((entry) => entry.profile.id === id)?.profile.dialect;
  return dialect !== undefined && owners.dialects[dialect] === pluginId;
}

export function providerServicesFor(scope: ProviderFacadeScope): ProviderServices {
  const gate = (member: string, since = PROVIDER_FACADE_API_VERSION): void => {
    scope.assertPermission();
    if (scope.apiVersion < since) {
      throw new PluginApiVersionError(scope.pluginId, `ctx.provider.${member}`, since, scope.apiVersion);
    }
  };
  /**
   * The launch in progress for `missionId`, if any. Its seal is bound to the backend
   * the daemon launched: a plugin that names another plugin's mission is refused,
   * not answered with an empty plan — it is asking about a mission that is not its.
   */
  const launchOf = (missionId: string): LaunchSeal | undefined => {
    const seal = sealFor(missionId);
    if (seal && !ownsBackend(scope.pluginId, seal.backend)) {
      throw new PluginPolicyError(scope.pluginId, 'provider-mission', `mission ${missionId.slice(0, 8)} is not running on a backend this plugin registered`);
    }
    return seal;
  };
  /**
   * The binary a plugin CHOOSES goes through the operator's allowlist, exactly like
   * `ctx.host.exec` and `registerDialect`: the canonical name is the one the daemon
   * launches. (A definition that declares no binary owns no process.)
   */
  const exactBinaryCheck = (definition: NativeProviderDefinition): { authorizedBinaries: readonly string[]; authorizedCredentialDirs: readonly string[]; trusted: boolean } => {
    const canonical = definition?.declares?.binary?.names?.[0];
    if (typeof canonical === 'string') assertProviderExecAllowed(scope.pluginId, canonical, { trusted: scope.trusted });
    return { authorizedBinaries: scope.authorizedBinaries, authorizedCredentialDirs: scope.authorizedCredentialDirs, trusted: scope.trusted };
  };
  const adoptFor = (member: string, missionId: string, directory: string, sinceMs: number): ProviderGeneratedMedia[] => {
    const seal = launchOf(missionId);
    if (!seal) throw new PluginPolicyError(scope.pluginId, 'provider-mission', `${member} needs a mission running on a backend this plugin registered`);
    return adoptGeneratedMedia({ missionId, directory, sinceMs, roots: [missionScratchPath(scope.pluginId, missionId), seal.spawn?.cfg.cwd] });
  };
  let binary: ProviderBinary | null = null;
  const binaryApi = (): ProviderBinary => {
    if (!binary) {
      const created = createProviderBinary({ pluginId: scope.pluginId, trusted: scope.trusted, authorizedBinaries: scope.authorizedBinaries });
      // The servers a provider started end with the plugin, however it ends.
      scope.effect(() => () => { void created.stopAll(); });
      binary = created.api;
    }
    return binary;
  };
  return {
    get runtime(): ProviderRuntime {
      gate('runtime');
      return providerRuntime;
    },
    credentialStore(spec) {
      gate('credentialStore');
      if (!scope.trusted) throw new PluginPolicyError(scope.pluginId, 'provider-credential', 'Only a provider shipped in the release can open historical credential storage');
      return openProviderCredentialStore(spec);
    },
    async modelReasoning(profile, model) {
      gate('modelReasoning');
      if (!ownsBackend(scope.pluginId, profile.id)) throw new PluginPolicyError(scope.pluginId, 'provider-model', 'This profile belongs to another provider');
      if (!model || !Object.keys(profile.env).length) return undefined;
      const { catalogBackend } = await import('../backends/catalog.js');
      const entry = catalogBackend(profile.id);
      return entry?.custom ? entry.models.find((m) => m.slug === model)?.reasoning : undefined;
    },
    async mcp(spawn, options) {
      gate('mcp');
      const seal = launchOf(spawn.missionId);
      // Inside a launch the daemon answers its own question, not the one it was handed back.
      return providerMcpPlan({ spawn: seal?.spawn ?? spawn, seal, ...(options ? { options } : {}) });
    },
    scratch: {
      async mission(spawn) {
        gate('scratch.mission');
        const seal = launchOf(spawn.missionId);
        // A subscription account signs in in a folder of its own (`~/.timon/backend-accounts/<id>`), and an operator may have
        // pointed the host's sign-in elsewhere (`CODEX_AUTH_DIR`): the places a mission links its credentials from.
        const accountFolders = activeProfiles().flatMap(({ profile, account }) =>
          account && ownsBackend(scope.pluginId, profile.id) ? [accountConfigDir(account.id)] : []);
        const operatorFolders = scope.trusted ? envCredentialRoots(ownerCredentialDirEnv(scope.pluginId)) : [];
        return openMissionScratch({
          pluginId: scope.pluginId, missionId: spawn.missionId, seal, credentialDirs: ownerCredentialDirs(scope.pluginId),
          extraLinkRoots: [...accountFolders, ...operatorFolders],
        });
      },
      profile(profile) {
        gate('scratch.profile', PROVIDER_PROFILE_SCRATCH_API_VERSION);
        // The plugin that LAUNCHES the profile, as the fence names it (`missionFenceTarget`): a
        // profile's own plugin that only registered it on another's dialect would get a folder
        // its missions never reach.
        // An account's sign-in has its own folder, and its owner is a person: a profile's folder,
        // shared by the host's sign-in and every account of the profile, is not where it goes.
        if (isAccountInstanceId(profile.id)) {
          throw new PluginPolicyError(scope.pluginId, 'provider-profile', 'a launch on an account keeps its state in account.of(profile).configDir');
        }
        const id = baseBackendId(profile.id);
        if (backendOwnerPlugin(id) !== scope.pluginId) {
          throw new PluginPolicyError(scope.pluginId, 'provider-profile', `\`${id}\` does not run on a dialect this plugin launches`);
        }
        return openProfileScratch(scope.pluginId, id);
      },
    },
    binary: {
      resolve(name) { gate('binary.resolve'); return binaryApi().resolve(name); },
      version(name) { gate('binary.version'); return binaryApi().version(name); },
      probe(name, args, options) { gate('binary.probe'); return binaryApi().probe(name, args, options); },
      serve(name, args, options) { gate('binary.serve'); return binaryApi().serve(name, args, options); },
      converse(name, args, options) { gate('binary.converse'); return binaryApi().converse(name, args, options); },
    },
    git: {
      writableRoots(cwd) {
        gate('git.writableRoots');
        return typeof cwd === 'string' && isAbsolute(cwd) ? gitWritableRoots(cwd) : [];
      },
    },
    account: {
      of(profile) {
        gate('account.of');
        // Only for a profile this plugin registered: another provider's accounts are not its business.
        if (!ownsBackend(scope.pluginId, profile.id)) {
          throw new PluginPolicyError(scope.pluginId, 'provider-account', `\`${profile.id}\` is not a backend this plugin registered`);
        }
        const account = runtimeAccount(profile);
        return account ? { id: account.id, name: account.name, configDir: ensurePrivateDir(account.configDir) } : undefined;
      },
      osCredential(profile, service, missionId) {
        gate('account.osCredential', PROVIDER_ACCOUNT_OS_CREDENTIAL_API_VERSION);
        if (!ownsBackend(scope.pluginId, profile.id)) {
          throw new PluginPolicyError(scope.pluginId, 'provider-account', `\`${profile.id}\` is not a backend this plugin registered`);
        }
        if (typeof missionId !== 'string' || !missionId) {
          throw new PluginPolicyError(scope.pluginId, 'provider-os-credentials', '`osCredential(profile, service, missionId)` takes the id of the launch being built');
        }
        const account = runtimeAccount(profile);
        if (!account) return undefined;
        // A declared name plus THIS account's suffix: never the host's sign-in, another account's or another provider's.
        const suffix = accountEntrySuffix(account.configDir);
        const declared = typeof service === 'string'
          ? scope.osCredentials.find((entry) => !entry.account && service === `${entry.service}${suffix}`)
          : undefined;
        if (!declared) {
          throw new PluginPolicyError(scope.pluginId, 'provider-os-credentials',
            'An account entry is a service this manifest declares (`provider.osCredentials`), followed by the suffix of this account\'s folder');
        }
        const entry = { service };
        const accountId = account.id;
        const held = (): ProviderAccountOsCredentialHold | null =>
          accountSigningIn(accountId) ? 'signing-in' : accountCredentialHold(accountId, missionId);
        return {
          held,
          async read() { return readOsCredentialNow(getHost(), entry); },
          async remove(expected) {
            if (typeof expected !== 'string' || !expected) {
              throw new PluginPolicyError(scope.pluginId, 'provider-os-credentials', '`remove(expected)` takes the value that was read and copied');
            }
            // The invariant of the move: from this check to the delete, nothing is awaited.
            // `removeOsCredentialIf` runs `security` synchronously (`host.exec`), so no process
            // Timon launches can start in between: a sign-in flow, a launch outside the fence
            // or a one-shot is either recorded already, and seen here, or starts after the
            // delete. Moving this to `execAsync` would open that window.
            const hold = held();
            if (hold) return hold;
            return removeOsCredentialIf(getHost(), entry, expected);
          },
        };
      },
    },
    media: {
      async adopt(missionId, directory, sinceMs) {
        gate('media.adopt');
        return adoptFor('media.adopt', missionId, directory, sinceMs);
      },
      adoptSync(missionId, directory, sinceMs) {
        gate('media.adoptSync');
        return adoptFor('media.adoptSync', missionId, directory, sinceMs);
      },
      allowShow(missionId, directory) {
        gate('media.allowShow');
        const seal = launchOf(missionId);
        if (!seal) throw new PluginPolicyError(scope.pluginId, 'provider-mission', 'media.allowShow needs a mission running on a backend this plugin registered');
        allowShowFrom(missionId, directory, [missionScratchPath(scope.pluginId, missionId)]);
      },
    },
    osCredentials: {
      invalidate(service, account) {
        gate('osCredentials.invalidate');
        const declared = scope.osCredentials.find((entry) => entry.service === service && entry.account === account);
        if (!declared) throw new PluginPolicyError(scope.pluginId, 'provider-os-credentials', 'Not an OS credential this manifest declares');
        resetOsCredentialMisses(declared);
      },
      async read(service, account) {
        gate('osCredentials.read');
        const declared = scope.osCredentials.find((entry) => entry.service === service && entry.account === account);
        if (!declared) {
          throw new PluginPolicyError(scope.pluginId, 'provider-os-credentials',
            `\`${service}\`${account ? ` / \`${account}\`` : ''} is not an entry this plugin's manifest declares (\`provider.osCredentials\`)`);
        }
        return readOsCredential(getHost(), declared);
      },
    },
    redact: {
      // The daemon's own filter, with the daemon's own secrets: a plugin's copy would have none to mask.
      text(text) { gate('redact.text'); return redactText(text); },
      deep(value) { gate('redact.deep'); return redactDeep(value); },
    },
    registerProvider(definition: NativeProviderDefinition) {
      gate('registerProvider');
      return scope.effect(() => registerProvider(scope.pluginId, definition, exactBinaryCheck(definition)));
    },
    registerProductProfile(profile) {
      gate('registerProductProfile');
      if (!scope.trusted) {
        throw new PluginPolicyError(scope.pluginId, 'provider-profile',
          'registerProductProfile is for a plugin shipped in the release: a profile that names a vault entry would read it without `secrets:read` — use ctx.backends.registerProfile');
      }
      // The folders a profile masks from the others are the ones the operator saw in the manifest.
      const unlisted = (profile.credentialDirs ?? []).filter((dir) => !scope.authorizedCredentialDirs.includes(dir));
      if (unlisted.length > 0) {
        throw new PluginPolicyError(scope.pluginId, 'provider-profile', `\`${unlisted.join('`, `')}\` is not among the manifest's \`provider.credentialDirs\``);
      }
      return scope.effect(() => registerTrustedProfile(scope.pluginId, profile, { deferDialect: true, trusted: true }));
    },
    replaceProvider(definition: NativeProviderDefinition) {
      gate('replaceProvider');
      return scope.effect(() => replaceProvider(scope.pluginId, definition, exactBinaryCheck(definition)));
    },
    async env(spawn) {
      gate('env');
      const seal = launchOf(spawn.missionId);
      return providerEnvPlan({
        spawn: seal?.spawn ?? spawn,
        // The vault slice is the product's own launches': a plugin shipped inside the release
        // AND a backend the registry counts as the product's.
        trusted: scope.trusted && seal !== undefined && isProductBackend(seal.backend),
        // C6: what the provider declared its CLI needs from the daemon's environment.
        ...(seal ? { passthrough: profileDeclarations(seal.backend)?.passthroughEnv ?? [] } : {}),
      });
    },
  };
}
