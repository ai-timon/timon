/**
 * What a shell command about to run would execute from the mission's own
 * folder, shown on its permission card.
 *
 * A card that shows only `./run_tests.sh` asks the human to approve a file
 * they never saw: a cloned repository can hide anything behind a familiar
 * name, and one click then runs it with the user's rights. When the command
 * runs a local file (a script by path, a script handed to an interpreter or to
 * `source`, an npm script, a make target), the card carries a bounded excerpt
 * of it and a fingerprint of the whole file.
 *
 * Nothing here ever executes anything: the command is parsed as text, the file
 * is opened read-only and non-blocking (a FIFO planted under a script's name
 * must not hang the daemon), and read no further than the bounds. Outside the
 * mission's folder, or behind a symbolic link that leads out of it, the file is
 * named but never read: the card says so instead.
 *
 * The parse is deliberately modest. It reads what an agent usually types
 * (`./x.sh`, `bash x.sh`, `cd sub && python run.py`, `npm test`, `make check`)
 * and says "could not be resolved" for what depends on the shell's own state
 * (`$VAR/x.sh`, `~/x`, globs). It is a reading aid for the human, not a
 * sandbox: the approval itself stays the human's.
 *
 * The fingerprint is checked again when the card is approved
 * (`scriptsChanged`): a file rewritten between the moment the human read it
 * and the moment they clicked is not what they approved. A file the command
 * names but that is not there is checked too: one that appears before the
 * click was never shown. The same states, folded into one digest
 * (`ScriptPreviews.state`), bind a remembered approval to the content it was
 * given for (`approval-rules.ts`).
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { safeResolve, sniffBinary } from './files.js';
import { toPosixRelative } from './host/portable-names.js';

export const PREVIEW_MAX_LINES = 40;
export const PREVIEW_MAX_BYTES = 4096;
/** A command chaining many scripts still gets a card of a readable size. */
export const MAX_PREVIEWS = 4;
/**
 * Past this size a file is not fingerprinted and its approval is refused
 * (`tooLarge`). Hashing runs on the daemon's thread, on the card and again on
 * the click; a partial hash would let a rewrite of the end go unnoticed.
 */
export const MAX_HASH_BYTES = 32 * 1024 * 1024;
/** A `package.json` larger than this is not parsed for its scripts. */
const MAX_MANIFEST_BYTES = 1024 * 1024;
/**
 * npm scripts and make recipes are read for the files they run, this deep:
 * `test` → `test:unit` → `node run.js` is followed to the end. Past it, what
 * the body runs is not checked, so no remembered approval holds.
 */
export const MAX_DEPTH = 4;
/** `sh -c '…'` and `eval '…'` are read for the command they hold, this deep. */
export const MAX_NESTING = 3;

export type ScriptPreviewKind = 'file' | 'npm_script' | 'make_target';
/**
 * - `ok` / `binary`: read (a binary file shows no excerpt);
 * - `outside_cwd`, `symlink_outside`: named, never read;
 * - `missing`, `not_file`, `unreadable`: nothing to read there;
 * - `unresolved`: the path depends on the shell (`$VAR`, `~`, a glob, a `cd` it
 *   cannot follow, a `sh -c` nested too deep);
 * - `not_found`: the npm script is not in `package.json`;
 * - `too_large`: past `MAX_HASH_BYTES`, excerpt only, and the approval is refused.
 */
export type ScriptPreviewStatus =
  | 'ok' | 'binary' | 'outside_cwd' | 'symlink_outside' | 'missing' | 'not_file' | 'unreadable'
  | 'unresolved' | 'not_found' | 'too_large';

export type ScriptPreview = {
  kind: ScriptPreviewKind;
  /** Relative to the mission's folder, forward slashes; as written by the agent when it was not read. */
  path: string;
  /** The npm script or the make target. */
  name?: string;
  status: ScriptPreviewStatus;
  size?: number;
  excerpt?: string;
  /** The excerpt stops before the end of the file. */
  truncated?: boolean;
  sha256?: string;
};

/** The state of a file that is not there. */
export const ABSENT = 'absent';

