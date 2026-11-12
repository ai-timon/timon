/**
 * Third-party plugin loader (§10.5 of the plan), above the Cordis loader.
 *
 * It does three things, and nothing else:
 *
 *  1. **Discover** what is installed in `~/.timon/plugins/` (a regular npm
 *     tree written by `timon plugin add`) and reject anything that fails the
 *     manifest before execution (P.1).
 *  2. **Mount** what remains, each in its own Cordis fiber, exposing only the
 *     P.2 `PluginContext`.
 *  3. **Recompose live**: `update()` reconciles the mounted tree with disk
 *     state. No daemon restart is required — this is the step's exit criterion.
 *
 * ## Two deviations from the plan, both forced by the real API
 *
 * **(a) Third-party plugins do not go through `ctx.loader.create()`.**
 * The Cordis loader imports a module and applies it with its entry `Context`,
 * so the plugin would receive a real Cordis context with `ctx.emit`, `ctx.provide`,
 * and service resolution. P.2 explicitly closed this path (an emitting plugin
 * could fabricate a fake `timon/task_done` under the dispatcher's nose). There
 * is no extension point to change the arguments passed to `apply`. We mount
 * fibers ourselves — above the loader, as §10.5 says — while retaining its
 * semantics: one entry per plugin, disabled entries remain known, and toggles
 * are live.
 *
 * **(b) `loader.update(entries)` does not exist.** The real signature is
 * `update(id, options)`, one entry at a time. Our argument-less `update()`
 * reconciles the whole tree, as described functionally by the plan.
 *
 * ## What this step does not do
 *
 * Points 3 and 4 of §10.5 (Ed25519 signature, licensing) belong to P.5 and P.6.
 * Hooks are in place (`verify`, `licensed`); their absence currently allows
 * plugins through — a daemon rejecting everything because a verifier is not
 * written yet would be a regression, not security.
 */
import { existsSync, readFileSync, realpathSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Context, Fiber } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { CONFIG_FILE } from '../config/load.js';
import { ModuleSettingSchema, type ModuleSetting } from '../config/schema.js';
import { PLUGINS_DIR } from '../paths.js';
import { fixedComposition, withCompositionWrite } from '../license/capabilities.js';
import { licenseState } from '../license/runtime.js';
import { BundleRegistry } from './bundles.js';
import { CoverRegistry } from './covers.js';
import { dictationHostProblem, forbiddenInject, readManifest, type ManifestErrorCode, type PluginManifest } from './manifest.js';
import { createPluginContext, isolateForPlugin, type PluginContext, type PluginHost } from './context.js';
import { registerPluginPublicPaths } from './public-paths.js';
import { migratePluginDb, openPluginDb, pluginDbFile, pluginSqlFacade, readMigrations, resolveMigrationsDir } from './plugin-db.js';
import { webhookPublisherOf, type PluginWebhookPublisher } from './webhooks.js';
import { setPluginSpawnStanding } from './policy.js';
import { currentNodeRuntime, nodeEngineProblem, nodeEngineRange, type NodeRuntimeFacts } from './node-engine.js';
import { PLUGIN_PUBLIC_KEYS, type PluginPublicKey } from './pubkey.js';
import { verifyPluginDirectory } from './signature.js';
import type { BuiltinTrust, ResolvedBuiltin } from './builtin.js';
import { mountProviderPack, type PackProfileStatus } from './provider-pack.js';
import { entryUrl, evictRequireCache, treeStamp } from './hot-reload.js';
import { setPluginSource } from '../kernel/rejection-guard.js';
import { baseBackendId } from '../backends/instance-id.js';
import { beginProviderSwap, HotUpdateRefusedError, inactiveProfiles, installedProfiles, registeredBackendOwners } from '../backends/registry.js';

/**
 * Rejection codes, used as-is in `skipped:<code>` (§10.5). The first three come
 * from the manifest; `import` covers an unreadable host module or one that
 * throws while loading; `duplicate-id` is not in the plan but is necessary:
 * `plugin_kv`, `plugins-data/`, and the route prefix are all indexed by
 * `id`, so two packages claiming the same id would silently trample each other;
 * the second is rejected, never merged. `node-engine`: the package's
 * `engines.node` excludes the Node the daemon runs on (TODO #763).
 */
export type PluginSkipCode = ManifestErrorCode | 'import' | 'duplicate-id' | 'unsigned' | 'tampered' | 'unlicensed' | 'node-engine';

export type PluginState = 'active' | 'failed' | 'disabled' | 'skipped';

/** What the loader knows about an installed package at a given point in time. */
export type PluginStatus = {
  /** Manifest id; the npm package name if the manifest cannot be read. */
  id: string;
  /** Npm package name, the only stable key for `timon plugin remove`. */
  pkg: string;
  dir: string;
  version: string;
  state: PluginState;
  /** `skipped:<code>` or the disable reason. `null` while running. */
  reason: string | null;
  /** Detailed message for humans (log, `/api/capabilities`). */
  error: string | null;
  manifest: PluginManifest | null;
  /** Whether the plugin declares a browser half (`timon.client`), served only when `active`. */
  client: boolean;
  backends?: PackProfileStatus[];
  /**
   * Ed25519 admission passed. False when unsigned, tampered, or the manifest
   * could not be read. The gallery's "Verified" provenance uses this — a
   * plugin allowed through `unsignedPlugins` still reports false.
   */
  signed: boolean;
  /**
   * What the admitted signature vouches for: the digest of the package's
   * files (`hashPluginDirectory`) and the key that signed it. `null` when
   * `signed` is false. Another daemon compares it with its own copy of the
   * plugin before running this one's browser half (multi-machine P4c).
   */
  signature: { hash: string; keyId: string } | null;
  /**
   * Shipped with the product (`builtin.ts`) rather than installed under
   * `~/.timon/plugins/`: disable-only, never removable. Absent for an
   * installed package.
   */
  builtin?: true;
};

