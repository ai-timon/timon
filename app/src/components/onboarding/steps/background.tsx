'use client';

/**
 * "When you log out, should Timon keep working?" — right after the welcome,
 * because the background service is installed as soon as the reader leaves it
 * (`preparation.ts`), and how it is installed depends on the answer: lingering
 * on Linux, the LaunchDaemon on macOS, the boot task on Windows, only for
 * "even when logged out".
 * Nothing is preselected: the answer is the reader's click. "Only while I'm
 * logged in" comes first and is the recommended one: nothing runs with nobody
 * at the screen unless the reader asked for it. On a Linux account that
 * already lingers, that row says before the click that it turns lingering
 * off, which stops the reader's other user services at logout too.
 *
 * The step steps aside when there is nothing to ask (`skipsSessionChoice`):
 * a service already registered, or a machine where the answer changes nothing.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ChevronRight, Moon, Sun } from 'lucide-react';
import { t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';
import { cn } from '@/lib/utils';
import { machineSessionStorage } from '@/lib/machines/machine-storage';
import type { ServiceSessionMode } from '@/lib/system-info';
import { useOnboarding } from '../onboarding-context';
import { postOnboarding } from '../preparation';
import { keepSessionChoice, readSessionChoice, skipsSessionChoice } from '../service-session-choice';

const ROWS: readonly { mode: ServiceSessionMode; Icon: typeof Sun }[] = [
  { mode: 'session', Icon: Sun },
  { mode: 'always', Icon: Moon },
];

export function BackgroundStep(): ReactElement | null {
  const { next, back, direction } = useOnboarding();
  const [asking, setAsking] = useState(false);
  const [lingering, setLingering] = useState(false);
  const [recorded] = useState(() => readSessionChoice(machineSessionStorage()));
  const moves = useRef({ next, back, direction });
  moves.current = { next, back, direction };

  useEffect(() => {
    let active = true;
    void postOnboarding('service-status').then((read) => {
      if (!active) return;
      if (!skipsSessionChoice(read)) {
        setLingering(read.kind === 'answer' && read.answer.lingering === true);
        setAsking(true);
        return;
      }
      // Stepped over in the direction the reader was going, so "Back" from the account still reaches the welcome.
      if (moves.current.direction === -1) moves.current.back();
      else moves.current.next();
    });
    return () => { active = false; };
  }, []);

  if (!asking) return <section data-onboarding-step="background" aria-busy="true" />;

  const choose = (mode: ServiceSessionMode): void => {
    keepSessionChoice(machineSessionStorage(), mode);
    next();
  };

  return (
    <section data-onboarding-step="background" className="flex w-full max-w-[560px] flex-col items-center text-center">
      <h1 className="text-[30px] font-bold leading-tight tracking-[-0.02em]">{t('onboarding.background.title')}</h1>
      <p className="mb-[26px] mt-2.5 text-[15px] leading-normal text-muted-foreground">{t('onboarding.background.subtitle')}</p>
      <div
        role="group"
        aria-label={t('onboarding.background.title')}
        className="flex w-full flex-col gap-0.5 rounded-2xl bg-card p-1.5 text-left shadow-elev-3 ring-1 ring-border"
      >
        {ROWS.map(({ mode, Icon }, i) => (
          <button
            key={mode}
            type="button"
            data-session-mode={mode}
            aria-current={recorded === mode ? 'true' : undefined}
            onClick={() => choose(mode)}
            style={{ animationDelay: `${0.08 * i}s` }}
            className={cn(
              'timon-onboarding-rise group flex w-full items-center gap-3.5 rounded-xl p-3.5 text-left transition-colors',
              'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              recorded === mode && 'bg-muted',
            )}
          >
            <span className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-full bg-muted text-foreground">
              <Icon className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-[14.5px] font-semibold">
                {t(`onboarding.background.${mode}.title`)}
                {mode === 'session' && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                    {t('onboarding.background.recommended')}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{t(`onboarding.background.${mode}.description`)}</span>
              {mode === 'session' && lingering && (
                <span data-linger-note className="mt-1 block text-[12.5px] leading-snug text-amber-700 dark:text-amber-400">
                  {t('onboarding.background.session.lingerNote')}
                </span>
              )}
            </span>
            <ChevronRight
              aria-hidden
              className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-[3px] group-hover:text-foreground"
            />
          </button>
        ))}
      </div>
      <p className="mt-3 text-[12.5px] text-muted-foreground">{t('onboarding.background.later', { settingsPath: settingsPath('system', 'installation') })}</p>
    </section>
  );
}
