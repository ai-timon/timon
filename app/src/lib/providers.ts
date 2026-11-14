/**
 * The provider screen's data (Settings › AI models › Providers): provider
 * plugins with the binaries they launch, and the ACP registry. The daemon
 * decides who may do what (a superadmin signed in to the app); this module only
 * types its answers and turns them into the sentences and states the panel shows.
 */
import { t } from '@/lib/i18n';

export type ProviderBinary = {
  name: string;
  found: string | null;
  /** Absolute path on the daemon's machine, `null` when the program is not installed. */
  resolved: string | null;
  allowed: boolean;
  /** Why this program can never be authorized. */
  refused: string | null;
};

export type ProviderPlugin = {
  id: string;
  label: string;
  version: string;
  state: 'active' | 'failed' | 'disabled' | 'skipped';
  reason: string | null;
  error: string | null;
  signed: boolean | null;
  binaries: ProviderBinary[];
  /** The OS credential-store entries the provider reads (macOS keychain), declared in its manifest. */
  osCredentials?: Array<{ service: string; account?: string }>;
  /** The folders of the home the provider keeps its sign-in in, declared in its manifest. */
  credentialDirs?: string[];
  backends: string[];
};

export type AcpAgent = {
  id: string;
  name: string;
  version: string;
  description: string | null;
  website: string | null;
  license: string | null;
  supported: boolean;
  reason: string | null;
  integrity: 'sha256' | 'none' | null;
  installed: null | {
    version: string;
    integrity: 'sha256' | 'unverified';
    updateAvailable: boolean;
    /** Unverified install, and the registry now publishes a sha256 for this machine's build (at `version`). */
    verifiedUpdate?: boolean;
    state: 'ok' | 'tampered' | 'missing' | 'pending';
    profileId: string;
  };
};

/** How an installed agent signs in, as it told the daemon. */
export type AcpAuthMethod = {
  id: string;
  name: string;
  description: string | null;
  kind: 'agent' | 'terminal' | 'env_var';
  /** Paid per token, not through a subscription: never suggested. */
  billedPerToken: boolean;
  recommended: boolean;
  /** The terminal command that signs in, when the agent gave one. */
  command: string | null;
};

export type AcpRegistry = { registryVersion: string; dropped: number; stale: boolean; agents: AcpAgent[] };

const BASE = '/api/ui/providers';

export class ProviderError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}/${path}`, {
    method,
    cache: 'no-store',
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return undefined as T;
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof (json as { error?: unknown } | null)?.error === 'string' ? (json as { error: string }).error : '';
    const message = typeof (json as { message?: unknown } | null)?.message === 'string' ? (json as { message: string }).message : '';
    throw new ProviderError(response.status, code, providerErrorMessage(response.status, code, message));
  }
  return json as T;
}

/** Daemon codes → sentences of the locale; an unknown code keeps the daemon's own (path-free) message. */
export function providerErrorMessage(status: number, code: string, message: string): string {
  if (status === 401 || status === 403) return t('providersSettings.errors.forbidden');
  const known = ['mismatch', 'refused', 'unverified', 'already-installed', 'not-installed', 'unknown-agent', 'unsupported',
    'registry-unavailable', 'download-failed', 'checksum', 'archive', 'command-missing', 'definition-refused', 'authorize-failed', 'failed',
    'not-ready', 'inspect-failed'];
  if (known.includes(code)) return t(`providersSettings.errors.${code}`);
  return message || t('providersSettings.errors.generic', { status });
}

export const fetchProviders = async (): Promise<ProviderPlugin[]> => (await call<{ providers: ProviderPlugin[] }>('GET', 'list')).providers;
export const authorizeProvider = (id: string, paths: string[]): Promise<unknown> => call('POST', `${id}/authorize`, { paths });
export const fetchAcpRegistry = (refresh = false): Promise<AcpRegistry> => call('GET', `acp-registry${refresh ? '?refresh=1' : ''}`);
export const installAcpAgent = (agentId: string, acceptUnverified = false): Promise<unknown> =>
  call('POST', 'acp-registry/install', { agentId, ...(acceptUnverified ? { acceptUnverified: true } : {}) });
export const removeAcpAgent = (agentId: string): Promise<void> => call('DELETE', `acp-registry/${agentId}`);
/** Starts the agent's program on the daemon to read its handshake: on a click only. */
export const fetchAcpAuthMethods = async (agentId: string): Promise<AcpAuthMethod[]> =>
  (await call<{ methods: AcpAuthMethod[] }>('POST', `acp-registry/${agentId}/auth-methods`, {})).methods;

/** The suggested method first, the subscription ones next, those billed per token last. */
export function orderAuthMethods(methods: readonly AcpAuthMethod[]): AcpAuthMethod[] {
  const rank = (m: AcpAuthMethod): number => (m.recommended ? 0 : m.billedPerToken ? 2 : 1);
  return [...methods].sort((a, b) => rank(a) - rank(b));
}

/** What the person must do next about one provider binary. */
export type BinaryAction = 'authorize' | 'ready' | 'install' | 'refused';

export function binaryAction(binary: ProviderBinary): BinaryAction {
  if (binary.refused) return 'refused';
  if (!binary.resolved) return 'install';
  return binary.allowed ? 'ready' : 'authorize';
}

/** Some program of this provider waits for the operator's authorization (new, moved, or withdrawn). */
export function needsAuthorization(provider: ProviderPlugin): boolean {
  return provider.binaries.some((b) => binaryAction(b) === 'authorize');
}

/**
 * The query parameter a refused launch's card opens the panel with
 * (`provider-launch:<id>`, TODO #598): the provider whose program to review.
 */
export const PROVIDER_PARAM = 'provider';

/** The provider the card names, when it has something to authorize; `null` leaves the panel as is. */
export function providerToAuthorize(providers: readonly ProviderPlugin[], id: string | null): ProviderPlugin | null {
  const provider = id ? providers.find((p) => p.id === id) : undefined;
  return provider && needsAuthorization(provider) ? provider : null;
}

/** Paths the daemon expects back when the person accepts a provider's binaries. */
export function pathsToAuthorize(binaries: readonly ProviderBinary[]): string[] {
  return [...new Set(binaries.flatMap((b) => (b.resolved && !b.refused ? [b.resolved] : [])))];
}

/** The button of an ACP agent row. */
export type AcpAgentAction = 'install' | 'update' | 'verify' | 'repair' | 'none';

export function acpAction(agent: AcpAgent): AcpAgentAction {
  if (agent.installed) {
    if (agent.installed.state === 'tampered' || agent.installed.state === 'missing') return agent.supported ? 'repair' : 'none';
    // Offered, never applied by itself: the person replaces an unverified build with the verified one.
    if (agent.installed.verifiedUpdate === true && agent.supported) return 'verify';
    return agent.installed.updateAvailable && agent.supported ? 'update' : 'none';
  }
  return agent.supported ? 'install' : 'none';
}
