'use client';

/**
 * The 3D / 2D switch the onboarding paints above the mascot configurator
 * (through `LookStylerHost`'s `header`). It is the very preference of
 * Settings → Appearance → Mascot style (`mascotStylePref`): a choice made here
 * shows there, and the other way round, on every mascot of the account.
 *
 * Without WebGL2 the browser cannot draw the 3D head: the switch shows 2D,
 * cannot be changed, and says why. The stored choice is left as it is, so a
 * browser that can draw 3D later still finds it.
 *
 * `MascotStyleToggle` is the compact form the welcome screen paints next to
 * the light/dark switch, before any account exists: the preference keeps the
 * choice in the browser until a session can take it, so a refused write is
 * not an error there.
 */
import { useId, type ReactElement } from 'react';
import { MASCOT_STYLES, mascotStylePref, useMascotStyle, useWebGL2, type MascotStyle, type MascotStylePref } from '@/components/mascot/mascot-style-pref';
import { t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';
import { cn } from '@/lib/utils';

const LABEL_KEYS: Record<MascotStyle, string> = {
  '3d': 'appearance.mascotsStyle3d',
  '2d': 'appearance.mascotsStyle2d',
};

/** The style shown (2D without WebGL2) and the way to change it; `onRefused` hears a write the daemon did not take. */
function useStyleChoice(pref: MascotStylePref, onRefused?: () => void): { shown: MascotStyle; webgl2: boolean; choose: (next: MascotStyle) => void } {
  const chosen = useMascotStyle(pref);
  const webgl2 = useWebGL2();
  const choose = (next: MascotStyle): void => {
    if (!webgl2 || next === chosen) return;
    void pref.set(next).then((ok) => { if (!ok) onRefused?.(); });
  };
  return { shown: webgl2 ? chosen : '2d', webgl2, choose };
}

export function MascotStyleSwitch({ pref = mascotStylePref() }: { pref?: MascotStylePref }): ReactElement {
  const labelId = useId();
  const { shown, webgl2, choose } = useStyleChoice(pref, () => {
    void (async () => {
      // Loaded on failure only: the onboarding's steps stay free of the toaster
      // (and of the react-dom it pulls in) until there is something to say.
      const { toast } = await import('sonner');
      toast.error(t('appearance.saveError'));
    })();
  });
  return (
    <div className="flex flex-col gap-1.5" data-mascot-style-switch="">
      <div className="flex items-center gap-3">
        <span id={labelId} className="text-xs font-semibold text-muted-foreground">{t('appearance.mascotsStyle')}</span>
        <div
          role="radiogroup"
          aria-labelledby={labelId}
          aria-disabled={!webgl2 || undefined}
          className="grid grid-cols-2 gap-1 rounded-xl bg-background/70 p-1"
        >
          {MASCOT_STYLES.map((option) => {
            const on = shown === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!webgl2}
                data-mascot-style={option}
                onClick={() => choose(option)}
                className={cn(
                  'h-8 min-w-[52px] rounded-lg px-3 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed',
                  on ? 'bg-muted ring-[1.5px] ring-inset ring-foreground/55' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent',
                )}
              >
                {t(LABEL_KEYS[option])}
              </button>
            );
          })}
        </div>
      </div>
      <p className="px-0.5 text-[11.5px] text-muted-foreground" data-mascot-style-note={webgl2 ? 'shared' : 'no-webgl'}>
        {webgl2 ? t('appearance.mascotsStyleShared', { settingsPath: settingsPath('interface', 'appearance') }) : t('appearance.mascotsStyleNoWebgl')}
      </p>
    </div>
  );
}

export function MascotStyleToggle({ pref = mascotStylePref(), className }: { pref?: MascotStylePref; className?: string }): ReactElement {
  const { shown, webgl2, choose } = useStyleChoice(pref);
  const reason = webgl2 ? undefined : t('appearance.mascotsStyleNoWebgl');
  return (
    <div
      role="radiogroup"
      aria-label={t('appearance.mascotsStyle')}
      aria-disabled={!webgl2 || undefined}
      aria-description={reason}
      title={reason ?? t('appearance.mascotsStyle')}
      data-mascot-style-toggle={webgl2 ? '' : 'no-webgl'}
      className={cn('flex gap-0.5 rounded-full bg-muted/70 p-0.5', className)}
    >
      {MASCOT_STYLES.map((option) => {
        const on = shown === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={!webgl2}
            data-mascot-style={option}
            onClick={() => choose(option)}
            className={cn(
              'flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-[11.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed',
              on ? 'bg-card text-foreground shadow-elev-1' : 'text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:hover:text-muted-foreground',
            )}
          >
            {t(LABEL_KEYS[option])}
          </button>
        );
      })}
    </div>
  );
}
