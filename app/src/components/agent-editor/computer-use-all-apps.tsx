'use client';

/**
 * "All applications": instead of allowing applications one by one, a person lets the agent drive every
 * application but an exclusion list, which always wins (password managers, terminals and Timon itself
 * until the person edits it). Unlisted applications take the mode chosen here; an application of the
 * allowed list keeps its own. Only a person turns it on: the daemon refuses it to every token.
 *
 * A short label, then a card of rows: the switch, then, once on, the mode of the unlisted applications
 * and the exclusions, edited in a dialog so no list stays painted on the page.
 */
import React, { useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { t } from '@/lib/i18n';
import { DEFAULT_EXCLUDED_APPS, isDefaultExcludedApps, type ComputerAppMode } from '@/lib/computer-use';

const MODES: { value: ComputerAppMode; label: string }[] = [
  { value: 'foreground', label: 'editPage.computerAppsForeground' },
  { value: 'background', label: 'editPage.computerAppsBackground' },
];

export function ComputerUseAllApps({
  enabled, onEnabledChange, mode, onModeChange, excluded, onExcludedChange,
}: {
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  /** The mode of the applications the allowed list does not name: the agent's default mode. */
  mode: ComputerAppMode;
  onModeChange: (next: ComputerAppMode) => void;
  excluded: string[];
  onExcludedChange: (next: string[]) => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const defaults = isDefaultExcludedApps(excluded);
  const count = excluded.length;
  return (
    <ProviderSection title={t('editPage.computerAllApps')} className="mt-3">
      <ProviderSettingRow
          data-computer-use-all-apps={enabled ? 'on' : 'off'}
          title={t('editPage.computerAllAppsToggle')}
          status={t(enabled ? 'editPage.computerAllAppsOn' : 'editPage.computerAllAppsOff')}
          action={(
            <Switch
              checked={enabled}
              onCheckedChange={onEnabledChange}
              aria-label={t('editPage.computerAllAppsToggle')}
              data-computer-use-all-apps-switch
            />
          )}
        />
      {enabled && (
        <ProviderSettingRow
          data-computer-use-unlisted-mode={mode}
          title={t('editPage.computerAllAppsUnlisted')}
          status={t(mode === 'background' ? 'editPage.computerAllAppsUnlistedBackground' : 'editPage.computerAllAppsUnlistedForeground')}
          action={(
            <span role="radiogroup" aria-label={t('editPage.computerAllAppsUnlisted')} className="inline-flex gap-0.5 rounded-md bg-background/70 p-0.5">
              {MODES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === option.value}
                  data-computer-use-unlisted-option={option.value}
                  onClick={() => onModeChange(option.value)}
                  className={`rounded px-2 py-0.5 text-[11.5px] ${mode === option.value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {t(option.label)}
                </button>
              ))}
            </span>
          )}
        />
      )}
      {enabled && (
        <ProviderSettingRow
          data-computer-use-excluded={defaults ? 'default' : 'edited'}
          title={t('editPage.computerAllAppsExcluded')}
          status={t(defaults ? 'editPage.computerAllAppsExcludedDefault' : 'editPage.computerAllAppsExcludedCount', { count })}
          action={(
            <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => setEditing(true)} data-computer-use-excluded-edit>
              {t('editPage.computerAllAppsExcludedEdit')}
            </Button>
          )}
          menuLabel={t('editPage.computerAllAppsExcludedMore')}
          menu={(
            <DropdownMenuItem disabled={defaults} onSelect={() => onExcludedChange([...DEFAULT_EXCLUDED_APPS])} data-computer-use-excluded-reset>
              <RotateCcw aria-hidden />{t('editPage.computerAllAppsExcludedReset')}
            </DropdownMenuItem>
          )}
        />
      )}
      {editing && (
        <ExcludedAppsDialog
          initial={excluded}
          onCancel={() => setEditing(false)}
          onSave={(next) => { onExcludedChange(next); setEditing(false); }}
        />
      )}
    </ProviderSection>
  );
}

/** The exclusions, edited on a copy: nothing changes until Save. */
export function ExcludedAppsDialog({ initial, onCancel, onSave }: {
  initial: readonly string[];
  onCancel: () => void;
  onSave: (next: string[]) => void;
}): React.ReactElement {
  const [list, setList] = useState<string[]>([...initial]);
  const [text, setText] = useState('');
  const add = (): void => {
    const name = text.trim();
    setText('');
    if (!name || list.some((app) => app.toLowerCase() === name.toLowerCase())) return;
    setList([name, ...list]);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="sm:max-w-lg" data-computer-use-excluded-dialog="">
        <DialogHeader>
          <DialogTitle>{t('editPage.computerAllAppsExcluded')}</DialogTitle>
          <DialogDescription>{t('editPage.computerAllAppsExcludedDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
              placeholder={t('editPage.computerAllAppsExcludedAdd')}
              aria-label={t('editPage.computerAllAppsExcludedAdd')}
              className="h-8 min-w-0 flex-1 rounded-md bg-muted px-2.5 text-[12.5px] outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
              data-computer-use-excluded-input
            />
            <Button type="button" size="sm" variant="outline" className="h-8" onClick={add} disabled={!text.trim()}>
              {t('editPage.computerAllAppsExcludedAddButton')}
            </Button>
          </div>
          <ul className="flex max-h-72 flex-wrap gap-1.5 overflow-y-auto" data-computer-use-excluded-list>
            {list.map((app) => (
              <li key={app} data-computer-use-excluded-app={app} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[12px]">
                <span className="[overflow-wrap:anywhere]">{app}</span>
                <button
                  type="button"
                  onClick={() => setList(list.filter((entry) => entry !== app))}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={t('editPage.computerAppsRemove', { app })}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>{t('editPage.computerAllAppsExcludedCancel')}</Button>
          <Button type="button" onClick={() => onSave(list)} data-computer-use-excluded-save>{t('editPage.computerAllAppsExcludedSave')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
