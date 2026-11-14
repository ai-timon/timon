/**
 * `timon plugin check <dir>`: what a plugin author runs before sending a
 * package to someone else (TODO #643). It turns the mechanical part of the
 * "Pre-ship check" of `public-docs/docs/plugins/distribution.md` into findings
 * with a file and a line, and lists what only a person can judge.
 *
 * Read-only and local on purpose: no daemon route, no MCP tool (a folder
 * reader reachable from the network is a file reader), and the plugin's code
 * is never run — npm lists the files of a copy stripped of its `scripts`
 * (`npmPackLister`). Checks that need the code to run
 * (`inject`) stay with admission, at install time.
 *
 * The manifest, models-pack and signature verdicts are the ones the install
 * sheet (`PluginInstallSources.preview`) and admission give, through the same
 * functions: what passes here is what the recipient sees.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { getHost } from '../host/index.js';
import type { ExecResult } from '../host/types.js';
import { dictationModelsProblem, hasHostHalf } from './loader.js';
import { currentNodeRuntime, nodeEngineProblem, nodeEngineRange, nodeRangeSatisfied, type NodeRuntimeFacts } from './node-engine.js';
import { dictationEgressLines, manifestField, readManifest, SENSITIVE_PLUGIN_PERMISSIONS, type PluginManifest } from './manifest.js';
import { PLUGIN_PUBLIC_KEYS, type PluginPublicKey } from './pubkey.js';
import { verifyPluginDirectory } from './signature.js';

export type CheckLevel = 'error' | 'warn';

export type CheckFinding = {
  level: CheckLevel;
  rule: string;
  /** Relative to the plugin folder, `/`-separated whatever the OS. */
  file: string;
  /** 1-based; 0 when the finding is about the file as a whole. */
  line: number;
  message: string;
};

/** A finding a `timon-check:` comment explains, kept so the report can say so. */
export type JustifiedFinding = CheckFinding & { reason: string };

/**
 * Where the list of shipped files came from: npm itself, the `files` field
 * read without npm, or the whole folder (no npm and no `files`).
 */
export type PackSource = 'npm' | 'files' | 'folder';

/** Lists what `npm pack` would put in the archive; `null` when npm cannot be run. */
export type PackLister = (dir: string) => Promise<{ files: string[] } | { error: string } | null>;

export type CheckOptions = {
  strict?: boolean;
  /** The author's own words (name, handle, domain, project): each hit is an error. */
  deny?: readonly string[];
  keys?: readonly PluginPublicKey[];
  pack?: PackLister;
  /**
   * The Node `engines.node` is read against: the daemon's, which the CLI asks
   * for, otherwise this process's own (an estimate the message admits).
   */
  runtime?: NodeRuntimeFacts;
};

export type InstallSheet = {
  id: string;
  pkg: string | null;
  version: string | null;
  label: string | null;
  kind: string[];
  permissions: Array<{ name: string; sensitive: boolean }>;
  secrets: Array<{ name: string; mode: string }>;
  hosts: string[];
  binaries: string[];
  dictation: string[];
  licenseRequired: boolean;
};

export type CheckReport = {
  dir: string;
  ok: boolean;
  strict: boolean;
  errors: number;
  warnings: number;
  findings: CheckFinding[];
  justified: JustifiedFinding[];
  signature: 'signed' | 'unsigned' | 'invalid';
  packed: { source: PackSource; files: string[] };
  /** What the recipient's install sheet will show; `null` when the manifest is refused. */
  sheet: InstallSheet | null;
  /** Rules no regex can decide: the author answers them. */
  manual: string[];
};

/** A justification needs a reason: `timon-check:` alone explains nothing. */
const JUSTIFICATION = /timon-check:\s*(\S.*?)\s*(?:\*\/|-->)?\s*$/;

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
  '.json', '.md', '.markdown', '.txt', '.css', '.html', '.htm', '.yml', '.yaml', '.svg',
]);
/** A minified bundle is read; a model weights file named `.json` is not. */
const MAX_SCANNED_BYTES = 4 * 1024 * 1024;

