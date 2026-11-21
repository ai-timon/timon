/**
 * Citadel — browser half: the full-screen `/citadel` page (a 3D scene of the agents, mounted in a
 * container and unmounted cleanly) and its sidebar link.
 */
import React from 'react';
import type { ComponentType } from 'react';
import * as ui from '@timon/ui';
import type { ClientContext } from '@timon-ai/sdk';
import { mountCitadel } from './app.js';
import { configureI18n, t } from './i18n.js';
import messages from './messages.json';

const NavLink = ui.NavLink as ComponentType<{ href: string; label: string; icon: ComponentType }>;
configureI18n({ translate: ui.createTranslator(messages), locale: ui.getLocale });

const THEME_KEY = 'citadel.theme';
type ThemeId = 'light' | 'mordor';
const THEMES: readonly (readonly [ThemeId, string])[] = [['light', 'themeLight'], ['mordor', 'themeMordor']];
const readTheme = (): ThemeId => {
  try { const v = localStorage.getItem(THEME_KEY); return THEMES.find(([id]) => id === v)?.[0] ?? 'light'; } catch { return 'light'; }
};
const switchCss = '.ctd-theme{position:absolute;right:24px;bottom:20px;z-index:20;display:flex;padding:3px;border-radius:12px;background:rgba(255,255,255,.72);box-shadow:0 4px 18px rgba(0,0,0,.12);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}.ctd-theme button{border:0;background:none;padding:6px 14px;border-radius:9px;font:500 13px system-ui,sans-serif;color:#3a3a3c;cursor:pointer}.ctd-theme button[aria-pressed=true]{background:#1d1d1f;color:#fff}.ctd-dark .ctd-theme{background:rgba(22,14,12,.8)}.ctd-dark .ctd-theme button{color:#b39a8a}.ctd-dark .ctd-theme button[aria-pressed=true]{background:#efe2d6;color:#0b0807}';

// Full-screen page: the 3D scene mounts in a relative container and unmounts cleanly. Changing the theme remounts it.
const makePage = (ctx: ClientContext) => function CitadelPage(): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [theme, setTheme] = React.useState<ThemeId>(readTheme);
  React.useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    let cancelled = false;
    let dispose: (() => void) | null = null;
    setError(null);
    mountCitadel(root, path => ctx.api(path), { theme }).then(
      d => { if (cancelled) d(); else dispose = d; },
      (e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; if (dispose) dispose(); };
  }, [theme]);
  const pick = (id: ThemeId): void => { setTheme(id); try { localStorage.setItem(THEME_KEY, id); } catch { /* storage unavailable: the choice lasts for this visit */ } };
  return (
    <div className={theme === 'mordor' ? 'ctd-dark' : ''} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 480, overflow: 'hidden' }}>
      <div key={theme} ref={ref} style={{ position: 'absolute', inset: 0 }} />
      <style>{switchCss}</style>
      <div className="ctd-theme" role="group" aria-label={t('theme')}>
        {THEMES.map(([id, label]) => <button key={id} aria-pressed={theme === id} onClick={() => pick(id)}>{t(label)}</button>)}
      </div>
      {error ? <p style={{ position: 'absolute', inset: 0, margin: 0, display: 'grid', placeItems: 'center', font: '14px system-ui,sans-serif', color: '#6e6e73' }}>{t('loadError', { message: error })}</p> : null}
    </div>
  );
};

const NavIcon = (): React.ReactElement => (
  <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3 3 8l9 5 9-5-9-5z" />
    <path d="M3 13l9 5 9-5M3 17.5l9 5 9-5" />
  </svg>
);
const NavItem = (): React.ReactElement => <NavLink href="/citadel" label={t('navLabel')} icon={NavIcon} />;

export function apply(ctx: ClientContext): () => void {
  const disposers = [
    ctx.slots.register({ slot: 'page', key: '/citadel' }, makePage(ctx)),
    ctx.slots.register({ slot: 'nav.item', key: 'citadel' }, NavItem),
  ];
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
