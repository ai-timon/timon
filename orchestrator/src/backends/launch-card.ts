/**
 * The card a refused third-party launch raises (TODO #598, follow-up of #531 3-B).
 *
 * `assertLaunchAuthorized` refuses a mission whose program is not the file the operator authorized: a
 * link retargeted, an allowlist entry withdrawn, a program moved. The refusal reached the mission's own
 * error only, and the operator had to work out where the re-authorization lives. The card names the
 * backend and the reason, and opens Settings › AI models › Backends on the provider
 * (`notificationHref`, `provider-launch:<pluginId>`), where the authorization is a click on a dialog
 * that shows the path the DAEMON resolved. The card informs; it never authorizes anything itself.
 *
 * One card per plugin and process, replacing the previous boot's rather than stacking: a provider that
 * keeps failing at every turn must not bury the centre. A launch of that plugin that goes through, or an
 * authorization given from the providers page, closes it.
 */
import { daemonMessage } from '../daemon-message.js';

const CARD_PREFIX = 'provider-launch:';
/** Plugins whose card was raised in this process. */
const CARDED = new Set<string>();
/** Plugins whose card was looked for and closed since their last refusal. */
const CLEARED = new Set<string>();

export function launchCardAnchor(pluginId: string): string {
  return `${CARD_PREFIX}${pluginId}`;
}

/** Test seam: forget the cards raised and closed in this process. */
export function resetLaunchCards(): void {
  CARDED.clear();
  CLEARED.clear();
}

/**
 * Card writes, one after the other, as in `plugins/policy.ts`: a close queued after a raise must land
 * after it, or the card it answers would stay open. Never rejects.
 */
let cardWrites: Promise<void> = Promise.resolve();
function queueCardWrite(write: (notifications: typeof import('../notifications.js')) => unknown): void {
  cardWrites = cardWrites
    .then(() => import('../notifications.js'))
    .then((notifications) => { write(notifications); })
    .catch(() => { /* no notification subsystem here: the refusal stands either way */ });
}

/**
 * Resolves once every card raised or closed so far is written. Callers keep firing and forgetting;
 * tests await this instead of polling: under load the `import()` above lands after the launch has
 * returned, and a poll then reads the card an earlier refusal left open (TODO #656).
 */
export function launchCardsSettled(): Promise<void> {
  return cardWrites;
}

/**
 * Fire-and-forget, like the spawn card (`plugins/policy.ts`): a notification centre that is absent
 * (CLI, tests) must not turn a refusal into a crash, and the refusal stands either way. Paths and names
 * only — what the refusal itself says.
 */
export function raiseLaunchCard(pluginId: string, backend: string, reason: string): void {
  if (CARDED.has(pluginId)) return;
  CARDED.add(pluginId);
  CLEARED.delete(pluginId);
  const anchor = launchCardAnchor(pluginId);
  queueCardWrite(({ createNotification, resolveAnchor }) => {
    resolveAnchor(anchor);
    createNotification({
      type: 'action_required',
      urgent: true,
      title: `Backend \`${backend}\` was not started: its program needs your authorization`,
      body: `${reason} Open this card to review the program on the provider's page `
        + '(Settings › AI models › Backends) and authorize it again if it is the one you expect.',
      message: daemonMessage('backend_launch_unauthorized', { backend, reason }),
      source: `plugin:${pluginId}`,
      anchor,
    });
  });
}

/**
 * The plugin's program launched, or the operator authorized it: the card is answered, and a later
 * refusal may raise a new one. `force` skips the once-per-process guard (an authorization is rare and
 * must close a card a previous boot raised).
 */
export function clearLaunchCard(pluginId: string, options: { force?: boolean } = {}): void {
  if (!options.force && CLEARED.has(pluginId)) return;
  CLEARED.add(pluginId);
  CARDED.delete(pluginId);
  queueCardWrite(({ resolveAnchor }) => resolveAnchor(launchCardAnchor(pluginId)));
}

/**
 * The plugin is gone (TODO #663): the card sends the operator to a provider page that no longer exists,
 * to authorize a program for an id nobody installed any more. Forgets what this process carded, so a
 * reinstall's first refusal raises a card of its own. Awaitable: the CLI exits right after. Called by the
 * remover, then by the daemon once it sees the package gone (only it can close the card on the devices).
 */
export function closePluginLaunchCard(pluginId: string): Promise<void> {
  CARDED.delete(pluginId);
  CLEARED.delete(pluginId);
  queueCardWrite(({ resolveGoneAnchor }) => resolveGoneAnchor(launchCardAnchor(pluginId)));
  return launchCardsSettled();
}
