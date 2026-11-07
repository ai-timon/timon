import { toast } from 'sonner';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';

/**
 * Asks, deletes the agent, and offers to restore it from the toast. Shared so
 * every place that deletes an agent says the same thing about the trash.
 * Resolves true once the daemon has deleted it.
 */
export async function deleteAgentAfterConfirm(name: string, opts: { onRestored?: () => void | Promise<unknown> } = {}): Promise<boolean> {
  // The confirmation says where the agent goes: the trash, unless it is off.
  const trash = await fetch('/api/ui/agent-trash', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() as Promise<{ enabled?: boolean }> : null))
    .catch(() => null);
  const toTrash = trash?.enabled !== false;
  if (!(await confirmAction({ title: t(toTrash ? 'agentTrash.deleteConfirm' : 'agentTrash.deleteConfirmFinal', { name, settingsPath: settingsPath('system', 'backup') }), confirmLabel: t('confirmDialog.delete'), destructive: true }))) return false;
  try {
    const r = await fetch('/api/ui/agents/' + encodeURIComponent(name), {
      method: 'DELETE',
    });
    if (!r.ok) throw new Error(await r.text());
    const { trash_id: trashId } = await r.json().catch(() => ({})) as { trash_id?: string | null };
    if (trashId) {
      toast.success(t('agentTrash.deletedToast', { name }), {
        action: {
          label: t('agentTrash.restore'),
          onClick: () => {
            void fetch(`/api/ui/agent-trash/${encodeURIComponent(trashId)}/restore`, { method: 'POST' })
              .then(async (res) => {
                if (!res.ok) throw new Error(await res.text());
                toast.success(t('agentTrash.restored', { name }));
                await opts.onRestored?.();
              })
              .catch((e: Error) => toast.error(t('agentTrash.actionError', { error: e.message.slice(0, 80) })));
          },
        },
      });
    } else {
      toast.success('Deleted ' + name);
    }
    return true;
  } catch (e) {
    toast.error('Delete failed: ' + String((e as Error).message || e).slice(0, 80));
    return false;
  }
}
