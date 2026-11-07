'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useColorScheme } from '@/components/theme-provider';
import VaultNotePanel from '@/components/vault/vault-note-panel';
import { VAULT_LOGO_MASK } from '@/vendor/vault-graph/logo-mask';
import { createVaultGraphMarkup } from '@/vendor/vault-graph/markup';
import graphSource from '@/locales/en/vaultGraphSurface.json';
import type {
  VaultDiscData,
  VaultGraphApi,
  VaultGraphHandle,
} from '@/vendor/vault-graph/page';
import '@/vendor/vault-graph/page.css';
import { machineScopedStorage } from '@/lib/machines/machine-storage';
import { getLocale, t } from '@/lib/i18n';
import { dateTimeFormat, formatDateTime } from '@/lib/intl';

const COLORS_KEY = 'timon-brain-disc-colors';
const SHOWN_KEY = 'timon-brain-disc-shown';

function readMap(key: string): Record<string, string> | Record<string, boolean> | undefined {
  try {
    const raw = machineScopedStorage(localStorage).getItem(key);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed as Record<string, string>;
  } catch {
    return undefined;
  }
}

function writeMap(key: string, map: Record<string, unknown>): void {
  try {
    machineScopedStorage(localStorage).setItem(key, JSON.stringify(map));
  } catch {
    /* quota / private mode */
  }
}

function noteIdFromPath(file: string): string {
  return file.replace(/\.md$/i, '');
}

function applyTheme(root: HTMLElement, theme: string | undefined): void {
  root.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  // The graph engine performs hex colour math. Resolve app HSL tokens to hex
  // before passing them into its private, identically named CSS variables.
  const tokens = getComputedStyle(document.documentElement);
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  for (const [local, global] of Object.entries({
    '--surface-0': '--background', '--surface-1': '--card', '--surface-2': '--muted',
    '--border': '--border', '--border-strong': '--input', '--text-1': '--foreground',
    '--text-2': '--muted-foreground', '--text-3': '--muted-foreground',
    '--accent': '--primary', '--edge-hi': '--primary', '--today': '--foreground',
  })) {
    probe.style.color = `hsl(${tokens.getPropertyValue(global).trim()})`;
    const channels = getComputedStyle(probe).color.match(/[\d.]+/g)?.slice(0, 3);
    if (channels?.length === 3) root.style.setProperty(local, '#' + channels.map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join(''));
  }
  probe.remove();
}

function repaint(api: VaultGraphApi | null): void {
  if (!api) return;
  try {
    api.readTheme();
    api.renderer?.refresh();
    api.placeLogo?.();
    api.heatBuild?.();
  } catch {
    /* mount not ready yet */
  }
}

// `handle.destroy()`, not `api.renderer.kill()`: killing the renderer left every rAF
// loop, observer and window/document listener of the mount running; they kept calling
// refresh() on a dead renderer ("could not find a suitable program for node type
// circle") and burning frames forever. `api` is also null during the disc's deferred
// init, so this cleanup was a complete no-op on a quick unmount.
function killHandle(handle: VaultGraphHandle | null): void {
  if (!handle) return;
  try {
    handle.destroy();
  } catch {
    // destroy() is idempotent and guards itself: this net no longer catches the normal
    // case, only something unexpected we do not want surfacing in a React cleanup.
  }
}

function waitReady(handle: VaultGraphHandle, onReady: (api: VaultGraphApi) => void): () => void {
  if (handle.ready && handle.api) {
    onReady(handle.api);
    return () => undefined;
  }
  const id = window.setInterval(() => {
    if (handle.ready && handle.api) {
      window.clearInterval(id);
      onReady(handle.api);
    }
  }, 30);
  return () => window.clearInterval(id);
}