/** What a third-party plugin exports from its host half (§10.3). */
type PluginModule = {
  name?: string;
  inject?: readonly string[];
  apply?: (ctx: PluginContext, config: Record<string, unknown>) => void | Promise<void>;
};

type Discovered = ({
  pkg: string;
  dir: string;
  version: string;
  /** Host half to import; `null` for a plugin that only has a browser half. */
  entry: string | null;
  manifest: PluginManifest;
  /** `engines.node` of its `package.json`, read by `engineRefusal`. */
  engineRange: string | null;
} | {
  pkg: string;
  dir: string;
  version: string;
  refusal: { code: PluginSkipCode; message: string };
}) & {
  /** Set for a built-in plugin: whether its location may be trusted. */
  builtin?: BuiltinTrust;
  /** Built-in shipped switched off: no `plugins[<id>]` entry means disabled. */
  offByDefault?: true;
};

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

/** Dependencies declared by `~/.timon/plugins/package.json`. A missing
 *  directory is not an error: it means no plugins are installed. */
export function installedPackages(root: string = PLUGINS_DIR): string[] {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return [];
  try {
    const pkg = readJson(file) as { dependencies?: Record<string, string> };
    return Object.keys(pkg.dependencies ?? {}).sort();
  } catch (err) {
    console.warn(`[plugins] cannot read ${file}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Reads installed packages and validates their manifests without importing a
 * line of their code. This is P.1's requirement: a manifest must never be
 * validated by the code it governs.
 *
 * `inject` is NOT checked here: it lives in the host half, so that half must be
 * imported. The check happens at mount time, before `apply` (never after).
 *
 * Built-in plugins are read FIRST, so their ids win: a user who also
 * installed one under `~/.timon/plugins/` sees that copy refused as a
 * duplicate, with the way to remove it.
 */
export function discoverPlugins(root: string = PLUGINS_DIR, builtins: readonly ResolvedBuiltin[] = []): Discovered[] {
  const out: Discovered[] = [];
  const seen = new Map<string, { pkg: string; builtin: boolean }>();
  const sources = [
    ...builtins.map((b) => ({ pkg: b.pkg, dir: b.dir, builtin: b.trust, offByDefault: b.enabledByDefault === false })),
    ...installedPackages(root).map((pkg) => ({ pkg, dir: join(root, 'node_modules', pkg), builtin: undefined, offByDefault: false })),
  ];
  for (const { pkg, dir, builtin, offByDefault } of sources) {
    const file = join(dir, 'package.json');
    let json: { version?: string; main?: string } = {};
    if (!existsSync(file)) {
      const message = builtin
        ? `built-in plugin \`${pkg}\` is missing from this installation (${dir}) — reinstall Timon`
        : `package \`${pkg}\` is declared but missing from node_modules — run \`timon plugin add ${pkg}\` again`;
      out.push({ pkg, dir, version: '0.0.0', refusal: { code: 'manifest', message }, builtin });
      continue;
    }
    try {
      json = readJson(file) as typeof json;
    } catch (err) {
      out.push({ pkg, dir, version: '0.0.0', refusal: { code: 'manifest', message: `cannot read package.json: ${(err as Error).message}` }, builtin });
      continue;
    }
    const version = json.version ?? '0.0.0';
    const res = readManifest(json);
    if (!res.ok) {
      out.push({ pkg, dir, version, refusal: { code: res.code, message: res.message }, builtin });
      continue;
    }
    const previous = seen.get(res.manifest.id);
    if (previous) {
      const message = previous.builtin
        ? `\`${res.manifest.id}\` is built into Timon, which runs its own copy — this one is ignored and can be removed with \`timon plugin remove ${pkg}\``
        : `id \`${res.manifest.id}\` is already claimed by \`${previous.pkg}\` — two plugins cannot share an id (storage, routes, and data directory depend on it)`;
      out.push({ pkg, dir, version, refusal: { code: 'duplicate-id', message }, builtin });
      continue;
    }
    seen.set(res.manifest.id, { pkg, builtin: builtin !== undefined });
    // `main` only: `exports` would require reimplementing Node resolution, and
    // a plugin targeting this daemon follows §10.3 (`main` = host half,
    // `exports['./client']` = browser half, read by the frontend).
    //
    // A plugin may have NO host half: a widget, a page or a theme is browser
    // code and nothing else (§10.12). It is recognised by the absence of BOTH
    // `main` and `index.js`, plus a declared `client` half — never by an
    // import that failed, which stays an error naming its file. A declarative
    // pack never imports a host entry, including a stray index.js.
    const declared = json.main ? join(dir, json.main) : join(dir, 'index.js');
    const hostless = !hasHostHalf(dir, json, res.manifest);
    const hostProblem = dictationHostProblem(res.manifest, !hostless) ?? dictationModelsProblem(dir, res.manifest);
    if (hostProblem) {
      out.push({ pkg, dir, version, refusal: { code: 'manifest', message: `plugin \`${res.manifest.id}\`: ${hostProblem}` }, builtin });
      continue;
    }
    out.push({ pkg, dir, version, entry: hostless ? null : declared, manifest: res.manifest, engineRange: nodeEngineRange(json), builtin, ...(offByDefault ? { offByDefault: true as const } : {}) });
  }
  return out;
}

/**
 * Why a discovered package cannot run on `runtime`, from its `engines.node`
 * (TODO #763); `null` when it can. A check on the manifest variant, not a
 * discovery refusal: the package keeps its id, so `timon plugin remove <id>`
 * still finds it and its grants still go with it. Only a host half runs on
 * the daemon's Node — a widget or a provider pack never does — and a
 * built-in ships with the runtime it was tested on.
 */
