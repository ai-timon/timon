/**
 * The onboarding's order, pure: which step follows which, which ones carry a
 * progress dot, where "Back" leads (docs/ONBOARDING.md).
 *
 * The steps themselves live in `steps/registry.tsx`; this module only knows
 * their ids, so the order can be tested without rendering anything.
 */

/**
 * The steps of the 04/11/2026 mockup, in order. `background` asks whether
 * Timon keeps running once the user logs out: the service is installed right
 * after the welcome, so the answer comes first (`steps/background.tsx`). The agent step makes the main
 * agent; "Discover Timon" follows (`discover`, the maintainer's request of 05/11/2026):
 * a few animated slides on what a lone general agent does not do —
 * autonomous TIMs, teams, project agents that never leave their project. The
 * conversation that followed is now the main agent's welcome, on the TIMs
 * page (`WELCOME_PATH`, the maintainer's decision of 05/11/2026), and the shell leaves
 * the onboarding there once the slides are over or skipped (`afterLastStep`).
 */
export const ONBOARDING_STEP_IDS = ['splash', 'background', 'account', 'llm', 'profile', 'agent', 'discover'] as const;

/**
 * The former last step, `?step=chat`: an address a tab opened before the
 * welcome moved may still hold. It leads to the welcome, not to the splash.
 */
export const FORMER_CHAT_STEP = 'chat';

/** Is this the address of the former chat step (`/onboarding?step=chat`)? */
export function asksFormerChatStep(search: string): boolean {
  return new URLSearchParams(search).get('step') === FORMER_CHAT_STEP;
}

/**
 * Steps outside that order, for an account made before the new onboarding
 * (docs/ONBOARDING.md, `Upgrade welcome`): the welcome leads to `signin`
 * instead of `account`, and `signin` to `mascot`. Neither has "Back" nor a
 * dot, and "Continue" never reaches them: each step goes on by itself.
 */
export const RETURNING_STEP_IDS = ['signin', 'mascot'] as const;

export type OnboardingStepId = typeof ONBOARDING_STEP_IDS[number] | typeof RETURNING_STEP_IDS[number];

/**
 * The progress dots cover the background choice up to the agent: the welcome splash is
 * not a step to count, and "Discover Timon" has its own progress bars.
 * Without a dot it has no "Back" either: the agent is made, behind it.
 */
export const DOTTED_STEPS: readonly OnboardingStepId[] = ['background', 'account', 'llm', 'profile', 'agent'];

export const ONBOARDING_PATH = '/onboarding';

/**
 * The main agent's repair screen (`/setup/agent`) reached from the onboarding.
 * The marker tells it the "Choose your LLM" step already showed the provider
 * cards, so its own "Your AIs" is not shown a second time.
 */
export const SETUP_AGENT_FROM_ONBOARDING = '/setup/agent?from=onboarding';

/** Was this screen opened by the onboarding (`?from=onboarding`)? */
export function openedFromOnboarding(search: string): boolean {
  return new URLSearchParams(search).get('from') === 'onboarding';
}

/**
 * Does the login hand this install over to the welcome? Before the first
 * account exists (`needsSetup`): the account is made by the onboarding's
 * account step, the login only signs in. And while an account made before the
 * new onboarding has to sign in again (`welcome: 'returning'`): it meets the
 * welcome, then signs in from the onboarding.
 */
export function loginOpensWelcome(needsSetup: boolean, welcome: 'returning' | 'mascot' | null = null): boolean {
  return needsSetup || welcome === 'returning';
}

/** Where the welcome's "Continue" leads: the sign-in for an install that already has its account. */
export function afterSplash(returning: boolean): OnboardingStepId {
  return returning ? 'signin' : 'background';
}

export function isOnboardingStepId(value: unknown): value is OnboardingStepId {
  return typeof value === 'string'
    && ((ONBOARDING_STEP_IDS as readonly string[]).includes(value) || (RETURNING_STEP_IDS as readonly string[]).includes(value));
}

const inFlow = (id: OnboardingStepId): number => (ONBOARDING_STEP_IDS as readonly string[]).indexOf(id);

export function nextStep(id: OnboardingStepId): OnboardingStepId | null {
  const i = inFlow(id);
  return i < 0 ? null : ONBOARDING_STEP_IDS[i + 1] ?? null;
}

/** The last step of the order: its "Continue" leaves the onboarding (the out-of-order steps go on by themselves). */
export function isLastStep(id: OnboardingStepId): boolean {
  return id === ONBOARDING_STEP_IDS[ONBOARDING_STEP_IDS.length - 1];
}

export function previousStep(id: OnboardingStepId): OnboardingStepId | null {
  const i = inFlow(id);
  return i > 0 ? ONBOARDING_STEP_IDS[i - 1] ?? null : null;
}

/** "Back" shows on the dotted steps only: nothing comes before the welcome splash. */
export function canGoBack(id: OnboardingStepId): boolean {
  return DOTTED_STEPS.includes(id) && previousStep(id) !== null;
}

export type DotState = 'done' | 'current' | 'todo';

/** One state per dot, or `null` when this step shows no dots. */
export function progressDots(id: OnboardingStepId): DotState[] | null {
  const at = DOTTED_STEPS.indexOf(id);
  if (at < 0) return null;
  return DOTTED_STEPS.map((_, k) => (k < at ? 'done' : k === at ? 'current' : 'todo'));
}

/** The step a URL asks for (`/onboarding?step=llm`), the welcome when it names none or an unknown one. */
export function stepFromSearch(search: string): OnboardingStepId {
  const asked = new URLSearchParams(search).get('step');
  return isOnboardingStepId(asked) ? asked : 'splash';
}

/** The address of a step: the welcome has none of its own, every other step can be reopened by its URL. */
export function stepHref(id: OnboardingStepId): string {
  return id === 'splash' ? ONBOARDING_PATH : `${ONBOARDING_PATH}?step=${id}`;
}
