'use client';

/**
 * The licence page: what the instance is running on, and where to enter a key.
 *
 * It replaces the bare `/activate` form, which could only ever say "installed"
 * and never what had been installed. Once a licence is in place the plan, its
 * end date and the payment state are the whole point of coming here; the entry
 * form stays available underneath to replace it.
 */

import { FormEvent, useCallback, useEffect, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/lib/brand';
import { activationErrorMessage, submitLicense, type LicenseRejection, type PublicLicense } from '@/lib/license';
import { t } from '@/lib/i18n';
import { formatDate as formatCalendarDate } from '@/lib/intl';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { reportUsage, usageSurface } from '@/lib/usage-events';

/** Where a licence is bought. Derived from the brand: there is one product. */
const PURCHASE_URL = `https://${BRAND.domain}/pricing`;

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : formatCalendarDate(date, { year: 'numeric', month: 'numeric', day: 'numeric' });
}

function Row({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

function CurrentLicense({ license }: { license: PublicLicense }): ReactElement {
  const expiry = formatDate(license.subscriptionExpiresAt);
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="m-0 text-sm font-semibold">{t('licensePage.currentTitle')}</h2>
      <div className="mt-3">
        <Row label={t('licensePage.plan')} value={license.plan ?? t('licensePage.planUnnamed')} />
        <Row label={t('licensePage.edition')} value={license.edition} />
        {/* `expiresAt` is the 15-minute token TTL, never shown: the date that
            means something to a human is the end of the subscription. */}
        <Row
          label={t('licensePage.expiry')}
          value={expiry ?? t('licensePage.neverExpires')}
        />
        <Row
          label={t('licensePage.payment')}
          value={license.paymentStatus === 'past_due' ? t('licensePage.paymentPastDue') : t('licensePage.paymentActive')}
        />
      </div>
    </div>
  );
}

/** Mirrors the daemon's `parseMachineName` (PRD §5.10) so a name that could
 *  only be refused never leaves the page. The server stays the authority. */
const MACHINE_NAME_MAX = 32;
function parseMachineName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MACHINE_NAME_MAX) return null;
  // Control characters, exactly as the server rejects them.
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Naming this machine, once. Three states, because a locked machine is not
 * always a named one: the licence server hands the name back only to the call
 * that wrote it, so a name set from the admin console — or before this home
 * was recreated — is known to be there without being known. Showing a
 * disabled field in that case would suggest a change that no route allows.
 */
function MachineName({ license, busy, onName }: {
  license: PublicLicense;
  busy: boolean;
  onName: (name: string) => Promise<void>;
}): ReactElement {
  const [name, setName] = useState('');
  const stored = license.machineName ?? null;
  const locked = license.machineNameLocked === true || stored !== null;
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="m-0 text-sm font-semibold">{t('licensePage.machineTitle')}</h2>
      {locked
        ? stored !== null
          ? <div className="mt-3"><Row label={t('licensePage.machineName')} value={stored} /></div>
          : <p className="mt-1 text-xs text-muted-foreground">{t('licensePage.machineNameLocked')}</p>
        : (
          <>
            <p className="mt-1 text-xs text-muted-foreground">{t('licensePage.machineDescription')}</p>
            <form
              className="mt-4 flex flex-wrap items-center gap-2"
              onSubmit={(event) => { event.preventDefault(); void onName(name); }}
            >
              <input
                className="min-w-56 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={name}
                maxLength={MACHINE_NAME_MAX}
                aria-label={t('licensePage.machineName')}
                placeholder={t('licensePage.machineNamePlaceholder')}
                onChange={(event) => { setName(event.target.value); }}
              />
              <Button type="submit" size="sm" disabled={busy || parseMachineName(name) === null}>
                {busy ? t('licensePage.machineNameSaving') : t('licensePage.machineNameSubmit')}
              </Button>
            </form>
          </>
        )}
    </div>
  );
}

function NoLicense({ license }: { license: PublicLicense }): ReactElement {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="m-0 text-sm font-semibold">{t('licensePage.noneTitle')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('licensePage.noneDescription')}</p>
      {(license.restrictedAccounts ?? 0) > 0 && <p className="mt-3 text-sm" role="status">{t('freeLicense.restrictedAccounts', { count: license.restrictedAccounts! })}</p>}
      <a
        href={PURCHASE_URL}
        target="_blank"
        rel="noreferrer"
        onClick={() => reportUsage({ name: 'upgrade_action', surface: usageSurface(), action: 'buy_opened', entryPoint: 'license_page' })}
        className="mt-3 inline-block text-sm underline underline-offset-4"
      >
        {t('licensePage.buy', { domain: BRAND.domain })}
      </a>
    </div>
  );
}