export function engineRefusal(
  d: { entry: string | null; builtin?: BuiltinTrust; engineRange: string | null; manifest: Pick<PluginManifest, 'id'> },
  runtime: NodeRuntimeFacts,
): string | null {
  if (d.entry === null || d.builtin || !d.engineRange) return null;
  return nodeEngineProblem({ engines: { node: d.engineRange } }, d.manifest.id, runtime);
}

/**
 * Does this package have a host half the daemon imports? The rule
 * `discoverPlugins` applies, shared with the install paths that read a
 * package before it lands (`engines.node`, TODO #763).
 */
export function hasHostHalf(dir: string, json: unknown, manifest: Pick<PluginManifest, 'backends' | 'client'>): boolean {
  const raw = typeof json === 'object' && json !== null ? (json as { main?: unknown }).main : undefined;
  const main = typeof raw === 'string' ? raw : '';
  const declared = main ? join(dir, main) : join(dir, 'index.js');
  return !(manifest.backends !== undefined
    || (!main && !existsSync(declared) && manifest.client !== undefined));
}

/**
 * The `models` pack of a dictation plugin must be a file of the package once
 * links are resolved: the manifest's form keeps out `..` and absolute paths,
 * only the disk can tell a link that leads out. `null` when there is nothing
 * to say. Shared by admission and the install preview.
 */
export function dictationModelsProblem(dir: string, manifest: Pick<PluginManifest, 'dictation'>): string | null {
  const declared = manifest.dictation?.models;
  if (!declared) return null;
  try {
    const root = realpathSync(dir);
    const real = realpathSync(resolve(dir, declared));
    if (real.startsWith(root + sep) && statSync(real).isFile()) return null;
  } catch { /* missing: same answer */ }
  return `\`dictation.models\` (\`${declared}\`) is not a file of the package.`;
}

/**
 * Re-reads `plugins` FROM DISK on every call.
 *
 * Not `config()`: daemon configuration is memoized for the process lifetime,
 * which is normally correct — except here, where the point is to see the file
 * change live. A `timon plugin disable` taking effect only after restart would
 * miss the step's sole criterion.
 *
 * Not `loadConfig()` either: a temporarily invalid file while a human edits it
 * would bring down running plugins. Read only the relevant section and keep
 * the current state when in doubt.
 */
export function configuredPlugins(file: string = CONFIG_FILE): Record<string, ModuleSetting> {
  if (!existsSync(file)) return {};
  try {
    const raw = readJson(file) as { plugins?: unknown };
    const parsed = z.record(z.string(), ModuleSettingSchema).safeParse(raw.plugins ?? {});
    if (parsed.success) return parsed.data;
    console.warn(`[plugins] invalid \`plugins\` section in ${file} — ignored`);
  } catch (err) {
    console.warn(`[plugins] cannot read ${file} (${(err as Error).message}) — activations ignored`);
  }
  return {};
}

/**
 * `config.plugins[id]` → requested activation and options passed to `apply`.
 *
 * `installedBy` is stripped alongside `enabled`: it is bookkeeping written by
 * `timon plugin add` of a bundle (§10.12), not an option of the child plugin.
 * Leaving it in would hand a plugin a key it never declared AND make the
 * marker part of `signature()` below — writing or clearing provenance would
 * then remount a perfectly running plugin.
 */
/**
 * Does this plugin replace the whole interface? Read on both fields: the
 * manifest already refuses `root` outside a layout, and checking the two
 * keeps the licence gate shut should either rule ever loosen.
 */
export function requestsRoot(manifest: Pick<PluginManifest, 'kind' | 'client'>): boolean {
  return manifest.kind.includes('layout') || (manifest.client?.slots.includes('root') ?? false);
}

/** What the loader, the gallery and `timon plugin list` say of a layout refused for want of the right. */
export function whiteLabelRefusal(id: string): string {
  return `plugin \`${id}\` replaces the whole interface, which needs a licence that includes White Label`;
}

function settingOf(v: ModuleSetting | undefined, offByDefault = false): { enabled: boolean; config: Record<string, unknown> } {
  if (v === undefined || v === 'auto') return { enabled: !offByDefault, config: {} };
  if (typeof v === 'boolean') return { enabled: v, config: {} };
  const { enabled, installedBy: _installedBy, ...rest } = v as Record<string, unknown>;
  return { enabled: offByDefault ? enabled === true : enabled !== false, config: rest };
}

/** The package loaded under an id. Trust as this pass judged it, not as a list shows it. */
export type PluginPackageIdentity = PluginWebhookPublisher & { secretSettings: string[] };

export type PluginLoaderOptions = {
  /** Root of the plugins' npm tree. */
  dir?: string;
  /** Daemon bindings, built from the ROOT context: an isolated context no
   *  longer resolves `http`, so no route can be mounted. */
  host: PluginHost;
  /** Read on every `update()` — never memoized; see `configuredPlugins`. */
  plugins?: () => Record<string, ModuleSetting>;
  /** Called when a plugin fails (`alert` in the daemon, spy in tests). */
  onFailure?: (id: string, message: string) => void;
  /**
   * Called when the tree actually changes (add / remove / enable / disable, or
   * a bundle `rev` changes). The daemon uses it to publish `plugins_changed`;
   * plugins themselves do not emit — the bus is read-only to them (§10.4).
   */
  onChange?: (records: PluginStatus[]) => void;
  /**
   * Called at the start of every pass, before anything mounts. The watcher runs
   * one when `timon.config.json` changes: the daemon re-reads there what the
   * operator's file withdrew, so a package mounted by this pass does not get it
   * (TODO #663).
   */
  beforePass?: () => void;
  /**
   * Called once per plugin whose package left the disk since the last pass
   * (`timon plugin remove`, or a folder deleted by hand) — not for a plugin
   * disabled or refused, which is still installed. The daemon closes there
   * what only made sense for that install (its consent cards, TODO #661).
   */
  onRemoved?: (id: string) => void;
  /**
   * Called for every admitted package, enabled or not, before anything of it runs:
   * says which package holds the id. The daemon withdraws there what another
   * package was granted (`package-binding.ts`, TODO #671). A throw keeps it unmounted.
   */
  settlePackage?: (id: string, pkg: PluginPackageIdentity) => void;
  /** Injectable keys for tests and rotation. */
  publicKeys?: readonly PluginPublicKey[];
  /** Re-read on every update so developer mode follows the config. */
  allowUnsigned?: () => boolean;
  /** Allowlist from the license verified before boot. */
  licensedPlugins?: () => readonly string[] | '*';
  /**
   * Whether the licence in force carries the White Label right, re-read on
   * every update so losing it while the daemon runs unmounts the layout.
   * Absent means `false`: replacing the whole interface is never open by
   * default.
   */
  whiteLabelAllowed?: () => boolean;
  /**
   * Plugins shipped with the product, re-resolved on every update so a file
   * altered while the daemon runs loses its trust. The daemon passes
   * `resolveBuiltins`; none by default, so a test tree sees only its fixtures.
   */
  builtins?: () => readonly ResolvedBuiltin[];
  /**
   * Backends with a live mission right now. A provider plugin with a mission in
   * flight on one of its backends is NOT remounted: its update waits for the
   * mission to end (`docs/PROVIDERS-SDK.md` §12.5). Absent in tests that do not
   * model missions: nothing is ever in flight.
   */
  backendsInFlight?: () => ReadonlySet<string>;
  /** The Node host halves run on, read against `engines.node`. This process's own unless a test injects one. */
  runtime?: NodeRuntimeFacts;
};

