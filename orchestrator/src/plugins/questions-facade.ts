/**
 * `ctx.questions` (API 10): the questions agents ask the human (`question`,
 * `kanban_plan`) that wait for an answer, as the CALLER sees them — what an
 * inbox plugin lists across every project and answers on the user's behalf.
 *
 * Bounded by the missions the caller can read, like `GET /api/permissions`
 * (SECU-USERS U-1): in a request, that account's missions; in a job, the
 * missions owned by `plugin:<id>`. A card on a mission outside that view
 * answers as one that does not exist. Only `ask_user` forms are questions; a
 * tool-use approval (Allow / Deny) is not listed and cannot be resolved here
 * (`ctx.approvals`). `resolve` accepts an optional `relayedVia`, journaled
 * next to the plugin with the account of the request.
 *
 * `resolve` goes through `resolvePermission`, the function the route calls, so
 * the card closes, the agent resumes and the events fire exactly as for a click.
 * The answer is checked first against what the card asked: `resolvePermission`
 * turns a malformed series plan into a refusal sent to the agent, which a
 * plugin must get as an error instead.
 */
import { getAgent } from '../agent.js';
import { type DbViewer } from '../db.js';
import {
  DENY_REASONS, getPending, listPending, questionSnapshot, resolvePermission,
} from '../permissions.js';
import type { QuestionSnapshot } from '../question-bus.js';
import { planGroupNames, validateSeriesPlanAnswer, type SeriesPlanAnswer } from '../series-plan.js';
import { scopedDb } from '../users/scoped-db.js';
import { parseRelayedVia } from './relayed-via.js';

import type {
  PluginQuestionOptionActor, PluginQuestion, PluginQuestionAnswer, PluginQuestionResolution,
  PluginQuestionListFilter, PluginQuestionErrorCode,
} from './contract/questions.js';
export type {
  PluginQuestionOptionActor, PluginQuestionOption, PluginQuestionItem, PluginQuestionPlan,
  PluginQuestion, PluginQuestionAnswerValue, PluginQuestionAnswer, PluginQuestionResolution,
  PluginQuestionListFilter, PluginQuestionErrorCode,
} from './contract/questions.js';

export class PluginQuestionError extends Error {
  constructor(readonly code: PluginQuestionErrorCode, message: string = code) {
    super(message);
    this.name = 'PluginQuestionError';
  }
}

export type ScopedQuestions = {
  list(filter?: PluginQuestionListFilter): PluginQuestion[];
  get(id: string): PluginQuestion | undefined;
  resolve(id: string, answer: PluginQuestionAnswer): PluginQuestionResolution;
};

export type QuestionCallerScope = {
  pluginId: string;
  viewer: DbViewer | null;
  /** Account of the request, when this call relays a person's answer. */
  decidedByUserId: string | null;
};

const MAX_ANSWER_CHARS = 8_000;
const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** An actor outside the closed list shows no badge: refusing the whole question over it would cost the user their answer. */
const optionActor = (v: unknown): PluginQuestionOptionActor | null => (v === 'agent' || v === 'user' ? v : null);
const isAnswerText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= MAX_ANSWER_CHARS;

/** The card as a plugin reads it: a whitelist of what the form shows, nothing of the agent's wider payload. */
export function projectQuestion(card: QuestionSnapshot): PluginQuestion {
  const input = isRecord(card.input) ? card.input : {};
  const base = { id: card.id, missionId: card.missionId, agent: card.agent, kind: card.kind, createdAt: card.createdAt, expiresAt: card.expiresAt };
  if (card.kind === 'series_plan') {
    const form = isRecord(input.form) ? input.form : {};
    const volets = Array.isArray(form.volets) ? form.volets : [];
    return Object.freeze({
      ...base,
      questions: Object.freeze([]),
      plan: Object.freeze({
        title: asString(form.chantier) ?? '',
        volets: Object.freeze(volets.filter(isRecord).map((v) => Object.freeze({
          title: asString(v.title) ?? '', description: asString(v.description), group: asString(v.group),
        }))),
      }),
    });
  }
  const questions = (Array.isArray(input.questions) ? input.questions : []).filter(isRecord).map((q) =>
    Object.freeze({
      question: asString(q.question) ?? '',
      header: asString(q.header),
      options: Object.freeze((Array.isArray(q.options) ? q.options : []).filter(isRecord).map((o) =>
        Object.freeze({ label: asString(o.label) ?? '', description: asString(o.description), actor: optionActor(o.actor) }))),
      multiSelect: q.multiSelect === true,
      placeholder: asString(q.placeholder),
    }));
  return Object.freeze({ ...base, questions: Object.freeze(questions), plan: null });
}