export function LicenseClient(): ReactElement {
  const [license, setLicense] = useState<PublicLicense | null>(null);
  const [token, setToken] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch('/api/ui/license', { cache: 'no-store' });
    setLicense(response.ok ? (await response.json()) as PublicLicense : null);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { reportUsage({ name: 'upgrade_action', surface: usageSurface(), action: 'plans_viewed', entryPoint: 'license_page' }); }, []);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      // The daemon refuses to replace a licence by a lesser one on its own
      // (SECU-LICENCES L-3): the operator confirms, then `force` is sent.
      const result = await submitLicense(token, (refusal) => confirmAction({
        title: t('activate.downgradeConfirm', { current: refusal.current?.edition ?? '', next: refusal.next?.edition ?? '' }),
        confirmLabel: t('confirmDialog.replace'),
        destructive: true,
      }));
      if (result.status === 'cancelled') { setMessage(t('activate.downgradeCancelled')); return; }
      if (result.status === 'refused') throw new Error(activationErrorMessage(result.body, t));
      setMessage(t('activate.installed', { edition: result.edition }));
      setToken('');
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function releaseMachine(): Promise<void> {
    if (!(await confirmAction({ title: t('freeLicense.deactivateConfirm'), confirmLabel: t('confirmDialog.deactivate'), destructive: true }))) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/ui/license/deactivate', { method: 'POST' });
      const body = await response.json() as LicenseRejection;
      if (!response.ok) throw new Error(activationErrorMessage(body, t));
      await load();
      setMessage(t('freeLicense.deactivated'));
    } catch (error) {
      setMessage((error as Error).message);
    } finally { setBusy(false); }
  }

  async function nameMachine(raw: string): Promise<void> {
    const name = parseMachineName(raw);
    if (name === null) { setMessage(t('licensePage.machineNameInvalid')); return; }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/ui/license/name', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
      });
      const body = await response.json() as LicenseRejection;
      // A machine already named is not an error to apologise for: reloading
      // turns the form into the sentence that states it (§5.10).
      if (response.status === 409 && body.error === 'name_locked') {
        await load();
        setMessage(t('licensePage.machineNameLocked'));
        return;
      }
      if (!response.ok) throw new Error(activationErrorMessage(body, t));
      await load();
      setMessage(t('licensePage.machineNameSaved', { name }));
    } catch (error) {
      setMessage((error as Error).message);
    } finally { setBusy(false); }
  }

  const licensed = license?.status === 'valid';

  return (
    <div className="relative z-[1] flex h-full flex-col gap-4 overflow-auto px-7 pt-5 pb-8">
      <div>
        <h1 className="m-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {t('licensePage.eyebrow')}
        </h1>
        <div className="mt-1 text-[22px] font-semibold -tracking-[0.01em]">{t('licensePage.title')}</div>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('licensePage.description')}</p>
      </div>

      <div className="grid max-w-3xl gap-4">
        {license === null
          ? <p className="text-sm text-muted-foreground">{t('route.loading')}</p>
          : licensed ? <CurrentLicense license={license} /> : <NoLicense license={license} />}

        {licensed && license && <MachineName license={license} busy={busy} onName={nameMachine} />}

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h2 className="m-0 text-sm font-semibold">
            {licensed ? t('licensePage.replaceTitle') : t('activate.title')}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('activate.description')}</p>
          <form className="mt-4 space-y-3" onSubmit={(event) => { void submit(event); }}>
            <textarea
              /* code-font: pasted license token */ className="min-h-32 w-full rounded-md border border-border bg-background p-3 font-mono text-xs"
              value={token}
              onChange={(event) => { setToken(event.target.value); }}
              placeholder={t('licensePage.keyPlaceholder', { key: 'TMN-XXXX-XXXX-XXXX-XXXX', token: 'eyJhbGciOiJFZERTQSIs…' })}
              required
            />
            <Button type="submit" size="sm" disabled={busy || !token.trim()}>
              {busy ? t('activate.checking') : t('activate.submit')}
            </Button>
          </form>
          {licensed && <Button className="mt-4" variant="outline" disabled={busy} onClick={() => { void releaseMachine(); }}>{t('freeLicense.deactivate')}</Button>}
          {message && <p className="mt-3 rounded-md border border-border p-3 text-sm" role="status">{message}</p>}
        </div>
      </div>
    </div>
  );
}
