'use client';

/**
 * The own-settings section of a provider page (`settings.provider.section`,
 * key `settings`), for a provider the user added by hand only: one row per
 * backend — its picture, its name in the selectors and the address it reaches
 * — with "Edit" opening a dialog that holds the name, the picture and, folded
 * under Advanced, the protocol, address and key. An official provider has
 * none of these to change: the section stays away from its page. A provider
 * plugin's own settings (the long-lived Claude token…) are its sections,
 * registered right after this one (`order` 400 to 500).
 *
 * The key is write-only, as everywhere: the daemon never sends it back, so the
 * field is empty and typing one replaces the stored key. What the daemon warns
 * about the backend's file (a credential written in clear text) shows under
 * its row, in permanence: it is something to fix.
 */
import { useId, useState, type ReactElement } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { useProviderPage } from '@/components/provider-page/provider-page-context';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  destinationHost, outcomeMessage, settingsErrorKey, settingsPayload, testPayload,
  type BackendForm, type CustomBackend, type TestOutcome,
} from './form';
import { PictoPanel } from './picto-panel';
import { backendErrorText, CUSTOM_API, patchBackend, useBackendDraft, useProviderBackends, type ProtocolOption } from './provider-backends';
import { FIELD, HINT, LABEL } from './type-scale';

type Verdict = ReturnType<typeof outcomeMessage>;

const TONE_CLASS: Readonly<Record<Verdict['tone'], string>> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
};

/** A backend whose settings are the user's: added by hand, or one whose file warns about something. */
export function hasOwnSettings(backend: Pick<CustomBackend, 'origin' | 'warnings'>): boolean {
  return (!backend.origin || backend.origin === 'file') || backend.warnings.length > 0;
}

export function ProviderSettingsSection(): ReactElement | null {
  const page = useProviderPage();
  const { backends, protocols, reload } = useProviderBackends(page?.provider.backends.map((backend) => backend.id) ?? []);
  const own = backends.filter(hasOwnSettings);
  if (!page || own.length === 0) return null;
  const saved = async (): Promise<void> => {
    await reload();
    await page.refresh();
  };
  return (
    <ProviderSection title={t('providerPage.settings.title')}>
      {own.map((backend) => (
        <BackendSettings key={backend.id} backend={backend} protocols={protocols} onSaved={saved} onRemoved={page.back} />
      ))}
    </ProviderSection>
  );
}

/** A provider added by hand whose file Timon wrote: its connection is the user's to change. */
function connectionOf(draft: Pick<BackendForm, 'origin' | 'connectionEditable'>): boolean {
  return (!draft.origin || draft.origin === 'file') && draft.connectionEditable !== false;
}

