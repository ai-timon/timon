'use client';

/**
 * What a step of the onboarding gets from the shell (`onboarding-shell.tsx`):
 * where it is, how to move on, how to take "Back" for its own sub-views.
 *
 * A step never imports the shell, nor another step: it reads this context.
 * That is what lets each step of the onboarding live in its own file.
 */
import { createContext, useContext, useEffect, useRef } from 'react';
import type { OnboardingStepId } from './onboarding-flow';
import type { OnboardingScreenDetail } from '@/lib/usage-events';

export type OnboardingNav = {
  step: OnboardingStepId;
  /** `1` when this step was reached going forward, `-1` through "Back". */
  direction: 1 | -1;
  /** To the step after this one. */
  next: () => void;
  /** To the step before this one — after a sub-view's own "Back" declined. */
  back: () => void;
  goTo: (id: OnboardingStepId) => void;
  /**
   * Steps over this step without the person answering it (nothing to ask, an
   * account already made, "Skip all"), in the direction given (forward by
   * default). The funnel counts it `skipped`, not `completed`.
   */
  skip: (direction?: 1 | -1) => void;
  /** What the funnel's `completed` of this step carries ("Choose your LLM": the choice and its outcome). */
  setOutcome: (detail: OnboardingScreenDetail) => void;
  /**
   * Switches the interface language at once (cookie, `<html lang>`, every
   * `t()` of the onboarding). Resolves with the language actually applied.
   */
  setLanguage: (tag: string) => Promise<string>;
  /** Registers what "Back" does first; `useOnboardingBack` is the way to call it. */
  setBackHandler: (handler: (() => boolean) | null) => void;
};

const OnboardingContext = createContext<OnboardingNav | null>(null);

export const OnboardingProvider = OnboardingContext.Provider;

export function useOnboarding(): OnboardingNav {
  const nav = useContext(OnboardingContext);
  if (!nav) throw new Error('useOnboarding() outside the onboarding shell');
  return nav;
}

/**
 * A step with sub-views (an email then its code, a list then a detail) takes
 * "Back" for itself: `handler` returns `true` when it went back inside the
 * step, `false` to let the shell open the previous step.
 */
export function useOnboardingBack(handler: () => boolean): void {
  const { setBackHandler } = useOnboarding();
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    setBackHandler(() => latest.current());
    return () => setBackHandler(null);
  }, [setBackHandler]);
}
