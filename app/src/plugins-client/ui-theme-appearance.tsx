'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { BackgroundSettings } from '@/components/background/background-settings';
import { toast } from 'sonner';
import { fetchMe, type UserPrefs } from '@/lib/auth';
import { sharedGet } from '@/lib/shared-read';
import {
  appearanceOptions,
  layoutSelection,
  themeSelection,
  type AppearanceCatalogRow,
} from '@/lib/appearance-options';
import { useCapabilities } from '@/lib/capabilities';
import { t } from '@/lib/i18n';
import { syncClientPlugins } from '@/lib/plugin-host/loader';
import { loadLayout, saveLayout } from '@/lib/ui-layout-store';
import {
  THEME_VARIANTS, APPEARANCE_SCOPE, APPEARANCE_EVENT, DEFAULT_APPEARANCE,
  ambientShades, appearancePreviewVars, applyGlassAttributes, customPrimaryShades, hslTripleToHex, readNativeAppearance,
  type NativeAppearance,
} from './ui-theme-variants';
import { Switch } from '@/components/ui/switch';
import { useColorScheme } from '@/components/theme-provider';
import { cn } from '@/lib/utils';
import { GLASS_SCOPES, GLASS_TUNING_ENABLED } from '@/lib/glass-scope';
import { GlassTuningSettings } from './ui-theme-glass-tuning';
import { GlassProfilesSection } from '@/components/glass-profiles';
import { mascotAnimationPref, useMascotAnimation } from '@/components/mascot/mascot-animation-pref';

type CatalogPayload = { plugins?: AppearanceCatalogRow[] };

/** "Animate mascots": the live states of the agents' mascots (docs/AGENT-MASCOT.md). */
export function MascotAnimationSetting(): ReactElement {
  const animate = useMascotAnimation();
  return (
    <fieldset className="py-4">
      <legend className="text-[14px] font-semibold leading-snug">{t('appearance.mascotsTitle')}</legend>
      <p className="mt-0.5 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('appearance.mascotsHint')}</p>
      <label className="mt-3 flex cursor-pointer items-start gap-3">
        <Switch
          checked={animate}
          onCheckedChange={(v) => { void mascotAnimationPref().set(v).then((ok) => { if (!ok) toast.error(t('appearance.saveError')); }); }}
          className="mt-0.5"
          data-mascot-animation-switch=""
        />
        <span className="text-[13px] leading-snug">{t('appearance.mascotsAnimate')}<span className="mt-0.5 block text-[11px] text-muted-foreground">{t('appearance.mascotsAnimateHint')}</span></span>
      </label>
    </fieldset>
  );
}

/** The native canvas of each scheme (`--surface-0`), seeding a picker that holds no colour yet. */
/** The fields `applyGlassAttributes` mirrors onto <html>. */
const GLASS_ATTRIBUTE_FIELDS = new Set<string>(['glass', 'glassBubbles', 'glassScope', 'widgetsBorderless', 'widgetsTransparent']);

const NATIVE_CANVAS = { dark: hslTripleToHex('220 12% 11%'), light: hslTripleToHex('220 14% 97%') } as const;

