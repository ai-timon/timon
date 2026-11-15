'use client';

/**
 * The onboarding's frame (docs/ONBOARDING.md): one full-screen stage, the
 * progress dots above it, "Back" in one corner, the light/dark switch in the
 * other (with the 3D / 2D mascot switch beside it on the welcome, whose
 * avalanche shows the choice at once), and the current step from
 * `steps/registry.tsx` inside. It decides nothing about any step — it moves
 * between them, as a View Transition unless the reader asked for reduced
 * motion.
 *
 * Mounted by the `/onboarding` route, outside `(main)`: no top bar, no nav.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchCapabilities } from '@/lib/capabilities';
import { getLocale, t } from '@/lib/i18n';
import { welcomeLanding } from '@/app/setup/agent/setup-landing';
import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from '@/components/mascot/agent-mascot';
import { MascotStyleToggle } from '@/components/mascot/look-styler/mascot-style-switch';
import { applyLanguage } from './language';
import { SchemeSwitch } from './scheme-switch';
import { OnboardingProvider, type OnboardingNav } from './onboarding-context';
import {
  asksFormerChatStep, canGoBack, DOTTED_STEPS, isLastStep, nextStep, previousStep, progressDots, stepFromSearch, stepHref, type OnboardingStepId,
} from './onboarding-flow';
import { ONBOARDING_COMPANIONS, ONBOARDING_GATE, ONBOARDING_STEPS, type OnboardingCompanion, type OnboardingStepEntry } from './steps/registry';
import type { OnboardingGate } from './service-gate';

/** Runs `swap` inside a View Transition styled for the onboarding, or straight away. */
function transition(swap: () => void, reduced: boolean): void {
  if (reduced || typeof document.startViewTransition !== 'function') {
    swap();
    return;
  }
  const root = document.documentElement;
  root.dataset.timonVt = 'onboarding';
  const vt = document.startViewTransition(() => { flushSync(swap); });
  void vt.finished.finally(() => { delete root.dataset.timonVt; });
}

type Position = { step: OnboardingStepId; direction: 1 | -1 };

/**
 * Out of the onboarding, once the main agent is made: its welcome, on the TIMs
 * page. A full load, so the app's client host reads the install afresh.
 */
export async function afterLastStep(): Promise<void> {
  window.location.assign(welcomeLanding(await fetchCapabilities(true).catch(() => null)));
}

export type OnboardingShellProps = {
  /** The registry's; a test passes its own. */
  steps?: readonly OnboardingStepEntry[];
  companions?: readonly OnboardingCompanion[];
  /** Decides whether the current step may mount (the service steps wait for the service). */
  gate?: OnboardingGate;
  /** What "Continue" does on the last step; `afterLastStep` unless a test passes its own. */
  finish?: () => void;
};

export function OnboardingShell({
  steps = ONBOARDING_STEPS, companions = ONBOARDING_COMPANIONS, gate: Gate = ONBOARDING_GATE, finish,
}: OnboardingShellProps): ReactElement | null {
  // `null` until the URL is read: a reload on `?step=llm` must not flash the welcome.
  const [at, setAt] = useState<Position | null>(null);
  const [, setLanguageShown] = useState(getLocale);
  const reduced = usePrefersReducedMotion();
  const backHandler = useRef<(() => boolean) | null>(null);
  const current = useRef<OnboardingStepId>('splash');
  const motion = useRef(reduced);
  motion.current = reduced;
  const finishRef = useRef(finish ?? (() => { void afterLastStep(); }));
  finishRef.current = finish ?? finishRef.current;

  useEffect(() => {
    // A tab still on the former chat step goes where that conversation lives now.
    if (asksFormerChatStep(window.location.search)) { finishRef.current(); return; }
    const step = stepFromSearch(window.location.search);
    current.current = step;
    setAt({ step, direction: 1 });
  }, []);

  const goTo = useCallback((step: OnboardingStepId, direction: 1 | -1 = 1): void => {
    if (step === current.current) return;
    current.current = step;
    // The address follows the step, so a reload reopens it; Next keeps its own history state.
    window.history.replaceState(window.history.state, '', stepHref(step));
    transition(() => {
      backHandler.current = null;
      setAt({ step, direction });
    }, motion.current);
  }, []);

  const next = useCallback((): void => {
    const step = nextStep(current.current);
    if (step) goTo(step, 1);
    else if (isLastStep(current.current)) finishRef.current();
  }, [goTo]);

  const back = useCallback((): void => {
    const step = previousStep(current.current);
    if (step) goTo(step, -1);
  }, [goTo]);

  const setLanguage = useCallback(async (tag: string): Promise<string> => {
    const active = await applyLanguage(tag, document);
    setLanguageShown(active);
    return active;
  }, []);

  const setBackHandler = useCallback((handler: (() => boolean) | null): void => {
    backHandler.current = handler;
  }, []);

  const nav = useMemo<OnboardingNav | null>(() => (at
    ? { step: at.step, direction: at.direction, next, back, goTo: (id) => goTo(id, 1), setLanguage, setBackHandler }
    : null), [at, next, back, goTo, setLanguage, setBackHandler]);

  if (!at || !nav) return null;

  const entry = steps.find((candidate) => candidate.id === at.step);
  const Step = entry?.Component;
  const stays = entry?.leavesPage !== true;
  const dots = progressDots(at.step);
  const onBack = (): void => {
    if (backHandler.current?.()) return;
    back();
  };

  return (
    <OnboardingProvider value={nav}>
      <div className="fixed inset-0 overflow-hidden bg-background text-foreground">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ backgroundImage: 'radial-gradient(ellipse 55% 45% at 50% 15%, hsl(var(--primary) / 0.10), transparent 70%)' }}
        />
        {dots && (
          <div className="absolute left-1/2 top-[22px] z-20 flex -translate-x-1/2 gap-[7px]">
            <span className="sr-only">
              {t('onboarding.progress', { current: DOTTED_STEPS.indexOf(at.step) + 1, total: DOTTED_STEPS.length })}
            </span>
            {dots.map((state, k) => (
              <i
                key={k}
                aria-hidden
                data-dot={state}
                className={cn(
                  'timon-onboarding-dot block h-1.5 rounded-full',
                  state === 'current' ? 'w-[22px] bg-foreground' : 'w-1.5',
                  state === 'done' && 'bg-muted-foreground',
                  state === 'todo' && 'bg-border',
                )}
              />
            ))}
          </div>
        )}
        {canGoBack(at.step) && (
          <Button variant="ghost" size="sm" className="absolute left-4 top-3.5 z-20 gap-1" onClick={onBack}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
            {t('onboarding.back')}
          </Button>
        )}
        <div className="absolute right-4 top-3.5 z-20 flex items-center gap-2">
          {at.step === 'splash' && <MascotStyleToggle />}
          <SchemeSwitch />
        </div>
        <main className="absolute inset-0 flex flex-col items-center justify-center overflow-auto p-8">
          {Step && <Gate step={at.step}><Step key={at.step} /></Gate>}
        </main>
        {companions.map((Companion, i) => <Companion key={i} step={at.step} stays={stays} />)}
      </div>
    </OnboardingProvider>
  );
}
