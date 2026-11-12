/**
 * Installation of third-party plugins — what `timon plugin add|remove|
 * enable|disable` does (§10.3, §10.5).
 *
 * This whole file writes on DISK and nothing else: `~/.timon/plugins/`
 * for the npm tree, `~/.timon/timon.config.json` for the activation. The daemon,
 * for its part, watches these two files (`PluginLoader.watch()`) and recomposes its
 * tree on its own. That is what makes the commands usable **without a
 * restart and without an HTTP route**: the CLI does not have to know whether a daemon
 * runs, nor on which port — it sets the wanted state, the daemon follows.
 *
 * `npm` and not `pnpm`: npm is there as soon as Node is, and a plugin is an
 * ordinary npm package (§10.3). No dependency added.
 */
import { LicenseCapabilityError, assertCompositionMutable, fixedComposition, withCompositionWrite } from '../license/capabilities.js';
import { mutationLicenseState } from '../license/runtime.js';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIG_FILE, config, setConfig } from '../config/load.js';
import { BRAND } from '../brand.js';
import { whiteLabelAllowed } from '../license/capabilities.js';
import { applyBuildPolicy } from '../license/build-policy.js';
import { bootLicenseState } from '../license/refresh.js';
import { requestsRoot, whiteLabelRefusal } from './loader.js';
import { getHost } from '../host/index.js';
import { PLUGINS_DIR } from '../paths.js';
import { discoverPlugins, engineRefusal, hasHostHalf, installedPackages } from './loader.js';
import { readManifest, type PluginManifest, type PluginPermission } from './manifest.js';
import { PLUGIN_PUBLIC_KEYS, unsignedPluginsAllowed, type PluginPublicKey } from './pubkey.js';
import { verifyPluginDirectory } from './signature.js';
import { currentNodeRuntime, nodeEngineProblem, type NodeRuntimeFacts } from './node-engine.js';
import { resolveBuiltins, type ResolvedBuiltin } from './builtin.js';
import { agentsCreatedBy, pluginAgentOrigin } from './agent-origin.js';
import { disablePluginAutomations, type PluginAutomations } from './automation-cleanup.js';
import { purgePluginWebhookSecrets } from './webhooks.js';
import { boundPluginPackages, signsUnsignedCopy } from './package-binding.js';
import { closePluginSecretCards, revokePluginSecretGrants } from '../secrets/plugins.js';
import { closePluginLaunchCard } from '../backends/launch-card.js';
import { closePluginSpawnCards, narrowLivePluginGrants } from './policy.js';
import { withdrawPluginUserConnections } from './user-connections-host.js';

/** A line of `timon plugin list`. Built offline, without a daemon. */
export type InventoryEntry = {
  /** Manifest id; the npm name when the manifest is unreadable. */
  id: string;
  pkg: string;
  version: string;
  /** Wanted activation (`config.plugins[id]`), not the daemon's real state. */
  enabled: boolean;
  /** `skipped:<code>` when the package is refused, `null` otherwise. */
  refused: string | null;
  message: string | null;
  permissions: readonly PluginPermission[];
  /** Shipped with the product: disable-only. */
  builtin?: true;
};

type Json = Record<string, unknown>;

