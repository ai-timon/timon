// Pure logic of the /state route: filtering and normalisation. No I/O, never throws.

/** Source row of a Timon facade: untrusted shape, read key by key. */
export type Row = Record<string, unknown>;

export const RECENT_MS = 30 * 60 * 1000;
export const TEXT_MAX = 160;
const KEPT_STATUS = new Set(['running', 'waiting']);

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Collapses whitespace and cuts to `max` characters (ellipsis included). */
export function clip(v: unknown, max = TEXT_MAX): string {
  if (typeof v !== 'string') return '';
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export const LOOK_SHAPES = ['bean', 'cloud', 'gem', 'hex', 'round', 'squircle', 'tri'];
export const LOOK_EYES = ['pill', 'happy', 'wink', 'big', 'sleepy', 'sad', 'angry', 'surprised', 'heart', 'star', 'x', 'dots', 'code', 'squint', 'quizzical', 'skeptic'];

/** Look of a Tim: shape and colour are required, the rest falls back to a default. */
export interface Look { shape: string; color: string; eyes: string; acc: string }

/** Look of a Tim {shape,color,eyes,acc}: keeps valid values only; null when unusable (shape and colour required). */
export function normalizeLook(l: unknown): Look | null {
  if (!isRow(l)) return null;
  const { shape, color, eyes, acc } = l;
  if (typeof shape !== 'string' || !LOOK_SHAPES.includes(shape) || typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  return {
    shape, color: color.toLowerCase(),
    eyes: typeof eyes === 'string' && LOOK_EYES.includes(eyes) ? eyes : 'pill',
    acc: typeof acc === 'string' && /^[a-z_]{1,20}$/.test(acc) ? acc : 'none',
  };
}

export interface AgentRow {
  name: string; role: string | null; project: string | null; reports_to: string | null; orchestrator: string | null;
  icon_url: string | null; main: boolean; look: Look | null;
}
export function normalizeAgent(a: unknown): AgentRow | null {
  if (!isRow(a) || typeof a.name !== 'string') return null;
  return {
    name: a.name,
    role: str(a.role),
    project: str(a.project),
    reports_to: str(a.reports_to ?? a.reportsTo),
    orchestrator: str(a.orchestrator),
    icon_url: str(a.icon_url ?? a.iconUrl),
    main: a.main === true || a.is_main === true || a.isMain === true,
    look: normalizeLook(a.look),
  };
}

export interface ProjectRow { slug: string; name: string; color: string | null; icon: string | null; workspace: string | null }
export function normalizeProject(p: unknown): ProjectRow | null {
  if (!isRow(p) || typeof p.slug !== 'string') return null;
  return { slug: p.slug, name: str(p.name) ?? p.slug, color: str(p.color), icon: str(p.icon), workspace: str(p.workspace) };
}

export interface MissionRow {
  id: string; agent_name: string; status: string; title: string; started_at: number | null; ended_at: number | null; turn_active: boolean;
}
/** Keeps running/waiting missions and those ended less than 30 min ago. */
export function filterMissions(rows: unknown, now = Date.now(), recentMs = RECENT_MS): MissionRow[] {
  const out: MissionRow[] = [];
  for (const m of Array.isArray(rows) ? rows : []) {
    if (!isRow(m) || typeof m.id !== 'string') continue;
    const agent = str(m.agent_name ?? m.agent);
    if (!agent) continue;
    const status = str(m.status) ?? 'unknown';
    const ended = num(m.ended_at ?? m.endedAt);
    if (!KEPT_STATUS.has(status) && !(ended !== null && now - ended < recentMs)) continue;
    const title = clip(str(m.task_title) ?? str(m.title) ?? '', 80);
    out.push({
      id: m.id, agent_name: agent, status, title,
      started_at: num(m.started_at ?? m.startedAt), ended_at: ended,
      turn_active: typeof m.turn_active === 'boolean'
        ? m.turn_active
        : status === 'running' && ended === null && (typeof m.last_user_id === 'number' && typeof m.last_result_id === 'number' ? m.last_user_id > m.last_result_id : true),
    });
  }
  return out;
}

export interface QuestionRow { id: string; agent_name: string; mission_id: string | null; text: string }
/** Pending questions as {id, agent_name, mission_id, text ≤ 160}. */
export function normalizeQuestions(rows: unknown): QuestionRow[] {
  const out: QuestionRow[] = [];
  for (const q of Array.isArray(rows) ? rows : []) {
    if (!isRow(q) || typeof q.id !== 'string') continue;
    const agent = str(q.agent ?? q.agent_name);
    if (!agent) continue;
    const first = Array.isArray(q.questions) ? q.questions.find((x: unknown): x is Row => isRow(x) && typeof x.question === 'string' && x.question !== '') : undefined;
    const plan = isRow(q.plan) ? q.plan : null;
    const text = first ? String(first.question) : (plan && typeof plan.title === 'string' ? plan.title : (typeof q.text === 'string' ? q.text : ''));
    out.push({ id: q.id, agent_name: agent, mission_id: str(q.missionId ?? q.mission_id), text: clip(text) });
  }
  return out;
}
