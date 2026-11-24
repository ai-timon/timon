'use client';

import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { reportDirectoryPick, useDirectoryPicker } from '@/components/directory-browser';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { settingCopy } from '@/lib/settings-copy';

export type Setting = {
  key: string;
  type: 'bool' | 'int' | 'float' | 'string';
  group: string;
  label: string;
  description: string | null;
  unit: string | null;
  advanced: boolean;
  value: boolean | number | string;
  default: boolean | number | string;
  source: 'env' | 'config' | 'db' | 'default';
  overridden: boolean;
  /** Bundled plugin the setting belongs to (catalog id), if any. */
  owner?: string | null;
  /** `directory`: a folder path, pickable with the OS dialog on desktop. */
  input?: 'directory' | null;
  /** Inclusive bounds of a numeric setting; the daemon refuses a value outside them. */
  min?: number | null;
  max?: number | null;
};

/** Inline sentence for a numeric draft outside the setting's bounds, null when
 *  it fits (or is not a number yet: the daemon names a type error itself). */
export function settingRangeError(setting: Setting, draft: string): string | null {
  if (setting.type !== 'int' && setting.type !== 'float') return null;
  const value = Number(draft);
  if (draft.trim() === '' || !Number.isFinite(value)) return null;
  const min = setting.min ?? null;
  const max = setting.max ?? null;
  if (min !== null && max !== null) return value < min || value > max ? t('settingsPage.outOfRange', { min, max }) : null;
  if (min !== null && value < min) return t('settingsPage.belowMin', { min });
  if (max !== null && value > max) return t('settingsPage.aboveMax', { max });
  return null;
}

export function SettingsRow({
  setting,
  draft,
  saving,
  onDraft,
  onSave,
}: {
  setting: Setting;
  draft: string | undefined;
  saving: boolean;
  onDraft: (key: string, value: string) => void;
  onSave: (key: string, value: string | null) => void;
}): ReactElement {
  const label = settingCopy(setting.key, 'label', setting.label);
  const description = settingCopy(setting.key, 'description', setting.description);
  const unit = settingCopy(setting.key, 'unit', setting.unit);
  const locked = setting.source === 'env' || setting.source === 'config';
  const current = draft !== undefined ? draft : String(setting.value);
  const dirty = draft !== undefined && draft !== String(setting.value);
  const rangeError = dirty ? settingRangeError(setting, current) : null;
  const canSave = dirty && rangeError === null;
  // The folder is read by the active machine's daemon: the OS dialog on this
  // computer's own daemon, its folder browser anywhere else (TIM-0136).
  const isDirectory = setting.input === 'directory';
  const directoryPicker = useDirectoryPicker();
  const browse = async () => {
    const picked = await directoryPicker.pick(current);
    if (picked.status === 'chosen') void onSave(setting.key, picked.path);
    else reportDirectoryPick(picked);
  };

  return (
    <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium leading-snug" title={setting.key}>{label}</span>
          {setting.overridden && !locked && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              {t('settingsPage.modified')}
            </span>
          )}
          {locked && (
            <span
              className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400"
              title={setting.source === 'config' ? t('settingsPage.definedInConfig') : undefined}
            >
              {setting.source === 'config' ? t('settingsPage.definedInConfig') : t('settingsPage.forcedByEnv')}
            </span>
          )}
        </div>
        {description && (
          <p className="mt-1 max-w-[65ch] text-[12px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
        {/* While the value is the default, the field already says it: the
            default is worth a line only once it differs. The setting's key
            stays one hover away on the label, and the search still finds it. */}
        {/* Not for a switch: its position is the state, and "Default: false"
            says nothing the Default button does not. */}
        {setting.type !== 'bool' && String(setting.value) !== String(setting.default) && (
          <p className="mt-1 text-[11px] text-muted-foreground/80">
            {t('settingsPage.defaultValue', {
              value: String(setting.default) === ''
                ? t('settingsPage.empty')
                : unit ? `${String(setting.default)} ${unit}` : String(setting.default),
            })}
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1 self-start">
        <div className="flex items-center gap-2">
          {setting.type === 'bool' ? (
            // The same switch as the panes around it (Appearance, Developer
            // mode): one control for on/off across the whole dialog.
            <Switch
              checked={Boolean(setting.value)}
              disabled={locked || saving}
              aria-label={label}
              className="my-1"
              onCheckedChange={(checked) => void onSave(setting.key, checked ? 'true' : 'false')}
            />
          ) : (
            <>
              <input
                type={setting.type === 'string' ? 'text' : 'number'}
                step={setting.type === 'float' ? 'any' : undefined}
                min={setting.type === 'string' ? undefined : setting.min ?? undefined}
                max={setting.type === 'string' ? undefined : setting.max ?? undefined}
                value={current}
                aria-label={label}
                disabled={locked}
                aria-invalid={rangeError !== null || undefined}
                onChange={(e) => onDraft(setting.key, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canSave) void onSave(setting.key, current); }}
                className={cn(
                  'h-7 rounded-md border border-border bg-background px-2 text-[12px] tabular-nums',
                  setting.type === 'string' ? 'w-56 max-w-full' : 'w-28',
                  rangeError !== null && 'border-destructive',
                  locked && 'opacity-50',
                )}
              />
              {isDirectory && !locked && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[12px]"
                  disabled={saving}
                  onClick={() => void browse()}
                >
                  {t('setupPage.browse')}
                </Button>
              )}
              {isDirectory && directoryPicker.dialog}
              {unit && <span className="text-[11px] text-muted-foreground">{unit}</span>}
              {dirty && (
                <Button
                  size="sm"
                  className="h-7 text-[12px]"
                  disabled={saving || !canSave}
                  onClick={() => void onSave(setting.key, current)}
                >
                  {t('settingsPage.save')}
                </Button>
              )}
            </>
          )}
          {setting.overridden && !locked && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[12px] text-muted-foreground"
              disabled={saving}
              onClick={() => void onSave(setting.key, null)}
            >
              {t('settingsPage.defaultBtn')}
            </Button>
          )}
        </div>
        {rangeError && (
          <p role="alert" className="max-w-[28ch] text-right text-[11px] leading-snug text-destructive">{rangeError}</p>
        )}
      </div>
    </div>
  );
}
