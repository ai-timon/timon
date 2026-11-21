// Pure logic (no I/O, no DOM): Timon state (GET /state) → Citadel model.
import { t } from './i18n.js';
import { normalizeLook } from './state.js';
import type { Look } from './state.js';

export const FAIL_STATUSES = ['error', 'failed', 'timeout', 'interrupted', 'denied'];
export const ERR_WINDOW_MS = 30 * 60 * 1000;
/** Key of the space that holds projects without a workspace (its label is translated). */
export const UNASSIGNED_SPACE = '@unassigned';
export const ORPHAN_SLUG = '@no-project';
export const ORPHAN_COLOR = '#8e8e93';

/** Agent as the /state route sends it. */
export interface StateAgent {
  name: string; role?: string | null; project?: string | null; reports_to?: string | null; orchestrator?: string | null;
  icon_url?: string | null; main?: boolean; look?: unknown;
}
/** Project as the /state route sends it. */
export interface StateProject { slug: string; name?: string | null; color?: string | null; icon?: string | null; workspace?: string | null; status?: string | null }
/** Mission as the /state route sends it (times are tolerated as ms, seconds or ISO). */
export interface StateMission { id?: string | null; agent_name: string; status: string; title?: string | null; started_at?: unknown; ended_at?: unknown }
export interface StateQuestion { id?: string; agent_name: string; mission_id?: string | null; text?: string }
export interface StateInput {
  agents?: StateAgent[]; projects?: StateProject[]; missions?: StateMission[]; questions?: StateQuestion[]; errors?: string[];
}

export type AgentStateName = 'work' | 'wait' | 'err' | 'rest';
export type AgentKind = 'crew' | 'central' | 'pilot' | 'captain';
export interface ModelAgent {
  name: string; role: string; icon: string | null; project: string | null; space: string | null; kind: AgentKind; main: boolean;
  reports_to: string | null; look: Look; state: AgentStateName; text: string; since: number; missionId: string | null;
}
export interface ModelProject {
  slug: string; name: string; color: string; icon: string | null; space: string; pilot: string | null; crew: string[]; orphan: boolean;
}
export interface ModelSpace { key: string; name: string; projects: string[]; captain: string | null }
export interface Model { spaces: ModelSpace[]; projects: ModelProject[]; agents: ModelAgent[]; central: string[]; questions: StateQuestion[] }

// Ignores accents, dashes, spaces and case: "On-line", "on line" and "Online" are the same name.
export const normName = (s: unknown): string => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s_-]+/g, '').toLowerCase();

/** Tolerant timestamp: ms, Unix seconds, ISO; null when unknown. */
export function toMs(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e11 ? v * 1000 : v) : null;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e11 ? n * 1000 : n;
  const ms = Date.parse(String(v));
  return Number.isNaN(ms) ? null : ms;
}

export interface AgentStatus { state: AgentStateName; text: string; since: number; missionId: string | null }

const byStartDesc = (a: StateMission, b: StateMission): number => (toMs(b.started_at) ?? 0) - (toMs(a.started_at) ?? 0);

/** State of an agent from its missions and pending questions. */
export function agentState(name: string, missions: StateMission[], questions: StateQuestion[], now: number): AgentStatus {
  const mine = missions.filter(m => m.agent_name === name);
  const q = questions.find(x => x.agent_name === name);
  const waiting = mine.find(m => m.status === 'waiting');
  if (q || waiting) return { state: 'wait', text: q?.text || waiting?.title || '', since: toMs(waiting?.started_at) ?? now, missionId: q?.mission_id || waiting?.id || null };
  const last = mine.slice().sort(byStartDesc)[0];
  const endedAt = toMs(last?.ended_at);
  if (last && FAIL_STATUSES.includes(last.status) && endedAt !== null && now - endedAt < ERR_WINDOW_MS) return { state: 'err', text: last.title || last.status, since: endedAt, missionId: last.id || null };
  const running = mine.filter(m => m.status === 'running').sort(byStartDesc)[0];
  if (running) return { state: 'work', text: running.title || '', since: toMs(running.started_at) ?? now, missionId: running.id || null };
  return { state: 'rest', text: '', since: 0, missionId: last?.id || null };
}

