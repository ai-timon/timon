import { configuredVaultRoot } from './vault-root.js';
/**
 * Dreaming — an agent "dreams" at night and proposes leads to VALIDATE (never to
 * run). Nightly job in 2 phases, after synthesis (3am) + scoring (5am), in
 * a dedicated window so as not to pile the Sonnet/Opus passes on an
 * OOM-prone orchestrator.
 *
 *  - IMPROVE phase: over the top-N projects by score (priority = profitability ×
 *    progress — we do not dream about cold client sites), grounded on the
 *    vault note + the score + the curated rules/pitfalls → improvement axes towards
 *    the user's objectives.
 *  - OPPORTUNITY phase: objectives + vault ideas folder (`wiki/idees`) +
 *    WEB signals (WebSearch/WebFetch) → new veins aligned
 *    with the user's objectives.
 *
 * Guards (inspired by Anthropic "Claude Dreaming", OpenClaw, Stanford
 * Generative Agents): `dream_proposals` review queue, DEDUP against past
 * dreams (otherwise identical re-proposal every night), CAP per night,
 * credit spacing, and above all ZERO auto-task — the agent proposes, the user curates.
 *
 * "The agent dreams": we spawn under its identity (cwd/model), but with a dedicated
 * Dreaming system prompt. Since it is the anti-dispersion agent, its dreams
 * already come out filtered by its discipline (not a firehose of ideas).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dbApi, type ProjectRow } from './db.js';
import { resolveAnchor } from './notifications.js';
import { loadConfig, type AgentConfig } from './agent.js';
import { mainAgentName } from './main-agent.js';
import { searchUnavailableReason } from './web-search.js';
import { oneShotPrompt } from './summary.js';
import { GLOBAL_MEMORY_DIR } from './paths.js';
import { settingBool, settingNum, settingStr } from './settings.js';
import { oneShotTarget } from './backends/index.js';
import { isObjectivesPlaceholder } from './global-digest.js';

// Anti-hang guards (oneShotPrompt is not a tracked mission → no
// reaper). The opportunity runs a web research loop → longer.
const TICK_MS = 30 * 60_000;


const INSTRUCTIONS_FILE = join(GLOBAL_MEMORY_DIR, 'dream-instructions.md');
const CONFIG_FILE = join(GLOBAL_MEMORY_DIR, 'dream-config.json');

const INSTRUCTIONS_TEMPLATE = `# Dreaming directives

<!-- Read EVERY night (and editable from the Dreams tab). Steers the CONTENT of
     the agent's dreams: current focus, angles to dig into, what to avoid. The
     JSON output format stays fixed — you steer the substance, not the plumbing.
     Empty sections, or sections left in (parentheses), are ignored. -->

## General
(directives applied to BOTH phases — e.g. "this month, focus on this market; avoid that topic")

## Improvements
(specific to improving existing projects — e.g. "favour moves doable within 2 weeks")

## Opportunities
(specific to hunting opportunities — e.g. "explore this niche, ignore that sector")
`;
const OBJECTIVES_FILE = join(GLOBAL_MEMORY_DIR, 'objectives.md');
const INDEX_CAP = 2800;
const IDEAS_CAP = 2500;

type Cand = { title: string; body: string; rationale?: string; effort?: string; conviction?: number; sources?: string[]; project?: string };

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function baseCfg(): { name: string; cfg: AgentConfig } {
  // No agent named: the main agent dreams, whatever its owner called it.
  const name = settingStr('TIMON_DREAM_AGENT') || mainAgentName() || '';
  let cfg: AgentConfig;
  try { cfg = loadConfig(name); } catch { cfg = {}; }
  return { name, cfg: { ...cfg, ...oneShotTarget(settingStr('TIMON_DREAM_MODEL')) } };
}

function readObjectives(): string {
  try {
    if (!existsSync(OBJECTIVES_FILE)) return '(not filled in)';
    const b = readFileSync(OBJECTIVES_FILE, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
    return b && !isObjectivesPlaceholder(b) ? b : '(not filled in)';
  } catch { return '(not filled in)'; }
}

function readBrainIndex(slug: string): string {
  try {
    const root = configuredVaultRoot();
    if (!root) return '(vault not configured)';
    const p = join(root, 'wiki', 'projects', slug, '_index.md');
    if (!existsSync(p)) return '(no vault note)';
    const raw = readFileSync(p, 'utf8');
    return raw.length > INDEX_CAP ? raw.slice(0, INDEX_CAP) + '\n… [truncated]' : raw;
  } catch { return '(no vault note)'; }
}

/** Concatenates titles + first paragraphs of the `wiki/idees` notes, capped. */
function readIdeasFolder(): string {
  try {
    const root = configuredVaultRoot();
    if (!root) return '(vault not configured)';
    const IDEAS_DIR = join(root, 'wiki', 'idees');
    if (!existsSync(IDEAS_DIR)) return '(ideas folder empty or missing)';
    const files = readdirSync(IDEAS_DIR).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
    if (!files.length) return '(ideas folder empty)';
    const chunks: string[] = [];
    let total = 0;
    for (const f of files) {
      try {
        const raw = readFileSync(join(IDEAS_DIR, f), 'utf8').replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
        const excerpt = raw.replace(/\s+/g, ' ').trim().slice(0, 280);
        const entry = `- **${f.replace(/\.md$/, '')}** : ${excerpt}`;
        if (total + entry.length > IDEAS_CAP) break;
        chunks.push(entry);
        total += entry.length;
      } catch { /* skip */ }
    }
    return chunks.length ? chunks.join('\n') : '(ideas folder empty)';
  } catch { return '(ideas folder unreadable)'; }
}

