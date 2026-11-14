/**
 * The daemon's own `git`, made unable to run anything a mission wrote
 * (GHSA-f58g, V6 of the mission fence).
 *
 * The daemon runs git in mission worktrees and in the repositories they come
 * from: code gate, worktree refresh and merge, statusline, Git widget, push.
 * A mission writes its worktree, the repository's `.git` (it commits there, the
 * fence keeps it writable) and, as long as no fence applies, `~/.gitconfig`.
 * Git executes a lot from those files: hooks, `core.fsmonitor`, filter and
 * merge drivers named in `.gitattributes`, credential helpers, the SSH command,
 * `uploadpack` on a local remote, the signing program. Each one is code the
 * mission chose, run by the daemon, outside any fence.
 *
 * Every git call of the adapter therefore goes through `neutralGitCall`:
 *
 * - **Fixed overrides**, whatever the configuration says: no fsmonitor, a hooks
 *   folder that cannot exist, no editor, no pager, no `ext::` transport, no
 *   descent into submodules, no signature check in `log`. The daemon never
 *   needs any of them.
 * - **Local transport**, off unless every local repository the call may reach
 *   (a remote that is a path or a `file://` URL, once `insteadOf` rewrote it)
 *   lies where no mission writes: its hooks run on the receiving side, where
 *   the daemon's `-c` no longer applies. A call that would reach one a mission
 *   writes is refused.
 * - **Diff drivers**: `--no-ext-diff --no-textconv` on `diff`, `log` and `show`,
 *   the only porcelain commands of the daemon that render a diff.
 * - **Scanned overrides**: the configuration is read once per call, with the
 *   scope of each value (`git config --list --show-scope`). A command-running
 *   key set by a scope a mission writes (`local`, `worktree`, a file they
 *   include) is replaced by the value system or global configuration gives it,
 *   else by a neutral one. The user's own credential helper, SSH command or Git
 *   LFS keep working; the one a mission planted in `.git/config` never runs.
 *   Pure ref reads skip the scan: they run nothing configurable.
 * - **PATH** loses every entry a mission can write (`mission-writable.ts`), so
 *   the `ssh`, `gpg` or `git-lfs` git starts cannot be one a mission planted.
 *
 * The fence (V3, V4) wraps missions only, never the daemon's own git: what
 * this module leaves open stays open. Three things are left, on purpose:
 *
 * - `add`, and `commit` while it builds the editor's template, run git inside
 *   an initialized submodule, whose own configuration is never scanned, and
 *   nothing set from here stops them (git 2.43). The daemon runs `add` only in
 *   the demo project it has just created, and a commit without its message is
 *   refused. Every other command that would is kept out: by option (`status`,
 *   `diff`, `diff-index`, `diff-files`, `checkout`, `switch`, the transports),
 *   or by naming each submodule (`merge` and the commands that stash).
 * - A value can change between the scan and the call: a mission rewriting
 *   `filter.*` or `merge.*.driver`, or adding a submodule, in a loop may win
 *   that race. So may one rewriting `remote.*.url` or `url.*.insteadOf` to
 *   swap a checked local remote for one it prepared. Residual risk, recorded
 *   in `docs/SECURITY.md`.
 *   `--attr-source=<empty tree>` would close it for filters and drivers, but
 *   it also drops the attributes Git LFS, line endings and the user's own
 *   drivers need, on exactly the gestures that run them (status, merge); the
 *   others run no filter or driver at all.
 * - Code the remote side of a transport runs: `ssh`, `https`, `git`,
 *   installed remote helpers, and a local repository no mission writes, as
 *   far as `localRemoteProblem` knows the folders missions write: a project
 *   folder outside the Timon home is known only as the working directory of
 *   the call.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join, posix, resolve, win32 } from 'node:path';
import { fencedSystemFolders, missionWritableProblem } from './mission-writable.js';

/** A configuration value and the scope git read it from. `value` is null for
 *  a key written without `=` (an implicit `true`). */
export type GitConfigEntry = { scope: string; key: string; value: string | null };

/** Scopes a mission cannot write once fenced. `command` is `-c` or
 *  `GIT_CONFIG_PARAMETERS` from the daemon's own environment. */
const TRUSTED_SCOPES: ReadonlySet<string> = new Set(['system', 'global', 'command']);

/** The values `git lfs install` writes: kept from any scope, so a repository
 *  set up with `git lfs install --local` still reads its files as content. */
const LFS_FILTER_VALUES: Readonly<Record<string, string>> = Object.freeze({
  clean: 'git-lfs clean -- %f',
  smudge: 'git-lfs smudge -- %f',
  process: 'git-lfs filter-process',
});

