/**
 * Manifest of a third-party plugin — the field its `package.json` carries, and nothing
 * else (§10.3 of the plan).
 *
 * This file is the product's ENTRY DOOR: everything a third party declares about
 * itself goes through here before a single line of its code is imported. Two
 * consequences on the way it is written:
 *
 *  - it reads nothing on disk and imports nothing from the plugin. It validates
 *    data already read, which lets the loader (P.3) refuse a package
 *    BEFORE running it — a manifest must never be validated by the code
 *    it is supposed to frame;
 *  - it does not throw. An invalid plugin is not a daemon outage: it is
 *    a `skipped:<code>` entry in the report. Hence the result as a discriminated
 *    union, whose `code`s are exactly the suffixes of the
 *    `skipped:` states of §10.5.
 *
 * The field's key comes from `BRAND.manifestKey` and is never hard-coded:
 * it is a public contract frozen with Phase P, and it has a single source.
 */
import { z } from 'zod';
import { binaryIdentityProblem, credentialDirProblem } from '../backends/provider-declarations.js';
import { BACKEND_HOME_DIRS, providerBackendsProblems } from '../backends/builtin-declarations.js';
import { BRAND } from '../brand.js';
import { WEBHOOK_FORMAT_IDS, WEBHOOK_FORMATS_API_VERSION } from './webhook-format-ids.js';
import { PLUGIN_HOOK_NAME_RE, RESERVED_PLUGIN_ID } from './webhook-path.js';
import { SECRET_NAME_RE } from '../secrets/resolve.js';

/**
 * Version of the `PluginContext` contract (§10.4) this daemon implements.
 *
 * ADDITIVE policy (§10.15): a plugin declares the MINIMAL version it
 * needs, and this daemon accepts everything that is `<= PLUGIN_API_VERSION`. A
 * plugin written for contract 1 therefore keeps running on a daemon that has
 * widened its surface — that is what makes open-core sustainable: adding a
 * capability to the SDK does not break the installed ecosystem.
 *
 * What this number guarantees the other way round: a plugin that declares 3 will
 * never be loaded by a daemon 2, so it does not discover a missing facade
 * at runtime. A new capability announces itself through its PERMISSION and is tested with
 * `ctx.can()`; only a break of shape (member removed or signature
 * changed) justifies a new major, and the surface snapshot
 * (`contract-surface.test.ts`) is there to make it impossible by accident.
 *
 * 11 — provider authors' kit: `@timon-ai/sdk/provider` (code) and
 * `@timon-ai/sdk/testing` (conformance bench). No new permission: a
 * plugin that declares 11 only commits to its dialect not
 * contradicting itself, which `registerDialect` now refuses (docs/SDK-COMPAT.md §23).
 *
 * 12 — `ctx.provider`: the runtime of a provider (codecs, limit
 * detector, session drivers, ACP client) provided by the daemon rather than copied
 * into each plugin, and the services that require a daemon privilege. Under
 * `backends:register`; a member refuses a plugin that declares less than 12
 * (docs/SDK-COMPAT.md §34).
 *
 * 13 — `@timon/ui` exports `useBrowserChrome`: the built-in browser a
 * `browser.toolbar` / `browser.drawer` occupant is painted in. No member of
 * `PluginContext` changes (docs/SDK-COMPAT.md §37). Its `command()` needs the
 * new `browser:control` permission, enforced by the browser half.
 *
 * 14 — `kind: dictation` (TODO #484): a speech-to-text engine in the
 * `dictation.engine` slot, its `dictation` manifest block (where the voice
 * goes, said at install), the sensitive `dictation:engine` permission and the
 * `DictationEngine` types of `@timon-ai/sdk`. No member of `PluginContext`
 * changes (docs/SDK-COMPAT.md §44).
 *
 * 15 — `@timon/ui` exports `useDirectoryBrowser`: the folder request a
 * `directory.picker` occupant is painted for (TIM-0136). API 14 shipped in
 * 0.1.6, so a new export opens a new wave. No member of `PluginContext`
 * changes (docs/SDK-COMPAT.md §71). Same wave, still unpublished: `confirmAction`
 * and `useConfirmDialog`, the confirmation a `confirm.dialog` occupant is
 * painted for (TODO #781, §72); and the deprecated `codexAuth` field leaves
 * the report of `ctx.system.doctor()`, announced at API 12 — read `auth[]`
 * (TODO #555, §73). Same wave: `ctx.agents` writes an agent's skills, MCP
 * servers and team (`skills`, `mcpServers`, `team` of `create` / `update`)
 * and reaches the teams of bots (`ctx.agents.teams.list` / `create`), §74.
 * Same wave: `ctx.agents.export` reads an agent's portable definition under
 * the sensitive `agents:export` permission (agent import, volet 9), §79.
 * Same wave: `createTranslator` of `@timon/ui` reads any language with ICU
 * messages (plurals), and `getLocale` returns any BCP 47 tag, §82.
 * Same wave: `ctx.kanban.todos.attachments` (`list`, `add`, `remove`, `read`)
 * and `PluginTodo.attachment_count`, the files of an idea (TODO #837), §86.
 * Same wave: `ctx.sql`, a plugin's own SQLite database, migrated by the core
 * from the manifest's `migrations` folder before `apply`, under the ordinary
 * permission `storage:sql` (docs/SDK-COMPAT.md §102).
 */
export const PLUGIN_API_VERSION = 15;

/** First contract that knows `kind: dictation` and its manifest block. */
export const DICTATION_API_VERSION = 14;

/** First contract that knows the `mascot` block and the `mascot.parts` slot (docs/AGENT-LOOK.md). */
export const MASCOT_PACK_API_VERSION = 15;

/** The slot a mascot pack's browser half registers the drawing of each part in. */
export const MASCOT_PARTS_SLOT = 'mascot.parts';

/** A public path relative to the plugin prefix: lowercase segments or `:name` parameters, never a wildcard. */
export const PLUGIN_PUBLIC_PATH_RE = /^(\/([a-z0-9][a-z0-9-]{0,62}|:[a-zA-Z][a-zA-Z0-9]{0,30})){1,6}\/?$/;

/**
 * Cordis services a third-party plugin has the right to name in its `inject`
 * (§10.2). Everything else — `db`, `bus`, `dispatcher`… — would give direct
 * access to the core, bypassing the facades and their permission
 * checks. It is the list that closes the product.
 */