/**
 * What the approval reads again. Kept in the daemon, never sent to the card.
 * `state` is the file's SHA-256, `absent`, or the reason it could not be read.
 */
export type ScriptCheck = { root: string; rel: string; path: string; state: string };

export type ScriptPreviews = {
  previews: ScriptPreview[];
  checks: ScriptCheck[];
  /**
   * One digest of every state in `checks`, or null when the command runs
   * something whose content cannot be checked (outside the folder, unresolved,
   * not a file, too large, more files than a card shows). A remembered
   * approval holds only while this digest is the same; null = none holds.
   */
  state: string | null;
  /** Files too large to fingerprint: an Allow of this command is refused. */
  tooLarge: string[];
};

// ── Parsing ─────────────────────────────────────────────────────────────────

type Token = { word: string } | { op: string };

/** Shell words and operators, with quotes and escapes undone. No expansion. */
function tokenize(command: string): Token[] {
  const out: Token[] = [];
  let word = '';
  let started = false;
  const flush = (): void => {
    if (started) out.push({ word });
    word = '';
    started = false;
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      word += command.slice(i + 1, end < 0 ? command.length : end);
      started = true;
      i = end < 0 ? command.length : end + 1;
      continue;
    }
    if (c === '"') {
      started = true;
      i++;
      while (i < command.length && command[i] !== '"') {
        const next = command[i + 1];
        if (command[i] === '\\' && next !== undefined && '"\\$`'.includes(next)) {
          word += next;
          i += 2;
          continue;
        }
        word += command[i];
        i++;
      }
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') { word += command[i + 1]; started = true; }
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '<' || c === '>') {
      // `2>` names a descriptor, not a word of the command.
      if (/^\d+$/.test(word)) { word = ''; started = false; }
      flush();
      i++;
      if (command[i] === '>' || command[i] === '&' || command[i] === '<') i++;
      out.push({ op: 'redirect' });
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      flush();
      out.push({ op: c });
      i++;
      continue;
    }
    word += c;
    started = true;
    i++;
  }
  flush();
  return out;
}

/** The simple commands of a line, each as its words, redirections left out. */
function segments(command: string): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let skipNext = false;
  for (const token of tokenize(command)) {
    if ('op' in token) {
      if (token.op === 'redirect') { skipNext = true; continue; }
      if (current.length) out.push(current);
      current = [];
      skipNext = false;
      continue;
    }
    if (skipNext) { skipNext = false; continue; }
    current.push(token.word);
  }
  if (current.length) out.push(current);
  return out;
}

/** `python3.12`, `/usr/bin/node`, `npm.cmd` → `python3.12`, `node`, `npm`. */
function commandName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Prefixes that run the command after them. */
const WRAPPERS = new Set(['env', 'time', 'nice', 'nohup', 'exec', 'command', 'builtin', 'sudo', 'doas']);
/** Their options that take a value as the next word. */
const WRAPPER_VALUE_FLAGS = new Set(['-u', '-g', '-C', '-D', '-h', '-U', '-r', '-t', '-n']);

/** The words of a simple command once its variable assignments and wrappers are dropped. */
function bareCommand(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (ASSIGNMENT.test(w)) { i++; continue; }
    if (!WRAPPERS.has(commandName(w))) break;
    i++;
    while (i < words.length && (words[i]!.startsWith('-') || ASSIGNMENT.test(words[i]!))) {
      if (WRAPPER_VALUE_FLAGS.has(words[i]!)) i++;
      i++;
    }
  }
  return words.slice(i);
}

type Interpreter = {
  /** Options whose code is on the command line itself: no file to show. */
  inline: ReadonlySet<string>;
  /** Options that take the next word as their value. */
  valued?: ReadonlySet<string>;
  /** Subcommands skipped before the file (`deno run x.ts`). */
  subcommands?: ReadonlySet<string>;
};