/** What git's built-in text merge does, as an external driver: a planted
 *  driver is replaced by the merge it stands in for, not by a conflict. */
const NEUTRAL_MERGE_DRIVER = 'git merge-file --marker-size=%L %A %O %B';

/** What git runs for `core.alternateRefsCommand` when it is unset, as a shell
 *  command: git appends the alternate's path, which `#` drops after `$1`. */
const NEUTRAL_ALTERNATE_REFS_COMMAND = `git --git-dir="$1" for-each-ref --format='%(objectname)' #`;

/** Keys naming a program Git LFS starts. git never reads them: `git-lfs`
 *  does, as a filter, from the same configuration. A filter that keeps them
 *  cannot be trusted, wherever the filter itself is set. */
const LFS_PROGRAM_KEY = /^lfs\.(customtransfer\..+\.path|extension\..+\.(clean|smudge))$/;

type KeyRule = {
  match: RegExp;
  /** The value to pass when no trusted scope sets one. */
  neutral: (key: string, value: string | null) => string;
  /** A value safe to keep even from a scope a mission writes. */
  keep?: (key: string, value: string | null) => boolean;
  /** Multi-valued key: an empty value resets the list, trusted values follow. */
  list?: true;
  /** No value is known to be harmless: a scope a mission writes setting it
   *  refuses the call. */
  refuse?: true;
};

/**
 * Every key a repository configuration can use to make git run a program, as
 * of git 2.43, and how the daemon's git handles it.
 *
 * Scanned here (`KEY_RULES`, then the special cases of `scannedGitConfig`):
 * `core.sshCommand`, `core.askPass`, `core.alternateRefsCommand`,
 * `core.gitProxy`, `filter.*.{clean,smudge,process}`, `merge.*.driver`,
 * `credential.helper`, `credential.<url>.helper`, `gpg.program`,
 * `gpg.{openpgp,x509,ssh}.program`, `gpg.ssh.defaultKeyCommand`,
 * `submodule.*.update`, `remote.*.{uploadpack,receivepack}`,
 * `lfs.customtransfer.*.path`, `lfs.extension.*.{clean,smudge}`, and `hook.*`
 * (hooks declared in the configuration by later gits: refused).
 *
 * Fixed for every call (`fixedGitConfig`, `neutralGitCall`): `core.fsmonitor`,
 * `core.hooksPath`, `core.editor`, `sequence.editor`, `core.pager` and
 * `pager.*` (`--no-pager`), `diff.external`, `diff.*.command` and
 * `diff.*.textconv` (`--no-ext-diff --no-textconv` on the only commands that
 * honour them), `url.*.insteadOf` and `remote.*.vcs` (they only pick a
 * transport: the protocol policy refuses `ext`, and checks every local
 * target after rewriting),
 * `submodule.*.ignore`, `submodule.*.fetchRecurseSubmodules`,
 * `submodule.recurse` (the configuration of a submodule is never scanned, so
 * git must not run inside one: options on the commands that would).
 *
 * Not covered, on purpose:
 * - `uploadpack.packObjectsHook`, `safe.directory`, `trace2.*`: git reads them
 *   from system and global configuration only.
 * - `alias.*`: an alias never shadows a built-in command, and the daemon runs
 *   built-in commands only.
 * - `gc.*`, `maintenance.*`: the automatic housekeeping they start is git's
 *   own commands, which inherit the overrides of the call.
 * - `diff.tool`, `difftool.*`, `merge.tool`, `mergetool.*`, `sendemail.*`,
 *   `imap.tunnel`, `instaweb.*`, `web.browser`, `browser.*.cmd`, `man.*.cmd`,
 *   `interactive.diffFilter`: read only by commands the daemon never runs.
 * - `receive.*`, `uploadpack.*`: the remote side's, reachable only in a local
 *   repository no mission writes.
 * - `.lfsconfig` in the worktree: Git LFS reads only a safe list of keys from
 *   it, none naming a program.
 */