export const ALLOWED_INJECT = Object.freeze([
  'kanban',
  'missions',
  'notify',
  'storage',
  'settings',
  'events',
  'http',
  'host',
]) as readonly string[];

/** Declarable permissions (§10.3). Each opens a facade of the `PluginContext`. */
export const PLUGIN_PERMISSIONS = [
  'missions:spawn',
  'missions:read',
  'missions:control',
  'missions:transcript',
  'kanban:write',
  'kanban:read',
  'kanban:read:project',
  'kanban:delete',
  'todos:write',
  'todos:read',
  'triggers:disable',
  'triggers:read',
  'triggers:write',
  'triggers:execute',
  'routines:read',
  'routines:write',
  'pipelines:read',
  'pipelines:write',
  'pipelines:run',
  'notify',
  'storage',
  // API 15 — the plugin's own SQLite database (`ctx.sql`, manifest `migrations`).
  'storage:sql',
  'settings',
  'secrets:read',
  // API 10 — administration and system. All sensitive but `docs:read` (see the two lists below).
  'secrets:list',
  'secrets:manage',
  'secrets:broker',
  'accounts:read',
  'accounts:manage',
  // API 15 — the account provider (`ctx.accountProvider`), sensitive, signed plugins only.
  'accounts:provision',
  // API 15 — the source of the accounts' rights (`ctx.permissionSource`), sensitive, signed plugins only.
  'accounts:permissions-source',
  // API 15 — anonymous routes under the plugin's own prefix (manifest `routes.publicPaths`), sensitive.
  'http:public',
  'plugins:read',
  'plugins:manage',
  'system:read',
  'system:logs',
  'backup:read',
  'backup:manage',
  'browser:read',
  'browser:manage',
  // API 13 — recordings of the built-in browser (TODO #461). Both sensitive.
  'browser:recordings:read',
  'browser:recordings:write',
  // API 13 — the `command()` of `useBrowserChrome()` (browser half only, TODO #461).
  'browser:control',
  // API 13 — annotations of the built-in browser (TODO #468). Both sensitive.
  'browser:annotations:read',
  'browser:annotations:write',
  'docs:read',
  'license:read',
  'users:read',
  'http:outbound',
  'host:exec',
  'events:subscribe',
  'realtime:publish',
  'usage:read',
  'usage:collect',
  'backends:register',
  'events:register',
  'events:publish',
  'workflows:read',
  'workflows:run',
  'workflows:triggers:register',
  'workflows:executors:register',
  'transports:register',
  'connections:read',
  'connections:write',
  'connections:register',
  'connections:users:read',
  'webhooks:receive',
  'agents:read',
  'agents:manage',
  // API 10 — identity docs, inbox, skills, MCP servers, catalogue. Sensitive
  // (SENSITIVE_PLUGIN_PERMISSIONS): `agents:docs:*` (an agent's instructions),
  // `messages:read` (private conversations), `skills:write` and
  // `mcp-servers:write` (what agents load).
  'agents:docs:read',
  'agents:docs:write',
  // API 15 — an agent's portable definition (`ctx.agents.export`). Sensitive.
  'agents:export',
  'messages:send',
  'messages:read',
  'skills:read',
  'skills:write',
  'mcp-servers:read',
  'mcp-servers:write',
  'backends:read',
  'mcp:issue',
  'ui-documents:read',
  'ui-documents:write',
  'questions:read',
  'questions:answer',
  'notifications:read',
  'notifications:write',
  'memory:read',
  'memory:write',
  'projects:read',
  'projects:manage',
  'series:read',
  'series:manage',
  'worktrees:read',
  'worktrees:manage',
  'layout:read',
  'layout:propose',
  'layout:presets',
  'chat:media',
  'chat:command',
  'onboarding:read',
  // API 14 — a dictation engine hears the user's voice (TODO #484). Sensitive.
  'dictation:engine',
] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/**
 * Permissions that change what Timon does on the machine, act on other people's
 * work, validate an action, or hand out a secret or what an agent said, not
 * just read the plugin's own surface. Shown apart when a plugin is installed
 * (`timon plugin add`), so a plugin asking for one is read twice.
 *
 * Together with `ORDINARY_PLUGIN_PERMISSIONS` this list is EXHAUSTIVE over
 * `PLUGIN_PERMISSIONS` (`manifest.test.ts` fails on a permission in neither):
 * a new permission is classified when it is added, with its reason on its line.
 */
export const SENSITIVE_PLUGIN_PERMISSIONS = Object.freeze([
  'accounts:provision', // adds accounts to the install and opens their sessions: who holds it decides who gets in
  'accounts:permissions-source', // answers which rights every account holds
  'http:public', // opens routes to anyone, without a session
  // Work of other people
  'missions:control', // kills, forks and sends into running missions
  'missions:transcript', // reads what the agents said: prompts, summaries, message bodies, spans
  'kanban:delete', // deletes tasks
  'kanban:read:project', // reads the whole board of a granted project, not only the plugin's own tasks
  'triggers:write', // creates and edits schedules, webhooks and event rules that start agents
  'triggers:execute', // fires a trigger now
  'routines:write', // creates and edits recurring missions
  'pipelines:write', // edits pipelines that chain agents
  'pipelines:run', // starts a pipeline: agents run with their tools
  'workflows:run', // starts a workflow
  'memory:read', // what agents remember, which can hold private facts
  'memory:write', // rewrites what every agent remembers
  'agents:manage', // creates, edits and deletes agents, their tools and instructions
  'messages:send', // writes into an agent's inbox as if the owner had
  'projects:manage', // creates, edits and deletes projects
  'series:manage', // drives a series of tasks
  'worktrees:manage', // creates and removes worktrees on disk
  'skills:write', // what agents load
  'mcp-servers:write', // the tools agents load
  // What the owner trusted Timon with
  'questions:answer', // validates dangerous tool requests on the owner's behalf
  'chat:media', // puts a picture or video in the owner's conversation; an https source makes the daemon fetch it
  'chat:command', // proposes a command the owner may paste into their terminal
  'agents:docs:read', // an agent's instructions
  'agents:docs:write', // rewrites an agent's instructions
  'agents:export', // the whole definition of any agent the account may read: instructions, documents, routines
  'messages:read', // private conversations between agents
  // Secrets and access
  'secrets:read', // reads the secret values granted to the plugin
  'secrets:list', // names and grants of the vault
  'secrets:manage', // writes the vault and its grants
  'secrets:broker', // calls an API or fetches a git credential under a brokered identity
  'mcp:issue', // issues bearer tokens for the remote MCP
  'connections:users:read', // other accounts' connections and their secrets
  'accounts:read', // lists accounts
  'accounts:manage', // disables accounts, shares subscription accounts
  'plugins:read', // which plugins and modules are installed, and in what state
  'plugins:manage', // enables and disables other plugins
  // The machine
  'host:exec', // runs binaries on the host (still behind the operator's allowlist)
  'transports:register', // a transport carries agents' replies out and outside messages in, which start missions
  'backends:register', // a backend receives the prompts routed to it, and its binary runs on the host
  'system:read', // the daemon's health and the machine report of `doctor`
  'system:logs', // daemon logs
  'backup:read', // whether and where backups run
  'backup:manage', // turns backups on
  'browser:read', // the project browsers and their state: they hold sign-ins
  'browser:manage', // starts and stops browsers
  'browser:recordings:read', // what the user did and typed in their browser, ready to become a skill
  'browser:recordings:write', // edits and deletes those recordings, masks included
  'browser:control', // drives a signed-in browsing session and can fill saved credentials
  'browser:annotations:read', // what the user pointed at in their browser, what they said about it and what the page showed
  'browser:annotations:write', // resolves, links and deletes those annotations
  'dictation:engine', // hears the user's voice and turns it into text, which may leave the window
] as const satisfies readonly PluginPermission[]);

