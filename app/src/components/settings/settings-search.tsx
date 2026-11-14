'use client';

import type { ReactElement, ReactNode } from 'react';
import { ChevronRight, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { SettingsCategoryId, SettingsTab, SettingsTarget } from '@/lib/settings-layout';
import type { SettingsSearchResults } from '@/lib/settings-search';

export function SettingsSearchField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}): ReactElement {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('settingsSearch.placeholder')}
        aria-label={t('settingsSearch.label')}
        autoComplete="off"
        spellCheck={false}
        className="h-9 w-full rounded-lg border-0 bg-muted/70 pl-9 pr-9 text-[13px] text-foreground outline-none ring-1 ring-transparent placeholder:text-muted-foreground focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
      />
      {value !== '' && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={t('settingsSearch.clear')}
          title={t('settingsSearch.clear')}
          className="absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

function Crumb({
  category,
  tab,
  categoryLabel,
  tabLabel,
  onOpen,
}: {
  category: SettingsCategoryId;
  tab: SettingsTab;
  categoryLabel: (id: SettingsCategoryId) => string;
  tabLabel: (category: SettingsCategoryId, tab: SettingsTab) => string;
  onOpen: (target: SettingsTarget) => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={() => onOpen({ category, tab: tab.id })}
      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
    >
      {categoryLabel(category)}
      <ChevronRight className="size-3" aria-hidden />
      {tabLabel(category, tab)}
    </button>
  );
}

export function SettingsSearchResultsView({
  query,
  results,
  categoryLabel,
  tabLabel,
  onOpen,
  renderRow,
}: {
  query: string;
  results: SettingsSearchResults;
  categoryLabel: (id: SettingsCategoryId) => string;
  tabLabel: (category: SettingsCategoryId, tab: SettingsTab) => string;
  onOpen: (target: SettingsTarget) => void;
  renderRow: (key: string) => ReactNode;
}): ReactElement {
  const count = results.tabs.length + results.rows.length;
  return (
    <div>
      <p role="status" className="sr-only">{t(count === 1 ? 'settingsSearch.countOne' : 'settingsSearch.countOther', { count })}</p>
      {count === 0 && (
        <p className="py-6 text-[13px] text-muted-foreground">{t('settingsSearch.empty', { query: query.trim() })}</p>
      )}
      {results.tabs.length > 0 && (
        <section aria-label={t('settingsSearch.sections')}>
          <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('settingsSearch.sections')}
          </h3>
          <ul className="space-y-0.5">
            {results.tabs.map((hit) => (
              <li key={`${hit.category}/${hit.tab.id}`}>
                <button
                  type="button"
                  onClick={() => onOpen({ category: hit.category, tab: hit.tab.id })}
                  className="flex w-full flex-col gap-0.5 rounded-md px-1 py-2.5 text-left transition-colors hover:bg-foreground/[0.04]"
                >
                  <span className="flex items-center gap-1 text-[13px] font-medium">
                    {categoryLabel(hit.category)}
                    <ChevronRight className="size-3 text-muted-foreground" aria-hidden />
                    {tabLabel(hit.category, hit.tab)}
                  </span>
                  {hit.via.length > 0 && (
                    <span className="truncate text-[12px] text-muted-foreground">{hit.via.join(' · ')}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {results.rows.length > 0 && (
        <section aria-label={t('settingsSearch.settings')} className={results.tabs.length > 0 ? 'mt-5' : undefined}>
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('settingsSearch.settings')}
          </h3>
          <ul className="space-y-2">
            {results.rows.map((hit) => (
              <li key={hit.key} className="pt-3">
                <Crumb
                  category={hit.category}
                  tab={hit.tab}
                  categoryLabel={categoryLabel}
                  tabLabel={tabLabel}
                  onOpen={onOpen}
                />
                {renderRow(hit.key)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