function BackendSettings({ backend, protocols, onSaved, onRemoved }: {
  backend: CustomBackend;
  protocols: readonly ProtocolOption[];
  onSaved: () => Promise<void>;
  onRemoved: () => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const handMade = !backend.origin || backend.origin === 'file';
  const host = handMade && backend.protocol && backend.baseUrl ? destinationHost(backend.baseUrl) : null;

  const remove = async (): Promise<void> => {
    const name = backend.label || backend.id;
    if (!(await confirmAction({ title: t('backendsSettings.confirmRemove', { name }), confirmLabel: t('confirmDialog.remove'), destructive: true }))) return;
    setBusy(true);
    try {
      const res = await fetch(`${CUSTOM_API}/${encodeURIComponent(backend.id)}`, { method: 'DELETE', cache: 'no-store' });
      if (!res.ok) throw new Error(await backendErrorText(res));
      onRemoved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <>
      <ProviderSettingRow
        data-provider-settings={backend.id}
        leading={(
          <span className="flex size-8 items-center justify-center rounded-lg bg-background">
            <BrandMark icon={backend.icon ?? undefined} brand={backend.brand ?? undefined} className="size-4" />
          </span>
        )}
        title={<span className="truncate">{backend.label}</span>}
        status={<span className="block truncate">{host ? t('providerPage.settings.reaches', { host }) : t('providerPage.settings.shownAs')}</span>}
        action={handMade ? (
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" disabled={busy} onClick={() => setEditing(true)}>
            <Pencil aria-hidden className="size-3.5" />
            {t('providerPage.settings.edit')}
          </Button>
        ) : null}
        menu={handMade ? (
          <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={busy} onSelect={() => void remove()}>
            {t('providerPage.settings.remove')}
          </DropdownMenuItem>
        ) : null}
      >
        {backend.warnings.length > 0 ? backend.warnings.map((warning) => (
          <p key={warning} className="m-0 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400" data-backend-warning>
            <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>{warning}</span>
          </p>
        )) : null}
      </ProviderSettingRow>
      {handMade ? (
        <Dialog open={editing} onOpenChange={setEditing}>
          <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto" data-provider-settings-dialog={backend.id}>
            {editing ? <SettingsForm backend={backend} protocols={protocols} onSaved={onSaved} onClose={() => setEditing(false)} /> : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function SettingsForm({ backend, protocols, onSaved, onClose }: {
  backend: CustomBackend;
  protocols: readonly ProtocolOption[];
  onSaved: () => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const { draft, patch, dirty, settle } = useBackendDraft(backend, settingsPayload);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const id = useId();
  const connection = connectionOf(draft);
  const host = connection ? destinationHost(draft.baseUrl) : null;

  const edit = (next: Partial<BackendForm>): void => {
    setVerdict(null);
    patch(next);
  };

  const save = async (): Promise<void> => {
    const problem = settingsErrorKey(draft);
    if (problem) { toast.error(t(problem)); return; }
    setBusy(true);
    try {
      await patchBackend(backend.id, settingsPayload(draft));
      settle();
      toast.success(t('providerPage.settings.saved'));
      await onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Unchanged connection: the daemon tests the saved address with the stored key, which this screen never holds.
  const test = async (): Promise<void> => {
    const problem = settingsErrorKey(draft);
    if (problem) { toast.error(t(problem)); return; }
    const unchanged = !draft.key.trim() && draft.baseUrl.trim() === (backend.baseUrl ?? '') && draft.protocol === backend.protocol;
    setBusy(true);
    try {
      const res = await fetch(`${CUSTOM_API}/test`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify(unchanged ? { id: backend.id } : testPayload(draft)),
      });
      if (!res.ok) throw new Error(await backendErrorText(res));
      setVerdict(outcomeMessage(await res.json() as TestOutcome));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    // min-w-0: the dialog is a grid, whose column grows to its items' min-content width otherwise.
    <div className="min-w-0 space-y-5">
      <DialogHeader>
        <DialogTitle className="text-base">{t('providerPage.settings.editTitle', { name: backend.label })}</DialogTitle>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label className={LABEL} htmlFor={`${id}-name`}>{t('providerPage.settings.name')}</Label>
        <Input className={FIELD} id={`${id}-name`} value={draft.name} autoComplete="off"
          onChange={(event) => edit({ name: event.target.value })} />
      </div>
      <div className="space-y-1.5">
        <span className={cn(LABEL, 'block')}>{t('backendsSettings.fields.picto')}</span>
        <PictoPanel value={{ icon: draft.icon, brand: draft.brand }} onChange={(picto) => edit(picto)} />
      </div>

      {connection ? (
        <div className="space-y-3">
          <button type="button" aria-expanded={advanced} aria-controls={`${id}-advanced`} onClick={() => setAdvanced(!advanced)}
            className="-ml-1 flex items-center gap-1 rounded px-1 text-[13px] font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
            <ChevronRight aria-hidden className={cn('size-3.5 transition-transform', advanced && 'rotate-90')} />
            {t('providerPage.settings.advanced')}
          </button>
          {advanced ? (
            <div id={`${id}-advanced`} className="space-y-4 rounded-md bg-muted p-3">
              <p className={cn(HINT, 'm-0')}>{t('providerPage.settings.advancedHint')}</p>
              <fieldset className="space-y-1.5">
                <legend className={LABEL}>{t('backendsSettings.fields.protocol')}</legend>
                <div className="flex flex-wrap gap-4 pt-1.5">
                  {(['anthropic', 'openai-responses'] as const).map((protocol) => {
                    const installed = protocols.find((option) => option.protocol === protocol)?.installed ?? true;
                    return (
                      <label key={protocol} className={cn('flex items-center gap-2 text-[13px]', !installed && 'opacity-50')}>
                        <input type="radio" name={`${id}-protocol`} className="accent-primary" checked={draft.protocol === protocol}
                          onChange={() => (installed ? edit({ protocol }) : toast.error(t('backendsSettings.errors.protocolUnavailable')))} />
                        {t(`backendsSettings.protocols.${protocol}`)}
                      </label>
                    );
                  })}
                </div>
                <p className={HINT}>{t(`backendsSettings.protocolHints.${draft.protocol}`)}</p>
              </fieldset>
              <div className="space-y-1.5">
                <Label className={LABEL} htmlFor={`${id}-url`}>{t('backendsSettings.fields.baseUrl')}</Label>
                <Input className={FIELD} id={`${id}-url`} type="url" inputMode="url" autoComplete="off" value={draft.baseUrl}
                  onChange={(event) => edit({ baseUrl: event.target.value })} />
                {host ? <p className={HINT}>{t('backendsSettings.destinationNotice', { host })}</p> : null}
              </div>
              <div className="space-y-1.5">
                <Label className={LABEL} htmlFor={`${id}-key`}>{t('backendsSettings.fields.key')}</Label>
                <Input className={FIELD} id={`${id}-key`} type="password" autoComplete="off" value={draft.key}
                  onChange={(event) => edit({ key: event.target.value })} />
                <p className={HINT}>{t('backendsSettings.keyHintEdit')}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void test()}>
                  {verdict?.tone === 'ok' ? <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" aria-hidden /> : null}
                  {t('backendsSettings.testButton')}
                </Button>
                {verdict ? <span role="status" className={cn('text-xs', TONE_CLASS[verdict.tone])}>{t(verdict.key, verdict.vars)}</span> : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <DialogFooter className="gap-2 sm:gap-0">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
        <Button type="button" size="sm" disabled={busy || !dirty} onClick={() => void save()}>{t('backendsSettings.save')}</Button>
      </DialogFooter>
    </div>
  );
}