/**
 * Permissions that read or use only what the plugin, or the account it serves,
 * already owns, or that cannot do harm on their own. The counterpart of
 * `SENSITIVE_PLUGIN_PERMISSIONS`; a permission belongs to exactly one of the two.
 */
export const ORDINARY_PLUGIN_PERMISSIONS = Object.freeze([
  'missions:spawn', // the caller's own missions, bounded by the operator's `pluginPolicy.spawn`
  'missions:read', // the caller's missions and their skeleton, no content
  'kanban:write', // creates and updates tasks on the caller's own board
  'kanban:read', // the caller's own tasks
  'todos:write', // the caller's to-do notebook
  'todos:read', // the caller's to-do notebook
  'triggers:disable', // can only stop a trigger, never start or change one
  'triggers:read', // existence and shape of the caller's triggers
  'routines:read', // existence and shape of the caller's routines
  'pipelines:read', // existence and shape of the caller's pipelines
  'notify', // posts a notification to the caller
  'storage', // the plugin's own key-value store
  'storage:sql', // the plugin's own SQLite file under its data folder, never the daemon's database
  'settings', // the plugin's own declared settings
  'http:outbound', // network egress, behind the operator's `pluginPolicy.http` allowlist
  'events:subscribe', // events scoped to what the caller may see
  'realtime:publish', // pushes to the plugin's own topics
  'usage:read', // aggregated usage figures
  'usage:collect', // reports usage for a backend
  'events:register', // declares events in the plugin's own namespace
  'events:publish', // publishes events in the plugin's own namespace
  'workflows:read', // existence and shape of the caller's workflows
  'workflows:triggers:register', // adds a trigger type; nothing runs until a person wires it
  'workflows:executors:register', // adds a node type; it runs only in workflows a person started
  'connections:read', // the plugin's own connections, secrets stay in the vault
  'connections:write', // the plugin's own connections
  'connections:register', // declares a connection type
  'webhooks:receive', // inbound routes the manifest declares, signed by the plugin
  'agents:read', // agent configuration, scoped to what the caller sees
  'skills:read', // reads skills
  'mcp-servers:read', // reads MCP server declarations, secrets masked
  'backends:read', // the backend catalogue
  'ui-documents:read', // the plugin's own cards
  'ui-documents:write', // cards shown in an isolated frame
  'questions:read', // the caller's pending questions
  'notifications:read', // the caller's notifications
  'notifications:write', // dismisses the caller's notifications
  'projects:read', // the projects the caller sees
  'series:read', // the series the caller sees
  'worktrees:read', // information about a worktree
  'layout:read', // the caller's layout
  'layout:propose', // proposals the owner applies or ignores
  'layout:presets', // saves a layout preset
  'onboarding:read', // the caller's onboarding profile
  'docs:read', // the public documentation, which anyone reads on docs.timon-ai.com
  'license:read', // the edition, `lite` or `expert`, and nothing of the licence itself
  'users:read', // lets the plugin check the caller's `users:read` right; it reads nothing itself
] as const satisfies readonly PluginPermission[]);