const KEY_RULES: readonly KeyRule[] = [
  { match: /^core\.sshcommand$/, neutral: () => 'ssh' },
  { match: /^core\.askpass$/, neutral: () => '' },
  { match: /^core\.alternaterefscommand$/, neutral: () => NEUTRAL_ALTERNATE_REFS_COMMAND },
  { match: /^hook\./, neutral: () => '', refuse: true },
  {
    match: /^filter\..+\.(clean|smudge|process)$/,
    neutral: () => '',
    keep: (key, value) => {
      const m = /^filter\.lfs\.(clean|smudge|process)$/.exec(key);
      return !!m && value === LFS_FILTER_VALUES[m[1]!];
    },
  },
  {
    match: /^merge\..+\.driver$/,
    neutral: () => NEUTRAL_MERGE_DRIVER,
    keep: (_key, value) => value === 'true' || value === 'false',
  },
  { match: /^credential\.(.+\.)?helper$/, neutral: () => '', list: true },
  { match: /^gpg\.program$/, neutral: () => 'gpg' },
  { match: /^gpg\.openpgp\.program$/, neutral: () => 'gpg' },
  { match: /^gpg\.x509\.program$/, neutral: () => 'gpgsm' },
  { match: /^gpg\.ssh\.program$/, neutral: () => 'ssh-keygen' },
  { match: /^gpg\.ssh\.defaultkeycommand$/, neutral: () => '' },
  {
    match: /^submodule\..+\.update$/,
    neutral: () => 'checkout',
    keep: (_key, value) => !value?.startsWith('!'),
  },
];

/** Subcommands that only read refs, objects or settings: nothing they do runs a
 *  configured command, so they skip the scan (the fixed overrides still apply). */
const SCAN_FREE: ReadonlySet<string> = new Set([
  'rev-parse', 'rev-list', 'merge-base', 'for-each-ref', 'show-ref', 'symbolic-ref',
  'config', 'ls-tree', 'var', 'version', 'check-ignore', 'check-ref-format',
  'update-ref', 'branch',
]);

/** Porcelain commands that may render a diff through a configured driver. */
const DIFF_COMMANDS: ReadonlySet<string> = new Set(['diff', 'log', 'show']);

/**
 * Commands that run `status` inside a submodule to find edited files, with
 * the submodule's own configuration (a `filter.<x>.clean` there runs). Only
 * the option stops them: `submodule.<name>.ignore`, which a mission writes in
 * `.gitmodules` or `.git/config`, outranks `diff.ignoreSubmodules` even at
 * command scope (tested). `dirty` and not `all`: git then never runs inside the
 * submodule, and a submodule moved to another commit still shows, so the code
 * gate does not call a worktree clean while its submodule pointer changed.
 */
const SUBMODULE_STATUS_COMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'diff-index', 'diff-files']);

/**
 * Commands that run a `status` inside a submodule through `git stash create`
 * (a real `merge` always does, to restore the worktree if it fails) or a check
 * of their own, and take no option to stop it. `submodule.<name>.ignore` set
 * at command scope outranks the value of `.gitmodules` and `.git/config`: it is
 * set for every name git will read, which `gitmodulesScanArgs` asks git for.
 */
const NAMED_SUBMODULE_COMMANDS: ReadonlySet<string> = new Set(['merge', 'pull', 'rebase', 'cherry-pick', 'revert', 'stash', 'am', 'describe']);

/** Their closing report of local changes runs the same `status` inside a
 *  submodule, whatever `diff.ignoreSubmodules` says; `--quiet` skips it. */
const QUIET_COMMANDS: ReadonlySet<string> = new Set(['checkout', 'switch']);

/** `submodule.<name>.fetchRecurseSubmodules` outranks the fixed settings: only
 *  the option keeps a transport from running again inside a submodule. */
const NO_RECURSE_COMMANDS: ReadonlySet<string> = new Set(['fetch', 'pull', 'push']);

/** `commit` has no `--ignore-submodules`. With its message on the command
 *  line it never looks inside a submodule; without one it builds the editor's
 *  template from a `status` that does, before failing on the empty message
 *  (`core.editor=:`). The daemon always passes its message. */
const COMMIT_MESSAGE = /^(-m|--message|-F|--file|-C|--reuse-message|--no-edit)(=|$)|^-[^-]*[mFC]/;

/** `remote.<name>.uploadpack` and `receivepack` keep the FIRST value read, so
 *  `-c` cannot outrank a planted one: the command-line option can, on the
 *  commands that take it. The others that may start a transport are refused. */
const UPLOAD_PACK_COMMANDS: ReadonlySet<string> = new Set(['fetch', 'pull', 'ls-remote', 'clone']);
const RECEIVE_PACK_COMMANDS: ReadonlySet<string> = new Set(['push']);
const OTHER_TRANSPORT_COMMANDS: ReadonlySet<string> = new Set(['remote', 'submodule', 'archive', 'fetch-pack', 'send-pack']);

