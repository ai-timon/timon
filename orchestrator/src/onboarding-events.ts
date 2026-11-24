/**
 * First-run wizard steps as the rest of the daemon hears them: a closed list
 * of step names and outcomes, published on the bus by the routes that answer
 * them. Product analytics (`@timon/telemetry`) counts where people stop; any
 * other listener gets the same closed words and nothing the person typed.
 */
import { bus } from './bus.js';

export const ONBOARDING_STEPS = [
  'account',
  'configuration',
  'resume',
  'install_service',
  'install_binary',
  'main_agent',
  'agent_chat',
  'restart',
  'team',
] as const;
export type OnboardingStepName = (typeof ONBOARDING_STEPS)[number];

/**
 * `code_sent` / `code_failed`: the setup's email code, which the mail relay
 * accepted to send or not. They sit between the account screen and
 * `account / completed`, so the funnel shows who never got their code.
 */
export const ONBOARDING_STEP_ACTIONS = ['completed', 'skipped', 'failed', 'code_sent', 'code_failed'] as const;
export type OnboardingStepAction = (typeof ONBOARDING_STEP_ACTIONS)[number];

/**
 * Why a setup code did not go out: the error code the route answered, the
 * relay's (offline, service down, rate limited, address refused) or the
 * daemon's own throttling. Never the relay's raw text.
 */
export const ONBOARDING_CODE_FAILURES = [
  'email_connection_required',
  'email_service_unavailable',
  'email_rate_limited',
  'email_rejected',
  'email_code_too_soon',
  'email_code_origin_limited',
  'email_code_busy',
  'email_code_send_limit',
  'email_code_expired',
  'install_id_unavailable',
] as const;
export type OnboardingCodeFailure = (typeof ONBOARDING_CODE_FAILURES)[number];

/**
 * How the first account was made: `code` = the address confirmed with its
 * email code, `operator` = from the terminal (`timon init`, `timon user
 * create-admin`), `no_code` = a browser setup on a daemon that asks no code.
 */
export const ONBOARDING_ACCOUNT_VIA = ['code', 'operator', 'no_code'] as const;
export type OnboardingAccountVia = (typeof ONBOARDING_ACCOUNT_VIA)[number];

/** What a step may add to its outcome, each from a closed list. */
export type OnboardingStepDetail = {
  /** `code_sent`: a resend rather than the first code. */
  resend?: boolean;
  /** `code_failed`: why. */
  reason?: OnboardingCodeFailure;
  /** `account / completed`: how the account was made. */
  via?: OnboardingAccountVia;
};

/** Never throws: a listener's failure must not turn a wizard answer into a 500. */
export function onboardingStep(step: OnboardingStepName, action: OnboardingStepAction, detail: OnboardingStepDetail = {}): void {
  try {
    bus.publish({ kind: 'onboarding_step', step, action, ...detail });
  } catch {
    /* the step itself succeeded; its announcement is best effort */
  }
}

/**
 * The onboarding's screens as the web app shows them (`app/src/components/
 * onboarding/onboarding-flow.ts`, `ONBOARDING_STEP_IDS` then
 * `RETURNING_STEP_IDS`; `telemetry-v2.test.ts` holds the two lists together).
 * They are not the wizard routes above: a screen may call none, or several.
 */
export const ONBOARDING_SCREENS = ['splash', 'background', 'account', 'llm', 'profile', 'agent', 'discover', 'signin', 'mascot'] as const;
export type OnboardingScreen = (typeof ONBOARDING_SCREENS)[number];

/** `viewed` once per display; then how the person left it. */
export const ONBOARDING_SCREEN_ACTIONS = ['viewed', 'completed', 'skipped', 'back'] as const;
export type OnboardingScreenAction = (typeof ONBOARDING_SCREEN_ACTIONS)[number];

/** "Choose your LLM": the subscription the person pays for, or local models. */
export const ONBOARDING_LLM_CHOICES = ['plan', 'local'] as const;
/** Whether an AI the chat can start on was found when the person went on. */
export const ONBOARDING_LLM_CONNECTIONS = ['ok', 'failed', 'unknown'] as const;
/** Why none was: not downloaded, known to be signed out, or the list could not be read. */
export const ONBOARDING_LLM_FAILURES = ['not_installed', 'signed_out', 'unreachable'] as const;