const PYTHON: Interpreter = { inline: new Set(['-c', '-m']), valued: new Set(['-W', '-X']) };
const NODE: Interpreter = {
  inline: new Set(['-e', '--eval', '-p', '--print']),
  valued: new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions']),
  subcommands: new Set(['run']),
};
const PERL_RUBY: Interpreter = { inline: new Set(['-e', '-E']), valued: new Set(['-I', '-r']) };

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'source', '.']);
const SHELL_VALUED = new Set(['-o', '-O', '+o', '+O', '--rcfile', '--init-file']);

/**
 * What a shell is handed: the file it reads, or the command line of its `-c`
 * (`-c`, `-ec`, `-lc`…: the first word that is not an option). Null for stdin.
 */
function shellInput(args: string[]): { file: string } | { code: string } | null {
  let inline = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // `-` is `--` to bash: options end, and the next word is the command line
    // of a `-c`, or the file to read (none = stdin).
    if (a === '--' || a === '-') {
      const next = args[i + 1];
      if (next === undefined) return null;
      return inline ? { code: next } : { file: next };
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) { inline = true; continue; }
    if (a.startsWith('-') || a.startsWith('+')) {
      if (SHELL_VALUED.has(a)) i++;
      continue;
    }
    return inline ? { code: a } : { file: a };
  }
  return null;
}

function interpreterOf(name: string): Interpreter | null {
  if (/^python[0-9.]*$/.test(name) || name === 'py' || name === 'pypy3') return PYTHON;
  if (['node', 'nodejs', 'tsx', 'ts-node', 'bun', 'deno'].includes(name)) return NODE;
  if (name === 'perl' || name === 'ruby') return PERL_RUBY;
  if (name === 'php') return { inline: new Set(['-r']) };
  return null;
}

/** The file an interpreter is handed, or null when its code is inline or on stdin. */
function interpretedFile(args: string[], interpreter: Interpreter): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-' || a === '--') return a === '--' ? args[i + 1] ?? null : null;
    if (interpreter.inline.has(a) || [...interpreter.inline].some((f) => f.startsWith('--') && a.startsWith(`${f}=`))) return null;
    if (a.startsWith('-')) {
      if (interpreter.valued?.has(a)) i++;
      continue;
    }
    if (i === 0 && interpreter.subcommands?.has(a)) continue;
    if (a === 'eval' || a === 'x') return null; // `deno eval`, `bun x`: no local file
    return a;
  }
  return null;
}

