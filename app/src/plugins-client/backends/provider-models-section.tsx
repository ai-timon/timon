'use client';

/**
 * The Models section of a provider page (`settings.provider.section`, key
 * `models`): what the provider serves and which of those the model selectors
 * offer, read as a list — one row per model with its label, its slug and a
 * switch, saved at once. A model is edited (label, picture, context window
 * and, for a provider added by hand, how it thinks) in a dialog from its row's
 * menu; the whole list — reordering, several edits saved together — in an
 * explicit "Edit or reorder" mode that brings back the full editor.
 *
 * One block per backend of the provider, each with its own draft: a plugin
 * that brings several backends keeps their lists apart, as the selector does.
 */
import { useState, type ReactElement } from 'react';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { useProviderPage } from '@/components/provider-page/provider-page-context';
import type { ReasoningControl } from '@/lib/backends';
import { formatContextWindow, parseContextWindow } from '@/lib/context-window';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { contextWindowTextOf, modelsErrorKey, modelsPayload, type CustomBackend, type ModelDraft } from './form';
import { ModelEditor, modelMatches } from './model-editor';
import { PictoPanel } from './picto-panel';
import { patchBackend, useBackendDraft, useProviderBackends, type ProtocolOption } from './provider-backends';
import { ThinkingPanel } from './thinking-panel';
import { FIELD, LABEL } from './type-scale';

type ModelList = { models: ModelDraft[]; defaultModel: string | null };

/**
 * A model shown or hidden. The default follows what stays visible: a hidden
 * default hands its place to the first model still offered.
 */
export function withVisibility(list: ModelList, slug: string, hidden: boolean): ModelList {
  const models = list.models.map((model) => (model.slug === slug ? { ...model, hidden } : model));
  const kept = models.find((model) => model.slug === list.defaultModel && !model.hidden);
  return { models, defaultModel: kept?.slug ?? models.find((model) => !model.hidden)?.slug ?? null };
}

/** Every model shown, or every one hidden ("Hide all" leaves the selectors nothing of this provider). */
export function withAllVisibility(list: ModelList, hidden: boolean): ModelList {
  const models = list.models.map((model) => ({ ...model, hidden }));
  return { models, defaultModel: hidden ? list.defaultModel : list.defaultModel ?? models[0]?.slug ?? null };
}

export function ProviderModelsSection(): ReactElement | null {
  const page = useProviderPage();
  const { backends, protocols, reload } = useProviderBackends(page?.provider.backends.map((backend) => backend.id) ?? []);
  const [query, setQuery] = useState('');
  if (!page || backends.length === 0) return null;

  const saved = async (): Promise<void> => {
    await reload();
    await page.refresh();
  };

  return (
    <ProviderSection title={t('providerPage.models.title')}>
      {backends.map((backend, index) => (
        <BackendModels key={backend.id} backend={backend} protocols={protocols} query={query} onQuery={setQuery}
          searchable={index === 0} titled={backends.length > 1} onSaved={saved} />
      ))}
    </ProviderSection>
  );
}

