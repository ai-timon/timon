'use client';

/**
 * "What brings you here?" (mockup screen `profile`, right after the LLM):
 * three rows, each with its mascot. A click makes the mascot jump and records
 * the profile on the daemon (`PUT /api/onboarding/profile`); the agent step's
 * creation view follows that answer (`agentViewFor`). The guided tour reads
 * the same row and never asks again.
 *
 * Under it, an optional second question, who the person uses Timon for
 * (`UsageKindChoice`), written on click as well. "Continue" opens the agent
 * step once a profile is chosen; when the agency offer's box is ticked, it
 * first asks the daemon to send the request. A request the site cannot take
 * yet (offline) still lets the person go on: the daemon sends it later.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMe } from '@/hooks/use-me';
import { getLocale, t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  AgencyOfferRequestError, loadUsageKind, looksLikeEmail, saveUsageKind, subscribeAgencyOffer, type UsageKind,
} from '@/lib/agency-offer';
import type { AgentLook } from '@/components/mascot/agent-look';
import { AgentMascotHost } from '@/components/mascot/agent-mascot';
import { useOnboarding } from '../onboarding-context';
import { useOnboardingProfile, type OnboardingProfile } from '../onboarding-profile';
import { UsageKindChoice, type AgencyOfferDraft } from '../usage-kind-choice';

type Row = { profile: OnboardingProfile; look: Partial<AgentLook> };

const ROWS: readonly Row[] = [
  { profile: 'developer', look: { shape: 'hex', color: '#7ed957', eyes: 'pill' } },
  { profile: 'automation', look: { shape: 'cloud', color: '#ff8a2a', eyes: 'pill' } },
  { profile: 'beginner', look: { shape: 'tri', color: '#ff5fbf', eyes: 'big' } },
];

type Problem = null | 'profile' | 'usage' | 'email' | 'offer' | 'offerRefused';

export function ProfileStep(): ReactElement {
  const { next } = useOnboarding();
  const { profile: recorded, save } = useOnboardingProfile();
  const me = useMe();
  const [picked, setPicked] = useState<OnboardingProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [usage, setUsage] = useState<UsageKind | null>(null);
  const [offer, setOffer] = useState<AgencyOfferDraft>({ wanted: false, email: '' });
  const [leaving, setLeaving] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const emailTouched = useRef(false);

  // An answer given earlier (Back, a reload) shows as it stands.
  useEffect(() => {
    let live = true;
    loadUsageKind().then((kind) => { if (live && kind) setUsage((current) => current ?? kind); }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  // The account's address, until the person types their own.
  const accountEmail = me?.user?.email ?? '';
  useEffect(() => {
    if (!emailTouched.current && accountEmail) setOffer((current) => ({ ...current, email: accountEmail }));
  }, [accountEmail]);

  const chosen = picked ?? recorded;

  const choose = async (profile: OnboardingProfile): Promise<void> => {
    if (saving) return;
    setPicked(profile);
    setSaving(true);
    setProblem(null);
    try {
      await save(profile);
    } catch {
      setPicked(null);
      setProblem('profile');
    } finally {
      setSaving(false);
    }
  };

  const chooseUsage = async (kind: UsageKind): Promise<void> => {
    const before = usage;
    setUsage(kind);
    setProblem(null);
    try {
      await saveUsageKind(kind);
    } catch {
      setUsage(before);
      setProblem('usage');
    }
  };

  const changeOffer = (draft: AgencyOfferDraft): void => {
    if (draft.email !== offer.email) emailTouched.current = true;
    setOffer(draft);
    if (problem === 'email' || problem === 'offer' || problem === 'offerRefused') setProblem(null);
  };

  const proceed = async (): Promise<void> => {
    if (!chosen || leaving) return;
    if (usage === 'agency' && offer.wanted) {
      if (!looksLikeEmail(offer.email)) { setProblem('email'); return; }
      setLeaving(true);
      try {
        const view = await subscribeAgencyOffer(offer.email, getLocale());
        if (view.state === 'rejected') { setProblem('offerRefused'); setLeaving(false); return; }
      } catch (error) {
        setProblem(error instanceof AgencyOfferRequestError && error.status === 400 ? 'email' : 'offer');
        setLeaving(false);
        return;
      }
    }
    next();
  };

  const busy = saving || leaving;

  return (
    <section data-onboarding-step="profile" className="flex w-full max-w-[560px] flex-col items-center text-center">
      <h1 className="text-[30px] font-bold leading-tight tracking-[-0.02em]">{t('onboarding.profile.title')}</h1>
      <p className="mb-[26px] mt-2.5 text-[15px] leading-normal text-muted-foreground">{t('onboarding.profile.subtitle')}</p>
      <div
        role="group"
        aria-label={t('onboarding.profile.title')}
        aria-busy={saving}
        className="flex w-full flex-col gap-0.5 rounded-2xl bg-card p-1.5 text-left shadow-elev-3 ring-1 ring-border"
      >
        {ROWS.map((row, i) => (
          <button
            key={row.profile}
            type="button"
            data-profile={row.profile}
            aria-current={recorded === row.profile ? 'true' : undefined}
            aria-pressed={chosen === row.profile}
            disabled={busy}
            onClick={() => { void choose(row.profile); }}
            style={{ animationDelay: `${0.08 * i}s` }}
            className={cn(
              'timon-onboarding-rise group flex w-full items-center gap-3.5 rounded-xl p-3.5 text-left transition-colors',
              'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
              chosen === row.profile && 'bg-muted',
            )}
          >
            <span className={cn('shrink-0', picked === row.profile && 'timon-mascot-jump')}>
              <AgentMascotHost look={row.look} size={46} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14.5px] font-semibold">{t(`onboarding.profile.${row.profile}.title`)}</span>
              <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{t(`onboarding.profile.${row.profile}.description`)}</span>
            </span>
            <ChevronRight
              aria-hidden
              className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-[3px] group-hover:text-foreground"
            />
          </button>
        ))}
      </div>

      <div className="mt-9 w-full">
        <UsageKindChoice
          value={usage}
          disabled={leaving}
          onChoose={(kind) => { void chooseUsage(kind); }}
          offer={offer}
          onOffer={changeOffer}
        />
      </div>

      {problem && (
        <p role="alert" className="mt-3 text-sm text-destructive">{t(PROBLEM_KEYS[problem])}</p>
      )}
      <Button
        type="button"
        data-profile-continue
        className="mt-6 min-w-[180px]"
        disabled={!chosen || busy}
        onClick={() => { void proceed(); }}
      >
        {leaving ? t('onboarding.usage.sending') : t('onboarding.usage.continue')}
      </Button>
      {!chosen && <p className="mt-2 text-[12px] text-muted-foreground">{t('onboarding.usage.pickProfile')}</p>}
    </section>
  );
}

const PROBLEM_KEYS: Record<Exclude<Problem, null>, string> = {
  profile: 'onboarding.profile.failed',
  usage: 'onboarding.usage.failed',
  email: 'onboarding.usage.offer.invalidEmail',
  offer: 'onboarding.usage.offer.failed',
  offerRefused: 'onboarding.usage.offer.refused',
};