/** A browser-only plugin has no fiber: there is nothing to run on the daemon,
 *  but it is still mounted — its client bundle is served and it can be
 *  disabled like any other. */
type Mounted = { fiber: Fiber | null; signature: string; version: string; rev?: string; pack?: ReturnType<typeof mountProviderPack>; sqlDb?: { close(): void }; closePublicPaths?: () => void };

/**
 * Third-party plugin tree, mounted and unmounted live.
 *
 * One instance per daemon. `update()` is idempotent: called twice without a
 * disk change, it mounts nothing again (a plugin signature covers its version,
 * options, and desired state).
 */
export class PluginLoader {
  private readonly dir: string;
  private readonly mounted = new Map<string, Mounted>();
  /** Counts hot mounts: each one imports under a revision of its own (see `mount`). */
  private mountSeq = 0;
  private records: PluginStatus[] = [];
  private updating: Promise<PluginStatus[]> = Promise.resolve([]);
  private watchers: string[] = [];
  private treePoll: NodeJS.Timeout | null = null;
  private lastSnap: string | null = null;
  /** Source-tree fingerprint seen by the last reconciliation, per plugin
   *  directory. `watch()` compares against it to notice an edit to ANY file. */
  private readonly stamps = new Map<string, { dir: string; stamp: string }>();
  /**
   * Installed packages the last pass did NOT mount (declared but missing,
   * half-written, signature not there yet, disabled…), by directory, with the
   * fingerprint taken BEFORE that pass read them. `npm install` can be caught
   * mid-write by a pass the root `package.json` triggered; nothing else changes
   * at the root afterwards, so without this poll the final tree was never read
   * (TODO #925).
   */
  private readonly unsettled = new Map<string, string>();
  /** Provider plugins whose update waits for running missions, and the timer that asks again. */
  private readonly deferred = new Set<string>();
  private deferTimer: NodeJS.Timeout | null = null;
  /** Updates a provider's running version refused (transport / session store changed), per new signature. */
  private readonly refused = new Map<string, { signature: string; message: string }>();
  /** Servable bundles — one instance, mutated on each reconciliation. */
  readonly bundles = new BundleRegistry();
  /**
   * Servable cover art. Fed on the DISCOVERY path, not the mount path: the
   * gallery draws a card for a plugin that is disabled or unlicensed, and a
   * card without its cover is exactly the case the toggle exists for.
   */
  readonly covers = new CoverRegistry();

  constructor(private readonly root: Context, private readonly opts: PluginLoaderOptions) {
    this.dir = opts.dir ?? PLUGINS_DIR;
  }

  /** Last known state, without rereading disk. */
  list(): PluginStatus[] {
    const inactive = this.records.some((r) => r.backends) ? inactiveProfiles() : [];
    return this.records.map((r) => ({ ...r, ...(r.backends ? {
      backends: r.backends.map((p) => ({ ...p, issue: p.issue ?? inactive.find((i) => i.id === p.id)?.reason ?? null })),
    } : {}) }));
  }

  /**
   * Reconciles the mounted tree with disk. Concurrent calls are serialized: a
   * `timon plugin add` during `update()` must wait its turn, otherwise two
   * reconciliations would mount the same plugin twice.
   */
  update(): Promise<PluginStatus[]> {
    this.updating = this.updating.then(() => this.reconcile(), () => this.reconcile());
    return this.updating;
  }

  private async reconcile(): Promise<PluginStatus[]> {
    // Swaps opened for a provider being remounted close when the pass ends, so
    // that a backend never disappears between the old fiber and the new one.
    const swaps: Array<() => void> = [];
    try {
      return await this.reconcilePass(swaps);
    } finally {
      for (const end of swaps) end();
    }
  }

