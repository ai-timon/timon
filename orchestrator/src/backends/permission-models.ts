/**
 * The three ways a CLI can be made to respect Timon's permission policy
 * (`PermissionModel`), and what a dialect owes for each.
 *
 *   mcp-bridge — the CLI asks an injected MCP tool before every tool use that is
 *                not pre-approved: the dialect passes that tool's name
 *                (`CLAUDE_PERMISSION_PROMPT_TOOL`) and declares `timon_ask`.
 *                The answer is an Allow/Deny card and a classifier.
 *   sandbox    — nothing can be asked mid-turn; privileges are frozen at spawn.
 *                The dialect turns `permission_mode` into the CLI's own level
 *                (`sandboxLevelForPermissionMode` is the usual three).
 *   protocol   — the agent asks through its protocol (ACP
 *                `session/request_permission`); the session driver forwards it
 *                to `SessionHost.requestPermission`.
 *
 * A leaf of the backends module: the mapping is moved verbatim out of
 * le plugin `provider-codex` (`official-providers/provider-codex/lib/codex.js`).
 */

/** Map our agent.permission_mode → a sandbox level, as Codex's `--sandbox` has
 *  them. Only three levels (read-only / workspace-write / danger-full-access),
 *  so this is a coarser knob than Claude's permission system. Any dialect whose
 *  permission model is `sandbox` can reuse it. */
export function sandboxLevelForPermissionMode(permissionMode: string | undefined): string {
  switch (permissionMode) {
    case 'plan':
    case 'read-only':
      return 'read-only';
    case 'bypassPermissions':
    case 'danger-full-access':
      return 'danger-full-access';
    case 'auto':
    case 'acceptEdits':
    case 'default':
    case undefined:
    default:
      return 'workspace-write';
  }
}

/** What a dialect declaring `model` must be able to do — as sentences, for the
 *  registration check and the docs. `none` owes nothing: it is an admission. */
export const PERMISSION_MODEL_OBLIGATIONS: Readonly<Record<'mcp-bridge' | 'sandbox' | 'protocol' | 'none', string>> = {
  'mcp-bridge': 'pass the permission tool to the CLI at spawn and declare the `timon_ask` MCP server',
  sandbox: 'freeze the privileges at spawn from `permission_mode`; there is no card and no classifier',
  protocol: 'supply `openSession`: its driver forwards the agent\'s permission requests to `host.requestPermission`',
  none: 'nothing — the CLI runs everything unguarded, which the UI says plainly',
};

/**
 * The permission modes an agent may be given, as stored in its config (the
 * Claude names: `canonicalPermissionMode` turns a sandbox name into one of
 * these before it is written). What a provider lists in
 * `PermissionStrategy.supportedModes`.
 */
export const PERMISSION_MODES = ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Where every mode a provider does not support lands: the one that runs no tool. */
export const UNSUPPORTED_MODE_FALLBACK: PermissionMode = 'plan';

/** The sandbox names, as the mode they mean (`canonicalPermissionMode`). */
const SANDBOX_NAMES: ReadonlyMap<string, PermissionMode> = new Map([
  ['read-only', 'plan'],
  ['workspace-write', 'auto'],
  ['danger-full-access', 'bypassPermissions'],
]);

/**
 * The mode an agent really runs in on a provider that declares the only modes
 * it can honour (`PermissionStrategy.supportedModes`).
 *
 * Fail-closed: a mode in the list (or the sandbox name of one) runs as itself,
 * anything else — another mode, an unset one, a typo — runs in `plan`. A mode
 * is never raised: a provider that cannot ask for an approval does not turn
 * `default` into `bypassPermissions`. No list = the provider honours every
 * mode, and `mode` is returned untouched.
 */
export function resolveSupportedPermissionMode(
  mode: string | null | undefined,
  supported: readonly string[] | null | undefined,
): string | undefined {
  if (!supported) return mode ?? undefined;
  if (typeof mode === 'string') {
    if (supported.includes(mode)) return mode;
    const named = SANDBOX_NAMES.get(mode);
    if (named && supported.includes(named)) return named;
  }
  return UNSUPPORTED_MODE_FALLBACK;
}

/* ── A CLI's own sandbox inside Timon's mission fence ───────────────────── */

/**
 * A CLI whose own sandbox cannot run inside Timon's mission fence
 * (`PermissionStrategy.nestedSandbox`). Kernel sandboxes do not nest: bwrap
 * needs a mount namespace the fence's `no_new_privs` and Landlock domain
 * refuse (`bwrap: Failed to make / slave`), and Seatbelt refuses a second
 * profile (`sandbox_apply: Operation not permitted`). A fenced launch turns
 * the CLI's sandbox off as declared here, and the fence applies the level
 * that sandbox would have: under a read-only level, the mission's working
 * tree is read-only. An unfenced launch is left exactly as the provider built it.
 */
