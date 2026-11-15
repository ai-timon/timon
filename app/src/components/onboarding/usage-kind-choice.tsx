'use client';

/**
 * "Who do you use Timon for?", the second question of the profile step: three
 * rows in the same card style as the profile, optional. The agency row
 * carries the partner badge; once chosen, the offer opens under it with an
 * unticked box and the account's address, which the person may change.
 *
 * The answer is written to the daemon on click (`saveUsageKind`), so a change
 * of mind is a change; the offer request is sent by the step's "Continue",
 * only when the box is ticked (`subscribeAgencyOffer`).
 */
import { useId, type ReactElement } from 'react';
import { Building2, Check, Handshake, UserRound } from 'lucide-react';
import { t } from '@/lib/i18n';
import { settingsAccountPath } from '@/lib/settings-path';
import { cn } from '@/lib/utils';
import { USAGE_KINDS, type UsageKind } from '@/lib/agency-offer';

const ICONS: Record<UsageKind, typeof UserRound> = { solo: UserRound, team: Building2, agency: Handshake };

export type AgencyOfferDraft = { wanted: boolean; email: string };

export function UsageKindChoice({
  value,
  disabled,
  onChoose,
  offer,
  onOffer,
}: {
  value: UsageKind | null;
  disabled: boolean;
  onChoose: (kind: UsageKind) => void;
  offer: AgencyOfferDraft;
  onOffer: (next: AgencyOfferDraft) => void;
}): ReactElement {
  const titleId = useId();
  const emailId = useId();
  return (
    <div className="flex w-full flex-col items-center">
      <h2 id={titleId} className="text-[20px] font-semibold leading-tight tracking-[-0.01em]">{t('onboarding.usage.title')}</h2>
      <p className="mb-4 mt-1.5 text-[13px] text-muted-foreground">{t('onboarding.usage.optional')}</p>
      <div
        role="group"
        aria-labelledby={titleId}
        className="flex w-full flex-col gap-0.5 rounded-2xl bg-card p-1.5 text-left shadow-elev-3 ring-1 ring-border"
      >
        {USAGE_KINDS.map((kind) => {
          const Icon = ICONS[kind];
          const chosen = value === kind;
          return (
            <button
              key={kind}
              type="button"
              data-usage-kind={kind}
              aria-pressed={chosen}
              disabled={disabled}
              onClick={() => onChoose(kind)}
              className={cn(
                'group flex w-full items-center gap-3.5 rounded-xl p-3.5 text-left transition-colors',
                'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
                chosen && 'bg-muted',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-[46px] shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground transition-colors',
                  chosen && 'bg-primary text-primary-foreground',
                )}
              >
                <Icon className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 text-[14.5px] font-semibold">
                  {t(`onboarding.usage.${kind}.title`)}
                  {kind === 'agency' && (
                    <span data-agency-badge className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
                      {t('onboarding.usage.agency.badge')}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{t(`onboarding.usage.${kind}.description`)}</span>
              </span>
              <span
                aria-hidden
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full text-primary-foreground transition-colors',
                  chosen ? 'bg-primary' : 'bg-transparent',
                )}
              >
                {chosen && <Check className="size-3.5" />}
              </span>
            </button>
          );
        })}
      </div>

      {value === 'agency' && (
        <div data-agency-offer className="timon-onboarding-rise mt-3 w-full rounded-2xl bg-primary/[0.07] p-4 text-left ring-1 ring-primary/20">
          <p className="text-[13.5px] font-semibold">{t('onboarding.usage.offer.title')}</p>
          <ul className="mt-2 space-y-1.5">
            {(['early', 'partners', 'discount'] as const).map((line) => (
              <li key={line} className={cn('flex items-start gap-2 text-[13px] leading-snug', line === 'discount' && 'font-semibold')}>
                <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span>{t(`onboarding.usage.offer.${line}`)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 rounded-xl bg-card p-3 shadow-elev-1">
            <label className="flex cursor-pointer items-center gap-2.5 text-[13px] font-medium">
              <input
                type="checkbox"
                data-agency-consent
                checked={offer.wanted}
                disabled={disabled}
                onChange={(event) => onOffer({ ...offer, wanted: event.target.checked })}
                className="size-4 shrink-0 accent-primary"
              />
              {t('onboarding.usage.offer.consent')}
            </label>
            <input
              id={emailId}
              type="email"
              data-agency-email
              autoComplete="email"
              value={offer.email}
              disabled={disabled}
              aria-label={t('onboarding.usage.offer.emailLabel')}
              onChange={(event) => onOffer({ ...offer, email: event.target.value })}
              className="mt-2 h-9 w-full rounded-lg bg-background px-3 text-[13px] ring-1 ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="mt-2 text-[12px] leading-snug text-muted-foreground">{t('onboarding.usage.offer.notice', { settingsPath: settingsAccountPath('profile') })}</p>
          </div>
        </div>
      )}
    </div>
  );
}
