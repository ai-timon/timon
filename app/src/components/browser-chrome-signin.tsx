'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, LogIn, X } from 'lucide-react';
import { nativeBrowserRequest, type BrowserCommand } from '@/lib/native-browser';
import { t } from '@/lib/i18n';

type Capability = { available: true; name: string } | { available: false; message: string };
export type ChromeSigninStatus = { state: 'idle' | 'open' | 'finished' | 'failed'; imported?: number; skipped?: number; error?: string };
const actionClass = 'rounded border border-border px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-40';

/** What the sign-in dialog says for a state; the same wording for the closing report and a later reopening. */
export function chromeSigninReport(status: ChromeSigninStatus): string | null {
  if (status.state === 'finished') {
    return status.imported ? t('browserPanel.native.chromeSigninCopied', { count: status.imported }) : t('browserPanel.native.chromeSigninNothing');
  }
  return status.state === 'failed' ? status.error ?? t('browserPanel.native.chromeSigninNothing') : null;
}

/** Why the dialog opened: by hand, or on Google's refusal (of Google itself, or of a site's "Sign in with Google"). */
export type ChromeSigninReason = 'manual' | 'rejected' | 'rejectedSite';

/**
 * Sign-in through an installed Chrome (TODO #276). Google refuses the engine of this
 * browser itself, so the sign-in happens in a Chrome window and its cookies are copied here.
 * `startUrl` is the page Chrome opens on; `onSignedIn` runs once when a sign-in this dialog
 * watched open ends with cookies copied, whether by its button or by the window closed by hand.
 */
export function BrowserChromeSignin({ controlled, command, close, startUrl, reason = 'manual', onSignedIn }: {
  controlled: boolean; command: BrowserCommand; close: () => void;
  startUrl?: string; reason?: ChromeSigninReason; onSignedIn?: (status: ChromeSigninStatus) => void;
}) {
  const [capability, setCapability] = useState<Capability | null>(null);
  const [status, setStatus] = useState<ChromeSigninStatus>({ state: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const commandRef = useRef(command);
  commandRef.current = command;
  const signedInRef = useRef(onSignedIn);
  signedInRef.current = onSignedIn;
  // A result left by an earlier sign-in is read back on mount: only a window seen open here may lead anywhere.
  const sawOpen = useRef(false);
  const reported = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void nativeBrowserRequest<{ chrome?: Capability }>('capabilities', undefined, controller.signal)
      .then((value) => { if (!controller.signal.aborted && value.chrome) setCapability(value.chrome); })
      .catch((err) => { if (!controller.signal.aborted) setError((err as Error).message); });
    return () => controller.abort();
  }, []);
  // The window may be closed by hand: the daemon-side state, not this dialog, is the truth.
  const open = status.state === 'open';
  useEffect(() => {
    if (status.state === 'open') { sawOpen.current = true; return; }
    if (status.state === 'finished' && status.imported && sawOpen.current && !reported.current) {
      reported.current = true;
      signedInRef.current?.(status);
    }
  }, [status]);
  useEffect(() => {
    let alive = true;
    const read = () => commandRef.current<ChromeSigninStatus>('chromeSigninStatus')
      .then((value) => { if (alive) setStatus(value); }).catch(() => {});
    void read();
    if (!open) return () => { alive = false; };
    const timer = setInterval(() => void read(), 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [open]);
  const act = async (action: 'chromeSigninStart' | 'chromeSigninFinish' | 'chromeSigninCancel') => {
    setBusy(true); setError(null);
    try { setStatus(await command<ChromeSigninStatus>(action, action === 'chromeSigninStart' && startUrl ? { url: startUrl } : {})); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const report = chromeSigninReport(status);
  const missing = capability && !capability.available ? capability.message : null;
  return <section role="dialog" aria-modal="true" aria-label={t('browserPanel.native.chromeSignin')} className="absolute inset-0 z-20 flex flex-col overflow-hidden bg-card p-3">
    <div className="mb-3 flex items-center gap-2"><LogIn className="size-4" /><h2 className="min-w-0 flex-1 text-sm font-medium">{t('browserPanel.native.chromeSignin')}</h2><button type="button" className={actionClass} aria-label={t('browserPanel.native.close')} onClick={close}><X className="size-4" /></button></div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
      {reason !== 'manual' && <p className="rounded bg-muted p-2 text-xs font-medium">{t(reason === 'rejectedSite' ? 'browserPanel.native.chromeSigninRejectedSite' : 'browserPanel.native.chromeSigninRejected')}</p>}
      <p className="text-xs text-muted-foreground">{t('browserPanel.native.chromeSigninHint')}</p>
      {missing && <p role="alert" className="rounded bg-destructive/10 p-2 text-xs text-destructive">{missing}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {open && <p className="flex items-center gap-2 text-xs"><Loader2 className="size-3.5 animate-spin" />{t('browserPanel.native.chromeSigninOpenNow')}</p>}
      {!open && report && <p role="status" className="text-xs">{report}</p>}
      <div className="flex flex-wrap gap-2">
        {!open && <button type="button" className={actionClass} disabled={busy || !controlled || !!missing || !capability} onClick={() => void act('chromeSigninStart')}>{capability?.available ? `${t('browserPanel.native.chromeSigninOpen')} (${capability.name})` : t('browserPanel.native.chromeSigninOpen')}</button>}
        {open && <button type="button" className={actionClass} disabled={busy} onClick={() => void act('chromeSigninFinish')}>{t('browserPanel.native.chromeSigninDone')}</button>}
        {open && <button type="button" className={actionClass} disabled={busy} onClick={() => void act('chromeSigninCancel')}>{t('browserPanel.native.chromeSigninCancel')}</button>}
      </div>
      <p className="text-[11px] text-muted-foreground">{t('browserPanel.native.chromeSigninKept')}</p>
    </div>
  </section>;
}