/** A path whose meaning depends on the shell: variable, home, glob, substitution. */
function shellDependent(path: string): boolean {
  return /[$`*?[\]{}]/.test(path) || path.startsWith('~');
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

// ── Reading ─────────────────────────────────────────────────────────────────

type Located =
  | { status: 'ok'; real: string; rel: string }
  /** Not there; `rel` is where the shell would look, inside the folder. */
  | { status: 'missing'; rel: string }
  | { status: 'outside_cwd' | 'symlink_outside' | 'unresolved' };

/** Where `target` lands under `root`, through the same sandbox as the file browser. */
function locate(root: string, base: string | null, target: string): Located {
  if (shellDependent(target)) return { status: 'unresolved' };
  if (base === null && !isAbsolute(target)) return { status: 'unresolved' };
  const lexical = resolve(base ?? root, target);
  if (!within(root, lexical)) return { status: 'outside_cwd' };
  const rel = relative(root, lexical);
  let real: string;
  try {
    real = safeResolve(root, rel);
  } catch {
    return { status: 'symlink_outside' };
  }
  // `safeResolve` refuses a broken link (caught above) and re-attaches the
  // components that do not exist yet, so a path that is not there is missing.
  if (!existsSync(real)) return { status: 'missing', rel };
  return { status: 'ok', real, rel };
}

type Read =
  | { kind: 'file'; size: number; head: Buffer; sha256: string }
  /** Excerpt only: no fingerprint can vouch for it. */
  | { kind: 'too_large'; size: number; head: Buffer }
  | { kind: 'missing' } | { kind: 'not_file' } | { kind: 'unreadable' };

const HEAD_BYTES = 8192;

function fingerprint(real: string): Read {
  let fd: number;
  try {
    // Non-blocking: opening a FIFO for reading would otherwise wait for a writer.
    fd = openSync(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { kind: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: 'not_file' };
    const tooLarge = st.size > MAX_HASH_BYTES;
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    const parts: Buffer[] = [];
    let kept = 0;
    let pos = 0;
    // The whole file, or its head alone when it is too large to vouch for.
    const limit = tooLarge ? Math.min(st.size, HEAD_BYTES) : st.size;
    while (pos < limit) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, limit - pos), pos);
      if (n <= 0) break;
      hash.update(chunk.subarray(0, n));
      if (kept < HEAD_BYTES) {
        const take = Math.min(n, HEAD_BYTES - kept);
        parts.push(Buffer.from(chunk.subarray(0, take)));
        kept += take;
      }
      pos += n;
    }
    const head = Buffer.concat(parts);
    if (tooLarge) return { kind: 'too_large', size: st.size, head };
    return { kind: 'file', size: st.size, head, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

/** The first lines of a text, within the bounds. */
function excerptOf(text: string, totalBytes: number): { excerpt: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  const cut = bytes.length > PREVIEW_MAX_BYTES ? bytes.subarray(0, PREVIEW_MAX_BYTES).toString('utf8') : text;
  const lines = cut.split(/\r?\n/);
  const kept = lines.slice(0, PREVIEW_MAX_LINES);
  return {
    excerpt: kept.join('\n'),
    truncated: lines.length > PREVIEW_MAX_LINES || bytes.length > PREVIEW_MAX_BYTES || totalBytes > bytes.length,
  };
}

// ── Collecting ──────────────────────────────────────────────────────────────

type Collector = {
  root: string;
  previews: ScriptPreview[];
  checks: ScriptCheck[];
  seen: Set<string>;
  /** Something runs whose content no check covers: no remembered approval holds. */
  unverifiable: boolean;
  tooLarge: string[];
};

function full(c: Collector): boolean {
  return c.previews.length >= MAX_PREVIEWS;
}

/**
 * Records a file read through `locate` + `fingerprint`, with its check; null
 * when there is no text to go further with. `hidden` records only the check of
 * a file that is not there (another name the command could fall back on).
 */
function readInto(
  c: Collector, base: string | null, target: string, kind: ScriptPreviewKind, name?: string, hidden = false,
): { real: string; text: string | null; size: number; preview: ScriptPreview | null } | null {
  const key = `${kind}:${base ?? ''}:${target}:${name ?? ''}`;
  if (c.seen.has(key)) return null;
  const located = locate(c.root, base, target);
  if (hidden && located.status !== 'missing') return null;
  c.seen.add(key);
  if (located.status === 'missing') {
    // An expectation of absence: a file that appears before the click, or
    // before a remembered approval is used again, was never shown.
    c.checks.push({ root: c.root, rel: located.rel, path: toPosixRelative(located.rel), state: ABSENT });
    if (!hidden) push(c, { kind, path: target, ...(name ? { name } : {}), status: 'missing' });
    return null;
  }
  if (located.status !== 'ok') {
    c.unverifiable = true;
    push(c, { kind, path: target, ...(name ? { name } : {}), status: located.status });
    return null;
  }
  const path = toPosixRelative(located.rel);
  const read = fingerprint(located.real);
  if (read.kind === 'missing') {
    c.checks.push({ root: c.root, rel: located.rel, path, state: ABSENT });
    push(c, { kind, path, ...(name ? { name } : {}), status: 'missing' });
    return null;
  }
  if (read.kind === 'not_file' || read.kind === 'unreadable') {
    c.unverifiable = true;
    c.checks.push({ root: c.root, rel: located.rel, path, state: read.kind });
    push(c, { kind, path, ...(name ? { name } : {}), status: read.kind });
    return null;
  }
  const binary = sniffBinary(read.head);
  if (read.kind === 'too_large') {
    c.unverifiable = true;
    c.tooLarge.push(path);
    const preview = push(c, { kind, path, ...(name ? { name } : {}), status: 'too_large', size: read.size });
    return binary ? null : { real: located.real, text: read.head.toString('utf8'), size: read.size, preview };
  }
  c.checks.push({ root: c.root, rel: located.rel, path, state: read.sha256 });
  const preview = push(c, { kind, path, ...(name ? { name } : {}), status: binary ? 'binary' : 'ok', size: read.size, sha256: read.sha256 });
  return { real: located.real, text: binary ? null : read.head.toString('utf8'), size: read.size, preview };
}

/**
 * Adds a preview to the card; null when the card has no room left. The file
 * is still checked, but a card past `MAX_PREVIEWS` does not show it, so no
 * remembered approval can vouch for it.
 */
function push(c: Collector, preview: ScriptPreview): ScriptPreview | null {
  if (full(c)) { c.unverifiable = true; return null; }
  c.previews.push(preview);
  return preview;
}

/** Other names `node build` (and its kin) runs when `build` itself is not there. */
const NODE_FALLBACKS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.json', '.node', '/index.js', '/index.ts'];

function previewFile(c: Collector, base: string | null, target: string, fallbacks: readonly string[] = []): void {
  const got = readInto(c, base, target, 'file');
  if (got && got.text !== null) {
    if (got.preview) Object.assign(got.preview, excerptOf(got.text, got.size));
    return;
  }
  if (got || locate(c.root, base, target).status !== 'missing') return;
  // Each fallback is either shown and fingerprinted, or expected absent.
  for (const suffix of fallbacks) {
    const alt = `${target}${suffix}`;
    if (locate(c.root, base, alt).status === 'missing') readInto(c, base, alt, 'file', undefined, true);
    else previewFile(c, base, alt);
  }
}

const NPM_ALIASES: Record<string, string> = { t: 'test', tst: 'test', test: 'test', start: 'start', stop: 'stop', restart: 'restart' };
const RUN_WORDS = new Set(['run', 'run-script', 'rum', 'urn']);

/** The package script a package-manager command runs, or null. */
function packageScriptOf(manager: string, args: string[]): string | null {
  const words = args.filter((a) => !a.startsWith('-'));
  const sub = words[0];
  if (!sub) return null;
  if (RUN_WORDS.has(sub) && (manager === 'npm' || sub === 'run')) return words[1] ?? null;
  return NPM_ALIASES[sub] ?? null;
}

function previewPackageScript(c: Collector, base: string | null, manager: string, script: string, depth: number): void {
  const got = readInto(c, base, 'package.json', 'npm_script', script);
  if (!got || got.text === null) return;
  const preview: ScriptPreview = got.preview ?? { kind: 'npm_script', path: '', status: 'ok' };
  let scripts: Record<string, unknown> = {};
  try {
    if (got.size > MAX_MANIFEST_BYTES) throw new Error('too large');
    // Re-read in full only here: the head kept for the excerpt stops at 8 KB.
    const parsed = JSON.parse(readWhole(got.real, MAX_MANIFEST_BYTES)) as { scripts?: unknown };
    if (parsed.scripts && typeof parsed.scripts === 'object') scripts = parsed.scripts as Record<string, unknown>;
  } catch {
    // Unparsed, the scripts it would run are unknown: nothing vouches for them.
    c.unverifiable = true;
    Object.assign(preview, excerptOf(got.text, got.size));
    return;
  }
  // npm also runs `pre<name>` and `post<name>` around it; pnpm and yarn 2+ do not.
  const names = manager === 'npm' ? [`pre${script}`, script, `post${script}`] : [script];
  const lines = names.flatMap((n) => (typeof scripts[n] === 'string' ? [`${n}: ${scripts[n] as string}`] : []));
  if (typeof scripts[script] !== 'string') {
    preview.status = 'not_found';
    return;
  }
  Object.assign(preview, excerptOf(lines.join('\n'), 0));
  if (depth + 1 >= MAX_DEPTH) {
    // The body may run a file no check covers: a rewrite would go unnoticed.
    c.unverifiable = true;
    return;
  }
  const dir = dirname(got.real);
  for (const n of names) {
    const body = scripts[n];
    if (typeof body === 'string') collect(c, body, dir, depth + 1, 0);
  }
}

function readWhole(real: string, max: number): string {
  const fd = openSync(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) throw new Error('not readable');
    const buf = Buffer.alloc(st.size);
    let pos = 0;
    while (pos < st.size) {
      const n = readSync(fd, buf, pos, st.size - pos, pos);
      if (n <= 0) break;
      pos += n;
    }
    return buf.subarray(0, pos).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];
const RULE = /^([^\s:#=][^:=#]*?)\s*::?(?!=)/;

/** The rule of `target` (its line and its recipe), or the first rule when no target is named. */
function makeRule(text: string, target: string | null): { name: string; block: string } | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = RULE.exec(lines[i]!);
    if (!m) continue;
    const names = m[1]!.trim().split(/\s+/);
    const hit = target ? names.includes(target) : names.find((n) => !n.startsWith('.') && !n.includes('%'));
    if (!hit) continue;
    const block = [lines[i]!];
    for (let j = i + 1; j < lines.length && (lines[j]!.startsWith('\t') || lines[j]!.trim() === ''); j++) {
      if (lines[j]!.trim() === '' && !(lines[j + 1] ?? '').startsWith('\t')) break;
      block.push(lines[j]!);
    }
    return { name: target ?? (hit as string), block: block.join('\n') };
  }
  return null;
}

function previewMakeTarget(c: Collector, base: string | null, args: string[], depth: number): void {
  let dir = base;
  let file: string | null = null;
  let target: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-C' || a === '--directory') { dir = changeDir(dir, args[++i]); continue; }
    if (a.startsWith('-C') && a.length > 2) { dir = changeDir(dir, a.slice(2)); continue; }
    if (a.startsWith('--directory=')) { dir = changeDir(dir, a.slice(12)); continue; }
    if (a === '-f' || a === '--file' || a === '--makefile') { file = args[++i] ?? null; continue; }
    if (a.startsWith('--file=') || a.startsWith('--makefile=')) { file = a.slice(a.indexOf('=') + 1); continue; }
    if (a.startsWith('-') || ASSIGNMENT.test(a)) continue;
    target ??= a;
  }
  // Probed only inside the folder: on Windows, testing a path on a share makes the machine authenticate to it.
  const probe = dir !== null && within(c.root, dir) ? dir : null;
  const name = file ?? (probe === null ? 'Makefile' : MAKEFILES.find((f) => existsSync(resolve(probe, f))) ?? 'Makefile');
  // make reads the first of these names that exists: one created ahead of it
  // before the click would replace the rule the card showed.
  if (file === null) {
    for (const ahead of MAKEFILES.slice(0, MAKEFILES.indexOf(name))) readInto(c, dir, ahead, 'make_target', undefined, true);
  }
  const got = readInto(c, dir, name, 'make_target', target ?? undefined);
  if (!got || got.text === null) return;
  const preview: ScriptPreview = got.preview ?? { kind: 'make_target', path: '', status: 'ok' };
  let whole = got.text;
  try { whole = readWhole(got.real, MAX_MANIFEST_BYTES); } catch { /* the head is enough to show something */ }
  const rule = makeRule(whole, target);
  if (!rule) {
    Object.assign(preview, excerptOf(got.text, got.size));
    return;
  }
  preview.name = rule.name;
  Object.assign(preview, excerptOf(rule.block, 0));
  const recipe = rule.block.split('\n').slice(1);
  if (depth + 1 >= MAX_DEPTH) {
    // The recipe may run a file no check covers: a rewrite would go unnoticed.
    if (recipe.some((line) => line.trim() !== '')) c.unverifiable = true;
    return;
  }
  const makeDir = dirname(got.real);
  for (const line of recipe) {
    collect(c, line.replace(/^\t[@+-]*/, ''), makeDir, depth + 1, 0);
  }
}

/** The folder after `cd <arg>`, or null when the shell alone knows it. */
function changeDir(dir: string | null, arg: string | undefined): string | null {
  if (!arg || arg === '-' || shellDependent(arg)) return null;
  if (isAbsolute(arg)) return resolve(arg);
  return dir === null ? null : resolve(dir, arg);
}

/**
 * The command line a shell is handed (`sh -c '…'`, `eval '…'`), read like the
 * outer one. Past `MAX_NESTING` the card says it could not follow, and no
 * remembered approval holds: wrapping a command must not hide what it runs.
 */
function collectNested(c: Collector, code: string, dir: string | null, depth: number, nesting: number): void {
  if (nesting + 1 > MAX_NESTING) {
    c.unverifiable = true;
    push(c, { kind: 'file', path: code.length > 200 ? `${code.slice(0, 200)}…` : code, status: 'unresolved' });
    return;
  }
  collect(c, code, dir, depth, nesting + 1);
}

function collect(c: Collector, command: string, base: string | null, depth: number, nesting: number): void {
  let dir = base;
  for (const words of segments(command)) {
    if (full(c)) {
      // Something may still run past what the card has room for.
      c.unverifiable = true;
      return;
    }
    const w = bareCommand(words);
    const head = w[0];
    if (!head) continue;
    const name = commandName(head);
    const args = w.slice(1);
    if (name === 'cd' || name === 'pushd') { dir = changeDir(dir, args[0]); continue; }
    if (SHELLS.has(name)) {
      const given = shellInput(args);
      if (given && 'code' in given) collectNested(c, given.code, dir, depth, nesting);
      else if (given) previewFile(c, dir, given.file);
      continue;
    }
    if (name === 'eval') {
      if (args.length) collectNested(c, args.join(' '), dir, depth, nesting);
      continue;
    }
    const interpreter = interpreterOf(name);
    if (interpreter) {
      const file = interpretedFile(args, interpreter);
      if (file !== null) previewFile(c, dir, file, interpreter === NODE ? NODE_FALLBACKS : []);
      continue;
    }
    if (name === 'npm' || name === 'pnpm' || name === 'yarn') {
      const script = packageScriptOf(name, args);
      if (script) previewPackageScript(c, dir, name, script, depth);
      continue;
    }
    if (name === 'make' || name === 'gmake') { previewMakeTarget(c, dir, args, depth); continue; }
    // A word with a separator names a file; a bare name is looked up on the PATH.
    if (/[\\/]/.test(head)) {
      // An absolute path outside the folder is an installed program, not the repository's.
      if (isAbsolute(head) && !shellDependent(head) && !within(c.root, resolve(head))) continue;
      previewFile(c, dir, head);
    }
  }
}

/**
 * The local files `command` would run from `cwd`, each with a bounded excerpt
 * and a fingerprint. Empty when it runs none (`ls`, `git status`). Never throws
 * for a file it cannot read: that is a status on the preview.
 */
export function scriptPreviews(command: string, cwd: string): ScriptPreviews {
  const root = realpathSync(cwd);
  const c: Collector = { root, previews: [], checks: [], seen: new Set(), unverifiable: false, tooLarge: [] };
  collect(c, command, root, 0, 0);
  return {
    previews: c.previews,
    checks: c.checks,
    state: c.unverifiable ? null : contentState(c.checks),
    tooLarge: c.tooLarge,
  };
}

/** One digest for the states of all the files a command runs, order aside. */
export function contentState(checks: readonly ScriptCheck[]): string {
  const lines = [...new Set(checks.map((k) => `${k.path}\u0000${k.state}`))].sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** What `rel` holds now, in the words of `ScriptCheck.state`. */
function currentState(root: string, rel: string): string {
  const located = locate(root, root, rel);
  if (located.status === 'missing') return ABSENT;
  if (located.status !== 'ok') return located.status;
  const read = fingerprint(located.real);
  if (read.kind === 'file') return read.sha256;
  return read.kind === 'missing' ? ABSENT : read.kind;
}

/**
 * The files whose content differs from what the card showed: rewritten, gone,
 * now leading out of the folder, or there when the card found none. Empty when
 * all still match.
 */
export function scriptsChanged(checks: readonly ScriptCheck[]): string[] {
  return checks.filter((check) => currentState(check.root, check.rel) !== check.state).map((check) => check.path);
}