export function isPluginPermission(value: string): value is PluginPermission {
  return (PLUGIN_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * UI slot name. Deliberately a SHAPE, not a closed list: the layout
 * itself is a plugin (§10.8), so a third-party layout declares its own
 * slots. Freezing the eight v1 slots here would forbid what §10.8 explicitly
 * allows.
 */
const SlotNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/, 'invalid slot name (expected: `nav.item`, `cockpit.widget`…)');

/**
 * What a plugin IS (plan §10.12). The manifest says its nature; the slots say
 * where it plugs in. Both are needed: a `widget` and an `overlay` can ship in
 * the same package, and the gallery has to name each surface it installs.
 *
 * `provider` is a plugin that brings an LLM backend (`ctx.backends.registerDialect`
 * / `registerProfile`). It occupies no slot; what it needs from the machine is
 * the `provider.binaries` it declares, which the operator authorizes at install
 * (`docs/PROVIDERS-SDK.md` §12.4).
 *
 * `dictation` (API 14) is a speech-to-text engine registered in
 * `dictation.engine`; its `dictation` block says where the voice goes, which
 * the install sheet shows (`docs/DICTATION.md`).
 *
 * `bundle` is the odd one out — it occupies nothing and installs `contains`.
 * `island` (client API 8) is a content type of the island workspace, opened
 * in a tab or a split by the user or an agent (`docs/ISLAND-WORKSPACE.md` §5).
 */
export const PLUGIN_KINDS = [
  'widget',
  'page',
  'island',
  'overlay',
  'theme',
  'composer',
  'layout',
  'behavior',
  'provider',
  'dictation',
  'bundle',
] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/**
 * The slot a kind must declare to be admitted. Written here rather than in the
 * client so that a manifest whose `kind` and `client.slots` disagree is refused
 * at the door, with a message naming both — not silently loaded and then
 * rejected in the browser where nobody reads the console.
 *
 * `widget` maps to no single name: any `*.widget` zone counts, which is exactly
 * what makes a widget movable (see `slot-compat.ts`). Hence the `null` and the
 * suffix test below.
 */
const KIND_SLOT: Readonly<Record<PluginKind, string | null>> = Object.freeze({
  widget: null,
  page: 'page',
  island: 'island.content',
  overlay: 'overlay',
  theme: 'theme',
  composer: 'chat.composer',
  layout: 'root',
  behavior: null,
  provider: null,
  dictation: 'dictation.engine',
  bundle: null,
});

/**
 * A string kind is sugar for a one-element list. Storing the normalised list
 * means every reader — gallery, loader, tests — sees one shape.
 */
const KindSchema = z
  .union([z.enum(PLUGIN_KINDS), z.array(z.enum(PLUGIN_KINDS)).min(1)])
  .transform((k) => (Array.isArray(k) ? [...new Set(k)] : [k]));

/** Route of a `page` plugin. Absolute, lowercase, no query and no traversal. */
const RouteSchema = z
  .string()
  .regex(/^\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/, 'invalid route (expected: `/acme`)');

/**
 * Cover art shipped INSIDE the package, resolved against its `package.json`.
 * Never a URL: the gallery must render offline, and a remote cover would let a
 * manifest phone home the moment a list is displayed.
 */
const CoverSchema = z
  .string()
  .regex(
    /^(?!\/)(?!.*\.\.)[\w./-]+\.(png|webp|jpg|jpeg|svg)$/,
    'invalid cover (expected: a file of the package, e.g. `cover.png`)',
  );

/**
 * Gallery picto: an SVG of the package, same containment rules as `cover`.
 * SVG only, because it is painted as a MASK in the theme's text colour — only
 * its shape counts, so it follows light/dark and the accent on its own.
 */
const IconSchema = z
  .string()
  .regex(
    /^(?!\/)(?!.*\.\.)[\w./-]+\.svg$/,
    'invalid icon (expected: an SVG of the package, e.g. `icon.svg`)',
  );

const PluginSettingSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'secret']),
  label: z.string().min(1),
  /** Value offered in `/settings` as long as the user has typed nothing. */
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type PluginSetting = z.infer<typeof PluginSettingSchema>;

/**
 * An incoming webhook the plugin receives (`ctx.webhooks.on`). `auth` names
 * the signature format the HOST verifies before the handler runs: one of the
 * formats shipped in `webhook-formats.ts` (`standard` by default, `github`,
 * `stripe`…). A plugin never brings its own verification code.
 */
const PluginWebhookSchema = z.object({
  name: z.string().regex(PLUGIN_HOOK_NAME_RE, 'invalid webhook name (expected a slug: `issues`, `github-events`)'),
  auth: z.enum(WEBHOOK_FORMAT_IDS, {
    error: `unknown webhook \`auth\` (expected one of: ${WEBHOOK_FORMAT_IDS.join(', ')})`,
  }).default('standard'),
});
export type PluginWebhookDecl = z.infer<typeof PluginWebhookSchema>;

/** A bare executable name: no separator, no drive, no leading dash. */
const BINARY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/**
 * What a `provider` plugin asks of the machine. Names only, never a path: the
 * daemon resolves them on the host's own search path and shows the operator the
 * RESOLVED path to accept (`plugins/exec-grants.ts`). The first name is the
 * binary the provider launches; the others are aliases the same program goes
 * by (`cursor-agent` / `agent`). `identity` mirrors `declares.binary.identity`
 * here because the plugin's code is not loaded yet when the operator clicks: it
 * is what the daemon holds the accepted program to before writing the allowlist.
 */
const PluginProviderSchema = z.object({
  binaries: z.array(z.object({
    name: z.string().regex(BINARY_NAME_RE, 'invalid binary name (expected a bare executable name: `cursor-agent`)'),
    aliases: z.array(z.string().regex(BINARY_NAME_RE, 'invalid binary alias')).max(4).default([]),
    identity: z.object({
      pattern: z.string(),
      args: z.array(z.string()).optional(),
      expected: z.string().optional(),
    }).superRefine((identity, ctx) => {
      const why = binaryIdentityProblem(identity, 'provider.binaries[].identity');
      if (why) ctx.addIssue({ code: 'custom', message: why });
    }).optional(),
  })).max(4).default([]),
  /**
   * Entries of the OS credential store the provider reads (`ctx.provider.osCredentials`,
   * macOS login keychain): where its CLI keeps the sign-in a file cannot show. Declared
   * so the install screen can SAY it; nothing else is readable.
   */
  osCredentials: z.array(z.object({
    service: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/, 'invalid credential service'),
    account: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/, 'invalid credential account').optional(),
  })).max(4).default([]),
  /**
   * Folders of the home the provider's CLI keeps its sign-in in (`declares.credentialDirs`,
   * what `ctx.provider.scratch.link` reads from). The operator sees them on the install
   * screen, and the provider can declare no others. Never the user's own key stores.
   */
  credentialDirs: z.array(z.string().superRefine((dir, ctx) => {
    // The manifest does not know which backend ids the plugin will register, so "the folder of ANOTHER
    // backend" cannot be judged here: it is judged where the folder is claimed — `registerProvider` (the
    // dialect's id) and `registerProfile` (the profile's id) — with the ids that claimant answers for.
    // Everything else (shape, the user's own key stores, a bare container) is refused at install.
    const why = credentialDirProblem(dir, Object.keys(BACKEND_HOME_DIRS));
    if (why) ctx.addIssue({ code: 'custom', message: why });
  })).max(4).default([]),
  /**
   * The backend ids a provider SHIPPED IN THE RELEASE brings, and what the product reads of each
   * before the plugin runs: the binary to look for, its sign-in folders, the first-run card, the
   * sign-in hint, the logo fragments, its place in the product's order
   * (`backends/builtin-declarations.ts`). Checked here for every manifest; read only from a
   * built-in plugin the release vouches for — a third party's is ignored, since a field of it can
   * run an installer or reserve an id.
   */
  backends: z.array(z.unknown()).max(8).optional(),
}).superRefine((provider, ctx) => {
  for (const message of providerBackendsProblems(provider)) ctx.addIssue({ code: 'custom', message, path: ['backends'] });
});
export type PluginProviderDecl = z.infer<typeof PluginProviderSchema>;

