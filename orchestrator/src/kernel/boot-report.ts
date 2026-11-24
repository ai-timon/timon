/**
 * What the kernel boot says, kept apart from `kernel-boot.ts` because that file
 * boots the daemon on import (top-level `await boot()`): a test cannot load it
 * to read a sentence. The sentences are English, like every user-facing
 * message of the daemon — the plugin failure title reaches every tester's
 * notification centre.
 */
import { daemonMessage, type DaemonMessage } from '../daemon-message.js';
import type { EntryDecision } from './registry.js';

/** The one boot line that sums up the module plan. */
export function kernelBootSummary(input: {
  profile: string;
  edition: string;
  licenseStatus: string;
  licenseReason?: string | null;
  capabilities: readonly string[];
  decisions: readonly EntryDecision[];
}): string {
  const off = input.decisions.filter((d) => d.disabled);
  return `[kernel] profile=${input.profile} edition=${input.edition} licence=${input.licenseStatus}${input.licenseReason ? `:${input.licenseReason}` : ''} capabilities=[${input.capabilities.join(', ')}]`
    + ` — ${input.decisions.length - off.length} module(s) active`
    + (off.length ? `, ${off.length} disabled: ${off.map((d) => `${d.id} (${d.reason})`).join(', ')}` : '');
}

/** The notification raised when a third-party plugin fails to load or apply. */
export function pluginFailureNotification(id: string, message: string): {
  type: 'alert';
  urgent: false;
  title: string;
  body: string;
  source: string;
  message: DaemonMessage;
} {
  return {
    type: 'alert',
    urgent: false,
    title: `Plugin ${id} failed`,
    body: message,
    source: `plugin:${id}`,
    message: daemonMessage('plugin_failed', { id }),
  };
}
