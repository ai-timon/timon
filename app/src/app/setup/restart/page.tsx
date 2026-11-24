'use client';

/**
 * Onboarding step 5 — the restart, and the last gate of the wizard.
 *
 * `timon.config.json` is read once, at boot. The daemon that served steps 1 to 4
 * is still running on the defaults the wizard replaced, so until this screen
 * existed the normal ending of onboarding was a cockpit whose daemon knew
 * nothing about the configuration its owner had just chosen — pinned binaries
 * invisible, modules at their defaults, and every symptom blamed on something
 * else. The restart used to be advice in a dialog, next to a "later" button.
 *
 * It is now a step, and it cannot be skipped: the first-run gate routes here
 * while `capabilities.restartOnboarding` is true, and that flag only drops when
 * a DIFFERENT process answers (`onboarding-restart.ts` compares boot ids). A
 * reload cannot satisfy it, and nothing here has to be believed — the screen
 * polls the daemon until the new one replies.
 *
 * Three ways to restart, in the order they are preferred:
 *   1. the desktop client, which owns the daemon it spawned;
 *   2. the daemon itself, through its supervisor (`POST /api/setup/restart`);
 *   3. the exact command to paste, when neither can — and as the recourse when
 *      the attempt fails.
 *
 * The one exception to "cannot be skipped" is a machine with NO supervisor:
 * there is no process to wait for, and a gate nobody can satisfy is worse than
 * a configuration read one boot late. The daemon decides that, not this screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingBackdrop } from '@/components/onboarding-backdrop';
import { CommandToRun } from '@/components/command-to-run';
import { RemoteAccess } from '@/components/remote-access-panel';
import { desktopBridge } from '@/lib/desktop';
import { t } from '@/lib/i18n';
import { apiErrorMessage } from '@/lib/api-error';

type RestartStatus = {
  pending: boolean;
  supervisor: string | null;
  canSelfRestart: boolean;
  command: string | null;
};

/** How long we keep asking before offering the manual recourse instead. A
 *  systemd restart answers in a second or two; a packaged one can take longer. */
const POLL_MS = 1500;
const GIVE_UP_MS = 90_000;

