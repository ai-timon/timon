'use client';

/**
 * The project identity popup: creation and editing, shared by every view.
 *
 * Extracted verbatim from the old `/projects` page (plugin `@timon/projects`)
 * when the agents grid became the only projects view: the form there was
 * already a popup, it did not need rewriting to change host.
 *
 * The input contract is a slug, not a project object: a caller with only a
 * card at hand (the grid) does not have to carry every field of the record.
 * The dialog therefore reads the record itself when it edits.
 */

import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { reportDirectoryPick, useDirectoryPicker } from '@/components/directory-browser';
import { autoColor } from '@/lib/project-visual';
import { LogoField } from '@/components/logo-field';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { apiErrorMessage } from '@/lib/api-error';
import { ProjectSettingsSlot } from '@/components/project-settings-slot';
import { announceProjectsChanged } from '@/hooks/use-project-meta';

type Project = {
  slug: string;
  name?: string | null;
  color?: string | null;
  icon?: string | null;
  workspace?: string | null;
  cwd?: string | null;
  speech?: string | null;
};

type Draft = {
  slug: string;
  name: string;
  color: string;
  icon: string;
  workspace: string;
  cwd: string;
  speech: string;
};

const SLUG_RE = /^[A-Za-z0-9._-]{1,64}$/;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

const EMPTY_DRAFT: Draft = {
  slug: '',
  name: '',
  color: '',
  icon: '',
  workspace: '',
  cwd: '',
  speech: '',
};

/** Slugs of the other projects, offered as the destination of the agents. */
async function otherProjects(slug: string): Promise<string[]> {
  try {
    const r = await fetch('/api/ui/projects', { cache: 'no-store' });
    if (!r.ok) return [];
    const j = (await r.json()) as { projects?: Project[] };
    return (j.projects ?? []).map((p) => p.slug).filter((s) => s.toLowerCase() !== slug.toLowerCase()).sort();
  } catch {
    return [];
  }
}

export type ProjectEditDialogProps = {
  /** `null` = creation; otherwise the slug of the project to edit. */
  slug: string | null;
  /** Called after a successful write: the caller reloads its list. */
  onSaved: () => void;
  onClose: () => void;
};

/** What a save answers when the daemon cannot use the cwd it just accepted. */
type CwdWarning = { field: string; error: 'missing' | 'denied' | 'not-a-directory'; code: string; path: string };

