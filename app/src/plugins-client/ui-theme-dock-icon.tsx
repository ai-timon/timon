'use client';

import { useEffect, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { chooseDockIcon, DOCK_ICONS, readDockIcon, type DockIcon } from '@/lib/dock-icon';

const DOCK_ICON_OPTIONS: Record<DockIcon, { label: string; hint: string; picture: string }> = {
  classic: { label: 'appearance.dockIconClassic', hint: 'appearance.dockIconClassicHint', picture: '/icon-192.png' },
  dark: { label: 'appearance.dockIconDark', hint: 'appearance.dockIconDarkHint', picture: '/icon-192-dark.png' },
};

/**
 * "Dock icon" (macOS desktop app): the picture the Dock shows while Timon
 * runs. Rendered only where the shell answers, so the web, Windows, Linux
 * and a window showing another machine never see it.
 */
export function DockIconSetting(): ReactElement | null {
  const [icon, setIcon] = useState<DockIcon | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    void readDockIcon().then((current) => { if (alive) setIcon(current); });
    return () => { alive = false; };
  }, []);
  if (icon === null) return null;

  const choose = async (next: DockIcon): Promise<void> => {
    if (next === icon) return;
    const previous = icon;
    setIcon(next);
    setSaving(true);
    const ok = await chooseDockIcon(next);
    setSaving(false);
    if (ok) return;
    setIcon(previous);
    toast.error(t('appearance.dockIconError'));
  };

  return (
    <fieldset className="py-4" data-dock-icon-setting="">
      <legend className="text-[14px] font-semibold leading-snug">{t('appearance.dockIconTitle')}</legend>
      <p className="mt-0.5 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('appearance.dockIconHint')}</p>
      <div role="radiogroup" aria-label={t('appearance.dockIconTitle')} className="mt-3 flex flex-wrap gap-2">
        {DOCK_ICONS.map((option) => {
          const checked = icon === option;
          const { label, hint, picture } = DOCK_ICON_OPTIONS[option];
          return (
            <label
              key={option}
              className={cn(
                'flex min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] leading-snug',
                checked ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
                saving && 'pointer-events-none opacity-60',
              )}
            >
              <input
                type="radio"
                name="appearance-dock-icon"
                value={option}
                checked={checked}
                disabled={saving}
                onChange={() => { void choose(option); }}
                className="size-3.5 shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-muted-foreground/60 bg-transparent transition-colors checked:border-[4px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-dock-icon={option}
              />
              {/* eslint-disable-next-line @next/next/no-img-element -- a static file of public/, shown at its own size */}
              <img src={picture} alt="" width={40} height={40} className="size-10 shrink-0" />
              <span className={cn('min-w-0', checked && 'font-medium')}>{t(label)}<span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">{t(hint)}</span></span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
