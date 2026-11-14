'use client';

/**
 * Named arrangements, in the appearance menu.
 *
 * Lives with the chrome of `@timon/ui-layout` — the product layout plugin's
 * browser half, which already mounts `theme-toggle.tsx` — because a preset is
 * a property of the layout system itself, next to "Edit layout" and "Focus
 * mode". No tile is added to the widget registry and no slot is bypassed
 * (`docs/LAYOUT-PRESETS.md`, CLAUDE.md rule 9).
 *
 * The section only exists once the workspace is resolved. Two keys, and they
 * are not the same one (11/09/2026, `docs/LAYOUT-PRESETS.md` §5): the list is
 * read from `sharedKey`, which ignores the project, so an arrangement saved in
 * one chat is offered in every other one; it is applied to `key`, the view the
 * user is looking at. The pathname is still in both, so a chat never lists a
 * cockpit's arrangements without anyone having to filter.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, LayoutGrid, Pencil, Plus, Save, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { t } from '@/lib/i18n';
import { useStoredLayout } from '@/hooks/use-stored-layout';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { usePresetCaptureHooks } from '@/components/islands/use-preset-capture-hooks';
import {
  captureView,
  commitPresets,
  forgetPresets,
  listProjectSlugs,
  recallEverywhere,
  recallView,
  viewKeysOfAllProjects,
} from '@/lib/layout-presets-io';
import {
  MAX_NAME_LENGTH,
  PRESETS_SUFFIX,
  addPreset,
  mergePresets,
  previousPresetsSource,
  readPresets,
  removePreset,
  renamePreset,
  replacePreset,
  type LayoutPreset,
  type PresetError,
  type PresetResult,
} from '@/lib/layout-presets';

type StoredUpdate = ReturnType<typeof useStoredLayout>['update'];

/**
 * Folds the presets stored under `source` into the shared list, once per
 * `mark`, then erases `source` so that a preset deleted afterwards does not
 * come back from it. `source` is `null` whenever there is nothing to fold.
 *
 * No `setError` on this path, ever: nobody asked for this write, and a red
 * banner over a gesture the user did not make explains nothing. The mark is
 * pinned before the write: a refused write rolls the list back, and without
 * it the fold would fire again on the very state it just failed to leave.
 */
function useFoldPresets(
  source: string | null,
  mark: string | null,
  folded: RefObject<Set<string>>,
  presets: readonly LayoutPreset[],
  update: StoredUpdate,
): void {
  const legacy = useStoredLayout(source);
  useEffect(() => {
    if (!source || !mark || !legacy.ready || folded.current.has(mark)) return;
    folded.current.add(mark);
    const found = readPresets(legacy.raw);
    if (found.length === 0) return;
    void (async () => {
      const out = await commitPresets(presets, (list) => mergePresets(list, found), (op) => update(op, true, { undoOnFailure: true }));
      if (out.ok) await forgetPresets(source);
    })();
  }, [source, mark, folded, legacy.ready, legacy.raw, presets, update]);
}

const ITEM = 'flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-xs outline-none focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50';
const ICON_BUTTON = 'rounded p-1 text-muted-foreground/70 outline-none transition-colors hover:text-primary focus-visible:text-primary disabled:pointer-events-none disabled:opacity-50';

