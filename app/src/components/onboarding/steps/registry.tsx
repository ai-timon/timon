/**
 * The onboarding's steps, in order (docs/ONBOARDING.md).
 *
 * One file per step under `steps/`, one line here: an import and this line,
 * nothing in the shell. Every step has shipped; a step that is not ready yet
 * stands in with `legacyStep(href | null)` (`legacy-step.tsx`). The order is
 * `ONBOARDING_STEP_IDS`, then the out-of-order `RETURNING_STEP_IDS`; the test
 * holds them together.
 *
 * `companions` render beside every step (a status that follows the reader
 * through the whole onboarding): one line each, same rule. The `gate` wraps the
 * current step and decides whether it may mount yet.
 *
 * `leavesPage` marks a stand-in that opens another screen (a full
 * navigation): the shell tells the companions, which start nothing on a page
 * about to unload (`preparationStarts`). The gate needs no such flag: it does
 * not mount a step it holds, so a held stand-in cannot leave.
 */
import type { ComponentType } from 'react';
import type { OnboardingStepId } from '../onboarding-flow';
import { PreparationCard } from '../preparation-card';
import { ServiceGate, type OnboardingGate } from '../service-gate';
import { AccountStep } from './account';
import { AgentStep } from './agent';
import { BackgroundStep } from './background';
import { LlmStep } from './llm';
import { MascotStep } from './mascot';
import { ProfileStep } from './profile';
import { SigninStep } from './signin';
import { SplashStep } from './splash';
import { DiscoverStep } from './discover';

export type OnboardingStepEntry = {
  id: OnboardingStepId;
  Component: ComponentType;
  /** The step opens another screen: this page unloads as soon as it mounts. */
  leavesPage?: true;
};

export const ONBOARDING_STEPS: readonly OnboardingStepEntry[] = [
  { id: 'splash', Component: SplashStep },
  { id: 'background', Component: BackgroundStep },
  { id: 'account', Component: AccountStep },
  { id: 'llm', Component: LlmStep },
  { id: 'profile', Component: ProfileStep },
  { id: 'agent', Component: AgentStep },
  { id: 'discover', Component: DiscoverStep },
  // Outside the order: the upgrade welcome of an account made before this onboarding (`RETURNING_STEP_IDS`).
  { id: 'signin', Component: SigninStep },
  { id: 'mascot', Component: MascotStep },
];

/** Shown on every step, given the current one and whether it stays on this page. */
export type OnboardingCompanion = ComponentType<{ step: OnboardingStepId; stays: boolean }>;

export const ONBOARDING_COMPANIONS: readonly OnboardingCompanion[] = [
  // "Preparing Timon": the service installed in the background (docs/ONBOARDING-PREPARATION.md).
  PreparationCard,
];

/**
 * Wraps every step: the agent step waits for the daemon service
 * (`SERVICE_STEPS`, `@/lib/setup-plan`), stand-ins included; the other steps
 * pass through.
 */
export const ONBOARDING_GATE: OnboardingGate = ServiceGate;
