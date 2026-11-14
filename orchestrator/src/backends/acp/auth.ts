/**
 * What to tell a user whose ACP agent wants a sign-in.
 *
 * `initialize` lists the agent's `authMethods` and `session/new` answers
 * `auth_required` (-32000) until one is done — but a method is a name, not a
 * command, and TIMON cannot run a login for the user (opencode's is a browser
 * flow, Hermes' a terminal wizard). So the message names the step the agent's
 * OWN CLI offers. The commands are data the agent's provider declares, by the
 * method ids it observed; an agent that declared none keeps the generic message
 * built from the method names alone.
 */

/**
 * What an agent's provider writes for a sign-in (`AcpAgentSpec.signIn`): the
 * command its own CLI offers, by the method ids it announces, and one for when
 * none of them is known.
 */
export type AcpSignIn = {
  /** By `authMethods[].id`, the most precise reading. */
  readonly byMethod?: Readonly<Record<string, string>>;
  /** When none of the announced ids is known. */
  readonly fallback: string;
};

function idOf(method: unknown): string | null {
  if (method === null || typeof method !== 'object') return null;
  const id = (method as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * The instruction that answers an `auth_required`, or null for an agent whose
 * provider declared none. `methods` is the raw `authMethods` of `initialize`;
 * nothing the agent wrote is echoed back — only ids are compared.
 */
export function signInAdvice(signIn: AcpSignIn | undefined, methods: unknown): string | null {
  if (!signIn) return null;
  for (const method of Array.isArray(methods) ? methods : []) {
    const id = idOf(method);
    const known = id !== null ? signIn.byMethod?.[id] : undefined;
    if (known) return known;
  }
  return signIn.fallback;
}

/* ── reading `authMethods` ─────────────────────────────────────────────────── */

/**
 * How a method signs in, as ACP describes it: `agent` (the default) is a step the
 * agent runs itself when a client calls `authenticate`; `terminal` is a command
 * the user runs in a terminal; `env_var` reads credentials from variables.
 */
export type AcpAuthMethodKind = 'agent' | 'terminal' | 'env_var';

export type AcpAuthMethodInfo = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: AcpAuthMethodKind;
  /** Paid per token rather than through a subscription (`isBilledPerToken`): Timon never picks it. */
  readonly billedPerToken: boolean;
  /** For a terminal sign-in, what to run (`program: null` is the agent's own program, with `args`); null when its command was unusable. */
  readonly terminal: { readonly program: string | null; readonly args: readonly string[] } | null;
};

const MAX_METHODS = 16;
// A command a person will paste: one word per item, no quote, space or shell character, so nothing the agent wrote
// can turn into a second command. A method whose command does not pass keeps its name, without a command.
export const COMMAND_WORD_RE = /^[A-Za-z0-9._/\\:@+=,-]{1,256}$/;
const MAX_ARGS = 16;

/** Agent text kept for display: no control character, bounded. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean.length > 0 ? clean.slice(0, max) : null;
}

function words(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGS) return null;
  return value.every((arg) => typeof arg === 'string' && COMMAND_WORD_RE.test(arg)) ? value as string[] : null;
}

function terminalOf(method: Record<string, unknown>): AcpAuthMethodInfo['terminal'] {
  if (method.type === 'terminal') {
    const args = words(method.args);
    return args ? { program: null, args } : null;
  }
  // The `terminal-auth` extension some agents announce before the protocol had a `terminal` type.
  const meta = method._meta;
  const ext = meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>)['terminal-auth'] : undefined;
  if (ext === null || typeof ext !== 'object') return null;
  const { command, args } = ext as Record<string, unknown>;
  const list = words(args);
  return typeof command === 'string' && COMMAND_WORD_RE.test(command) && list ? { program: command, args: list } : null;
}

/**
 * Heuristic, on purpose: ACP has no field that says how a method is paid for. A method counts as billed per
 * token when it reads an API key (`type: "env_var"`, or a variable named `*_API_KEY`), or when its id or name
 * names one (`gemini-api-key`) or a pay-per-use cloud platform (`agent-platform` / Vertex AI, Bedrock, Azure).
 * Only the id, the name and the variable names are read — a description saying "no API key needed" must not
 * mark a subscription. It can miss a new vendor's per-token method; the list grows with what the registry shows.
 */
const BILLED_RE = /api[\s_-]?key|vertex|agent[\s_-]?platform|bedrock|azure/i;

export function isBilledPerToken(method: { id: string; name: string; kind: AcpAuthMethodKind; vars?: readonly string[] }): boolean {
  if (method.kind === 'env_var') return true;
  if ((method.vars ?? []).some((name) => /API_KEY/i.test(name))) return true;
  return BILLED_RE.test(method.id) || BILLED_RE.test(method.name);
}

/** The `authMethods` of `initialize`, read defensively: an entry that is not a method is skipped. */
export function readAuthMethods(raw: unknown): AcpAuthMethodInfo[] {
  const out: AcpAuthMethodInfo[] = [];
  for (const candidate of Array.isArray(raw) ? raw.slice(0, MAX_METHODS) : []) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const method = candidate as Record<string, unknown>;
    const id = text(method.id, 128);
    if (!id) continue;
    const name = text(method.name, 120) ?? id;
    const terminal = terminalOf(method);
    const kind: AcpAuthMethodKind = method.type === 'env_var' ? 'env_var' : method.type === 'terminal' || terminal ? 'terminal' : 'agent';
    const vars = Array.isArray(method.vars)
      ? method.vars.flatMap((v) => (v !== null && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string' ? [(v as { name: string }).name] : []))
      : typeof method.varName === 'string' ? [method.varName] : [];
    out.push({
      id, name, description: text(method.description, 500), kind,
      billedPerToken: isBilledPerToken({ id, name, kind, vars }),
      terminal: kind === 'terminal' ? terminal : null,
    });
  }
  return out;
}

/** The method to suggest: a terminal command first, then the agent's own step — never one billed per token. */
export function recommendedAuthMethod(methods: readonly AcpAuthMethodInfo[]): AcpAuthMethodInfo | null {
  const subscription = methods.filter((m) => !m.billedPerToken);
  return subscription.find((m) => m.terminal !== null) ?? subscription.find((m) => m.kind === 'agent') ?? null;
}
