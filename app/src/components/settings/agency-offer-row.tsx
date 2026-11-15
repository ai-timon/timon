'use client';

/**
 * Settings › Profile › Partners: the agency offer of the signed-in account, as
 * one row (title, state, one action). Shown to an account that said it uses
 * Timon for an agency, or that already asked for the offer (so it can always
 * withdraw). "Withdraw" tells the daemon, which tells the site; "Subscribe"
 * opens a dialog with the address, prefilled with the account's.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { getLocale, t } from '@/lib/i18n';
import {
  AgencyOfferRequestError, agencyOfferStatusKey, loadAgencyOffer, loadUsageKind, looksLikeEmail, subscribeAgencyOffer,
  withdrawAgencyOffer, type AgencyOfferView, type UsageKind,
} from '@/lib/agency-offer';

export function AgencyOfferRow({ accountEmail }: { accountEmail: string }): ReactElement | null {
  const [view, setView] = useState<AgencyOfferView | null>(null);
  const [usage, setUsage] = useState<UsageKind | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [offer, kind] = await Promise.all([loadAgencyOffer(), loadUsageKind().catch(() => null)]);
      setView(offer);
      setUsage(kind);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (failed) {
    return (
      <ProviderSection title={t('agencyOffer.label')}>
        <ProviderSettingRow title={t('agencyOffer.title')} status={t('agencyOffer.loadFailed')} />
      </ProviderSection>
    );
  }
  if (!view || (view.state === 'none' && usage !== 'agency')) return null;

  const withdraw = async (): Promise<void> => {
    setBusy(true);
    try {
      const next = await withdrawAgencyOffer();
      setView(next);
      if (next.state === 'none') toast.success(t('agencyOffer.withdrawn'));
    } catch {
      toast.error(t('agencyOffer.failed'));
    } finally {
      setBusy(false);
    }
  };

  const active = view.state === 'subscribed' || view.state === 'pending';
  const canSubscribe = usage === 'agency' && (view.state === 'none' || view.state === 'rejected');
  const status = t(agencyOfferStatusKey(view), { email: view.email ?? '' });

  const action = active ? (
    <Button type="button" size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => { void withdraw(); }} data-agency-withdraw>
      {t('agencyOffer.withdraw')}
    </Button>
  ) : canSubscribe ? (
    <Button type="button" size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => setOpen(true)} data-agency-subscribe>
      {t('agencyOffer.subscribe')}
    </Button>
  ) : null;

  const menu = active && usage === 'agency' ? (
    <DropdownMenuItem onSelect={() => setOpen(true)}>{t('agencyOffer.changeEmail')}</DropdownMenuItem>
  ) : view.state === 'rejected' ? (
    <DropdownMenuItem onSelect={() => { void withdraw(); }}>{t('agencyOffer.withdraw')}</DropdownMenuItem>
  ) : undefined;

  return (
    <ProviderSection title={t('agencyOffer.label')}>
      <ProviderSettingRow data-agency-offer={view.state} title={t('agencyOffer.title')} status={status} action={action} menu={menu} menuLabel={t('agencyOffer.more')} />
      <SubscribeDialog
        open={open}
        onOpenChange={setOpen}
        initialEmail={view.email ?? accountEmail}
        onDone={(next) => { setView(next); setOpen(false); }}
      />
    </ProviderSection>
  );
}

function SubscribeDialog({ open, onOpenChange, initialEmail, onDone }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialEmail: string;
  onDone: (view: AgencyOfferView) => void;
}): ReactElement {
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setEmail(initialEmail); setError(''); }
  }, [open, initialEmail]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!looksLikeEmail(email)) { setError(t('agencyOffer.invalidEmail')); return; }
    setBusy(true);
    try {
      const next = await subscribeAgencyOffer(email, getLocale());
      if (next.state === 'rejected' && next.error === 'invalid') { setError(t('agencyOffer.invalidEmail')); return; }
      toast.success(t('agencyOffer.recorded'));
      onDone(next);
    } catch (failure) {
      setError(t(failure instanceof AgencyOfferRequestError && failure.status === 400 ? 'agencyOffer.invalidEmail' : 'agencyOffer.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(event) => { void submit(event); }} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t('agencyOffer.dialogTitle')}</DialogTitle>
          </DialogHeader>
          <Input
            type="email"
            autoComplete="email"
            aria-label={t('agencyOffer.emailLabel')}
            value={email}
            onChange={(event) => { setEmail(event.target.value); setError(''); }}
          />
          <p className="text-[12px] leading-snug text-muted-foreground">{t('agencyOffer.notice')}</p>
          {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t('agencyOffer.cancel')}</Button>
            <Button type="submit" disabled={busy}>{t('agencyOffer.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