function readJson(file: string): Json {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}: the root must be a JSON object`);
  }
  return parsed as Json;
}

function writeJson(file: string, data: Json): void {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Marker written into `plugins[<child-id>]` when a bundle brought that child in
 * (plan §10.12). It lives in the config rather than in a side file because the
 * two facts belong together: the child is enabled BECAUSE the bundle installed
 * it, and `timon plugin remove <bundle>` reads back exactly what it wrote.
 *
 * Anything else keeps the child: a plugin installed before the bundle never
 * gets the marker, and `timon plugin add <child>` clears it — reinstalling by
 * hand makes the child its own owner.
 */
const PROVENANCE_KEY = 'installedBy';

function pluginsSection(cfg: Json): Json {
  return (typeof cfg.plugins === 'object' && cfg.plugins !== null && !Array.isArray(cfg.plugins))
    ? (cfg.plugins as Json)
    : {};
}

/** Id of the bundle that installed `id`, or `null` when nobody claims it. */
export function pluginProvenance(id: string, file: string = CONFIG_FILE): string | null {
  let entry: unknown;
  try {
    entry = pluginsSection(readJson(file))[id];
  } catch { return null; }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const owner = (entry as Json)[PROVENANCE_KEY];
  return typeof owner === 'string' ? owner : null;
}

/**
 * `plugins[<id>] = { enabled: true, installedBy: <bundle> }`.
 *
 * `enabled: true` even if the config said `false`: the package was ABSENT, so
 * that `false` described a plugin that no longer existed. The plan's sentence
 * is "install and enable each missing id" — a bundle whose children
 * install disabled would look broken on the first launch.
 */
function markInstalledBy(id: string, bundleId: string, file: string): void {
  let cfg: Json;
  try { cfg = readJson(file); } catch { cfg = {}; }
  const plugins = pluginsSection(cfg);
  const current = plugins[id];
  const entry: Json = (typeof current === 'object' && current !== null && !Array.isArray(current))
    ? { ...(current as Json) }
    : {};
  entry.enabled = true;
  entry[PROVENANCE_KEY] = bundleId;
  plugins[id] = entry;
  cfg.plugins = plugins;
  writeJson(file, cfg);
}

/** Drops the marker, keeping every other key (the plugin's own options). */
function clearProvenance(id: string, file: string): void {
  let cfg: Json;
  try { cfg = readJson(file); } catch { return; }
  const plugins = pluginsSection(cfg);
  const current = plugins[id];
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return;
  if (!(PROVENANCE_KEY in (current as Json))) return;
  const { [PROVENANCE_KEY]: _owner, ...rest } = current as Json;
  plugins[id] = rest;
  cfg.plugins = plugins;
  writeJson(file, cfg);
}

/** Removes the whole entry — used only on a child the bundle had written. */
function forgetPlugin(id: string, file: string): void {
  let cfg: Json;
  try { cfg = readJson(file); } catch { return; }
  const plugins = pluginsSection(cfg);
  if (!(id in plugins)) return;
  delete plugins[id];
  cfg.plugins = plugins;
  writeJson(file, cfg);
}

/**
 * Drops `pluginPolicy.http.byPlugin[<id>]` (TODO #599) and returns the hosts it
 * held. Those hosts were consented to for THIS package: one republished later
 * under the same id, by another author included, was never shown to anyone.
 * The live config of this process forgets them too (narrow merge, like
 * `binary-pins.ts`); a daemon in another process follows when it sees this file
 * change (`narrowLivePluginGrants`, TODO #663).
 */
export function forgetPluginHttpHosts(id: string, file: string): string[] {
  let cfg: Json;
  try { cfg = readJson(file); } catch { return []; }
  const asObject = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
  const policy = asObject(cfg.pluginPolicy);
  const http = asObject(policy.http);
  const byPlugin = asObject(http.byPlugin);
  let removed: string[] = [];
  if (Object.prototype.hasOwnProperty.call(byPlugin, id)) {
    const held: unknown = byPlugin[id];
    removed = Array.isArray(held) ? held.filter((h): h is string => typeof h === 'string') : [];
    delete byPlugin[id];
    cfg.pluginPolicy = { ...policy, http: { ...http, byPlugin } };
    writeJson(file, cfg);
  }
  if (file === CONFIG_FILE) {
    const live = config();
    if (Object.prototype.hasOwnProperty.call(live.pluginPolicy.http.byPlugin, id)) {
      const { [id]: _gone, ...rest } = live.pluginPolicy.http.byPlugin;
      setConfig({ ...live, pluginPolicy: { ...live.pluginPolicy, http: { ...live.pluginPolicy.http, byPlugin: rest } } });
    }
  }
  return removed;
}

/**
 * Drops the id from `pluginPolicy.spawn.approved` and `pluginPolicy.kanban.projects`
 * (TODO #663), and says what it held. Same reason as the hosts above: approving
 * an id to spawn is letting it spend the machine's AI subscriptions, and these
 * entries name the id, not the package. The file is written only if an entry
 * goes. The daemon, another process, follows on its own (`narrowLivePluginGrants`,
 * on the change of this very file). `spawn.denied` is left alone: the operator
 * refused the id, and a reinstall under it should still be refused.
 */
export function forgetPluginPolicyGrants(id: string, file: string): { spawn: boolean; projects: string[] } {
  let cfg: Json;
  try { cfg = readJson(file); } catch { return { spawn: false, projects: [] }; }
  const asObject = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
  const policy = asObject(cfg.pluginPolicy);
  const spawnSection = asObject(policy.spawn);
  const kanban = asObject(policy.kanban);
  const table = asObject(kanban.projects);
  const approved: unknown[] = Array.isArray(spawnSection.approved) ? spawnSection.approved : [];
  const spawn = approved.includes(id);
  const granted = Object.prototype.hasOwnProperty.call(table, id);
  const held: unknown = granted ? table[id] : [];
  if (spawn || granted) {
    const next: Json = { ...policy };
    if (spawn) next.spawn = { ...spawnSection, approved: approved.filter((entry) => entry !== id) };
    if (granted) {
      delete table[id];
      next.kanban = { ...kanban, projects: table };
    }
    cfg.pluginPolicy = next;
    writeJson(file, cfg);
  }
  if (file === CONFIG_FILE) narrowLivePluginGrants(file);
  return { spawn, projects: Array.isArray(held) ? held.filter((p): p is string => typeof p === 'string') : [] };
}

/**
 * Creates `~/.timon/plugins/` and its `package.json` if needed. `private: true`:
 * this tree is never published, and without this marker npm asks for a valid
 * version and name on every command.
 */
export function ensurePluginsRoot(root: string = PLUGINS_DIR): string {
  mkdirSync(root, { recursive: true });
  const file = join(root, 'package.json');
  if (!existsSync(file)) {
    writeJson(file, { name: 'timon-plugins', version: '0.0.0', private: true, dependencies: {} });
  }
  return root;
}

/** How a command reaches npm. Injectable so tests exercise the real add /
 *  remove logic — bundle expansion included — without a registry. */
export type NpmRunner = (args: string[], cwd: string) => Promise<void>;

const npm: NpmRunner = async (args, cwd) => {
  const r = await getHost().execAsync('npm', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  if (r.code !== 0) {
    throw new Error(`npm ${args.join(' ')} failed: ${r.stderr.trim() || `code ${r.code}`}`);
  }
};

/**
 * How `addPlugin` reads a registry release WITHOUT installing it (TODO #794):
 * the parsed `--json` answer of `npm view`, or `null` when npm could not say
 * (offline, a private registry, a spec it does not know). Read-only — no
 * tarball is unpacked and no script runs. Injectable, as `NpmRunner` is.
 */
export type NpmViewer = (spec: string, cwd: string) => Promise<unknown>;

/** `engines`, `main` and the manifest: what decides whether a release fits the daemon's Node. */
const VIEW_FIELDS = ['version', 'engines', 'main', BRAND.manifestKey];

const npmView: NpmViewer = async (spec, cwd) => {
  const r = await getHost().execAsync('npm', ['view', spec, ...VIEW_FIELDS, '--json'], {
    cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.code !== 0 || r.timedOut) return null;
  try {
    return JSON.parse(r.stdout) as unknown;
  } catch {
    return null;
  }
};

/** Third positional of `addPlugin` / `removePlugin`, all optional: the CLI
 *  keeps calling `addPlugin(spec)` and `removePlugin(pkg)` unchanged. */
export type InstallOptions = {
  npm?: NpmRunner;
  /** `npm view` unless a test injects its own (TODO #794). */
  view?: NpmViewer;
  /** `timon.config.json` to write provenance into. */
  config?: string;
  /** Admission keys; the embedded registry unless a test injects its own. */
  publicKeys?: readonly PluginPublicKey[];
  /** Plugins shipped with the product; the running layout unless a test injects its own. */
  builtins?: readonly ResolvedBuiltin[];
  /**
   * The Node the daemon runs plugins on. This process's own by default — the
   * daemon's when the gallery installs. The CLI runs on another Node and
   * passes the daemon's (TODO #763).
   */
  runtime?: NodeRuntimeFacts;
};

/**
 * A package whose `engines.node` excludes the daemon's Node: not installed,
 * or uninstalled at once when only npm could tell (TODO #763).
 */
export class PluginEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginEngineError';
  }
}

/** `timon plugin remove` on a plugin shipped with the product. */
export class BuiltinPluginError extends Error {
  constructor(readonly id: string) {
    super(`\`${id}\` is built into Timon and cannot be removed — disable it instead: timon plugin disable ${id}`);
    this.name = 'BuiltinPluginError';
  }
}

