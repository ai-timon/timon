/** Public plugin types, extracted from the host implementations (TODO #512). */
import type {
  BackendCapabilities, CatalogModel, PermissionModel, RateLimitReporting, ReasoningControl,
} from './provider-kit.js';

/** A subject the provider has not seen work on the real program (`declares.unverified`). */
export type PluginBackendUnverified = {
  subject: 'session' | 'mcp' | 'permissions' | 'sign-in' | 'models' | 'extension-requests' | 'credential-dirs' | 'binary-identity';
  note: string;
};

/**
 * The catalogue as the page and the tool read it. Spelled out from what
 * `catalogForViewer` (`plugins-bundled/backends/account-routes.ts`) returns:
 * that module proves at compilation that both agree (TODO #512, volet 3).
 */
export type PluginBackendCatalog = {
  backends: {
    signedIn: boolean | null;
    id: string;
    label: string;
    vendor?: string;
    brand?: string;
    icon?: string;
    models: CatalogModel[];
    defaultModel: string | null;
    custom?: boolean;
    slugPrefixes?: string[];
    permissionModel: PermissionModel;
    rateLimitReporting: RateLimitReporting;
    accountUsage: boolean;
    sessionResumable: boolean;
    selfManagedPermissions?: boolean;
    permissionModeApplied?: boolean;
    supportedPermissionModes?: string[];
    remote?: boolean;
    capabilities: BackendCapabilities;
    nativeCompact?: boolean;
    subscription?: { note: string; planMaxToggle?: boolean };
    instanceOf?: string;
    account?: { id: string; name: string };
    thinkingControls?: ReasoningControl['type'][];
    signInCommand?: string;
    signInThen?: string;
    unverified?: PluginBackendUnverified[];
  }[];
  defaultBackend: string | null;
  modelBrands: { match: string; brand: string }[];
};
