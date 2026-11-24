'use client';

/**
 * The product's "Publish on GitHub" dialog (`forge.publish.dialog`, host
 * `publish-dialog.tsx`): on the left the exact text that would leave, read
 * first and edited on demand; on the right where it goes, as which account,
 * what prepared it and how it is sent once only. One main action, "Publish";
 * "Edit" and "Do not publish" beside it. Nothing is sent before that click.
 *
 * A branch update has no text to read: the left side says which branch
 * GitHub updates and from which head. A conflict push shows the commit it
 * pushes to the contributor's branch above the comment that follows it.
 */

import { useState, type ReactElement, type ReactNode } from 'react';
import { ExternalLink, Loader2, Send } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  branchUpdateDetails, conflictPushDetails, isPending, PROPOSAL_BODY_LIMIT, publishRefusal, type ForgeProposal,
} from './forge-proposals-api';
import { safeHref } from './project-todo-links';
import { usePublishDialog } from './publish-dialog-context';

const ISLAND = 'rounded-lg bg-foreground/[0.035]';
const CHIP = 'inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[10.5px] font-medium';
const STATE_TONE = {
  pending: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  published: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  discarded: 'bg-foreground/[0.06] text-muted-foreground',
  publishing: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
} as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

const shortSha = (sha: string) => sha.slice(0, 12);

/** What a branch update or a conflict push writes besides a comment. */
function WriteDetails({ proposal }: { proposal: ForgeProposal }) {
  const update = branchUpdateDetails(proposal);
  if (update) {
    const branch = update.head_repository ? `${update.head_repository}:${update.head_ref}` : update.head_ref;
    return (
      <dl data-publish-update="" className="flex flex-col gap-2 rounded-md bg-background/60 px-3 py-2.5">
        <Row label={t('forgePublish.update.branch')}><span title={branch}>{branch}</span></Row>
        <Row label={t('forgePublish.update.merges')}>{t('forgePublish.update.mergesValue', { base: update.base_ref })}</Row>
        <Row label={t('forgePublish.update.head')}><span className="tabular-nums" title={update.expected_head_sha}>{shortSha(update.expected_head_sha)}</span></Row>
        <Row label={t('forgePublish.update.runs')}>{t('forgePublish.update.runsValue')}</Row>
      </dl>
    );
  }
  const push = conflictPushDetails(proposal);
  if (!push) return null;
  const branch = `${push.head_repository}:${push.head_ref}`;
  return (
    <dl data-publish-push="" className="flex flex-col gap-2 rounded-md bg-background/60 px-3 py-2.5">
      <Row label={t('forgePublish.push.branch')}><span title={branch}>{branch}</span></Row>
      {push.push_host && push.push_repository && (
        <Row label={t('forgePublish.push.to')}>
          <span data-publish-push-to="" title={push.push_url ?? undefined}>{t('forgePublish.push.toValue', { host: push.push_host, repository: push.push_repository })}</span>
        </Row>
      )}
      <Row label={t('forgePublish.push.commit')}><span className="tabular-nums" title={push.commit_sha}>{shortSha(push.commit_sha)}</span></Row>
      <Row label={t('forgePublish.push.files')}>
        <span title={push.files.join('\n')}>{t('forgePublish.push.filesValue', { count: push.files.length, base: push.base_ref })}</span>
      </Row>
      <Row label={t('forgePublish.push.head')}><span className="tabular-nums" title={push.expected_head_sha}>{shortSha(push.expected_head_sha)}</span></Row>
    </dl>
  );
}