// Default look of a Tim by role (as in the Timon client: defaultLookFor).
const ROLE_ALIAS: Record<string, string> = { coder: 'code', reviewer: 'review', ops: 'chore' };
const ROLE_EYES: Record<string, string> = { orchestrator: 'pill', research: 'big', review: 'squint', chore: 'pill' };
const ROLE_ACC: Record<string, string> = { orchestrator: 'baton', research: 'loupe', review: 'pen', chore: 'hammer' };
export function defaultLookFor(role: string | null | undefined): Look {
  const r = ROLE_ALIAS[role ?? ''] ?? role ?? '';
  if (r === 'code') return { shape: 'tri', color: '#7ed957', eyes: 'code', acc: 'coffee' };
  const eyes = ROLE_EYES[r];
  if (eyes) return { shape: 'squircle', color: '#7a4f35', eyes, acc: ROLE_ACC[r] ?? 'none' };
  return { shape: 'squircle', color: '#7a4f35', eyes: 'pill', acc: 'none' };
}

/** Builds the model: spaces (ring sectors), projects, placed agents and states. */
export function buildModel(state: StateInput | null | undefined, now = Date.now()): Model {
  const st = state ?? {};
  const stAgents = st.agents ?? [];
  const projects: ModelProject[] = (st.projects ?? []).filter(p => p && p.slug && !String(p.slug).startsWith('-') && (!p.status || p.status === 'active')).map(p => ({
    slug: p.slug, name: p.name || p.slug, color: p.color || ORPHAN_COLOR, icon: p.icon || null,
    space: p.workspace || UNASSIGNED_SPACE, pilot: null, crew: [], orphan: false,
  }));
  const bySlug = new Map(projects.map(p => [p.slug, p]));
  const spaceNames: string[] = [];
  for (const p of projects) if (p.space !== UNASSIGNED_SPACE && !spaceNames.includes(p.space)) spaceNames.push(p.space);
  const hasUnassigned = projects.some(p => p.space === UNASSIGNED_SPACE);
  const missions = st.missions ?? [], questions = st.questions ?? [];

  // No declared main agent: the tower goes to the top of the hierarchy (no manager, most subordinates); the plugin
  // facade gives no reporting line, so otherwise to the first project-less agent whose role is "main"
  const mains = new Set<string>(stAgents.filter(a => a.main).map(a => a.name));
  if (mains.size === 0) {
    const below = new Map<string, number>();
    const count = (n: string): number => {
      const known = below.get(n); if (known !== undefined) return known;
      below.set(n, 0);
      let c = 0;
      for (const x of stAgents) if (x.reports_to === n) c += 1 + count(x.name);
      below.set(n, c);
      return c;
    };
    const roots = stAgents.filter(a => !a.reports_to).map((a): [StateAgent, number] => [a, count(a.name)]).filter(([, c]) => c > 0).sort((x, y) => y[1] - x[1]);
    const lead = roots[0] ? roots[0][0] : stAgents.find(a => a.role === 'main' && !a.project && !String(a.name).includes('.'));
    if (lead) mains.add(lead.name);
  }
  const agents: ModelAgent[] = [];
  const spaceNorm = new Map<string, string>();
  for (const s of [...spaceNames, UNASSIGNED_SPACE]) spaceNorm.set(normName(s), s);
  let needOrphan = false;
  for (const a of stAgents) {
    const isMain = mains.has(a.name);
    let proj = a.project && bySlug.has(a.project) ? a.project : null;
    if (!proj) { const pre = String(a.name).split('.')[0] ?? ''; if (String(a.name).includes('.') && bySlug.has(pre)) proj = pre; }
    const ag: ModelAgent = {
      name: a.name, role: a.role || '', icon: a.icon_url || null, project: null, space: null, kind: 'crew', main: isMain, reports_to: a.reports_to || null,
      look: normalizeLook(a.look) ?? defaultLookFor(a.role === 'main' || a.orchestrator ? 'orchestrator' : a.role),
      state: 'rest', text: '', since: 0, missionId: null,
    };
    const project = proj ? bySlug.get(proj) : undefined;
    const captainSpace = spaceNorm.get(normName(a.name));
    if (isMain) {
      ag.kind = 'central';
    } else if (proj && project) {
      ag.project = proj; ag.space = project.space;
      ag.kind = (a.role === 'main' || a.orchestrator) ? 'pilot' : 'crew';
    } else if (captainSpace !== undefined) {
      ag.kind = 'captain'; ag.space = captainSpace;
    } else if (!a.reports_to && mains.size === 0) {
      ag.kind = 'central';
    } else { ag.kind = 'crew'; ag.project = ORPHAN_SLUG; ag.space = UNASSIGNED_SPACE; needOrphan = true; }
    Object.assign(ag, agentState(a.name, missions, questions, now));
    agents.push(ag);
  }
  // Pilot: role main first, else orchestrator; one per project, the others join the crew.
  for (const p of projects) {
    const own = agents.filter(a => a.project === p.slug && a.kind === 'pilot');
    const lead = own.find(a => stAgents.find(x => x.name === a.name)?.role === 'main') ?? own[0];
    for (const a of own) if (a !== lead) a.kind = 'crew';
    p.pilot = lead ? lead.name : null;
  }
  if (needOrphan) {
    const orphan: ModelProject = { slug: ORPHAN_SLUG, name: t('noProject'), color: ORPHAN_COLOR, icon: null, space: UNASSIGNED_SPACE, pilot: null, crew: [], orphan: true };
    projects.push(orphan); bySlug.set(ORPHAN_SLUG, orphan);
  }
  for (const p of projects) p.crew = agents.filter(a => a.project === p.slug && a.name !== p.pilot).map(a => a.name);

  const spaces: ModelSpace[] = [...spaceNames, ...(hasUnassigned || needOrphan ? [UNASSIGNED_SPACE] : [])].map(name => ({
    key: name, name: name === UNASSIGNED_SPACE ? t('unassignedSpace') : name,
    projects: projects.filter(p => p.space === name).map(p => p.slug),
    captain: agents.find(a => a.kind === 'captain' && a.space === name)?.name ?? null,
  }));
  return { spaces, projects, agents, central: agents.filter(a => a.kind === 'central').map(a => a.name), questions: [...questions] };
}

