'use client';

import { FormEvent, useEffect, useState } from 'react';
import { ArrowRight, Lock } from 'lucide-react';
import { t } from '@/lib/i18n';
import { fetchMe, type AuthMe } from '@/lib/auth';
import { forgetAllChatMissions } from '@/lib/chat-mission-cache';
import { BrandLogo } from '@/components/brand-logo';
import { OnboardingBackdrop } from '@/components/onboarding-backdrop';
import { PasswordReset } from '@/components/auth/password-reset';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiErrorMessage } from '@/lib/api-error';
import { loginOpensWelcome, ONBOARDING_PATH } from '@/components/onboarding/onboarding-flow';
import { signedInTarget } from '@/components/onboarding/welcome-landing';

/**
 * The only page served outside the cockpit shell (no topbar, no nav): it
 * owns the whole viewport, hence the centring here rather than in a layout.
 * It signs in, and leads a forgotten password through its emailed code; the
 * first account is made by the onboarding's account step (docs/ONBOARDING.md).
 */
function LoginShell({ children }: { children: React.ReactNode }) {
  return (
    <OnboardingBackdrop center className="max-w-sm">
      <div className="mb-8 flex justify-center">
        <BrandLogo className="h-11" alt="Timon" />
      </div>
      <div className="rounded-xl border border-border bg-card p-6 shadow-elev-2 sm:p-7">
        {children}
      </div>
    </OnboardingBackdrop>
  );
}

export default function LoginPage() {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);

  // `AuthRedirect` sends a signed-out user here with `?reason=expired`: say why, instead of a silent bounce.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('reason') === 'expired') setMessage(t('loginPage.sessionExpired'));
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchMe().then((body) => { if (alive) setMe(body); });
    return () => { alive = false; };
  }, []);

  // A fresh install starts on the onboarding's welcome, whose account step makes the first account;
  // an account made before that onboarding meets its welcome once, then signs in there (`Upgrade welcome`).
  const toWelcome = me !== null && !me.user && loginOpensWelcome(me.needsSetup, me.welcome ?? null);
  useEffect(() => {
    if (toWelcome) window.location.replace(ONBOARDING_PATH);
  }, [toWelcome]);

  const welcome = me?.welcome ?? null;
  useEffect(() => {
    if (!me?.user) return;
    let alive = true;
    void signedInTarget({ welcome }).then((target) => {
      // Authentication changes every viewer-scoped store and SSE subscription.
      // A soft navigation retains the root layout mounted anonymously, its
      // failed stream and its cached permissions. Start a fresh document.
      if (!alive) return;
      forgetAllChatMissions();
      window.location.replace(target);
    });
    return () => { alive = false; };
  }, [me?.user, welcome]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !me) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/ui/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const payload = await response.json() as { error?: string; user?: { email: string } };
      if (!response.ok) {
        throw new Error(apiErrorMessage(payload, t('loginPage.failed')));
      }
      const next = await fetchMe();
      setMe(next);
      setPassword('');
    } catch (error) {
      setMessage(error instanceof TypeError ? t('emailCode.unreachable') : (error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (me?.user || toWelcome) {
    return (
      <LoginShell>
        <p className="text-sm text-muted-foreground">{t('route.loading')}</p>
      </LoginShell>
    );
  }

  if (resetting) {
    return (
      <OnboardingBackdrop center className="max-w-[560px]">
        <div className="flex justify-center">
          <PasswordReset
            initialEmail={email}
            onClose={(address) => {
              if (address) setEmail(address);
              setMessage(null);
              setResetting(false);
            }}
          />
        </div>
      </OnboardingBackdrop>
    );
  }

  return (
    <LoginShell>
      <h1 className="text-lg font-semibold tracking-tight">{t('loginPage.title')}</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">{t('loginPage.description')}</p>
      <form className="mt-6 space-y-4" aria-busy={busy} onSubmit={(event) => { void submit(event); }}>
        <div className="space-y-1.5">
          <Label htmlFor="login-email">{t('loginPage.email')}</Label>
          <Input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="login-password">{t('loginPage.password')}</Label>
          <Input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <Button className="w-full gap-2" disabled={busy || !me} type="submit">
          {busy ? t('loginPage.working') : t('loginPage.submit')}
          {!busy && <ArrowRight className="h-4 w-4" aria-hidden />}
        </Button>
      </form>
      {me && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-3 w-full text-muted-foreground"
          data-login-forgot=""
          onClick={() => { setMessage(null); setResetting(true); }}
        >
          {t('loginPage.forgot')}
        </Button>
      )}
      {message && (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="status"
        >
          {message}
        </p>
      )}
      <p className="mt-5 flex items-start gap-2 text-xs leading-[1.45] text-muted-foreground">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t('loginPage.local')}</span>
      </p>
    </LoginShell>
  );
}
