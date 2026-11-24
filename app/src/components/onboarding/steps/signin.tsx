'use client';

/**
 * "Sign in" (mockup screen `login`), for an account made before the new
 * onboarding (docs/ONBOARDING.md, `Upgrade welcome`): the welcome leads here
 * instead of the account step. Email and password, "Forgot your password?"
 * through the emailed code, the privacy note — then the mascot step when the
 * daemon offers it, else wherever a login lands.
 *
 * Outside the dotted order: no "Back", no dot. A reader already signed in
 * (a reload after signing in) goes straight on.
 */
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactElement } from 'react';
import { ArrowRight, Loader2, Lock } from 'lucide-react';
import { BrandLogo } from '@/components/brand-logo';
import { PasswordInput } from '@/components/auth/password-input';
import { PasswordReset } from '@/components/auth/password-reset';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiErrorMessage } from '@/lib/api-error';
import { fetchMe } from '@/lib/auth';
import { t } from '@/lib/i18n';
import { reportOnboardingScreen } from '@/lib/usage-events';
import { landAfterSignin } from '../welcome-landing';

export function SigninStep(): ReactElement {
  const ids = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchMe().then((me) => {
      if (alive && me.user) void landAfterSignin(me);
    });
    return () => { alive = false; };
  }, []);

  const submit = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/ui/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        throw new Error(apiErrorMessage(payload, t('loginPage.failed')));
      }
      setPassword('');
      // Signed in now: the funnel's event goes with the new session.
      reportOnboardingScreen('signin', 'completed');
      await landAfterSignin(await fetchMe());
    } catch (error) {
      setMessage(error instanceof TypeError ? t('emailCode.unreachable') : (error as Error).message);
      setBusy(false);
    }
  }, [busy, email, password]);

  if (resetting) {
    return (
      <PasswordReset
        initialEmail={email}
        onClose={(address) => {
          if (address) setEmail(address);
          setMessage(null);
          setResetting(false);
        }}
      />
    );
  }

  return (
    <div className="flex w-full max-w-[400px] flex-col items-center text-center" data-onboarding-signin="">
      <BrandLogo className="h-12" alt="Timon" />
      <h1 className="mt-6 text-[28px] font-bold leading-tight tracking-[-0.02em]">{t('onboarding.signin.title')}</h1>
      <p className="mt-1.5 text-sm leading-snug text-muted-foreground">{t('onboarding.signin.subtitle')}</p>
      <form noValidate aria-busy={busy} className="mt-[18px] flex w-full flex-col gap-2.5 text-left" onSubmit={(e) => { void submit(e); }}>
        <div>
          <Label htmlFor={`${ids}-email`} className="mb-1.5 ml-0.5 block text-[12.5px] font-semibold text-muted-foreground">
            {t('loginPage.email')}
          </Label>
          <Input
            id={`${ids}-email`}
            type="email"
            required
            autoFocus
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-10"
          />
        </div>
        <div>
          <Label htmlFor={`${ids}-password`} className="mb-1.5 ml-0.5 block text-[12.5px] font-semibold text-muted-foreground">
            {t('loginPage.password')}
          </Label>
          <PasswordInput
            id={`${ids}-password`}
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            shown={shown}
            onToggleShown={() => setShown((s) => !s)}
            className="h-10"
          />
        </div>
        <p role="status" aria-live="polite" className="ml-0.5 min-h-4 text-[12.5px] leading-4 text-destructive">
          {message}
        </p>
        <Button type="submit" size="lg" className="h-11 w-full gap-2 rounded-full" disabled={busy || !email || !password}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {t('loginPage.submit')}
          {!busy && <ArrowRight className="h-4 w-4" aria-hidden />}
        </Button>
      </form>
      <Button
        variant="ghost"
        size="sm"
        className="mt-2 text-muted-foreground"
        onClick={() => { setMessage(null); setResetting(true); }}
      >
        {t('loginPage.forgot')}
      </Button>
      <p className="mt-3 flex items-start gap-2 text-left text-[12.5px] leading-[1.45] text-muted-foreground">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t('loginPage.local')}</span>
      </p>
    </div>
  );
}