/** Slug of a dictation engine, unique within the plugin. */
const DICTATION_ENGINE_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

/**
 * A host a plugin reaches (a dictation engine's `egress`, an entry of `http.hosts`),
 * in the form `pluginPolicy.http.allow` takes: a bare lowercase hostname, or
 * `*.example.com` for its subdomains. Never a URL, a port or a path: the
 * operator reads it as a destination.
 */
const POLICY_HOST_RE = /^(\*\.)?(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const DictationEngineDeclSchema = z.object({
  id: z.string().regex(DICTATION_ENGINE_ID_RE, 'invalid engine id (expected a slug: `acme-whisper`)'),
  /**
   * `page`: the engine runs in the plugin's browser half. `daemon`: the browser
   * half sends blocks of audio to the plugin's host half through `ctx.api`.
   * The desktop's native engine is the built-in occupant's alone.
   */
  runtime: z.enum(['page', 'daemon']),
  /**
   * Where the voice goes: `none` (stays in the window), `daemon` (the daemon of
   * the active machine), or the hosts it is sent to. Shown at install.
   */
  egress: z.union([
    z.enum(['none', 'daemon']),
    z.array(z.string().regex(POLICY_HOST_RE, 'invalid egress host (expected a hostname: `api.acme.com`)'))
      .min(1).max(8)
      .refine((hosts) => new Set(hosts).size === hosts.length, 'duplicate egress host'),
  ]),
});
export type PluginDictationEngineDecl = z.infer<typeof DictationEngineDeclSchema>;

/**
 * What a `dictation` plugin says of itself (API 14). `models` is a pack of
 * models for the built-in native engine: a JSON file INSIDE the package, same
 * containment as `cover` (no absolute path, no `..`); the install preview also
 * refuses one that a link takes out of the package.
 */
const PluginDictationSchema = z.object({
  engines: z.array(DictationEngineDeclSchema).max(8).default([])
    .refine((list) => new Set(list.map((e) => e.id)).size === list.length, 'duplicate engine id'),
  models: z.string()
    .regex(/^(?!\/)(?!.*\.\.)[\w./-]+\.json$/, 'invalid `models` (expected a JSON file of the package: `dictation-models.json`)')
    .optional(),
});
export type PluginDictationDecl = z.infer<typeof PluginDictationSchema>;

/** A part's slug, prefixed by the plugin id to make the id an agent's look stores (`acme-pack:cap`). */
const MascotPartSlugSchema = z.string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'invalid mascot part (expected 1 to 40 characters among a-z, 0-9 and `-`, not starting with `-`)');
const MascotPartListSchema = z.array(MascotPartSlugSchema).max(32)
  .refine((list) => new Set(list).size === list.length, 'duplicate mascot part');

/**
 * The parts a mascot pack adds (API 15), by look field: the daemon accepts
 * `<pluginId>:<part>` in an agent's `look` while the plugin is installed and
 * enabled. Ids only: the drawing is the browser half's (`mascot.parts`).
 */
const PluginMascotSchema = z.object({
  shape: MascotPartListSchema.optional(),
  color: MascotPartListSchema.optional(),
  eyes: MascotPartListSchema.optional(),
  acc: MascotPartListSchema.optional(),
}).refine((block) => Object.values(block).some((list) => list && list.length > 0), 'a `mascot` block declares at least one part');
export type PluginMascotDecl = z.infer<typeof PluginMascotSchema>;

/**
 * Why the plugin asks, shown as written on the install sheet and by
 * `timon plugin add`. One line: a line break or a control character would let
 * the plugin draw lines of its own on a sheet the operator trusts.
 */
const DeclReasonSchema = z.string().min(1).max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'invalid `why` (expected one line of text, no control character)');

/**
 * A vault entry the plugin will ask for, by name (TODO #599). `read`:
 * `ctx.secrets.get` (permission `secrets:read`); `broker`: `ctx.secrets.httpCall`
 * or a git credential, the value never reaching the plugin (`secrets:broker`).
 * A declaration, not a grant: the operator still grants it, and an entry
 * missing from the vault stays to be created.
 */
const PluginSecretDeclSchema = z.object({
  name: z.string().regex(SECRET_NAME_RE, 'invalid secret name (expected an environment variable name: `ACME_TOKEN`)'),
  mode: z.enum(['read', 'broker']),
  why: DeclReasonSchema.optional(),
});
export type PluginSecretDecl = z.infer<typeof PluginSecretDeclSchema>;

/** A host the plugin's `ctx.fetch` (permission `http:outbound`) will reach (TODO #599). */
const PluginHttpHostDeclSchema = z.object({
  host: z.string().regex(POLICY_HOST_RE, 'invalid host (expected a hostname: `api.acme.com` or `*.acme.com`)'),
  why: DeclReasonSchema.optional(),
});
export type PluginHttpHostDecl = z.infer<typeof PluginHttpHostDeclSchema>;

const PluginHttpDeclSchema = z.object({
  hosts: z.array(PluginHttpHostDeclSchema).min(1).max(20)
    .refine((list) => new Set(list.map((h) => h.host)).size === list.length, 'duplicate host'),
});
export type PluginHttpDecl = z.infer<typeof PluginHttpDeclSchema>;

const PluginClientSchema = z.object({
  /**
   * Slots the browser half has the right to fill. The admission is
   * done on the client side (`app/src/lib/plugin-host/slot-compat.ts`) and compares
   * the natures: declaring a `*.widget` slot opens every host zone with
   * widgets, any other name stays an exact match.
   */
  slots: z.array(SlotNameSchema).default([]),
  /** Modules outside the `PLATFORM_MODULES` baseline (§10.8) — normally empty. */
  external: z.array(z.string()).default([]),
  /** `iframe` embeds a third-party page behind a `sandbox`: never the default. */
  mode: z.enum(['esm', 'iframe']).default('esm'),
});