/**
 * A hooks folder that cannot exist: it lies under the daemon's own runtime, a
 * regular file. Nothing can be created there, so there is nothing to remove
 * before a call and no window between a removal and git's lookup. Whoever can
 * turn that file into a folder has replaced the daemon's runtime already.
 */
export function gitHooksNoneDir(runtime = process.execPath): string {
  return join(runtime, 'git-hooks-none');
}

/** `-c` pairs applied to every call of the daemon. */
export function fixedGitConfig(): string[] {
  return [
    'core.fsmonitor=false',
    `core.hooksPath=${gitHooksNoneDir()}`,
    'core.editor=:',
    'sequence.editor=:',
    'core.pager=cat',
    'protocol.ext.allow=never',
    // A local remote runs ITS hooks and configuration on the receiving side,
    // where git drops the daemon's `-c`: a bare repository a mission prepared
    // would run its `pre-receive`. `neutralGitCall` reopens it for a call
    // whose local targets no mission writes.
    'protocol.file.allow=never',
    // A submodule's configuration is never scanned: git must not run in it.
    // `dirty` still reports a changed submodule commit, without the `status`
    // git would run inside the submodule to find edited files.
    'submodule.recurse=false',
    'diff.ignoreSubmodules=dirty',
    'fetch.recurseSubmodules=false',
    'push.recurseSubmodules=no',
    'log.showSignature=false',
  ];
}

function fixedGitArgs(): string[] {
  return ['--no-pager', ...fixedGitConfig().flatMap((pair) => ['-c', pair])];
}

type ParsedCall = {
  /** Options before the subcommand that say WHERE git works (`-C`, `--git-dir`…). */
  location: string[];
  /** Index of the subcommand in `args`, -1 when there is none (`--version`). */
  commandIndex: number;
};

const GLOBAL_WITH_VALUE: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const LOCATION_OPTIONS: ReadonlySet<string> = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--bare']);

function parseCall(args: readonly string[]): ParsedCall {
  const location: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) return { location, commandIndex: i };
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const takesNext = !arg.includes('=') && GLOBAL_WITH_VALUE.has(arg);
    if (LOCATION_OPTIONS.has(name)) location.push(...(takesNext ? [arg, args[i + 1] ?? ''] : [arg]));
    if (takesNext) i++;
  }
  return { location, commandIndex: -1 };
}

/**
 * The `git config` reads that tell where each value comes from, for a call
 * that needs them: the scoped listing (git ≥ 2.26), then the plain one, whose
 * values count as untrusted. Null when the call runs nothing configurable.
 */
export function gitScanArgs(args: readonly string[]): { scoped: string[]; plain: string[] } | null {
  const { location, commandIndex } = parseCall(args);
  if (commandIndex < 0 || SCAN_FREE.has(args[commandIndex]!)) return null;
  const base = [...location, '--no-pager', 'config', '--list', '-z'];
  return { scoped: [...base, '--show-scope'], plain: base };
}

/** Where the call works, for a call whose submodules need naming. */
export function gitToplevelArgs(args: readonly string[]): string[] | null {
  const { location, commandIndex } = parseCall(args);
  if (commandIndex < 0 || !NAMED_SUBMODULE_COMMANDS.has(args[commandIndex]!)) return null;
  return [...location, ...fixedGitArgs(), 'rev-parse', '--show-toplevel'];
}

/**
 * The reads of every `.gitmodules` git may take submodule names from: the
 * worktree's, else the index's, else HEAD's. All three are read, by git's own
 * parser: a name too many costs nothing, a name missed would leave a submodule
 * git still runs in. A source that does not exist fails and names nothing.
 */
export function gitmodulesScanArgs(args: readonly string[], toplevel: string): string[][] {
  // Reading `:.gitmodules` loads the index, which may start `core.fsmonitor`.
  const base = [...parseCall(args).location, ...fixedGitArgs(), 'config', '--list', '-z', '--name-only'];
  return [
    [...base, '--file', join(toplevel, '.gitmodules')],
    [...base, '--blob', ':.gitmodules'],
    [...base, '--blob', 'HEAD:.gitmodules'],
  ];
}

/** Submodule names in `git config --list -z --name-only` outputs, read as far
 *  as they go: a parse error further down still leaves git the names above. */
export function parseSubmoduleNames(outputs: readonly string[]): string[] {
  const names = new Set<string>();
  for (const out of outputs) {
    for (const key of out.split('\0')) {
      const last = key.lastIndexOf('.');
      if (key.startsWith('submodule.') && last > 'submodule.'.length) names.add(key.slice('submodule.'.length, last));
    }
  }
  return [...names];
}

