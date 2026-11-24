'use client';

/**
 * "Discover Timon" (docs/ONBOARDING.md, `Discover`): right after the main agent
 * is made, four quick animated slides on what sets Timon apart — TIMs that
 * work on their own, teams of TIMs, projects whose TIMs never leave them, and
 * everything that plugs in around them. Then the TIMs page, where the agent
 * opens its welcome.
 *
 * Short on purpose: a slide moves on by itself after `DISCOVER_SLIDE_MS` (pointer
 * resting on it holds it), "Next" does not wait, "Skip all" leaves at
 * once, and the last slide waits for the person's own click. No "Back" to
 * the agent step: the agent is made; ← walks back through the slides.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isAgentLook, normalizeAgentLook, DEFAULT_LOOK, type AgentLook } from '@/components/mascot/agent-look';
import { usePrefersReducedMotion } from '@/components/mascot/agent-mascot';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { loadMainAgent, type MainAgentState } from '../agent-create';
import { useOnboarding } from '../onboarding-context';
import {
  autoAdvances, nextSlide, previousSlide, DISCOVER_SLIDE_IDS, DISCOVER_SLIDE_MS, DISCOVER_VIEWS, discoverSegments,
} from '../discover-slides';
import { DISCOVER_DRAWINGS } from '../discover/drawings';

type Lead = { name: string | null; look: AgentLook };

/** The main agent as the agent step left it: its chosen name, its look. */
export function leadOf(state: MainAgentState): Lead {
  return {
    name: state.named && state.name ? state.name : null,
    look: isAgentLook(state.look) ? normalizeAgentLook(state.look) : DEFAULT_LOOK,
  };
}

export type DiscoverStepProps = {
  /** Reads the main agent; a test passes its own. */
  loadAgent?: () => Promise<MainAgentState>;
};

export function DiscoverStep({ loadAgent = loadMainAgent }: DiscoverStepProps): ReactElement {
  const { next, skip } = useOnboarding();
  const reduced = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const [lead, setLead] = useState<Lead>({ name: null, look: DEFAULT_LOOK });

  useEffect(() => {
    let live = true;
    void loadAgent().then((state) => { if (live) setLead(leadOf(state)); });
    return () => { live = false; };
  }, [loadAgent]);

  const forward = useCallback((): void => {
    const to = nextSlide(index);
    if (to === null) next();
    else setIndex(to);
  }, [index, next]);

  const backward = useCallback((): void => {
    const to = previousSlide(index);
    if (to !== null) setIndex(to);
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); forward(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); backward(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [forward, backward]);

  const slide = DISCOVER_SLIDE_IDS[index] ?? DISCOVER_SLIDE_IDS[0];
  const Drawing = DISCOVER_DRAWINGS[slide];
  const last = nextSlide(index) === null;
  const total = DISCOVER_SLIDE_IDS.length;

  return (
    <section
      data-onboarding-step="discover"
      data-discover-slide={slide}
      aria-roledescription={t('onboarding.discover.label')}
      aria-label={t('onboarding.discover.label')}
      className="flex w-full max-w-[880px] flex-col"
    >
      <div className="mb-7 flex gap-1.5">
        {discoverSegments(index).map((state, k) => (
          <button
            key={k}
            type="button"
            data-segment={state}
            aria-label={t('onboarding.discover.slide', { current: k + 1, total })}
            aria-current={state === 'current' ? 'step' : undefined}
            onClick={() => setIndex(k)}
            className="group flex-1 py-1.5 focus-visible:outline-none"
          >
            <span className="relative block h-1 overflow-hidden rounded-full bg-border group-focus-visible:ring-2 group-focus-visible:ring-ring">
              {state === 'done' && <span className="absolute inset-0 rounded-full bg-foreground" />}
              {state === 'current' && (autoAdvances(k, reduced)
                ? (
                  <span
                    key={`fill-${index}`}
                    data-discover-fill
                    className="timon-discover-fill absolute inset-0 origin-left rounded-full bg-foreground"
                    style={{ animationDuration: `${DISCOVER_SLIDE_MS}ms`, animationPlayState: held ? 'paused' : 'running' }}
                    onAnimationEnd={forward}
                  />
                )
                : <span className="absolute inset-0 rounded-full bg-foreground" />)}
            </span>
          </button>
        ))}
      </div>

      {/* The pointer resting on the slide holds it, the time to read; the buttons do not. */}
      <div
        key={slide}
        data-discover-stage
        className="grid w-full grid-cols-1 items-center gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,430px)]"
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
      >
        <div className="text-left">
          <p className="timon-onboarding-rise text-[12.5px] font-medium tabular-nums text-muted-foreground">
            {t('onboarding.discover.slide', { current: index + 1, total })}
          </p>
          <h1 className="timon-onboarding-rise mt-2 text-[30px] font-bold leading-tight tracking-[-0.02em]" style={{ animationDelay: '0.06s' }}>
            {t(`onboarding.discover.${slide}.title`)}
          </h1>
          <p className="timon-onboarding-rise mt-3 text-[15px] leading-relaxed text-muted-foreground" style={{ animationDelay: '0.14s' }}>
            {t(`onboarding.discover.${slide}.body`)}
          </p>
          <div className="timon-onboarding-rise mt-5 flex flex-wrap items-center gap-1.5" style={{ animationDelay: '0.22s' }}>
            <span className="mr-1 text-[12px] text-muted-foreground">{t('onboarding.discover.views.label')}</span>
            {DISCOVER_VIEWS[slide].map((view) => (
              <span key={view} data-discover-view={view} className="rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium">
                {t(`onboarding.discover.views.${view}`)}
              </span>
            ))}
          </div>
        </div>
        <div className="timon-onboarding-fade h-[300px] overflow-hidden rounded-2xl bg-card shadow-elev-3 ring-1 ring-border">
          <Drawing look={lead.look} />
        </div>
      </div>

      <div className="mt-8 flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" data-discover-skip className={cn(last && 'invisible')} onClick={() => skip()}>
          {t('onboarding.discover.skip')}
        </Button>
        <Button type="button" size="lg" data-discover-next={last ? undefined : ''} data-discover-finish={last ? '' : undefined} onClick={forward}>
          {last
            ? (lead.name ? t('onboarding.discover.finish', { name: lead.name }) : t('onboarding.discover.finishNoName'))
            : t('onboarding.discover.next')}
          <ArrowRight className="ml-2 size-4" aria-hidden />
        </Button>
      </div>
    </section>
  );
}
