/**
 * How an agent of the registry signs in. A registry entry says nothing about
 * it: what is known comes from the agent's own `initialize` (`authMethods`),
 * read once at install and again when the person asks, and kept in the state.
 *
 * Two uses: the sentence a mission shows when the agent answers `auth_required`
 * (the provider's `signIn`), and the list the settings screen shows, where a
 * method billed per token is marked and never suggested — Timon runs on
 * subscriptions only.
 */
import { recommendedAuthMethod, type AcpAuthMethodInfo, type AcpAuthMethodKind } from '../../backends/acp/auth.js';
import type { AcpSignIn } from '../../backends/acp/auth.js';

/** One method, as the settings screen receives it. */
export type AuthMethodView = {
  id: string;
  name: string;
  description: string | null;
  kind: AcpAuthMethodKind;
  billedPerToken: boolean;
  /** The one Timon suggests; never a method billed per token. */
  recommended: boolean;
  /** The terminal command that signs in, when the agent gave one. */
  command: string | null;
};

/** A word with a space (a Windows profile folder) is quoted; the others were checked to need nothing. */
function shellWord(word: string): string {
  return /\s/.test(word) ? `"${word}"` : word;
}

export function signInCommand(method: AcpAuthMethodInfo, program: string): string | null {
  if (!method.terminal) return null;
  return [shellWord(method.terminal.program ?? program), ...method.terminal.args].join(' ');
}

export function authMethodViews(methods: readonly AcpAuthMethodInfo[], program: string): AuthMethodView[] {
  const recommended = recommendedAuthMethod(methods);
  return methods.map((method) => ({
    id: method.id,
    name: method.name,
    description: method.description,
    kind: method.kind,
    billedPerToken: method.billedPerToken,
    recommended: method === recommended,
    command: signInCommand(method, program),
  }));
}

const quoted = (names: readonly string[]): string => names.map((name) => `“${name}”`).join(', ');

/**
 * The sentence that follows "the agent needs you to sign in first". `methods`
 * null = never read (an agent installed before this was kept, or one that did
 * not answer): the sentence then says where to read them.
 */
export function signInAdviceFor(agentName: string, program: string, methods: readonly AcpAuthMethodInfo[] | null): string {
  if (methods === null || methods.length === 0) {
    return `open Settings → AI models → LLM backends → Providers → ACP registry and use “Sign-in methods” on ${agentName} to see how it signs in`;
  }
  const billed = methods.filter((m) => m.billedPerToken).map((m) => m.name);
  const billedNote = billed.length > 0 ? ` Billed per token, so never used by Timon: ${quoted(billed)}.` : '';
  const pick = recommendedAuthMethod(methods);
  if (!pick) {
    return `every sign-in method ${agentName} offers is billed per token (${quoted(billed)}), and Timon runs on subscriptions only: use another provider`;
  }
  const command = signInCommand(pick, program);
  if (command) return `sign in from a terminal with \`${command}\` (“${pick.name}”), then start the mission again.${billedNote}`;
  return `${agentName} signs in through its own “${pick.name}” step, which an ACP client starts and Timon does not: `
    + `complete it once from a client that offers it, or use the provider of ${agentName}'s own CLI if Timon has one, `
    + `then start the mission again.${billedNote}`;
}

/** The provider's `signIn`: computed from what was read, so the sentence holds whatever the agent announces at run time. */
export function registrySignIn(agentName: string, program: string, methods: readonly AcpAuthMethodInfo[] | null): AcpSignIn {
  return { fallback: signInAdviceFor(agentName, program, methods) };
}
