'use client';

/**
 * The long-lived claude token (`claude setup-token`), a section of the Claude
 * provider's page only: the client half of that provider registers it
 * (`plugins-client/provider-claude.tsx`), since the token is its own setting.
 * One row — whether a token is stored — and "Set" or "Replace" opening a
 * dialog that carries the field and the explanation. Write-only like the
 * vault: the daemon never sends the value back.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { TonePill } from '@/components/provider-page/provider-status-pill';
import type { StatusTone } from '@/lib/provider-overview';
import { t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';
import { apiErrorMessage } from '@/lib/api-error';
import { SecretValueDialog } from './secret-value-dialog';

const API = '/api/ui/backends/claude-token';

export type ClaudeTokenState = { configured: boolean; readable: boolean; serviceOutsideSession: boolean };

/** Which status line to show; exported for the test. */
export function claudeTokenStateKey(state: ClaudeTokenState): string {
  if (!state.configured) return 'backendsSettings.claudeToken.none';
  return state.readable ? 'backendsSettings.claudeToken.set' : 'backendsSettings.claudeToken.unreadable';
}

/** Its pastille: stored and readable is ready, unreadable is blocked, missing asks for action only where missions need it. */
export function claudeTokenTone(state: ClaudeTokenState): StatusTone {
  if (state.configured) return state.readable ? 'ready' : 'blocked';
  return state.serviceOutsideSession ? 'action' : 'off';
}

async function errorOf(res: Response): Promise<string> {
  if (res.status === 403 || res.status === 401) return t('backendsSettings.errors.forbidden');
  const body = await res.json().catch(() => null) as { error?: string } | null;
  return apiErrorMessage(body, { status: res.status });
}

/** Its one line: what blocks Claude missions first, then whether a token is stored. */
export function claudeTokenStatusKey(state: ClaudeTokenState): string {
  return state.serviceOutsideSession && !state.readable ? 'backendsSettings.claudeToken.required' : claudeTokenStateKey(state);
}

export function ClaudeTokenPanel(): ReactElement | null {
  const [state, setState] = useState<ClaudeTokenState | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(API, { cache: 'no-store' }).catch(() => null);
    if (res?.ok) setState(await res.json() as ClaudeTokenState);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function send(method: 'PUT' | 'DELETE', token?: string): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch(API, {
        method, cache: 'no-store',
        ...(method === 'PUT' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) } : {}),
      });
      if (!res.ok) throw new Error(await errorOf(res));
      setState(await res.json() as ClaudeTokenState);
      toast.success(t(method === 'PUT' ? 'backendsSettings.claudeToken.saved' : 'backendsSettings.claudeToken.cleared'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  // Not a superadmin, or an older daemon: nothing to offer.
  if (!state) return null;
  return (
    <ProviderSection title={t('providerPage.settings.title')}>
      <ProviderSettingRow
        data-claude-token={claudeTokenTone(state)}
        title={t('providerPage.claudeToken.title')}
        status={<TonePill tone={claudeTokenTone(state)} className="flex">{t(claudeTokenStatusKey(state))}</TonePill>}
        action={(
          <Button type="button" size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => setEditing(true)}>
            {t(state.configured ? 'providerPage.claudeToken.replace' : 'providerPage.claudeToken.set')}
          </Button>
        )}
        menu={state.configured ? (
          <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={busy}
            onSelect={() => { void send('DELETE').catch(() => {}); }}>
            {t('backendsSettings.claudeToken.clear')}
          </DropdownMenuItem>
        ) : null}
      />
      <SecretValueDialog
        open={editing}
        onOpenChange={setEditing}
        title={t('backendsSettings.claudeToken.title')}
        description={t('backendsSettings.claudeToken.hint', { settingsPath: settingsPath('system', 'installation') })}
        label={t('providerPage.claudeToken.field')}
        placeholder="sk-ant-oat01-…"
        submitLabel={t('backendsSettings.save')}
        onSubmit={(token) => send('PUT', token)}
      />
    </ProviderSection>
  );
}