  private async reconcilePass(swaps: Array<() => void>): Promise<PluginStatus[]> {
    this.opts.beforePass?.();
    const wanted = (this.opts.plugins ?? configuredPlugins)();
    // Before discovery reads a single file: a write landing during the pass then
    // differs from this fingerprint, and the poll asks for another pass.
    const before = new Map(installedPackages(this.dir).map((pkg) => {
      const dir = join(this.dir, 'node_modules', pkg);
      return [dir, treeStamp(dir)] as const;
    }));
    const discovered = discoverPlugins(this.dir, this.opts.builtins?.() ?? []);
    // Rebuilt by this pass: a plugin disabled, removed or skipped while its
    // update waited must not keep the retry timer alive.
    this.deferred.clear();
    const records: PluginStatus[] = [];
    const keep = new Set<string>();
    const covered = new Set<string>();

    for (const d of discovered) {
      if ('refusal' in d) {
        // A rejected package has no reliable id: index it by its npm name.
        await this.unmount(d.pkg);
        records.push({
          id: d.pkg, pkg: d.pkg, dir: d.dir, version: d.version,
          state: 'skipped', reason: `skipped:${d.refusal.code}`, error: d.refusal.message,
          manifest: null, client: false, signed: false, signature: null,
          ...(d.builtin && d.refusal.code !== 'duplicate-id' ? { builtin: true as const } : {}),
        });
        console.warn(`[plugins] ${d.pkg} ignored (${d.refusal.code}): ${d.refusal.message}`);
        continue;
      }

      const id = d.manifest.id;
      // Before any admission test: a refused plugin is still listed, and a
      // listed plugin still shows its cover.
      if (this.refreshCover(id, d.dir, d.manifest)) covered.add(id);
      const { enabled, config } = settingOf(wanted[id], d.offByDefault === true);
      // Admission before the license gate so `signed` is known even on an
      // unlicensed skip — the gallery's Verified tab is about the signature,
      // not about whether this install may run the plugin.
      const admission = verifyPluginDirectory(d.dir, this.opts.publicKeys ?? PLUGIN_PUBLIC_KEYS);
      const base: PluginStatus = {
        id, pkg: d.pkg, dir: d.dir, version: d.version,
        state: 'active', reason: null, error: null,
        manifest: d.manifest, client: d.manifest.client !== undefined,
        signed: admission.ok,
        signature: admission.ok ? { hash: admission.signature.hash, keyId: admission.signature.keyId } : null,
        ...(d.builtin ? { builtin: true as const } : {}),
      };
      // Trust by location (`builtin.ts`): part of the release, so neither the
      // licence composition nor a signature governs it. A built-in whose
      // files the release does not vouch for falls through to the checks
      // any installed package goes through.
      const trusted = d.builtin?.ok === true;
      const untrusted = d.builtin && !d.builtin.ok ? `built-in plugin not vouched for by the release (${d.builtin.message}); ` : '';

      if (!trusted && fixedComposition(licenseState())) {
        await this.unmount(id);
        records.push({ ...base, state: 'skipped', reason: 'skipped:unlicensed', error: 'This licence has a fixed bundled composition; external plugins cannot run.' });
        continue;
      }
      // Before the signature admission on purpose: developer mode lets an
      // unsigned package through, and must not open the whole interface with it.
      if (!trusted && requestsRoot(d.manifest) && !(this.opts.whiteLabelAllowed?.() ?? false)) {
        await this.unmount(id);
        records.push({ ...base, state: 'skipped', reason: 'skipped:unlicensed', error: whiteLabelRefusal(id) });
        continue;
      }
      if (!trusted && d.manifest.license.required) {
        const licensed = this.opts.licensedPlugins?.() ?? [];
        if (licensed !== '*' && !licensed.includes(id)) {
          await this.unmount(id);
          records.push({ ...base, state: 'skipped', reason: 'skipped:unlicensed', error: `plugin \`${id}\` is not covered by the license` });
          continue;
        }
      }

      // Admission check BEFORE importing the host half. Developer mode bypasses
      // only a missing SIGNATURE: a present but invalid signature is tampering
      // and remains rejected.
      const unsignedAllowed = admission.ok === false
        && admission.code === 'unsigned'
        && admission.message === 'SIGNATURE absent'
        && (this.opts.allowUnsigned?.() ?? false);
      if (!trusted && !admission.ok && !unsignedAllowed) {
        await this.unmount(id);
        records.push({ ...base, state: 'skipped', reason: `skipped:${admission.code}`, error: untrusted + admission.message });
        console.warn(`[plugins] ${id} ignored (${admission.code}): ${untrusted}${admission.message}`);
        continue;
      }

      // Its engines.node excludes the Node it would run on: refused before it
      // settles, so it takes nothing from the package on record (TODO #763).
      const engine = engineRefusal(d, this.opts.runtime ?? currentNodeRuntime());
      if (engine) {
        await this.unmount(id);
        records.push({ ...base, state: 'skipped', reason: 'skipped:node-engine', error: engine });
        console.warn(`[plugins] ${id} ignored (node-engine): ${engine}`);
        continue;
      }

      // Past admission and only there: a package refused above takes nothing from
      // the one on record. Before the signature test below, whose match could
      // otherwise keep a mounted id without asking who holds it now.
      const settle = () => this.opts.settlePackage?.(id, {
        pkg: d.pkg,
        trust: trusted ? 'builtin' : admission.ok ? 'signed' : 'unsigned',
        secretSettings: d.manifest.settings.filter((s) => s.type === 'secret').map((s) => s.key),
      });
      let refused: Error | null = null;
      try { settle(); } catch (err) { refused = err as Error; }
      // The package still mounted under the id may be what holds its data folder
      // open (Windows refuses the move): stopped, it lets go, and every step of the
      // settlement is safe to run again.
      if (refused && this.mounted.has(id)) {
        await this.unmount(id);
        try { settle(); refused = null; } catch (err) { refused = err as Error; }
      }
      if (refused) {
        await this.unmount(id);
        const failure = this.fail(id, 'failed', refused.message);
        records.push({ ...base, state: 'failed', reason: failure.reason, error: failure.message });
        continue;
      }

      if (!enabled) {
        await this.unmount(id);
        const neverEnabled = d.offByDefault === true && (wanted[id] === undefined || wanted[id] === 'auto');
        records.push({ ...base, state: 'disabled', reason: neverEnabled ? 'built in but switched off until you enable it' : 'disabled in timon.config.json' });
        continue;
      }

      keep.add(id);
      // Lets an unhandled rejection from its files be put on its name. Not
      // cleared at unmount: a timer the plugin left behind still rejects
      // under its name, and that is when the name matters most.
      setPluginSource(id, d.dir);
      // A built-in is part of the release: its files do not change under the
      // daemon, and re-evaluating its sub-modules would duplicate their state.
      const hot = !trusted;
      const signature = this.signature(d.entry ?? d.dir, hot ? d.dir : null, d.version, config)
        + `|${admission.ok ? admission.signature.hash : trusted ? 'builtin' : 'developer-unsigned'}`
        + (d.manifest.backends ? `|${JSON.stringify(d.manifest)}` : '');
      // Watched all the same when it has no host half (a theme, a browser-only
      // plugin): there is no sub-module state to duplicate, a reconciliation
      // only re-reads its bundle and hands browsers the new `rev`. In a source
      // tree that is what makes editing a built-in theme show live; in a
      // release its files do not change, and the poll finds nothing.
      if (hot || d.entry === null) this.stamps.set(id, { dir: d.dir, stamp: before.get(d.dir) ?? treeStamp(d.dir) });
      const already = this.mounted.get(id);
      if (already && already.signature === signature) {
        this.refreshBundle(id, d.dir, d.manifest, trusted);
        records.push({ ...base, ...(already.pack ? { backends: already.pack.profiles } : {}) });
        continue;
      }
      const provider = d.manifest.permissions.includes('backends:register');
      if (already && provider) {
        const refused = this.refused.get(id);
        if (refused?.signature === signature) {
          // The same files were already judged: the running version stays, quietly.
          this.refreshBundle(id, d.dir, d.manifest, trusted);
          records.push({ ...base, reason: 'update-refused', error: refused.message });
          continue;
        }
        if (this.hasMissions(id)) {
          this.deferred.add(id);
          this.refreshBundle(id, d.dir, d.manifest, trusted);
          records.push({ ...base, version: already.version, reason: 'update-pending',
            error: 'a new version is installed; it applies when the missions running on this provider end' });
          continue;
        }
      }
      this.deferred.delete(id);
      this.refused.delete(id);
      if (already) {
        if (provider) swaps.push(beginProviderSwap(id));
        await this.unmount(id);
      }

      if (d.entry === null) {
        const pack = d.manifest.backends ? mountProviderPack(d.manifest, this.opts.host.kv) : undefined;
        this.mounted.set(id, { fiber: null, signature, pack, version: d.version });
        this.refreshBundle(id, d.dir, d.manifest, trusted);
        records.push({ ...base, ...(pack ? { backends: pack.profiles } : {}) });
        continue;
      }

      // A built-in does not change the composition: it mounts under a fixed
      // one too, which `withCompositionWrite` would refuse.
      const publisher = webhookPublisherOf(base);
      const mountIt = () => this.mount(id, d.entry!, d.dir, hot ? d.dir : null, d.manifest, d.version, config, signature, trusted, publisher);
      let failure = await (trusted ? mountIt() : withCompositionWrite(licenseState(), mountIt));
      if (failure?.reason === 'update-refused' && already) {
        // The new version would change how missions talk to the provider: put the
        // running one back (its module is still cached under its own revision).
        const message = `version ${d.version} not applied: ${failure.message}`;
        this.refused.set(id, { signature, message });
        const restored = await this.mount(id, d.entry!, d.dir, hot ? d.dir : null, d.manifest, already.version, config, already.signature, trusted, publisher, already.rev);
        if (!restored) {
          this.refreshBundle(id, d.dir, d.manifest, trusted);
          records.push({ ...base, version: already.version, reason: 'update-refused', error: message });
          continue;
        }
        failure = restored;
      }
      if (failure) {
        records.push({ ...base, state: 'failed', reason: failure.reason, error: failure.message });
      } else {
        this.refreshBundle(id, d.dir, d.manifest, trusted);
        records.push(base);
      }
    }

    // Anything removed from disk (or whose manifest no longer passes) leaves
    // with its routes and effects.
    for (const id of [...this.mounted.keys()]) {
      if (!keep.has(id)) await this.unmount(id);
    }
    for (const id of [...this.stamps.keys()]) {
      if (!keep.has(id)) this.stamps.delete(id);
    }
    const polled = new Set([...this.stamps.values()].map((s) => s.dir));
    this.unsettled.clear();
    for (const [dir, stamp] of before) {
      if (!polled.has(dir)) this.unsettled.set(dir, stamp);
    }
    this.bundles.retain(this.mounted.keys());
    this.covers.retain(covered);

    // By package, not id: a manifest that stops validating is indexed by its
    // npm name, yet the package is still there.
    const onDisk = new Set(discovered.map((d) => d.pkg));
    for (const before of this.records) {
      if (before.manifest && !onDisk.has(before.pkg)) this.opts.onRemoved?.(before.id);
    }

    this.records = records;
    this.scheduleDeferred();
    this.emitIfChanged();
    return this.list();
  }