export function ProductPublishDialog(): ReactElement | null {
  const host = usePublishDialog();
  const [editing, setEditing] = useState(false);
  if (!host) return null;
  const { proposal, target, repo, account, body, problem, busy, error, loading, editable } = host;
  const fresh = proposal === null;
  const open = fresh || isPending(proposal);
  const writing = open && editable && (fresh || editing);
  const kind = proposal?.kind ?? 'comment';
  const hasComment = kind !== 'update_branch';
  const state: keyof typeof STATE_TONE = open || proposal.state === 'draft' || proposal.state === 'failed' ? 'pending' : proposal.state;
  const where = t(target.type === 'pull' ? 'forgePublish.onPull' : 'forgePublish.onIssue', { number: target.number });
  const href = safeHref(target.url);
  const canPublish = open && !loading && !problem && account !== null && busy === null;
  const trigger = !proposal ? t('forgePublish.trigger.person')
    : proposal.trigger === 'plugin' ? t('forgePublish.trigger.plugin', { plugin: proposal.plugin ?? '?' })
      : t(`forgePublish.trigger.${proposal.trigger}`);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) host.close(); }}>
      <DialogContent data-publish-dialog="" className="flex max-h-[85vh] max-w-[900px] flex-col gap-3 overflow-hidden">
        <DialogTitle className="flex min-w-0 items-center gap-2 text-sm">
          <Send className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{t('forgePublish.title')}</span>
          <span data-publish-state={state} className={cn(CHIP, STATE_TONE[state])}>{t(`forgePublish.state.${state}`)}</span>
        </DialogTitle>
        <DialogDescription className="sr-only">{t('forgePublish.description')}</DialogDescription>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_19rem]">
          <section className={cn(ISLAND, 'flex min-h-0 min-w-0 flex-col gap-2 p-3')} aria-label={where}>
            {kind !== 'comment' && proposal && (
              <>
                <h3 className="text-[11.5px] font-medium text-muted-foreground">{t(`forgePublish.heading.${kind}`, { where })}</h3>
                <WriteDetails proposal={proposal} />
              </>
            )}
            {hasComment && <h3 className="text-[11.5px] font-medium text-muted-foreground">{t('forgePublish.commentOn', { where })}</h3>}
            {!hasComment ? null : loading ? (
              <p className="text-xs text-muted-foreground">{t('landings.loading')}</p>
            ) : writing ? (
              <>
                <Textarea
                  data-publish-body=""
                  value={body}
                  onChange={(e) => host.setBody(e.target.value)}
                  rows={8}
                  autoFocus
                  aria-label={t('forgePublish.commentOn', { where })}
                  className="scrollbar-thin min-h-32 resize-y text-[12.5px] leading-relaxed"
                />
                <p className={cn('text-right text-[11px] tabular-nums', problem === 'tooLong' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
                  {body.length} / {PROPOSAL_BODY_LIMIT}
                </p>
              </>
            ) : (
              <div data-publish-text="" className="scrollbar-thin max-h-[45vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-background/60 px-3 py-2 text-[12.5px] leading-relaxed">
                {body}
              </div>
            )}
            {proposal && proposal.trigger !== 'person' && open && (
              <p className="text-[11px] text-muted-foreground">
                {t(proposal.trigger === 'plugin' ? 'forgePublish.preparedByPlugin' : 'forgePublish.preparedHint')}
              </p>
            )}
            {problem && problem !== 'empty' && writing && (
              <p className="text-[11.5px] text-red-600 dark:text-red-400">{t(`forgePublish.problem.${problem}`)}</p>
            )}
            {proposal?.state === 'failed' && proposal.error && !error && (
              <p data-publish-last-error="" className="text-[11.5px] text-red-600 dark:text-red-400">
                {publishRefusal(proposal.error.code) ?? t('forgePublish.lastError', { reason: proposal.error.reason ?? proposal.error.code })}
              </p>
            )}
            {error && <p data-publish-error="" className="text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}
          </section>

          <section className={cn(ISLAND, 'flex min-w-0 flex-col gap-2 p-3')} aria-label={t('forgePublish.whatLeaves')}>
            <h3 className="text-[11.5px] font-medium text-muted-foreground">{t('forgePublish.whatLeaves')}</h3>
            <dl className="flex flex-col gap-2">
              <Row label={t('forgePublish.where')}>
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline" title={`${repo ?? ''} · ${where}`}>
                    {repo ? `${repo} · ${where}` : where}
                  </a>
                ) : (repo ? `${repo} · ${where}` : where)}
              </Row>
              <Row label={t('forgePublish.account')}>
                {proposal?.account ?? account ?? (
                  <span data-publish-no-account="" className="text-red-600 dark:text-red-400">{loading ? '…' : t('forgePublish.noAccount')}</span>
                )}
              </Row>
              <Row label={t('forgePublish.triggeredBy')}>{trigger}</Row>
              <Row label={t('forgePublish.once')}>
                <span title={proposal?.key}>{t('forgePublish.onceValue')}</span>
              </Row>
            </dl>
          </section>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {proposal?.state === 'published' && proposal.url && (
            <a href={proposal.url} target="_blank" rel="noopener noreferrer" className="mr-auto inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline">
              <ExternalLink className="size-3.5" aria-hidden />{t('forgePublish.openComment')}
            </a>
          )}
          {open ? (
            <>
              {fresh ? (
                <>
                  <Button variant="secondary" size="sm" data-publish-cancel="" onClick={host.close} disabled={busy !== null}>{t('forgePublish.cancel')}</Button>
                  <Button variant="secondary" size="sm" data-publish-save="" onClick={() => void host.save()} disabled={busy !== null || !!problem}>
                    {busy === 'save' ? t('forgePublish.saving') : t('forgePublish.keep')}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="secondary" size="sm" data-publish-discard="" onClick={() => void host.discard()} disabled={busy !== null}>
                    {busy === 'discard' ? t('forgePublish.discarding') : t(`forgePublish.discardKind.${kind}`)}
                  </Button>
                  {!editable ? null : editing ? (
                    <Button variant="secondary" size="sm" data-publish-save="" onClick={() => { void host.save().then((ok) => { if (ok) setEditing(false); }); }} disabled={busy !== null || !!problem}>
                      {busy === 'save' ? t('forgePublish.saving') : t('forgePublish.save')}
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" data-publish-edit="" onClick={() => setEditing(true)} disabled={busy !== null || loading}>{t('forgePublish.edit')}</Button>
                  )}
                </>
              )}
              {/* The window's one main action, filled: what leaves GitHub's way. */}
              <Button
                size="sm"
                data-publish-send=""
                onClick={() => void host.publish()}
                disabled={!canPublish}
                title={account === null && !loading ? t('forgePublish.noAccount') : undefined}
              >
                {busy === 'publish' ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
                {busy === 'publish' ? t('forgePublish.publishing') : t(`forgePublish.publishKind.${kind}`)}
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={host.close}>{t('forgePublish.close')}</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
