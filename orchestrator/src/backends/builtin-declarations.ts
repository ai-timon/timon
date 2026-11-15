/**
 * What the product's OWN providers declare about themselves, as data
 * (`docs/PROVIDERS-SDK.md` § 4, volets 5b and 7).
 *
 * The core used to name each provider where it needed one: the npm package of a
 * CLI, the folders its installer writes to, the folder its sign-in lives in, the
 * model tiers, the order of the automatic fallback. Those declarations now live in
 * the manifest of the official provider plugin that brings each backend
 * (`timon.provider.backends` of its `package.json`), in the vocabulary a provider
 * plugin writes (C1 to C5) plus the fields only the product reads (setup card,
 * sign-in hint, logo fragments, standalone installer…). The core reads them the
 * same way whoever shipped the provider: `profileDeclarations(id)` answers from the
 * registered provider first, from these declarations second.
 *
 * Why the manifest and not the plugin's code: the doctor, the binary search, the
 * mission isolation and the onboarding need them BEFORE the plugin loader runs (and
 * for a provider plugin switched off), and a manifest can be read synchronously
 * without running anything. Only the built-in plugins the release vouches for are
 * read (`plugins/builtin.ts`): a field here can run an installer or spare a folder.
 *
 * Keyed by BACKEND id, not by dialect: `opencode` and `hermes` share the ACP
 * runtime and have nothing else in common, `kimi` and `ollama-cloud` ride on
 * `claude` and `codex` with a sign-in folder of their own.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BUILTIN_DIR, orchestratorRoot, readBuiltinList, resolveBuiltins, verifiedRelease } from '../plugins/builtin.js';
import { otherBackendHomeDirProblem, setBackendHomeDirsSource } from './credential-home-dirs.js';
import { binaryProblems, credentialDirProblem } from './provider-declarations.js';
import type { ProviderBinaryDeclaration, ProviderDeclarations, ProviderDesktopBuild } from './provider-declarations.js';

/**
 * A build shipped by a desktop app. The product's own declarations can narrow which
 * folders count as a build (`folderPattern`, a case-insensitive regular
 * expression over the folder name): the Codex app names them by a hexadecimal
 * fingerprint and the winget package of Copilot by `GitHub.Copilot_<source>`.
 * Not part of the public vocabulary, so a plugin's own value is never read.
 */
export type BuiltinDesktopBuild = ProviderDesktopBuild & { readonly folderPattern?: string };

export type BuiltinBinaryDeclaration = Omit<ProviderBinaryDeclaration, 'desktopBuilds'> & {
  readonly desktopBuilds?: readonly BuiltinDesktopBuild[];
  /**
   * The vendor's own standalone installer, as its documentation gives it (step 3
   * of the onboarding and Settings › AI models install the AI CLIs with it). Not
   * npm, unlike `install`: a desktop-only machine has no Node, and the standalone
   * builds need none. A side the vendor does not document is left out: that OS
   * gets the link to the vendor's page instead of a line we would have made up.
   */
  readonly standaloneInstaller?: { readonly label: string; readonly posix?: string; readonly windows?: string };
};

/**
 * Where the newest published version of a CLI is read, to offer "Update
 * available". Answered by the vendor's own channel: the npm registry for a CLI
 * published there, or a plain-text endpoint that holds only the version.
 */
export type CliLatestSource = { readonly npm: string } | { readonly text: string };