  /** A provider with a mission in flight on one of its backends. */
  private hasMissions(pluginId: string): boolean {
    const inFlight = this.opts.backendsInFlight?.();
    if (!inFlight || inFlight.size === 0) return false;
    const owners = registeredBackendOwners();
    // The dialect's owner also serves profiles registered by another plugin, and subscription accounts.
    // Installed profiles include disabled ones: disabling a profile does not stop its running process.
    return [...inFlight].some((id) => {
      const backend = baseBackendId(id);
      if (owners.profiles[backend] === pluginId) return true;
      const profile = installedProfiles().find((candidate) => candidate.id === backend);
      return profile !== undefined && owners.dialects[profile.dialect] === pluginId;
    });
  }

  /** Asks again while an update waits for missions to end. */
  private scheduleDeferred(): void {
    if (this.deferTimer || this.deferred.size === 0) return;
    this.deferTimer = setTimeout(() => {
      this.deferTimer = null;
      // A cheap look first: reconciling hashes every plugin directory, so it
      // only runs once some waiting provider has no mission left.
      if ([...this.deferred].some((id) => !this.hasMissions(id))) {
        void this.update().catch((err: Error) => console.warn('[plugins] deferred update:', err.message));
      } else {
        this.scheduleDeferred();
      }
    }, 5_000);
    this.deferTimer.unref();
  }

