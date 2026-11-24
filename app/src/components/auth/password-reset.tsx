'use client';

/**
 * "Forgot password?" on the login (mockup view `login`, docs/EMAIL-CODE-UI.md):
 * the address → the code it received → the new password twice → done. The
 * daemon checks the code together with the new password
 * (`POST /api/auth/password-reset/confirm`), so a wrong code is learnt on the
 * password screen and brings the reader back to the code, tries counted.
 *
 * The daemon answers the same whether an account holds the address or not
 * (docs/EMAIL-CODES.md): the screens say "if an account matches", and
 * always recall the offline way, `timon user reset-password`.
 */
import { useCallback, useState, type FormEvent, type ReactElement } from 'react';
import { ArrowLeft, ArrowRight, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AgentMascotHost } from '@/components/mascot/agent-mascot';
import { EmailCodeHost, useNow, type EmailCodeResent, type EmailCodeVerdict } from '@/components/email-code/email-code';
import {
  confirmReset, requestResetCode, resendResetCode, RESTART_CODES, type CodeChallenge,
} from '@/components/email-code/email-code-api';
import { expiredChallenge, failureText, type CodeFailure } from '@/components/email-code/email-code-failure';
import { t } from '@/lib/i18n';
import { looksLikeEmail, MIN_PASSWORD, passwordPairReady, passwordProblem } from './auth-form';
import { PasswordInput } from './password-input';

export type PasswordResetView = 'ask' | 'code' | 'new' | 'done';

/** The refusals of the confirmation that are about the code, not the password: back to the code. */
const CODE_REFUSALS: ReadonlySet<string> = new Set(['email_code_invalid', 'email_code_exhausted', 'email_code_expired']);

export type PasswordResetProps = {
  /** The address typed on the login, if any. */
  initialEmail?: string;
  /** Back to the login form, with the address to sign in with. */
  onClose: (email: string) => void;
};

function Fallback(): ReactElement {
  const marker = '\u0000';
  const [before = '', after = ''] = t('passwordReset.fallback', { cmd: marker }).split(marker);
  return (
    <p data-reset-fallback="" className="mt-6 max-w-[380px] text-[12.5px] leading-[1.5] text-muted-foreground">
      {before}
      {/* code-font: a command to type in a terminal */}
      <code className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-foreground">timon user reset-password</code>
      {after}
    </p>
  );
}

