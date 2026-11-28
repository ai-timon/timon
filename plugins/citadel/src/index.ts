/**
 * Citadel — host half: a read-only snapshot of the agents, projects, missions and pending
 * questions (`GET /state`) and two allow-listed binary assets (`GET /assets/:name`).
 */
import { readFile } from 'node:fs/promises';
import type { PluginContext } from '@timon-ai/sdk';
import { normalizeAgent, normalizeProject, filterMissions, normalizeQuestions } from './state.js';
import type { AgentRow, ProjectRow, MissionRow, QuestionRow } from './state.js';

export const name = 'citadel';

/** Strict allow-list: served name → [file, content type]. mascot3d.json holds the 3D Tims. */
const ASSETS = new Map<string, readonly [URL, string]>([
  ['office.glb', [new URL('../assets/office.glb', import.meta.url), 'model/gltf-binary']],
  ['mascot3d.json', [new URL('../assets/mascot3d.json', import.meta.url), 'application/json']],
]);
const errText = (e: unknown): string => String(e instanceof Error ? e.message : e).slice(0, 120);

export interface CitadelState {
  generated_at: string;
  agents: AgentRow[];
  projects: ProjectRow[];
  missions: MissionRow[];
  questions: QuestionRow[];
  errors: string[];
}
/** The slice of the plugin context the snapshot reads. */
type StateSource = Pick<PluginContext, 'agents' | 'projects' | 'missions' | 'questions'>;

/** Read-only snapshot: one try/catch per source, never throws. Agent look and avatar come from the SDK (ctx.agents.list). */
export async function buildState(ctx: StateSource, now = Date.now()): Promise<CitadelState> {
  const errors: string[] = [];
  const load = async (label: string, fn: () => Promise<unknown>): Promise<unknown[]> => {
    try { const v = await fn(); return Array.isArray(v) ? v : []; }
    catch (e) { errors.push(label + ': ' + errText(e)); return []; }
  };
  const [agents, projects, missions, questions] = await Promise.all([
    load('agents', () => ctx.agents.list()),
    load('projects', () => ctx.projects.list()),
    load('missions', () => ctx.missions.list({ limit: 300 })),
    load('questions', () => ctx.questions.list({ limit: 100 })),
  ]);
  return {
    generated_at: new Date(now).toISOString(),
    agents: agents.map(normalizeAgent).filter((a): a is AgentRow => a !== null),
    projects: projects.map(normalizeProject).filter((p): p is ProjectRow => p !== null),
    missions: filterMissions(missions, now),
    questions: normalizeQuestions(questions),
    errors,
  };
}

export function apply(ctx: PluginContext): void {
  const router = ctx.router();
  router.get('/state', async (_req, res) => {
    if (!ctx.user()) { res.status(401).json({ error: 'Authentication required' }); return; }
    res.json(await buildState(ctx));
  });
  router.get('/assets/:name', async (req, res) => {
    if (!ctx.user()) { res.status(401).json({ error: 'Authentication required' }); return; }
    const entry = ASSETS.get(String(req.params.name));
    if (!entry) { res.status(404).json({ error: 'Not found' }); return; }
    const [url, type] = entry;
    try {
      const buf = await readFile(url);
      res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' });
      res.send(buf);
    } catch { res.status(404).json({ error: 'Not found' }); }
  });
}