/** What `npm pack` never ships whatever `files` says (npm docs, "files"). */
const ALWAYS_IGNORED = /^(?:\.git|CVS|\.svn|\.hg|node_modules|\.DS_Store|\.npmrc|npm-debug\.log|package-lock\.json|\.lock-wscript|config\.gypi|\._.*|.*\.orig|\..*\.swp)$/;
/** What `npm pack` always ships whatever `files` says. */
const ALWAYS_SHIPPED = /^(?:package\.json|readme(?:\..*)?|licen[cs]e(?:\..*)?|notice(?:\..*)?)$/i;

const SAMPLE_SUFFIX = /\.(?:example|sample|template|dist)$/i;

type PackedRule = { rule: string; test: (path: string, name: string) => boolean; message: string };

/** Development leftovers the distribution guide keeps out of a package. */
const PACKED_RULES: readonly PackedRule[] = [
  { rule: 'packed-env', test: (_p, n) => /^\.env(?:\..+)?$/i.test(n) && !SAMPLE_SUFFIX.test(n), message: 'an environment file is shipped; keep it out with `files`' },
  { rule: 'packed-data', test: (_p, n) => /\.(?:db|sqlite3?|db-wal|db-shm|db-journal)$/i.test(n), message: 'a database is shipped; the plugin creates its own under `ctx.storage.dir`' },
  { rule: 'packed-log', test: (_p, n) => /\.log$/i.test(n), message: 'a log file is shipped' },
  { rule: 'packed-key', test: (_p, n) => /\.(?:pem|key|p12|pfx)$/i.test(n) || /^id_(?:rsa|ed25519|ecdsa)/.test(n), message: 'key material is shipped' },
  { rule: 'packed-dev', test: (p) => /^(?:state|coverage)\//.test(p) || /(?:^|\/)(?:tests?|__tests__|fixtures|__fixtures__)\//.test(p), message: 'a development folder (tests, fixtures, local state) is shipped' },
  { rule: 'packed-dev', test: (_p, n) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(n), message: 'a test file is shipped' },
];

type TextRule = {
  rule: string;
  level: CheckLevel;
  re: RegExp;
  message: (hit: string) => string;
  /** Lines of `package.json` metadata (author, repository…) say who publishes: not a leak. */
  metadataExempt?: boolean;
  /** `LICENSE` names the copyright holder on purpose. */
  licenseExempt?: boolean;
};

const TEXT_RULES: readonly TextRule[] = [
  {
    rule: 'machine-path', level: 'error',
    re: /(?:\/home\/[a-z_][\w.-]*|\/Users\/[A-Za-z][\w.-]*|\b[A-Za-z]:\\{1,2}Users\b)/g,
    message: (hit) => `absolute path of a machine \`${hit}\`: files go under \`ctx.storage.dir\`, a user-chosen path is a setting`,
  },
  {
    rule: 'author-file', level: 'error',
    re: /\b(?:AGENTS|CLAUDE)\.md\b/g,
    message: (hit) => `\`${hit}\` is a file of your repository, not of the recipient's: ship a route or a skill instead`,
  },
  {
    rule: 'personal-email', level: 'error', metadataExempt: true, licenseExempt: true,
    re: /[\w.%+-]+@(?:gmail|googlemail|outlook|hotmail|live|yahoo|icloud|proton|protonmail)\.[a-z]{2,}/gi,
    message: (hit) => `personal email address \`${hit}\``,
  },
  {
    rule: 'secret-literal', level: 'error',
    re: /\bsecrets\.get\(\s*(['"`])[^'"`$]+\1\s*\)/g,
    message: (hit) => `\`${hit}\`: a vault secret's name is a setting, never a constant`,
  },
  {
    rule: 'localhost', level: 'warn',
    re: /\b(?:localhost|127\.0\.0\.1):\d{2,5}\b/g,
    message: (hit) => `\`${hit}\` points at a service of your machine; make the address a setting`,
  },
  {
    rule: 'locale', level: 'warn',
    // A tag used as an object key (`'zh-CN': { … }`) names a language of a createTranslator table, not one the code imposes.
    re: /\b(?:Europe|America|Asia|Africa|Australia|Pacific|Atlantic|Indian|Antarctica)\/[A-Z][A-Za-z_]+|(['"`])[a-z]{2}-[A-Z]{2}\1(?!\s*:)/g,
    message: (hit) => `hard-coded locale or time zone ${hit}: use \`getLocale\` and a time-zone setting`,
  },
  {
    rule: 'dev-hook', level: 'warn',
    re: /\b__[A-Za-z]+Boot\b/g,
    message: (hit) => `\`${hit}\` looks like a development hook left in the build`,
  },
];

/** React's own internals: a browser half that carries them bundled a second React. */
const BUNDLED_REACT = /__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED|__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE/;

const METADATA_KEYS = ['name', 'author', 'contributors', 'maintainers', 'repository', 'bugs', 'homepage', 'funding', 'publisher'] as const;

export async function checkPluginFolder(dirArg: string, opts: CheckOptions = {}): Promise<CheckReport> {
  const dir = resolve(dirArg);
  const strict = opts.strict === true;
  const raw: CheckFinding[] = [];
  const add = (level: CheckLevel, rule: string, file: string, line: number, message: string) => {
    raw.push({ level, rule, file, line, message });
  };

  const pkgText = readText(join(dir, 'package.json'));
  let json: Record<string, unknown> | null = null;
  if (pkgText === null) add('error', 'package-json', 'package.json', 0, 'no readable package.json in this folder');
  else {
    try {
      const parsed = JSON.parse(pkgText) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
      else add('error', 'package-json', 'package.json', 1, 'package.json is not a JSON object');
    } catch (err) {
      add('error', 'package-json', 'package.json', 1, `package.json is not valid JSON: ${(err as Error).message}`);
    }
  }
  const lineOfKey = (key: string) => (pkgText ? lineOf(pkgText, `"${key}"`) : 0);
  if (json && (typeof json.name !== 'string' || !json.name)) add('error', 'package-json', 'package.json', 1, 'package.json has no `name`');
  if (json && typeof json.version !== 'string') add('warn', 'package-json', 'package.json', 1, 'package.json has no `version`; the install sheet shows 0.0.0');

  // Manifest: the very reader admission and the install sheet use.
  let manifest: PluginManifest | null = null;
  if (json) {
    const res = readManifest(json);
    if (!res.ok) {
      const at = manifestField(json) === undefined ? 1 : lineOfKey('timon');
      add('error', 'manifest', 'package.json', at, res.message);
    } else {
      const models = dictationModelsProblem(dir, res.manifest);
      if (models) add('error', 'manifest', 'package.json', lineOfKey('models'), models);
      else manifest = res.manifest;
    }
  }

  // engines.node: what the daemon refuses at install, and at load (TODO #763).
  // Only a host half runs on the daemon's Node.
  const range = json ? nodeEngineRange(json) : null;
  if (json && manifest && range && hasHostHalf(dir, json, manifest)) {
    const runtime = opts.runtime ?? currentNodeRuntime('local');
    const fits = nodeRangeSatisfied(range, runtime.node);
    if (fits === null) {
      add('warn', 'node-engine', 'package.json', lineOfKey('engines'), `engines.node \`${range}\` is not a range Timon can read: it is not checked at install, so a daemon whose Node is too old loads the plugin anyway`);
    } else if (!fits) {
      add('error', 'node-engine', 'package.json', lineOfKey('engines'), nodeEngineProblem(json, manifest.id, runtime) ?? `engines.node \`${range}\` excludes Node ${runtime.node}`);
    }
  }

  // Signature: absent is the author's state before the distributor signs;
  // present and wrong is what the recipient's Timon refuses outright.
  const hasSignature = existsSync(join(dir, 'SIGNATURE'));
  const verdict = verifyPluginDirectory(dir, opts.keys ?? PLUGIN_PUBLIC_KEYS);
  let signature: CheckReport['signature'] = 'signed';
  if (!verdict.ok) {
    if (!hasSignature) {
      signature = 'unsigned';
      add('warn', 'unsigned', 'package.json', 0, 'the package is not signed: it only loads where developer mode is open (signing goes through the distributor)');
    } else {
      signature = 'invalid';
      add('error', 'signature', 'SIGNATURE', 0, `the signature does not match this package (${verdict.message}); the recipient's Timon refuses it`);
    }
  }

  // What will ship.
  const files = json ? json.files : undefined;
  const filesList = Array.isArray(files) && files.every((f): f is string => typeof f === 'string') ? files : null;
  if (json && files === undefined) {
    add('error', 'files', 'package.json', 1, 'no `files` allow-list in package.json: everything in the folder ships, development files included');
  } else if (json && !filesList) {
    add('error', 'files', 'package.json', lineOfKey('files'), '`files` must be a list of paths');
  }

  const lister = opts.pack ?? npmPackLister;
  let packed: { source: PackSource; files: string[] };
  const listed = json ? await lister(dir) : null;
  if (listed && 'files' in listed) packed = { source: 'npm', files: listed.files.map(toSlash).sort() };
  else {
    if (listed && 'error' in listed) {
      add('error', 'pack', 'package.json', 0, `npm pack refused this package: ${listed.error}`);
    } else if (json) {
      add('warn', 'npm-missing', 'package.json', 0, filesList
        ? 'npm could not be run: the shipped files were read from `files`, which only approximates npm\'s own rules'
        : 'npm could not be run and there is no `files`: every file of the folder was read as shipped');
    }
    packed = { source: filesList ? 'files' : 'folder', files: filesFromFolder(dir, filesList, json) };
  }
  const shipped = new Set(packed.files);

  for (const path of packed.files) {
    if (path.startsWith('node_modules/') || path.includes('/node_modules/')) continue;
    const name = path.split('/').pop() ?? path;
    const hit = PACKED_RULES.find((r) => r.test(path, name));
    if (hit) add('error', hit.rule, path, 0, hit.message);
  }

  // Entry points npm would ship missing: nothing builds them on the recipient's side.
  if (json) {
    for (const [field, target] of entryTargets(json)) {
      const rel = normalizeRel(target);
      if (rel && !shipped.has(rel) && !shipped.has(`${rel}.js`) && !shipped.has(`${rel.replace(/\/$/, '')}/index.js`)) {
        add('error', 'entry', 'package.json', lineOfKey(field), `\`${field}\` points at \`${target}\`, which is not in the package (built files must ship)`);
      }
    }
  }
  if (manifest) {
    for (const asset of [manifest.icon, manifest.cover, ...manifest.screenshots]) {
      if (asset && !shipped.has(normalizeRel(asset))) add('warn', 'asset', 'package.json', lineOf(pkgText ?? '', asset), `\`${asset}\` is named by the manifest but not shipped`);
    }
  }

  // Text rules over what ships, the way the grep of the guide reads it.
  const deny = (opts.deny ?? []).map((w) => w.trim()).filter(Boolean);
  const texts = new Map<string, string>();
  for (const path of packed.files) {
    if (path === 'SIGNATURE' || path.split('/').includes('node_modules')) continue;
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const abs = join(dir, ...path.split('/'));
    let size = 0;
    try { size = statSync(abs).size; } catch { continue; }
    if (size > MAX_SCANNED_BYTES) continue;
    const text = readText(abs);
    if (text === null) continue;
    texts.set(path, text);
    const isPackageJson = path === 'package.json';
    const isLicense = /^licen[cs]e(?:\.|$)/i.test(basename(path));
    text.split(/\r?\n/).forEach((line, index) => {
      for (const rule of TEXT_RULES) {
        // package.json: read value by value below, so its metadata can be told apart.
        if ((rule.licenseExempt && isLicense) || (rule.metadataExempt && isPackageJson)) continue;
        for (const m of line.matchAll(rule.re)) add(rule.level, rule.rule, path, index + 1, rule.message(m[0]));
      }
      if (isLicense || isPackageJson) return;
      const lower = line.toLowerCase();
      for (const word of deny) {
        if (lower.includes(word.toLowerCase())) add('error', 'deny', path, index + 1, `\`${word}\` (--deny) appears here`);
      }
    });
    if (isPackageJson && json) {
      // `author`, `repository`… name the publisher where npm expects it: not a leak.
      for (const value of packageValues(json)) {
        const at = lineOf(text, JSON.stringify(value).slice(1, -1));
        for (const rule of TEXT_RULES.filter((r) => r.metadataExempt)) {
          for (const m of value.matchAll(rule.re)) add(rule.level, rule.rule, path, at, rule.message(m[0]));
        }
        for (const word of deny) {
          if (value.toLowerCase().includes(word.toLowerCase())) add('error', 'deny', path, at, `\`${word}\` (--deny) appears here`);
        }
      }
    }
    if (/\.[cm]?js$/.test(path) && BUNDLED_REACT.test(text)) {
      add('warn', 'bundled-react', path, lineOf(text, 'DO_NOT_USE'), 'React itself is bundled here: keep `react`, `react-dom` and `@timon/*` external in the browser bundle');
    }
  }

  // The recipient's prerequisites must be readable before they install.
  const readme = packed.files.find((p) => /^readme(?:\.|$)/i.test(p));
  if (!readme) add('warn', 'readme', 'package.json', 0, 'no README ships: the recipient has nowhere to read permissions, settings and prerequisites');
  if (manifest && readme) {
    const text = (texts.get(readme) ?? readText(join(dir, readme)) ?? '').toLowerCase();
    for (const decl of manifest.http?.hosts ?? []) {
      if (!text.includes(decl.host.toLowerCase())) add('warn', 'readme-hosts', readme, 0, `the README does not name \`${decl.host}\`, a host the plugin reaches (http:outbound)`);
    }
    for (const bin of manifest.provider?.binaries ?? []) {
      if (!text.includes(bin.name.toLowerCase())) add('warn', 'readme-binaries', readme, 0, `the README does not name \`${bin.name}\`, a program the plugin runs (host:exec)`);
    }
  }
  // A plugin that declares connection types reaches the address of each
  // connection once an administrator approved it: those destinations are
  // chosen and reviewed per connection, not named in advance.
  if (manifest?.permissions.includes('http:outbound') && !(manifest.http?.hosts ?? []).length
    && !manifest.permissions.includes('connections:register')) {
    add('warn', 'http-hosts', 'package.json', lineOfKey('permissions'), '`http:outbound` without `http.hosts`: the install sheet cannot show which domains the plugin reaches');
  }

  // Justifications: on the line, or on the one above.
  const findings: CheckFinding[] = [];
  const justified: JustifiedFinding[] = [];
  for (const f of raw) {
    const reason = f.line > 0 ? justificationAt(texts.get(f.file) ?? null, f.line) : null;
    const level: CheckLevel = strict ? 'error' : f.level;
    if (reason) justified.push({ ...f, level, reason });
    else findings.push({ ...f, level });
  }
  findings.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1)
    || a.file.localeCompare(b.file) || a.line - b.line);
  const errors = findings.filter((f) => f.level === 'error').length;
  const warnings = findings.length - errors;

  return {
    dir,
    ok: errors === 0,
    strict,
    errors,
    warnings,
    findings,
    justified,
    signature,
    packed,
    sheet: manifest ? sheetOf(manifest, json) : null,
    manual: manualChecks(manifest),
  };
}

/** One line per finding, `level  rule  file:line  message`, then what is left to a person. */
export function formatCheckReport(report: CheckReport): string {
  const out: string[] = [];
  for (const f of report.findings) {
    out.push(`${f.level.padEnd(5)}  ${f.rule}  ${f.line > 0 ? `${f.file}:${f.line}` : f.file}  ${f.message}`);
  }
  if (report.findings.length) out.push('');
  const s = report.sheet;
  if (s) {
    out.push(`Install sheet: ${s.id}${s.version ? ` ${s.version}` : ''} (${s.pkg ?? '?'}), ${s.kind.join(', ') || 'no kind'}, signature ${report.signature}`);
    if (s.permissions.length) out.push(`  permissions: ${s.permissions.map((p) => (p.sensitive ? `${p.name} (sensitive)` : p.name)).join(', ')}`);
    if (s.secrets.length) out.push(`  vault secrets: ${s.secrets.map((x) => `${x.name} (${x.mode})`).join(', ')}`);
    if (s.hosts.length) out.push(`  hosts: ${s.hosts.join(', ')}`);
    if (s.binaries.length) out.push(`  programs: ${s.binaries.join(', ')}`);
    for (const line of s.dictation) out.push(`  dictation: ${line}`);
  }
  out.push(`Shipped files (${report.packed.source === 'npm' ? 'npm pack' : report.packed.source === 'files' ? '`files`, without npm' : 'whole folder, without npm'}): ${report.packed.files.length}`);
  if (report.justified.length) out.push(`Justified with timon-check: ${report.justified.length}`);
  out.push('', 'To check by hand:');
  for (const item of report.manual) out.push(`  - ${item}`);
  out.push('', `${report.errors} error(s), ${report.warnings} warning(s)${report.strict ? ' (--strict)' : ''}: ${report.ok ? 'ready for the manual checks' : 'not ready to ship'}`);
  return out.join('\n');
}

/** Exit code of the command: 0 nothing blocks, 1 something does. Usage errors (64) are the CLI's. */
export function checkExitCode(report: CheckReport): 0 | 1 {
  return report.ok ? 0 : 1;
}

/**
 * The real lister: `npm pack --dry-run --json` on a copy of the folder whose
 * package.json has no `scripts`. Not on the folder itself: npm 10 runs
 * `prepare` on a local pack even under `--ignore-scripts`, which would run the
 * plugin's code. The copy leaves out what npm never ships (`.git`, `.npmrc`,
 * and `node_modules` unless the package bundles dependencies).
 */
export const npmPackLister: PackLister = async (dir) => {
  const json = readJsonObject(join(dir, 'package.json'));
  if (!json) return { error: 'no readable package.json' };
  const bundles = Boolean(json.bundleDependencies ?? json.bundledDependencies);
  const stage = mkdtempSync(join(tmpdir(), 'timon-plugin-check-'));
  try {
    cpSync(dir, stage, {
      recursive: true,
      filter: (src) => {
        const name = basename(src);
        return name !== '.git' && name !== '.npmrc' && (bundles || name !== 'node_modules');
      },
    });
    const { scripts: _scripts, ...rest } = json;
    writeFileSync(join(stage, 'package.json'), JSON.stringify(rest, null, 2));
    let r: ExecResult;
    try {
      r = await getHost().execAsync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: stage, timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      return null; // npm not on PATH: the adapter could not resolve it
    }
    if (r.code !== 0) {
      if (npmCouldNotStart(r)) return null;
      return { error: firstLine(r.stderr) || `exit code ${r.code}` };
    }
    return packListOf(r.stdout);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};

/**
 * npm resolved, yet never ran: its `#!/usr/bin/env node` finds no `node` on
 * the PATH (exit 127), or the shell cannot find it. The adapter also looks in
 * known folders (`/usr/local/bin`…), so an npm outside the PATH is found and
 * then fails to start; and `env` words its message in the user's language, so
 * 127 is read before any text. npm itself never exits 127 for a package.
 */
export function npmCouldNotStart(r: Pick<ExecResult, 'code' | 'stdout' | 'stderr'>): boolean {
  if (r.stdout.trim()) return false;
  return r.code === 127 || /ENOENT|not found|not recognized/i.test(r.stderr);
}

function packListOf(stdout: string): { files: string[] } | { error: string } {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const entry = Array.isArray(parsed) ? parsed[0] as { files?: unknown } | undefined : undefined;
    const list = Array.isArray(entry?.files) ? entry.files : null;
    if (!list) return { error: 'npm pack printed no file list' };
    return { files: list.flatMap((f) => (f && typeof f === 'object' && typeof (f as { path?: unknown }).path === 'string' ? [(f as { path: string }).path] : [])) };
  } catch {
    return { error: 'npm pack printed no readable JSON' };
  }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function manualChecks(manifest: PluginManifest | null): string[] {
  const items = [
    'every string, label, comment and mission brief is in English; other languages go through createTranslator',
    'defaults are empty, generic or computed at run time; content (prompts, tone, templates) lives in settings',
    'no mission brief names a file of your repository; the agent is a setting, empty by default',
    'data and settings are scoped per user where several accounts share the installation',
  ];
  if (manifest?.permissions.includes('host:exec') && !manifest.kind.includes('provider')) {
    items.push('the README lists every program run through host:exec and the pluginPolicy.exec lines the operator adds');
  }
  items.push(
    'the services the host half injects are allowed (checked when installed, never here: that would run the plugin)',
    'installed from the .tgz on a clean Timon, it shows as active, says what to configure, and survives disable/enable',
  );
  return items;
}

function sheetOf(manifest: PluginManifest, json: Record<string, unknown> | null): InstallSheet {
  const sensitive = new Set<string>(SENSITIVE_PLUGIN_PERMISSIONS);
  return {
    id: manifest.id,
    pkg: typeof json?.name === 'string' ? json.name : null,
    version: typeof json?.version === 'string' ? json.version : null,
    label: manifest.label ?? null,
    kind: [...manifest.kind],
    permissions: manifest.permissions.map((name) => ({ name, sensitive: sensitive.has(name) })),
    secrets: (manifest.secrets ?? []).map((s) => ({ name: s.name, mode: s.mode })),
    hosts: (manifest.http?.hosts ?? []).map((h) => h.host),
    binaries: manifest.kind.includes('provider') ? (manifest.provider?.binaries ?? []).map((b) => b.name) : [],
    dictation: dictationEgressLines(manifest),
    licenseRequired: manifest.license.required,
  };
}

/** `main`, `browser` and the string targets of `exports`, keyed by the field that names them. */
function entryTargets(json: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (typeof json.main === 'string') out.push(['main', json.main]);
  const walk = (value: unknown) => {
    if (typeof value === 'string') { if (value.startsWith('./') && !value.includes('*')) out.push(['exports', value]); }
    else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v);
  };
  walk(json.exports);
  return out;
}

/**
 * Without npm: the folder read through `files`, plus what npm always adds.
 * An approximation that says so (`npm-missing`), not npm's packlist.
 */
function filesFromFolder(dir: string, files: readonly string[] | null, json: Record<string, unknown> | null): string[] {
  const all = walk(dir);
  if (!files) return all;
  const include = files.filter((f) => !f.startsWith('!')).map(globToRegex);
  const exclude = files.filter((f) => f.startsWith('!')).map((f) => globToRegex(f.slice(1)));
  const main = typeof json?.main === 'string' ? normalizeRel(json.main) : null;
  return all.filter((path) => {
    if (!path.includes('/') && ALWAYS_SHIPPED.test(path)) return true;
    if (path === main) return true;
    const covered = (res: RegExp[]) => res.some((re) => prefixes(path).some((p) => re.test(p)));
    return covered(include) && !covered(exclude);
  });
}

function walk(root: string, dir = root): string[] {
  const out: string[] = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (ALWAYS_IGNORED.test(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(root, abs));
    else if (entry.isFile()) out.push(toSlash(relative(root, abs)));
  }
  return out.sort();
}

/** `lib/a/b.js` → `lib`, `lib/a`, `lib/a/b.js`: a `files` entry naming a folder covers what is below. */
function prefixes(path: string): string[] {
  const parts = path.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

function globToRegex(glob: string): RegExp {
  const clean = normalizeRel(glob).replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (c === '*' && clean[i + 1] === '*') { re += '.*'; i++; if (clean[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function normalizeRel(path: string): string {
  return toSlash(path).replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
}

function toSlash(path: string): string {
  return path.split(sep).join('/').replace(/\\/g, '/');
}

/** Every string of package.json but the publisher's metadata (`author`, `repository`…, `timon.author`). */
function packageValues(json: Record<string, unknown>): string[] {
  const out: string[] = [];
  const collect = (value: unknown, skip: readonly string[] = []) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) collect(v);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) if (!skip.includes(k)) collect(v);
    }
  };
  for (const [key, value] of Object.entries(json)) {
    if ((METADATA_KEYS as readonly string[]).includes(key)) continue;
    collect(value, key === 'timon' ? ['author'] : []);
  }
  return out;
}

function justificationAt(text: string | null, line: number): string | null {
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  for (const candidate of [lines[line - 1], lines[line - 2]]) {
    const m = candidate === undefined ? null : JUSTIFICATION.exec(candidate);
    if (m?.[1]) return m[1];
  }
  return null;
}

function lineOf(text: string, needle: string): number {
  const at = text.indexOf(needle);
  return at < 0 ? 0 : text.slice(0, at).split('\n').length;
}

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.replace(/^npm (?:error|ERR!)\s*/, '').trim()).find(Boolean) ?? '';
}
