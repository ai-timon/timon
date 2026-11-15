'use client';

/**
 * "Meet {name}'s mascot", the last screen of the upgrade welcome
 * (docs/ONBOARDING.md, `Upgrade welcome`): an account made before the new
 * onboarding has just signed in again, and is offered to dress its main
 * agent's mascot with the shared configurator (`LookStylerHost`, the one of
 * the agent step and of the editor's Avatar tab), with the 3D / 2D switch of
 * Settings → Appearance above it.
 *
 * "Keep this look" saves the look and makes the mascot the agent's head;
 * "Not now" changes nothing. Either way the welcome closes for good
 * (`POST /api/ui/auth/welcome/done`) and the reader lands where a login lands.
 * An account that may not edit agents, or an install without a main agent,
 * closes it without a screen.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { defaultLookFor, normalizeAgentLook, type AgentLook } from '@/components/mascot/agent-look';
import { LookStylerHost } from '@/components/mascot/look-styler/look-styler';
import { MascotStyleSwitch } from '@/components/mascot/look-styler/mascot-style-switch';
import { fetchMe, meCan } from '@/lib/auth';
import { authLanding } from '@/lib/auth-landing';
import { t } from '@/lib/i18n';
import { agentConfigPath, loadMainAgent, type Fetcher } from '../agent-create';
import { stepHref } from '../onboarding-flow';

export const WELCOME_DONE_PATH = '/api/ui/auth/welcome/done';

/** Closes the welcome; a failure is not worth holding the reader for — it is offered again at the next login. */
export async function closeWelcome(fetcher: Fetcher = fetch): Promise<void> {
  await fetcher(WELCOME_DONE_PATH, { method: 'POST' }).catch(() => undefined);
}

/** Saves the look and makes the mascot the head the agent shows everywhere. */
export async function keepLook(name: string, look: AgentLook, fetcher: Fetcher = fetch): Promise<boolean> {
  try {
    const res = await fetcher(agentConfigPath(name), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ look, avatar: 'mascot' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function leave(): Promise<void> {
  window.location.replace(await authLanding());
}

type Agent = { name: string; role: string | null; look: AgentLook };

export function MascotStep(): ReactElement | null {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [busy, setBusy] = useState<'keep' | 'skip' | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const me = await fetchMe();
      if (!alive) return;
      if (!me.user) { window.location.replace(stepHref('signin')); return; }
      if (me.welcome !== 'mascot') { void leave(); return; }
      const main = meCan(me, 'agents:manage') === false ? null : await loadMainAgent();
      if (!alive) return;
      if (!main?.name) { await closeWelcome(); void leave(); return; }
      const base = defaultLookFor(main.role ?? '');
      setAgent({ name: main.name, role: main.role, look: normalizeAgentLook(main.look ?? base, base) });
    })();
    return () => { alive = false; };
  }, []);

  const onLook = useCallback((look: AgentLook) => {
    setFailed(false);
    setAgent((current) => (current ? { ...current, look } : current));
  }, []);

  const finish = async (keep: boolean): Promise<void> => {
    if (!agent || busy) return;
    setBusy(keep ? 'keep' : 'skip');
    if (keep && !(await keepLook(agent.name, agent.look))) {
      setFailed(true);
      setBusy(null);
      return;
    }
    await closeWelcome();
    await leave();
  };

  if (!agent) return null;

  return (
    <div className="flex h-full max-h-[820px] w-full max-w-[920px] flex-col items-center text-center" data-onboarding-mascot="">
      <h1 className="text-[28px] font-bold leading-tight tracking-[-0.02em]">{t('onboarding.mascot.title', { name: agent.name })}</h1>
      <p className="mt-1.5 max-w-[560px] text-sm leading-snug text-muted-foreground">{t('onboarding.mascot.subtitle', { name: agent.name })}</p>
      <div className="mt-5 min-h-0 w-full flex-1 overflow-auto rounded-[18px] bg-muted/40 p-3 text-left">
        <LookStylerHost look={agent.look} onChange={onLook} name={agent.name} role={agent.role} header={<MascotStyleSwitch />} />
      </div>
      <p role="status" aria-live="polite" className="mt-3 min-h-4 text-[12.5px] leading-4 text-destructive">
        {failed ? t('onboarding.mascot.failed') : null}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2.5">
        <Button variant="ghost" size="lg" className="h-11 rounded-full" disabled={busy !== null} onClick={() => { void finish(false); }}>
          {busy === 'skip' && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          {t('onboarding.mascot.skip')}
        </Button>
        <Button size="lg" className="h-11 gap-2 rounded-full px-6" disabled={busy !== null} onClick={() => { void finish(true); }} data-mascot-keep="">
          {busy === 'keep' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {t('onboarding.mascot.keep')}
          {busy !== 'keep' && <ArrowRight className="h-4 w-4" aria-hidden />}
        </Button>
      </div>
      <p className="mt-3 text-[12.5px] text-muted-foreground">{t('onboarding.mascot.later')}</p>
    </div>
  );
}