/** Defect of `answer` against the form `card` holds, or `null`. */
function answerDefect(card: PluginQuestion, answer: Record<string, unknown>): string | null {
  if (card.kind === 'series_plan') {
    if (answer.plan === undefined) return 'this question is a Kanban plan: answer with `{ plan }` or `{ cancel: true }`';
    return validateSeriesPlanAnswer(answer.plan, planGroupNames(card.plan?.volets ?? []));
  }
  if (answer.plan !== undefined) return 'this question is a form: answer with `{ answers }` or `{ cancel: true }`';
  if (!isRecord(answer.answers)) return '`answers` must be an object keyed by the text of each question';
  if (answer.note !== undefined && typeof answer.note !== 'string') return '`note` must be a string';
  const byText = new Map(card.questions.map((q) => [q.question, q]));
  for (const key of Object.keys(answer.answers)) {
    if (!byText.has(key)) return `unknown question: ${key.slice(0, 80)}`;
  }
  for (const q of card.questions) {
    const value = answer.answers[q.question];
    const where = `answer to "${q.question.slice(0, 48)}"`;
    if (value === undefined) return `${where} is missing`;
    if (isRecord(value)) {
      const extra = Object.keys(value).find((k) => k !== 'choice' && k !== 'choices' && k !== 'text');
      if (extra) return `${where}: unknown field \`${extra.slice(0, 40)}\` (expected \`choice\`, \`choices\` and \`text\`)`;
      if (!isAnswerText(value.text)) return `${where}: \`text\` must be a non-empty string`;
      if (value.choice !== undefined && value.choices !== undefined) return `${where}: give \`choice\` or \`choices\`, not both`;
      if (value.choice !== undefined && !isAnswerText(value.choice)) return `${where}: \`choice\` must be a non-empty string`;
      if (value.choices !== undefined) {
        if (!q.multiSelect) return `${where}: \`choices\` is accepted only on a multi-select question`;
        if (!Array.isArray(value.choices) || value.choices.some((v) => !isAnswerText(v))) {
          return `${where}: each of \`choices\` must be a non-empty string`;
        }
      }
    } else if (Array.isArray(value)) {
      if (!q.multiSelect) return `${where}: a list is accepted only on a multi-select question`;
      if (value.some((v) => typeof v !== 'string' || v.trim() === '' || v.length > MAX_ANSWER_CHARS)) {
        return `${where}: each choice must be a non-empty string`;
      }
    } else if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_ANSWER_CHARS) {
      return `${where} must be a non-empty string`;
    }
  }
  if (typeof answer.note === 'string' && answer.note.length > MAX_ANSWER_CHARS) return '`note` is too long';
  return null;
}

export function questionsFor(scope: QuestionCallerScope): ScopedQuestions {
  const { pluginId, viewer, decidedByUserId } = scope;
  const visible = (card: QuestionSnapshot): boolean => !!scopedDb(viewer).getMission(card.missionId);
  const open = (id: unknown): QuestionSnapshot | undefined => {
    if (typeof id !== 'string') return undefined;
    const p = getPending(id);
    const card = p && questionSnapshot(p);
    return card && visible(card) ? card : undefined;
  };

  return {
    list(filter = {}) {
      const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100)));
      const kinds = filter.kinds;
      if (kinds !== undefined && (!Array.isArray(kinds) || kinds.some((k) => k !== 'question' && k !== 'series_plan'))) {
        throw new PluginQuestionError('invalid', "`kinds` accepts 'question' and 'series_plan'");
      }
      if (filter.project !== undefined && typeof filter.project !== 'string') throw new PluginQuestionError('invalid', '`project` must be a string');
      const out: PluginQuestion[] = [];
      for (const p of listPending()) {
        const card = questionSnapshot(p);
        if (!card || (kinds && !kinds.includes(card.kind)) || !visible(card)) continue;
        if (filter.project !== undefined && getAgent(card.agent)?.project !== filter.project) continue;
        out.push(projectQuestion(card));
      }
      return out.sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
    },
    get(id) {
      const card = open(id);
      return card ? projectQuestion(card) : undefined;
    },
    resolve(id, answer) {
      const card = open(id);
      // Unknown, already answered and foreign answer the same: nothing to resolve.
      if (!card) throw new PluginQuestionError('not_found', 'question not found (already answered or expired)');
      const raw: unknown = answer;
      if (!isRecord(raw)) throw new PluginQuestionError('invalid', 'the answer must be an object');
      const relayed = parseRelayedVia(raw.relayedVia);
      if (!relayed.ok) throw new PluginQuestionError('invalid', relayed.message);
      const cancel = raw.cancel === true;
      if (!cancel) {
        const defect = answerDefect(projectQuestion(card), raw);
        if (defect) throw new PluginQuestionError('invalid', defect);
      }
      const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : undefined;
      const decision = cancel
        ? { behavior: 'deny' as const, message: DENY_REASONS.formCancelled }
        : card.kind === 'series_plan'
          ? { behavior: 'allow' as const, updatedInput: { plan: raw.plan, note: (raw.plan as SeriesPlanAnswer).note } }
          : { behavior: 'allow' as const, updatedInput: { answers: raw.answers, note } };
      const ok = resolvePermission(card.id, decision, 'plugin', { kind: 'plugin', id: pluginId }, {
        decidedBy: decidedByUserId ? { kind: 'user', id: decidedByUserId } : null,
        relayedVia: relayed.value,
      });
      if (!ok) throw new PluginQuestionError('not_found', 'question not found (already answered or expired)');
      return Object.freeze({ id: card.id, status: cancel ? 'cancelled' : 'answered' });
    },
  };
}