function RadioList({
  name,
  legend,
  hint,
  empty,
  options,
  value,
  disabled,
  onChoose,
}: {
  name: string;
  legend: string;
  hint: string;
  empty: string;
  options: readonly { id: string; label: string }[];
  value: string;
  disabled: boolean;
  onChoose: (id: string) => void;
}): ReactElement {
  return (
    <fieldset className="py-4">
      <legend className="text-[14px] font-semibold leading-snug">{legend}</legend>
      <p className="mt-0.5 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{hint}</p>
      {options.length === 0 ? (
        <p className="mt-3 text-[12px] text-muted-foreground">{empty}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-1">
          {options.map((option) => {
            const checked = option.id === value;
            return (
              <label
                key={option.id}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] leading-snug',
                  checked
                    ? 'bg-foreground/[0.08] font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
                  disabled && 'pointer-events-none opacity-60',
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={option.id}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onChoose(option.id)}
                  className="size-3.5 accent-primary"
                />
                <span>{option.label}</span>
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

/**
 * Own settings category of `@timon/ui-theme` (`settings.section`). One
 * Appearance screen lists both themes and layouts; the topbar moon/sun
 * toggle writes `scheme` on its own, outside this page.
 */
export function AppearanceSettings(): ReactElement {
  const caps = useCapabilities();
  const { scheme } = useColorScheme();
  const [native, setNative] = useState<NativeAppearance>(DEFAULT_APPEARANCE);
  const [variantReady, setVariantReady] = useState(false);
  useEffect(() => { void loadLayout({ scope: APPEARANCE_SCOPE, storage: null }).then((out) => {
    if (!out.ok) return;
    const loaded = readNativeAppearance(out.raw);
    nativeRef.current = loaded;
    committedRef.current = loaded;
    setNative(loaded);
    setVariantReady(true);
  }); }, []);
  // A profile applied from the Customize interface menu writes the row from
  // outside: follow it, unless a drag of this screen is still in flight.
  useEffect(() => {
    const onExternal = (event: Event) => {
      if (previewFrame.current !== null || Object.keys(pendingPatch.current).length > 0) return;
      const next = readNativeAppearance((event as CustomEvent).detail);
      nativeRef.current = next;
      committedRef.current = next;
      setNative(next);
    };
    window.addEventListener(APPEARANCE_EVENT, onExternal);
    return () => window.removeEventListener(APPEARANCE_EVENT, onExternal);
  }, []);
  const variant = native.variant;
  // Always the whole row: the scope holds variant, colour and glass together,
  // and a write of one field alone would erase the others.
  // `nativeRef` runs ahead of the render during a drag (the latest pixel);
  // `committedRef` is the row last handed to the theme.
  const nativeRef = useRef(native);
  const committedRef = useRef(native);
  // A drag paints inline custom properties on <html>, at most once a frame;
  // the theme's stylesheet is rewritten once, when the row is written.
  const previewFrame = useRef<number | null>(null);
  const previewKeys = useRef<string[]>([]);
  const paintPreview = (next: NativeAppearance) => {
    const root = document.documentElement;
    const vars = appearancePreviewVars(next, root.classList.contains('light') ? 'light' : 'dark');
    for (const key of previewKeys.current) if (!(key in vars)) root.style.removeProperty(key);
    for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
    previewKeys.current = Object.keys(vars);
  };
  const clearPreview = () => {
    if (previewFrame.current !== null) { cancelAnimationFrame(previewFrame.current); previewFrame.current = null; }
    const keys = previewKeys.current;
    previewKeys.current = [];
    if (keys.length === 0) return;
    // Two frames: the theme's new stylesheet is painted before the inline values leave, so nothing flashes back.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (previewKeys.current.length > 0) return;
      for (const key of keys) document.documentElement.style.removeProperty(key);
    }));
  };
  const persistNative = async (patch: Partial<NativeAppearance>) => {
    // Changing the site-wide widget style dates it: every widget's own choice made
    // before now gives way to it, on every page, without opening a single layout.
    const restyles = 'widgetsBorderless' in patch || 'widgetsTransparent' in patch;
    const next = { ...nativeRef.current, ...patch, ...(restyles ? { widgetsStyleAt: Date.now() } : {}) };
    const previous = committedRef.current;
    // Only a switch of the glass or of the widget style concerns <html>'s
    // attributes; announcing it re-renders every widget, so a colour does not.
    const restyled = Object.keys(patch).some((key) => GLASS_ATTRIBUTE_FIELDS.has(key));
    setNative(next);
    nativeRef.current = next;
    committedRef.current = next;
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: next }));
    if (restyled) applyGlassAttributes(next);
    clearPreview();
    const ok = await saveLayout(next, { scope: APPEARANCE_SCOPE, storage: null });
    if (ok) return;
    toast.error(t('appearance.saveError'));
    setNative(previous);
    nativeRef.current = previous;
    committedRef.current = previous;
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: previous }));
    if (restyled) applyGlassAttributes(previous);
  };
  const chooseVariant = async (id: NativeAppearance['variant']) => {
    setSaving(true);
    await persistNative({ variant: id });
    setSaving(false);
  };
  // Pickers and sliders fire on every pixel of a drag: the page previews it
  // through inline properties, the row is written once the hand stops.
  const primaryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatch = useRef<Partial<NativeAppearance>>({});
  const previewPatch = (patch: Partial<NativeAppearance>) => {
    // The state follows at once: a controlled input whose state lags is put
    // back to its old value by React, and the picker jumps under the hand.
    nativeRef.current = { ...nativeRef.current, ...patch };
    setNative(nativeRef.current);
    if (previewFrame.current === null) previewFrame.current = requestAnimationFrame(() => {
      previewFrame.current = null;
      paintPreview(nativeRef.current);
    });
    pendingPatch.current = { ...pendingPatch.current, ...patch };
    if (primaryTimer.current) clearTimeout(primaryTimer.current);
    primaryTimer.current = setTimeout(() => { const flushed = pendingPatch.current; pendingPatch.current = {}; void persistNative(flushed); }, 400);
  };
  const previewPrimary = (hex: string) => previewPatch({ primary: hex });
  // A reset writes at once: a pending drag of the same field must not land after it.
  const resetField = (patch: Partial<NativeAppearance>) => {
    if (primaryTimer.current) clearTimeout(primaryTimer.current);
    const flushed = { ...pendingPatch.current, ...patch };
    pendingPatch.current = {};
    void persistNative(flushed);
  };
  useEffect(() => () => {
    if (primaryTimer.current) clearTimeout(primaryTimer.current);
    if (previewFrame.current !== null) cancelAnimationFrame(previewFrame.current);
    for (const key of previewKeys.current) document.documentElement.style.removeProperty(key);
  }, []);
  const activeVariant = THEME_VARIANTS.find((v) => v.id === variant) ?? THEME_VARIANTS[1];
  const pickerValue = native.primary ?? hslTripleToHex(scheme === 'light' ? activeVariant.light : activeVariant.dark);
  const shades = native.primary ? customPrimaryShades(native.primary) : null;
  const [catalog, setCatalog] = useState<AppearanceCatalogRow[]>([]);
  const [prefs, setPrefs] = useState<UserPrefs | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [me, pluginsRes] = await Promise.all([
      fetchMe(),
      sharedGet('/api/ui/plugins').catch(() => null),
    ]);
    setPrefs(me.prefs);
    if (!pluginsRes?.ok) {
      setCatalog([]);
      return;
    }
    const body = await pluginsRes.json() as CatalogPayload;
    setCatalog(body.plugins ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const themes = useMemo(() => appearanceOptions('theme', caps, catalog), [caps, catalog]);
  const layouts = useMemo(() => appearanceOptions('layout', caps, catalog), [caps, catalog]);
  const selectedTheme = themeSelection(prefs?.theme ?? '', themes);
  const selectedLayout = layoutSelection(prefs?.layout ?? '', layouts);

  const choose = useCallback(async (patch: { theme?: string; layout?: string }) => {
    setSaving(true);
    try {
      const response = await fetch('/api/ui/prefs', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch), cache: 'no-store',
      });
      if (!response.ok) throw new Error('save failed');
      const body = await response.json() as { prefs?: UserPrefs };
      if (body.prefs) setPrefs(body.prefs);
      await syncClientPlugins();
    } catch { toast.error(t('appearance.saveError')); }
    finally { setSaving(false); }
  }, []);

  return (
    <div className="flex flex-col gap-2">
      {selectedTheme === '@timon/ui-theme' && <fieldset className="pb-6 pt-4">
        <legend className="text-sm font-medium">{t('appearance.styleTitle')}</legend>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('appearance.styleHint')}</p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {THEME_VARIANTS.map((v) => <label key={v.id} className={cn('cursor-pointer overflow-hidden border bg-card transition-colors', variant === v.id ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-muted-foreground', (saving || !variantReady) && 'pointer-events-none opacity-60')} style={{ borderRadius: v.radius }}>
            <div aria-hidden="true" className="flex h-20 gap-2 bg-background p-3">
              <div className="w-5 bg-muted" style={{ borderRadius: v.radius * 0.6 }} />
              <div className="flex flex-1 flex-col justify-center gap-2"><span className="h-1.5 w-3/4 rounded-sm bg-muted-foreground/30" /><span className="h-1.5 w-1/2 rounded-sm bg-muted-foreground/20" /><span className="mt-1 h-4 w-12" style={{ background: `hsl(${scheme === 'light' ? v.light : v.dark})`, borderRadius: v.radius * 0.6 }} /></div>
            </div>
            <div className="px-3 py-3"><span className="flex items-center gap-2 text-[13px] font-medium"><input type="radio" name="native-variant" checked={variant === v.id} disabled={saving || !variantReady} onChange={() => void chooseVariant(v.id)} className="accent-primary" />{t(`appearance.variants.${v.id}.name`)}</span><span className="mt-1.5 block text-[11px] text-muted-foreground">{t(`appearance.variants.${v.id}.description`)}</span></div>
          </label>)}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2.5 text-[13px] font-medium">
            <input
              type="color"
              value={pickerValue}
              disabled={saving || !variantReady}
              onChange={(e) => previewPrimary(e.target.value)}
              aria-label={t('appearance.primaryColor')}
              className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent disabled:cursor-not-allowed disabled:opacity-60"
            />
            {t('appearance.primaryColor')}
          </label>
          {shades && <span aria-hidden="true" className="flex items-center gap-1" title={t('appearance.primaryShades')}>
            <span className="size-4 rounded-sm border border-border" style={{ background: `hsl(${shades.dark})` }} />
            <span className="size-4 rounded-sm border border-border" style={{ background: `hsl(${shades.light})` }} />
          </span>}
          {native.primary && <button
            type="button"
            disabled={saving}
            onClick={() => resetField({ primary: null })}
            className="rounded-md border border-border px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
          >
            {t('appearance.primaryReset')}
          </button>}
        </div>
        <p className="mt-1.5 max-w-[65ch] text-[11px] leading-snug text-muted-foreground">{t('appearance.primaryHint')}</p>
        <div className="mt-5">
          <span className="text-[13px] font-medium leading-snug">{t('appearance.tintTitle')}</span>
          <p className="mt-0.5 max-w-[65ch] text-[11px] leading-snug text-muted-foreground">{t('appearance.tintHint')}</p>
          <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
            {(['dark', 'light'] as const).map((mode) => {
              const field = mode === 'dark' ? 'tintDark' : 'tintLight';
              const value = native[field];
              const levels = value ? ambientShades(value, mode, parseFloat((mode === 'dark' ? activeVariant.borderDark : activeVariant.borderLight).split(' ')[2] ?? '0')) : null;
              return (
                <div key={mode} className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2.5 text-[13px]">
                    <input
                      type="color"
                      value={value ?? (mode === 'dark' ? NATIVE_CANVAS.dark : NATIVE_CANVAS.light)}
                      disabled={saving || !variantReady}
                      onChange={(e) => previewPatch({ [field]: e.target.value })}
                      aria-label={t(mode === 'dark' ? 'appearance.tintDark' : 'appearance.tintLight')}
                      className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    {t(mode === 'dark' ? 'appearance.tintDark' : 'appearance.tintLight')}
                  </label>
                  {levels && <span aria-hidden="true" className="flex items-center gap-1" title={t('appearance.tintLevels')}>
                    {(['--chrome', '--surface-sunken', '--surface-0', '--surface-1', '--surface-2', '--surface-4', '--border'] as const).map((token) => (
                      <span key={token} className="size-4 rounded-sm" style={{ background: `hsl(${levels[token]})` }} />
                    ))}
                  </span>}
                  {value && <button
                    type="button"
                    disabled={saving}
                    onClick={() => resetField({ [field]: null })}
                    className="rounded-md border border-border px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
                  >
                    {t('appearance.tintReset')}
                  </button>}
                </div>
              );
            })}
          </div>
        </div>
      </fieldset>}
      {/* The two switch groups sit side by side from `md`: how widgets are drawn on the left, the frosted glass on the right. */}
      <div className="grid gap-x-10 md:grid-cols-2">
      <fieldset className="min-w-0 py-4">
        <legend className="text-[14px] font-semibold leading-snug">{t('appearance.widgetsTitle')}</legend>
        <p className="mt-0.5 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('appearance.widgetsHint')}</p>
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex cursor-pointer items-start gap-3">
            <Switch checked={native.widgetsBorderless} disabled={!variantReady} onCheckedChange={(v) => { void persistNative({ widgetsBorderless: v }); }} className="mt-0.5" />
            <span className="text-[13px] leading-snug">{t('appearance.widgetsBorderless')}<span className="mt-0.5 block text-[11px] text-muted-foreground">{t('appearance.widgetsBorderlessHint')}</span></span>
          </label>
          <label className="flex cursor-pointer items-start gap-3">
            <Switch checked={native.widgetsTransparent} disabled={!variantReady} onCheckedChange={(v) => { void persistNative({ widgetsTransparent: v }); }} className="mt-0.5" />
            <span className="text-[13px] leading-snug">{t('appearance.widgetsTransparent')}<span className="mt-0.5 block text-[11px] text-muted-foreground">{t('appearance.widgetsTransparentHint')}</span></span>
          </label>
        </div>
      </fieldset>
      <fieldset className="min-w-0 py-4">
        <legend className="text-[14px] font-semibold leading-snug">{t('appearance.glassTitle')}</legend>
        <p className="mt-0.5 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('appearance.glassHint')}</p>
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex cursor-pointer items-start gap-3">
            <Switch checked={native.glass} disabled={!variantReady} onCheckedChange={(v) => { void persistNative({ glass: v }); }} className="mt-0.5" />
            <span className="text-[13px] leading-snug">{t('appearance.glassChrome')}<span className="mt-0.5 block text-[11px] text-muted-foreground">{t('appearance.glassChromeHint')}</span></span>
          </label>
          <label className="flex cursor-pointer items-start gap-3">
            <Switch checked={native.glassBubbles} disabled={!variantReady} onCheckedChange={(v) => { void persistNative({ glassBubbles: v }); }} className="mt-0.5" />
            <span className="text-[13px] leading-snug">{t('appearance.glassBubbles')}<span className="mt-0.5 block text-[11px] text-muted-foreground">{t('appearance.glassBubblesHint')}</span></span>
          </label>
        </div>
        {/* Where the glass sits: the default each island follows until its menu says otherwise. */}
        <div role="radiogroup" aria-label={t('appearance.glassScope')} className={cn('mt-4 flex flex-col gap-1', (!native.glass || !variantReady) && 'pointer-events-none opacity-80')}>
          <span className="text-[13px] leading-snug">{t('appearance.glassScope')}<span className="mt-0.5 block text-[11px] text-muted-foreground">{t('appearance.glassScopeHint')}</span></span>
          {GLASS_SCOPES.map((scope) => {
            const checked = native.glassScope === scope;
            const key = scope === 'island' ? 'Island' : scope === 'widgets' ? 'Widgets' : 'Both';
            const [label, hint] = [t(`appearance.glassScope${key}`), t(`appearance.glassScope${key}Hint`)];
            return (
              <label
                key={scope}
                className={cn(
                  'flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-[13px] leading-snug',
                  checked ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
                )}
              >
                <input
                  type="radio"
                  name="appearance-glass-scope"
                  value={scope}
                  checked={checked}
                  disabled={!native.glass || !variantReady}
                  onChange={() => { void persistNative({ glassScope: scope }); }}
                  // Drawn rather than native: a disabled native radio greys its
                  // dot to the row's own grey, and the choice vanished.
                  className="mt-0.5 size-3.5 shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-muted-foreground/60 bg-transparent transition-colors checked:border-[4px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                />
                <span className={cn(checked && 'font-medium')}>{label}<span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">{hint}</span></span>
              </label>
            );
          })}
        </div>
        {/* Hidden until finished (`GLASS_TUNING_ENABLED`): one section with the switches above. */}
        {GLASS_TUNING_ENABLED && <>
          <GlassTuningSettings
            native={native}
            disabled={(!native.glass && !native.glassBubbles) || !variantReady}
            scheme={scheme === 'light' ? 'light' : 'dark'}
            onPreview={previewPatch}
            onReset={resetField}
          />
          <GlassProfilesSection native={native} onApply={(settings) => resetField(settings)} />
        </>}
      </fieldset>
      </div>
      <MascotAnimationSetting />
      <BackgroundSettings />
      <RadioList
        name="appearance-theme"
        legend={t('appearance.theme')}
        hint={t('appearance.themeHint')}
        empty={t('appearance.emptyThemes')}
        options={themes}
        value={selectedTheme}
        disabled={saving}
        onChoose={(id) => { void choose({ theme: id }); }}
      />
      <RadioList
        name="appearance-layout"
        legend={t('appearance.layout')}
        hint={t('appearance.layoutHint')}
        empty={t('appearance.emptyLayouts')}
        options={layouts}
        value={selectedLayout}
        disabled={saving}
        onChoose={(id) => { void choose({ layout: id }); }}
      />
    </div>
  );
}