/** Manifest id of the built-in that `idOrPkg` names (id or npm name), if any. */
export function builtinNamed(idOrPkg: string, builtins: readonly ResolvedBuiltin[]): string | null {
  for (const b of builtins) {
    let id: string | null = null;
    try {
      const res = readManifest(JSON.parse(readFileSync(join(b.dir, 'package.json'), 'utf8')));
      if (res.ok) id = res.manifest.id;
    } catch { /* unreadable: still matched by its npm name below */ }
    if (b.pkg === idOrPkg || id === idOrPkg) return id ?? b.pkg;
  }
  return null;
}

/**
 * `--ignore-scripts` is a SECURITY flag, not a speed one (audit finding #5).
 *
 * Without it, a package's `preinstall`/`postinstall` runs as the operator, at
 * install time — that is, BEFORE anything verifies its Ed25519 signature,
 * which only happens when the daemon loads the plugin. The signature therefore
 * protected nothing on the path that matters: a hostile package never needed
 * to be loaded to run code, it only needed to be installed. With the flag, npm
 * puts inert files on disk and the first thing that ever executes is the host
 * half the loader imports — after admission.
 *
 * The cost is a plugin whose install script compiles a native addon; such a
 * package must ship its build instead. Nothing in the plugin contract (§10.4)
 * needs an install script.
 */
const NPM_FLAGS = ['--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'];

export type AddResult = {
  pkg: string;
  id: string;
  version: string;
  manifest: PluginManifest | null;
  /** Manifest refusal: the package is installed but will not be loaded. */
  refused: string | null;
  message: string | null;
  /** What a `kind: bundle` brought. Always empty for the others. */
  children: BundleChild[];
  /** Ed25519 admission, checked on the freshly installed files. */
  signature: AddSignature;
  /**
   * The signed release of the unsigned copy of the same npm name that held the
   * id: an update, its data, settings and grants kept (`keepsPluginData`).
   */
  updatesUnsigned: boolean;
  /**
   * `engines.node` excludes the CLI's Node, the only one known when no daemon
   * answered: said, not refused — the daemon's loader decides (TODO #763).
   */
  engineWarning?: string | null;
};

/**
 * What the signature check said about the package that was just installed.
 *
 * It is reported at INSTALL time — while nothing of the package has run yet,
 * thanks to `--ignore-scripts` — so the operator decides with the answer in
 * hand rather than discovering it in the daemon log. `unsigned` is reported,
 * not refused: the loader already refuses to mount it outside developer mode,
 * and refusing here too would make `timon plugin add ./my-plugin` impossible
 * during development. `tampered` IS a refusal: a broken signature is never a
 * work-in-progress, it is a package that does not match what was signed.
 */
export type AddSignature =
  | { ok: true; keyId: string }
  | { ok: false; code: 'unsigned' | 'tampered'; message: string };

/** One `contains` entry, and what became of it. */
export type BundleChild = {
  id: string;
  /** npm name of the package; `null` when the id could not be resolved. */
  pkg: string | null;
  /**
   * `installed`: brought by this bundle (marked `installedBy`, removed with it).
   * `kept`: already installed before — it survives the bundle's uninstallation.
   * `unresolved`: no package of the bundle declares this id; it is a packaging
   * error of the third party, not an outage, so it is reported, not thrown.
   */
  state: 'installed' | 'kept' | 'unresolved';
  message: string | null;
};

/**
 * `timon plugin add <spec>` — `<spec>` is what npm accepts: a registry
 * name, a `.tgz`, a local folder.
 *
 * The package is installed THEN its manifest is read: npm alone knows which name hides
 * behind `./examples/plugin-hello`, and one cannot validate what one does
 * not have yet. A refused manifest is therefore not an installation error
 * — it is a package present that the daemon will ignore, and the message says so.
 */
