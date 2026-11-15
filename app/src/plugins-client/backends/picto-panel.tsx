'use client';

/**
 * How a backend added by hand — or one of its models — gets a logo.
 *
 * The brands the product ships, wrapping onto as many lines as the width asks,
 * then a picture of one's own and an emoji, kept at the right of the first
 * line. The brands draw in `currentColor` and follow the theme; a picture or
 * an emoji covers every provider we have never heard of. The active choice is
 * highlighted, and pressing it again goes back to "no picture".
 * Deliberately INLINE, with no portal: a picker that opened over a row of the
 * model editor would fight the dialog that frames an uploaded image.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Crop, ImagePlus } from 'lucide-react';
import { BRAND_KEYS, BrandMark } from '@/components/brand-mark';
import { EmojiPicker } from '@/components/emoji-picker';
import { firstImageFile } from '@/components/logo-field';
import { LogoCropDialog, type LogoCropSource } from '@/components/logo-crop-dialog';
import { isIconUrl } from '@/lib/project-visual';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

/** The two halves of a picture, as the daemon stores them: a key of a logo we
 *  ship, or something the user provided. Never both. */
export type Picto = { icon: string | null; brand: string | null };

const NONE: Picto = { icon: null, brand: null };

/** Mounted panels, most recent last. The backend's own panel and the one of a
 *  model row can be on screen together: a paste goes to the one opened last,
 *  never to both. */
const pasteTargets: string[] = [];

function Choice({ active, label, onClick, children }: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'grid size-7 shrink-0 place-items-center overflow-hidden rounded-md transition-colors hover:bg-muted',
        active && 'bg-background shadow-sm ring-1 ring-primary/40',
      )}
    >
      {children}
    </button>
  );
}

export function PictoPanel({ value, onChange, className }: {
  value: Picto;
  onChange: (next: Picto) => void;
  className?: string;
}): ReactElement {
  const id = useId();
  const [source, setSource] = useState<LogoCropSource | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const picture = isIconUrl(value.icon) ? value.icon : null;
  const emoji = value.icon && !picture ? value.icon : null;

  const accept = useCallback((file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error(t('projectsPage.imageOnly')); return; }
    // Every image goes through the framing dialog, as in every logo field.
    setSource(file);
  }, []);

  // Ctrl/Cmd+V anywhere in the editor pastes into the picture.
  useEffect(() => {
    pasteTargets.push(id);
    const onPaste = (event: ClipboardEvent) => {
      if (pasteTargets[pasteTargets.length - 1] !== id) return;
      const image = firstImageFile(event.clipboardData?.items ?? null, null);
      if (!image) return;
      event.preventDefault();
      accept(image);
    };
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('paste', onPaste);
      pasteTargets.splice(pasteTargets.lastIndexOf(id), 1);
    };
  }, [accept, id]);

  return (
    <div
      className={cn(
        'flex min-w-0 flex-nowrap items-start gap-0.5 rounded-md border border-dashed p-1 transition-colors',
        dragOver ? 'border-foreground/50 bg-muted/60' : 'border-transparent',
        className,
      )}
      onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        accept(firstImageFile(event.dataTransfer?.items ?? null, event.dataTransfer?.files ?? null));
      }}
    >
      {/* The brands wrap rather than scroll: a strip as wide as twenty logos
          set the min-content width of the dialog around it, which then
          overflowed sideways. The picture and emoji buttons stay outside the
          strip, so they keep their place at the right, and the emoji picker,
          which opens below its button in plain absolute positioning, is never
          inside a clipping box. */}
      <div data-picto-brands className="mr-2 flex min-w-0 flex-1 flex-wrap items-center gap-0.5 p-px">
        {BRAND_KEYS.map((key) => (
          <Choice key={key} label={key} active={value.brand === key}
            onClick={() => onChange(value.brand === key ? NONE : { icon: null, brand: key })}>
            <BrandMark brand={key} className="size-4" />
          </Choice>
        ))}
      </div>
      <Choice
        active={!!picture}
        label={t(picture ? 'backendsSettings.picto.remove' : 'backendsSettings.picto.image')}
        onClick={() => (picture ? onChange(NONE) : fileInput.current?.click())}
      >
        {picture
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={picture} alt="" className="size-full object-cover" />
          : <ImagePlus className="size-3.5 text-muted-foreground" />}
      </Choice>
      {picture ? (
        <Choice active={false} label={t('logoCrop.adjust')} onClick={() => setSource(picture)}>
          <Crop className="size-3.5 text-muted-foreground" />
        </Choice>
      ) : null}
      {emoji ? (
        <Choice active label={t('backendsSettings.picto.remove')} onClick={() => onChange(NONE)}>
          <span className="text-[15px] leading-none">{emoji}</span>
        </Choice>
      ) : (
        <EmojiPicker
          iconLabel={t('backendsSettings.picto.emoji')}
          align="end"
          className="size-7 text-muted-foreground"
          onPick={(picked) => onChange({ icon: picked, brand: null })}
        />
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Without a reset, picking the same file twice in a row fires nothing.
          event.target.value = '';
          accept(file);
        }}
      />
      {/* `accent` of a logo field is the tint of an owner; these objects have
          none, so the neutral slate is offered as a background. */}
      <LogoCropDialog
        source={source}
        endpoint="/api/uploads/backends"
        suggestedBackground="#64748b"
        onCancel={() => setSource(null)}
        onUploaded={(url) => { setSource(null); onChange({ icon: url, brand: null }); }}
      />
    </div>
  );
}
