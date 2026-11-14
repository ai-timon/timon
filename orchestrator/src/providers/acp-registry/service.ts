/**
 * The generic ACP provider: pick an agent of the official registry, download
 * its program, verify it, run it as a `acp` backend, update it later.
 *
 * Trust, in the order it is applied:
 *  1. the registry document is parsed with zod (`schema.ts`), entry by entry;
 *  2. the download is https-only and size-capped; when the registry published a
 *     sha256 a mismatch deletes the file and fails the install. When it did NOT
 *     (about half of the targets, Cursor among them), nothing is silently
 *     accepted: the caller must say `acceptUnverified`, and the install is
 *     recorded as `unverified`;
 *  3. the archive is opened by `archive.ts` (no traversal, no links);
 *  4. the extracted tree is hashed; that digest is re-checked every time the
 *     profile is registered, so a file altered afterwards is never launched;
 *  5. the registry's `env` is never read.
 *
 * An install made without a hash is never upgraded behind the person's back:
 * when the registry later publishes a sha256 for this machine's build, the view
 * says so (`installed.verifiedUpdate`) and an install of that build is allowed
 * even at the same version — through the same swap as any update.
 *
 * An update installs the new version in its own folder, verifies it, then swaps
 * the profile through `beginProviderSwap`: a mission starting during the swap
 * still finds the backend, and missions already running keep the process they
 * have. The previous version folder is kept one generation.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { readAuthMethods, type AcpAuthMethodInfo } from '../../backends/acp/auth.js';
import { acpTransportOver } from '../../backends/acp/conversation-transport.js';
import { defineProvider } from '../../backends/acp/provider.js';
import { registerLaunchProvenance } from '../../backends/launch-provenance.js';
import { sealFor } from '../../backends/launch-seal.js';
import { createProviderBinary } from '../../backends/provider-binary.js';
import { providerMcpPlan } from '../../backends/provider-mcp.js';
import { beginProviderSwap, registerProvider, registerTrustedProfile, ProviderDefinitionError } from '../../backends/registry.js';
import type { BackendProfile } from '../../backends/types.js';
import {
  ArchiveError, extractTarGz, extractZip, installRaw, type ExtractLimits, DEFAULT_EXTRACT_LIMITS,
} from './archive.js';
import { DownloadError, downloadVerified, type Fetcher } from './download.js';
import {
  archiveKind, parseRegistry, REGISTRY_URL, supportOf, type AgentSupport, type ParsedRegistry, type RegistryAgent,
} from './schema.js';
import {
  acpRegistryPaths, hashTree, readState, writeState, type InstalledAgent,
} from './store.js';
import { authMethodViews, registrySignIn, type AuthMethodView } from './sign-in.js';

export const ACP_REGISTRY_OWNER = 'acp-registry';
const REGISTRY_MAX_BYTES = 5 * 1024 * 1024;
const REGISTRY_TTL_MS = 10 * 60_000;
const DOWNLOAD_MAX_BYTES = 600 * 1024 * 1024;

export class AcpRegistryError extends Error {
  constructor(
    readonly code:
      | 'registry-unavailable' | 'unknown-agent' | 'unsupported' | 'unverified' | 'already-installed' | 'not-installed'
      | 'download-failed' | 'checksum' | 'archive' | 'command-missing' | 'tampered' | 'busy' | 'definition-refused'
      | 'not-ready' | 'inspect-failed',
    message: string,
    readonly status: 400 | 404 | 409 | 502 = 400,
  ) {
    super(message);
    this.name = 'AcpRegistryError';
  }
}

export type InstallState = 'ok' | 'tampered' | 'missing' | 'pending';

export type AgentView = {
  id: string;
  name: string;
  version: string;
  description: string | null;
  website: string | null;
  license: string | null;
  supported: boolean;
  /** Why not, when `supported` is false. */
  reason: string | null;
  /** `sha256` = verified against the registry; `none` = the registry gives no hash. */
  integrity: 'sha256' | 'none' | null;
  installed: null | {
    version: string;
    integrity: 'sha256' | 'unverified';
    updateAvailable: boolean;
    /**
     * The installed build is `unverified` and the registry now publishes a sha256 for this machine's build
     * (at the top-level `version`, which may be the same): installing it again replaces it with a verified one.
     */
    verifiedUpdate: boolean;
    state: InstallState;
    profileId: string;
  };
};

