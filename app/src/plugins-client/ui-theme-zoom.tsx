'use client';

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Minus, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/lib/i18n';
import { DEFAULT_UI_ZOOM, formatUiZoom, readUiZoom, setUiZoom, stepUiZoom, subscribeUiZoom, type UiZoomDirection, type UiZoomState } from '@/lib/ui-zoom';

/**
 * "Interface size" (desktop app): how large Timon's text and controls are in
 * every window of this computer. Rendered only where the shell answers, so
 * the web and an older desktop never see it. The keys and Ctrl+wheel change
 * the same size: the control follows them while Settings is open.
 */
export function InterfaceSizeSetting(): ReactElement | null {
  const [zoom, setZoom] = useState<UiZoomState | null>(null);
  const [saving, setSaving] = useState(false);
  // Settings can close while the shell is still answering: no state is set on an unmounted control.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    void readUiZoom().then((state) => { if (aliveRef.current && state) setZoom(state); });
    const stop = subscribeUiZoom((factor) => { if (aliveRef.current) setZoom((old) => (old ? { ...old, factor } : old)); });
    return () => { aliveRef.current = false; stop(); };
  }, []);
  if (zoom === null) return null;

  const { factor, steps } = zoom;
  const apply = async (change: () => Promise<number | null>): Promise<void> => {
    setSaving(true);
    const next = await change();
    if (!aliveRef.current) return;
    setSaving(false);
    if (next === null) { toast.error(t('appearance.zoomError')); return; }
    setZoom((old) => (old ? { ...old, factor: next } : old));
  };
  const step = (direction: UiZoomDirection) => { void apply(() => stepUiZoom(direction)); };
  const choose = (value: string) => {
    const next = Number(value);
    if (Number.isFinite(next) && next !== factor) void apply(() => setUiZoom(next));
  };
  const smallest = steps[0] ?? factor;
  const largest = steps[steps.length - 1] ?? factor;
  // A size the shell holds that is not offered (a newer shell) still shows as the current one.
  const offered = steps.includes(factor) ? steps : [...steps, factor].sort((a, b) => a - b);

  return (
    <fieldset className="py-4" data-interface-size-setting="">
      <legend className="text-sm font-medium">{t('appearance.zoomTitle')}</legend>
      <p className="mt-1 max-w-[65ch] text-xs leading-relaxed text-muted-foreground">{t('appearance.zoomHint')}</p>
      <TooltipProvider delayDuration={300}>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t('appearance.zoomOut')}
                disabled={saving || factor <= smallest}
                onClick={() => step('out')}
                data-interface-size="out"
              >
                <Minus aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('appearance.zoomOut')}</TooltipContent>
          </Tooltip>
          <Select value={String(factor)} onValueChange={choose} disabled={saving}>
            <SelectTrigger className="w-28" aria-label={t('appearance.zoomTitle')} data-interface-size="value">
              <SelectValue>{formatUiZoom(factor)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {offered.map((option) => <SelectItem key={option} value={String(option)}>{formatUiZoom(option)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t('appearance.zoomIn')}
                disabled={saving || factor >= largest}
                onClick={() => step('in')}
                data-interface-size="in"
              >
                <Plus aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('appearance.zoomIn')}</TooltipContent>
          </Tooltip>
          <Button
            type="button"
            variant="ghost"
            size="default"
            disabled={saving || factor === DEFAULT_UI_ZOOM}
            onClick={() => step('reset')}
            data-interface-size="reset"
          >
            {t('appearance.zoomReset')}
          </Button>
        </div>
      </TooltipProvider>
    </fieldset>
  );
}