async function addPluginAdmitted(
  spec: string,
  root: string = PLUGINS_DIR,
  opts: InstallOptions = {},
): Promise<AddResult> {
  assertCompositionMutable(mutationLicenseState());
  const run = opts.npm ?? npm;
  const configFile = opts.config ?? CONFIG_FILE;
  const keys = opts.publicKeys ?? PLUGIN_PUBLIC_KEYS;
  const runtime = opts.runtime ?? currentNodeRuntime();
  // Only the daemon's own Node refuses. The CLI's, used when no daemon
  // answered, is an estimate: it warns, and the loader decides at load.
  const enforced = runtime.source === 'daemon';
  // A folder (or an extracted zip) is read BEFORE npm: refused there, it never
  // replaces a working release of the same package. A registry name or a
  // tarball can only be read once npm has fetched it (below).
  const sourceDir = localSpecDir(spec);
  const early = sourceDir ? engineProblemOfFolder(sourceDir, runtime) : null;
  if (early && enforced) throw new PluginEngineError(early);
  ensurePluginsRoot(root);
  const before = new Set(installedPackages(root));
  // What an update may have to put back: npm overwrites the release in place.
  const previous = previousReleases(root, before);
  // An update from the registry is read BEFORE npm too (TODO #794): refused
  // there, the release that worked is never replaced.
  const registryPkg = registryPackageName(spec);
  if (enforced && registryPkg && previous.has(registryPkg)) {
    // An injected npm is a registry of its own: the real one is never asked about its packages.
    const view = opts.view ?? (opts.npm ? async () => null : npmView);
    const refusal = registryEngineProblem(await view(spec, root), runtime);
    if (refusal) {
      throw new PluginEngineError(`${refusal} Nothing was installed: release ${previous.get(registryPkg)?.version ?? '?'} stays in place.`);
    }
  }
  const bound = boundPluginPackages();
  // npm runs with the plugins root as cwd: a relative path (`./examples/plugin-hello`) would be read
  // from THERE, not from where the user typed it. Resolve it against the caller's directory first.
  const npmSpec = LOCAL_SPEC.test(spec) ? resolve(spec.startsWith('file:') ? spec.slice('file:'.length) : spec) : spec;
  await run(['install', '--prefix', root, ...NPM_FLAGS, npmSpec], root);

  const added = installedPackages(root).filter((p) => !before.has(p));
  const found = discoverPlugins(root).filter((d) => added.includes(d.pkg));
  // npm may have reinstalled a package already declared (update, or a bundle
  // child taken over on its own account): in that case nothing is "added", and
  // the package named by the spec is what counts. A local spec does not
  // necessarily contain the npm name (`./examples/plugin-widget` ≠ `@timon-ai/plugin-widget`)
  // — it is then read from the `package.json` of the named folder.
  const named = packageNameOf(localSpecDir(spec));
  const d = found[0]
    ?? discoverPlugins(root).find((x) => (named ? x.pkg === named : spec.includes(x.pkg)));
  if (!d) throw new Error(`installed, but no new package detected in ${root} — check \`${spec}\``);

  if ('refusal' in d) {
    return { pkg: d.pkg, id: d.pkg, version: d.version, manifest: null, refused: `skipped:${d.refusal.code}`, message: d.refusal.message, children: [], signature: signatureOf(d.dir, keys), updatesUnsigned: false };
  }
  const signature = signatureOf(d.dir, keys);
  // Tampering stops here: the package is not expanded, and it is reported as
  // refused so the CLI exits non-zero. It stays on disk, inert, exactly like
  // any other refusal — removing files under someone's feet is not this
  // command's job, and the loader will not mount it either.
  if (!signature.ok && signature.code === 'tampered') {
    return { pkg: d.pkg, id: d.manifest.id, version: d.version, manifest: d.manifest, refused: 'skipped:tampered', message: signature.message, children: [], signature, updatesUnsigned: false };
  }
  // Fetched from the registry: npm alone could read `engines`. A package this
  // command just brought leaves again; one that replaced an installed release
  // stays inert on disk, refused, and the message says how to go back.
  const engine = engineRefusal(d, runtime);
  if (engine && enforced) {
    if (added.includes(d.pkg)) {
      await run(['uninstall', '--prefix', root, '--no-audit', '--no-fund', d.pkg], root);
      throw new PluginEngineError(engine);
    }
    // npm could not be asked first (a tarball, a git spec, the registry
    // unreachable): the release it replaced is put back.
    const prior = previous.get(d.pkg);
    if (prior && await restoreRelease(d.pkg, prior, root, run)) {
      throw new PluginEngineError(`${engine} Release ${prior.version}, installed before, was put back.`);
    }
    const back = prior ? `${d.pkg}@${prior.version}` : `${d.pkg}@<version>`;
    return { pkg: d.pkg, id: d.manifest.id, version: d.version, manifest: d.manifest, refused: 'skipped:node-engine', message: `${engine} It replaced the release installed before, which could not be put back: reinstall it (\`timon plugin add ${back}\`).`, children: [], signature, updatesUnsigned: false };
  }
  // Installing a plugin by hand makes it its own owner: if a
  // bundle had brought it, it will no longer leave with it.
  clearProvenance(d.manifest.id, configFile);
  const children = d.manifest.kind.includes('bundle')
    ? await expandBundle(d.dir, d.manifest, root, run, configFile, localSpecDir(spec), runtime)
    : [];
  const updatesUnsigned = signature.ok && signsUnsignedCopy(bound.get(d.manifest.id) ?? null, { pkg: d.pkg, trust: 'signed' });
  return { pkg: d.pkg, id: d.manifest.id, version: d.version, manifest: d.manifest, refused: null, message: null, children, signature, updatesUnsigned, engineWarning: enforced ? null : engine };
}

/**
 * `engines.node` of a folder about to be installed, against `runtime`: the
 * refusal message, or `null`. A folder that is not a plugin, or one with no
 * host half, is left to the checks that follow (the loader's own rule).
 */
function engineProblemOfFolder(dir: string, runtime: NodeRuntimeFacts): string | null {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as unknown;
  } catch {
    return null;
  }
  const res = readManifest(json);
  if (!res.ok || !hasHostHalf(dir, json, res.manifest)) return null;
  return nodeEngineProblem(json, res.manifest.id, runtime);
}

/** An installed release: its version, and the spec the plugins root recorded for it. */
type PriorRelease = { version: string; spec: string };

/** Installed version and recorded spec of each package of the plugins root. */
function previousReleases(root: string, installed: ReadonlySet<string>): Map<string, PriorRelease> {
  const deps = dependenciesOf(root);
  const out = new Map<string, PriorRelease>();
  for (const pkg of installed) {
    const spec = deps[pkg];
    const version = versionOf(join(root, 'node_modules', pkg));
    if (typeof spec === 'string' && version) out.set(pkg, { version, spec });
  }
  return out;
}

/** `version` of a package folder, `null` if it is unreadable. */
function versionOf(dir: string): string | null {
  try {
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof json.version === 'string' ? json.version : null;
  } catch { return null; }
}

/**
 * The npm name of a spec npm resolves against the registry (`name`,
 * `@scope/name`, either with `@version`, `@range` or `@tag`); `null` for a
 * path, a tarball, a URL, a git or an `npm:` alias spec — `npm view` cannot
 * read those without fetching them.
 */
export function registryPackageName(spec: string): string | null {
  if (LOCAL_SPEC.test(spec) || /\.(tgz|tar|tar\.gz)$/i.test(spec)) return null;
  const m = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:@([^/:]*))?$/i.exec(spec.trim());
  return m?.[1] ?? null;
}

/**
 * `engines.node` of the release(s) `npm view` describes, against `runtime`:
 * the refusal message when EVERY release the spec may resolve to is excluded,
 * otherwise `null`. Anything unclear lets npm go on — the check after the
 * install, and the restore behind it, still hold: an unreadable answer, a range
 * whose releases do not all agree (npm alone picks among them), a manifest
 * whose host half only the files can tell.
 */