/** `git config --list -z [--show-scope]`: `[scope NUL] key LF value NUL`, or
 *  `key NUL` for a key written without a value. */
export function parseGitConfigList(raw: string, scoped: boolean): GitConfigEntry[] {
  const fields = raw.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  const out: GitConfigEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const scope = scoped ? fields[i++] ?? '' : 'unknown';
    const field = fields[i];
    if (field === undefined) break;
    const newline = field.indexOf('\n');
    out.push(newline < 0
      ? { scope, key: field, value: null }
      : { scope, key: field.slice(0, newline), value: field.slice(newline + 1) });
  }
  return out;
}

/**
 * `-c` pairs replacing every command-running value an untrusted scope set.
 * `refused` names a key `-c` cannot reach: git splits `-c` at the first `=`,
 * so a subsection holding one (`[credential "https://a=b"]`) would override
 * another key and leave the planted value in force.
 */
export type ScannedGitConfig = {
  config: string[];
  env: Record<string, string>;
  /** A scope a mission writes names the program a transport starts. */
  plantedUploadPack?: true;
  plantedReceivePack?: true;
  refused?: string;
};

export function scannedGitConfig(entries: readonly GitConfigEntry[]): ScannedGitConfig {
  const config: string[] = [];
  const env: Record<string, string> = {};
  const out: ScannedGitConfig = { config, env };
  const byKey = new Map<string, GitConfigEntry[]>();
  for (const entry of entries) {
    const key = entry.key;
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }
  const neutralizedFilters = new Set<string>();
  for (const [key, list] of byKey) {
    // `core.gitProxy` keeps the FIRST matching value, so a later `-c` cannot
    // outrank a planted one; the environment variable is read before any file.
    if (key === 'core.gitproxy') {
      if (list.some((e) => !TRUSTED_SCOPES.has(e.scope))) env.GIT_PROXY_COMMAND = '';
      continue;
    }
    if (/^remote\..+\.(uploadpack|receivepack)$/.test(key)) {
      if (!list.some((e) => !TRUSTED_SCOPES.has(e.scope))) continue;
      if (key.endsWith('.uploadpack')) out.plantedUploadPack = true;
      else out.plantedReceivePack = true;
      continue;
    }
    const rule = KEY_RULES.find((r) => r.match.test(key));
    if (!rule) continue;
    const untrusted = list.filter((e) => !TRUSTED_SCOPES.has(e.scope) && !rule.keep?.(key, e.value));
    if (untrusted.length === 0) continue;
    if (rule.refuse || key.includes('=')) return { config: [], env: {}, refused: key };
    const trusted = list.filter((e) => TRUSTED_SCOPES.has(e.scope));
    if (rule.list) {
      config.push(`${key}=`, ...trusted.map((e) => `${key}=${e.value ?? ''}`));
    } else {
      const last = trusted[trusted.length - 1];
      config.push(`${key}=${last ? last.value ?? 'true' : rule.neutral(key, untrusted[0]!.value)}`);
    }
    const filter = /^filter\.(.+)\.(clean|smudge|process)$/.exec(key);
    if (filter) neutralizedFilters.add(filter[1]!);
  }
  // Git LFS reads the program a mission named, whoever set the filter: the
  // filter goes, and LFS files read as their pointers for this call.
  if (entries.some((e) => !TRUSTED_SCOPES.has(e.scope) && LFS_PROGRAM_KEY.test(e.key))) {
    config.push('filter.lfs.clean=', 'filter.lfs.smudge=', 'filter.lfs.process=');
    neutralizedFilters.add('lfs');
  }
  // A filter left without a command must not fail the checkout it guards.
  for (const name of neutralizedFilters) config.push(`filter.${name}.required=false`);
  return out;
}

/** The environment's PATH minus every entry a mission can write, a relative
 *  entry first of all: git resolves `ssh` or `git-lfs` in the worktree it runs
 *  in when PATH holds `.` or an empty entry. */
export function neutralGitEnv(
  base: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; timonHome?: string } = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const separator = platform === 'win32' ? ';' : platform === process.platform ? delimiter : ':';
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (!(platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH')) continue;
    const entries = (env[key] ?? '').split(separator);
    env[key] = entries.filter((dir) => !missionWritableProblem(
      platform === 'win32' ? win32.normalize(dir || '.') : dir,
      { platform, ...(options.timonHome ? { timonHome: options.timonHome } : {}) },
    )).join(separator);
  }
  return env;
}

/** Commands that start a transport to the repository they name, or to the
 *  remote they default to. Every other one keeps the local transport off. */
