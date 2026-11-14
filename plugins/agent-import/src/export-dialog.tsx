/**
 * "Export" in the action bar of the Agents page (SUG-0084): pick some
 * agents, or all, and download the archive another Timon imports. The list
 * and the archive come from the plugin's own routes (`agents`, `export`),
 * which only show what the signed-in account reads.
 */
import React from 'react';
import type { ComponentType, ReactNode } from 'react';
import * as ui from '@timon/ui';
import type { ClientContext } from '@timon-ai/sdk';
import {
  EXPORT_DIALOG_MAX, exportBody, exportFailureKey, exportFileName, kept, toggled, toggledAll, type ExportableAgent,
} from './export-state.js';
import messages from './messages.json';

const t = ui.createTranslator(messages);

type Children = { children?: ReactNode };
// The SDK leaves React out of its types; narrowed at this boundary.
const Button = ui.Button as ComponentType<Children & {
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'outline' | 'ghost';
  size?: 'sm' | 'default';
  className?: string;
}>;
const Switch = ui.Switch as ComponentType<{
  id?: string;
  checked: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  onCheckedChange: (checked: boolean) => void;
}>;
const Label = ui.Label as ComponentType<Children & { htmlFor?: string; className?: string }>;
const Dialog = ui.Dialog as ComponentType<Children & { open: boolean; onOpenChange: (open: boolean) => void }>;
const DialogContent = ui.DialogContent as ComponentType<Children & { className?: string; style?: React.CSSProperties }>;
const DialogHeader = ui.DialogHeader as ComponentType<Children>;
const DialogTitle = ui.DialogTitle as ComponentType<Children>;
const DialogDescription = ui.DialogDescription as ComponentType<Children>;

type Api = ClientContext['api'];

async function bodyOf(response: Response): Promise<unknown> {
  try { return await response.json() as unknown; } catch { return null; }
}

/** Hands a file to the browser as a download. */
export function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ExportBody({ api }: { api: Api }) {
  const [agents, setAgents] = React.useState<ExportableAgent[] | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const id = React.useId();

  React.useEffect(() => {
    let live = true;
    (async () => {
      try {
        const response = await api('agents');
        const json = await bodyOf(response);
        if (!live) return;
        if (!response.ok) {
          setError(t(exportFailureKey(response.status, json)));
          setAgents([]);
          return;
        }
        const list = (json as { agents?: ExportableAgent[] } | null)?.agents ?? [];
        setAgents(list);
        setSelected((current) => kept(current, list));
      } catch {
        if (live) { setError(t('export.errors.network')); setAgents([]); }
      }
    })();
    return () => { live = false; };
  }, [api]);

  const body = exportBody(selected);
  const run = async () => {
    if (!body) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const response = await api('export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) {
        setError(t(exportFailureKey(response.status, await bodyOf(response))));
        return;
      }
      save(await response.blob(), exportFileName(new Date()));
      setDone(t('export.done', { count: body.agents.length }));
    } catch {
      setError(t('export.errors.network'));
    } finally {
      setBusy(false);
    }
  };

  if (agents === null) return <p className="text-sm text-muted-foreground">{t('export.loading')}</p>;
  const everyone = agents.length > 0 && agents.every((a) => selected.includes(a.name));
  return (
    <div className="flex flex-col gap-4">
      {agents.length === 0 && !error && <p className="text-sm text-muted-foreground">{t('export.empty')}</p>}
      {agents.length > 0 && (
        <>
          <div className="flex items-center gap-3">
            <Switch
              id={`${id}-all`}
              checked={everyone}
              disabled={busy}
              onCheckedChange={() => setSelected((current) => toggledAll(current, agents))}
            />
            <Label htmlFor={`${id}-all`} className="text-sm font-medium">{t('export.all', { count: agents.length })}</Label>
          </div>
          <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {agents.map((agent, index) => (
              <li key={agent.name} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40">
                <Switch
                  id={`${id}-${index}`}
                  checked={selected.includes(agent.name)}
                  disabled={busy}
                  onCheckedChange={() => setSelected((current) => toggled(current, agent.name))}
                />
                <Label htmlFor={`${id}-${index}`} className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{agent.name}</span>
                  {(agent.role || agent.project) && (
                    <span className="truncate text-xs text-muted-foreground">
                      {[agent.role, agent.project].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </Label>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">{t('export.secrets')}</p>
      {selected.length > EXPORT_DIALOG_MAX && (
        <p role="alert" className="text-sm text-destructive">{t('export.tooMany', { max: EXPORT_DIALOG_MAX })}</p>
      )}
      {error && <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {done && <p role="status" className="text-sm text-muted-foreground">{done}</p>}
      <div className="flex justify-end">
        <Button disabled={busy || body === null} onClick={() => void run()}>
          {busy ? t('export.running') : t('export.run', { count: selected.length })}
        </Button>
      </div>
    </div>
  );
}

function ExportDialog({ api, open, onOpenChange }: { api: Api; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Inline sizes: a plugin's arbitrary Tailwind values are not compiled by the product. */}
      <DialogContent style={{ maxWidth: 560, maxHeight: '85vh', overflowY: 'auto' }}>
        <DialogHeader>
          <DialogTitle>{t('export.title')}</DialogTitle>
          <DialogDescription>{t('export.description')}</DialogDescription>
        </DialogHeader>
        {open && <ExportBody api={api} />}
      </DialogContent>
    </Dialog>
  );
}

/** "Export" next to "Import agents" in the Agents page's action bar. */
export function ExportEntry({ api }: { api: Api }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      {/* Same size, icon and gap as the bar's own entries; the arrow leaves the tray. */}
      <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1.5 px-2.5 text-[11.5px] font-medium" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="m17 8-5-5-5 5" />
          <path d="M12 3v12" />
        </svg>
        {t('export.open')}
      </Button>
      <ExportDialog api={api} open={open} onOpenChange={setOpen} />
    </>
  );
}

const MenuItem = ui.DropdownMenuItem as ComponentType<Children & { onSelect?: () => void; disabled?: boolean }>;

/** Downloads the archive of one agent; resolves the message key of a failure, `null` on success. */
export async function exportOne(api: Api, name: string): Promise<string | null> {
  const body = exportBody([name]);
  if (!body) return 'export.errors.invalid';
  try {
    const response = await api('export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) return exportFailureKey(response.status, await bodyOf(response));
    save(await response.blob(), exportFileName(new Date()));
    return null;
  } catch {
    return 'export.errors.network';
  }
}

/**
 * "Export" in the menu of one agent (`agent.menu.item`): the archive of that
 * agent alone, straight to the downloads. The menu closes on select and takes
 * this entry with it, so a refusal is said in Timon's own dialog rather than
 * in state that would no longer be painted.
 */
export function ExportAgentMenuItem({ api }: { api: Api }) {
  const agent = ui.useAgentMenuItem();
  if (!agent) return null;
  return (
    <MenuItem
      onSelect={() => {
        void exportOne(api, agent.name).then((failure) => {
          if (failure) void ui.confirmAction({ title: t('export.failed', { name: agent.name }), description: t(failure), confirmLabel: t('export.ok') });
        });
      }}
    >
      {t('export.one')}
    </MenuItem>
  );
}