export type BuiltinDeclarations = Omit<ProviderDeclarations, 'binary'> & {
  readonly binary?: BuiltinBinaryDeclaration;
  /**
   * What a person types to sign in to the CLI, as the vendor gives it (`claude`, `codex login`),
   * for the onboarding to show after the install: the program name is replaced by the path the
   * daemon resolved, since a terminal opened before the install does not have the new PATH.
   */
  readonly signInCommand?: string;
  /** What to do once that command runs, when the CLI does not sign in by itself (`/login` inside `claude`). */
  readonly signInThen?: string;
  /**
   * Variables the sign-in command runs with, by POSIX system: written in front of it (`NAME=value cmd`),
   * so that the CLI saves its sign-in where the missions Timon starts will read it (`agy` keeps it in its
   * own file rather than the Linux keychain, which the mission fence cannot reach). Values are plain words
   * a shell reads as written; Windows has no such form and takes none.
   */
  readonly signInEnv?: SignInEnv;
  /**
   * A fresh install seeds its main agent on this provider when its CLI runs on the host, in the order
   * of this table. A product decision, not a capability: the providers whose model list comes from
   * the agent itself (the ACP ones) are not offered to someone who has not chosen yet.
   */
  readonly seedsMainAgent?: true;
  /**
   * How the first-run screen shows the CLI: a short name and its place among the cards. `suggested` is
   * the one offered when none is installed (the one Timon can install unattended).
   */
  readonly setupCard?: { readonly label: string; readonly order: number; readonly suggested?: true };
  /**
   * The model-name fragments the UI recognises this provider's models by, for the logo of a model
   * listed by an aggregator (a `kimi-…` served under another sign): first fragment found, in the order
   * of this table. The provider's own `brand` is the house; these name the product. Served with the
   * catalogue whether or not the provider is active: a model of `kimi` listed by another provider keeps
   * its logo on a machine where `kimi` has no key.
   */
  readonly modelBrands?: ReadonlyArray<{ readonly match: string; readonly brand: string }>;
  /**
   * The dialect of this key honours `BuildSpawnOpts.readOnlyTools`: its launch then runs no shell
   * and writes no file (`docs/SECURITY.md` § 6.2.3). Read by DIALECT id, for a trusted
   * registration only: a mission that needs it on any other backend is refused rather than run
   * unconfined. A security claim the product makes for its own code, so never a plugin's.
   */
  readonly readOnlyTools?: true;
  /** The vendor's installation page: what the onboarding links to when it cannot run an installer here. */
  readonly installDocs?: string;
  /**
   * Where the newest version is read (the provider cards of the onboarding and of Settings); the
   * installed one comes from `<binary> --version`. Absent: no check. An ACP adapter (`pi-acp`,
   * `hermes-acp`) is a stdio server that may start instead of answering `--version`, so those
   * providers declare none. `supportedMajor`: the newest major version the product drives and its
   * installer installs; an installed one above it is another generation of the same binary, which
   * neither Install nor Update may overwrite.
   */
  readonly updateCheck?: { readonly latest: CliLatestSource; readonly supportedMajor?: number };
  /**
   * The providers reached with an API key rather than a CLI of their own, through THIS backend's
   * CLI: the first-run screen names them under it. Informational only.
   */
  readonly apiKeyProviders?: ReadonlyArray<{ readonly id: string; readonly label: string; readonly brand: string }>;
};

/** `BuiltinDeclarations.signInEnv`: the variables of the sign-in command, for the systems whose shell reads `NAME=value cmd`. */
export type SignInEnv = Readonly<Partial<Record<'linux' | 'darwin', Readonly<Record<string, string>>>>>;

/**
 * The sign-in line a person runs on `platform`: the declared variables of that system, then the command.
 * The schema already refused a name or a value a shell would read otherwise.
 */
export function signInLine(command: string, env: SignInEnv | undefined, platform: NodeJS.Platform): string {
  const vars = platform === 'linux' || platform === 'darwin' ? env?.[platform] : undefined;
  const prefix = Object.entries(vars ?? {}).map(([name, value]) => `${name}=${value} `).join('');
  return `${prefix}${command}`;
}

/** One entry of `timon.provider.backends`: a backend id of the product and what it declares. */
export type ProductBackend = BuiltinDeclarations & {
  readonly id: string;
  /** Where the product lists it among its own backends (catalogue, doctor, seeding), lowest first. */
  readonly rank: number;
};

const LABEL = z.string().min(1).max(80);
const COMMAND = z.string().min(1).max(500);
/** A vendor page or channel: the onboarding links to it or fetches it, so never anything but https. */
const HTTPS_URL = z.string().max(300).url().refine((value) => value.startsWith('https://'), 'expected an https:// URL');
/** A variable of the sign-in command: an upper-case name, a value a POSIX shell reads as written (no quote, space or `$`). */
const SIGN_IN_VARS = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/, 'invalid variable name'), z.string().max(200).regex(/^[A-Za-z0-9_.,:/@%+=-]*$/, 'a value a shell would not read as written'))
  .refine((vars) => Object.keys(vars).length <= 8, 'at most 8 variables');
const NPM_PACKAGE = z.string().regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, 'invalid npm package name').max(214);

