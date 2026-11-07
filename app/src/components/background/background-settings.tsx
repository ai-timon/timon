'use client';

import { useEffect, useRef, useState, useId } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useColorScheme } from '@/components/theme-provider';
import { BACKGROUND_PATTERNS } from './background-model';
import { BackgroundPattern } from './background-pattern';
import { BackgroundSurface, useBackground } from './background-provider';
import { BackgroundPhotoError, prepareBackgroundPhoto, uploadBackgroundPhoto } from './background-photo';

const button = 'rounded-md border border-border bg-card px-3 py-2 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50';
export function BackgroundSettings() {
  const { background, ready, update } = useBackground();
  const { scheme } = useColorScheme();
  const [themeColor, setThemeColor] = useState('#181b20');
  useEffect(() => {
    const sync = () => {
      const rgb = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
      if (rgb && rgb.length >= 3) setThemeColor('#' + rgb.slice(0, 3).map(v => Number(v).toString(16).padStart(2, '0')).join(''));
    };
    sync();
    window.addEventListener('timon:theme-painted', sync);
    return () => window.removeEventListener('timon:theme-painted', sync);
  }, [scheme]);
  const [uploading, setUploading] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = !ready || uploading;
  const upload = async (file: File) => {
    setUploading(true);
    try {
      const dataUrl = await prepareBackgroundPhoto(file);
      if (!alive.current) return;
      const url = await uploadBackgroundPhoto(dataUrl);
      if (!alive.current) {
        void fetch(url, { method: 'DELETE' }).catch(() => {});
        return;
      }
      const old = background.photo;
      const ok = await update({ photo: url, mode: 'photo' });
      if (ok && old && old !== url) void fetch(old, { method: 'DELETE' }).catch(() => {});
    } catch (error) {
      const code = error instanceof BackgroundPhotoError ? error.code : 'decode';
      if (alive.current) toast.error(t(`appearance.background.errors.${code}`));
    } finally { if (alive.current) setUploading(false); }
  };
  const removePhoto = async () => {
    const old = background.photo;
    if (!old) return;
    const ok = await update({ photo: null, mode: 'pattern' });
    if (ok) void fetch(old, { method: 'DELETE' }).catch(() => {});
  };
  // Same header as the Appearance sections above it: a deeper padding put
  // twice their gap between this title and its hint.
  return <fieldset className="min-w-0 py-4" disabled={busy}>
    <legend className="text-[14px] font-semibold leading-snug">{t('appearance.background.title')}</legend>
    <p className="mt-0.5 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('appearance.background.hint')}</p>
    <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-w-0 space-y-5">
        {/* A segmented control, like the tabs above it: one plate, the chosen
            side raised. A filled button beside an outlined one read as two
            unrelated controls. */}
        <div className="inline-flex gap-1 rounded-lg bg-foreground/[0.05] p-1">
          {(['pattern', 'photo'] as const).map(mode => <button key={mode} type="button" aria-pressed={background.mode === mode} className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50', background.mode === mode ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')} onClick={() => {
            if (mode === 'photo' && !background.photo) fileInput.current?.click();
            else void update({ mode });
          }}>{t(`appearance.background.${mode}`)}</button>)}
        </div>
        {background.mode === 'pattern' && <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-label={t('appearance.background.pattern')}>
            {BACKGROUND_PATTERNS.map(pattern => <label key={pattern} className={cn('relative cursor-pointer overflow-hidden rounded-lg border bg-card', pattern === background.pattern ? 'border-primary ring-1 ring-primary' : 'border-transparent')}>
              <div className="relative h-16 overflow-hidden" style={{ backgroundColor: background.colors[scheme] ?? 'hsl(var(--background))' }}><BackgroundPattern pattern={pattern} intensity={0.65} /></div>
              <span className="flex items-center gap-1.5 bg-muted/30 px-2 py-2 text-[11px]"><input type="radio" name="background-pattern" value={pattern} checked={background.pattern === pattern} onChange={() => void update({ pattern })} className="accent-primary" />{t(`appearance.background.patterns.${pattern}`)}</span>
            </label>)}
          </div>
          {background.pattern !== 'none' && <label className="flex flex-col gap-2 text-xs" htmlFor={`${id}-intensity`}>
            <span className="flex justify-between">{t('appearance.background.intensity')}<output>{Math.round(background.intensity * 100)} %</output></span>
            <input id={`${id}-intensity`} type="range" min="0" max="65" value={Math.round(background.intensity * 100)} onChange={e => void update({ intensity: Number(e.target.value) / 100 })} className="w-full accent-primary" />
          </label>}
        </>}
        <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only" aria-label={t('appearance.background.upload')} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file); }} />
        {(background.mode === 'photo' || uploading) && <div className="space-y-3">
          <div className="flex flex-wrap gap-2"><button type="button" className={cn(button, 'flex items-center gap-2')} onClick={() => fileInput.current?.click()}><ImagePlus className="size-4" />{t(uploading ? 'appearance.background.uploading' : 'appearance.background.replace')}</button>
            {background.photo && <button type="button" className={cn(button, 'flex items-center gap-2')} onClick={() => void removePhoto()}><Trash2 className="size-4" />{t('appearance.background.remove')}</button>}
          </div>
          <label className="flex flex-col gap-2 text-xs" htmlFor={`${id}-veil`}>
            <span className="flex justify-between">{t('appearance.background.veil')}<output>{Math.round(background.veil * 100)} %</output></span>
            <input id={`${id}-veil`} type="range" min="10" max="95" value={Math.round(background.veil * 100)} onChange={e => void update({ veil: Number(e.target.value) / 100 })} className="w-full accent-primary" />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">{t('appearance.background.photoHint')}</p>
        </div>}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs"><input type="color" aria-label={t('appearance.background.color')} value={background.colors[scheme] ?? themeColor} onChange={e => void update({ colors: { ...background.colors, [scheme]: e.target.value } })} className="h-8 w-10 cursor-pointer rounded border border-border bg-card p-0.5" />{t('appearance.background.color')}</label>
          <button type="button" className={button} disabled={busy || background.colors[scheme] === null} onClick={() => void update({ colors: { ...background.colors, [scheme]: null } })}>{t('appearance.background.themeColor')}</button>
        </div>
      </div>
      <div className="min-w-0">
        <div className="relative h-48 overflow-hidden rounded-xl bg-foreground/[0.03]" aria-label={t('appearance.background.preview')}>
          <BackgroundSurface background={background} />
          <div className="absolute inset-x-5 bottom-5 rounded-lg bg-card p-3 shadow-elev-1"><span className="text-xs font-medium text-card-foreground">{t('appearance.background.preview')}</span><p className="mt-1 text-[11px] text-muted-foreground">{t('appearance.background.previewHint')}</p></div>
        </div>
      </div>
    </div>
  </fieldset>;
}