export function registryEngineProblem(answer: unknown, runtime: NodeRuntimeFacts): string | null {
  const releases = Array.isArray(answer) ? answer : [answer];
  if (releases.length === 0) return null;
  let refusal: string | null = null;
  for (const release of releases) {
    const problem = releaseEngineProblem(release, runtime);
    if (!problem) return null;
    refusal = problem;
  }
  return refusal;
}

/** One release of an `npm view --json` answer: its refusal, or `null` (fits, or cannot tell). */
function releaseEngineProblem(release: unknown, runtime: NodeRuntimeFacts): string | null {
  if (typeof release !== 'object' || release === null || Array.isArray(release)) return null;
  const res = readManifest(release);
  if (!res.ok || res.manifest.backends !== undefined) return null;
  // `hasHostHalf` looks for `index.js` on disk when `main` is absent: only a
  // browser half then says nothing, so the registry answer cannot either.
  const main = (release as { main?: unknown }).main;
  if (!(typeof main === 'string' && main) && res.manifest.client !== undefined) return null;
  return nodeEngineProblem(release, res.manifest.id, runtime);
}

/**
 * Reinstalls the release an update replaced; `true` once it is back on disk.
 * A registry range is pinned to the exact version it had (the range alone
 * would bring the latest again); a local folder or tarball (`file:`) is taken
 * from where the plugins root recorded it. Anything else cannot be put back.
 */
async function restoreRelease(pkg: string, prior: PriorRelease, root: string, run: NpmRunner): Promise<boolean> {
  let spec: string | null = null;
  if (prior.spec.startsWith('file:')) {
    const path = resolve(root, prior.spec.slice('file:'.length));
    spec = existsSync(path) ? path : null;
  } else if (!/^([a-z+]+:|github:|[\w-]+\/[\w-]+)/i.test(prior.spec)) {
    spec = `${pkg}@${prior.version}`;
  }
  if (!spec) return false;
  try {
    await run(['install', '--prefix', root, ...NPM_FLAGS, spec], root);
  } catch {
    return false;
  }
  return versionOf(join(root, 'node_modules', pkg)) === prior.version;
}

/** Ed25519 admission of an installed directory, in `AddResult` shape. */
function signatureOf(dir: string, keys: readonly PluginPublicKey[] = PLUGIN_PUBLIC_KEYS): AddSignature {
  const res = verifyPluginDirectory(dir, keys);
  return res.ok ? { ok: true, keyId: res.signature.keyId } : { ok: false, code: res.code, message: res.message };
}

/** npm name declared by a package folder, `null` if it is unreadable. */
function packageNameOf(dir: string | null): string | null {
  if (!dir) return null;
  try {
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
    return json.name ?? null;
  } catch { return null; }
}

/** `dependencies` of a `package.json`, or nothing if it is unreadable. */
function dependenciesOf(dir: string): Record<string, string> {
  try {
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    return json.dependencies ?? {};
  } catch { return {}; }
}

/**
 * Where npm put a dependency of the bundle: in its own `node_modules`, or
 * hoisted to the root of the tree. This folder is only read to LEARN
 * which id a package declares — never to install it from there (installing a
 * `node_modules` folder onto itself is destructive).
 */
function locateDependency(root: string, bundleDir: string, name: string): string | null {
  for (const dir of [join(bundleDir, 'node_modules', name), join(root, 'node_modules', name)]) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return null;
}

const LOCAL_SPEC = /^(file:|\.{1,2}\/|\/)/;

/** Directory named by a `file:` / relative / absolute spec, if it is a package. */
function localDepDir(base: string, spec: string): string | null {
  if (!LOCAL_SPEC.test(spec)) return null;
  const dir = resolve(base, spec.startsWith('file:') ? spec.slice('file:'.length) : spec);
  return existsSync(join(dir, 'package.json')) ? dir : null;
}

/** Source folder of a local `spec` (`./examples/plugin-bundle`), otherwise `null`
 *  — a registry name or a tarball has no source folder. */
function localSpecDir(spec: string): string | null {
  if (!LOCAL_SPEC.test(spec)) return null;
  const dir = resolve(spec.startsWith('file:') ? spec.slice('file:'.length) : spec);
  return existsSync(join(dir, 'package.json')) ? dir : null;
}

/**
 * Reusable npm specifier to install a child ON ITS OWN, from
 * what the bundle declared.
 *
 * A local path is resolved against the bundle's SOURCE folder — the one the
 * command named, or, failing that, the real folder of the installed copy (npm
 * links the `file:` dependencies through a symbolic link, so `realpath` leads back to the
 * original package). Resolving it against the `node_modules` copy would end up
 * installing a folder onto itself: npm erases it before copying it again.
 */