export default function BrainDisc() {
  const hostRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  const handleRef = useRef<VaultGraphHandle | null>(null);
  const dataRef = useRef<VaultDiscData | null>(null);
  const cancelReadyRef = useRef<(() => void) | null>(null);
  const reloadRef = useRef<() => void>(() => undefined);
  const { scheme: resolvedTheme } = useColorScheme();
  const themeRef = useRef(resolvedTheme);
  themeRef.current = resolvedTheme;
  const [error, setError] = useState<string | null>(null);
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  const generation = useRef(0);

  const followLink = useCallback(
    (target: string) => {
      const nodes = dataRef.current?.nodes ?? [];
      const needle = target.replace(/\.md$/i, '');
      const exact = nodes.find((n) => noteIdFromPath(n.id) === needle);
      if (exact) {
        setOpenNoteId(noteIdFromPath(exact.id));
        return;
      }
      const bn = needle.split('/').pop();
      const match = nodes.find((n) => noteIdFromPath(n.id).split('/').pop() === bn);
      if (match) setOpenNoteId(noteIdFromPath(match.id));
    },
    [],
  );

  const mount = useCallback(async (payload: VaultDiscData, theme: string | undefined) => {
    const host = hostRef.current;
    if (!host) return;
    const gen = ++generation.current;

    const [{ mountVaultGraph }, graphology, sigmaNs] = await Promise.all([
      import('@/vendor/vault-graph/page.js'),
      import('@/vendor/vault-graph/graphology.umd.min.js'),
      import('@/vendor/vault-graph/sigma.min.js'),
    ]);
    if (gen !== generation.current) return;

    cancelReadyRef.current?.();
    killHandle(handleRef.current);
    handleRef.current = null;
    host.replaceChildren();

    const dictionary = Object.fromEntries(Object.entries(graphSource.vaultGraphSurface).map(([key, message]) => {
      const placeholders = Object.fromEntries(Array.from(message.matchAll(/\{(\w+)\}/g), ([slot, name]) => [name, slot]));
      return [key, t(`vaultGraphSurface.${key}`, placeholders)];
    }));
    const locale = getLocale();
    const calendarFormats = {
      month: dateTimeFormat({ month: 'short', timeZone: 'UTC' }, locale),
      weekday: dateTimeFormat({ weekday: 'short', timeZone: 'UTC' }, locale),
      weekdayNarrow: dateTimeFormat({ weekday: 'narrow', timeZone: 'UTC' }, locale),
    };
    const parsed = new DOMParser().parseFromString(createVaultGraphMarkup(dictionary), 'text/html');
    const page = parsed.body.firstElementChild;
    if (!(page instanceof HTMLElement)) {
      setError(t('vault.invalidMarkup'));
      return;
    }
    applyTheme(page, themeRef.current);
    host.appendChild(page);
    pageRef.current = page;

    const g = graphology.default as { Graph?: unknown } & object;
    const s = sigmaNs.default as { Sigma?: unknown; rendering?: Record<string, unknown> };
    const Graph = (g && 'Graph' in g && g.Graph) ? g.Graph : g;
    const Sigma = (s && 'Sigma' in s && s.Sigma) ? s.Sigma : s;
    const rendering = s?.rendering ?? {};

    const handle = mountVaultGraph(page, payload, {
      Graph,
      Sigma,
      rendering,
      locale,
      dictionary,
      formatDate: (value, kind) => kind === 'generated'
        ? formatDateTime(value, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC',
          }, locale)
        : calendarFormats[kind].format(new Date(value)),
      logoMask: VAULT_LOGO_MASK,
      settingsUI: true,
      folderColors: readMap(COLORS_KEY) as Record<string, string> | undefined,
      folderShown: readMap(SHOWN_KEY) as Record<string, boolean> | undefined,
      onFolderColors: (map) => writeMap(COLORS_KEY, map),
      onFolderShown: (map) => writeMap(SHOWN_KEY, map),
      onRefresh: () => reloadRef.current(),
    });
    handleRef.current = handle;
    cancelReadyRef.current = waitReady(handle, (api) => {
      applyTheme(page, themeRef.current);
      repaint(api);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setError(null);
      try {
        const res = await fetch('/api/ui/vault/disc', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as VaultDiscData;
        if (cancelled) return;
        dataRef.current = json;
        await mount(json, themeRef.current);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : t('vault.loadFailed'));
      }
    })();
    reloadRef.current = () => {
      void (async () => {
        try {
          const res = await fetch('/api/ui/vault/disc', { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as VaultDiscData;
          dataRef.current = json;
          await mount(json, themeRef.current);
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : t('vault.loadFailed'));
        }
      })();
    };
    return () => {
      cancelled = true;
      generation.current += 1;
      cancelReadyRef.current?.();
      killHandle(handleRef.current);
      handleRef.current = null;
    };
    // Mounted once: the theme is applied live below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sync = () => {
      const page = pageRef.current;
      if (!page) return;
      applyTheme(page, resolvedTheme);
      repaint(handleRef.current?.api ?? null);
    };
    sync();
    window.addEventListener('timon:theme-painted', sync);
    return () => window.removeEventListener('timon:theme-painted', sync);
  }, [resolvedTheme]);

  // Delegation set on the HOST, not on the disc's markup: that markup is
  // remounted on every data refresh, and the effect listening to it left
  // before it — `pageRef` was still empty at commit, so no click was
  // intercepted any more and the `obsidian://` link opened the application.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (ev: MouseEvent) => {
      const target = ev.target instanceof Element ? ev.target.closest('a[href^="obsidian://"]') : null;
      if (!target) return;
      ev.preventDefault();
      try {
        const href = target.getAttribute('href') ?? '';
        const q = new URLSearchParams(href.split('?')[1] ?? '');
        const file = q.get('file');
        if (file) setOpenNoteId(noteIdFromPath(decodeURIComponent(file)));
      } catch {
        /* malformed link */
      }
    };
    host.addEventListener('click', onClick);
    return () => host.removeEventListener('click', onClick);
  }, []);

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-destructive">
        {t('vault.discError', { error })}
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div ref={hostRef} className="absolute inset-0" />
      {openNoteId && (
        <VaultNotePanel
          noteId={openNoteId}
          onClose={() => setOpenNoteId(null)}
          onFollowLink={followLink}
        />
      )}
    </div>
  );
}