export function LayoutPresetsSection() {
  const { key, sharedKey, previousSharedKey, owner, view } = useWorkspaceLayout();
  const { raw, update, ready } = useStoredLayout(sharedKey);
  const presets = useMemo(() => readPresets(raw), [raw]);
  // A chat's conversation and a terminal's shell stay out of a preset (§4 of
  // `docs/ISLAND-WORKSPACE.md`): a preset brings the agents back, not the day.
  const hooks = usePresetCaptureHooks();

  // Presets saved before the list left the project behind still sit under
  // `<key>.presets`, a row nothing reads any more. They are folded in the
  // first time the shared list is read empty — once per pair of scopes.
  const folded = useRef(new Set<string>());
  const pair = key && sharedKey ? `${sharedKey}|${key}` : null;
  const legacyScope = pair && ready && presets.length === 0 && !folded.current.has(pair)
    ? `${key}.${PRESETS_SUFFIX}`
    : null;
  useFoldPresets(legacyScope, pair, folded, presets, update);
  // On a remote machine, the list as it was hashed before the scopes followed
  // the acting account (TIM-0137).
  const previousScope = previousPresetsSource(sharedKey, previousSharedKey, ready, folded.current);
  useFoldPresets(previousScope, previousScope, folded, presets, update);

  // `null` = no form open, `''` = saving a new one, an id = renaming that one.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);
  // Id of the preset whose "apply to every project" awaits its confirmation:
  // the gesture rewrites the arrangement of every project's view, so one click
  // is not enough to trigger it.
  const [confirmAll, setConfirmAll] = useState<string | null>(null);
  // Stays on screen until the next attempt, where a toast would have faded
  // while the form it belongs to is still open. Recall is the exception: it is
  // the only action that closes the menu, so its failure has to be a toast.
  const [error, setError] = useState<PresetError | 'capture' | 'projects' | 'apply-all' | null>(null);

  const capture = useCallback(
    () => (key ? captureView(key, hooks) : Promise.resolve(null)),
    [key, hooks],
  );

  /**
   * Writes a change of the list and reports whether the daemon took it.
   *
   * The rollback is the point: `useStoredLayout.update` paints the new list
   * before the request leaves, so a refused write would otherwise leave the
   * menu showing a preset nobody stored — a success on screen next to an
   * error message. `undoOnFailure` takes the gesture back off the screen.
   *
   * `edit` is checked against the list on screen (the errors the form shows),
   * then applied again to the stored list when written: replayed over a
   * preset another window saved meanwhile (TODO #647), it keeps that one.
   */
  const apply = useCallback(async (edit: (list: readonly LayoutPreset[]) => PresetResult): Promise<boolean> => {
    const first = edit(presets);
    if (!first.ok) { setError(first.error); return false; }
    const out = await commitPresets(
      presets,
      (list) => { const next = edit(list); return next.ok ? next.presets : list; },
      (op) => update(op, true, { undoOnFailure: true }),
    );
    if (!out.ok) { setError(out.error); return false; }
    setError(null);
    return true;
  }, [presets, update]);

  const closeForm = useCallback(() => { setEditing(null); setDraft(''); }, []);

  const onSave = useCallback(async () => {
    setBusy(true);
    try {
      const scopes = await capture();
      if (!scopes) { setError('capture'); return; }
      if (await apply((list) => addPreset(list, draft, scopes))) closeForm();
    } finally { setBusy(false); }
  }, [apply, capture, closeForm, draft, presets]);

  const onOverwrite = useCallback(async (preset: LayoutPreset) => {
    setBusy(true);
    try {
      const scopes = await capture();
      if (!scopes) { setError('capture'); return; }
      if (await apply((list) => replacePreset(list, preset.id, scopes))) {
        toast.success(t('appearance.menu.presets.overwritten', { name: preset.name }));
      }
    } finally { setBusy(false); }
  }, [apply, capture, presets]);

  const onRecall = useCallback(async (preset: LayoutPreset) => {
    if (!key) return;
    setBusy(true);
    try {
      // The view as it stands, hooks or not: these rows are only compared, never stored.
      const current = await captureView(key);
      // Selecting a preset closes the dropdown: this section is unmounted by
      // the time the answer lands, so the failure has to survive outside it.
      // `cancelled`: a tab it would replace asked to stay (unsaved changes), and said so.
      const failed = !current
        ? 'appearance.menu.presets.error.capture'
        : (await recallView(key, preset, current, hooks)) === 'failed'
          ? 'appearance.menu.presets.error.recall'
          : null;
      if (failed) {
        toast.error(t(failed), { id: 'layout-presets', duration: Infinity, closeButton: true });
      }
    } finally { setBusy(false); }
  }, [hooks, key]);

  const onApplyAll = useCallback(async (preset: LayoutPreset) => {
    if (!owner) return;
    setBusy(true);
    setConfirmAll(null);
    try {
      const slugs = await listProjectSlugs();
      if (!slugs) { setError('projects'); return; }
      setError(null);
      const { applied, failed } = await recallEverywhere(await viewKeysOfAllProjects(owner, view, slugs), preset, hooks);
      if (failed > 0) setError('apply-all');
      else toast.success(t('appearance.menu.presets.appliedAll', { name: preset.name, count: applied }));
    } finally { setBusy(false); }
  }, [hooks, owner, view]);

  const onRename = useCallback(async (id: string) => {
    setBusy(true);
    try {
      if (await apply((list) => renamePreset(list, id, draft))) closeForm();
    } finally { setBusy(false); }
  }, [apply, closeForm, draft, presets]);

  const onDelete = useCallback(async (preset: LayoutPreset) => {
    setBusy(true);
    try {
      if (await apply((list) => ({ ok: true, presets: removePreset(list, preset.id), preset }))) {
        toast.success(t('appearance.menu.presets.deleted', { name: preset.name }));
      }
    } finally { setBusy(false); }
  }, [apply]);

  // No workspace yet (login, an unresolved route): there is no view to attach
  // a preset to, and painting the section would invite saving into nothing.
  if (!sharedKey || !key) return null;

  const form = (onConfirm: () => void) => (
    <div className="flex items-center gap-1 px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={draft}
        maxLength={MAX_NAME_LENGTH}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
          if (e.key === 'Escape') { e.preventDefault(); closeForm(); }
        }}
        placeholder={t('appearance.menu.presets.namePlaceholder')}
        aria-label={t('appearance.menu.presets.namePlaceholder')}
        className="min-w-0 flex-1 rounded border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-primary"
      />
      <button type="button" disabled={busy} onClick={onConfirm} aria-label={t('appearance.menu.presets.confirm')} title={t('appearance.menu.presets.confirm')} className={ICON_BUTTON}>
        <Check className="size-3.5" />
      </button>
      <button type="button" onClick={closeForm} aria-label={t('appearance.menu.presets.cancel')} title={t('appearance.menu.presets.cancel')} className={ICON_BUTTON}>
        <X className="size-3.5" />
      </button>
    </div>
  );

  return <>
    <div className="mt-2 flex items-center gap-2 px-3 py-2">
      <span className="flex-1 text-xs font-medium">{t('appearance.menu.presets.title')}</span>
      {presets.length > 0 && (
        <button
          type="button"
          onClick={() => { setManaging((on) => !on); setConfirmAll(null); closeForm(); }}
          aria-pressed={managing}
          aria-label={t('appearance.menu.presets.manage')}
          title={t('appearance.menu.presets.manage')}
          className={`flex items-center gap-1 rounded px-1 py-0.5 text-[11px] outline-none transition-colors focus-visible:text-primary ${managing ? 'text-primary' : 'text-muted-foreground/70 hover:text-primary'}`}
        >
          <SlidersHorizontal className="size-3.5" />
          <span>{managing ? t('appearance.menu.presets.manageDone') : t('appearance.menu.presets.manageShort')}</span>
        </button>
      )}
    </div>

    {error && (
      <p role="alert" className="px-3 pb-2 text-xs leading-snug text-destructive">
        {t(`appearance.menu.presets.error.${error}`)}
      </p>
    )}

    {managing && presets.length > 0 && (
      <p className="px-3 pb-1 text-[11px] leading-snug text-muted-foreground">
        {t('appearance.menu.presets.manageHint')}
      </p>
    )}

    {presets.length === 0 && (
      <p className="px-3 pb-2 text-xs leading-snug text-muted-foreground">
        {t('appearance.menu.presets.empty')}
      </p>
    )}

    {presets.map((preset) => (
      editing === preset.id ? (
        <div key={preset.id}>{form(() => void onRename(preset.id))}</div>
      ) : managing && confirmAll === preset.id ? (
        <div key={preset.id} className="flex items-center gap-1 px-3 py-1.5 text-xs">
          <span className="min-w-0 flex-1 leading-snug">{t('appearance.menu.presets.applyAllConfirm', { name: preset.name })}</span>
          <button type="button" disabled={busy} onClick={() => void onApplyAll(preset)} aria-label={t('appearance.menu.presets.confirm')} title={t('appearance.menu.presets.confirm')} className={ICON_BUTTON}>
            <Check className="size-3.5" />
          </button>
          <button type="button" onClick={() => setConfirmAll(null)} aria-label={t('appearance.menu.presets.cancel')} title={t('appearance.menu.presets.cancel')} className={ICON_BUTTON}>
            <X className="size-3.5" />
          </button>
        </div>
      ) : managing ? (
        // Management rows are not menu items: they carry four actions, and a
        // row whose click already means "recall" cannot also mean "rename".
        <div key={preset.id} className="flex items-center gap-1 px-3 py-1.5 text-xs">
          <span className="min-w-0 flex-1 truncate" title={preset.name}>{preset.name}</span>
          <button type="button" disabled={!ready || busy} onClick={() => { setError(null); setEditing(preset.id); setDraft(preset.name); }} aria-label={t('appearance.menu.presets.rename', { name: preset.name })} title={t('appearance.menu.presets.rename', { name: preset.name })} className={ICON_BUTTON}>
            <Pencil className="size-3.5" />
          </button>
          <button type="button" disabled={!ready || busy} onClick={() => void onOverwrite(preset)} aria-label={t('appearance.menu.presets.overwrite', { name: preset.name })} title={t('appearance.menu.presets.overwrite', { name: preset.name })} className={ICON_BUTTON}>
            <Save className="size-3.5" />
          </button>
          <button type="button" disabled={!ready || busy || !owner} onClick={() => { setError(null); setConfirmAll(preset.id); }} aria-label={t('appearance.menu.presets.applyAll', { name: preset.name })} title={t('appearance.menu.presets.applyAll', { name: preset.name })} className={ICON_BUTTON}>
            <LayoutGrid className="size-3.5" />
          </button>
          <button type="button" disabled={!ready || busy} onClick={() => void onDelete(preset)} aria-label={t('appearance.menu.presets.delete', { name: preset.name })} title={t('appearance.menu.presets.delete', { name: preset.name })} className={ICON_BUTTON}>
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ) : (
        <Dropdown.Item key={preset.id} disabled={busy} onSelect={() => void onRecall(preset)} className={ITEM}>
          <span className="min-w-0 flex-1 truncate" title={preset.name}>{preset.name}</span>
        </Dropdown.Item>
      )
    ))}

    {editing === '' ? form(() => void onSave()) : (
      <Dropdown.Item
        disabled={!ready || busy}
        onSelect={(e) => { e.preventDefault(); setError(null); setManaging(false); setEditing(''); setDraft(''); }}
        className={ITEM}
      >
        <Plus className="size-4" />
        <span className="flex-1">{t('appearance.menu.presets.save')}</span>
      </Dropdown.Item>
    )}
  </>;
}
