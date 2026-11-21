import { toast } from 'sonner';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { t } from '@/lib/i18n';
import { deletePole } from './hierarchy-actions';
import type { PoleRecord } from './agents-client';

/**
 * Asks, deletes the pole and says so. Shared so the pole dialog and the
 * right-click menu ask the same question. Resolves true once the daemon has
 * deleted it.
 */
export async function deletePoleAfterConfirm(pole: PoleRecord): Promise<boolean> {
  if (!(await confirmAction({ title: t('agentsPage.poleDeleteConfirm', { name: pole.name }), confirmLabel: t('confirmDialog.delete'), destructive: true }))) return false;
  const error = await deletePole(pole.slug);
  if (error) {
    toast.error(t('agentsPage.actionFailed', { error }));
    return false;
  }
  toast.success(t('agentsPage.poleDeleted', { name: pole.name }));
  return true;
}