function BackendModels({ backend, protocols, query, onQuery, searchable, titled, onSaved }: {
  backend: CustomBackend;
  protocols: readonly ProtocolOption[];
  query: string;
  onQuery: (query: string) => void;
  /** The one search of the section sits under the first list's count. */
  searchable: boolean;
  /** Several backends on one page: each list says whose it is. */
  titled: boolean;
  onSaved: () => Promise<void>;
}): ReactElement {
  const { draft, patch, dirty, reset, settle } = useBackendDraft(backend, modelsPayload);
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState(false);
  /** The model whose dialog is open: its slug, or `''` for a new one. */
  const [editing, setEditing] = useState<string | null>(null);
  const shown = draft.models.filter((model) => !model.hidden).length;
  const total = draft.models.length;
  const handMade = !draft.origin || draft.origin === 'file';
  // Thinking is set by hand only on a provider the user added: a built-in one declares its own levels.
  const thinkingControls = handMade ? protocols.find((option) => option.protocol === draft.protocol)?.thinkingControls ?? ['levels'] : null;

  /** Writes a new list at once, shown before the daemon answers and put back if it refuses. */
  const commit = async (next: ModelList, success?: string): Promise<boolean> => {
    const problem = modelsErrorKey(next.models);
    if (problem) { toast.error(t(problem)); return false; }
    patch(next);
    setBusy(true);
    try {
      await patchBackend(backend.id, modelsPayload({ ...draft, ...next }));
      settle();
      if (success) toast.success(success);
      await onSaved();
      return true;
    } catch (err) {
      reset();
      toast.error(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveList = async (): Promise<void> => {
    if (await commit({ models: draft.models, defaultModel: draft.defaultModel }, t('providerPage.models.saved'))) setListing(false);
  };

  const list: ModelList = { models: draft.models, defaultModel: draft.defaultModel };
  const allShown = shown === total;
  const visible = draft.models.filter((model) => modelMatches(model, query));
  const editedModel = editing === null ? null : draft.models.find((model) => model.slug === editing) ?? { slug: '', label: '' };

  return (
    <div className="flex flex-col gap-0.5" data-provider-models={backend.id}>
      <ProviderSettingRow
        title={<span data-models-count>{t('providerPage.models.count', { shown, total })}</span>}
        status={titled ? backend.label : null}
        action={!listing && total > 0 ? (
          <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" disabled={busy}
            onClick={() => void commit(withAllVisibility(list, allShown))}>
            {t(allShown ? 'providerPage.models.hideAll' : 'providerPage.models.showAll')}
          </Button>
        ) : null}
        menuLabel={t('providerPage.models.more')}
        menu={listing ? null : <>
          <DropdownMenuItem onSelect={() => setEditing('')}>{t('backendsSettings.models.add')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setListing(true)}>{t('providerPage.models.editList')}</DropdownMenuItem>
        </>}
      />
      {searchable && total > 0 ? (
        <label className="relative mx-1 flex items-center">
          <Search aria-hidden className="pointer-events-none absolute left-3 size-3.5 text-muted-foreground" />
          <Input type="search" value={query} onChange={(event) => onQuery(event.target.value)}
            aria-label={t('providerPage.models.search')} placeholder={t('providerPage.models.search')}
            className="h-8 border-0 bg-background pl-8 text-[13px] md:text-[13px]" />
        </label>
      ) : null}

      {listing ? (
        <div className="space-y-3 px-3 py-2.5" data-models-editor>
          <ModelEditor
            label={null}
            models={draft.models}
            defaultModel={draft.defaultModel}
            savedSlugs={draft.savedSlugs}
            query={query}
            onChange={patch}
            thinkingControls={thinkingControls}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy || !dirty} onClick={() => void saveList()}>{t('backendsSettings.save')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { reset(); setListing(false); }}>{t('common.cancel')}</Button>
          </div>
        </div>
      ) : (
        <>
          {total === 0 ? <p className="m-0 px-3 py-2.5 text-xs text-muted-foreground">{t('providerPage.models.empty')}</p> : null}
          {total > 0 && visible.length === 0 ? <p className="m-0 px-3 py-2.5 text-xs text-muted-foreground">{t('backendsSettings.models.noMatch')}</p> : null}
          {visible.map((model) => (
            <ModelRow key={model.slug} model={model} isDefault={model.slug === draft.defaultModel} busy={busy}
              onVisible={(on) => void commit(withVisibility(list, model.slug, !on))}
              onDefault={() => void commit({ models: draft.models.map((entry) => (entry.slug === model.slug ? { ...entry, hidden: false } : entry)), defaultModel: model.slug })}
              onEdit={() => setEditing(model.slug)}
              onRemove={() => {
                const models = draft.models.filter((entry) => entry.slug !== model.slug);
                void commit({ models, defaultModel: draft.defaultModel === model.slug ? models.find((entry) => !entry.hidden)?.slug ?? null : draft.defaultModel });
              }}
            />
          ))}
        </>
      )}

      <Dialog open={editedModel !== null} onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto" data-model-dialog>
          {editedModel ? (
            <ModelForm
              model={editedModel}
              fresh={editing === ''}
              saved={draft.savedSlugs?.includes(editedModel.slug) ?? false}
              thinkingControls={thinkingControls}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={async (next) => {
                const models = editing === ''
                  ? [next, ...draft.models]
                  : draft.models.map((entry) => (entry.slug === editing ? next : entry));
                // A default is a slug: renaming the slug it points at carries it along.
                const defaultModel = editing !== '' && draft.defaultModel === editing ? next.slug : draft.defaultModel ?? next.slug;
                if (await commit({ models, defaultModel }, t('providerPage.models.saved'))) setEditing(null);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ModelRow({ model, isDefault, busy, onVisible, onDefault, onEdit, onRemove }: {
  model: ModelDraft;
  isDefault: boolean;
  busy: boolean;
  onVisible: (on: boolean) => void;
  onDefault: () => void;
  onEdit: () => void;
  onRemove: () => void;
}): ReactElement {
  const name = model.label || model.slug;
  return (
    <ProviderSettingRow
      data-model-row={model.slug}
      className={cn(model.hidden && 'text-muted-foreground')}
      leading={model.icon || model.brand ? <BrandMark icon={model.icon} brand={model.brand} className="size-4" /> : null}
      title={<>
        <span className="truncate">{name}</span>
        {/* code-font: a model id, as the CLI is given it */}
        <code className="truncate font-mono text-xs font-normal text-muted-foreground">{model.slug}</code>
        {isDefault ? <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-[11px] font-normal text-muted-foreground">{t('providerPage.models.default')}</span> : null}
      </>}
      action={(
        <Switch checked={!model.hidden} disabled={busy}
          aria-label={t(model.hidden ? 'backendsSettings.models.show' : 'backendsSettings.models.hide')}
          onCheckedChange={(on) => onVisible(on)} />
      )}
      menuLabel={t('providerPage.models.modelMore', { name })}
      menu={<>
        {isDefault ? null : <DropdownMenuItem disabled={busy} onSelect={onDefault}>{t('providerPage.models.setDefault')}</DropdownMenuItem>}
        <DropdownMenuItem onSelect={onEdit}>{t('providerPage.models.edit')}</DropdownMenuItem>
        <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={busy} onSelect={onRemove}>{t('backendsSettings.models.remove')}</DropdownMenuItem>
      </>}
    />
  );
}

/** One model, in its dialog: what the list editor offers for a row, laid out as a form. */
function ModelForm({ model, fresh, saved, thinkingControls, busy, onCancel, onSave }: {
  model: ModelDraft;
  fresh: boolean;
  saved: boolean;
  thinkingControls: readonly ReasoningControl['type'][] | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (next: ModelDraft) => Promise<void>;
}): ReactElement {
  const [draft, setDraft] = useState<ModelDraft>(model);
  const edit = (next: Partial<ModelDraft>): void => setDraft((current) => ({ ...current, ...next }));
  const contextText = contextWindowTextOf(draft);
  const contextInvalid = parseContextWindow(contextText) === undefined;
  return (
    // min-w-0: the dialog is a grid, whose column grows to its items' min-content width otherwise.
    <form className="min-w-0 space-y-5" onSubmit={(event) => { event.preventDefault(); if (draft.slug.trim()) void onSave({ ...draft, slug: draft.slug.trim() }); }}>
      <DialogHeader>
        <DialogTitle className="text-base">{fresh ? t('backendsSettings.models.add') : t('providerPage.models.editTitle', { name: model.label || model.slug })}</DialogTitle>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label className={LABEL} htmlFor="model-slug">{t('backendsSettings.models.columnSlug')}</Label>
        {/* code-font: a model id sent to the CLI */}
        <Input id="model-slug" className={cn(FIELD, 'font-mono')} value={draft.slug} autoComplete="off" spellCheck={false} required
          placeholder={t('backendsSettings.models.slugPlaceholder')} onChange={(event) => edit({ slug: event.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label className={LABEL} htmlFor="model-label">{t('backendsSettings.models.columnLabel')}</Label>
        <Input id="model-label" className={FIELD} value={draft.label} autoComplete="off"
          placeholder={t('backendsSettings.models.labelPlaceholder')} onChange={(event) => edit({ label: event.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label className={LABEL} htmlFor="model-context">{t('backendsSettings.models.contextWindow')}</Label>
        <Input id="model-context" className={cn(FIELD, 'tabular-nums aria-[invalid=true]:border-destructive')} value={contextText}
          autoComplete="off" spellCheck={false} aria-invalid={contextInvalid}
          placeholder={draft.detectedContextWindow
            ? t('backendsSettings.models.contextWindowDetected', { window: formatContextWindow(draft.detectedContextWindow) })
            : t('backendsSettings.models.contextWindowAuto')}
          onChange={(event) => edit({ contextWindowText: event.target.value })} />
        <p className="m-0 text-xs text-muted-foreground">{t('backendsSettings.models.contextWindowHint')}</p>
      </div>
      <div className="space-y-1.5">
        <span className={cn(LABEL, 'block')}>{t('backendsSettings.fields.picto')}</span>
        <PictoPanel value={{ icon: draft.icon ?? null, brand: draft.brand ?? null }}
          onChange={(picto) => edit({ icon: picto.icon ?? undefined, brand: picto.brand ?? undefined })} />
      </div>
      {thinkingControls ? (
        <ThinkingPanel model={draft} saved={saved} controls={thinkingControls} onChange={setDraft} />
      ) : null}
      <DialogFooter className="gap-2 sm:gap-0">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="submit" size="sm" disabled={busy || !draft.slug.trim() || contextInvalid}>{t('backendsSettings.save')}</Button>
      </DialogFooter>
    </form>
  );
}
