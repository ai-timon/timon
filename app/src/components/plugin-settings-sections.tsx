'use client';

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { PluginWebhooksPane } from '@/components/plugin-webhooks-pane';
import { PluginBoundary } from '@/lib/plugin-host/plugin-boundary';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type PluginSetting = {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'secret';
  label: string;
  default?: string | number | boolean;
  value?: unknown;
  configured: boolean;
};

function PluginSettingsForm({ pluginId }: { pluginId: string }): ReactElement {
  const [settings, setSettings] = useState<PluginSetting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    setDrafts({});
    void fetch(`/api/ui/plugins/${encodeURIComponent(pluginId)}/settings`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((v: { settings?: PluginSetting[] }) => setSettings(v.settings ?? []));
  }, [pluginId]);

  const save = useCallback(async (setting: PluginSetting, value: string | boolean) => {
    setSaving(setting.key);
    const parsed = setting.type === 'number' ? Number(value) : value;
    const response = await fetch(`/api/ui/plugins/${encodeURIComponent(pluginId)}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: setting.key, value: parsed }),
    });
    setSaving(null);
    if (!response.ok) {
      toast.error(t('settingsPage.saveError'));
      return;
    }
    toast.success(t('settingsPage.saved'));
    setSettings((all) => all.map((row) => (
      row.key === setting.key
        ? { ...row, configured: true, value: setting.type === 'secret' ? '' : parsed }
        : row
    )));
    setDrafts((d) => {
      const next = { ...d };
      delete next[setting.key];
      return next;
    });
  }, [pluginId]);

  return (
    <div className="flex flex-col">
      {settings.map((setting) => {
        const current = drafts[setting.key] !== undefined
          ? drafts[setting.key]!
          : String(setting.value ?? setting.default ?? '');
        const dirty = drafts[setting.key] !== undefined
          && drafts[setting.key] !== String(setting.value ?? setting.default ?? '');
        return (
          <div
            key={setting.key}
            className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8"
          >
            <div className="min-w-0 flex-1">
              <span className="text-[13px] font-medium leading-snug" title={setting.key}>{setting.label}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2 self-start">
              {setting.type === 'boolean' ? (
                <Switch
                  checked={Boolean(setting.value ?? setting.default)}
                  disabled={saving === setting.key}
                  aria-label={setting.label}
                  className="my-1"
                  onCheckedChange={(checked) => void save(setting, checked)}
                />
              ) : (
                <>
                  <input
                    type={setting.type === 'secret' ? 'password' : setting.type === 'number' ? 'number' : 'text'}
                    value={current}
                    placeholder={setting.type === 'secret' && setting.configured
                      ? t('settingsPage.secretConfigured')
                      : undefined}
                    onChange={(e) => setDrafts((d) => ({ ...d, [setting.key]: e.target.value }))}
                    onBlur={(e) => {
                      if (e.target.value) void save(setting, e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && dirty) void save(setting, current);
                    }}
                    className={cn(
                      'h-7 rounded-md border border-border bg-background px-2 text-[12px]',
                      setting.type === 'string' || setting.type === 'secret' ? 'w-56 max-w-full' : 'w-28 tabular-nums',
                    )}
                  />
                  {dirty && (
                    <Button
                      size="sm"
                      className="h-7 text-[12px]"
                      disabled={saving === setting.key}
                      onClick={() => void save(setting, current)}
                    >
                      {t('settingsPage.save')}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Auto form for a plugin that declared `timon.settings` or `timon.webhooks` without occupying `settings.section`. */
export function PluginSettingsPane({ pluginId }: { pluginId: string }): ReactElement {
  return (
    <PluginBoundary pluginId={pluginId}>
      <PluginSettingsForm pluginId={pluginId} />
      <PluginWebhooksPane pluginId={pluginId} />
    </PluginBoundary>
  );
}
