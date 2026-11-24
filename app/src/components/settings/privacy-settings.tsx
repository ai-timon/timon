'use client';

/**
 * Settings › System › Privacy, its own part: how long Timon keeps the mission
 * history and the raw memory facts on the computer. One row per setting, the
 * duration at the left, "Change" at the right (a dialog), "Keep everything"
 * and "Back to the default" in the "…" menu. The rows come from the dialog's
 * settings load, and save through its door, like every other row.
 */
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { settingRangeError, type Setting } from '@/components/settings/settings-row';
import { useMe } from '@/hooks/use-me';
import { t } from '@/lib/i18n';
import { RETENTION_ROWS, retentionRowView, retentionStatus, type RetentionCopy } from '@/lib/privacy-retention';

export function PrivacySettings({ rows, saving, onSave }: {
  rows: readonly Setting[];
  saving: string | null;
  onSave: (key: string, value: string | null) => void;
}): ReactElement | null {
  const me = useMe();
  // A daemon too old to say is yes, as `meCan` reads it: its route refuses for itself.
  const canWrite = me !== null && (me.can === null || me.can['settings:write'] !== false);
  const [editing, setEditing] = useState<{ setting: Setting; copy: RetentionCopy } | null>(null);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const shown = RETENTION_ROWS.flatMap((row) => {
    const setting = byKey.get(row.key);
    return setting ? [{ setting, copy: row.copy }] : [];
  });
  if (shown.length === 0) return null;

  return (
    <div className="max-w-2xl">
      <ProviderSection title={t('privacySettings.section')}>
        {shown.map(({ setting, copy }) => {
          const view = retentionRowView(setting);
          const status = retentionStatus(copy, view);
          const busy = saving === setting.key;
          const writable = canWrite && view.lockedBy === null;
          const menu = writable && (view.canKeepAll || view.canReset) ? (
            <>
              {view.canKeepAll && (
                <DropdownMenuItem disabled={busy} onSelect={() => { onSave(setting.key, '0'); }} data-privacy-keep-all="">
                  {t('privacySettings.keepAll')}
                </DropdownMenuItem>
              )}
              {view.canReset && (
                <DropdownMenuItem disabled={busy} onSelect={() => { onSave(setting.key, null); }} data-privacy-reset="">
                  {t('privacySettings.reset', { days: view.defaultDays })}
                </DropdownMenuItem>
              )}
            </>
          ) : undefined;
          return (
            <ProviderSettingRow
              key={setting.key}
              data-privacy-row={setting.key}
              title={t(`privacySettings.${copy}.title`)}
              status={(
                <span>
                  {t(status.key, status.values)}
                  {status.lock ? ` · ${t(status.lock)}` : ''}
                </span>
              )}
              action={writable ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={busy}
                  onClick={() => { setEditing({ setting, copy }); }}
                >
                  {t('privacySettings.change')}
                </Button>
              ) : undefined}
              menu={menu}
              menuLabel={t('privacySettings.more')}
            />
          );
        })}
      </ProviderSection>
      <RetentionDialog
        editing={editing}
        onClose={() => { setEditing(null); }}
        onSave={(key, value) => { setEditing(null); onSave(key, value); }}
      />
    </div>
  );
}

function RetentionDialog({ editing, onClose, onSave }: {
  editing: { setting: Setting; copy: RetentionCopy } | null;
  onClose: () => void;
  onSave: (key: string, value: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (editing) setDraft(String(retentionRowView(editing.setting).days));
  }, [editing]);
  const error = editing ? settingRangeError(editing.setting, draft) : null;
  const valid = draft.trim() !== '' && Number.isInteger(Number(draft)) && error === null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (editing && valid) onSave(editing.setting.key, String(Number(draft)));
  };

  return (
    <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{editing ? t(`privacySettings.${editing.copy}.title`) : ''}</DialogTitle>
          </DialogHeader>
          <label className="flex items-center gap-2 text-[13px]">
            <Input
              type="number"
              inputMode="numeric"
              min={editing?.setting.min ?? 0}
              max={editing?.setting.max ?? undefined}
              step={1}
              value={draft}
              aria-invalid={error !== null || undefined}
              aria-label={t('privacySettings.days')}
              onChange={(event) => { setDraft(event.target.value); }}
              className="w-28 tabular-nums"
              autoFocus
            />
            <span className="text-muted-foreground">{t('privacySettings.days')}</span>
          </label>
          <p className="text-[12px] text-muted-foreground">{t('privacySettings.zeroKeeps')}</p>
          {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>{t('privacySettings.cancel')}</Button>
            <Button type="submit" disabled={!valid}>{t('privacySettings.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