/** The fields only the product reads; the public ones (`binary`, `credentialDirs`) are checked like a plugin's. */
const ProductBackendSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'invalid backend id (expected a slug: `grok`)'),
  rank: z.number().int().min(0).max(10_000),
  binary: z.unknown().optional(),
  credentialDirs: z.array(z.string()).max(4).optional(),
  signInCommand: COMMAND.optional(),
  signInThen: COMMAND.optional(),
  signInEnv: z.object({ linux: SIGN_IN_VARS.optional(), darwin: SIGN_IN_VARS.optional() }).strict().optional(),
  seedsMainAgent: z.literal(true).optional(),
  setupCard: z.object({ label: LABEL, order: z.number().int(), suggested: z.literal(true).optional() }).strict().optional(),
  modelBrands: z.array(z.object({ match: LABEL, brand: LABEL }).strict()).max(16).optional(),
  readOnlyTools: z.literal(true).optional(),
  installDocs: HTTPS_URL.optional(),
  updateCheck: z.object({
    latest: z.union([z.object({ npm: NPM_PACKAGE }).strict(), z.object({ text: HTTPS_URL }).strict()]),
    supportedMajor: z.number().int().min(0).max(10_000).optional(),
  }).strict().optional(),
  apiKeyProviders: z.array(z.object({ id: LABEL, label: LABEL, brand: LABEL }).strict()).max(8).optional(),
}).strict();

/** The product's narrowings of a binary declaration: a standalone installer, the folders that count as a desktop build. */
const ProductBinaryExtrasSchema = z.object({
  standaloneInstaller: z.object({ label: LABEL, posix: COMMAND.optional(), windows: COMMAND.optional() }).strict()
    .refine(({ posix, windows }) => posix !== undefined || windows !== undefined, 'names an installer for at least one OS').optional(),
  desktopBuilds: z.array(z.object({ folderPattern: z.string().min(1).max(200).optional() })).optional(),
});

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function patternProblem(pattern: string): string | null {
  try {
    new RegExp(pattern, 'i');
    return null;
  } catch {
    return `\`${pattern}\` is not a regular expression`;
  }
}

/** What is wrong with one entry of `timon.provider.backends`, as sentences; none means it is usable. */
export function productBackendProblems(raw: unknown): string[] {
  const parsed = ProductBackendSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join('.') || 'entry'}: ${issue.message}`);
  const { id, binary, credentialDirs } = parsed.data;
  const problems: string[] = [];
  if (binary !== undefined) {
    problems.push(...binaryProblems(binary));
    const extras = ProductBinaryExtrasSchema.safeParse(binary);
    if (!extras.success) problems.push(...extras.error.issues.map((issue) => `binary.${issue.path.join('.')}: ${issue.message}`));
    else for (const build of extras.data.desktopBuilds ?? []) {
      const why = build.folderPattern === undefined ? null : patternProblem(build.folderPattern);
      if (why) problems.push(`binary.desktopBuilds: ${why}`);
    }
  }
  for (const dir of credentialDirs ?? []) {
    const why = credentialDirProblem(dir, id);
    if (why) problems.push(`credentialDirs: ${why}`);
  }
  return problems;
}

/**
 * What is wrong with the `backends` of a manifest's `provider` block: each entry on its own, and against
 * the block — a binary or a folder the operator was not shown (`binaries`, `credentialDirs`) is not one
 * a backend may declare, and an id appears once.
 */
export function providerBackendsProblems(provider: {
  readonly binaries?: ReadonlyArray<{ readonly name: string; readonly aliases?: readonly string[] }>;
  readonly credentialDirs?: readonly string[];
  readonly backends?: unknown;
}): string[] {
  if (provider.backends === undefined) return [];
  if (!Array.isArray(provider.backends)) return ['`backends` must be a list'];
  if (provider.backends.length > 8) return ['`backends` lists at most 8 entries'];
  const shown = new Set((provider.binaries ?? []).flatMap(({ name, aliases }) => [name, ...(aliases ?? [])]));
  const dirs = new Set(provider.credentialDirs ?? []);
  const seen = new Set<string>();
  return provider.backends.flatMap((raw, index): string[] => {
    const problems = productBackendProblems(raw).map((problem) => `backends[${index}].${problem}`);
    if (problems.length > 0 || !isRecord(raw)) return problems;
    const entry = raw as ProductBackend;
    if (seen.has(entry.id)) problems.push(`backends[${index}]: \`${entry.id}\` is listed twice`);
    seen.add(entry.id);
    for (const name of entry.binary?.names ?? []) {
      if (!shown.has(name)) problems.push(`backends[${index}].binary: \`${name}\` is not among the manifest's \`provider.binaries\``);
    }
    for (const dir of entry.credentialDirs ?? []) {
      if (!dirs.has(dir)) problems.push(`backends[${index}].credentialDirs: \`${dir}\` is not among the manifest's \`provider.credentialDirs\``);
    }
    return problems;
  });
}

/**
 * The folders of the built-in plugins whose manifest the product believes. In the daemon, the ones the
 * signed release vouches for (or, from a source checkout, the ones inside it). A process that did not
 * start through the verified boot — the `timon` CLI of an installed build — runs the installed files
 * unverified anyway: their manifests are exactly as trustworthy as the code that reads them.
 */
