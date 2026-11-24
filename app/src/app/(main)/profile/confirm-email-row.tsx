'use client';

/**
 * "Confirm your address", for an account whose address was made without its
 * mailed code (docs/EMAIL-CODES.md): a member invited or created by an admin,
 * a first admin made offline by `timon user create-admin`, a login moved by an
 * email change. The site relay mails a reset code only to an address it saw
 * confirmed, so until then "Forgot your password?" brings nothing.
 *
 * One row, one action: the code goes out, then the code screen (the
 * `email.code` slot, through `EmailCodeHost`) opens in a dialog.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { EmailCodeHost, useNow, type EmailCodeResent, type EmailCodeVerdict } from '@/components/email-code/email-code';
import {
  confirmEmailVerification, requestEmailVerification, resendEmailVerification, RESTART_CODES, type CodeChallenge,
} from '@/components/email-code/email-code-api';
import { expiredChallenge, failureText, type CodeFailure } from '@/components/email-code/email-code-failure';
import { refreshMe } from '@/hooks/use-me';
import { CONFIRM_EMAIL_ANCHOR } from '@/components/notices/confirm-email-notice';
import { t } from '@/lib/i18n';

/** Answers that mean there is nothing left to confirm: the row goes away. */
const SETTLED = 'email_already_confirmed';

export function ConfirmEmailRow({ email }: { email: string }): ReactElement {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<CodeChallenge | null>(null);
  const [failure, setFailure] = useState<CodeFailure | null>(null);
  const waiting = failureText(failure, now);
  const blocked = failure?.retryUntil != null && waiting !== null;
  const button = useRef<HTMLButtonElement>(null);

  // Reached from the bottom-left card (`/profile#confirm-email`): the page
  // paints this row only once the account is read, after the browser gave up
  // on the anchor, so the row brings itself into view. Focus, not a click:
  // mailing a code stays the person's own gesture.
  useEffect(() => {
    if (window.location.hash !== `#${CONFIRM_EMAIL_ANCHOR}`) return;
    const target = button.current;
    target?.scrollIntoView?.({ block: 'center' });
    target?.focus({ preventScroll: true });
  }, []);

  const ask = useCallback(async (): Promise<CodeChallenge | CodeFailure> => {
    const answer = await requestEmailVerification();
    return answer.ok ? answer.value : answer.failure;
  }, []);

  const send = async (): Promise<void> => {
    if (busy || blocked) return;
    setBusy(true);
    setFailure(null);
    const answer = await ask();
    setBusy(false);
    if ('challengeId' in answer) {
      setChallenge(answer);
      return;
    }
    if (answer.code === SETTLED) { void refreshMe(); return; }
    setFailure(answer);
  };

  const verify = useCallback(async (code: string): Promise<EmailCodeVerdict> => {
    if (!challenge) return { ok: false, failure: expiredChallenge() };
    const answer = await confirmEmailVerification({ challengeId: challenge.challengeId, code });
    return answer.ok ? { ok: true } : { ok: false, failure: answer.failure };
  }, [challenge]);

  const resend = useCallback(async (): Promise<EmailCodeResent> => {
    if (!challenge) return { ok: false, failure: expiredChallenge() };
    const answer = await resendEmailVerification(challenge.challengeId);
    if (answer.ok) return { ok: true, resendAt: answer.value.resendAt };
    if (answer.failure.code && RESTART_CODES.has(answer.failure.code)) {
      const fresh = await ask();
      if (!('challengeId' in fresh)) return { ok: false, failure: fresh };
      setChallenge(fresh);
      return { ok: true, resendAt: fresh.resendAt };
    }
    return { ok: false, failure: answer.failure };
  }, [challenge, ask]);

  const verified = useCallback((): void => {
    setChallenge(null);
    toast.success(t('profile.confirmEmailDone'));
    void refreshMe();
  }, []);

  const close = useCallback((): void => { setChallenge(null); }, []);

  return (
    <div id={CONFIRM_EMAIL_ANCHOR} data-confirm-email-row="" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-4 py-3">
      <div className="min-w-0">
        <p className="m-0 text-sm font-medium">{t('profile.confirmEmailTitle')}</p>
        <p role="status" aria-live="polite" className={waiting ? 'm-0 text-xs tabular-nums text-destructive' : 'm-0 text-xs text-muted-foreground'}>
          {waiting ?? t('profile.confirmEmailStatus')}
        </p>
      </div>
      <Button ref={button} type="button" size="sm" disabled={busy || blocked} onClick={() => { void send(); }}>
        {busy ? t('profile.confirmEmailSending') : t('profile.confirmEmailSend')}
      </Button>
      <Dialog open={challenge !== null} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogTitle className="sr-only">{t('profile.confirmEmailTitle')}</DialogTitle>
          {challenge && (
            <div className="flex justify-center py-4">
              <EmailCodeHost
                purpose="verify"
                email={email}
                resendAt={challenge.resendAt}
                verify={verify}
                resend={resend}
                onVerified={verified}
                changeEmail={close}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