export function ProjectEditDialog({ slug: editingSlug, onSaved, onClose }: ProjectEditDialogProps) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Set when the daemon refuses to delete a project that still has agents: the user picks their fate.
  const [fate, setFate] = useState<{ agents: string[]; others: string[] } | null>(null);
  const [fateMode, setFateMode] = useState<'delete' | 'detach' | 'move'>('move');
  const [fateTarget, setFateTarget] = useState('');
  const [browsing, setBrowsing] = useState(false);
  // The working directory lives on the active machine: its daemon lists the
  // folders when the OS dialog of this computer would be the wrong disk (TIM-0136).
  const directoryPicker = useDirectoryPicker();
  const slugInputRef = useRef<HTMLInputElement>(null);
  // Tracks whether the user edited the slug by hand; if so, stop rewriting it
  // from the name (the usual auto-slug form UX).
  const slugTouched = useRef(editingSlug !== null);

  // On creation, the slug is the first field to fill; on edit it is locked,
  // so there is nothing to focus.
  useEffect(() => {
    if (editingSlug !== null) return;
    const id = setTimeout(() => slugInputRef.current?.focus(), 60);
    return () => clearTimeout(id);
  }, [editingSlug]);

  // The full record is not in the props: read it again on open.
  useEffect(() => {
    if (editingSlug === null) {
      setDraft(EMPTY_DRAFT);
      return;
    }
    let cancelled = false;
    // Immediate seed so the title and the slug field are right from the first
    // frame; the full record arrives right after.
    setDraft({ ...EMPTY_DRAFT, slug: editingSlug });
    void (async () => {
      try {
        const r = await fetch('/api/ui/projects', { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as { projects?: Project[] };
        const p = (j.projects ?? []).find((x) => x.slug === editingSlug);
        if (!p || cancelled) return;
        // The record arrives after the first render: if the user already typed,
        // overwriting it would steal their input. Only seed a draft that is
        // still untouched.
        setDraft((d) =>
          d.name || d.color || d.icon || d.workspace || d.cwd || d.speech
            ? d
            : {
                slug: p.slug,
                name: p.name ?? '',
                color: p.color ?? '',
                icon: p.icon ?? '',
                workspace: p.workspace ?? '',
                cwd: p.cwd ?? '',
                speech: p.speech ?? '',
              },
        );
      } catch {
        /* unreadable record: the form keeps the slug alone rather than going blank */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editingSlug]);

  async function browseCwd() {
    setBrowsing(true);
    try {
      const picked = await directoryPicker.pick(draft.cwd);
      if (picked.status === 'chosen') setDraft((d) => ({ ...d, cwd: picked.path }));
      else reportDirectoryPick(picked);
    } finally {
      setBrowsing(false);
    }
  }

  async function save() {
    const slug = draft.slug.trim();
    if (!SLUG_RE.test(slug)) {
      toast.error(t('projectsPage.invalidSlug'));
      return;
    }
    setSaving(true);
    const body: Record<string, string> = { slug };
    if (draft.name.trim()) body.name = draft.name.trim();
    if (draft.color.trim()) body.color = draft.color.trim();
    if (draft.icon.trim()) body.icon = draft.icon.trim();
    if (draft.workspace.trim()) body.workspace = draft.workspace.trim();
    if (draft.cwd.trim()) body.cwd = draft.cwd.trim();
    if (draft.speech.trim()) body.speech = draft.speech.trim();
    try {
      const isEdit = !!editingSlug;
      const url = isEdit
        ? `/api/ui/projects/${encodeURIComponent(slug)}/meta`
        : '/api/ui/projects';
      const r = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(apiErrorMessage(j, { status: r.status }));
      }
      toast.success(t(isEdit ? 'projectsPage.updated' : 'projectsPage.created', { slug }));
      // A privileged save is accepted even when the daemon cannot use the path:
      // say so now, not when a card later shows an empty signal row.
      const saved = await r.json().catch(() => ({})) as { warnings?: CwdWarning[] };
      for (const w of saved.warnings ?? []) {
        if (w.field !== 'cwd') continue;
        const key = w.error === 'denied' ? 'cwdWarnDenied'
          : w.error === 'not-a-directory' ? 'cwdWarnNotDirectory'
          : 'cwdWarnMissing';
        toast.warning(t(`projectsPage.${key}`, { path: w.path, code: w.code }));
      }
      announceProjectsChanged();
      onSaved();
      onClose();
    } catch (e) {
      toast.error(String((e as Error).message || e).slice(0, 120));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!editingSlug) return;
    if (!(await confirmAction({ title: t('projectsPage.deleteConfirm', { slug: editingSlug }), confirmLabel: t('confirmDialog.delete'), destructive: true }))) return;
    await removeWith('');
  }

  /** `query` is empty on the first attempt; the daemon answers 409 with the agent list when some are left. */
  async function removeWith(query: string) {
    if (!editingSlug) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/ui/projects/${encodeURIComponent(editingSlug)}${query}`, {
        method: 'DELETE',
      });
      if (r.status === 409) {
        const j = (await r.json().catch(() => ({}))) as { agents?: string[] };
        const others = await otherProjects(editingSlug);
        setFateTarget(others[0] ?? '');
        setFateMode(others.length ? 'move' : 'detach');
        setFate({ agents: j.agents ?? [], others });
        return;
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(apiErrorMessage(j, { status: r.status }));
      }
      toast.success(t('projectsPage.deleted', { slug: editingSlug }));
      announceProjectsChanged();
      onSaved();
      onClose();
    } catch (e) {
      toast.error(String((e as Error).message || e).slice(0, 120));
    } finally {
      setDeleting(false);
    }
  }

  async function confirmFate() {
    const query = fateMode === 'move' ? `?agents=move&to=${encodeURIComponent(fateTarget)}` : `?agents=${fateMode}`;
    setFate(null);
    await removeWith(query);
  }

  const previewColor = draft.color.trim() || autoColor(draft.name || draft.slug || 'project');

  return (
    <>
      <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>
              {editingSlug ? t('projectsPage.editTitle', { slug: editingSlug }) : t('projectsPage.createTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3.5">
            {/* The logo on top, centred: it is the project's identity, not one
                form field among others. */}
            <LogoField
              value={draft.icon}
              onChange={(icon) => setDraft((d) => ({ ...d, icon }))}
              accent={previewColor}
              fallback={(draft.name || draft.slug || '·').slice(0, 2).toUpperCase()}
              disabled={saving}
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('projectsPage.name')}>
                <Input
                  value={draft.name}
                  onChange={(e) => {
                    const name = e.target.value;
                    setDraft((d) => ({
                      ...d,
                      name,
                      slug: slugTouched.current ? d.slug : slugify(name),
                    }));
                  }}
                  placeholder={t('projectsPage.namePlaceholder')}
                  disabled={saving}
                />
              </Field>
              <Field label={t('projectsPage.slug')}>
                <Input
                  ref={slugInputRef}
                  value={draft.slug}
                  onChange={(e) => {
                    slugTouched.current = true;
                    setDraft((d) => ({ ...d, slug: e.target.value }));
                  }}
                  placeholder={t('projectsPage.slugPlaceholder')}
                  disabled={saving || !!editingSlug}
                  
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('projectsPage.color')}>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={draft.color || previewColor}
                    onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
                    className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent"
                    disabled={saving}
                  />
                  <Input
                    value={draft.color}
                    onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
                    placeholder={t('editPage.colorAuto')}
                    /* code-font: hex colour value */ className="font-mono"
                    disabled={saving}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setDraft((d) => ({ ...d, color: '' }))}
                    disabled={saving}
                    title={t('projectsPage.autoColor')}
                  >
                    {t('projectsPage.auto')}
                  </Button>
                </div>
              </Field>
              <Field label={t('projectsPage.workspace')}>
                <Input
                  value={draft.workspace}
                  onChange={(e) => setDraft((d) => ({ ...d, workspace: e.target.value }))}
                  placeholder={t('projectsForm.workspacePlaceholder')}
                  disabled={saving}
                />
              </Field>
            </div>
            {/* An absolute path does not fit in half a width. */}
            <Field label={t('projectsPage.workingDirectory')}>
              <div className="flex gap-1.5">
                <Input
                  value={draft.cwd}
                  onChange={(e) => setDraft((d) => ({ ...d, cwd: e.target.value }))}
                  placeholder={t('projectsPage.cwdPlaceholder')}
                  /* code-font: file path */ className="min-w-0 font-mono text-xs"
                  disabled={saving}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void browseCwd()}
                  disabled={saving || deleting || browsing}
                >
                  {t('setupPage.browse')}
                </Button>
                {directoryPicker.dialog}
              </div>
            </Field>
            <Field label={t('projectsPage.speech')}>
              <Textarea
                value={draft.speech}
                onChange={(e) => setDraft((d) => ({ ...d, speech: e.target.value }))}
                placeholder={t('projectsForm.speechPlaceholder')}
                rows={3}
                disabled={saving}
              />
            </Field>
            {editingSlug && <ProjectSettingsSlot project={editingSlug} />}
            {/* Danger zone, edit only. Deletion lives ONLY here: on a grid of
                twenty-five cards, a hover trash glyph makes the fatal click
                too easy to give by mistake. */}
            {editingSlug && (
              <div className="mt-1 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[12px] font-medium text-destructive">
                    {t('projectsPage.dangerZone')}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {t('projectsPage.dangerZoneHint')}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="shrink-0 gap-1.5"
                  onClick={remove}
                  disabled={saving || deleting}
                  title={t('projectsPage.delete')}
                >
                  <Trash2 className="size-3.5" />
                  {deleting ? t('projectsPage.deleting') : t('projectsPage.delete')}
                </Button>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={saving || deleting}>
              {t('common.cancel')}
            </Button>
            <Button onClick={save} disabled={saving || deleting}>
              {saving ? t('projectsPage.saving') : editingSlug ? t('projectsPage.save') : t('projectsPage.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {fate && editingSlug && (
        <Dialog open onOpenChange={(v) => { if (!v) setFate(null); }}>
          <DialogContent className="sm:max-w-[460px]">
            <DialogHeader>
              <DialogTitle>{t('projectsPage.fateTitle', { slug: editingSlug, count: fate.agents.length })}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3 text-[13px]">
              <div className="text-[11px] text-muted-foreground">
                {fate.agents.slice(0, 8).join(', ')}{fate.agents.length > 8 ? ` +${fate.agents.length - 8}` : ''}
              </div>
              {(['move', 'detach', 'delete'] as const).map((mode) => (
                <label
                  key={mode}
                  className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${fateMode === mode ? (mode === 'delete' ? 'border-destructive/60 bg-destructive/5' : 'border-primary/60 bg-primary/5') : 'border-border'} ${mode === 'move' && !fate.others.length ? 'opacity-50' : ''}`}
                >
                  <input
                    type="radio"
                    name="project-agents-fate"
                    className="mt-1"
                    checked={fateMode === mode}
                    disabled={mode === 'move' && !fate.others.length}
                    onChange={() => setFateMode(mode)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{t(`projectsPage.fate.${mode}`)}</span>
                    <span className="block text-[11px] text-muted-foreground">{t(`projectsPage.fate.${mode}Hint`)}</span>
                    {mode === 'move' && fateMode === 'move' && (
                      <select
                        aria-label={t('projectsPage.fate.target')}
                        className="mt-1.5 h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                        value={fateTarget}
                        onChange={(e) => setFateTarget(e.target.value)}
                      >
                        {fate.others.map((other) => <option key={other} value={other}>{other}</option>)}
                      </select>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setFate(null)}>{t('common.cancel')}</Button>
              <Button
                variant={fateMode === 'delete' ? 'destructive' : 'default'}
                disabled={fateMode === 'move' && !fateTarget}
                onClick={() => void confirmFate()}
              >
                {t('projectsPage.fate.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