export type ServiceOptions = {
  home: string;
  fetchFn?: Fetcher;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => number;
  limits?: ExtractLimits;
  maxDownloadBytes?: number;
  /** Tests stand in for the profile registry. */
  register?: (agent: InstalledAgent, command: string) => () => void;
  /** Tests stand in for the agent: what its `initialize` answers as `authMethods`. */
  inspect?: (agent: InstalledAgent, command: string) => Promise<unknown>;
};

export function profileIdOf(agentId: string): string {
  return `acp-${agentId}`;
}

/** A provider id is at most 64 characters, an agent id may be 64 on its own: past 64 the dialect id keeps a readable head and a hash of the whole. */
const MAX_DIALECT_ID = 64;

export function dialectIdOf(agentId: string): string {
  const profileId = profileIdOf(agentId);
  if (profileId.length <= MAX_DIALECT_ID) return profileId;
  return `${profileId.slice(0, MAX_DIALECT_ID - 9)}-${createHash('sha256').update(agentId).digest('hex').slice(0, 8)}`;
}

/**
 * An agent downloaded from the registry is THIRD-PARTY code: it must not run on a
 * dialect `isProductDialect` trusts with the mission token and the vault slice
 * (SECURITY.md § 6.4.1). Each installed agent is its OWN provider — the same ACP
 * runtime the product's agents use, a definition of its own — registered by the
 * `acp-registry` owner and never marked trusted, so `isProductBackend('acp-<id>')`
 * is false, which fails closed on every credential. The dialect id is the profile's,
 * as for every provider (a declaration is kept by dialect, and two agents share none).
 *
 * The check a plugin's provider goes through at registration (`registerProvider`,
 * strict) applies here too and BLOCKS: an agent whose definition contradicts itself
 * is refused (`refused`), at install and, when the daemon restores what is installed,
 * left unregistered with a warning. It was only a warning when every agent shared
 * the product's dialect, which nothing could contradict.
 */
function defaultRegister(agent: InstalledAgent, command: string): () => void {
  const profileId = profileIdOf(agent.id);
  const dialectId = dialectIdOf(agent.id);
  const profile: BackendProfile = {
    id: profileId,
    dialect: dialectId,
    label: agent.name,
    vendor: agent.name,
    cmd: command,
    custom: true,
    defaultModel: null,
    models: [],
    subscription: {
      note: `Runs ${agent.name} ${agent.version}, installed from the ACP registry. Calls go through the account the agent itself is signed in to (its own login command).`,
    },
  };
  // The program the user installed and the daemon verified: probing its models needs no allowlist entry
  // (a downloaded program is on no PATH and in no operator list), still no environment of the daemon's.
  const binary = createProviderBinary({ pluginId: ACP_REGISTRY_OWNER, trusted: true, authorizedBinaries: [command] });
  const definition = defineProvider({
    mcp: (spawn, options) => {
      // The launch of THIS agent only: another backend's seal is not this agent's to read.
      const live = sealFor(spawn.missionId);
      const seal = live?.backend === profileId ? live : undefined;
      return providerMcpPlan({ spawn: seal?.spawn ?? spawn, seal, ...(options ? { options } : {}) });
    },
    // The one program this agent runs is the installed command, whatever label the definition declares it under.
    binary: { converse: (_label, args, options) => binary.api.converse(command, args, options) },
  }, {
    id: dialectId,
    args: agent.args,
    // A bare label (a declaration names programs, never paths): the downloaded program is on no PATH, its profile
    // carries the absolute command, and nothing resolves this name — the host's resolution never sees a path.
    binary: { names: [dialectId] },
    // `permissionsByAgent: false` is the ACP default: the agent asks, Timon's card and classifier answer.
    permissionsByAgent: false,
    // No `authenticateWith`: a method of an agent nobody reviewed may open a browser or pick a billed account,
    // so Timon never starts one by itself. The sentence says which step to take, never a billed one.
    signIn: registrySignIn(agent.name, command, agent.authMethods ?? null),
    modelProbe: 'session-new',
  });
  let offProvider: () => void;
  try {
    offProvider = registerProvider(ACP_REGISTRY_OWNER, definition);
  } catch (err) {
    void binary.stopAll();
    if (err instanceof ProviderDefinitionError) throw new AcpRegistryError('definition-refused', `${agent.name} was refused: ${err.problems.join('; ')}`, 502);
    throw err;
  }
  let offProfile: () => void;
  try { offProfile = registerTrustedProfile(ACP_REGISTRY_OWNER, profile); } catch (err) { offProvider(); void binary.stopAll(); throw err; }
  // The one program a mission on this agent may launch: the one installed here, typed by its origin (TODO #531).
  const offProvenance = registerLaunchProvenance(profileId, { source: 'acp-registry', path: command, version: agent.version });
  return () => { offProvenance(); offProfile(); offProvider(); void binary.stopAll(); };
}

