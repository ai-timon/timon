'use client';

/** What a `forge.publish.dialog` occupant reads (`publish-dialog.tsx`): the text and the gestures. */

import { createContext, useContext } from 'react';
import type { bodyProblem, ForgeProposal, ForgeTargetType } from './forge-proposals-api';

export type PublishBusy = 'publish' | 'save' | 'discard' | null;

export type PublishDialogValue = {
  project: string;
  /** Null while a new comment is written: it becomes a proposal when saved or published. */
  proposal: ForgeProposal | null;
  /** True until the proposal and the project's account are read. */
  loading: boolean;
  repo: string | null;
  target: { type: ForgeTargetType; number: number; url: string | null };
  /** The account the project publishes as; null when none is set (publishing is then refused). */
  account: string | null;
  /** The text as it would leave, edits included. */
  body: string;
  setBody: (body: string) => void;
  /** False for a branch update: its text is the daemon's, published as is. */
  editable: boolean;
  /** Why the daemon would refuse the text, before it is sent. */
  problem: ReturnType<typeof bodyProblem>;
  busy: PublishBusy;
  /** The last refusal, in the reader's language. */
  error: string | null;
  /** Sends the text as it stands to GitHub, as the project's account. Each
   *  gesture resolves `true` once the daemon took it, `false` on a refusal. */
  publish: () => Promise<boolean>;
  /** Keeps the text for later, unpublished. */
  save: () => Promise<boolean>;
  /** "Do not publish": the proposal closes, nothing reaches GitHub. */
  discard: () => Promise<boolean>;
  close: () => void;
};

export const PublishDialogContext = createContext<PublishDialogValue | null>(null);

/** The publication a `forge.publish.dialog` occupant paints, and its gestures. */
export function usePublishDialog(): PublishDialogValue | null {
  return useContext(PublishDialogContext);
}