/**
 * The `timon` field of a plugin's `package.json`.
 *
 * `z.object` and not `z.strictObject`: an unknown key is ignored rather than
 * fatal. A manifest written for a future version of the contract must be
 * refused by its `apiVersion` — a message that names the real cause — and not
 * by an extra key, which would send the third party looking in the wrong place.
 */
export const PluginManifestSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]{3,40}$/, 'invalid id (expected: 3 to 40 characters among a-z, 0-9 and `-`)')
    // `/api/plugins/hooks/…` is the public webhook path: a plugin router
    // mounted there would receive unauthenticated calls.
    .refine((id) => id !== RESERVED_PLUGIN_ID, `id \`${RESERVED_PLUGIN_ID}\` is reserved`),
  /** MINIMAL contract targeted. Validated for its shape here, compared to the daemon below. */
  apiVersion: z.number().int().positive(),
  /**
   * Nature(s) of the plugin. Absent, it is inferred from `client.slots`: the
   * manifests written before Phase U stay valid without being rewritten:
   * an added field does not change the contract they declare.
   */
  kind: KindSchema.optional(),
  /** Title shown by the gallery. Default: the `id`. */
  label: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  /** Publisher shown on the detail sheet. Absent → the gallery shows the package name. */
  author: z.string().min(1).optional(),
  cover: CoverSchema.optional(),
  /** Monochrome SVG picto (24×24 grid advised) drawn on the gallery card. */
  icon: IconSchema.optional(),
  /**
   * Extra stills for the gallery carousel, same rules as `cover` (files of
   * the package, never a URL). Empty by default. The sheet shows `cover`
   * first, then these, de-duplicated.
   */
  screenshots: z.array(CoverSchema).default([]),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).default([]),
  client: PluginClientSchema.optional(),
  /**
   * Sockets this plugin OPENS to the others — a page that sets a widget
   * zone, a layout that sets its own slots. Declaring means claiming
   * the name: two plugins cannot open the same one.
   */
  declares: z.record(SlotNameSchema, z.enum(['single', 'list', 'keyed'])).default({}),
  /** Route mounted if `kind` contains `page`. */
  route: RouteSchema.optional(),
  /** What it changes without occupying it (`theme`…) — informative for the gallery. */
  modifies: z.array(z.string().min(1)).default([]),
  /** Ids installed by a bundle. Empty everywhere else. */
  contains: z.array(z.string().regex(/^[a-z0-9-]{3,40}$/, 'invalid `contains` id')).default([]),
  settings: z.array(PluginSettingSchema).default([]),
  /** Incoming webhooks, permission `webhooks:receive`. Optional, not
   *  defaulted: manifests built in code before it existed stay valid. */
  webhooks: z.array(PluginWebhookSchema).max(20)
    .refine((list) => new Set(list.map((w) => w.name)).size === list.length, 'duplicate webhook name')
    .optional(),
  // Entries are validated independently with the local profile schema at mount.
  backends: z.array(z.unknown()).max(100).optional(),
  /** Read for `kind: provider` only; see `PluginProviderSchema`. */
  provider: PluginProviderSchema.optional(),
  /** Read for `kind: dictation` only; see `PluginDictationSchema`. */
  dictation: PluginDictationSchema.optional(),
  /** The parts of a mascot pack (API 15); see `PluginMascotSchema`. */
  mascot: PluginMascotSchema.optional(),
  /**
   * The vault entries and the hosts the plugin will ask for, by name, so the
   * install sheet can show them (TODO #599). Optional and not defaulted: a
   * manifest written before them stays valid and means the same thing, and a
   * daemon that predates them ignores them. Each needs its permission
   * (`secretsHttpMismatch`).
   */
  secrets: z.array(PluginSecretDeclSchema).max(20)
    .refine((list) => new Set(list.map((s) => s.name)).size === list.length, 'duplicate secret name')
    .optional(),
  http: PluginHttpDeclSchema.optional(),
  /**
   * API 15 — folder of the package holding the migrations of the plugin's own
   * database (`NNN-name.sql`, numbered from 1). Requires `storage:sql`.
   */
  migrations: z.string().min(1).max(200).optional(),
  /**
   * API 15 — routes reachable without a session, under the plugin's own prefix
   * (`/api/plugins/<id>/…`), behind the core's rate limit, body ceiling and
   * cross-site refusal. Requires `http:public`.
   */
  routes: z.object({
    publicPaths: z.array(z.object({
      method: z.enum(['GET', 'POST']),
      path: z.string().regex(PLUGIN_PUBLIC_PATH_RE, 'a path under the plugin prefix: `/segment` or `/:param`, no wildcard'),
    })).max(10).default([]),
  }).optional(),
  license: z.object({ required: z.boolean().default(false) }).prefault({}),
});
/**
 * `kind` is always a list here, never `undefined`: `readManifest` infers it
 * when the manifest does not carry it, so that no downstream reader
 * has to redo that inference (and redo it differently).
 */
export type PluginManifest = Omit<z.infer<typeof PluginManifestSchema>, 'kind'> & { kind: PluginKind[] };

/** True for a widget host zone: `cockpit.widget`, `sidebar.left.widget`, … */
function isWidgetSlot(slot: string): boolean {
  return slot.slice(slot.lastIndexOf('.') + 1) === 'widget';
}

/**
 * Nature inferred from the slots, for a manifest older than Phase U. A
 * plugin that occupies nothing is a `behavior`: that is the case of a plugin that
 * only has a host half (job, listener), not an error.
 */
export function inferKinds(slots: readonly string[]): PluginKind[] {
  const kinds = new Set<PluginKind>();
  for (const slot of slots) {
    if (isWidgetSlot(slot)) kinds.add('widget');
    for (const kind of PLUGIN_KINDS) {
      if (KIND_SLOT[kind] === slot) kinds.add(kind);
    }
  }
  return kinds.size ? [...kinds] : ['behavior'];
}

/**
 * Consistency between what the plugin says it is and what it occupies. These rules cannot
 * live in the zod schema: they cross `kind`, `client.slots`,
 * `route` and `contains`, and the message must name both fields in
 * disagreement to be actionable.
 */
