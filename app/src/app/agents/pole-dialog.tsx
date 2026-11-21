'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { t } from '@/lib/i18n';
import { createPole, updatePole } from './hierarchy-actions';
import { deletePoleAfterConfirm } from './delete-pole';
import type { PoleRecord } from './agents-client';

/** Offered when the user ticks a colour on; a pole starts without one and
 *  then follows the theme's accent. */
const DEFAULT_COLOR = '#5b8def';

/** Create a pole, or edit one (name, colour, lead agent, deletion). */
export function PoleDialog({ pole, agents, onClose, onSaved }: {
  /** The pole to edit; absent = create a new one. */
  pole?: PoleRecord | null;
  agents: readonly string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(pole?.name ?? '');
  const [color, setColor] = useState<string | null>(pole?.color ?? null);
  const [lead, setLead] = useState(pole?.lead_agent ?? '');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const input = { name: trimmed, color, lead_agent: lead || null };
    const error = pole ? await updatePole(pole.slug, input) : await createPole(input);
    setBusy(false);
    if (error) {
      toast.error(t('agentsPage.actionFailed', { error }));
      return;
    }
    toast.success(t(pole ? 'agentsPage.poleSaved' : 'agentsPage.poleCreated', { name: trimmed }));
    onSaved();
    onClose();
  }

  async function remove() {
    if (!pole || busy) return;
    setBusy(true);
    const deleted = await deletePoleAfterConfirm(pole);
    setBusy(false);
    if (!deleted) return;
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogTitle>{pole ? t('agentsPage.editPoleNamed', { name: pole.name }) : t('agentsPage.newPole')}</DialogTitle>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-[12px] font-medium">
            {t('agentsPage.poleName')}
            <Input autoFocus required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="flex flex-col gap-1.5 text-[12px] font-medium">
            {t('agentsPage.poleColor')}
            <div className="flex items-center gap-3">
              <input
                type="color"
                aria-label={t('agentsPage.poleColor')}
                value={color ?? DEFAULT_COLOR}
                disabled={color === null}
                onChange={(e) => setColor(e.target.value)}
                className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent disabled:opacity-40"
              />
              <label className="flex items-center gap-1.5 font-normal text-muted-foreground">
                <input type="checkbox" checked={color === null} onChange={(e) => setColor(e.target.checked ? null : DEFAULT_COLOR)} />
                {t('agentsPage.poleNoColor')}
              </label>
            </div>
          </div>
          <label className="flex flex-col gap-1.5 text-[12px] font-medium">
            {t('agentsPage.poleLead')}
            <select
              value={lead}
              onChange={(e) => setLead(e.target.value)}
              className="h-9 rounded-md border border-input bg-card px-2 text-[13px] font-normal"
            >
              <option value="">{t('agentsPage.poleNoLead')}</option>
              {agents.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <DialogFooter className="gap-2 sm:justify-between">
            {pole ? (
              <Button type="button" variant="outline" className="text-destructive" disabled={busy} onClick={remove}>
                {t('agentsPage.poleDelete')}
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('agentsPage.cancel')}</Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {t(pole ? 'agentsPage.poleSave' : 'agentsPage.poleCreate')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
