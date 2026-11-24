/**
 * Deep link of a notification: `/chat` on the right mission, card highlighted.
 *
 * Extracted from the notification rail so the app has only ONE URL builder.
 * The server counterpart lives in `orchestrator/src/push.ts`
 * (`notificationHref`) — it produces exactly the same string, carried in the
 * Web Push payload, since the service worker (static JS in public/) cannot
 * import this module.
 */
import type { ProviderAccess } from './provider-access';

export type NotificationLinkFields = {
  mission_id: string | null;
  task_id: string | null;
  anchor: string | null;
};

export type NotificationLinkViewer = {
  /** The viewer's level of the Providers screen: a provider page is a link only at `full`. Absent = linked. */
  providers?: ProviderAccess | null;
};

export function notificationHref(n: NotificationLinkFields, viewer: NotificationLinkViewer = {}): string | null {
  const egress = n.anchor ? EGRESS_ANCHOR.exec(n.anchor) : null;
  if (egress) return `/chat?mission=${encodeURIComponent(egress[1]!)}&egress=1`;
  if (n.mission_id) {
    const anchor = n.anchor ? `&highlight=${encodeURIComponent(n.anchor)}` : '';
    return `/chat?mission=${encodeURIComponent(n.mission_id)}${anchor}`;
  }
  if (n.task_id) return `/chat?task=${encodeURIComponent(n.task_id)}`;
  // Neither mission nor task, but a page anchor: go straight there. Without
  // this case, every notification the orchestrator emits itself (memory
  // curation, dreaming, audits — mission_id AND task_id null) was a dead
  // card: the click did nothing.
  if (n.anchor && n.anchor.startsWith('/')) return n.anchor;
  const consent = n.anchor ? PLUGIN_SECRET_ANCHOR.exec(n.anchor) : null;
  if (consent) return `/secrets?grant=${encodeURIComponent(consent[2]!)}&plugin=${encodeURIComponent(consent[1]!)}`;
  const proposal = n.anchor ? FORGE_PROPOSAL_ANCHOR.exec(n.anchor) : null;
  if (proposal) return `/?forge-proposal=${encodeURIComponent(proposal[2]!)}&forge-project=${encodeURIComponent(proposal[1]!)}`;
  const launch = n.anchor ? PROVIDER_LAUNCH_ANCHOR.exec(n.anchor) : null;
  // The program to authorise is in the Program section, which only the full level is shown.
  if (launch && viewer.providers !== undefined && viewer.providers !== 'full') return null;
  if (launch) return `/?settings=${encodeURIComponent('models/backends')}&provider=${encodeURIComponent(launch[1]!)}`;
  return null;
}

/**
 * A new outbound host for a mission (`egress:<mission>`, TODO #590): the
 * mission's chat, its Network view opened (`lib/egress.ts`). Not
 * `&highlight=`, which names a card of the thread: the chat would page through
 * the whole history looking for it.
 */
const EGRESS_ANCHOR = /^egress:(.+)$/;

/**
 * Refused launch of a third-party provider (`provider-launch:<plugin>`, TODO #598):
 * the card opens Settings › AI models › Providers on that provider's page
 * (`provider` parameter, `ProvidersSettings`), whose Program section offers the
 * re-authorisation and confirms it (`provider-common-sections.tsx`).
 */
const PROVIDER_LAUNCH_ANCHOR = /^provider-launch:(.+)$/;

/**
 * A publication on GitHub waiting for approval (`forge-proposal:<project>:<id>`):
 * the card opens the "Publish on GitHub" dialog on it, over the page it lands
 * on (`ForgeProposalDialogHost`). `forge-project`, not `project`, which names
 * the workspace of a view.
 */
const FORGE_PROPOSAL_ANCHOR = /^forge-proposal:([a-z0-9][a-z0-9._-]*):([0-9a-f-]{36})$/i;

/**
 * Consent card of a plugin (`plugin-secret:<id>:<NAME>`, TODO #597): it opens
 * the Secrets page, grant prefilled, to confirm. The anchor stays the one that
 * closes the card. A secret name never has a `:`, so the last one separates
 * the plugin id from the name.
 */
const PLUGIN_SECRET_ANCHOR = /^plugin-secret:(.+):([A-Z][A-Z0-9_]*)$/;
