'use client';

/**
 * The modal shell of Settings and its close cross. Closing is explicit (the
 * cross, Escape) or a click on the dimmed page around the dialog; a click
 * outside never discards a row still being typed, it says so instead.
 */
import type { MutableRefObject, ReactElement, ReactNode } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function SettingsDialogFrame({
  onClose,
  unsavedRef,
  children,
}: {
  onClose: () => void;
  /** True while a row holds a typed value that was not saved yet. */
  unsavedRef: MutableRefObject<boolean>;
  children: ReactNode;
}): ReactElement {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        hideClose
        // Focus lands on the dialog itself, not on its first category: opened
        // from a link or a reload, that button wore the keyboard ring as if it
        // had been tabbed to. Tab still reaches it first.
        onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}
        onPointerDownOutside={(event) => {
          const target = event.target;
          // Toasts live in their own portal: a click on one is not a click on the page.
          if (target instanceof Element && target.closest('[data-sonner-toaster]')) {
            event.preventDefault();
            return;
          }
          if (unsavedRef.current) {
            event.preventDefault();
            toast(t('settingsDialog.unsavedKept'));
          }
        }}
        className={cn(
          'flex max-w-none gap-0 overflow-hidden p-0 outline-none focus-visible:outline-none',
          'h-[100dvh] w-screen rounded-none',
          'sm:h-[min(860px,calc(100dvh-3rem))] sm:w-[min(1240px,calc(100vw-3rem))] sm:rounded-xl',
        )}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function SettingsCloseButton({ onClose }: { onClose: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={t('settingsDialog.close')}
      title={t('settingsDialog.close')}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <X className="size-4" aria-hidden />
    </button>
  );
}
