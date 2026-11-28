'use client';

/**
 * A command an agent asks the user to decide (`terminal_propose`), as a card
 * in the mission's conversation — the popup terminal no longer shows it, so a
 * request never lands in the shell of a project the user is not looking at.
 *
 * Its buttons are the daemon's `choices`: Allow (the daemon runs the command
 * and the card shows its exit code and output), Paste into a terminal, Dismiss. Pasting records the decision, then
 * types the command without Enter in the terminal of the request's own
 * project. The final state comes back with `command_request_resolved`, a
 * persisted event: a reload shows the card as it was left.
 */

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Check, ClipboardPaste, Copy, Play, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  commandScope,
  fetchCommandRequests,
  freshest,
  pasteIntoTerminal,
  resolveCommandRequest,
  type CommandDecision,
  type CommandRequestView,
  type ResolveOutcome,
} from '@/lib/command-requests';
import { copyToClipboard } from '@/lib/clipboard';
import { t } from '@/lib/i18n';
import type { TerminalOpenRequest } from '@/lib/terminal-web';
import { cn } from '@/lib/utils';

type Settled = Pick<CommandRequestView, 'status' | 'run' | 'running'>;

function runState(r: Settled): 'running' | 'ok' | 'failed' | 'timeout' | 'not_run' | 'none' {
  if (r.status !== 'allow') return 'none';
  if (r.running || !r.run) return 'running';
  if (r.run.notRun) return 'not_run';
  if (r.run.timedOut) return 'timeout';
  return r.run.exitCode === 0 ? 'ok' : 'failed';
}

function runFailed(r: Settled): boolean {
  const state = runState(r);
  return state === 'failed' || state === 'timeout' || state === 'not_run';
}

function stateLabel(r: Settled): string {
  const state = runState(r);
  if (state === 'none') return t(`terminal.request.state.${r.status}`);
  if (state === 'running') return t('terminal.request.state.running');
  if (state === 'not_run') return t('terminal.request.state.notRun');
  const seconds = ((r.run?.durationMs ?? 0) / 1000).toFixed(1);
  if (state === 'timeout') return t('terminal.request.state.timedOut', { seconds });
  return t('terminal.request.state.ran', { code: r.run?.exitCode ?? 0, seconds });
}

const ICONS: Record<CommandDecision, typeof Check> = { allow: Play, paste: ClipboardPaste, deny: X };

