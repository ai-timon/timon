import { t } from '@/lib/i18n';

/** Metadata is supplied only for recognized, system-created backend warnings. */
export type SystemNotificationPresentation = {
  kind: 'backend-binary';
  cmd: string;
  backends: string[];
  pinned: boolean;
  installCommand: string | null;
};

export type PresentableNotification = {
  title: string;
  body: string | null;
  presentation?: SystemNotificationPresentation;
};

/** Leave agent, plugin and user-authored text untouched, including Markdown. */
export function systemNotificationText(n: PresentableNotification): { title: string; body: string | null } {
  const metadata = n.presentation;
  if (metadata?.kind !== 'backend-binary') return { title: n.title, body: n.body };
  const vars = {
    cmd: metadata.cmd,
    backends: metadata.backends.join(', '),
    configKey: `host.binaries.${metadata.cmd}`,
    settings: t('systemNotifications.backendBinary.settings'),
    recheck: t('systemNotifications.backendBinary.recheck'),
  };
  return {
    title: t('systemNotifications.backendBinary.title', vars),
    body: [
      t('systemNotifications.backendBinary.description', vars),
      '',
      t(metadata.pinned ? 'systemNotifications.backendBinary.repairPinned' : 'systemNotifications.backendBinary.repairMissing', vars),
      ...(metadata.installCommand ? ['', t('systemNotifications.backendBinary.installCommand', { command: metadata.installCommand })] : []),
    ].join('\n'),
  };
}