export function PasswordReset({ initialEmail = '', onClose }: PasswordResetProps): ReactElement {
  const now = useNow();
  const [view, setView] = useState<PasswordResetView>('ask');
  const [email, setEmail] = useState(initialEmail);
  const [challenge, setChallenge] = useState<CodeChallenge | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<CodeFailure | null>(null);
  /** A refusal of the code learnt on the password screen, and a key to show it on a fresh code screen. */
  const [codeRefusal, setCodeRefusal] = useState<{ failure: CodeFailure; round: number } | null>(null);

  const address = email.trim();
  const waiting = failureText(failure, now);
  const blocked = failure?.retryUntil != null && waiting !== null;

  const ask = useCallback(async (): Promise<CodeChallenge | CodeFailure> => {
    const answer = await requestResetCode(address);
    return answer.ok ? answer.value : answer.failure;
  }, [address]);

  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!looksLikeEmail(address) || busy || blocked) return;
    setBusy(true);
    setFailure(null);
    const answer = await ask();
    setBusy(false);
    if ('challengeId' in answer) {
      setChallenge(answer);
      setCodeRefusal(null);
      setView('code');
    } else {
      setFailure(answer);
    }
  };

  // The daemon checks the code with the new password: here the digits are only kept.
  const keep = useCallback(async (digits: string): Promise<EmailCodeVerdict> => {
    setCode(digits);
    return { ok: true };
  }, []);

  const resend = useCallback(async (): Promise<EmailCodeResent> => {
    if (!challenge) return { ok: false, failure: expiredChallenge() };
    const answer = await resendResetCode(challenge.challengeId);
    if (answer.ok) return { ok: true, resendAt: answer.value.resendAt };
    if (answer.failure.code && RESTART_CODES.has(answer.failure.code)) {
      const fresh = await ask();
      if (!('challengeId' in fresh)) return { ok: false, failure: fresh };
      setChallenge(fresh);
      return { ok: true, resendAt: fresh.resendAt };
    }
    return { ok: false, failure: answer.failure };
  }, [challenge, ask]);

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!challenge || !passwordPairReady(password, confirm) || busy || blocked) return;
    setBusy(true);
    setFailure(null);
    const answer = await confirmReset({ challengeId: challenge.challengeId, code, password });
    setBusy(false);
    if (answer.ok) {
      setPassword('');
      setConfirm('');
      setView('done');
      return;
    }
    if (answer.failure.code && CODE_REFUSALS.has(answer.failure.code)) {
      setCodeRefusal((r) => ({ failure: answer.failure, round: (r?.round ?? 0) + 1 }));
      setView('code');
      return;
    }
    setFailure(answer.failure);
  };

  if (view === 'code' && challenge) {
    // The daemon answers a reset to an unconfirmed address like a sent one
    // (telling them apart would reveal which addresses hold an account), so
    // the way out is always said under the code.
    return (
      <div className="flex w-full flex-col items-center">
        <EmailCodeHost
          key={codeRefusal?.round ?? 0}
          purpose="reset"
          email={address}
          resendAt={challenge.resendAt}
          verify={keep}
          resend={resend}
          onVerified={() => { setFailure(null); setView('new'); }}
          changeEmail={() => { setFailure(null); setView('ask'); }}
          failure={codeRefusal?.failure ?? null}
          settleMs={0}
        />
        <p data-reset-unconfirmed="" className="mt-4 max-w-[380px] text-center text-[12.5px] leading-[1.5] text-muted-foreground">
          {t('passwordReset.unconfirmed')}
        </p>
      </div>
    );
  }

  if (view === 'new') {
    const problem = passwordProblem(password, confirm);
    const line = waiting ?? (problem === 'mismatch' ? t('onboarding.account.mismatch') : problem === 'short' ? t('onboarding.account.tooShort', { min: MIN_PASSWORD }) : null);
    const toggle = () => setShown((s) => !s);
    return (
      <div className="flex w-full max-w-[440px] flex-col items-center text-center">
        <AgentMascotHost look={{ shape: 'round', color: '#3fa9ff', eyes: 'happy' }} size={72} />
        <h1 className="mt-3 text-[28px] font-bold leading-tight tracking-[-0.02em]">{t('passwordReset.newTitle')}</h1>
        <form noValidate aria-busy={busy} className="mt-6 flex w-full flex-col gap-2.5 text-left" onSubmit={(e) => { void save(e); }}>
          <div>
            <Label htmlFor="reset-password" className="mb-1.5 ml-0.5 block text-[12.5px] font-semibold text-muted-foreground">{t('onboarding.account.password')}</Label>
            <PasswordInput id="reset-password" autoFocus required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} shown={shown} onToggleShown={toggle} className="h-10" />
          </div>
          <div>
            <Label htmlFor="reset-confirm" className="mb-1.5 ml-0.5 block text-[12.5px] font-semibold text-muted-foreground">{t('onboarding.account.confirm')}</Label>
            <PasswordInput id="reset-confirm" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} shown={shown} onToggleShown={toggle} aria-invalid={problem !== null} className="h-10" />
          </div>
          <p role="status" aria-live="polite" data-reset-status="" className="ml-0.5 min-h-4 text-[12.5px] leading-4 tabular-nums text-destructive">{line}</p>
          <Button type="submit" size="lg" className="h-11 w-full gap-2 rounded-full" disabled={!passwordPairReady(password, confirm) || busy || blocked}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {t('passwordReset.save')}
            {!busy && <ArrowRight className="h-4 w-4" aria-hidden />}
          </Button>
        </form>
      </div>
    );
  }

  if (view === 'done') {
    return (
      <div className="flex w-full max-w-[440px] flex-col items-center text-center">
        <AgentMascotHost look={{ shape: 'squircle', color: '#7ed957', eyes: 'happy' }} size={84} />
        <p role="status" className="mt-4 flex items-center gap-2 text-[15px] text-success">
          <Check className="h-4 w-4" aria-hidden />
          {t('passwordReset.done')}
        </p>
        <Button size="lg" className="mt-5 h-11 gap-2 rounded-full px-8" autoFocus onClick={() => onClose(address)}>
          {t('loginPage.submit')}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-[440px] flex-col items-center text-center">
      <AgentMascotHost look={{ shape: 'gem', color: '#ffc233', eyes: 'big' }} size={72} />
      <h1 className="mt-3 text-[28px] font-bold leading-tight tracking-[-0.02em]">{t('passwordReset.title')}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t('passwordReset.subtitle')}</p>
      <form noValidate aria-busy={busy} className="mt-6 flex w-full flex-col gap-2.5" onSubmit={(e) => { void send(e); }}>
        <Input
          type="email"
          autoFocus
          required
          autoComplete="username"
          aria-label={t('onboarding.account.email')}
          placeholder={t('onboarding.account.emailPlaceholder')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-12 text-center text-base md:text-base"
        />
        <p role="status" aria-live="polite" data-reset-status="" className="min-h-4 text-[12.5px] leading-4 tabular-nums text-destructive">{waiting}</p>
        <Button type="submit" size="lg" className="h-11 w-full gap-2 rounded-full" disabled={!looksLikeEmail(address) || busy || blocked}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {t('passwordReset.send')}
          {!busy && <ArrowRight className="h-4 w-4" aria-hidden />}
        </Button>
      </form>
      <Button variant="ghost" size="sm" className="mt-2 gap-1.5 text-muted-foreground" onClick={() => onClose(address)}>
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t('onboarding.back')}
      </Button>
      <Fallback />
    </div>
  );
}