const REPOSITORY_COMMANDS: ReadonlySet<string> = new Set(['fetch', 'pull', 'push', 'ls-remote', 'clone']);

/** Their options whose value is the next argument, skipped while looking for
 *  the repository. A value taken for the repository refuses the call or
 *  leaves the local transport off: it never opens it to another target. */
const REPOSITORY_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  push: new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']),
  fetch: new Set([
    '-o', '--server-option', '--upload-pack', '--depth', '--deepen', '--shallow-since', '--shallow-exclude',
    '-j', '--jobs', '--negotiation-tip', '--refmap', '--filter', '--recurse-submodules-default', '--submodule-prefix',
  ]),
  pull: new Set([
    '-o', '--server-option', '--upload-pack', '--depth', '--deepen', '--shallow-since', '--shallow-exclude',
    '-j', '--jobs', '--negotiation-tip', '--refmap', '--filter', '-s', '--strategy', '-X', '--strategy-option',
  ]),
  'ls-remote': new Set(['-o', '--server-option', '--upload-pack', '--sort']),
  clone: new Set([
    '-o', '--origin', '-b', '--branch', '-u', '--upload-pack', '--reference', '--reference-if-able',
    '--separate-git-dir', '--depth', '--shallow-since', '--shallow-exclude', '-c', '--config', '--template',
    '-j', '--jobs', '--filter', '--server-option', '--bundle-uri', '--revision',
  ]),
});

/** `url.<base>.insteadOf` rewriting, as git does it: the longest matching
 *  prefix wins. Null when no rule matches. */
function rewriteUrl(url: string, rules: ReadonlyArray<readonly [base: string, prefix: string]>): string | null {
  let best: readonly [string, string] | null = null;
  for (const rule of rules) {
    if (url.startsWith(rule[1]) && (!best || rule[1].length > best[1].length)) best = rule;
  }
  return best ? best[0] + url.slice(best[1].length) : null;
}

/**
 * Every URL the call may reach, once `url.*.insteadOf` and
 * `url.*.pushInsteadOf` rewrote it: those of the remote it names (`url` and
 * `pushurl`), the repository it names when that is no remote, every remote's
 * when it names none. Null for a command that starts no such transport.
 * Over-inclusive on purpose: a URL the call ends up not using costs at worst
 * a refusal, a URL missed would open the local transport to it.
 */
export function reachedGitUrls(args: readonly string[], entries: readonly GitConfigEntry[] | null): string[] | null {
  const { commandIndex } = parseCall(args);
  const command = commandIndex >= 0 ? args[commandIndex]! : '';
  if (!REPOSITORY_COMMANDS.has(command)) return null;
  const remotes = new Map<string, string[]>();
  const insteadOf: Array<[string, string]> = [];
  const pushInsteadOf: Array<[string, string]> = [];
  for (const e of entries ?? []) {
    const remote = /^remote\.(.+)\.(url|pushurl)$/.exec(e.key);
    if (remote && e.value !== null) remotes.set(remote[1]!, [...(remotes.get(remote[1]!) ?? []), e.value]);
    const rule = /^url\.(.+)\.(insteadof|pushinsteadof)$/.exec(e.key);
    if (rule && e.value !== null) (rule[2] === 'insteadof' ? insteadOf : pushInsteadOf).push([rule[1]!, e.value]);
  }
  const valueOptions = REPOSITORY_VALUE_OPTIONS[command] ?? new Set<string>();
  const named: string[] = [];
  let all = false;
  let optionsDone = false;
  const rest = args.slice(commandIndex + 1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!optionsDone && arg === '--') { optionsDone = true; continue; }
    if (!optionsDone && arg.startsWith('-')) {
      if (arg === '--all' || arg === '--multiple') all = true;
      if (arg.startsWith('--repo=')) named.push(arg.slice('--repo='.length));
      else if (arg === '--repo') named.push(rest[i + 1] ?? '');
      if (valueOptions.has(arg)) i++;
      continue;
    }
    named.push(arg);
    // Further arguments are refspecs or a folder; `fetch --multiple` names
    // remotes, and counts as naming them all.
    if (named.length > 0 && !all) break;
  }
  const raw = named.length === 0 || all
    ? [...[...remotes.values()].flat(), ...named.filter((n) => !remotes.has(n))]
    : named.flatMap((n) => remotes.get(n) ?? [n]);
  const urls = new Set<string>();
  for (const url of raw) {
    const fetched = rewriteUrl(url, insteadOf) ?? url;
    urls.add(fetched);
    urls.add(rewriteUrl(url, pushInsteadOf) ?? fetched);
  }
  return [...urls];
}