function childSpec(name: string, spec: string, base: string): string {
  if (LOCAL_SPEC.test(spec)) {
    return resolve(base, spec.startsWith('file:') ? spec.slice('file:'.length) : spec);
  }
  // URL, git, tarball, `npm:` alias: npm already knows how to read them alone.
  if (/^([a-z+]+:|github:|[\w-]+\/[\w-]+#?)/.test(spec) && !/^[\^~><=\d*]/.test(spec)) return spec;
  return `${name}@${spec}`;
}

/**
 * `kind: bundle` — installs and enables each id of `contains` that is missing
 * (plan §10.12).
 *
 * The children are the bundle's npm `dependencies`: npm has therefore already
 * put them on disk, which allows reading their manifest and knowing
 * which one carries which id. Each is then installed **for itself**, at the
 * first level of the tree — that is what makes it a plugin in its own right,
 * switched off, moved and removed independently.
 *
 * A single level: a bundle named in another's `contains` is installed
 * but not unfolded. Without this limit, two bundles citing each other would loop.
 */
async function expandBundle(
  bundleDir: string,
  bundle: PluginManifest,
  root: string,
  run: NpmRunner,
  configFile: string,
  sourceDir: string | null,
  runtime: NodeRuntimeFacts,
): Promise<BundleChild[]> {
  let base = sourceDir ?? bundleDir;
  if (!sourceDir) {
    try { base = realpathSync(bundleDir); } catch { /* not a link: the folder is enough */ }
  }
  const present = new Map<string, string>();
  for (const d of discoverPlugins(root)) {
    if (!('refusal' in d)) present.set(d.manifest.id, d.pkg);
  }

  // declared id → package carrying it, learnt on disk after the bundle's
  // installation (a registry package's manifest is not readable before).
  const provided = new Map<string, { pkg: string; spec: string; bundle: boolean; engine: string | null }>();
  for (const [name, range] of Object.entries(dependenciesOf(bundleDir))) {
    // npm install of a local `file:` bundle does NOT hoist that bundle's own
    // `file:` dependencies into the prefix (what just happened on
    // `./examples/plugin-bundle`). Fall back to the path declared in the
    // bundle's package.json, resolved against the source directory — that is
    // also the spec we then install at the first level.
    const dir = locateDependency(root, bundleDir, name)
      ?? localDepDir(base, range);
    if (!dir) continue;
    let json: unknown;
    try { json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { continue; }
    const res = readManifest(json);
    if (!res.ok) continue;
    const engine = hasHostHalf(dir, json, res.manifest) ? nodeEngineProblem(json, res.manifest.id, runtime) : null;
    provided.set(res.manifest.id, { pkg: name, spec: childSpec(name, range, base), bundle: res.manifest.kind.includes('bundle'), engine });
  }

  const out: BundleChild[] = [];
  for (const id of bundle.contains) {
    if (id === bundle.id) {
      out.push({ id, pkg: null, state: 'unresolved', message: `\`contains\` names the bundle itself — ignored` });
      continue;
    }
    const already = present.get(id);
    if (already) {
      out.push({ id, pkg: already, state: 'kept', message: null });
      continue;
    }
    const child = provided.get(id);
    if (!child) {
      out.push({ id, pkg: null, state: 'unresolved', message: `no dependency of \`${bundle.id}\` declares the id \`${id}\`` });
      continue;
    }
    // Guard: installing a `node_modules` folder onto itself would
    // destroy it (npm erases the target before copying again). That only happens if
    // the bundle's source path cannot be found — better to say so.
    if (child.spec.startsWith(join(root, 'node_modules'))) {
      out.push({ id, pkg: child.pkg, state: 'unresolved', message: `source path of \`${bundle.id}\` not found — reinstall the bundle from its original folder` });
      continue;
    }
    await run(['install', '--prefix', root, ...NPM_FLAGS, child.spec], root);
    markInstalledBy(id, bundle.id, configFile);
    present.set(id, child.pkg);
    out.push({
      id,
      pkg: child.pkg,
      state: 'installed',
      // Installed all the same: it is part of the bundle, and loads on a runtime that fits (TODO #794).
      message: child.engine
        ? (runtime.source === 'daemon' ? `installed, but NOT loaded: ${child.engine}` : `warning: ${child.engine}`)
        : child.bundle ? 'nested bundle: installed, but its own `contains` is not unfolded' : null,
    });
  }
  return out;
}

/** Resolves a manifest id (or an npm name) to the installed package name. */
export function resolvePackage(idOrPkg: string, root: string = PLUGINS_DIR): string | null {
  for (const d of discoverPlugins(root)) {
    if (d.pkg === idOrPkg) return d.pkg;
    if (!('refusal' in d) && d.manifest.id === idOrPkg) return d.pkg;
  }
  return null;
}

export type RemoveResult = {
  pkg: string;
  /** Ids of the children removed with the bundle (`installedBy`). */
  children: string[];
  /** Agents this plugin created (`ctx.agents.create`). Left in place: they
   *  belong to the user now, and only the user deletes them. */
  agents: string[];
  /** Routines and triggers this plugin owned, now switched off (the rows stay),
   *  and the pipelines it defined. See `automation-cleanup.ts`. */
  automations: PluginAutomations;
  /** `<plugin id>/<name>` of every webhook secret deleted with it, bundle children included. */
  webhooks: string[];
  /** `<plugin id>/<host>` of every host its `pluginPolicy.http.byPlugin` entry opened, now closed. */
  httpHosts: string[];
  /** `<plugin id>/<secret name>` of every vault entry granted to it (`agent:plugin:<id>`), grant now withdrawn. */
  secretGrants: string[];
  /** Ids whose `pluginPolicy.spawn.approved` entry was withdrawn: the plugin and the children it took. */
  spawnApprovals: string[];
  /** `<plugin id>/<project>` of every `pluginPolicy.kanban.projects` grant withdrawn. */
  kanbanProjects: string[];
  /** `<plugin id>/<connection id>` of every user connection sent back to approval, its keys deleted. */
  connections: string[];
  /** `<plugin id>: <reason>` when its connections could not be reached: they may still be approved. */
  connectionsFailed: string[];
};

/** `timon plugin remove <id>`. The data folder and the `plugin_kv` keys
 *  SURVIVE: reinstalling a plugin finds its settings again, and an uninstallation
 *  must not destroy data without anyone having asked for it.
 *
 *  Except its webhooks' secrets (TODO #529): a package republished under the
 *  same id, by another author included, would otherwise receive the calls signed for
 *  the old one, on behalf of the account that had generated the secret. Nor the vault's
 *  `agent:plugin:<id>` grants (TODO #659): they name the id, not the package,
 *  and would otherwise read those secrets for the first comer who republishes that id. Nor its
 *  "global secret only" cards (TODO #661): their Grant button would grant the
 *  secret to the id, hence to the next package published under that id. Nor its per-id
 *  approvals of `pluginPolicy` and the cards that ask for them (TODO #663), for the
 *  same reason. Nor its users' connections (TODO #664): they go back
 *  to pending, without their keys, because `ctx.fetch` opens their origins to whoever
 *  carries that id. Its settings (`secret` included), its `plugin_kv` and its data
 *  folder stay for the reinstallation of the same package: they leave if another
 *  package takes the id, the folder going to the trash (`package-binding.ts`,
 *  TODO #675, #677).
 *
 *  From a bundle, the children IT brought leave too — those whose
 *  config carries its `installedBy`. A child installed before it, or reinstalled
 *  by hand since, stays. The manifest is read BEFORE the `npm uninstall`: the
 *  package disappears from the disk with it, and with it the `contains` list. */
async function removePluginAdmitted(
  idOrPkg: string,
  root: string = PLUGINS_DIR,
  opts: InstallOptions = {},
): Promise<RemoveResult> {
  assertCompositionMutable(mutationLicenseState());
  const run = opts.npm ?? npm;
  const configFile = opts.config ?? CONFIG_FILE;
  const pkg = resolvePackage(idOrPkg, root);
  // A user copy of a built-in is removable (the daemon already ignores it);
  // the built-in itself is not — the installer owns its files.
  if (!pkg) {
    const builtin = builtinNamed(idOrPkg, opts.builtins ?? resolveBuiltins());
    if (builtin) throw new BuiltinPluginError(builtin);
    throw new Error(`plugin \`${idOrPkg}\` not found in ${root}`);
  }

  const found = discoverPlugins(root).find((d) => d.pkg === pkg);
  const manifest = found && !('refusal' in found) ? found.manifest : null;

  const children: string[] = [];
  const webhooks: string[] = [];
  const forgetWebhooks = (id: string) => { for (const name of purgePluginWebhookSecrets(id)) webhooks.push(`${id}/${name}`); };
  const httpHosts: string[] = [];
  const forgetHosts = (id: string) => { for (const host of forgetPluginHttpHosts(id, configFile)) httpHosts.push(`${id}/${host}`); };
  const secretGrants: string[] = [];
  const forgetGrants = (id: string) => { for (const name of revokePluginSecretGrants(id)) secretGrants.push(`${id}/${name}`); };
  const spawnApprovals: string[] = [];
  const kanbanProjects: string[] = [];
  const forgetPolicy = async (id: string) => {
    const { spawn, projects } = forgetPluginPolicyGrants(id, configFile);
    if (spawn) spawnApprovals.push(id);
    for (const project of projects) kanbanProjects.push(`${id}/${project}`);
    await closePluginSpawnCards(id);
    await closePluginLaunchCard(id);
  };
  const connections: string[] = [];
  const connectionsFailed: string[] = [];
  const forgetConnections = (id: string) => {
    try {
      // A user copy of a built-in: the built-in keeps serving these connections,
      // and no other package can load under its id.
      if (builtinNamed(id, opts.builtins ?? resolveBuiltins())) return;
      for (const connection of withdrawPluginUserConnections(id)) connections.push(`${id}/${connection}`);
    } catch (error) {
      // The package has already left: throwing would lose the rest of this cleanup,
      // and `remove` could not be run again, since it no longer finds the plugin.
      connectionsFailed.push(`${id}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };
  if (manifest?.kind.includes('bundle')) {
    for (const id of manifest.contains) {
      if (pluginProvenance(id, configFile) !== manifest.id) continue;
      const childPkg = resolvePackage(id, root);
      if (childPkg) await run(['uninstall', '--prefix', root, '--no-audit', '--no-fund', childPkg], root);
      // The config entry is removed because the bundle is the one that had
      // written it: leaving it would outlive what it describes.
      forgetPlugin(id, configFile);
      forgetWebhooks(id);
      forgetHosts(id);
      forgetGrants(id);
      forgetConnections(id);
      await closePluginSecretCards(id);
      await forgetPolicy(id);
      children.push(id);
    }
  }

  await run(['uninstall', '--prefix', root, '--no-audit', '--no-fund', pkg], root);
  if (manifest) {
    forgetWebhooks(manifest.id);
    forgetHosts(manifest.id);
    forgetGrants(manifest.id);
    forgetConnections(manifest.id);
    await closePluginSecretCards(manifest.id);
    await forgetPolicy(manifest.id);
  }
  return {
    pkg, children, webhooks, httpHosts, secretGrants, spawnApprovals, kanbanProjects, connections, connectionsFailed,
    agents: manifest ? agentsCreatedBy(pluginAgentOrigin(manifest.id)) : [],
    automations: manifest ? disablePluginAutomations(manifest.id) : { routines: [], triggers: [], pipelines: [] },
  };
}

/**
 * `timon plugin enable|disable <id>` — writes `plugins[<id>]` into
 * `timon.config.json`.
 *
 * An object value is KEPT: its other keys are the options the
 * plugin receives in `apply`, and losing them by disabling it for five seconds
 * would amount to resetting its configuration at every toggle.
 */
export function setPluginEnabled(
  id: string,
  enabled: boolean,
  file: string = CONFIG_FILE,
  builtins: readonly ResolvedBuiltin[] = resolveBuiltins(),
): void {
  // A built-in is part of the product, not of the composition a licence
  // fixes: it can be switched off (and back on) even under Free (the maintainer,
  // 26/09/2026). Installing or removing anything stays locked.
  if (!builtinNamed(id, builtins)) assertCompositionMutable(mutationLicenseState());
  const cfg = readJson(file);
  const plugins = (typeof cfg.plugins === 'object' && cfg.plugins !== null && !Array.isArray(cfg.plugins))
    ? (cfg.plugins as Json)
    : {};
  const current = plugins[id];
  if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
    (current as Json).enabled = enabled;
  } else {
    plugins[id] = enabled;
  }
  cfg.plugins = plugins;
  writeJson(file, cfg);
}

/**
 * Developer mode as the Settings switch shows it. `requested` is the wish the
 * config holds, `effective` what the loader applies right now: a fixed
 * composition can refuse a wish, and the switch must not show "on" for code
 * that will not load. `available` says whether turning it on would take
 * effect, so the switch is greyed out before a click rather than after. Both
 * go through `unsignedPluginsAllowed`, never a copy of its licence rule.
 *
 * `blockedBy` has a single reason because the rule has a single refusal in
 * practice: every state without rights in force that the daemon produces is
 * either the local Free tier (admitted) or the locked beta state (a fixed
 * composition), and a valid licence is refused only when its composition is
 * fixed. `developer-routes.test.ts` pins that invariant on the real producers;
 * a new state that breaks it must add its own reason here and in the switch.
 */
export type DeveloperModeState = {
  requested: boolean;
  effective: boolean;
  available: boolean;
  blockedBy: 'plugin_composition_fixed' | null;
};

export function developerModeState(): DeveloperModeState {
  const setting = config().developer.unsignedPlugins;
  const available = unsignedPluginsAllowed(true);
  return {
    requested: setting === true,
    effective: unsignedPluginsAllowed(setting),
    available,
    // Named after the rule's answer, never ahead of it: should the rule one day
    // admit a fixed composition, the switch opens with it.
    blockedBy: !available && fixedComposition(mutationLicenseState()) ? 'plugin_composition_fixed' : null,
  };
}

/**
 * Writes `developer.unsignedPlugins` and makes the live config follow (narrow
 * merge, like `forgetPluginHttpHosts`): `config()` is memoized for the process,
 * and the loader's `allowUnsigned` reads it on every pass. Without the merge the
 * next `loader.update()` would still judge with the boot's value.
 *
 * Turning it off only narrows what loads, so it is allowed under any licence.
 * Turning it on is refused with `plugin_composition_fixed` when the admission
 * rule shuts a fixed composition out, the only refusal it has today; should
 * another appear, the wish is kept and `developerModeState` reports it as not
 * effective.
 * `false` is written, not deleted: an explicit refusal, whatever default the
 * key registry would resolve.
 */
export function setUnsignedPluginsSetting(enabled: boolean, file: string = CONFIG_FILE): void {
  if (enabled && !unsignedPluginsAllowed(true) && fixedComposition(mutationLicenseState())) {
    throw new LicenseCapabilityError('plugin_composition_fixed',
      'This licence includes a fixed plugin composition: developer mode cannot be turned on.');
  }
  const cfg = readJson(file);
  const developer = (typeof cfg.developer === 'object' && cfg.developer !== null && !Array.isArray(cfg.developer))
    ? (cfg.developer as Json)
    : {};
  cfg.developer = { ...developer, unsignedPlugins: enabled };
  writeJson(file, cfg);
  if (file === CONFIG_FILE) {
    const live = config();
    setConfig({ ...live, developer: { ...live.developer, unsignedPlugins: enabled } });
  }
}

/** Offline inventory: what is installed, and what the config says about it. */
export function inventory(
  root: string = PLUGINS_DIR,
  file: string = CONFIG_FILE,
  builtins: readonly ResolvedBuiltin[] = resolveBuiltins(),
  runtime: NodeRuntimeFacts = currentNodeRuntime(),
  whiteLabel: () => boolean = storedWhiteLabel,
): InventoryEntry[] {
  let plugins: Json = {};
  try {
    const cfg = readJson(file);
    if (typeof cfg.plugins === 'object' && cfg.plugins !== null) plugins = cfg.plugins as Json;
  } catch { /* config illisible : le daemon le dira, l'inventaire reste utile */ }

  // Same reading as `settingOf` (loader.ts): a built-in shipped off needs an explicit `true`.
  const wanted = (id: string, offByDefault: boolean): boolean => {
    const v = plugins[id];
    if (v === undefined || v === 'auto') return !offByDefault;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'object' && v !== null) return offByDefault ? (v as Json).enabled === true : (v as Json).enabled !== false;
    return !offByDefault;
  };

  return discoverPlugins(root, builtins).map((d): InventoryEntry => {
    const builtin = d.builtin && !('refusal' in d && d.refusal.code === 'duplicate-id') ? { builtin: true as const } : {};
    if ('refusal' in d) {
      return { id: d.pkg, pkg: d.pkg, version: d.version, enabled: false, refused: `skipped:${d.refusal.code}`, message: d.refusal.message, permissions: [], ...builtin };
    }
    // What the daemon's loader refuses at load, said the same way (TODO #763).
    const engine = engineRefusal(d, runtime);
    if (engine) return { id: d.manifest.id, pkg: d.pkg, version: d.version, enabled: false, refused: 'skipped:node-engine', message: engine, permissions: d.manifest.permissions, ...builtin };
    // The loader refuses it before any other licence check: said here too, or
    // the list would call active a layout the interface never shows. Read
    // only when a package asks for `root`, so a plain list reads no licence.
    if (!d.builtin && heldForWhiteLabel(d.manifest, whiteLabel)) {
      return { id: d.manifest.id, pkg: d.pkg, version: d.version, enabled: wanted(d.manifest.id, d.offByDefault === true), refused: 'skipped:unlicensed', message: whiteLabelRefusal(d.manifest.id), permissions: d.manifest.permissions };
    }
    return {
      id: d.manifest.id, pkg: d.pkg, version: d.version, enabled: wanted(d.manifest.id, d.offByDefault === true), refused: null,
      // No trust verdict here: the CLI does not boot through the release
      // verification, so only the daemon's loader can judge a built-in.
      message: null,
      permissions: d.manifest.permissions, ...builtin,
    };
  });
}

/**
 * The White Label right as the daemon's boot reads it: the stored licence,
 * offline tolerance included. A CLI has no live state, and a token on disk
 * older than its lifetime is still the licence in force while the daemon
 * tolerates the server being out of reach.
 */
function storedWhiteLabel(): boolean {
  return whiteLabelAllowed(applyBuildPolicy(bootLicenseState()));
}

/**
 * Installed, but held back until the licence includes White Label. Not a
 * `refused` install: the person still confirms its permissions, since it
 * loads on its own the day the right arrives.
 */
export function heldForWhiteLabel(manifest: Pick<PluginManifest, 'kind' | 'client'>, whiteLabel: () => boolean = storedWhiteLabel): boolean {
  return requestsRoot(manifest) && !whiteLabel();
}

export function addPlugin(spec: string, root: string = PLUGINS_DIR, opts: InstallOptions = {}): Promise<AddResult> {
  return withCompositionWrite(mutationLicenseState(), () => addPluginAdmitted(spec, root, opts));
}

export function removePlugin(idOrPkg: string, root: string = PLUGINS_DIR, opts: InstallOptions = {}): Promise<RemoveResult> {
  return withCompositionWrite(mutationLicenseState(), () => removePluginAdmitted(idOrPkg, root, opts));
}
