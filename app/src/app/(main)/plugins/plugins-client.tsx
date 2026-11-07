'use client';

import { useLicense } from '@/lib/license';
import { sseOn } from '@/lib/sse-stream';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { PluginCard } from '@/components/plugin-card';
import { PluginInstallPanel } from '@/components/plugin-install-panel';
import { useMe } from '@/hooks/use-me';
import { actingUser } from '@/lib/auth';
import { KIND_TONE } from '@/components/plugin-kind-badge';
import { PluginBoundary } from '@/lib/plugin-host/plugin-boundary';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  GALLERY_PROVENANCES,
  GALLERY_TYPES,
  countByProvenance,
  filterGallery,
  kindLabel,
  toCardData,
  toggleFailureMessage,
  type GalleryType,
  type PluginProvenance,
  type PluginPublic,
} from '@/lib/plugin-gallery';
import { t } from '@/lib/i18n';
import { toast } from 'sonner';
import { syncClientPlugins } from '@/lib/plugin-host/loader';
import { awaitingLocalApproval } from '@/lib/plugin-host/remote-plugins';
import { activeMachineId } from '@/lib/machines/machine-storage';
import { LOCAL_MACHINE_ID } from '@/lib/machines/machine-id';
import { cn } from '@/lib/utils';

const PROVENANCE_VALUES = ['all', ...GALLERY_PROVENANCES] as const;
type ProvenanceTab = (typeof PROVENANCE_VALUES)[number];

function isProvenance(value: string | null): value is ProvenanceTab {
  return PROVENANCE_VALUES.includes(value as ProvenanceTab);
}

function isGalleryType(value: string): value is GalleryType {
  return (GALLERY_TYPES as readonly string[]).includes(value);
}

type TypeTab = GalleryType | 'all';

function parseType(raw: string | null): TypeTab {
  if (!raw || raw === 'all') return 'all';
  const first = raw.split(',')[0]?.trim() ?? '';
  return isGalleryType(first) ? first : 'all';
}

function writeUrl(next: { p: ProvenanceTab; t: TypeTab; q: string }): void {
  const url = new URL(window.location.href);
  if (next.p === 'all') url.searchParams.delete('p');
  else url.searchParams.set('p', next.p);
  if (next.t === 'all') url.searchParams.delete('t');
  else url.searchParams.set('t', next.t);
  if (!next.q.trim()) url.searchParams.delete('q');
  else url.searchParams.set('q', next.q);
  window.history.replaceState(null, '', url.toString());
}