/** The handshake only: no session is opened, so nothing lands in the agent's own history. */
const INSPECT_MS = 20_000;

async function defaultInspect(agent: InstalledAgent, command: string): Promise<unknown> {
  const binary = createProviderBinary({ pluginId: ACP_REGISTRY_OWNER, trusted: true, authorizedBinaries: [command] });
  try {
    const channel = acpTransportOver(await binary.api.converse(command, agent.args, { timeoutMs: INSPECT_MS }), { requestTimeoutMs: INSPECT_MS - 5_000 });
    try { return (await channel.transport.initialize()).authMethods ?? []; } finally { await channel.stop(); }
  } finally {
    await binary.stopAll();
  }
}

export class AcpRegistryService {
  private readonly paths;
  private readonly fetchFn: Fetcher;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly now: () => number;
  private readonly limits: ExtractLimits;
  private readonly maxDownload: number;
  private readonly register: (agent: InstalledAgent, command: string) => () => void;
  private readonly inspect: (agent: InstalledAgent, command: string) => Promise<unknown>;
  private readonly live = new Map<string, () => void>();
  private readonly health = new Map<string, InstallState>();
  private cache: { at: number; registry: ParsedRegistry } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: ServiceOptions) {
    this.paths = acpRegistryPaths(opts.home);
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.platform = opts.platform ?? process.platform;
    this.arch = opts.arch ?? process.arch;
    this.now = opts.now ?? Date.now;
    this.limits = opts.limits ?? DEFAULT_EXTRACT_LIMITS;
    this.maxDownload = opts.maxDownloadBytes ?? DOWNLOAD_MAX_BYTES;
    this.register = opts.register ?? defaultRegister;
    this.inspect = opts.inspect ?? defaultInspect;
  }

  /** One mutation at a time: two installs of one agent would race on its folder. */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /* ── registry ──────────────────────────────────────────────────────────── */

  private async registry(force = false): Promise<{ registry: ParsedRegistry; stale: boolean }> {
    if (!force && this.cache && this.now() - this.cache.at < REGISTRY_TTL_MS) return { registry: this.cache.registry, stale: false };
    try {
      const res = await this.fetchFn(REGISTRY_URL, { redirect: 'manual' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > REGISTRY_MAX_BYTES) throw new Error('registry document too large');
      const text = await res.text();
      if (text.length > REGISTRY_MAX_BYTES) throw new Error('registry document too large');
      const registry = parseRegistry(JSON.parse(text));
      this.cache = { at: this.now(), registry };
      return { registry, stale: false };
    } catch (err) {
      // A registry that cannot be reached must not take the installed agents with it.
      if (this.cache) return { registry: this.cache.registry, stale: true };
      throw new AcpRegistryError('registry-unavailable', `the ACP registry could not be read (${(err as Error).message})`, 502);
    }
  }

  async list(opts: { refresh?: boolean } = {}): Promise<{ registryVersion: string; dropped: number; stale: boolean; agents: AgentView[] }> {
    const { registry, stale } = await this.registry(opts.refresh === true);
    const installed = readState(this.paths);
    const agents = registry.agents.map((agent) => this.view(agent, installed[agent.id]));
    // An installed agent the registry no longer lists stays manageable.
    for (const entry of Object.values(installed)) {
      if (registry.agents.some((agent) => agent.id === entry.id)) continue;
      agents.push({
        id: entry.id, name: entry.name, version: entry.version, description: null, website: null, license: null,
        supported: false, reason: 'no longer listed in the registry', integrity: null,
        installed: this.installedView(entry, null, null),
      });
    }
    agents.sort((a, b) => Number(!!b.installed) - Number(!!a.installed) || Number(b.supported) - Number(a.supported) || a.name.localeCompare(b.name));
    return { registryVersion: registry.version, dropped: registry.dropped, stale, agents };
  }

  private installedView(entry: InstalledAgent, latest: string | null, support: AgentSupport | null): NonNullable<AgentView['installed']> {
    return {
      version: entry.version,
      integrity: entry.integrity,
      updateAvailable: latest !== null && latest !== entry.version,
      verifiedUpdate: entry.integrity === 'unverified' && support?.supported === true && support.integrity === 'sha256',
      state: this.health.get(entry.id) ?? 'pending',
      profileId: profileIdOf(entry.id),
    };
  }

  private view(agent: RegistryAgent, entry: InstalledAgent | undefined): AgentView {
    const support = supportOf(agent, this.platform, this.arch);
    return {
      id: agent.id,
      name: agent.name,
      version: agent.version,
      description: agent.description ?? null,
      website: agent.website ?? null,
      license: agent.license ?? null,
      supported: support.supported,
      reason: support.supported ? null : support.reason,
      integrity: support.supported ? support.integrity : null,
      installed: entry ? this.installedView(entry, agent.version, support) : null,
    };
  }

  /* ── install / update ──────────────────────────────────────────────────── */

  install(agentId: string, opts: { acceptUnverified?: boolean } = {}): Promise<AgentView> {
    return this.serial(() => this.installNow(agentId, opts));
  }

  private async installNow(agentId: string, opts: { acceptUnverified?: boolean }): Promise<AgentView> {
    const { registry } = await this.registry();
    const agent = registry.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new AcpRegistryError('unknown-agent', 'no such agent in the registry', 404);
    const support: AgentSupport = supportOf(agent, this.platform, this.arch);
    if (!support.supported) throw new AcpRegistryError('unsupported', `${agent.name} cannot be installed here: ${support.reason}`, 409);
    if (support.integrity === 'none' && opts.acceptUnverified !== true) {
      throw new AcpRegistryError(
        'unverified', `${agent.name} publishes no sha256 for this build: its integrity rests on https alone. Confirm to install it anyway.`, 409,
      );
    }

    const state = readState(this.paths);
    const current = state[agent.id];
    // The same version stays installable when it can now replace an unverified install with a verified one.
    const verifies = current?.integrity === 'unverified' && support.integrity === 'sha256';
    if (current && current.version === agent.version && this.health.get(agent.id) === 'ok' && !verifies) {
      throw new AcpRegistryError('already-installed', `${agent.name} ${agent.version} is already installed and intact`, 409);
    }

    mkdirSync(this.paths.tmp, { recursive: true, mode: 0o700 });
    const work = join(this.paths.tmp, randomBytes(8).toString('hex'));
    const final = this.paths.versionDir(agent.id, agent.version);
    const partial = `${final}.partial`;
    const kind = archiveKind(support.entry.archive)!;
    try {
      mkdirSync(work, { recursive: true, mode: 0o700 });
      const archive = join(work, 'download');
      let download: { sha256: string };
      try {
        download = await downloadVerified(support.entry.archive, archive, {
          fetchFn: this.fetchFn, maxBytes: this.maxDownload, expectedSha256: support.entry.sha256,
        });
      } catch (err) {
        if (err instanceof DownloadError) {
          throw new AcpRegistryError(err.code === 'checksum' ? 'checksum' : 'download-failed', err.message, 502);
        }
        throw err;
      }

      rmSync(partial, { recursive: true, force: true });
      try {
        if (kind === 'tar.gz') await extractTarGz(archive, partial, this.limits);
        else if (kind === 'zip') await extractZip(archive, partial, this.limits);
        else installRaw(archive, partial, support.entry.cmd);
      } catch (err) {
        if (err instanceof ArchiveError) throw new AcpRegistryError('archive', `the archive was refused: ${err.message}`, 502);
        throw err;
      }

      const command = this.commandWithin(partial, kind === 'raw' ? support.entry.cmd.replaceAll('\\', '/').split('/').pop()! : support.entry.cmd);
      chmodSync(command.absolute, 0o755);
      const treeSha256 = await hashTree(partial);

      // The same bytes as the build in place (an unverified install the registry now hashes): the files stay where
      // they are, so nothing a running mission holds is replaced; only the record becomes verified. The folder is
      // hashed again here: its health dates from boot, and a file altered since then must not be blessed as verified.
      const sameTree = current?.version === agent.version && current.treeSha256 === treeSha256 && existsSync(final)
        && this.health.get(agent.id) === 'ok' && await hashTree(final) === treeSha256;
      if (!sameTree) {
        // Promote only now that everything held: a failed install leaves the old version alone.
        rmSync(final, { recursive: true, force: true });
        renameSync(partial, final);
      }

      const next: InstalledAgent = {
        id: agent.id,
        name: agent.name,
        version: agent.version,
        target: support.target,
        integrity: support.integrity === 'sha256' ? 'sha256' : 'unverified',
        archiveSha256: download.sha256,
        treeSha256,
        cmd: command.relative,
        args: support.entry.args,
        installedAt: this.now(),
        // Re-installing the same version keeps the generation before it.
        ...(current && current.version !== agent.version ? { previousVersion: current.version }
          : current?.previousVersion ? { previousVersion: current.previousVersion } : {}),
      };
      const program = join(final, ...command.relative.split('/'));
      // How it signs in, read before it goes live so the very first mission can say it. Best effort: an agent
      // that does not answer is still installed, and the settings screen can ask again.
      const methods = await this.readMethods(next, program).catch(() => null);
      if (methods) next.authMethods = methods;
      try {
        this.swapIn(next, program);
      } catch (err) {
        // Nothing points at the new folder: do not leave it behind.
        if (current?.version !== agent.version) rmSync(final, { recursive: true, force: true });
        throw err;
      }
      this.health.set(agent.id, 'ok');
      writeState(this.paths, { ...state, [agent.id]: next });
      this.prune(next);
      return this.view(agent, next);
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(partial, { recursive: true, force: true });
    }
  }

  /* ── sign-in ───────────────────────────────────────────────────────────── */

  private async readMethods(agent: InstalledAgent, program: string): Promise<AcpAuthMethodInfo[]> {
    return readAuthMethods(await this.inspect(agent, program));
  }

  /**
   * Asks the installed agent how it signs in (its `initialize`), keeps the answer, and re-registers the agent
   * when it changed so that a mission's sign-in sentence follows. Starts the agent's program: a person's click,
   * never a page load.
   */
  authMethods(agentId: string): Promise<{ methods: AuthMethodView[] }> {
    return this.serial(async () => {
      const state = readState(this.paths);
      const agent = state[agentId];
      if (!agent) throw new AcpRegistryError('not-installed', 'this agent is not installed', 404);
      if (this.health.get(agentId) !== 'ok') {
        throw new AcpRegistryError('not-ready', `${agent.name} is not ready to run: repair it first`, 409);
      }
      const program = join(this.paths.versionDir(agent.id, agent.version), ...agent.cmd.split('/'));
      let methods: AcpAuthMethodInfo[];
      try {
        methods = await this.readMethods(agent, program);
      } catch (err) {
        console.warn(`[acp-registry] ${agent.id}: initialize failed: ${(err as Error).message}`);
        throw new AcpRegistryError('inspect-failed', `${agent.name} did not say how it signs in`, 502);
      }
      if (JSON.stringify(methods) !== JSON.stringify(agent.authMethods ?? null)) {
        const next: InstalledAgent = { ...agent, authMethods: methods };
        this.swapIn(next, program);
        writeState(this.paths, { ...state, [agent.id]: next });
      }
      return { methods: authMethodViews(methods, program) };
    });
  }

  /** The program inside a folder, proven to be a file that stays inside it. */
  private commandWithin(dir: string, cmd: string): { absolute: string; relative: string } {
    const parts = cmd.replaceAll('\\', '/').split('/').filter((part) => part !== '' && part !== '.');
    if (parts.length === 0 || parts.some((part) => part === '..' || part.includes('\0')) || isAbsolute(cmd) || /^[a-zA-Z]:/.test(cmd)) {
      throw new AcpRegistryError('command-missing', 'the registry gave an unusable program path', 502);
    }
    const root = resolve(dir);
    const absolute = resolve(root, ...parts);
    if (!absolute.startsWith(root + sep) || !existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new AcpRegistryError('command-missing', 'the program named by the registry is not in the archive', 502);
    }
    return { absolute, relative: parts.join('/') };
  }

  /** Replaces the live registration atomically: the backend never disappears. */
  private swapIn(agent: InstalledAgent, command: string): void {
    const end = beginProviderSwap(ACP_REGISTRY_OWNER);
    try {
      this.live.get(agent.id)?.();
      this.live.delete(agent.id);
      this.live.set(agent.id, this.register(agent, command));
    } finally {
      end();
    }
  }

  /** Keeps the version in use and the one before it; the rest is deleted. */
  private prune(agent: InstalledAgent): void {
    const base = join(this.paths.agents, agent.id);
    if (!existsSync(base)) return;
    for (const name of readdirSync(base)) {
      if (name === agent.version || name === agent.previousVersion) continue;
      // A program still running from an old version can make this fail on Windows: next update retries.
      try { rmSync(join(base, name), { recursive: true, force: true }); } catch { /* retried later */ }
    }
  }

  /* ── remove / restore ──────────────────────────────────────────────────── */

  remove(agentId: string): Promise<void> {
    return this.serial(async () => {
      const state = readState(this.paths);
      if (!state[agentId]) throw new AcpRegistryError('not-installed', 'this agent is not installed', 404);
      this.live.get(agentId)?.();
      this.live.delete(agentId);
      this.health.delete(agentId);
      const { [agentId]: _gone, ...rest } = state;
      writeState(this.paths, rest);
      try { rmSync(join(this.paths.agents, agentId), { recursive: true, force: true }); } catch { /* in use on Windows: the state no longer lists it */ }
    });
  }

  /**
   * At daemon start: register what is installed, but only what still hashes to
   * what was verified. A folder that changed is reported `tampered` and NOT
   * registered. Resolves when every agent has been judged.
   */
  restore(): Promise<void> {
    return this.serial(async () => {
      for (const agent of Object.values(readState(this.paths))) {
        const dir = this.paths.versionDir(agent.id, agent.version);
        if (!existsSync(dir)) { this.health.set(agent.id, 'missing'); continue; }
        let digest: string;
        try { digest = await hashTree(dir); } catch { this.health.set(agent.id, 'missing'); continue; }
        if (digest !== agent.treeSha256) {
          this.health.set(agent.id, 'tampered');
          console.warn(`[acp-registry] ${agent.id}@${agent.version}: files changed since they were verified — not registered`);
          continue;
        }
        try {
          this.swapIn(agent, join(dir, ...agent.cmd.split('/')));
          this.health.set(agent.id, 'ok');
        } catch (err) {
          this.health.set(agent.id, 'missing');
          console.warn(`[acp-registry] ${agent.id}: ${(err as Error).message}`);
        }
      }
    });
  }

  /** Unregisters everything (daemon stop, tests). Files stay. */
  dispose(): void {
    for (const off of this.live.values()) off();
    this.live.clear();
  }
}
