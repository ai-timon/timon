/**
 * The address that opens "Publish on GitHub" over any page
 * (`?forge-proposal=<id>&forge-project=<slug>`), read by
 * `ForgeProposalDialogHost` and written by a notification card or a row with
 * no dialog of its own. Kept apart from the host so a TO DO row does not load it.
 */

export const FORGE_PROPOSAL_PARAM = 'forge-proposal';
export const FORGE_PROJECT_PARAM = 'forge-project';

const ID = /^[0-9a-f-]{36}$/i;
const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

/** Whether the two values name a proposal the host may open. */
export function isProposalAddress(project: string, id: string): boolean {
  return ID.test(id) && SLUG.test(project);
}

/**
 * Opens a proposal over the current page: the address asks the host.
 * `pushState` is enough, Next follows it, and Back closes the dialog.
 */
export function openForgeProposal(project: string, id: string): void {
  if (!isProposalAddress(project, id)) return;
  const url = new URL(window.location.href);
  url.searchParams.set(FORGE_PROPOSAL_PARAM, id);
  url.searchParams.set(FORGE_PROJECT_PARAM, project);
  window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