function trustedBuiltinDirs(): string[] {
  const root = orchestratorRoot();
  if (verifiedRelease() === null && existsSync(join(root, 'release-manifest.json'))) {
    return readBuiltinList(root).map(({ pkg }) => join(root, BUILTIN_DIR, ...pkg.split('/')));
  }
  return resolveBuiltins({ root }).filter(({ trust }) => trust.ok).map(({ dir }) => dir);
}

/** The backends the trusted built-in manifests declare, lowest rank first. An entry that fails its checks is left out, with the reason in the log. */
function readProductBackends(): ProductBackend[] {
  const found: ProductBackend[] = [];
  for (const dir of trustedBuiltinDirs()) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const timon = isRecord(json) && isRecord(json.timon) ? json.timon : null;
    const provider = timon && isRecord(timon.provider) ? timon.provider : null;
    if (!provider || provider.backends === undefined) continue;
    const problems = providerBackendsProblems(provider as Parameters<typeof providerBackendsProblems>[0]);
    if (problems.length > 0) {
      console.warn(`[backends] ${join(dir, 'package.json')}: the backends it declares are ignored — ${problems.join('; ')}`);
      continue;
    }
    for (const entry of provider.backends as ProductBackend[]) {
      if (found.some(({ id }) => id === entry.id)) {
        console.warn(`[backends] ${join(dir, 'package.json')}: \`${entry.id}\` is already declared by another built-in plugin — ignored`);
        continue;
      }
      // Two backends never share a sign-in folder: the mask of one would spare the other's.
      const claimed = Object.fromEntries(found.map(({ id, credentialDirs }) => [id, credentialDirs ?? []]));
      const overlap = (entry.credentialDirs ?? []).map((folder) => otherBackendHomeDirProblem(folder, entry.id, claimed)).find((why) => why !== null);
      if (overlap) {
        console.warn(`[backends] ${join(dir, 'package.json')}: \`${entry.id}\` ignored — ${overlap}`);
        continue;
      }
      found.push(Object.freeze(entry));
    }
  }
  return found.sort((a, b) => a.rank - b.rank);
}

const PRODUCT_BACKENDS: readonly ProductBackend[] = Object.freeze(readProductBackends());

/** What each backend of the product declares, by id, in the order the product lists them. */
export const BUILTIN_DECLARATIONS: Readonly<Record<string, BuiltinDeclarations>> = Object.freeze(Object.fromEntries(
  PRODUCT_BACKENDS.map(({ id, rank: _rank, ...declared }) => [id, declared] as const)));

/**
 * The providers reached with an API key rather than a CLI of their own: they run through the CLI of
 * `via` (a backend of the product), which the first-run screen names. Informational only.
 */
export const BUILTIN_API_KEY_PROVIDERS: ReadonlyArray<{ readonly id: string; readonly label: string; readonly brand: string; readonly via: string }> = Object.freeze(
  Object.entries(BUILTIN_DECLARATIONS).flatMap(([via, { apiKeyProviders }]) => (apiKeyProviders ?? []).map((entry) => ({ ...entry, via }))));

/**
 * Credential folders of each of the product's own backends, relative to the home folder (`credentialDirs`,
 * C2). A mission running on `claude` MUST keep `~/.claude` (the CLI reads its subscription credentials and
 * its session history there) — masking it would not harden anything, it would stop the mission from
 * starting. Handed to `credential-home-dirs.ts`, which the published SDK shares and which therefore reads
 * no file itself.
 */
export const BACKEND_HOME_DIRS: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.fromEntries(
  Object.entries(BUILTIN_DECLARATIONS).flatMap(([id, { credentialDirs }]) =>
    (credentialDirs ? [[id, Object.freeze([...credentialDirs])] as const] : []))));
setBackendHomeDirsSource(() => BACKEND_HOME_DIRS);

/** The model-name fragments of the product's providers, in the product's order (`modelBrands`). */
export function productModelBrands(): Array<{ match: string; brand: string }> {
  return Object.values(BUILTIN_DECLARATIONS).flatMap(({ modelBrands }) => (modelBrands ? modelBrands.map(({ match, brand }) => ({ match, brand })) : []));
}

/** The ids of the product's own providers, in the order the product lists them. */
export function builtinProviderIds(): string[] {
  return Object.keys(BUILTIN_DECLARATIONS);
}

/** The binary declarations of the product's own providers: what `host.bin` and the installer look for. */
export function builtinBinaries(): BuiltinBinaryDeclaration[] {
  return Object.values(BUILTIN_DECLARATIONS).flatMap(({ binary }) => (binary ? [binary] : []));
}
