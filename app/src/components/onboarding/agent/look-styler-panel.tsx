'use client';

/**
 * "Customise" (mockup `#styler`): it takes the place of the step's form, in
 * the flow, beside the agent's card — side by side, never over the step (the maintainer,
 * 05/11/2026: the floating panel covered the form and could not be moved).
 * The panel is the step's — its title, its close button, "Done" and
 * Escape; what it holds is the shared configurator (`LookStylerHost`, slot
 * `agent.lookstyler`), the same one the agent editor's Avatar tab opens. The
 * step owns it: leaving the step unmounts it, so the panel never outlives it.
 * Above the choices sits the 3D / 2D switch, the preference of Settings →
 * Appearance → Mascot style.
 */
import { useEffect, useRef, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AgentLook } from '@/components/mascot/agent-look';
import { LookStylerHost } from '@/components/mascot/look-styler/look-styler';
import { MascotStyleSwitch } from '@/components/mascot/look-styler/mascot-style-switch';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type LookStylerPanelProps = {
  open: boolean;
  name: string;
  role?: string | null;
  look: AgentLook;
  onChange: (look: AgentLook) => void;
  onClose: () => void;
};

export function LookStylerPanel({ open, name, role = null, look, onChange, onClose }: LookStylerPanelProps): ReactElement {
  const done = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    done.current?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div
      id="agent-look-styler"
      role="dialog"
      aria-modal="false"
      aria-hidden={!open}
      aria-label={t('onboarding.agent.style.title', { name })}
      data-look-styler={open ? 'open' : 'closed'}
      className={cn(
        'min-w-0 flex-col overflow-hidden rounded-[22px] bg-card shadow-elev-2 ring-1 ring-border md:sticky md:top-2 md:h-[min(640px,calc(100vh-140px))]',
        // Not displayed while closed: nothing in it takes the focus or the room.
        open ? 'flex' : 'hidden',
      )}
    >
      <div className="flex items-center gap-2.5 pl-5 pr-4 pt-4">
        <h2 className="flex-1 text-[17px] font-bold">{t('onboarding.agent.style.title', { name })}</h2>
        <button type="button" onClick={onClose} aria-label={t('onboarding.agent.style.close')} className="grid size-8 place-items-center rounded-[10px] text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      {/* Mounted only while open: a closed panel animates no mascot and paints no grid. */}
      <div className="mx-4 mt-1 flex min-h-0 flex-1 flex-col">
        {open && <LookStylerHost look={look} onChange={onChange} name={name} role={role} header={<MascotStyleSwitch />} />}
      </div>
      <div className="flex gap-2 px-4 pb-4 pt-3">
        <Button ref={done} type="button" className="min-w-0 flex-1" data-style-done onClick={onClose}>{t('onboarding.agent.style.done')}</Button>
      </div>
    </div>
  );
}