/**
 * The folder a URL reaches through git's local transport, or null when git
 * would use another one. Mirrors `url_is_local_not_ssh` and the `file://`
 * parsing of git's `connect.c`: a `scp`-like `host:path` is SSH, a URL with a
 * scheme other than `file` is not local, and git decodes `%xx` in a URL.
 */
export function localGitPath(url: string, platform: NodeJS.Platform = process.platform): string | null {
  const windows = platform === 'win32';
  const drive = (s: string) => windows && /^[A-Za-z]:/.test(s);
  if (url.startsWith('file://')) {
    let rest: string;
    try { rest = decodeURIComponent(url.slice('file://'.length)); } catch { rest = url.slice('file://'.length); }
    if (rest.startsWith('/') || drive(rest)) {
      // `file:///C:/repo` names the drive.
      return windows && /^\/[A-Za-z]:/.test(rest) ? rest.slice(1) : rest;
    }
    // `file://server/share/repo`: a UNC path under Windows, the host
    // dropped elsewhere.
    if (windows) return `//${rest}`;
    const slash = rest.indexOf('/');
    return slash < 0 ? '' : rest.slice(slash);
  }
  // A remote helper (`<transport>::<address>`) or another scheme.
  if (/^[A-Za-z0-9][A-Za-z0-9+.-]*::/.test(url) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) return null;
  if (drive(url)) return url;
  const colon = url.indexOf(':');
  const slash = windows ? url.search(/[\\/]/) : url.indexOf('/');
  return colon < 0 || (slash >= 0 && slash < colon) ? url : null;
}

/** The common git directory of the repository at `dir`, when its `.git` is a
 *  file pointing elsewhere (a linked worktree): a fenced mission writes it. */
function linkedGitDir(dir: string, platform: NodeJS.Platform): string | null {
  const path = platform === 'win32' ? win32 : posix;
  try {
    const dotGit = path.join(dir, '.git');
    if (!statSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const gitDir = path.resolve(dir, m[1]!);
    try { return path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { return gitDir; }
  } catch {
    return null;
  }
}

/** `path` with its deepest existing ancestor resolved, links followed. */
function throughExistingAncestor(path: string): string {
  const rest: string[] = [];
  let dir = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(dir), ...rest.reverse());
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return path;
      rest.push(basename(dir));
      dir = parent;
    }
  }
}

/** The folder git works in: the last `-C`, resolved against `cwd`. */
function gitWorkDir(args: readonly string[], cwd: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  const p = platform === 'win32' ? win32 : posix;
  const { location } = parseCall(args);
  let dir = cwd;
  for (let i = 0; i < location.length; i++) {
    if (location[i] === '-C' && location[i + 1]) dir = dir ? p.resolve(dir, location[i + 1]!) : location[i + 1];
  }
  return dir;
}

/**
 * Why git must not reach the local repository at `path`, or null. Its hooks
 * and configuration run on the receiving side, where git drops the daemon's
 * `-c`: the repository must lie where no mission writes. That is outside the
 * folders `missionWritableProblem` refuses, the system folders the fence
 * leaves writable, the repository the call runs in and its git directory.
 * Each of the suffixes git tries (`.git`, `/.git`) is checked, links resolved.
 */
export function localRemoteProblem(
  path: string,
  options: { platform?: NodeJS.Platform; timonHome?: string; cwd?: string; fencedFolders?: readonly string[] } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? win32 : posix;
  if (!path || !p.isAbsolute(path) || (platform === 'win32' && /^[A-Za-z]:(?![\\/])/.test(path))) return 'relative path';
  const also = [...(options.fencedFolders ?? fencedSystemFolders())];
  if (options.cwd && p.isAbsolute(options.cwd)) {
    const cwd = p.resolve(options.cwd);
    // A call made from a filesystem root would refuse every path.
    if (p.parse(cwd).root !== cwd) also.push(cwd);
    const common = linkedGitDir(cwd, platform);
    if (common && p.parse(common).root !== common) also.push(common);
  }
  const spellings = [path, `${path}.git`, p.join(path, '.git'), p.join(`${path}.git`, '.git')];
  // A path that does not exist yet keeps its links unresolved: a mission may
  // create it, behind a link, once the check has passed.
  const candidates = platform === process.platform ? [...spellings, ...spellings.map(throughExistingAncestor)] : spellings;
  for (const candidate of candidates) {
    const problem = missionWritableProblem(candidate, {
      platform,
      alsoRoots: also,
      ...(options.timonHome ? { timonHome: options.timonHome } : {}),
    });
    if (problem) return problem;
  }
  return null;
}