  /**
   * Recomputes the browser-half hash. Also called when the host has not changed:
   * an edit to `client.js` alone must still change `rev`.
   */
  private refreshBundle(id: string, dir: string, manifest: PluginManifest, builtin: boolean): void {
    if (!manifest.client) {
      this.bundles.unregister(id);
      return;
    }
    let json: unknown;
    try {
      json = readJson(join(dir, 'package.json'));
    } catch (err) {
      console.warn(`[plugins] ${id}: cannot read package.json for bundle — ${(err as Error).message}`);
      this.bundles.unregister(id);
      return;
    }
    const res = this.bundles.register(id, dir, json, builtin);
    if (!res.ok) {
      console.warn(`[plugins] ${id}: ${res.message}`);
      this.bundles.unregister(id);
    }
  }

  /**
   * Registers (or re-registers) the cover art. Rends `false` when there is
   * nothing to serve — a manifest without `cover`, or a file the package does
   * not actually ship. A missing cover is not a failure: the gallery falls
   * back to a placeholder.
   */
  private refreshCover(id: string, dir: string, manifest: PluginManifest): boolean {
    if (!manifest.cover) {
      this.covers.unregister(id);
    } else {
      const res = this.covers.register(id, dir, manifest.cover);
      if (!res.ok) {
        console.warn(`[plugins] ${id}: ${res.message}`);
        this.covers.unregister(id);
      }
    }
    this.covers.registerStills(id, dir, manifest.screenshots);
    if (!manifest.icon) {
      this.covers.unregisterIcon(id);
    } else {
      const res = this.covers.registerIcon(id, dir, manifest.icon);
      if (!res.ok) {
        console.warn(`[plugins] ${id}: ${res.message}`);
        this.covers.unregisterIcon(id);
      }
    }
    return this.covers.get(id) !== null || this.covers.listStills(id).length > 0 || this.covers.getIcon(id) !== null;
  }

  private emitIfChanged(): void {
    const snap = JSON.stringify(this.records.map((r) => ({
      id: r.id,
      state: r.state,
      reason: r.reason,
      version: r.version,
      rev: this.bundles.get(r.id)?.rev ?? null,
    })));
    if (snap === this.lastSnap) return;
    this.lastSnap = snap;
    try {
      this.opts.onChange?.(this.list());
    } catch (err) {
      console.warn('[plugins] onChange:', (err as Error).message);
    }
  }

  /** Changes when code, version, or options change: this decides whether to
   *  remount or keep running. `dir` set = the whole source tree counts, not
   *  only the entry: a plugin split across `lib/*.js` must remount when a
   *  sub-module changes. */
  private signature(entry: string, dir: string | null, version: string, config: Record<string, unknown>): string {
    let stamp = '0';
    if (dir !== null) {
      stamp = treeStamp(dir);
    } else {
      try { stamp = String(statSync(entry).mtimeMs); } catch { /* missing file: import will fail and report it */ }
    }
    return `${version}|${stamp}|${JSON.stringify(config)}`;
  }

  private async mount(
    id: string,
    entry: string,
    packageDir: string,
    hotDir: string | null,
    manifest: PluginManifest,
    version: string,
    config: Record<string, unknown>,
    signature: string,
    builtin: boolean,
    publisher: PluginWebhookPublisher,
    revision?: string,
  ): Promise<{ reason: string; message: string } | null> {
    // The revision is what Node's ESM cache is keyed on, and it caches a module
    // whose linking FAILED just as it caches a good one. The signature alone is
    // the same for a disable then enable with no edit in between, so a plugin
    // that once failed to import (an export missing mid-edit) would fail the
    // same way until the daemon restarted (TIM-0116). A hot plugin therefore
    // imports under a fresh revision at every mount; `revision` is passed only
    // to put back a version that is still cached under its own.
    const rev = revision ?? (hotDir !== null ? `${signature}|m${++this.mountSeq}` : signature);
    let mod: PluginModule;
    try {
      // `?rev=` breaks the ESM cache: without it, reinstalling a fixed plugin
      // would load the OLD code, leaving the developer to search for a bug in
      // a file the daemon no longer executes. `hotDir` extends it to the
      // sub-modules inside the plugin directory (see `hot-reload.ts`).
      if (hotDir !== null) evictRequireCache(hotDir);
      mod = (await import(entryUrl(entry, rev, hotDir))) as PluginModule;
    } catch (err) {
      const retry = hotDir !== null ? ' — fix the file, or disable then enable the plugin to load it again' : '';
      return this.fail(id, 'skipped:import', `cannot read host half (${entry}): ${(err as Error).message}${retry}`);
    }

    // `inject` is checked AFTER import (it lives in the module) but BEFORE
    // `apply`: a plugin requesting `db` never executes its logic.
    const forbidden = forbiddenInject(id, mod.inject ?? []);
    if (forbidden) return this.fail(id, `skipped:${forbidden.code}`, forbidden.message);
    if (typeof mod.apply !== 'function') {
      return this.fail(id, 'skipped:import', `host half does not export an \`apply\` function (${entry})`);
    }
    const apply = mod.apply;

    // The plugin's own database is open and migrated before `apply`: a plugin
    // never runs against a schema that is half migrated (API 15).
    let sqlDb: ReturnType<typeof openPluginDb> | undefined;
    if (manifest.permissions.includes('storage:sql')) {
      try {
        sqlDb = openPluginDb(pluginDbFile(this.opts.host.dataDir(id)));
        if (manifest.migrations) migratePluginDb(sqlDb, readMigrations(resolveMigrationsDir(packageDir, manifest.migrations)));
      } catch (err) {
        sqlDb?.close();
        return this.fail(id, 'skipped:migration', `database not ready: ${(err as Error).message}`);
      }
    }
    let sqlOpen = sqlDb !== undefined;
    const sqlFacade = sqlDb ? pluginSqlFacade(sqlDb, () => sqlOpen) : undefined;
    const closeSql = sqlDb ? { close: () => { if (sqlOpen) { sqlOpen = false; sqlDb!.close(); } } } : undefined;
    // Anonymous paths open with the plugin and close with it (API 15, `http:public`).
    const closePublicPaths = manifest.routes?.publicPaths.length
      ? registerPluginPublicPaths(id, manifest.routes.publicPaths)
      : undefined;

    // Before `apply`, which may spawn at once. `builtin` is the release vouching
    // for the files; the publisher says `signed` only when the admission passed.
    setPluginSpawnStanding(id, {
      trust: builtin ? 'builtin' : publisher.trust === 'signed' ? 'signed' : 'unsigned',
      declaresSpawn: manifest.permissions.includes('missions:spawn'),
    });
    // Isolated context: even an `inject` that escaped the check resolves no
    // internal service (second line of defense, see P.2).
    const fiber = isolateForPlugin(this.root).plugin({
      name: `plugin:${id}`,
      apply: (ctx: Context) => apply(
        createPluginContext(ctx, { manifest, version, config, builtin, publisher, sqlDb: sqlFacade }, this.opts.host),
        config,
      ),
    });
    this.mounted.set(id, { fiber, signature, version, rev, sqlDb: closeSql, closePublicPaths });

    try {
      await fiber;
    } catch (err) {
      // The fiber is FAILED and Cordis removes its effects. The daemon
      // continues; this is the phase's exit criterion.
      this.mounted.delete(id);
      setPluginSpawnStanding(id, null);
      closeSql?.close();
      closePublicPaths?.();
      if (err instanceof HotUpdateRefusedError) return this.fail(id, 'update-refused', err.message);
      return this.fail(id, 'failed', `\`apply\` failed: ${(err as Error).message}`);
    }
    console.log(`[plugins] ${id}@${version} actif`);
    return null;
  }

