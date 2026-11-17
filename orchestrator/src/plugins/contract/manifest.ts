/**
 * The `timon` field of a plugin's `package.json`, as the SDK publishes it
 * (TODO #512, volet 4). Spelled out from `plugins/manifest.ts`, whose zod schema
 * validates it: deriving it (`z.infer`) would put zod and the daemon's manifest
 * checks in every plugin's types. `plugins/manifest-contract-guards.ts` proves
 * at compilation that both say the same thing. What each field means is
 * documented on the schema.
 */
import type { PluginPermission } from './permissions.js';

/**
 * The plugin contract this daemon implements. A manifest declares the minimum
 * it targets (`apiVersion`); the daemon accepts anything `<=` this. Kept equal
 * to the daemon's own constant by `plugins/manifest-contract-guards.ts`: bump
 * both together (the history of each version is beside the daemon's).
 */
export const PLUGIN_API_VERSION = 18;

/**
 * What a plugin is; spelled out from `PLUGIN_KINDS`. Not exported by the SDK:
 * `@inline` writes its values out where the reference uses it.
 * @inline
 */
export type PluginKind =
  | 'widget'
  | 'page'
  | 'island'
  | 'overlay'
  | 'theme'
  | 'composer'
  | 'layout'
  | 'behavior'
  | 'provider'
  | 'dictation'
  | 'bundle';

/** A setting the plugin declares, edited in `/settings`. */
export type PluginSetting = {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'secret';
  label: string;
  /** Proposed in `/settings` until the user enters a value. */
  default?: string | number | boolean | undefined;
};

/** An incoming webhook (`ctx.webhooks.on`); `auth` names the signature format the host verifies. */
export type PluginWebhookDecl = {
  name: string;
  auth: 'standard' | 'github' | 'gitea' | 'forgejo' | 'gitlab' | 'stripe' | 'slack' | 'shopify' | 'linear' | 'discord' | 'meta';
};

/**
 * What a `provider` plugin asks of the machine: names, never paths. Not
 * exported by the SDK: `@inline` writes it out where the reference uses it.
 * @inline
 */
export type PluginProviderDecl = {
  binaries: {
    name: string;
    aliases: string[];
    identity?: {
      pattern: string;
      args?: string[] | undefined;
      expected?: string | undefined;
    } | undefined;
  }[];
  osCredentials: {
    service: string;
    account?: string | undefined;
  }[];
  credentialDirs: string[];
  backends?: unknown[] | undefined;
};

/**
 * The two dictation blocks, held as members of a carrier type rather than
 * declared as aliases of their own: `contract-surface.json` records them as
 * the daemon's schema prints them, expanded, and an alias of an object literal
 * prints by its name. A member read through an indexed access carries no alias,
 * the way a `z.infer` does not. `'daemon'` comes before `'none'` for the same
 * record: a union prints its literals in the order the checker first met them.
 */
type DictationShapes = {
  engine: {
    id: string;
    runtime: 'page' | 'daemon';
    /** Where the voice goes: nowhere, the daemon, or these hosts. Shown at install. */
    egress: 'daemon' | 'none' | string[];
  };
  decl: {
    engines: {
      id: string;
      runtime: 'page' | 'daemon';
      egress: 'daemon' | 'none' | string[];
    }[];
    models?: string | undefined;
  };
};

/** One speech-to-text engine of a `dictation` plugin. */
export type PluginDictationEngineDecl = DictationShapes['engine'];

/** What a `dictation` plugin says of itself (API 14). */
export type PluginDictationDecl = DictationShapes['decl'];

/**
 * The parts a mascot pack adds (API 15), by look field: slugs, each stored in
 * an agent's look as `<pluginId>:<slug>` while the plugin is installed and
 * enabled. The drawing is registered by the browser half in `mascot.parts`.
 */
export type PluginMascotDecl = {
  shape?: string[] | undefined;
  color?: string[] | undefined;
  eyes?: string[] | undefined;
  acc?: string[] | undefined;
};

/**
 * A vault entry the plugin will ask for, by name: `read` for `ctx.secrets.get`
 * (needs `secrets:read`), `broker` for `ctx.secrets.httpCall` or a git
 * credential (needs `secrets:broker`). `why` is shown as written at install.
 * A declaration, not a grant: the operator still grants it.
 */
export type PluginSecretDecl = {
  name: string;
  mode: 'read' | 'broker';
  why?: string | undefined;
};

/** A host the plugin's `ctx.fetch` will reach (needs `http:outbound`), in the form of `pluginPolicy.http.allow`. */
export type PluginHttpHostDecl = {
  host: string;
  why?: string | undefined;
};

/** The hosts the plugin will reach, shown at install. */
export type PluginHttpDecl = {
  hosts: PluginHttpHostDecl[];
};

/**
 * A plugin manifest once read: `kind` is always a list, deduced when the
 * package omits it. Spelled out as one object rather than as the daemon's
 * `Omit<…> & { kind }` (TODO #578): an intersection with an unexported base
 * left the SDK reference with no field to list. The guard compares it to the
 * daemon's type flattened, so the two forms still have to say the same thing.
 */
/** One anonymous path: `GET` or `POST`, relative to `/api/plugins/<id>`, `/segment` or `/:param`. */
export type PluginPublicPathDecl = { method: 'GET' | 'POST'; path: string };

export type PluginRoutesDecl = { publicPaths: PluginPublicPathDecl[] };

export type PluginManifest = {
  id: string;
  apiVersion: number;
  kind: PluginKind[];
  label?: string | undefined;
  description?: string | undefined;
  author?: string | undefined;
  cover?: string | undefined;
  icon?: string | undefined;
  screenshots: string[];
  permissions: PluginPermission[];
  client?: {
    slots: string[];
    external: string[];
    mode: 'esm' | 'iframe';
  } | undefined;
  declares: Record<string, 'single' | 'list' | 'keyed'>;
  route?: string | undefined;
  modifies: string[];
  contains: string[];
  settings: PluginSetting[];
  webhooks?: PluginWebhookDecl[] | undefined;
  backends?: unknown[] | undefined;
  provider?: PluginProviderDecl | undefined;
  dictation?: PluginDictationDecl | undefined;
  mascot?: PluginMascotDecl | undefined;
  secrets?: PluginSecretDecl[] | undefined;
  http?: PluginHttpDecl | undefined;
  /** API 15 — folder of the package holding the migrations of `ctx.sql` (`NNN-name.sql`). Requires `storage:sql`. */
  migrations?: string | undefined;
  /** API 15 — routes reachable without a session, under the plugin prefix. Requires `http:public`. */
  routes?: PluginRoutesDecl | undefined;
  license: {
    required: boolean;
  };
};
