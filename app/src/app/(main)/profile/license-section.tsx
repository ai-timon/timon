'use client';

/**
 * The licence key, in the profile (TODO #865). Since the product opened, the
 * first account is created without a key and runs on Free; a key is entered or
 * replaced here, through the same routes as the licence page. Everyone sees
 * the state; only a superadmin gets the field — the daemon refuses anyone
 * else, so offering it would only lead to a 403.
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { isPageSurfaceAllowed, useCapabilities } from '@/lib/capabilities';
import { t } from '@/lib/i18n';
import { formatDate } from '@/lib/intl';
import { activationErrorMessage, licenseSummary, submitLicense, type PublicLicense } from '@/lib/license';
import { sseOn } from '@/lib/sse-stream';

function Row({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

function day(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatDate(date, { year: 'numeric', month: 'numeric', day: 'numeric' });
}

function LicenseState({ license }: { license: PublicLicense }): ReactElement {
  const summary = licenseSummary(license);
  if (summary.tier === 'free') {
    return (
      <>
        <Row label={t('profile.licensePlan')} value={t('profile.licenseFree')} />
        <p className="mt-1 text-xs text-muted-foreground">{t('profile.licenseFreeHint')}</p>
      </>
    );
  }
  if (summary.tier === 'none') {
    return <Row label={t('profile.licensePlan')} value={t('profile.licenseNone')} />;
  }
  return (
    <>
      <Row label={t('profile.licensePlan')} value={summary.plan ?? t('licensePage.planUnnamed')} />
      <Row label={t('licensePage.expiry')} value={summary.expiresAt ? day(summary.expiresAt) : t('licensePage.neverExpires')} />
      {summary.pastDue && <Row label={t('licensePage.payment')} value={t('licensePage.paymentPastDue')} />}
    </>
  );
}

export function LicenseSection({ canEdit }: { canEdit: boolean }): ReactElement {
  const [license, setLicense] = useState<PublicLicense | null>(null);
  const [failed, setFailed] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const capabilities = useCapabilities();
  const detailsAllowed = isPageSurfaceAllowed(capabilities, '/license');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/ui/license', { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      setLicense(await response.json() as PublicLicense);
      setFailed(false);
    } catch { setFailed(true); }
  }, []);

  // A renewal, a revocation or an install from another tab is published on the
  // global stream: the state shown here follows it without a reload.
  useEffect(() => { void load(); return sseOn('license_changed', () => { void load(); }); }, [load]);

  // A licence card's "Enter my key" lands here (`/profile#license`): the page
  // paints this block after the browser looked for the anchor, so scroll once
  // the state is in.
  const loaded = license !== null || failed;
  useEffect(() => {
    if (loaded && window.location.hash === '#license') document.getElementById('license')?.scrollIntoView?.({ block: 'start' });
  }, [loaded]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    try {
      const result = await submitLicense(value, (refusal) => confirmAction({
        title: t('activate.downgradeConfirm', { current: refusal.current?.edition ?? '', next: refusal.next?.edition ?? '' }),
        confirmLabel: t('confirmDialog.replace'),
        destructive: true,
      }));
      if (result.status === 'cancelled') { toast.message(t('activate.downgradeCancelled')); return; }
      if (result.status === 'refused') { toast.error(activationErrorMessage(result.body, t)); return; }
      setValue('');
      toast.success(t('profile.licenseInstalled'));
      await load();
    } catch {
      toast.error(t('profile.licenseError'));
    } finally {
      setBusy(false);
    }
  }

  const licensed = license?.status === 'valid';
  return (
    <section id="license" className="scroll-mt-20 rounded-xl border border-border bg-card p-5 shadow-sm" aria-labelledby="profile-license-title">
      <h2 id="profile-license-title" className="m-0 text-sm font-semibold">{t('profile.licenseTitle')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('profile.licenseDescription')}</p>
      <div className="mt-4">
        {license === null
          ? <p className="text-sm text-muted-foreground">{failed ? t('profile.licenseUnavailable') : t('route.loading')}</p>
          : <LicenseState license={license} />}
        {canEdit ? (
          <form className="mt-4 flex flex-col gap-1.5" onSubmit={(event) => { void submit(event); }}>
            <Label htmlFor="profile-license-key">{licensed ? t('profile.licenseReplaceLabel') : t('profile.licenseKeyLabel')}</Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="profile-license-key"
                className="min-w-56 flex-1"
                type="password"
                value={value}
                onChange={(event) => { setValue(event.target.value); }}
                // i18n-exempt: format of an activation key, the same in every language
                placeholder="TMN-XXXX-XXXX-XXXX-XXXX"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
              />
              <Button type="submit" size="sm" disabled={busy || !value.trim()}>
                {busy ? t('activate.checking') : licensed ? t('profile.licenseReplace') : t('profile.licenseActivate')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('profile.licenseKeyHint')}</p>
          </form>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">{t('profile.licenseAdminOnly')}</p>
        )}
        {detailsAllowed && (
          <Link className="mt-3 inline-block text-xs underline underline-offset-4" href="/license">{t('profile.licenseDetails')}</Link>
        )}
      </div>
    </section>
  );
}