export function PluginsClient(): React.ReactElement {
  const licence = useLicense();
  const fixed = licence?.capabilities?.plugins === 'fixed';
  // The daemon only lets a superadmin session install; others never see the button.
  const canInstall = actingUser(useMe())?.is_superadmin === true && !fixed;
  const [failure, setFailure] = useState<string | null>(null);
  const params = useSearchParams();
  const [plugins, setPlugins] = useState<PluginPublic[] | null>(null);
  // On a remote machine: the third-party plugins whose browser half waits for
  // the same version and signature on this computer.
  const [awaiting, setAwaiting] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<ProvenanceTab>(() => {
    const fromUrl = params.get('p');
    return isProvenance(fromUrl) ? fromUrl : 'all';
  });
  const [type, setType] = useState<TypeTab>(() => parseType(params.get('t')));
  const [query, setQuery] = useState(() => params.get('q') ?? '');

  /**
   * `strict` is for the toggle, and only for it. The boot and SSE paths have
   * nobody to tell — a rejection there would be unhandled — so they keep
   * returning silently on a failed GET. The toggle, on the other hand, must not
   * mistake a gallery that failed to reload for a gallery showing the truth.
   */
  const load = useCallback(async (opts?: { strict?: boolean }) => {
    const response = await fetch('/api/ui/plugins', { cache: 'no-store' });
    if (!response.ok) {
      if (opts?.strict) throw new Error(`GET /api/ui/plugins → ${response.status}`);
      return;
    }
    const data = await response.json() as { plugins?: PluginPublic[] };
    const list = data.plugins ?? [];
    setPlugins(list);
    if (activeMachineId() === LOCAL_MACHINE_ID) return;
    const local = await fetch('/api/ui/plugins/local', { cache: 'no-store' })
      .then(async (r) => (r.ok ? ((await r.json()) as { plugins?: PluginPublic[] }).plugins ?? [] : []))
      .catch(() => [] as PluginPublic[]);
    setAwaiting(awaitingLocalApproval(list, local));
  }, []);

  useEffect(() => {
    void load().catch(() => {});
    return sseOn('plugins_changed', () => { void load().catch(() => {}); });
  }, [load]);

  const setFilter = useCallback((patch: Partial<{ p: ProvenanceTab; t: TypeTab; q: string }>) => {
    const next = {
      p: patch.p ?? provenance,
      t: patch.t ?? type,
      q: patch.q ?? query,
    };
    if (patch.p !== undefined) setProvenance(patch.p);
    if (patch.t !== undefined) setType(patch.t);
    if (patch.q !== undefined) setQuery(patch.q);
    writeUrl(next);
  }, [provenance, type, query]);

  const catalog = useMemo(
    () => (plugins ?? []).map((plugin) => ({ ...toCardData(plugin), awaitingApproval: awaiting.has(plugin.id) })),
    [plugins, awaiting],
  );
  const visible = useMemo(
    () => (plugins ? filterGallery(plugins, { provenance, type, query }) : []),
    [plugins, provenance, type, query],
  );
  const counts = useMemo(
    () => (plugins ? countByProvenance(plugins, { type, query }) : null),
    [plugins, type, query],
  );

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    setFailure(null);
    setBusy(id);
    try {
      let response: Response;
      try {
        // The id travels in the BODY, not in the path: an id like
        // `@timon/kanban` would put an encoded slash in a path segment, and the
        // ingress answers 400 with an empty body before Next ever sees it.
        response = await fetch('/api/ui/plugins/enabled', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, enabled }),
        });
      } catch {
        // A rejected fetch says the ANSWER was lost, not that the write did not
        // happen: the daemon may have applied the change and the response died
        // on the way back. So the user is told the outcome is unknown and to
        // check after a reload — never that nothing was modified.
        toast.error(t('pluginsPage.toggleFailed', { plugin: id }), {
          description: t('pluginsPage.toggleUnreachable'),
        });
        await load().catch(() => {});
        return;
      }
      if (!response.ok) {
        // A refusal must reach the user. Silently returning here is what made a
        // `core` module (403), an unknown id (404) or an expired session (401)
        // indistinguishable from a dead switch: nothing moved, nothing said why.
        const body: unknown = await response.json().catch(() => null);
        const description = toggleFailureMessage(response.status, body);
        setFailure(description);
        toast.error(t('pluginsPage.toggleFailed', { plugin: id }), { description });
        // The daemon's state is the truth; re-read it so the card cannot stay
        // on a wish the daemon never granted.
        await load().catch(() => {});
        return;
      }
      // The daemon has already recomposed. load() only refreshes the gallery
      // list; the in-memory slot registry that drives SlotKeyed on the
      // catch-all would otherwise wait for the async plugins_changed SSE
      // echo. Navigating to the just-disabled page before that echo lands
      // flashes the old content. Await the sync on this tab; SSE still
      // covers the others.
      try {
        await Promise.all([load({ strict: true }), syncClientPlugins()]);
      } catch {
        // The change WAS applied (the daemon answered 2xx) — only this tab
        // failed to catch up, either on the gallery GET (`strict`, so a 500 is
        // no longer mistaken for a refresh) or on the client registry. A
        // different sentence on purpose: telling the user the toggle failed
        // would send them to undo something that already happened.
        toast.warning(t('pluginsPage.toggleApplied', { plugin: id }), {
          description: t('pluginsPage.toggleSyncFailed'),
        });
      }
    } finally {
      setBusy(null);
    }
  };

  // Same side padding as Missions and Kanban (px-6): at px-7 the title and
  // the grid jumped 4px to the right when switching pages.
  return (
    <div className="relative z-[1] h-full overflow-auto px-6 pt-5 pb-8">
      <h1 className="m-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {t('pluginsPage.eyebrow')}
      </h1>
      <div className="mt-1 text-[22px] font-semibold -tracking-[0.01em]">{t('pluginsPage.title')}</div>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('pluginsPage.subtitle')}</p>
      {canInstall && (
        <PluginInstallPanel onInstalled={async () => { await Promise.all([load({ strict: true }), syncClientPlugins()]); }} />
      )}

      <div className="mt-5 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Tabs value={provenance} onValueChange={(v) => isProvenance(v) && setFilter({ p: v })} className="min-w-0">
            <TabsList className="h-auto flex-wrap justify-start">
              {PROVENANCE_VALUES.map((value) => (
                <TabsTrigger key={value} value={value} className="gap-1.5">
                  {t(`pluginsPage.provenance.${value}`)}
                  {counts && (
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {counts[value]}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="relative ml-auto w-56 shrink-0">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={query}
              onChange={(e) => setFilter({ q: e.target.value })}
              placeholder={t('pluginsPage.searchPlaceholder')}
              aria-label={t('pluginsPage.searchPlaceholder')}
              // Filled like the Missions search; the outline only appears on focus.
              className="border-transparent bg-foreground/[0.05] pl-8 shadow-none focus-visible:border-ring/60"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t('pluginsPage.typesLabel')}>
          <button
            type="button"
            role="radio"
            aria-checked={type === 'all'}
            onClick={() => setFilter({ t: 'all' })}
            className={cn(
              'rounded-md border border-transparent bg-muted/30 px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground transition-all',
              type === 'all' ? 'ring-1 ring-current' : 'opacity-60 hover:opacity-100',
            )}
          >
            {t('pluginsPage.typesAll')}
          </button>
          {GALLERY_TYPES.map((kind) => {
            const on = type === kind;
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setFilter({ t: kind })}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-[11.5px] font-medium transition-all',
                  KIND_TONE[kind] ?? 'text-muted-foreground',
                  on ? 'ring-1 ring-current' : 'opacity-60 hover:opacity-100',
                )}
              >
                {kindLabel(kind)}
              </button>
            );
          })}
        </div>
      </div>

      {fixed && <p className="mt-4 text-sm">{t('freeLicense.plugin_composition_fixed')}</p>}
      {failure && <p className="mt-4 text-sm text-destructive" role="alert">{failure}</p>}
      {plugins === null && <p className="mt-6 text-sm text-muted-foreground">{t('common.loading')}</p>}
      {plugins && visible.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">{t('pluginsPage.noMatch')}</p>
      )}
      {plugins && visible.length > 0 && (
        <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {visible.map((plugin) => (
            <PluginBoundary key={plugin.id} pluginId={plugin.id}>
              <PluginCard
                plugin={catalog.find((c) => c.id === plugin.id) ?? toCardData(plugin)}
                catalog={catalog}
                busyId={busy}
                onToggle={fixed ? undefined : (id, enabled) => void toggle(id, enabled)}
              />
            </PluginBoundary>
          ))}
        </div>
      )}
    </div>
  );
}