export type NestedSandboxDeclaration = {
  /**
   * The option of the launch that names the CLI's sandbox level (`--sandbox`,
   * as `--sandbox <level>` or `--sandbox=<level>`), the value that turns the
   * sandbox off, and the levels under which the CLI writes nothing.
   */
  readonly level?: {
    readonly flag: string;
    readonly off: string;
    readonly readOnly?: readonly string[];
  };
  /** Arguments put in front of a fenced launch's own, that keep the CLI's sandbox off whatever its settings say. */
  readonly offArgs?: readonly string[];
};

const NESTED_FLAG = /^--?[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const NESTED_MAX_ARGS = 8;
const NESTED_MAX_ARG_CHARS = 512;

/** Why `value` cannot be a `nestedSandbox` declaration, as sentences for its author; `[]` when it can. */
export function nestedSandboxProblems(value: unknown, where = 'permission.nestedSandbox'): string[] {
  const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const plainArg = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= NESTED_MAX_ARG_CHARS && !v.includes('\0');
  if (!isRecord(value)) return [`\`${where}\` must be \`{ level?, offArgs? }\``];
  const problems: string[] = [];
  const unknownKeys = Object.keys(value).filter((key) => key !== 'level' && key !== 'offArgs');
  if (unknownKeys.length > 0) problems.push(`\`${where}\` has unknown keys ${unknownKeys.map((k) => JSON.stringify(k)).join(', ')}; known: 'level', 'offArgs'`);
  if (value.level === undefined && value.offArgs === undefined) {
    problems.push(`\`${where}\` must say how to turn the CLI's sandbox off: \`level\`, \`offArgs\` or both`);
  }
  if (value.level !== undefined) {
    const level = value.level;
    if (!isRecord(level)) problems.push(`\`${where}.level\` must be \`{ flag, off, readOnly? }\``);
    else {
      if (typeof level.flag !== 'string' || !NESTED_FLAG.test(level.flag)) {
        problems.push(`\`${where}.level.flag\` must be an option name such as '--sandbox'`);
      }
      if (!plainArg(level.off)) problems.push(`\`${where}.level.off\` must be the non-empty value that turns the CLI's sandbox off`);
      if (level.readOnly !== undefined) {
        if (!Array.isArray(level.readOnly) || !level.readOnly.every(plainArg)) {
          problems.push(`\`${where}.level.readOnly\` must be a list of level values`);
        } else if ((level.readOnly as unknown[]).includes(level.off)) {
          problems.push(`\`${where}.level.readOnly\` cannot list the value that turns the sandbox off`);
        }
      }
    }
  }
  if (value.offArgs !== undefined) {
    const args = value.offArgs;
    if (!Array.isArray(args) || args.length === 0 || args.length > NESTED_MAX_ARGS || !args.every(plainArg)) {
      problems.push(`\`${where}.offArgs\` must be 1 to ${NESTED_MAX_ARGS} non-empty arguments of at most ${NESTED_MAX_ARG_CHARS} characters`);
    }
  }
  return problems;
}

export type FencedArgs = {
  readonly args: string[];
  /** The CLI's sandbox would have written nothing: the fence keeps the working tree read-only. */
  readonly readOnly: boolean;
  /** The declared level option is not in the launch: nothing was replaced. */
  readonly levelMissing: boolean;
};

/**
 * The arguments of a launch the fence wraps, with the CLI's own sandbox turned
 * off as `declaration` says. Every occurrence of the level option is replaced,
 * and the most restrictive one decides: a single read-only level keeps the
 * working tree read-only. Pure.
 */
export function argsUnderFence(args: readonly string[], declaration: NestedSandboxDeclaration | undefined): FencedArgs {
  if (!declaration) return { args: [...args], readOnly: false, levelMissing: false };
  const out = [...(declaration.offArgs ?? []), ...args];
  const level = declaration.level;
  if (!level) return { args: out, readOnly: false, levelMissing: false };
  const readOnlyLevels = level.readOnly ?? [];
  const prefix = `${level.flag}=`;
  let found = false;
  let readOnly = false;
  for (let i = (declaration.offArgs ?? []).length; i < out.length; i++) {
    const arg = out[i] ?? '';
    if (arg === level.flag && i + 1 < out.length) {
      found = true;
      if (readOnlyLevels.includes(out[i + 1] ?? '')) readOnly = true;
      out[i + 1] = level.off;
      i++;
    } else if (arg.startsWith(prefix)) {
      found = true;
      if (readOnlyLevels.includes(arg.slice(prefix.length))) readOnly = true;
      out[i] = `${prefix}${level.off}`;
    }
  }
  return { args: out, readOnly, levelMissing: !found };
}
