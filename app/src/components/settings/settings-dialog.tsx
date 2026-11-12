'use client';

/**
 * Settings, as a dialog over whatever page is on screen. Opened by the
 * `?settings=<category>[/<tab>]` parameter (see `settings-navigation.ts`);
 * the filing of rows, grafts and plugin panes lives in `settings-layout.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject, type ReactElement } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Brain, ChevronLeft, Cpu, Gauge, Globe, KeyRound, LayoutPanelLeft, Puzzle, Rocket, ScrollText, Wrench, type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { DesktopUninstallSettings } from '@/components/desktop-uninstall-settings';
import { SystemInstallationSettings } from '@/components/settings/system-installation-settings';
import { FallbackSettings } from '@/components/fallback-settings';
import { BackendAccountsSettings } from '@/components/settings/backend-accounts-settings';
import { GlobalInstructionsSettings } from '@/plugins-client/settings/global-instructions-settings';
import { TimonPreambleSettings } from '@/plugins-client/settings/timon-preamble-settings';
import { PluginSettingsPane } from '@/components/plugin-settings-sections';
import { PluginWebhooksPane } from '@/components/plugin-webhooks-pane';
import { PluginConnectionsSettings } from '@/components/settings/plugin-connections';
import { DevicesSettings } from '@/components/settings/devices-settings';
import { DeveloperModeSettings } from '@/components/settings/developer-mode-settings';
import { LanguageSettings } from '@/components/settings/language-settings';
import { PushToggle } from '@/components/push-toggle';
import { VoiceDictationSettings } from '@/components/voice-dictation-settings';
import { DictationEnginesSettings } from '@/components/dictation/dictation-engines-settings';
import { SecretsClient } from '@/plugins-client/secrets-vault/secrets-page';
import { GptLiveSettings } from '@/components/gpt-live-settings';
import { WebUiSettings } from '@/components/webui-settings';
import { SettingsAccount } from '@/components/settings/settings-account';
import { ProfileClient } from '@/app/(main)/profile/profile-client';
import { LicenseClient } from '@/app/(main)/license/license-client';
import { SettingsCloseButton, SettingsDialogFrame } from '@/components/settings/settings-dialog-frame';
import { SettingsSearchField, SettingsSearchResultsView } from '@/components/settings/settings-search';
import { SettingsRow, type Setting } from '@/components/settings/settings-row';
import { isPageSurfaceAllowed, isZoneVisible, useCapabilities } from '@/lib/capabilities';
import { useMe } from '@/hooks/use-me';
import { actingUser } from '@/lib/auth';
import { desktopBridge } from '@/lib/desktop';
import { t } from '@/lib/i18n';
import { SlotKeyed, useSlotEntries } from '@/lib/plugin-host/render';
import { NativeCategoryGraft, NativeSettingsContext, type ResourceMemoryInfo } from '@/lib/plugin-host/settings-graft';
import { SETTINGS_GROUP_TO_SLOT } from '@/lib/plugin-host/settings-slots';
import { slotEntries, slotVersion, subscribeSlots } from '@/lib/plugin-host/slots';
import {
  buildSettingsLayout,
  isRowListed,
  parseSettingsAccountView,
  parseSettingsParam,
  resolveSettingsTarget,
  type SettingsCategory,
  type SettingsCategoryId,
  type SettingsTab,
  type SettingsTarget,
} from '@/lib/settings-layout';
import { searchSettings, searchTerms } from '@/lib/settings-search';
import { SETTINGS_PARAM, useSettingsNavigation } from '@/lib/settings-navigation';
import { pluginCategoryItems, type PluginCatalogRow } from '@/lib/settings-plugin-categories';
import { sseOn } from '@/lib/sse-stream';
import { cn } from '@/lib/utils';
import { apiErrorMessage } from '@/lib/api-error';

const CATEGORY_ICONS: Readonly<Record<SettingsCategoryId, LucideIcon>> = {
  instructions: ScrollText,
  interface: LayoutPanelLeft,
  models: Cpu,
  missions: Rocket,
  resources: Gauge,
  memory: Brain,
  network: Globe,
  system: Wrench,
  secrets: KeyRound,
  plugins: Puzzle,
};

function categoryLabel(id: SettingsCategoryId): string {
  return t(`settingsDialog.category.${id}`);
}

/** A hidden-keyword entry of the locale files; none when the key is not there. */
function keywordsOf(key: string): string[] {
  const value = t(key);
  return value === key ? [] : [value];
}

