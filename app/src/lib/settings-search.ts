/**
 * Search over the Settings dialog. It looks at exactly what the layout shows:
 * the rows the tabs list (advanced ones included, an inactive plugin's not)
 * and the tabs themselves, so a pane without rows (Appearance, Notifications,
 * Instructions…) is found by its name. Hidden keywords widen what a row or a
 * tab answers to without showing on screen.
 *
 * Pure: labels and keywords come in as callbacks, the dialog resolves them
 * through `t()`.
 */
import {
  placeSetting,
  type SettingsCategory,
  type SettingsCategoryId,
  type SettingsRowLike,
  type SettingsTab,
} from './settings-layout';

export type SearchableRow = SettingsRowLike & {
  label: string;
  description: string | null;
};

export type SettingsSearchInput = {
  query: string;
  layout: readonly SettingsCategory[];
  /** Rows already filtered with `isRowListed`. */
  rows: readonly SearchableRow[];
  categoryLabel: (category: SettingsCategoryId) => string;
  tabLabel: (category: SettingsCategoryId, tab: SettingsTab) => string;
  rowCopy?: (row: SearchableRow) => Pick<SearchableRow, 'label' | 'description'>;
  rowKeywords: (key: string) => readonly string[];
  tabKeywords: (category: SettingsCategoryId, tab: SettingsTab) => readonly string[];
};

export type SettingsTabHit = {
  category: SettingsCategoryId;
  tab: SettingsTab;
  /** Labels of the rows painted by this pane that matched the query. */
  via: string[];
};

export type SettingsRowHit = {
  category: SettingsCategoryId;
  tab: SettingsTab;
  key: string;
};

export type SettingsSearchResults = { tabs: SettingsTabHit[]; rows: SettingsRowHit[] };

/** Lower case without accents: a query typed without diacritics finds an accented label. */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function searchTerms(query: string): string[] {
  return normalizeSearchText(query).split(/\s+/).filter(Boolean);
}

function matchesAll(terms: readonly string[], fields: readonly (string | null | undefined)[]): boolean {
  const haystack = normalizeSearchText(fields.filter(Boolean).join(' '));
  return terms.every((term) => haystack.includes(term));
}

export function searchSettings(input: SettingsSearchInput): SettingsSearchResults {
  const terms = searchTerms(input.query);
  if (terms.length === 0) return { tabs: [], rows: [] };

  const tabOf = new Map<string, { category: SettingsCategoryId; tab: SettingsTab }>();
  for (const category of input.layout) {
    for (const tab of category.tabs) tabOf.set(`${category.id}/${tab.id}`, { category: category.id, tab });
  }

  const rowHits = new Map<string, SettingsRowHit[]>();
  const viaByTab = new Map<string, string[]>();
  for (const row of input.rows) {
    const place = placeSetting(row);
    const home = tabOf.get(`${place.category}/${place.tab}`);
    if (!home) continue;
    const copy = input.rowCopy?.(row) ?? row;
    const fields = [copy.label, copy.description, row.label, row.description, row.key, row.group, ...input.rowKeywords(row.key)];
    if (!matchesAll(terms, fields)) continue;
    const tabKey = `${home.category}/${home.tab.id}`;
    if (home.tab.kind === 'rows') {
      rowHits.set(tabKey, [...(rowHits.get(tabKey) ?? []), { category: home.category, tab: home.tab, key: row.key }]);
    } else {
      // A native pane paints its own rows: the way to them is the pane.
      viaByTab.set(tabKey, [...(viaByTab.get(tabKey) ?? []), copy.label]);
    }
  }

  const tabs: SettingsTabHit[] = [];
  const rows: SettingsRowHit[] = [];
  for (const category of input.layout) {
    for (const tab of category.tabs) {
      const tabKey = `${category.id}/${tab.id}`;
      const via = viaByTab.get(tabKey) ?? [];
      const named = matchesAll(terms, [
        input.categoryLabel(category.id),
        input.tabLabel(category.id, tab),
        category.id === 'plugins' ? tab.id : undefined,
        ...input.tabKeywords(category.id, tab),
      ]);
      if (named || via.length > 0) tabs.push({ category: category.id, tab, via });
      rows.push(...(rowHits.get(tabKey) ?? []));
    }
  }
  return { tabs, rows };
}
