'use client';

/**
 * What the install sheet says when the package (or a child of the bundle)
 * is unsigned and developer mode is off: why it will not load, and the two
 * ways out — turn the mode on right here, or open the switch in Settings.
 * When a fixed plugin composition keeps the mode shut, it says that instead of
 * offering a button that cannot work.
 */
import type { ReactElement } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { developerModeBlockedText, type DeveloperModeState } from '@/lib/developer-mode';
import { t } from '@/lib/i18n';

export function PluginInstallDeveloperMode({ state, busy, onEnable, onOpenSettings }: {
  /** `null` while it loads, or when the daemon could not say. */
  state: DeveloperModeState | null;
  busy: boolean;
  onEnable: () => void;
  onOpenSettings: () => void;
}): ReactElement {
  const blocked = state ? developerModeBlockedText(state) : null;
  return (
    <div className="flex gap-2.5 rounded-md bg-amber-500/10 px-3 py-2.5 text-[12px] leading-relaxed text-amber-900 dark:text-amber-200" data-testid="unsigned-developer-mode">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-2">
        <p className="m-0 font-semibold">{t('pluginsPage.install.developerMode.title')}</p>
        <p className="m-0">{t('pluginsPage.install.developerMode.body')}</p>
        {blocked && <p className="m-0">{blocked}</p>}
        <div className="flex flex-wrap gap-2">
          {state?.available && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={onEnable}>
              {t('pluginsPage.install.developerMode.enable')}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={onOpenSettings}>
            {t('pluginsPage.install.developerMode.openSettings')}
          </Button>
        </div>
      </div>
    </div>
  );
}
