'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Shield, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t as i18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** What the daemon says about the mission's level (`GET …/permission-mode`). */
export type PermissionModeState = {
  mode: string;
  switchable: boolean;
  /** What this account may pick, lowest first. */
  choices: string[];
};

/** Levels the menu knows how to name. Anything else is shown by its raw name:
 *  a mode set by an administrator must stay legible, not vanish. */
const KNOWN = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk'] as const;

export function permissionModeLabel(mode: string): string {
  return (KNOWN as readonly string[]).includes(mode) ? i18n(`chatPage.permMode.label.${mode}`) : mode;
}

function permissionModeHint(mode: string): string | null {
  return (KNOWN as readonly string[]).includes(mode) ? i18n(`chatPage.permMode.hint.${mode}`) : null;
}

export function parsePermissionModeState(raw: unknown): PermissionModeState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.mode !== 'string' || typeof o.switchable !== 'boolean' || !Array.isArray(o.choices)) return null;
  return { mode: o.mode, switchable: o.switchable, choices: o.choices.filter((c): c is string => typeof c === 'string') };
}

/**
 * Whether there is anything to choose: a backend that cannot change its level
 * mid-mission, or an account allowed a single level, gets no menu rather than
 * one whose entries do nothing.
 */
export function selectorVisible(state: PermissionModeState | null): state is PermissionModeState {
  return !!state && state.switchable && state.choices.length > 1;
}

/**
 * The mission's permission mode, next to the reasoning level in the composer
 * bar (TODO #430). A change applies from the next message: the daemon stores
 * it, and a claude session is relaunched on its own conversation before that
 * message. Leaving the guarded modes for `bypassPermissions` asks first — it
 * takes away the Allow/Deny cards and the classifier for the rest of the
 * mission — in the product's own dialog: the browser's `confirm()` freezes
 * the page, names the site rather than Timon, and a browser that was told to
 * stop showing dialogs answers it "no" without asking anyone.
 */
export function PermissionModeMenu({
  missionId,
  compact = false,
  className,
  refreshKey,
  fetchImpl = fetch,
}: {
  missionId: string;
  compact?: boolean;
  /** The trigger's shape, from the host: the composer paints it as a pill. */
  className?: string;
  /** Changes when the level may have moved under the menu (a turn ended, the
   *  backend changed): the level is read again. */
  refreshKey?: string;
  /** Injected by tests. */
  fetchImpl?: typeof fetch;
}) {
  const [state, setState] = useState<PermissionModeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [readTick, setReadTick] = useState(0);
  // Bumped by every change the menu sends: a read that left before it
  // answers with the old level and must not paint over the new one.
  const writes = useRef(0);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const url = `/api/ui/missions/${encodeURIComponent(missionId)}/permission-mode`;
  const reread = useCallback(() => setReadTick((n) => n + 1), []);

  // Another mission: its level is unknown until read, never the previous one's.
  useEffect(() => { setState(null); }, [url]);

  // The level is read again whenever it may have changed elsewhere: a save on
  // the agent's sheet relaunches the CLI in the new mode, an agent can set
  // its own, a backend switch changes the ladder. Read once, the menu kept
  // naming the level of the moment it mounted.
  useEffect(() => {
    let alive = true;
    const sentWrites = writes.current;
    void (async () => {
      try {
        const r = await fetchImpl(url, { cache: 'no-store' });
        if (!r.ok) return;
        const parsed = parsePermissionModeState(await r.json());
        if (alive && writes.current === sentWrites) setState(parsed);
      } catch {
        // No level to show is better than a wrong one: the menu stays hidden.
      }
    })();
    return () => { alive = false; };
  }, [url, fetchImpl, refreshKey, readTick]);

  // Coming back to the window after editing the agent elsewhere.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') reread(); };
    window.addEventListener('focus', reread);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', reread);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reread]);

  const apply = useCallback(async (mode: string) => {
    if (!state || busy || mode === state.mode) return;
    setBusy(true);
    writes.current += 1;
    try {
      const r = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const body = (await r.json().catch(() => ({}))) as { mode?: unknown; reason?: unknown; error?: unknown };
      if (!r.ok) {
        const why = typeof body.reason === 'string' ? body.reason : typeof body.error === 'string' ? body.error : '';
        throw new Error(why || i18n('chatPage.permMode.changeFailed'));
      }
      setState({ ...state, mode: typeof body.mode === 'string' ? body.mode : mode });
      toast.success(i18n('chatPage.permMode.changed', { mode: permissionModeLabel(mode) }));
    } catch (e) {
      toast.error((e as Error).message || i18n('chatPage.permMode.changeFailed'));
    } finally {
      setBusy(false);
    }
  }, [state, busy, url, fetchImpl]);

  const pick = useCallback((mode: string) => {
    if (mode === 'bypassPermissions' && state?.mode !== mode) setConfirming(true);
    else void apply(mode);
  }, [state, apply]);

  if (!selectorVisible(state)) return null;
  const bypass = state.mode === 'bypassPermissions';
  const Icon = bypass ? ShieldAlert : Shield;

  return (
    <>
    {/* Non-modal, like the gauge's menu: a modal one fights the focus with any
        dialog opened next to it (TIM-0035). */}
    <DropdownMenu modal={false} onOpenChange={(open) => { if (open) reread(); }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          data-testid="permission-mode-trigger"
          title={i18n('chatPage.permMode.title')}
          aria-label={i18n('chatPage.permMode.ariaLabel', { mode: permissionModeLabel(state.mode) })}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-muted/60 disabled:opacity-50',
            className,
            bypass ? 'text-destructive' : 'text-foreground',
          )}
        >
          <Icon aria-hidden className={cn('shrink-0', compact ? 'size-3' : 'size-3.5')} />
          <span className="truncate">{busy ? '…' : permissionModeLabel(state.mode)}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {i18n('chatPage.permMode.nextMessage')}
        </DropdownMenuLabel>
        {state.choices.map((mode) => {
          const hint = permissionModeHint(mode);
          return (
            <DropdownMenuItem
              key={mode}
              data-mode={mode}
              onSelect={() => pick(mode)}
              className="flex items-start gap-2 text-xs"
            >
              <Check aria-hidden className={cn('mt-0.5 size-3 shrink-0', mode === state.mode ? 'opacity-100' : 'opacity-0')} />
              <span className="flex min-w-0 flex-col">
                <span className={cn(mode === 'bypassPermissions' && 'text-destructive')}>{permissionModeLabel(mode)}</span>
                {hint && <span className="text-[10.5px] text-muted-foreground">{hint}</span>}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={confirming} onOpenChange={setConfirming}>
      <DialogContent
        role="alertdialog"
        hideClose
        data-testid="permission-mode-bypass-confirm"
        className="max-w-md"
        // Enter right after the menu must not take the guards away.
        onOpenAutoFocus={(e) => { e.preventDefault(); cancelButton.current?.focus(); }}
      >
        <DialogHeader>
          <DialogTitle>{i18n('chatPage.permMode.bypassTitle')}</DialogTitle>
          <DialogDescription>{i18n('chatPage.permMode.bypassConfirm')}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button ref={cancelButton} variant="outline" data-choice="cancel" onClick={() => setConfirming(false)}>
            {i18n('chatPage.permMode.bypassCancel')}
          </Button>
          <Button
            variant="destructive"
            data-choice="bypass"
            onClick={() => { setConfirming(false); void apply('bypassPermissions'); }}
          >
            {i18n('chatPage.permMode.bypassAccept')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
