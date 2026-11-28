'use client';

/**
 * The way out of step 3, always on screen (`components/onboarding/setup-trouble.ts`
 * says how loud; `setup-skip.ts` beside it answers the step).
 *
 * Fixed over everything, the opaque loader included: when the agent's tools are
 * refused its first card never comes, the loader never lifts, and a button
 * inside the chat would sit behind it.
 */
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import type { SetupTrouble } from '@/components/onboarding/setup-trouble';

export function SetupEscape({ trouble, busy, error, onSkip, onRestart }: {
  trouble: SetupTrouble;
  busy: boolean;
  error: string | null;
  onSkip: () => void;
  onRestart: () => void;
}): ReactNode {
  return (
    <div data-setup-escape={trouble.level} className="fixed right-[calc(1rem+var(--timon-window-controls-w,0px))] top-4 z-[60] flex max-w-sm flex-col items-end gap-2">
      {trouble.level === 'quiet' ? (
        <button
          type="button"
          disabled={busy}
          onClick={onSkip}
          className="rounded-full bg-background/80 px-3 py-1.5 text-sm text-muted-foreground backdrop-blur transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {t('setupChat.escape.skip')}
        </button>
      ) : (
        <div role="alert" className="space-y-3 rounded-xl bg-popover p-4 text-popover-foreground shadow-lg">
          <p className="text-sm font-medium">{t(`setupChat.escape.${trouble.reason}.title`)}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">{t(`setupChat.escape.${trouble.reason}.body`)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={onSkip}>{t('setupChat.escape.skip')}</Button>
            {trouble.canRestart && (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRestart}>{t('setupChat.escape.restart')}</Button>
            )}
          </div>
        </div>
      )}
      {error && <p role="alert" className="rounded-md bg-popover px-3 py-1.5 text-sm text-destructive shadow">{error}</p>}
    </div>
  );
}