/** Structure signature: when it changes the model is rebuilt; otherwise only the states move. */
export function structureKey(model: Model): string {
  return JSON.stringify([
    model.spaces.map(s => [s.key, s.captain, s.projects]),
    model.projects.map(p => [p.slug, p.name, p.color, p.icon, p.pilot, p.crew]),
    model.agents.map(a => [a.name, a.kind, a.project, a.icon, a.look]),
  ]);
}

export interface JournalRow { name: string; from: AgentStateName; state: AgentStateName; text: string; at: number }
/** State transitions between two models → journal rows (nothing on the first reading). */
export function transitions(prev: Model | null, next: Model, now = Date.now()): JournalRow[] {
  if (!prev) return [];
  const before = new Map(prev.agents.map(a => [a.name, a.state]));
  const out: JournalRow[] = [];
  for (const a of next.agents) {
    const was = before.get(a.name);
    if (was === undefined || was === a.state) continue;
    const verbs: Record<AgentStateName, string> = { rest: t('done'), work: t('starts'), wait: t('waitsYou'), err: t('incident') };
    out.push({ name: a.name, from: was, state: a.state, text: a.state === 'rest' ? t('done') : a.text || verbs[a.state], at: now });
  }
  return out;
}

export interface ProjectSummary { m: ModelAgent[]; act: ModelAgent[]; w: ModelAgent[]; e: ModelAgent[]; line: string }
export function summarize(model: Model, project: ModelProject): ProjectSummary {
  const names = [project.pilot, ...project.crew].filter((n): n is string => !!n);
  const m = names.map(n => model.agents.find(a => a.name === n)).filter((a): a is ModelAgent => a !== undefined);
  const act = m.filter(a => a.state !== 'rest');
  const w = m.filter(a => a.state === 'wait'), e = m.filter(a => a.state === 'err');
  const lead = w[0] ?? e[0] ?? act.slice().sort((x, y) => y.since - x.since)[0];
  const short = lead ? lead.name.replace(project.slug + '.', '') : '';
  return { m, act, w, e, line: lead ? `${short} ${lead.text}`.trim() : t('available', { count: m.length }) };
}