export function CommandRequestCard({
  request,
  time,
  avatar,
  highlighted = false,
  openTerminal,
}: {
  request: CommandRequestView;
  time: string;
  /** The agent's avatar, drawn like the bubbles around the card. */
  avatar?: ReactNode;
  /** True for a moment after a notification led here. */
  highlighted?: boolean;
  /** Test seam; the floating terminal's `openTerminalWindow` otherwise. */
  openTerminal?: (request: TerminalOpenRequest) => boolean;
}): ReactElement {
  // What the daemon said since the event was replayed: a decision taken here,
  // or buttons narrowed since (Allow is offered only while an agent can run it).
  const [fresh, setFresh] = useState<CommandRequestView | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = freshest(request, fresh);
  const pending = shown.status === 'pending';

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await fetchCommandRequests(request.missionId, signal);
      const mine = list.find((r) => r.id === request.id);
      if (mine) setFresh(mine);
    } catch { /* the replayed copy stays */ }
  }, [request.id, request.missionId]);

  useEffect(() => {
    if (request.status !== 'pending') return;
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [request.status, reload]);

  const settle = useCallback((outcome: ResolveOutcome, decision: CommandDecision): boolean => {
    if (outcome.ok) {
      setFresh(outcome.request ?? { ...shown, status: decision, resolvedAt: Date.now(), running: decision === 'allow' });
      return true;
    }
    toast.error(t(`terminal.request.errors.${outcome.error}`));
    if (outcome.error === 'already_decided' || outcome.error === 'not_offered') void reload();
    return false;
  }, [shown, reload]);

  const decide = useCallback(async (decision: CommandDecision) => {
    if (busy || !pending) return;
    setBusy(true);
    try {
      if (decision !== 'paste') {
        settle(await resolveCommandRequest(shown.id, decision), decision);
        return;
      }
      const scope = commandScope(shown);
      const outcome = await pasteIntoTerminal({
        resolve: async () => settle(await resolveCommandRequest(shown.id, 'paste'), 'paste'),
        scope,
        command: shown.command,
        sessionId: shown.sessionId,
        open: openTerminal,
      });
      if (outcome.kind === 'window_refused') {
        // Already recorded: the user still has the command, from the clipboard or the card.
        const label = scope ? (scope.kind === 'project' ? scope.slug : scope.name) : t('terminal.scopes.none');
        const copied = await copyToClipboard(shown.command);
        toast.warning(t(copied ? 'terminal.request.windowRefused' : 'terminal.request.windowRefusedNoClipboard', { scope: label }));
      }
    } finally {
      setBusy(false);
    }
  }, [busy, pending, shown, settle, openTerminal]);

  const copy = useCallback(async () => {
    if (await copyToClipboard(shown.command)) toast.success(t('terminal.request.copied'));
    else toast.error(t('terminal.clipboard.copyFailed'));
  }, [shown.command]);

  return (
    <div
      // Same columns as the bubbles above and below, avatar gutter included.
      className="grid grid-cols-1 items-start gap-3 scroll-mt-24 sm:grid-cols-[34px_minmax(0,1fr)_34px]"
      // The deep-link of a notification looks for this attribute, as for a permission card.
      data-perm-id={shown.id}
      data-command-request={shown.status}
    >
      {avatar ?? <span aria-hidden />}
      <div className="flex w-full min-w-0 max-w-full flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground/70 [overflow-wrap:anywhere]">
          <span className="text-[11.5px] font-medium text-foreground">{shown.agent}</span>
          <span className="rounded bg-[hsl(var(--warning)/0.1)] px-1.5 py-0.5 text-[10px] lowercase text-[hsl(var(--warning))]">
            {t('terminal.request.badge')}
          </span>
          <span className="text-[10.5px] tabular-nums text-muted-foreground/60">{time}</span>
        </div>
        <div
          className={cn(
            'flex flex-col gap-2 rounded-xl rounded-tl-sm border bg-card px-3.5 py-3 text-[13px] shadow-elev-1 transition-[border-color,box-shadow] duration-200 dark:bg-surface-2',
            pending
              ? 'border-[hsl(var(--warning)/0.5)]'
              : shown.status === 'deny'
                ? 'border-border'
                : 'border-[hsl(var(--success)/0.5)]',
            highlighted && 'ring-2 ring-[hsl(var(--warning))] shadow-[0_0_28px_hsl(var(--warning)/0.55)]',
          )}
        >
          <div className="font-medium">
            {shown.project
              ? t('terminal.request.titleFrom', { agent: shown.agent, project: shown.project })
              : t('terminal.request.title', { agent: shown.agent })}
          </div>
          {shown.note && <p className="text-[12.5px] text-muted-foreground">{shown.note}</p>}
          <div className="flex min-w-0 items-start gap-1.5">
            {/* code-font: the shell command, shown exactly as it will be typed. */}
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-[12px]">{shown.command}</pre>
            <button
              type="button"
              onClick={() => void copy()}
              title={t('terminal.request.copy')}
              aria-label={t('terminal.request.copy')}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Copy className="size-3.5" />
            </button>
          </div>
          {pending ? (
            <div className="flex flex-wrap items-center gap-2">
              {shown.choices.map((decision) => {
                const Icon = ICONS[decision];
                return (
                  <Button
                    key={decision}
                    size="sm"
                    variant={decision === 'deny' ? 'outline' : decision === 'paste' && shown.choices.includes('allow') ? 'outline' : 'default'}
                    disabled={busy}
                    onClick={() => void decide(decision)}
                    data-decision={decision}
                    className={cn(
                      'h-7 gap-1.5',
                      decision === 'deny' && 'text-muted-foreground',
                    )}
                  >
                    <Icon className="size-3" />
                    {t(`terminal.request.${decision}`)}
                  </Button>
                );
              })}
              {shown.choices.includes('paste') && (
                <span className="text-[11px] text-muted-foreground">{t('terminal.request.hint')}</span>
              )}
            </div>
          ) : (
            <>
              <span
                className={cn(
                  'flex w-fit items-center gap-1 rounded px-2 py-0.5 text-[11px]',
                  shown.status === 'deny'
                    ? 'bg-muted text-muted-foreground'
                    : runFailed(shown)
                      ? 'bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))]'
                      : 'bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]',
                )}
                data-run-state={runState(shown)}
              >
                {shown.status === 'deny' ? <X className="size-3" /> : <Check className="size-3" />}
                {stateLabel(shown)}
              </span>
              {shown.run && shown.run.output.trim() && (
                <details className="min-w-0 text-[12px]">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('terminal.request.output')}</summary>
                  {/* code-font: the command's own output, shown as it was printed. */}
                  <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-[11.5px]">{shown.run.output}</pre>
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