/**
 * The arguments and environment of a daemon git call. `entries` is the result
 * of the scan `gitScanArgs` asked for, null when none was needed: a scan that
 * failed stops the call instead (`generic.ts`). `refused`: the call must not
 * run at all.
 */
export function neutralGitCall(
  args: readonly string[],
  entries: readonly GitConfigEntry[] | null,
  baseEnv: NodeJS.ProcessEnv,
  options: {
    platform?: NodeJS.Platform;
    timonHome?: string;
    submodules?: readonly string[];
    /** Where git runs: a local remote inside it is refused. */
    cwd?: string;
    /** Stands in for the system folders a fenced mission writes, in tests. */
    fencedFolders?: readonly string[];
  } = {},
): { args: string[]; env: NodeJS.ProcessEnv } | { refused: string } {
  const scanned: ScannedGitConfig = entries ? scannedGitConfig(entries) : { config: [], env: {} };
  if (scanned.refused) {
    return { refused: `git refused: the repository configuration sets "${scanned.refused}", which Timon cannot neutralize` };
  }
  const submodules = options.submodules ?? [];
  // `-c` splits at the first `=`: such a name cannot be reached.
  const unreachable = submodules.find((name) => name.includes('='));
  if (unreachable !== undefined) {
    return { refused: `git refused: the submodule "${unreachable}" cannot be kept from running git inside it` };
  }
  // The local transport opens only when every local repository the call may
  // reach lies where no mission writes, and refuses the call otherwise.
  let localTransport = false;
  const workDir = gitWorkDir(args, options.cwd, options.platform);
  for (const url of reachedGitUrls(args, entries) ?? []) {
    const path = localGitPath(url, options.platform);
    if (path === null) continue;
    const problem = localRemoteProblem(path, { ...options, ...(workDir ? { cwd: workDir } : {}) });
    if (problem) {
      return { refused: `git refused: the remote "${path}" is a local repository in a place a mission can write (${problem}); its hooks would run as Timon` };
    }
    localTransport = true;
  }
  const config = [
    ...fixedGitConfig(),
    ...(localTransport ? ['protocol.file.allow=always'] : []),
    ...scanned.config,
    ...submodules.map((name) => `submodule.${name}.ignore=dirty`),
  ].flatMap((pair) => ['-c', pair]);
  const out = [...args];
  const { commandIndex } = parseCall(args);
  const command = commandIndex >= 0 ? args[commandIndex]! : '';
  const flags: string[] = [];
  if (DIFF_COMMANDS.has(command)) flags.push(...['--no-ext-diff', '--no-textconv'].filter((flag) => !args.includes(flag)));
  if (SUBMODULE_STATUS_COMMANDS.has(command)) flags.push('--ignore-submodules=dirty');
  if (QUIET_COMMANDS.has(command) && !args.includes('--quiet') && !args.includes('-q')) flags.push('--quiet');
  if (NO_RECURSE_COMMANDS.has(command)) flags.push('--no-recurse-submodules');
  if (command === 'commit' && !args.slice(commandIndex + 1).some((a) => COMMIT_MESSAGE.test(a))) {
    return { refused: 'git refused: a commit by Timon carries its message on the command line' };
  }
  if (scanned.plantedUploadPack && UPLOAD_PACK_COMMANDS.has(command)) flags.push('--upload-pack=git-upload-pack');
  if (scanned.plantedReceivePack && RECEIVE_PACK_COMMANDS.has(command)) flags.push('--receive-pack=git-receive-pack');
  if ((scanned.plantedUploadPack || scanned.plantedReceivePack) && OTHER_TRANSPORT_COMMANDS.has(command)) {
    return { refused: `git refused: the repository configuration names the program "git ${command}" would start on the remote side` };
  }
  out.splice(commandIndex + 1, 0, ...flags);
  const env = neutralGitEnv(baseEnv, options);
  // It would replace the protocol policy above with its own list.
  for (const key of Object.keys(env)) {
    if ((options.platform ?? process.platform) === 'win32' ? key.toUpperCase() === 'GIT_ALLOW_PROTOCOL' : key === 'GIT_ALLOW_PROTOCOL') delete env[key];
  }
  for (const [key, value] of Object.entries(scanned.env)) {
    if (env[key] === undefined) env[key] = value;
  }
  return { args: ['--no-pager', ...config, ...out], env };
}
