/**
 * Developer mode (`developer.unsignedPlugins`): what the Settings switch and
 * the install sheet read and write, through `/api/ui/plugins/developer`.
 *
 * `requested` is the wish the config holds; `effective` is what the daemon
 * applies, after the licence. Only `effective` may say "on": a wish the licence
 * refuses must never read as unsigned code that runs. The only refusal is a
 * fixed plugin composition (the daemon's `DeveloperModeState` says why): Free
 * and paid licences both admit developer mode.
 */
import { fetchCapabilities } from '@/lib/capabilities';
import { t } from '@/lib/i18n';
import type { BundleChildPreview, PluginPreview } from '@/lib/plugin-install';
import type { SettingsTarget } from '@/lib/settings-layout';

export type DeveloperModeState = {
  requested: boolean;
  effective: boolean;
  /** Turning it on would take effect, licence included. */
  available: boolean;
  blockedBy: 'plugin_composition_fixed' | null;
};

/** Where the switch lives: Settings › Plugins › Developer mode. */
export const DEVELOPER_MODE_TARGET: SettingsTarget = { category: 'plugins', tab: 'developer' };

const ENDPOINT = '/api/ui/plugins/developer';

export class DeveloperModeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'DeveloperModeError';
  }
}

function errorMessage(status: number, code: string): string {
  if (status === 401) return t('developerMode.errors.unauthenticated');
  if (status === 403 && code === 'plugin_composition_fixed') return t('freeLicense.plugin_composition_fixed');
  if (status === 403) return t('developerMode.errors.forbidden');
  return t('developerMode.errors.generic', { status });
}

async function call(init: RequestInit): Promise<DeveloperModeState> {
  const response = await fetch(ENDPOINT, { ...init, cache: 'no-store' });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof (json as { error?: unknown } | null)?.error === 'string' ? (json as { error: string }).error : '';
    throw new DeveloperModeError(response.status, code, errorMessage(response.status, code));
  }
  return json as DeveloperModeState;
}

export function fetchDeveloperMode(): Promise<DeveloperModeState> {
  return call({ method: 'GET' });
}

/**
 * Flips the mode. The daemon has already recomposed the plugin tree when it
 * answers; the capabilities are read again so every screen that shows the
 * mode (the gallery banner, the sheet's verdict) follows at once.
 */
export async function setDeveloperMode(enabled: boolean): Promise<DeveloperModeState> {
  const state = await call({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
  void fetchCapabilities(true);
  return state;
}

/** Why the switch cannot be turned on, or `null` when it can. */
export function developerModeBlockedText(state: DeveloperModeState): string | null {
  return state.blockedBy === 'plugin_composition_fixed' ? t('developerMode.blocked.fixed') : null;
}

function unsignedChild(child: BundleChildPreview): boolean {
  return child.state === 'install' && child.signature?.state === 'unsigned';
}

/** The package, or one of the children a bundle would install, carries no signature. */
export function previewHasUnsignedCode(preview: PluginPreview): boolean {
  return preview.signature.state === 'unsigned' || (preview.children ?? []).some(unsignedChild);
}