export default function RestartSetupPage() {
  const [status, setStatus] = useState<RestartStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canBridge, setCanBridge] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // Kept in a ref, not in state: the poll must be stoppable from an unmount
  // without re-running the effect that started it.
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const read = useCallback(async (): Promise<RestartStatus | null> => {
    const response = await fetch('/api/ui/setup/restart', { cache: 'no-store' });
    if (!response.ok) throw new Error('unreadable');
    return await response.json() as RestartStatus;
  }, []);

  const load = useCallback(async () => {
    try {
      const body = await read();
      setStatus(body);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [read]);

  useEffect(() => {
    // Resolved after mount: the bridge does not exist on the server, and a
    // button rendered from it would not survive hydration.
    setCanBridge(desktopBridge() !== null);
    void load();
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  /** Gives the button back. */
  function stopWatching() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setWaiting(false);
  }

  /** Asks until a NEW daemon answers. Failures are expected here — the process
   *  we are talking to is the one going away. */
  function watchForNewDaemon() {
    if (timer.current) clearInterval(timer.current);
    setWaiting(true);
    setTimedOut(false);
    const startedAt = Date.now();
    timer.current = setInterval(() => {
      void (async () => {
        try {
          const body = await read();
          setStatus(body);
          if (!body?.pending) {
            if (timer.current) clearInterval(timer.current);
            timer.current = null;
            setWaiting(false);
          }
        } catch { /* the daemon is restarting: keep asking */ }
        if (Date.now() - startedAt > GIVE_UP_MS && timer.current) {
          clearInterval(timer.current);
          timer.current = null;
          setWaiting(false);
          setTimedOut(true);
        }
      })();
    }, POLL_MS);
  }

  async function restart() {
    setError(null);
    const bridge = desktopBridge();
    if (bridge) {
      // The client owns the daemon it spawned; it reloads the window itself.
      watchForNewDaemon();
      try {
        await bridge.restartAfterSetup();
      } catch {
        // A shell that refuses (the embedded daemon still holds the port) must
        // give the button back: leaving the poll armed would hold it disabled on
        // "Restarting…" for the whole timeout, next to its own error.
        stopWatching();
        setError(t('restartStep.failed'));
      }
      return;
    }
    try {
      const response = await fetch('/api/ui/setup/restart', { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { command?: string | null };
        setStatus((previous) => (previous ? { ...previous, canSelfRestart: false, command: body.command ?? previous.command } : previous));
        setError(apiErrorMessage(body, t('restartStep.failed')));
        return;
      }
      watchForNewDaemon();
    } catch {
      // The answer leaves before the signal lands, so a network error here is
      // usually the restart itself — watch rather than declare a failure.
      watchForNewDaemon();
    }
  }

  /** Portable mode only. The daemon refuses (409) on a supervised machine. */
  async function continueWithoutRestart() {
    setError(null);
    try {
      const response = await fetch('/api/ui/setup/restart/skip', { method: 'POST' });
      if (!response.ok) { setError(apiErrorMessage(await response.json().catch(() => ({})), t('restartStep.failed'))); return; }
      setStatus(await response.json() as RestartStatus);
    } catch { setError(t('restartStep.failed')); }
  }

  const done = status !== null && !status.pending;
  const unsupervised = status?.supervisor === null;

  return (
    <OnboardingBackdrop className="max-w-2xl">
      <nav aria-label={t('teamSetup.progressLabel')} className="mb-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
        <span>{t('teamSetup.step1')}</span><span>{t('teamSetup.step2')}</span><span>{t('teamSetup.step3')}</span>
        <span>{t('teamSetup.step4')}</span>
        <span aria-current="step" className="font-medium text-primary">{t('teamSetup.step5')}</span>
      </nav>

      {done ? (
        <>
          <Check className="h-8 w-8 text-primary" aria-hidden="true" />
          <h1 className="mt-4 text-3xl font-semibold tracking-tight">{t('restartStep.doneTitle')}</h1>
          <p className="mt-3 leading-relaxed text-muted-foreground">{t('restartStep.doneDescription')}</p>
          <div className="mt-8">
            <Button asChild><a href="/">{t('restartStep.open')}<ArrowRight className="ml-2 h-4 w-4" aria-hidden /></a></Button>
          </div>
        </>
      ) : (
        <>
          <h1 className="text-3xl font-semibold tracking-tight">{t('restartStep.title')}</h1>
          <p className="mt-3 leading-relaxed text-muted-foreground">{t('restartStep.description')}</p>

          {status === null ? (
            <div role="status" className="mt-8 space-y-4">
              <p className="text-sm text-muted-foreground">{t(loadFailed ? 'restartStep.loadFailed' : 'restartStep.loading')}</p>
              {loadFailed && <Button variant="outline" onClick={() => void load()}>{t('teamSetup.retry')}</Button>}
            </div>
          ) : (
            <div className="mt-8 space-y-6">
              {(canBridge || status.canSelfRestart) && (
                <div className="flex flex-wrap items-center gap-4">
                  <Button type="button" disabled={waiting} onClick={() => void restart()}>
                    <RefreshCw className={`mr-2 h-4 w-4 ${waiting ? 'animate-spin' : ''}`} aria-hidden />
                    <span role="status">{t(waiting ? 'restartStep.restarting' : 'restartStep.restartNow')}</span>
                  </Button>
                  {waiting && <p className="text-sm text-muted-foreground">{t('restartStep.waitingHint')}</p>}
                </div>
              )}

              {/* The command is not a fallback hidden behind a failure: on a
                  machine the daemon cannot restart itself, it IS the step. */}
              {(!canBridge && !status.canSelfRestart || timedOut) && status.command && (
                <section className="space-y-2 rounded-xl border border-border bg-card p-4">
                  <h2 className="text-sm font-medium">{t('restartStep.manualTitle')}</h2>
                  <p className="text-xs text-muted-foreground">{t('restartStep.manualHint')}</p>
                  <CommandToRun command={status.command} label={t('setupPage.remoteAccessCommandLabel')} />
                  <Button variant="outline" type="button" disabled={waiting} onClick={() => watchForNewDaemon()}>
                    {t(waiting ? 'restartStep.checking' : 'restartStep.check')}
                  </Button>
                </section>
              )}

              {timedOut && <p role="alert" className="text-sm text-muted-foreground">{t('restartStep.timedOut')}</p>}
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

              {/* No supervisor on this machine: nothing will ever restart on its
                  own, so the daemon itself allows the step through. */}
              {unsupervised && (
                <div className="space-y-2 pt-4">
                  <p className="text-sm text-muted-foreground">{t('restartStep.unsupervisedHint')}</p>
                  <Button variant="outline" type="button" onClick={() => void continueWithoutRestart()}>
                    {t('restartStep.continueAnyway')}
                  </Button>
                </div>
              )}

              <RemoteAccess />
            </div>
          )}
        </>
      )}
    </OnboardingBackdrop>
  );
}