function kindMismatch(manifest: PluginManifest): string | null {
  const kinds = manifest.kind;
  const slots = manifest.client?.slots ?? [];

  if (kinds.includes('bundle')) {
    if (kinds.length > 1) {
      return `\`kind\` mixes \`bundle\` with ${kinds.filter((k) => k !== 'bundle').join(', ')} — a bundle occupies nothing, it installs \`contains\`.`;
    }
    if (!manifest.contains.length) return "`kind: bundle` without `contains` — a bundle that installs nothing is not a plugin.";
    if (slots.length) return `\`kind: bundle\` but \`client.slots\` names ${slots.join(', ')} — a bundle has no browser half.`;
  } else if (manifest.contains.length) {
    return '`contains` is only read for `kind: bundle` — use a bundle, or remove `contains`.';
  }

  if (kinds.includes('provider')) {
    if (!manifest.permissions.includes('backends:register')) {
      return '`kind: provider` needs the permission `backends:register` — a provider that cannot register a backend is not one.';
    }
  } else if (manifest.provider) {
    return '`provider` is read only for `kind: provider`.';
  }

  const dictation = dictationMismatch(manifest);
  if (dictation) return dictation;

  const mascot = mascotMismatch(manifest);
  if (mascot) return mascot;

  // The reverse of `KIND_SLOT.layout`: `root` is the whole interface, and only
  // a layout may ask for it. Without this rule a `behavior` or a `page` naming
  // `root` would replace the shell for everyone, with no choice in the
  // appearance settings and around the licence right a layout needs.
  if (slots.includes('root') && !kinds.includes('layout')) {
    return '`client.slots` names `root` but `kind` is not `layout` — only a layout replaces the whole interface.';
  }

  if (kinds.includes('page')) {
    if (!manifest.route) return '`kind: page` without `route` — a page is mounted by its route.';
  } else if (manifest.route) {
    return '`route` is only read for `kind: page`.';
  }

  for (const kind of kinds) {
    if (kind === 'widget') {
      if (!slots.some(isWidgetSlot)) {
        return "`kind: widget` but `client.slots` names no `*.widget` zone.";
      }
      continue;
    }
    const required = KIND_SLOT[kind];
    if (required && !slots.includes(required)) {
      return `\`kind: ${kind}\` but \`client.slots\` does not name \`${required}\` — this slot admits exact names only, a \`*.widget\` zone does not stand in for it.`;
    }
  }

  return null;
}

/**
 * A dictation engine hears the user's voice: what it is, where the voice goes
 * and who may hear it are settled at the door, before the install sheet shows
 * anything. The slot is checked in BOTH directions: `kind: widget` naming
 * `dictation.engine` would otherwise reach the engine registry without the
 * block that tells the operator where the voice goes.
 */
function dictationMismatch(manifest: PluginManifest): string | null {
  const slots = manifest.client?.slots ?? [];
  if (!manifest.kind.includes('dictation')) {
    if (manifest.dictation) return '`dictation` is read only for `kind: dictation`.';
    if (slots.includes('dictation.engine')) return '`client.slots` names `dictation.engine` but `kind` is not `dictation`.';
    return null;
  }
  if (manifest.apiVersion < DICTATION_API_VERSION) {
    return `\`kind: dictation\` needs \`apiVersion: ${DICTATION_API_VERSION}\` or later.`;
  }
  if (!manifest.permissions.includes('dictation:engine')) {
    return '`kind: dictation` needs the permission `dictation:engine` — an engine hears the user\'s voice, the operator must see it asked.';
  }
  const block = manifest.dictation;
  if (!block || (!block.engines.length && !block.models)) {
    return '`kind: dictation` needs a `dictation` block with at least one engine or a `models` pack — it says where the voice goes.';
  }
  for (const engine of block.engines) {
    if (Array.isArray(engine.egress) && !manifest.permissions.includes('http:outbound')) {
      return `engine \`${engine.id}\` sends the voice to ${engine.egress.join(', ')} but the plugin does not declare \`http:outbound\`.`;
    }
    if (engine.runtime === 'daemon' && engine.egress === 'none') {
      return `engine \`${engine.id}\` runs in the daemon, so the voice leaves the window: \`egress: none\` cannot be true.`;
    }
  }
  return null;
}

/**
 * A mascot pack's ids and their drawing travel apart — the manifest says
 * which parts exist, the browser half draws them in `mascot.parts` — so both
 * must be there: ids without a drawing would be stored and drawn as the
 * default, a drawing without ids would be offered then refused at save.
 */
function mascotMismatch(manifest: PluginManifest): string | null {
  const slots = manifest.client?.slots ?? [];
  if (!manifest.mascot) {
    return slots.includes(MASCOT_PARTS_SLOT) ? `\`client.slots\` names \`${MASCOT_PARTS_SLOT}\` but the manifest has no \`mascot\` block declaring the parts.` : null;
  }
  if (manifest.apiVersion < MASCOT_PACK_API_VERSION) {
    return `\`mascot\` needs \`apiVersion: ${MASCOT_PACK_API_VERSION}\` or later.`;
  }
  if (!slots.includes(MASCOT_PARTS_SLOT)) {
    return `\`mascot\` declares parts but \`client.slots\` does not name \`${MASCOT_PARTS_SLOT}\`, where the browser half draws them.`;
  }
  return null;
}

/**
 * A declared secret or host is something the plugin will do, so the
 * permission that lets it do so must be asked too: otherwise the sheet would
 * show a name the plugin can never use, and the operator would grant it for
 * nothing. The reverse is not required: a permission without a declaration is
 * how every manifest written before TODO #599 reads.
 */
function secretsHttpMismatch(manifest: PluginManifest): string | null {
  for (const secret of manifest.secrets ?? []) {
    const needed = secret.mode === 'read' ? 'secrets:read' : 'secrets:broker';
    if (!manifest.permissions.includes(needed)) {
      return `secret \`${secret.name}\` is declared with \`mode: ${secret.mode}\` but the plugin does not declare \`${needed}\`.`;
    }
  }
  const hosts = manifest.http?.hosts ?? [];
  if (hosts.length && !manifest.permissions.includes('http:outbound')) {
    return `\`http.hosts\` names ${hosts.map((h) => h.host).join(', ')} but the plugin does not declare \`http:outbound\`.`;
  }
  return null;
}

/**
 * A `daemon` engine is served by the plugin's host half (`ctx.api` routes): a
 * package without one would be admitted, then fail at the first dictation.
 * Judged by the loader, which alone knows whether a host half exists.
 */
