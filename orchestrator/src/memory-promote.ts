/**
 * Promotion of recurring facts (mechanism 3/3 of the self-learning memory
 * system). Periodic job (NOT the bus — it is batch) that scans the
 * per-agent `learnings.jsonl`, counts recurrence by hash, and for every fact
 * seen ≥ threshold times PROPOSES (does not decide) adding it to the injected curated files.
 *
 * Mode = propose-to-the-user: we NEVER write automatically into
 * instructions.md / decisions.md (hand-curated files). A
 * proposal is appended to the project's `proposals.md` + a notification. The user validates through the existing
 * PUT API. Idempotency: dedup by hash already present in proposals.md.
 *
 * Activation: TIMON_MEMORY_PROMOTION_ENABLED=1 (default off).
 */
import { listAgents, readMemory, writeMemory, appendMemory } from './agent.js';
import { readProjectMemory, appendProjectMemory } from './projects.js';
import { decayLearnings, parseSalience } from './memory-view.js';
import { notifyUser } from './notify.js';
import { daemonMessage } from './daemon-message.js';
import { settingBool, settingNum } from './settings.js';


type Kind = 'decision' | 'pitfall' | 'preference';
export type Candidate = { hash: string; kind: Kind; text: string; count: number; agent: string };

// Promotion target (curated + injected project file). NB: `pitfall` targets
// `instructions.md` (project level) and NOT `pieges.md`: a pitfall is already
// auto-written into the per-agent `pieges.md` at capture; promoting it must
// raise it to a team rule seen by ALL the project's agents. Double
// residence (per-agent pieges.md + project instructions.md) on purpose.
export const TARGET_FILE: Record<Kind, string> = {
  preference: 'instructions.md',
  decision: 'decisions.md',
  pitfall: 'instructions.md',
};

/** Counts the recurrence (nb of occurrences = nb of missions) per hash in an
 *  agent's learnings.jsonl. Keeps the most recent text/kind. */
function recurrentFacts(agent: string): Candidate[] {
  const raw = readMemory(agent, 'learnings.jsonl');
  if (!raw) return [];
  const byHash = new Map<string, { kind: Kind; text: string; count: number }>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let j: { hash?: string; kind?: Kind; text?: string };
    try { j = JSON.parse(line); } catch { continue; }
    if (!j.hash || !j.kind || !j.text) continue;
    const cur = byHash.get(j.hash);
    if (cur) { cur.count++; cur.kind = j.kind; cur.text = j.text; }
    else byHash.set(j.hash, { kind: j.kind, text: j.text, count: 1 });
  }
  const out: Candidate[] = [];
  for (const [hash, v] of byHash) {
    if (v.count >= settingNum('TIMON_MEMORY_PROMOTE_THRESHOLD')) out.push({ hash, kind: v.kind, text: v.text, count: v.count, agent });
  }
  return out;
}

/** Hashes already proposed (present in the project's proposals.md). */
function proposedHashes(slug: string): Set<string> {
  const raw = readProjectMemory(slug, 'proposals.md');
  const set = new Set<string>();
  if (!raw) return set;
  for (const m of raw.matchAll(/<!--\s*proposal\s+hash:([0-9a-f]{12})\b/g)) set.add(m[1]!);
  return set;
}

/** One proposals.md block. Exported so the reader (`parseProposals`,
 *  memory-view.ts) is tested against the exact text written here. */
export function proposalBlock(c: Candidate, ts: string): string {
  return `<!-- proposal hash:${c.hash} kind:${c.kind} count:${c.count} agent:${c.agent} ts:${ts} -->\n` +
    `- [${c.kind} ×${c.count}] ${c.text}\n` +
    `  → suggested target: \`${TARGET_FILE[c.kind]}\`\n` +
    `<!-- /proposal hash:${c.hash} -->`;
}

export function runPromotionScan(): void {
  const agents = listAgents();
  const perProject = new Map<string, { proposed: Set<string>; blocks: string[]; items: Candidate[] }>();

  for (const a of agents) {
    if (!a.project) continue; // project-targeted promotion; cross-project agents ignored
    const slug = a.project;
    const cands = recurrentFacts(a.name);
    if (cands.length === 0) continue;
    let bucket = perProject.get(slug);
    if (!bucket) {
      bucket = { proposed: proposedHashes(slug), blocks: [], items: [] };
      perProject.set(slug, bucket);
    }
    for (const c of cands) {
      if (bucket.proposed.has(c.hash)) continue;
      bucket.proposed.add(c.hash);
      const ts = new Date().toISOString();
      bucket.blocks.push(proposalBlock(c, ts));
      bucket.items.push(c);
    }
  }

  let total = 0;
  for (const [slug, bucket] of perProject) {
    if (bucket.blocks.length === 0) continue;
    appendProjectMemory(slug, 'proposals.md', '\n' + bucket.blocks.join('\n') + '\n');
    total += bucket.items.length;
    const top = [...bucket.items].sort((a, b) => b.count - a.count).slice(0, 5)
      .map((c) => `- [${c.kind} ×${c.count}] ${c.text}`).join('\n');
    notifyUser(
      `Memory ${slug}: ${bucket.items.length} recurring fact(s) to review`,
      `These facts recur ≥${settingNum('TIMON_MEMORY_PROMOTE_THRESHOLD')}× and are proposed for promotion (proposals.md of project \`${slug}\`). ` +
      `Approve them by copying them into the suggested curated file through the project memory UI/API.\n\n${top}`,
      {
        message: daemonMessage('memory_proposals_to_review', {
          slug, count: bucket.items.length, threshold: settingNum('TIMON_MEMORY_PROMOTE_THRESHOLD'), top,
        }),
      },
    );
    console.log(`[memory-promote] project ${slug}: ${bucket.items.length} proposal(s)`);
  }
  if (total === 0) console.log('[memory-promote] scan: no new proposal');
}

/**
 * Decay (forgetting) pass of the learnings.jsonl staging tier. For each agent:
 * archives the hash groups whose weight (Ebbinghaus × salience) drops below
 * the threshold into learnings.archive.jsonl (reversible), rewrites the pruned learnings.
 * The curated project files (instructions/decisions) are NEVER touched
 * (pinned tier). Activation: TIMON_MEMORY_DECAY_ENABLED=1.
 */
export function runDecaySweep(): void {
  const now = Date.now();
  let archived = 0;
  for (const a of listAgents()) {
    const learn = readMemory(a.name, 'learnings.jsonl');
    if (!learn) continue;
    const sal = parseSalience(readMemory(a.name, 'salience.json'));
    const { keep, archive } = decayLearnings(learn, sal, now, { halfLifeDays: settingNum('TIMON_MEMORY_DECAY_HALFLIFE_DAYS'), threshold: settingNum('TIMON_MEMORY_DECAY_THRESHOLD') });
    if (archive.length === 0) continue;
    appendMemory(a.name, 'learnings.archive.jsonl', archive.join('\n') + '\n');
    writeMemory(a.name, 'learnings.jsonl', keep.length ? keep.join('\n') + '\n' : '');
    archived += archive.length;
    console.log(`[memory-decay] ${a.name}: ${archive.length} line(s) archived`);
  }
  if (archived === 0) console.log('[memory-decay] sweep: nothing to forget');
}

