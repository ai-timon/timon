/**
 * The dry run / real run behind `POST /api/triggers/:id/test`, shared with
 * `ctx.triggers.test`. Who may *execute* is the caller's business and comes in
 * as `mayExecute`: a route checks its request, a plugin its manifest and caller.
 */
import { runActions } from './actions.js';
import { scheduleInput } from './engine.js';
import { evaluateFilter } from './filter.js';
import { TRIGGER_HOOK_BODY_LIMIT } from './hook-path.js';
import type { testTriggerSchema } from './schema.js';
import { publicHeaders } from './signature.js';
import { excerptOf, recordDelivery, type Trigger } from './store.js';
import type { z } from 'zod';
import type { TriggerTestResult } from '../plugins/contract/automation.js';
export type { TriggerTestResult } from '../plugins/contract/automation.js';

export type TriggerTestBody = z.infer<typeof testTriggerSchema>;
export type TriggerTestRefusal = { status: number; error: string };
/** The refusal this module makes itself, beside whatever `mayExecute` answers. */
export type TriggerTestTooLarge = { status: 413; error: string };

/** Generic over the caller's refusal: a route answers a coded body, a plugin facade a plain message. */
export function runTriggerTest<R extends { status: number } = TriggerTestRefusal>(
  trigger: Trigger, body: TriggerTestBody, mayExecute: () => R | null,
): { refused: R | TriggerTestTooLarge } | { result: TriggerTestResult } {
  const payload = body.payload ?? {};
  if (Buffer.byteLength(JSON.stringify(payload) ?? '') > TRIGGER_HOOK_BODY_LIMIT) {
    return { refused: { status: 413, error: 'payload too large' } };
  }
  const input = trigger.source === 'schedule'
    ? scheduleInput(trigger, Date.now())
    : { body: payload, headers: publicHeaders(body.headers ?? {}) };
  if (trigger.source !== 'schedule' && !evaluateFilter(trigger.filter, input)) {
    return { result: { status: 'ignored', reason: 'filter' } };
  }
  if (!body.execute) {
    return { result: { status: 'dry_run', outcomes: runActions(trigger, input, { dryRun: true }) } };
  }
  const denied = mayExecute();
  if (denied) return { refused: denied };
  const outcomes = runActions(trigger, input);
  const failed = outcomes.filter((o) => !o.ok);
  recordDelivery({
    triggerId: trigger.id, status: 'test', result: outcomes,
    reason: failed.length ? `${failed.length} action(s) failed` : null,
    excerpt: excerptOf(input.body),
  });
  return { result: { status: failed.length ? 'error' : 'received', outcomes } };
}
