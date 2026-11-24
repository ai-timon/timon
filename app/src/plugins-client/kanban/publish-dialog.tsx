'use client';

/**
 * The host of the "Publish on GitHub" dialog (`forge.publish.dialog`), the
 * one way a text of Timon's reaches the forge (`docs/FORGE-FLOW-PLAN.md` §3.3,
 * §5): a proposal waiting for approval, opened from a job's or a pull
 * request's row or from its notification card, or a new comment a person
 * writes on a pull request.
 *
 * It reads the proposal and the account the project publishes as, keeps the
 * text being edited, and makes the calls; the daemon publishes only for a
 * signed-in person and checks the account again before any write. The
 * occupant reads `usePublishDialog()` and only paints. The product's dialog is
 * painted directly while only its registered fallback holds the slot.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { PUBLISH_DIALOG_SLOT } from '@/lib/plugin-host/slots';
import { t } from '@/lib/i18n';
import {
  bodyProblem, createProposal, discardProposal, editProposal, getProposal, isEditable, projectAccount, publishProposal,
  type ForgeProposal, type ForgeTargetType,
} from './forge-proposals-api';
import { PublishDialogContext, type PublishBusy, type PublishDialogValue } from './publish-dialog-context';
import { ProductPublishDialog } from './product-publish-dialog';
import type { Answer } from './landing-api';

/** A new comment a person writes: where it would go. */
export type PublishTarget = { type: ForgeTargetType; number: number; url: string | null; repo: string | null };

export type PublishDialogProps = {
  project: string;
  /** The proposal to open, read again from the daemon. */
  proposalId?: string;
  /** Or the proposal as a list already holds it (read again all the same). */
  proposal?: ForgeProposal;
  /** Or a new comment on this target. */
  target?: PublishTarget;
  onClose: () => void;
  /** A proposal was saved, published or discarded: the screen reads its rows again. */
  onChange?: () => void;
};

export function PublishDialog({ project, proposalId, proposal: given, target, onClose, onChange }: PublishDialogProps): ReactElement {
  const id = proposalId ?? given?.id ?? null;
  const [proposal, setProposal] = useState<ForgeProposal | null>(given ?? null);
  const [body, setBody] = useState(given?.body ?? '');
  const [account, setAccount] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<PublishBusy>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([id ? getProposal(project, id) : Promise.resolve(null), projectAccount(project)]).then(([read, acc]) => {
      if (!alive) return;
      setAccount(acc);
      if (read && read.ok) { setProposal(read.value); setBody(read.value.body); }
      else if (read) setError(read.message);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [project, id]);

  /** The proposal the text belongs to, created on its first save or publication. */
  const ensure = useCallback(async (): Promise<Answer<ForgeProposal>> => {
    if (proposal) return { ok: true, value: proposal };
    if (!target) return { ok: false, message: t('forgePublish.noTarget') };
    return createProposal(project, { type: target.type, number: target.number }, body);
  }, [proposal, target, project, body]);

  const run = useCallback(async (kind: Exclude<PublishBusy, null>, step: () => Promise<Answer<ForgeProposal>>, done: (p: ForgeProposal) => void): Promise<boolean> => {
    setBusy(kind);
    setError(null);
    const out = await step();
    setBusy(null);
    if (!out.ok) { setError(out.message); return false; }
    setProposal(out.value);
    onChange?.();
    done(out.value);
    return true;
  }, [onChange]);

  const value = useMemo<PublishDialogValue>(() => {
    const where = proposal
      ? { type: proposal.target.type, number: proposal.target.number, url: proposal.target.url }
      : { type: target?.type ?? 'pull', number: target?.number ?? 0, url: target?.url ?? null };
    // A branch update has no text of the person's: the daemon wrote it and publishes it as is.
    const editable = proposal ? isEditable(proposal) : true;
    return {
      project,
      proposal,
      loading,
      repo: proposal?.repo ?? target?.repo ?? null,
      target: where,
      account,
      body,
      setBody,
      editable,
      problem: editable ? bodyProblem(body) : null,
      busy,
      error,
      publish: () => run('publish', async () => {
        const made = await ensure();
        if (!made.ok) return made;
        return publishProposal(project, made.value.id, isEditable(made.value) ? body : made.value.body);
      }, (p) => {
        toast.success(t('forgePublish.published'), p.url ? { action: { label: t('forgePublish.openComment'), onClick: () => window.open(p.url!, '_blank', 'noopener,noreferrer') } } : undefined);
        onClose();
      }),
      save: () => run('save', async () => {
        const made = await ensure();
        if (!made.ok || made.value.body === body) return made;
        return editProposal(project, made.value.id, body);
      }, () => { toast.success(t('forgePublish.saved')); }),
      // A comment never saved has nothing to close on the daemon.
      discard: proposal ? () => run('discard', () => discardProposal(project, proposal.id), () => onClose()) : async () => { onClose(); return true; },
      close: onClose,
    };
  }, [project, proposal, loading, target, account, body, busy, error, run, ensure, onClose]);

  const occupant = useSlotEntries(PUBLISH_DIALOG_SLOT)[0];
  return (
    <PublishDialogContext.Provider value={value}>
      {occupant && !occupant.fallback ? <SlotSingle name={PUBLISH_DIALOG_SLOT} /> : <ProductPublishDialog />}
    </PublishDialogContext.Provider>
  );
}
