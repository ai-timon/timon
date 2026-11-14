'use client';

import { useEffect, useMemo, useState } from 'react';
import { Settings2, Trash2, Plus, ArrowLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { apiErrorMessage } from '@/lib/api-error';
import { RoleSvg } from '@/components/role-svg';
import { loadLucideIconSet, roleSvgFromRenderedIcon, type LucideIconSet } from '@/lib/roles';

export type Role = {
  id: string;
  label: string;
  iconName: string;
  iconSvg: string;
  color: string;
  default_directives: string;
  default_model: string;
  default_permission_mode: string;
  builtin?: boolean;
  directives_overridden?: boolean;
};

type Draft = {
  existing?: boolean;
  id: string;
  label: string;
  iconName: string;
  iconSvg: string;
  color: string;
  directives: string;
  model: string;
  mode: string;
};

const BLANK: Draft = {
  id: '',
  label: '',
  iconName: '',
  iconSvg: '',
  color: '#64748b',
  directives: '',
  model: 'claude-sonnet-4-6',
  mode: 'auto',
};

/** Searchable lucide icon grid. Keeps the picked icon's name, and its inner
 *  markup reduced to the shapes the daemon accepts, as the fallback drawn by
 *  the D3 canvas and wherever the name is not a known lucide icon. */
function IconPicker({
  value,
  color,
  onPick,
}: {
  value: string;
  color: string;
  onPick: (name: string, svg: string) => void;
}) {
  const [q, setQ] = useState('');
  const [icons, setIcons] = useState<LucideIconSet | null>(null);
  useEffect(() => {
    let live = true;
    void loadLucideIconSet().then((set) => { if (live) setIcons(set); });
    return () => { live = false; };
  }, []);
  const names = useMemo(() => {
    if (!icons) return [];
    const all = Object.keys(icons);
    const lc = q.trim().toLowerCase();
    return lc ? all.filter((n) => n.toLowerCase().includes(lc)).slice(0, 120) : all.slice(0, 80);
  }, [q, icons]);
  return (
    <div>
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('roles.searchIcon')}
        className="text-[12px]"
      />
      <div className="mt-2 grid max-h-44 grid-cols-9 gap-1 overflow-auto rounded-md border border-border p-1.5">
        {!icons && <Loader2 className="m-2 size-4 animate-spin text-muted-foreground" aria-hidden />}
        {icons && names.map((name) => {
          const Ic = icons[name];
          if (!Ic) return null;
          return (
            <button
              key={name}
              type="button"
              title={name}
              onClick={(e) => {
                const svg = e.currentTarget.querySelector('svg');
                onPick(name, roleSvgFromRenderedIcon(svg?.innerHTML ?? ''));
              }}
              className={cn(
                'grid place-items-center rounded p-1.5 hover:bg-muted',
                value === name && 'ring-2 ring-primary',
              )}
              style={value === name ? { color } : undefined}
            >
              <Ic className="size-4" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

const MODELS = ['claude-fable-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'fable', 'sonnet', 'opus', 'haiku'];
const MODES = ['auto', 'acceptEdits', 'plan', 'bypassPermissions', 'default'];

/**
 * Role management modal: lists built-in and custom roles, with a
 * create/edit form (id, label, lucide icon, colour, directives, model,
 * permission). Built-ins allow prompt edits only. Persists via /api/ui/agent-roles.
 */
export function RoleManager({ roles, onChanged }: { roles: Role[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null); // null = list view
  const [saving, setSaving] = useState(false);

  const editingRole = draft?.existing ? roles.find((r) => r.id === draft.id) : undefined;
  const isBuiltin = editingRole !== undefined && editingRole.builtin !== false;

  const custom = roles.filter((r) => r.builtin === false);
  const builtins = roles.filter((r) => r.builtin !== false);

  function editRole(r: Role) {
    setDraft({
      existing: true,
      id: r.id,
      label: r.label,
      iconName: r.iconName,
      iconSvg: r.iconSvg,
      color: r.color,
      directives: r.default_directives,
      model: r.default_model,
      mode: r.default_permission_mode,
    });
  }

  async function save(reset = false) {
    if (!draft || saving) return;
    if (reset && !(await confirmAction({ title: t('roles.resetConfirm', { id: draft.id }), confirmLabel: t('confirmDialog.restore'), destructive: true }))) return;
    if (!draft.iconSvg) return toast.error(t('roles.chooseIcon'));
    if (!draft.label.trim()) return toast.error(t('roles.labelRequired'));
    const isNew = !draft.existing;
    setSaving(true);
    try {
      const body = isBuiltin
        ? (reset ? { reset_directives: true } : { default_directives: draft.directives })
        : {
        id: draft.id,
        label: draft.label.trim(),
        iconName: draft.iconName,
        iconSvg: draft.iconSvg,
        color: draft.color,
        default_directives: draft.directives,
        default_model: draft.model,
        default_permission_mode: draft.mode,
      };
      const r = await fetch(isNew ? '/api/ui/agent-roles' : `/api/ui/agent-roles/${encodeURIComponent(draft.id)}`, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(apiErrorMessage(j, r.statusText));
      }
      toast.success(t(reset ? 'roles.resetDone' : isNew ? 'roles.created' : 'roles.updated', { id: draft.id }));
      setDraft(null);
      onChanged();
    } catch (e) {
      toast.error(t('roles.saveError', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  async function del(id: string) {
    if (!(await confirmAction({ title: t('roles.deleteConfirm', { id }), confirmLabel: t('confirmDialog.delete'), destructive: true }))) return;
    try {
      const r = await fetch(`/api/ui/agent-roles/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(apiErrorMessage(j, r.statusText));
      }
      toast.success(t('roles.deleted', { id }));
      onChanged();
    } catch (e) {
      toast.error(t('roles.saveError', { message: (e as Error).message }));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setDraft(null); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px]">
          <Settings2 className="size-3" /> {t('roles.manage')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {draft ? (draft.existing ? t('roles.edit', { id: draft.id }) : t('roles.new')) : t('roles.roles')}
          </DialogTitle>
        </DialogHeader>

        {!draft ? (
          <div className="flex flex-col gap-3">
            <Button variant="outline" size="sm" className="gap-1.5 self-start" onClick={() => setDraft({ ...BLANK })}>
              <Plus className="size-3.5" /> {t('roles.new')}
            </Button>
            {custom.length > 0 && (
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Custom</p>
                <div className="flex flex-col gap-1">
                  {custom.map((r) => (
                    <div key={r.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
                      <span
                        className="grid size-5 shrink-0 place-items-center"
                        style={{ color: r.color }}
                      >
                        <RoleSvg svg={r.iconSvg} iconName={r.iconName} size={16} />
                      </span>
                      <span className="flex-1 text-[12px]">{r.label} <span className="text-muted-foreground/60">({r.id})</span></span>
                      <button type="button" onClick={() => editRole(r)} className="text-[11px] text-muted-foreground hover:text-foreground">{t('roles.edit', { id: r.id })}</button>
                      <button type="button" onClick={() => del(r.id)} className="text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
                <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{t('roles.builtin')}</p>
              <div className="flex flex-wrap gap-1.5">
                {builtins.map((r) => (
                  <button type="button" key={r.id} onClick={() => editRole(r)} aria-label={t('roles.edit', { id: r.id })} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" style={{ color: r.color, borderColor: `${r.color}66`, background: `${r.color}14` }}>
                    <RoleSvg svg={r.iconSvg} iconName={r.iconName} size={12} />
                    {r.id} {r.directives_overridden && <span>· {t('roles.modified')}</span>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex max-h-[70vh] flex-col gap-3 overflow-auto pr-1">
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-[11px] text-muted-foreground">{t('roles.id')}</label>
                <Input
                  className="text-[12px]"
                  value={draft.id}
                  disabled={draft.existing}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                  placeholder="e.g. designer"
                />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-[11px] text-muted-foreground">{t('roles.label')}</label>
                <Input className="text-[12px]" value={draft.label} disabled={isBuiltin} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Designer" />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted-foreground">{t('roles.color')}</label>
                <input type="color" disabled={isBuiltin} value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} className="h-9 w-12 rounded border border-border bg-transparent" />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-muted-foreground">
                {t('roles.icon')} {draft.iconName && <span className="text-foreground">· {draft.iconName}</span>}
              </label>
              {!isBuiltin && <IconPicker value={draft.iconName} color={draft.color} onPick={(name, svg) => setDraft({ ...draft, iconName: name, iconSvg: svg })} />}
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-[11px] text-muted-foreground">{t('roles.defaultModel')}</label>
                <Select disabled={isBuiltin} value={draft.model} onValueChange={(v) => setDraft({ ...draft, model: v })}>
                  <SelectTrigger className="text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>{MODELS.map((m) => <SelectItem key={m} value={m} className="text-[12px]">{m}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-[11px] text-muted-foreground">{t('roles.defaultPermission')}</label>
                <Select disabled={isBuiltin} value={draft.mode} onValueChange={(v) => setDraft({ ...draft, mode: v })}>
                  <SelectTrigger className="text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>{MODES.map((m) => <SelectItem key={m} value={m} className="text-[12px]">{m}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label htmlFor="role-directives" className="mb-1 block text-[11px] text-muted-foreground">{t('roles.directives')}</label>
              {isBuiltin && <p className="mb-2 text-xs text-muted-foreground">{t('roles.builtinPromptHint')} {editingRole?.directives_overridden && t('roles.modified')}</p>}
              <Textarea /* code-font: prompt source editor */ id="role-directives" disabled={saving} className="min-h-24 font-mono text-[12px]" value={draft.directives} onChange={(e) => setDraft({ ...draft, directives: e.target.value })} placeholder={t('roles.directivesPlaceholder')} />
            </div>
            <div className="flex flex-wrap justify-between gap-2 pt-1">
              <Button variant="ghost" size="sm" className="gap-1.5" disabled={saving} onClick={() => setDraft(null)}><ArrowLeft className="size-3.5" /> {t('roles.back')}</Button>
              <div className="flex gap-2">
                {isBuiltin && editingRole?.directives_overridden && <Button variant="outline" size="sm" onClick={() => save(true)} disabled={saving}>{t('roles.reset')}</Button>}
                <Button size="sm" onClick={() => save()} disabled={saving}>{saving ? t('roles.saving') : t('roles.save')}</Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