  private fail(id: string, reason: string, message: string): { reason: string; message: string } {
    console.warn(`[plugins] ${id}: ${message}`);
    this.opts.onFailure?.(id, message);
    return { reason, message };
  }

  private async unmount(id: string): Promise<void> {
    this.bundles.unregister(id);
    setPluginSpawnStanding(id, null);
    const m = this.mounted.get(id);
    if (!m) return;
    this.mounted.delete(id);
    m.pack?.dispose();
    // Closed first: nobody reaches the plugin anonymously while it unloads.
    m.closePublicPaths?.();
    if (m.fiber) {
      try {
        await m.fiber.dispose();
      } catch (err) {
        console.warn(`[plugins] ${id}: incomplete unload — ${(err as Error).message}`);
      }
    }
    // After the plugin's own effects, which may still write; before the data
    // folder can be moved to the trash, which Windows refuses on an open file.
    m.sqlDb?.close();
  }

  /**
   * Watches the two files that determine the tree: the installed package list
   * and configuration. This makes `timon plugin` work WITHOUT a restart AND
   * without a dedicated route — the CLI writes to disk and the daemon notices.
   *
   * It also polls the source tree of every non-built-in plugin, and of every
   * built-in without a host half: a plugin linked from a repository
   * (developer mode) is edited in place, and an edit to `lib/core.js`
   * touches neither of those two files. Installed packages left unmounted are
   * polled too, so a pass that read an install half-way is followed by one
   * that reads it whole.
   *
   * `watchFile` (polling), not `watch` (inotify): npm REPLACES `package.json`
   * instead of modifying it, and an inotify watch on a destroyed inode never
   * notifies again.
   */
  watch(intervalMs = 1_000): () => void {
    const files = [join(this.dir, 'package.json'), CONFIG_FILE];
    let pending: NodeJS.Timeout | null = null;
    const onChange = () => {
      if (pending) clearTimeout(pending);
      // npm writes several times in a row: let the dust settle.
      pending = setTimeout(() => {
        pending = null;
        // A failed reconciliation must not kill the process through an
        // unhandled rejection: it has already reported everything in the logs.
        this.update().catch((err: Error) => console.warn('[plugins] recomposition:', err.message));
      }, 250);
      pending.unref();
    };
    for (const f of files) {
      const w = watchFile(f, { interval: intervalMs }, onChange);
      w.unref();
      this.watchers.push(f);
    }
    if (this.treePoll) clearInterval(this.treePoll);
    this.treePoll = setInterval(() => {
      // A change already waiting out its debounce: re-arming it every tick
      // would push the reconciliation back forever.
      if (pending) return;
      for (const { dir, stamp } of this.stamps.values()) {
        if (treeStamp(dir) !== stamp) {
          onChange();
          return;
        }
      }
      for (const [dir, stamp] of this.unsettled) {
        if (treeStamp(dir) !== stamp) {
          onChange();
          return;
        }
      }
    }, intervalMs);
    this.treePoll.unref();
    return () => this.unwatch();
  }

  private unwatch(): void {
    for (const f of this.watchers) unwatchFile(f);
    this.watchers = [];
    if (this.treePoll) clearInterval(this.treePoll);
    this.treePoll = null;
  }

  /** Unmounts everything — for tests and daemon shutdown. */
  async dispose(): Promise<void> {
    this.unwatch();
    if (this.deferTimer) clearTimeout(this.deferTimer);
    this.deferTimer = null;
    this.deferred.clear();
    for (const id of [...this.mounted.keys()]) await this.unmount(id);
    this.records = [];
    this.lastSnap = null;
    this.unsettled.clear();
    this.bundles.retain([]);
    this.covers.retain([]);
  }
}