function priority(r: ProjectRow): number {
  return Math.round(((r.revenue_potential ?? 0) * (r.progress ?? 0)) / 100);
}

function parseCands(out: string, max: number): Cand[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(out);
  const body = (fenced ? fenced[1]! : out).trim();
  const s = body.indexOf('['); const e = body.lastIndexOf(']');
  if (s < 0 || e < s) return [];
  let arr: unknown;
  try { arr = JSON.parse(body.slice(s, e + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out2: Cand[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const text = typeof o.body === 'string' ? o.body.trim() : '';
    if (!title || !text) continue;
    out2.push({
      title: title.slice(0, 160),
      body: text.slice(0, 1200),
      rationale: typeof o.rationale === 'string' ? o.rationale.trim().slice(0, 400) : undefined,
      effort: typeof o.effort === 'string' && /^[SML]$/i.test(o.effort.trim()) ? o.effort.trim().toUpperCase() : undefined,
      conviction: typeof o.conviction === 'number' ? Math.max(0, Math.min(100, Math.round(o.conviction))) : undefined,
      sources: Array.isArray(o.sources) ? (o.sources.filter((u) => typeof u === 'string') as string[]).slice(0, 6) : undefined,
      project: typeof o.project === 'string' ? o.project.trim().slice(0, 60) : undefined,
    });
    if (out2.length >= max) break;
  }
  return out2;
}

const IMPROVE_SYSTEM = `You are the user's strategic advisor (their ultimate goal is described in their objectives grid). This is your nightly "dreaming" phase: you think hard about ONE project to propose its next highest-leverage moves towards their objectives.

You are given: the user's objectives grid, the project sheet (vault note + revenue/progress score + curated rules/pitfalls), and the list of ideas ALREADY proposed (do NOT repeat them).

Propose 1 to ${settingNum('TIMON_DREAM_IMPROVE_PER_PROJECT')} CONCRETE, actionable improvement axes that bring the project closer to its objectives. No generalities ("improve the UX"): precise moves ("add the Stripe paywall on X to monetise the current Y users"). Each axis must pass your own anti-dispersion test: does it serve the ultimate goal, is it worth the cost? If nothing new deserves proposing, answer "[]".

Write the texts in the language the objectives are written in.

Answer ONLY with a JSON array, nothing else:
[{"title":"short title","body":"the what + the how, concrete","rationale":"why it brings them closer to their objectives","effort":"S|M|L","conviction":0-100}]`;

const OPP_SYSTEM = `You are the user's strategic advisor (their ultimate goal is described in their objectives grid). This is your nightly EXPLORATION "dreaming" phase: you hunt for NEW opportunities aligned with their objectives.

You are given: their objectives, their vault ideas folder, and the opportunities ALREADY proposed (do NOT repeat them). You can and MUST search the web and read sources to rely on real signals (trends, niches, tools, market demand) — not just introspection. Cite your sources.

Propose up to ${settingNum('TIMON_DREAM_OPP_MAX')} opportunities. Each one: a precise and plausible vein, aligned with the ultimate goal, with a realistic first step. Stay DISCIPLINED (you are the anti-dispersion agent): prefer 2 solid tracks to ${settingNum('TIMON_DREAM_OPP_MAX')} hazy ones. If nothing new, answer "[]".

Write the texts in the language the objectives are written in.

Answer ONLY with a JSON array, nothing else:
[{"title":"short title","body":"the vein + the concrete first step","rationale":"why it is aligned with their objectives","effort":"S|M|L","conviction":0-100,"project":"suggested slug or name","sources":["url"]}]`;

function knownBlock(titles: string[]): string {
  if (!titles.length) return '';
  return `\n\n# Already proposed — do NOT repeat:\n${titles.slice(0, 40).map((t) => `- ${t}`).join('\n')}`;
}

// ── Custom directives (hot-editable, file or Dreams tab) ──
/** Creates the dream-instructions.md template if it does not exist. Called at boot. */
export function seedDreamInstructions(): void {
  try {
    if (existsSync(INSTRUCTIONS_FILE)) return;
    mkdirSync(GLOBAL_MEMORY_DIR, { recursive: true });
    writeFileSync(INSTRUCTIONS_FILE, INSTRUCTIONS_TEMPLATE);
  } catch { /* best-effort */ }
}
/** Raw read of the file (for the UI editor). */
export function readDreamInstructionsRaw(): string {
  try { return existsSync(INSTRUCTIONS_FILE) ? readFileSync(INSTRUCTIONS_FILE, 'utf8') : INSTRUCTIONS_TEMPLATE; }
  catch { return INSTRUCTIONS_TEMPLATE; }
}
/** Write (from the UI editor). */
export function writeDreamInstructions(text: string): void {
  mkdirSync(GLOBAL_MEMORY_DIR, { recursive: true });
  writeFileSync(INSTRUCTIONS_FILE, text);
}

/** ON/OFF toggle of dreaming, persistent and read EVERY night (runtime, without
 *  restart) — e.g. disable it during holidays so as not to pile up
 *  leads to handle. Default: enabled (missing file → true). */
export function isDreamEnabled(): boolean {
  try {
    if (!existsSync(CONFIG_FILE)) return true;
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).enabled !== false;
  } catch { return true; }
}
export function setDreamEnabled(enabled: boolean): void {
  mkdirSync(GLOBAL_MEMORY_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ enabled }, null, 2));
}
/** A section content is "real" if it is neither empty nor a placeholder in (parentheses). */
function realSection(s: string): string {
  const t = s.replace(/<!--[\s\S]*?-->/g, '').trim();
  return !t || /^\(.*\)$/s.test(t) ? '' : t;
}
/** Parses the file into {general, improve, opportunity}. Tolerates missing sections. */
function parseInstructions(): { general: string; improve: string; opportunity: string } {
  const raw = readDreamInstructionsRaw().replace(/<!--[\s\S]*?-->/g, '');
  const out = { general: '', improve: '', opportunity: '' };
  // Split on ## headings; what precedes the 1st heading = general.
  const parts = raw.split(/^##\s+/m);
  const preamble = parts.shift() ?? '';
  out.general = realSection(preamble.replace(/^#\s+.*$/m, ''));
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const head = (nl < 0 ? part : part.slice(0, nl)).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();
    const content = realSection(nl < 0 ? '' : part.slice(nl + 1));
    if (!content) continue;
    if (head.startsWith('general')) out.general = [out.general, content].filter(Boolean).join('\n\n');
    else if (head.startsWith('amelior') || head.startsWith('improve')) out.improve = content;
    else if (head.startsWith('opportun')) out.opportunity = content;
  }
  return out;
}
/** Appends the user's directives block to a phase's system prompt. */
function withCustom(base: string, phase: 'improve' | 'opportunity'): string {
  const ins = parseInstructions();
  const blocks = [ins.general, phase === 'improve' ? ins.improve : ins.opportunity].filter(Boolean);
  if (!blocks.length) return base;
  return base +
    `\n\n# THE USER'S CUSTOM DIRECTIVES — they OVERRIDE the general instructions above, BUT you MUST keep the requested JSON output format strictly.\n${blocks.join('\n\n')}`;
}

async function dreamImprove(runId: string): Promise<number> {
  const objectives = readObjectives();
  const projects = dbApi.listProjectRows()
    .filter((r) => (r.status ?? 'active') === 'active' && priority(r) >= settingNum('TIMON_DREAM_MIN_PRIORITY'))
    .sort((a, b) => priority(b) - priority(a))
    .slice(0, settingNum('TIMON_DREAM_IMPROVE_TOP_N'));
  if (!projects.length) { console.log('[dream] improve: no eligible project'); return 0; }
  const { name, cfg } = baseCfg();
  let inserted = 0;
  for (const p of projects) {
    const known = dbApi.recentDreamTitles('improve', settingNum('TIMON_DREAM_DEDUP_DAYS'), p.slug).map(norm);
    const rules = dbApi.listRules({ scope: 'project', project: p.slug }).slice(0, 12).map((r) => `- ${r.text}`).join('\n') || '(none)';
    const pitfalls = dbApi.recentPitfalls(p.slug, 5).map((l) => `- ${l.text}`).join('\n') || '(none)';
    const userMsg =
      `# The user's objectives grid\n${objectives}\n\n` +
      `# Project: ${p.slug} — revenue score ${p.revenue_potential ?? '?'}/100, progress ${p.progress ?? '?'}% (priority ${priority(p)})\n\n` +
      `## Vault note\n${readBrainIndex(p.slug)}\n\n## Curated rules\n${rules}\n\n## Recent pitfalls\n${pitfalls}` +
      knownBlock(dbApi.recentDreamTitles('improve', settingNum('TIMON_DREAM_DEDUP_DAYS'), p.slug));
    let out: string;
    try { out = await oneShotPrompt(name, cfg, userMsg, withCustom(IMPROVE_SYSTEM, 'improve'), undefined, settingNum('TIMON_DREAM_IMPROVE_TIMEOUT_MS')); }
    catch (err) { console.warn(`[dream] improve ${p.slug}: ${(err as Error).message}`); await delay(settingNum('TIMON_DREAM_SPACING_MS')); continue; }
    for (const c of parseCands(out, settingNum('TIMON_DREAM_IMPROVE_PER_PROJECT'))) {
      if (known.includes(norm(c.title))) continue;
      known.push(norm(c.title));
      dbApi.insertDreamProposal({ kind: 'improve', project: p.slug, title: c.title, body: c.body, rationale: c.rationale, effort: c.effort, conviction: c.conviction, runId });
      inserted++;
    }
    console.log(`[dream] improve ${p.slug}: +${inserted}`);
    await delay(settingNum('TIMON_DREAM_SPACING_MS'));
  }
  return inserted;
}

async function dreamOpportunity(runId: string): Promise<number> {
  if (settingNum('TIMON_DREAM_OPP_MAX') <= 0) { console.log('[dream] opportunity: disabled (TIMON_DREAM_OPP_MAX=0)'); return 0; }
  const known = dbApi.recentDreamTitles('opportunity', settingNum('TIMON_DREAM_DEDUP_DAYS')).map(norm);
  const userMsg =
    `# Your objectives (ultimate goal)\n${readObjectives()}\n\n` +
    `# Your vault ideas folder (wiki/idees)\n${readIdeasFolder()}` +
    knownBlock(dbApi.recentDreamTitles('opportunity', settingNum('TIMON_DREAM_DEDUP_DAYS')));
  const { name, cfg } = baseCfg();
  let out: string;
  const searchReason = searchUnavailableReason(cfg);
  if (searchReason) { console.log(`[dream] opportunity: skipped (${searchReason})`); return 0; }
  try { out = await oneShotPrompt(name, cfg, userMsg, withCustom(OPP_SYSTEM, 'opportunity'), ['WebSearch', 'WebFetch'], settingNum('TIMON_DREAM_OPP_TIMEOUT_MS')); }
  catch (err) { console.warn(`[dream] opportunity: ${(err as Error).message}`); return 0; }
  let inserted = 0;
  for (const c of parseCands(out, settingNum('TIMON_DREAM_OPP_MAX'))) {
    if (known.includes(norm(c.title))) continue;
    known.push(norm(c.title));
    dbApi.insertDreamProposal({ kind: 'opportunity', project: c.project ?? null, title: c.title, body: c.body, rationale: c.rationale, effort: c.effort, conviction: c.conviction, sources: c.sources, runId });
    inserted++;
  }
  console.log(`[dream] opportunity: +${inserted}`);
  return inserted;
}

/** Anchor of the "tracks to review" card; the review routes close it when the queue is empty. */
export const DREAMS_ANCHOR = '/dreams';

/** The card has nothing left to ask once no track is waiting for a decision. */
export function closeDreamsCardIfDone(): void {
  if (dbApi.countActiveDreams() === 0) resolveAnchor(DREAMS_ANCHOR);
}

export async function runDreamPass(): Promise<{ improve: number; opportunity: number }> {
  const runId = randomUUID().slice(0, 8);
  console.log(`[dream] nightly pass ${runId} (model ${settingStr('TIMON_DREAM_MODEL')})`);
  const improve = await dreamImprove(runId);
  await delay(settingNum('TIMON_DREAM_SPACING_MS'));
  const opportunity = await dreamOpportunity(runId);
  const total = improve + opportunity;
  if (total > 0) {
    dbApi.createNotification({
      id: randomUUID(),
      type: 'action_required',
      title: `Dreaming: ${total} track(s) to review`,
      body: `${improve} improvement(s) + ${opportunity} opportunity(ies). To approve, reject or snooze.`,
      anchor: DREAMS_ANCHOR,
    });
  }
  console.log(`[dream] pass ${runId} finished: ${improve} improve + ${opportunity} opportunity`);
  return { improve, opportunity };
}

export function startDreamer(): () => void {
  if (!settingBool('TIMON_DREAM_ENABLED')) { console.log('[dream] disabled (TIMON_DREAM_ENABLED=0)'); return () => { /* nothing was started */ }; }
  let lastRunDay = '';
  const tick = () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const h = now.getHours();
    if (day === lastRunDay) return;
    if (h < settingNum('TIMON_DREAM_HOUR') || h >= settingNum('TIMON_DREAM_HOUR') + settingNum('TIMON_DREAM_WINDOW_H')) return;
    // Runtime toggle (e.g. holidays) — read every night, without restart.
    if (!isDreamEnabled()) { console.log('[dream] disabled (toggle) — pass skipped'); return; }
    lastRunDay = day;
    runDreamPass().catch((err) => console.error(`[dream] pass failed: ${(err as Error).message}`));
  };
  const timer = setInterval(tick, TICK_MS);
  console.log(`[dream] active (window ${settingNum('TIMON_DREAM_HOUR')}h–${settingNum('TIMON_DREAM_HOUR') + settingNum('TIMON_DREAM_WINDOW_H')}h, model ${settingStr('TIMON_DREAM_MODEL')})`);
  return () => clearInterval(timer);
}

/** Triggers an immediate pass (test / backfill via endpoint). */
export async function runDreamNow(): Promise<{ improve: number; opportunity: number }> {
  return runDreamPass();
}