function tabLabel(category: SettingsCategoryId, tab: SettingsTab): string {
  if (tab.kind === 'plugin') return tab.label;
  if (tab.kind === 'rows' && tab.ownerLabel) return tab.ownerLabel;
  return t(`settingsDialog.tab.${category}.${tab.id}`);
}

export function SettingsDialog(): ReactElement | null {
  const searchParams = useSearchParams();
  const target = parseSettingsParam(searchParams.get(SETTINGS_PARAM));
  const caps = useCapabilities();
  const { close } = useSettingsNavigation();
  const unsavedRef = useRef(false);
  // Fail closed while caps load, and for a viewer without the surface.
  if (!target || caps === null || !isPageSurfaceAllowed(caps, '/settings')) return null;
  return (
    <SettingsDialogFrame onClose={close} unsavedRef={unsavedRef}>
      <SettingsPanel onClose={close} unsavedRef={unsavedRef} />
    </SettingsDialogFrame>
  );
}

function SettingsPanel({ onClose, unsavedRef }: { onClose: () => void; unsavedRef: MutableRefObject<boolean> }): ReactElement {
  const searchParams = useSearchParams();
  const target = parseSettingsParam(searchParams.get(SETTINGS_PARAM)) ?? { category: 'interface', tab: null };
  const { select: navigate, selectAccount } = useSettingsNavigation();
  const me = useMe();
  const parsedView = parseSettingsAccountView(searchParams.get(SETTINGS_PARAM));
  // Licence belongs to the superadmin; a pasted `?settings=license` from anyone
  // else (or while the account is still loading) falls back to the categories.
  const accountView = parsedView === 'license' && !actingUser(me)?.is_superadmin ? null : parsedView;
  const caps = useCapabilities();
  // Advanced rows are always on screen; only a preset that hides the zone (lite) drops them.
  const includeAdvanced = isZoneVisible(caps, 'settings.advanced');

  const [settings, setSettings] = useState<Setting[]>([]);
  const [resourceMemory, setResourceMemory] = useState<ResourceMemoryInfo | null>(null);
  const [catalog, setCatalog] = useState<PluginCatalogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [desktop, setDesktop] = useState(false);
  useEffect(() => { setDesktop(Boolean(desktopBridge()?.uninstall)); }, []);

  const load = useCallback(async () => {
    const r = await fetch('/api/ui/settings', { cache: 'no-store' });
    if (!r.ok) { toast.error(t('settingsPage.loadError')); setLoading(false); return false; }
    const data = await r.json() as { settings?: Setting[]; resourceMemory?: ResourceMemoryInfo | null };
    setSettings(data.settings ?? []);
    setResourceMemory(data.resourceMemory ?? null);
    setDrafts({});
    setLoading(false);
    return true;
  }, []);
  useEffect(() => { void load(); }, [load]);

  const loadPlugins = useCallback(async () => {
    const r = await fetch('/api/ui/plugins', { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json() as { plugins?: PluginCatalogRow[] };
    setCatalog(data.plugins ?? []);
  }, []);
  useEffect(() => {
    void loadPlugins();
    return sseOn('plugins_changed', () => { void loadPlugins(); });
  }, [loadPlugins]);

  const save = useCallback(async (key: string, value: string | null) => {
    setSaving(key);
    const r = await fetch('/api/ui/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    setSaving(null);
    if (!r.ok) {
      const err = await r.json().catch(() => ({})) as { error?: string };
      toast.error(apiErrorMessage(err, t('settingsPage.saveError')));
      return;
    }
    toast.success(value === null ? t('settingsPage.resetToDefault') : t('settingsPage.saved'));
    await load();
  }, [load]);

  const onDraft = useCallback((key: string, value: string) => {
    setDrafts((d) => ({ ...d, [key]: value }));
  }, []);

  const sectionEntries = useSlotEntries('settings.section');
  const slotsAt = useSyncExternalStore(subscribeSlots, slotVersion, slotVersion);
  const graftedGroups = useMemo(() => {
    void slotsAt;
    return new Set(Object.entries(SETTINGS_GROUP_TO_SLOT)
      .filter(([, slot]) => slotEntries(slot).length > 0)
      .map(([group]) => group));
  }, [slotsAt]);

  // Leaving for a tab ends the search that led there (or interrupted it).
  const select = useCallback((next: SettingsTarget) => {
    setQuery('');
    navigate(next);
  }, [navigate]);

  // The secrets page registers only while its module runs and the viewer may
  // open it: that is exactly when the category should exist.
  const hasSecrets = useMemo(() => {
    void slotsAt;
    return slotEntries('page').some((entry) => entry.key === '/secrets');
  }, [slotsAt]);

  const pluginStates = useMemo(() => new Map(catalog.map((row) => [row.id, row.state])), [catalog]);
  const layout = useMemo(() => buildSettingsLayout({
    rows: settings,
    includeAdvanced,
    pluginStates,
    pluginLabels: new Map(catalog.map((row) => [row.id, row.label ?? row.id])),
    plugins: pluginCategoryItems(sectionEntries, catalog).flatMap((item) => (
      item.plugin ? [{ id: item.plugin.id, origin: item.plugin.origin, label: item.plugin.label }] : []
    )),
    graftedGroups,
    desktop,
    secrets: hasSecrets,
    superadmin: actingUser(me)?.is_superadmin === true,
  }), [settings, includeAdvanced, pluginStates, catalog, sectionEntries, graftedGroups, desktop, hasSecrets, me]);

  const resolved = resolveSettingsTarget(target, layout);
  const byKey = useMemo(() => new Map(settings.map((s) => [s.key, s])), [settings]);
  const inPlugins = resolved?.category.id === 'plugins';
  const searching = searchTerms(query).length > 0;
  const results = useMemo(() => {
    if (!searching) return null;
    return searchSettings({
      query,
      layout,
      rows: settings.filter((row) => isRowListed(row, { includeAdvanced, pluginStates })),
      categoryLabel,
      tabLabel,
      rowKeywords: (key) => keywordsOf(`settingsSearch.rowKeywords.${key}`),
      tabKeywords: (category, tab) => keywordsOf(`settingsSearch.tabKeywords.${category}.${tab.id}`),
    });
  }, [searching, query, layout, settings, includeAdvanced, pluginStates]);
  useEffect(() => {
    unsavedRef.current = Object.entries(drafts).some(([key, value]) => {
      const row = byKey.get(key);
      return row !== undefined && value !== String(row.value);
    });
  }, [drafts, byKey, unsavedRef]);
  const firstNative = layout.find((c) => c.id !== 'plugins');

  return (
    <div className="flex min-h-0 w-full flex-col md:flex-row">
      <nav
        aria-label={t('settingsPage.categories')}
        className="hidden w-[220px] shrink-0 flex-col overflow-y-auto bg-muted/30 px-3 py-5 md:flex"
      >
        <DialogTitle className="px-2.5 text-[20px] font-semibold tracking-[-0.02em]">
          {t('settings.title')}
        </DialogTitle>
        {/* Radix wants a description; the visible one said nothing a user needed. */}
        <DialogDescription className="sr-only">{t('settings.description')}</DialogDescription>
        {inPlugins && resolved ? (
          <>
            {/* Plugins can be many: they get the column to themselves rather
                than a tab bar that would overflow. The back arrow returns to
                the product's own categories. */}
            <div className="mt-5 flex items-center gap-1">
              <button
                type="button"
                onClick={() => select({ category: firstNative?.id ?? 'interface', tab: null })}
                aria-label={t('settingsDialog.backToSettings')}
                title={t('settingsDialog.backToSettings')}
                className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
              >
                <ChevronLeft className="size-4" aria-hidden />
              </button>
              <span className="flex items-center gap-2 text-[13px] font-medium">
                <Puzzle className="size-4" aria-hidden />
                {categoryLabel('plugins')}
              </span>
            </div>
            <ul className="mt-2 space-y-0.5" aria-label={categoryLabel('plugins')}>
              {resolved.category.tabs.map((tab) => (
                <li key={tab.id}>
                  <button
                    type="button"
                    aria-current={tab.id === resolved.tab.id ? 'page' : undefined}
                    onClick={() => select({ category: 'plugins', tab: tab.id })}
                    className={cn(
                      'block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-snug transition-colors duration-150 motion-reduce:transition-none',
                      tab.id === resolved.tab.id
                        ? 'bg-foreground/[0.08] font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
                    )}
                  >
                    {tabLabel('plugins', tab)}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <ul className="mt-5 space-y-0.5">
            {layout.map((category) => (
              <CategoryItem
                key={category.id}
                category={category}
                active={!accountView && category.id === resolved?.category.id}
                onSelect={() => select({ category: category.id, tab: null })}
              />
            ))}
          </ul>
        )}
        {/* Stuck to the foot of the column, whatever the category list holds. */}
        <SettingsAccount className="mt-auto" view={accountView} onSelect={selectAccount} />
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
        {accountView ? (
          <>
            <header className="flex items-center gap-3 py-3 pl-5 pr-3 md:pl-8 md:pr-4">
              <h2 className="min-w-0 flex-1 truncate text-[18px] font-semibold tracking-[-0.02em]">
                {t(accountView === 'profile' ? 'session.profile' : 'session.license')}
              </h2>
              <SettingsCloseButton onClose={onClose} />
            </header>
            {/* The page's own component, in the pane: it brings its scroll. */}
            <div className="min-h-0 flex-1 overflow-hidden">
              {accountView === 'profile' ? <ProfileClient /> : <LicenseClient />}
            </div>
          </>
        ) : (
          <>
        <header className="flex flex-wrap items-center gap-3 py-3 pl-5 pr-3 md:pl-8 md:pr-4">
          <label htmlFor="settings-category" className="sr-only">{t('settingsPage.selectCategory')}</label>
          <select
            id="settings-category"
            value={resolved?.category.id ?? ''}
            onChange={(e) => select({ category: e.target.value as SettingsCategoryId, tab: null })}
            className="h-9 min-w-0 flex-1 rounded-lg border-0 bg-muted/70 px-3 text-[13px] font-medium text-foreground outline-none ring-1 ring-border/60 focus-visible:ring-ring md:hidden"
          >
            {layout.map((category) => (
              <option key={category.id} value={category.id}>{categoryLabel(category.id)}</option>
            ))}
          </select>
          {inPlugins && resolved && (
            <select
              aria-label={categoryLabel('plugins')}
              value={resolved.tab.id}
              onChange={(e) => select({ category: 'plugins', tab: e.target.value })}
              className="h-9 min-w-0 flex-1 rounded-lg border-0 bg-muted/70 px-3 text-[13px] font-medium text-foreground outline-none ring-1 ring-border/60 focus-visible:ring-ring md:hidden"
            >
              {resolved.category.tabs.map((tab) => (
                <option key={tab.id} value={tab.id}>{tabLabel('plugins', tab)}</option>
              ))}
            </select>
          )}
          {resolved && (
            <h2 className="hidden min-w-0 flex-1 truncate text-[18px] font-semibold tracking-[-0.02em] md:block">
              {inPlugins ? tabLabel('plugins', resolved.tab) : categoryLabel(resolved.category.id)}
            </h2>
          )}
          {/* Inline with the title and the cross; on a phone it takes its own row under the pickers. */}
          <SettingsSearchField value={query} onChange={setQuery} className="order-last w-full md:order-none md:w-72" />
          <SettingsCloseButton onClose={onClose} />
        </header>

        {!searching && resolved && !inPlugins && resolved.category.tabs.length > 1 && (
          <div className="px-5 py-2.5 md:px-8">
            <div
              role="tablist"
              aria-label={categoryLabel(resolved.category.id)}
              className="inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1"
            >
              {resolved.category.tabs.map((tab) => {
                const active = tab.id === resolved.tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    id={`settings-tab-${tab.id}`}
                    aria-selected={active}
                    aria-controls="settings-tabpanel"
                    onClick={() => select({ category: resolved.category.id, tab: tab.id })}
                    className={cn(
                      'shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
                      active
                        ? 'bg-background text-foreground shadow'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {tabLabel(resolved.category.id, tab)}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div
          id="settings-tabpanel"
          role={searching ? undefined : 'tabpanel'}
          aria-labelledby={!searching && resolved && !inPlugins && resolved.category.tabs.length > 1 ? `settings-tab-${resolved.tab.id}` : undefined}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-5 md:px-8 md:py-6"
        >
          {loading || !resolved ? (
            <RowsSkeleton />
          ) : results ? (
            <SettingsSearchResultsView
              query={query}
              results={results}
              categoryLabel={categoryLabel}
              tabLabel={tabLabel}
              onOpen={select}
              renderRow={(key) => {
                const setting = byKey.get(key);
                return setting ? (
                  <SettingsRow
                    setting={setting}
                    draft={drafts[key]}
                    saving={saving === key}
                    onDraft={onDraft}
                    onSave={save}
                  />
                ) : null;
              }}
            />
          ) : (
            <NativeSettingsContext.Provider value={{ resourceMemory, refresh: load, includeAdvanced }}>
              <TabContent
                tab={resolved.tab}
                rows={resolved.tab.kind === 'rows'
                  ? resolved.tab.keys.flatMap((key) => byKey.get(key) ?? [])
                  : []}
                drafts={drafts}
                saving={saving}
                onDraft={onDraft}
                onSave={save}
              />
            </NativeSettingsContext.Provider>
          )}
        </div>
          </>
        )}
        {/* The column is desktop-only: on a phone the account sits under the pane. */}
        <SettingsAccount className="shrink-0 px-5 pb-3 md:hidden" view={accountView} onSelect={selectAccount} />
      </div>
    </div>
  );
}

function CategoryItem({
  category,
  active,
  onSelect,
}: {
  category: SettingsCategory;
  active: boolean;
  onSelect: () => void;
}): ReactElement {
  const Icon = CATEGORY_ICONS[category.id];
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-snug transition-colors duration-150 motion-reduce:transition-none',
          active
            ? 'bg-foreground/[0.08] font-medium text-foreground'
            : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{categoryLabel(category.id)}</span>
      </button>
    </li>
  );
}

function TabContent({
  tab,
  rows,
  drafts,
  saving,
  onDraft,
  onSave,
}: {
  tab: SettingsTab;
  rows: Setting[];
  drafts: Record<string, string>;
  saving: string | null;
  onDraft: (key: string, value: string) => void;
  onSave: (key: string, value: string | null) => void;
}): ReactElement | null {
  if (tab.kind === 'plugin') {
    // The webhooks belong to the host: a plugin's own section cannot hide them.
    return tab.origin === 'occupant'
      ? <><SlotKeyed name="settings.section" entryKey={tab.pluginId} /><PluginWebhooksPane pluginId={tab.pluginId} /></>
      : <PluginSettingsPane pluginId={tab.pluginId} />;
  }
  if (tab.kind === 'native') {
    const grafts = tab.grafts.map((group) => <NativeCategoryGraft key={group} group={group} />);
    switch (tab.pane) {
      case 'language':
        return <><LanguageSettings />{grafts}</>;
      case 'push':
        return (
          <div>
            <p className="mb-4 max-w-[65ch] text-[13px] leading-snug text-muted-foreground">
              {t('settingsPage.notificationsDescription')}
            </p>
            {/* Push subscription requires a user gesture ON the device. */}
            <PushToggle />
            {grafts}
          </div>
        );
      case 'voice':
        return <><VoiceDictationSettings /><DictationEnginesSettings /><GptLiveSettings />{grafts}</>;
      case 'webui':
        return (
          <div>
            <p className="mb-4 max-w-[65ch] text-[13px] leading-snug text-muted-foreground">
              {t('webuiSettings.description')}
            </p>
            <WebUiSettings />
            {grafts}
          </div>
        );
      case 'desktop':
        return <DesktopUninstallSettings />;
      case 'installation':
        return <SystemInstallationSettings />;
      case 'instructions':
        return <GlobalInstructionsSettings />;
      case 'preamble':
        return <TimonPreambleSettings />;
      case 'fallback':
        return <><FallbackSettings />{grafts}</>;
      case 'accounts':
        return <BackendAccountsSettings />;
      case 'secrets':
        return <SecretsClient />;
      case 'connections':
        return <PluginConnectionsSettings />;
      case 'devices':
        return <DevicesSettings />;
      case 'developer':
        return <DeveloperModeSettings />;
    }
  }
  return (
    <div className="flex flex-col">
      {rows.map((s) => (
        <SettingsRow
          key={s.key}
          setting={s}
          draft={drafts[s.key]}
          saving={saving === s.key}
          onDraft={onDraft}
          onSave={onSave}
        />
      ))}
      {tab.grafts.map((group) => <NativeCategoryGraft key={group} group={group} />)}
    </div>
  );
}

function RowsSkeleton(): ReactElement {
  return (
    <div className="flex flex-col" aria-busy="true">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-8 py-4">
          <div className="space-y-2">
            <div className="h-3.5 w-40 animate-pulse rounded bg-muted" />
            <div className="h-3 w-64 animate-pulse rounded bg-muted/70" />
          </div>
          <div className="h-7 w-20 animate-pulse rounded-md bg-muted" />
        </div>
      ))}
    </div>
  );
}
