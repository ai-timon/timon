/**
 * Who a person uses Timon for, as they answered in the onboarding: for
 * themselves, for their team or company, or for an agency and its clients.
 * One row per account (`onboarding.usage_kind`), next to the onboarding
 * profile, and optional: an account that skipped the question has no row.
 *
 * It lives in the core rather than in the settings module because three
 * modules read it: the settings routes write it, product analytics segments
 * by it (an enum, never anything else about the account), and the agency
 * offer is only open to an `agency` answer.
 */
import { z } from 'zod';
import { bus } from './bus.js';
import { dbApi } from './db.js';

export const USAGE_KIND_SCOPE = 'onboarding.usage_kind';
export const USAGE_KINDS = ['solo', 'team', 'agency'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const UsageKindSchema = z.enum(USAGE_KINDS);

export type StoredUsageKind = { usageKind: UsageKind; at: number };

export function isUsageKind(value: unknown): value is UsageKind {
  return UsageKindSchema.safeParse(value).success;
}

export function readUsageKind(owner: string): StoredUsageKind | null {
  const raw = dbApi.uiLayoutGetOwn(owner, USAGE_KIND_SCOPE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredUsageKind>;
    if (!isUsageKind(parsed.usageKind)) return null;
    return { usageKind: parsed.usageKind, at: typeof parsed.at === 'number' ? parsed.at : 0 };
  } catch {
    return null;
  }
}

/**
 * Records the answer and announces it on the bus when it is new or differs
 * from the previous one: analytics counts choices and changes, not saves.
 */
export function writeUsageKind(owner: string, usageKind: UsageKind): StoredUsageKind {
  const before = readUsageKind(owner);
  const stored: StoredUsageKind = { usageKind, at: Date.now() };
  dbApi.uiLayoutSet(owner, USAGE_KIND_SCOPE, JSON.stringify(stored));
  if (before?.usageKind !== usageKind) {
    try {
      bus.publish({ kind: 'usage_kind_set', usageKind, userId: owner });
    } catch {
      /* the answer is stored; its announcement is best effort */
    }
  }
  return stored;
}

/**
 * The answer of the installation's first account, the one that ran the
 * onboarding: what analytics segments an installation by. `null` when it
 * skipped the question or nobody signed up yet.
 */
export function installationUsageKind(): UsageKind | null {
  try {
    const first = dbApi.listUsers()[0];
    return first ? readUsageKind(first.id)?.usageKind ?? null : null;
  } catch {
    return null;
  }
}
