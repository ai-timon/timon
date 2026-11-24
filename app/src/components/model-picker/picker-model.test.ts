/**
 * What the ModelPicker shows, without a DOM (`picker-model.ts`): the view it
 * opens on, the search across the whole catalogue, favourites tied to their
 * account and hidden (not dropped) once it is gone, the orphan value, the
 * value held while the catalogue loads, the filter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPending, type BackendCatalog } from '@/lib/backends';
import { acceptsPick, initialView, orphanOf, pickLabel, providersOf, rowsFor, visibleFavorites } from './picker-model';

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    {
      id: 'claude', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      models: [
        { slug: 'haiku', label: 'Haiku', presetRank: 3, contextWindow: 200_000 },
        { slug: 'opus', label: 'Opus', presetRank: 1, contextWindow: 1_000_000 },
        { slug: 'sonnet', label: 'Sonnet', presetRank: 2 },
      ],
    },
    {
      id: 'claude@krz', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      instanceOf: 'claude', account: { id: 'krz', name: 'KRZDIGITAL', state: 'reauth' },
      models: [{ slug: 'opus', label: 'Opus', presetRank: 1 }],
    },
    {
      id: 'codex', label: 'Codex', vendor: 'OpenAI', brand: 'openai', defaultModel: 'gpt-5.5',
      models: [{ slug: 'gpt-5.5', label: 'GPT-5.5' }, { slug: 'gpt-5.4-mini', label: 'GPT-5.4 mini' }],
    },
  ],
};

test('opens on the value\'s provider, else the favourites, else the first provider', () => {
  assert.deepEqual(initialView(CATALOG, { backend: 'codex', model: 'gpt-5.5' }, []), { kind: 'provider', backend: 'codex' });
  assert.deepEqual(initialView(CATALOG, null, [{ backend: 'claude', model: 'opus' }]), { kind: 'favorites' });
  assert.deepEqual(initialView(CATALOG, null, []), { kind: 'provider', backend: 'claude' });
  // A favourite whose account is gone does not count as "there are favourites".
  assert.deepEqual(initialView(CATALOG, null, [{ backend: 'claude@old', model: 'opus' }]), { kind: 'provider', backend: 'claude' });
});

test('a provider\'s models are sorted by power, with their context window', () => {
  const rows = rowsFor({ catalog: CATALOG, view: { kind: 'provider', backend: 'claude' }, query: '', value: { backend: 'claude', model: 'sonnet' }, favorites: [] });
  assert.deepEqual(rows.map((r) => r.slug), ['opus', 'sonnet', 'haiku']);
  assert.equal(rows[0]?.contextWindow, 1_000_000);
  assert.equal(rows[1]?.selected, true);
  assert.equal(rows[0]?.vendor, undefined, 'the header already names the provider');
});

test('a search looks through the whole catalogue and names each row\'s account', () => {
  const rows = rowsFor({ catalog: CATALOG, view: { kind: 'provider', backend: 'codex' }, query: ' OPUS ', value: null, favorites: [] });
  assert.deepEqual(rows.map((r) => r.backend), ['claude', 'claude@krz']);
  assert.deepEqual(rows.map((r) => r.vendor), ['Anthropic', 'Anthropic']);
  assert.deepEqual(rows.map((r) => r.account), [undefined, 'KRZDIGITAL']);
  // The provider's name is a criterion too.
  assert.equal(rowsFor({ catalog: CATALOG, view: { kind: 'favorites' }, query: 'openai', value: null, favorites: [] }).length, 2);
});

test('favourites are exact pairs: one per account, hidden when their account or model is gone', () => {
  const favorites = [
    { backend: 'claude@krz', model: 'opus' },
    { backend: 'claude@old', model: 'opus' },
    { backend: 'claude', model: 'retired-model' },
    { backend: 'claude', model: 'opus' },
  ];
  const rows = rowsFor({ catalog: CATALOG, view: { kind: 'favorites' }, query: '', value: null, favorites });
  assert.deepEqual(rows.map((r) => `${r.backend}:${r.slug}`), ['claude@krz:opus', 'claude:opus'], 'stored order, gone ones hidden');
  assert.ok(rows.every((r) => r.isFavorite));
  assert.equal(rows[0]?.vendor, 'Anthropic');
  assert.equal(rows[0]?.account, 'KRZDIGITAL');
  // The account to sign in again stays visible, but cannot be picked.
  assert.equal(rows[0]?.pickable, false);
  assert.ok(rows[0]?.hint);
  assert.equal(rows[1]?.pickable, true);
  // In the provider view, only the account's own pair is starred.
  const claude = rowsFor({ catalog: CATALOG, view: { kind: 'provider', backend: 'claude' }, query: '', value: null, favorites: [{ backend: 'claude@krz', model: 'opus' }] });
  assert.equal(claude.find((r) => r.slug === 'opus')?.isFavorite, false);
});

test('a value whose account is gone is an orphan; a slug typed by hand leads its provider\'s list', () => {
  const gone = orphanOf(CATALOG, { backend: 'claude@old', model: 'opus' });
  assert.equal(gone?.kind, 'gone');
  assert.match(gone?.label ?? '', /opus/);
  assert.equal(orphanOf({ ...CATALOG, backends: [] }, { backend: 'claude@old', model: 'opus' }), null, 'nothing decided before the catalogue loads');
  assert.equal(orphanOf(CATALOG, { backend: 'claude', model: 'opus' }), null);

  const typed = { backend: 'claude', model: 'claude-opus-4-6' };
  assert.equal(orphanOf(CATALOG, typed)?.kind, 'custom');
  const rows = rowsFor({ catalog: CATALOG, view: { kind: 'provider', backend: 'claude' }, query: '', value: typed, favorites: [] });
  assert.equal(rows[0]?.slug, 'claude-opus-4-6');
  assert.equal(rows[0]?.selected, true);
  assert.equal(rows[0]?.starrable, false);
});

test('while the catalogue loads, the value is shown as held: never gone, never another account', () => {
  const loading: BackendCatalog = { defaultBackend: '', backends: [] };
  assert.equal(catalogPending(loading), true);
  assert.equal(catalogPending(CATALOG), false);
  const value = { backend: 'claude@perso', model: 'opus' };
  assert.equal(orphanOf(loading, value), null);
  for (const view of [{ kind: 'favorites' as const }, { kind: 'provider' as const, backend: 'claude' }]) {
    const rows = rowsFor({ catalog: loading, view, query: '', value, favorites: [value] });
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { label: rows[0]?.label, vendor: rows[0]?.vendor, selected: rows[0]?.selected, pickable: rows[0]?.pickable, pending: rows[0]?.pending, starrable: rows[0]?.starrable },
      { label: 'opus', vendor: 'claude', selected: true, pickable: false, pending: true, starrable: false },
    );
    assert.doesNotMatch(rows[0]?.hint ?? '', /unavailable|no longer/i);
  }
  assert.deepEqual(rowsFor({ catalog: loading, view: { kind: 'favorites' }, query: 'op', value, favorites: [] }), [], 'no search over nothing');
  assert.deepEqual(rowsFor({ catalog: loading, view: { kind: 'favorites' }, query: '', value: null, favorites: [] }), []);
  // An agent stored without a model reads as its backend until the default is known.
  assert.equal(rowsFor({ catalog: loading, view: { kind: 'favorites' }, query: '', value: { backend: 'claude', model: '' }, favorites: [] })[0]?.label, 'claude');
  assert.equal(pickLabel(loading, { backend: 'claude', model: '' }), 'claude');
  assert.equal(pickLabel(loading, value), 'opus');
});

test('a filter restricts the rail, the lists, the favourites and the search', () => {
  const onlyCodex = (b: { id: string }) => b.id === 'codex';
  assert.deepEqual(providersOf(CATALOG, onlyCodex).map((b) => b.id), ['codex']);
  assert.equal(visibleFavorites(CATALOG, [{ backend: 'claude', model: 'opus' }], onlyCodex).length, 0);
  assert.deepEqual(initialView(CATALOG, null, [], onlyCodex), { kind: 'provider', backend: 'codex' });
  assert.equal(rowsFor({ catalog: CATALOG, view: { kind: 'favorites' }, query: 'opus', value: null, favorites: [], filter: onlyCodex }).length, 0);
  const noMini = (_b: unknown, m: { slug: string }) => !m.slug.includes('mini');
  assert.deepEqual(rowsFor({ catalog: CATALOG, view: { kind: 'provider', backend: 'codex' }, query: '', value: null, favorites: [], filter: noMini }).map((r) => r.slug), ['gpt-5.5']);
});

test('acceptsPick: the host lets through only what the product picker offers', () => {
  const base = { value: null, inherit: false, allowCustomSlug: false, disabled: false };
  const opus = { backend: 'claude', model: 'opus' };
  assert.equal(acceptsPick(CATALOG, opus, base), true);
  assert.equal(acceptsPick(CATALOG, opus, { ...base, disabled: true }), false, 'disabled');
  assert.equal(acceptsPick(CATALOG, null, base), false, 'null without inherit');
  assert.equal(acceptsPick(CATALOG, null, { ...base, inherit: true }), true);
  assert.equal(acceptsPick(CATALOG, { backend: 'claude@krz', model: 'opus' }, base), false, 'an account to sign in again');
  assert.equal(acceptsPick(CATALOG, { backend: 'claude@old', model: 'opus' }, base), false, 'an account the catalogue no longer lists');
  // A typed slug: only where typing is offered, or the value already held.
  const typed = { backend: 'claude', model: 'opus-next' };
  assert.equal(acceptsPick(CATALOG, typed, base), false);
  assert.equal(acceptsPick(CATALOG, typed, { ...base, allowCustomSlug: true }), true);
  assert.equal(acceptsPick(CATALOG, typed, { ...base, value: typed }), true);
  assert.equal(acceptsPick(CATALOG, { backend: 'claude', model: '  ' }, { ...base, allowCustomSlug: true }), false, 'a blank slug');
  // The surface's filter holds for listed models and for the provider a slug is typed on.
  const onlyCodex = (b: { id: string }) => b.id === 'codex';
  assert.equal(acceptsPick(CATALOG, opus, { ...base, filter: onlyCodex }), false);
  assert.equal(acceptsPick(CATALOG, { backend: 'codex', model: 'gpt-5.5' }, { ...base, filter: onlyCodex }), true);
  assert.equal(acceptsPick(CATALOG, typed, { ...base, allowCustomSlug: true, filter: onlyCodex }), false);
});