export function dictationHostProblem(manifest: Pick<PluginManifest, 'dictation'>, hasHostHalf: boolean): string | null {
  if (hasHostHalf) return null;
  const engine = manifest.dictation?.engines.find((e) => e.runtime === 'daemon');
  return engine
    ? `engine \`${engine.id}\` runs in the daemon but the plugin has no host half (\`main\` or \`index.js\`) to serve its \`ctx.api\` routes.`
    : null;
}

/**
 * Where each engine of a dictation plugin sends the voice, one English line
 * per engine, for the install sheets (`timon plugin add`, the gallery's
 * preview). Empty for any other plugin.
 */
export function dictationEgressLines(manifest: Pick<PluginManifest, 'kind' | 'dictation'>): string[] {
  if (!manifest.kind.includes('dictation') || !manifest.dictation) return [];
  const lines = manifest.dictation.engines.map((engine) => {
    const where = engine.egress === 'none' ? 'stays in this window'
      : engine.egress === 'daemon' ? 'is sent to the daemon of the active machine'
      : `is sent to ${engine.egress.join(', ')}`;
    return `${engine.id}: your voice ${where}`;
  });
  if (manifest.dictation.models) lines.push('models: brings models for the built-in engine; your voice stays on this machine');
  return lines;
}

/**
 * Refusal codes. They are taken as they are by the loader to compose
 * `skipped:<code>` (§10.5), so renaming them changes a value exposed by
 * `/api/capabilities` — it is a contract, not an internal label.
 */
export type ManifestErrorCode = 'manifest' | 'api-version' | 'forbidden-inject';

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; code: ManifestErrorCode; message: string };

function fail(code: ManifestErrorCode, message: string): ManifestResult {
  return { ok: false, code, message };
}

/** The raw manifest field of a `package.json`, without validation. */
export function manifestField(packageJson: unknown): unknown {
  if (typeof packageJson !== 'object' || packageJson === null || Array.isArray(packageJson)) return undefined;
  return (packageJson as Record<string, unknown>)[BRAND.manifestKey];
}

/**
 * Validates the `timon` field of a plugin's `package.json`.
 *
 * `inject` is passed separately because it does not live in the manifest: it is the
 * host half (`lib/index.js`) that exports it, Cordis-style. The loader will
 * read it when importing the module; it is checked here so that the rule and
 * its message hold in a single place.
 */
export function readManifest(
  packageJson: unknown,
  opts: { inject?: readonly string[] } = {},
): ManifestResult {
  const field = manifestField(packageJson);
  if (field === undefined) {
    return fail('manifest', `no \`${BRAND.manifestKey}\` field in package.json — this package is not a ${BRAND.displayName} plugin`);
  }

  const parsed = PluginManifestSchema.safeParse(field);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join('.') : '<root>'}: ${i.message}`)
      .join('; ');
    return fail('manifest', `invalid \`${BRAND.manifestKey}\` field — ${details}`);
  }
  const manifest: PluginManifest = {
    ...parsed.data,
    kind: parsed.data.kind ?? inferKinds(parsed.data.client?.slots ?? []),
  };

  // Additive: only a contract MORE RECENT than the daemon's is refused.
  if (manifest.apiVersion > PLUGIN_API_VERSION) {
    return fail(
      'api-version',
      `plugin \`${manifest.id}\`: apiVersion ${manifest.apiVersion} is too recent — this daemon implements contract ${PLUGIN_API_VERSION}. ` +
        `Install a version of ${BRAND.displayName} that implements contract ${manifest.apiVersion}.`,
    );
  }

  if (manifest.backends && typeof packageJson === 'object' && packageJson !== null
    && 'main' in packageJson) {
    return fail('manifest', 'a declarative provider pack must not declare `main`');
  }
  if (manifest.backends && !manifest.permissions.includes('backends:register')) {
    return fail('manifest', '`backends` requires permission `backends:register`');
  }
  if (manifest.routes?.publicPaths.length && !manifest.permissions.includes('http:public')) {
    return fail('manifest', '`routes.publicPaths` requires permission `http:public`');
  }
  if (manifest.migrations && !manifest.permissions.includes('storage:sql')) {
    return fail('manifest', '`migrations` requires permission `storage:sql`');
  }
  if (manifest.webhooks?.length && !manifest.permissions.includes('webhooks:receive')) {
    return fail('manifest', '`webhooks` requires permission `webhooks:receive`');
  }
  // A format other than `standard` is contract 8: a daemon that predates it
  // refuses the manifest on its apiVersion, with a message naming the cause.
  const formatted = manifest.webhooks?.find((w) => w.auth !== 'standard');
  if (formatted && manifest.apiVersion < WEBHOOK_FORMATS_API_VERSION) {
    return fail('manifest', `webhook \`${formatted.name}\`: \`auth: ${formatted.auth}\` needs \`apiVersion: ${WEBHOOK_FORMATS_API_VERSION}\` or later`);
  }

  const mismatch = kindMismatch(manifest);
  if (mismatch) return fail('manifest', `plugin \`${manifest.id}\`: ${mismatch}`);
  const declared = secretsHttpMismatch(manifest);
  if (declared) return fail('manifest', `plugin \`${manifest.id}\`: ${declared}`);

  const forbidden = forbiddenInject(manifest.id, opts.inject ?? []);
  if (forbidden) return fail(forbidden.code, forbidden.message);

  return { ok: true, manifest };
}

/**
 * Check of a host half's `inject` (§10.2), isolated from the rest because it
 * happens later than the manifest: `inject` lives in `lib/index.js`, so
 * the loader only knows it AFTER importing the module — but always
 * BEFORE calling its `apply`. A single writing of the rule, two moments.
 *
 * Returns `null` when everything named is allowed.
 */
export function forbiddenInject(
  id: string,
  inject: readonly string[],
): { code: 'forbidden-inject'; message: string } | null {
  const forbidden = inject.filter((s) => !ALLOWED_INJECT.includes(s));
  if (!forbidden.length) return null;
  return {
    code: 'forbidden-inject',
    message:
      `plugin \`${id}\`: \`inject\` names a forbidden capability (${forbidden.join(', ')}) — ` +
      `a third-party plugin may only inject ${ALLOWED_INJECT.join(', ')}.`,
  };
}
