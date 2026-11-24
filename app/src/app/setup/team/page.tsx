'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Check, Users, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { apiErrorMessage } from '@/lib/api-error';
import { OnboardingBackdrop } from '@/components/onboarding-backdrop';

type Preset = 'team' | 'scratch';
type TeamStatus = {
  status: 'unavailable' | 'pending' | 'applying' | 'complete';
  /** A state saved before the `company` preset was removed still carries it,
   *  so what the daemon reports is wider than what this screen offers. */
  preset: Preset | 'company' | null;
  configured: boolean;
  agents: { name: string; reportsTo: string | null }[];
};

const OPTIONS = [
  { id: 'team', icon: Users, roles: ['assistant', 'researcher', 'writer', 'developer'] },
  { id: 'scratch', icon: Terminal, roles: [] },
] as const;

export default function TeamSetupPage() {
  const [status, setStatus] = useState<TeamStatus | null>(null);
  const [selected, setSelected] = useState<Preset | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const option = OPTIONS.find((item) => item.id === selected);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch('/api/ui/setup/team', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const body = await response.json() as TeamStatus;
      setStatus(body);
      if (body.preset === 'team' || body.preset === 'scratch') setSelected(body.preset);
      if (!body.configured && body.status !== 'unavailable') window.location.replace('/setup');
    } catch { setError(t('teamSetup.loadFailed')); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/ui/setup/team', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preset: selected }),
      });
      const body = await response.json() as TeamStatus & { error?: string; code?: string };
      if (!response.ok) {
        setError(apiErrorMessage(body, t('teamSetup.failed')));
        // The server may have saved a plan before a filesystem failure. Read
        // back its locked choice so retries cannot silently switch teams.
        const fresh = await fetch('/api/ui/setup/team', { cache: 'no-store' });
        if (fresh.ok) {
          const current = await fresh.json() as TeamStatus;
          setStatus(current);
          if (current.preset === 'team' || current.preset === 'scratch') setSelected(current.preset);
        }
        return;
      }
      setStatus(body);
    } catch { setError(t('teamSetup.failed')); }
    finally { setBusy(false); }
  }

  // Every branch shares the onboarding backdrop. It used to inherit the global
  // hexagon pattern while steps 1–3 sat on the plain gradient, so the wizard
  // changed skin on its last screen.
  if (!status) return (
    <OnboardingBackdrop className="max-w-4xl">
      {error ? <><p role="alert">{error}</p><Button className="mt-4" onClick={() => void load()}>{t('teamSetup.retry')}</Button></>
        : <div role="status" className="space-y-6"><p>{t('teamSetup.loading')}</p><div className="h-12 rounded-md bg-muted" /><div className="h-48 rounded-md bg-muted" /></div>}
    </OnboardingBackdrop>
  );

  if (status.status === 'unavailable') return (
    <OnboardingBackdrop className="max-w-xl space-y-5" center>
      <h1 className="text-2xl font-semibold">{t('teamSetup.unavailableTitle')}</h1>
      <p className="text-muted-foreground">{t('teamSetup.unavailableDescription')}</p>
      <Button asChild><a href="/agents">{t('teamSetup.openAgents')}</a></Button>
    </OnboardingBackdrop>
  );

  if (status.status === 'complete') return (
    <OnboardingBackdrop className="max-w-2xl space-y-6">
      <Check className="h-8 w-8 text-primary" aria-hidden="true" />
      <h1 className="text-3xl font-semibold tracking-tight">{t(status.preset === 'scratch' ? 'teamSetup.emptyReady' : 'teamSetup.ready')}</h1>
      <p className="text-muted-foreground">{t(status.preset === 'scratch' ? 'teamSetup.emptyNext' : 'teamSetup.readyDescription')}</p>
      <ul className="space-y-1">
        {status.agents.map((agent) => <li key={agent.name} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/30 px-3 py-2.5">
          <span className="font-medium">{agent.name}</span>
          {agent.reportsTo && <span className="text-sm text-muted-foreground">{t('teamSetup.reportsTo', { name: agent.reportsTo })}</span>}
        </li>)}
      </ul>
      {/* One exit, and it is the next step: the restart is mandatory, so the
          links into the product (a first chat, the agents page) belong AFTER
          it — offering them here is what let someone reach a cockpit served by
          the daemon their configuration had not reached yet. */}
      <div className="flex flex-wrap items-center gap-4 pt-4">
        <Button asChild><a href="/setup/restart">{t('teamSetup.continueToRestart')}<ArrowRight className="ml-2 h-4 w-4" /></a></Button>
        <p className="text-sm text-muted-foreground">{t('teamSetup.restartNext')}</p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </OnboardingBackdrop>
  );

  return (
    <OnboardingBackdrop className="max-w-4xl">
      <nav aria-label={t('teamSetup.progressLabel')} className="mb-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
        <span>{t('teamSetup.step1')}</span><span>{t('teamSetup.step2')}</span><span>{t('teamSetup.step3')}</span>
        <span aria-current="step" className="font-medium text-primary">{t('teamSetup.step4')}</span>
        <span>{t('teamSetup.step5')}</span>
      </nav>
      <h1 className="text-3xl font-semibold tracking-tight">{t('teamSetup.title')}</h1>
      <p className="mt-3 max-w-2xl leading-relaxed text-muted-foreground">{t('teamSetup.description')}</p>
      <fieldset disabled={busy || status.status === 'applying'} className="mt-8">
        <legend className="sr-only">{t('teamSetup.choose')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {OPTIONS.map(({ id, icon: Icon, roles }) => <label key={id} className={`relative cursor-pointer rounded-lg border p-5 transition-colors focus-within:ring-2 focus-within:ring-ring ${selected === id ? 'border-primary bg-muted' : 'border-border bg-card hover:bg-muted'}`}>
            <div className="flex items-center justify-between"><Icon className="h-5 w-5 text-primary" aria-hidden="true" /><input className="h-4 w-4 accent-[hsl(var(--primary))]" type="radio" name="team-preset" value={id} checked={selected === id} onChange={() => setSelected(id)} /></div>
            <span className="mt-5 block font-semibold">{t(`teamSetup.${id}.title`)}</span>
            <span className="mt-2 block text-sm leading-relaxed text-muted-foreground">{t(`teamSetup.${id}.description`)}</span>
            <span className="mt-5 block text-sm">{roles.length ? t('teamSetup.agentCount', { count: roles.length }) : t('teamSetup.noAgents')}</span>
            {id === 'team' && <span className="mt-1 block text-xs text-primary">{t('teamSetup.recommended')}</span>}
          </label>)}
        </div>
        {/* Said next to the cards, not only under the button: the choice reads
            as a commitment otherwise, and it is not one. */}
        <p className="mt-4 text-sm text-muted-foreground">{t('teamSetup.presetEditable')}</p>
      </fieldset>
      <section aria-live="polite" className="mt-10">
        {option ? <>
          <h2 className="font-medium">{t(`teamSetup.${option.id}.preview`)}</h2>
          {option.roles.length > 0 && <ul className="mt-3 grid gap-x-8 sm:grid-cols-2">
            {option.roles.map((role) => <li key={role} className="py-2 text-sm"><span className="font-medium">{t(`teamSetup.roles.${role}.title`)}</span><p className="mt-1 leading-relaxed text-muted-foreground">{t(`teamSetup.roles.${role}.description`)}</p></li>)}
          </ul>}
        </> : <p className="text-sm text-muted-foreground">{t('teamSetup.choose')}</p>}
      </section>
      {error && <p role="alert" className="mt-5 text-sm text-destructive">{error}</p>}
      <div className="mt-7 flex flex-wrap items-center gap-4">
        <Button disabled={!selected || busy} onClick={() => void create()}>
          {t(busy ? 'teamSetup.creating' : selected === 'scratch' ? 'teamSetup.startEmpty' : status.status === 'applying' ? 'teamSetup.resume' : 'teamSetup.create')}<ArrowRight className="ml-2 h-4 w-4" />
        </Button>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{t('teamSetup.noAutomaticWork')}</p>
      </div>
    </OnboardingBackdrop>
  );
}
