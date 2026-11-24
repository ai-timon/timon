/**
 * OOM attribution — which process of which mission the kernel killed, and
 * the sentence the agent gets about it.
 *
 * Why this exists: an OOM kill inside a mission scope used to surface as a
 * bare `Killed` (exit 137) in the agent's shell tool, plus a generic alert
 * about "the missions slice". The agent could not tell a memory ceiling from
 * a flaky command, so it reran the same thing — and got killed again. The
 * notice built here names the process and the ceiling it crossed.
 *
 * Two sources, the first always available, the second when readable:
 *  - the cgroup filesystem, snapshotted on every watch tick: per-scope
 *    `oom_kill` counter, `memory.max`, and the processes it holds (pid,
 *    command line, RSS). A counter that grew + a process that vanished since
 *    the previous tick names the victim, heaviest first;
 *  - the kernel log (`oom-kill:` + `Killed process` lines), which gives the
 *    exact pid even for a process born and killed between two ticks, and
 *    the scope of a mission whose main process died with it (its cgroup is
 *    gone before the next tick can read it). Unprivileged users often cannot
 *    read it; the cgroup path then stands alone.
 *
 * Linux only by construction: cgroup v2 and /proc. Callers reach here only
 * behind `hasSystemd()`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { daemonMessage, type DaemonMessage } from './daemon-message.js';

export type ProcInfo = { pid: number; cmd: string; rssBytes: number | null };

export type ScopeSnapshot = {
  oomKill: number;
  maxBytes: number | null;
  procs: ProcInfo[];
};

export type OomKill = {
  scope: string;
  pid: number | null;
  cmd: string | null;
  rssBytes: number | null;
  /** Ceiling that was crossed, in bytes, when known. */
  ceilingBytes: number | null;
  /** True when the collective slice ceiling fired, not the mission's own. */
  sliceWide: boolean;
};

// portability: cgroup v2 and procfs pseudo-filesystems, Linux-only by construction
const CGROUP_ROOT = '/sys/fs/cgroup';
// portability: procfs, Linux-only by construction
const PROC_ROOT = '/proc';
/** A runaway fork loop must not turn the watch tick into its own hog. */
const MAX_PROCS_PER_SCOPE = 500;
const MAX_CMD_LEN = 240;

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function readProc(pid: number): ProcInfo | null {
  const raw = readText(join(PROC_ROOT, String(pid), 'cmdline'));
  if (raw === null) return null; // exited between the listing and the read
  const cmd = raw.split('\0').filter(Boolean).join(' ').slice(0, MAX_CMD_LEN);
  const status = readText(join(PROC_ROOT, String(pid), 'status')) ?? '';
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
  return { pid, cmd: cmd || `pid ${pid}`, rssBytes: m ? Number(m[1]) * 1024 : null };
}

export function parseMemoryEvents(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    const [k, v] = line.trim().split(/\s+/);
    if (k) out[k] = Number(v) || 0;
  }
  return out;
}

/** Snapshot of every mission scope directly under the slice's cgroup.
 *  `keep` filters scope names (own instance only). */
export function readScopeSnapshots(
  sliceControlGroup: string,
  keep: (scope: string) => boolean,
  root = CGROUP_ROOT,
): Map<string, ScopeSnapshot> {
  const out = new Map<string, ScopeSnapshot>();
  const dir = join(root, sliceControlGroup);
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const scope of entries) {
    if (!scope.endsWith('.scope') || !keep(scope)) continue;
    const events = readText(join(dir, scope, 'memory.events'));
    if (events === null) continue;
    const maxRaw = (readText(join(dir, scope, 'memory.max')) ?? '').trim();
    const pids = (readText(join(dir, scope, 'cgroup.procs')) ?? '')
      .split('\n').map(Number).filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, MAX_PROCS_PER_SCOPE);
    out.set(scope, {
      oomKill: parseMemoryEvents(events).oom_kill ?? 0,
      maxBytes: /^\d+$/.test(maxRaw) ? Number(maxRaw) : null,
      procs: pids.map(readProc).filter((p): p is ProcInfo => p !== null),
    });
  }
  return out;
}

/** Victims seen from the cgroup side: scopes whose `oom_kill` grew, and the
 *  processes gone since the previous tick, heaviest first. Heaviest is the
 *  kernel's own choice (the OOM killer picks the biggest RSS), so it is the
 *  right guess when several processes left in the same interval. */
export function diffScopeKills(
  prev: Map<string, ScopeSnapshot>,
  next: Map<string, ScopeSnapshot>,
): OomKill[] {
  const kills: OomKill[] = [];
  for (const [scope, now] of next) {
    const before = prev.get(scope);
    if (!before || now.oomKill <= before.oomKill) continue;
    const alive = new Set(now.procs.map((p) => p.pid));
    const gone = before.procs
      .filter((p) => !alive.has(p.pid))
      .sort((a, b) => (b.rssBytes ?? 0) - (a.rssBytes ?? 0));
    const count = now.oomKill - before.oomKill;
    for (let i = 0; i < count; i++) {
      const p = gone[i];
      kills.push({
        scope,
        pid: p?.pid ?? null,
        cmd: p?.cmd ?? null,
        rssBytes: p?.rssBytes ?? null,
        ceilingBytes: now.maxBytes ?? before.maxBytes,
        sliceWide: false,
      });
    }
  }
  return kills;
}

export type KernelOomLine = {
  pid: number;
  task: string;
  /** Last path segment of `task_memcg`: the scope the victim lived in. */
  taskScope: string | null;
  /** True when `oom_memcg` IS that scope (its own ceiling fired). */
  scopeCeiling: boolean;
  rssBytes: number | null;
};

/** Parses the kernel's OOM report. The `oom-kill:` line carries the cgroups
 *  and the pid; the `Killed process` line that follows carries the RSS. */
export function parseKernelOom(text: string): KernelOomLine[] {
  const out: KernelOomLine[] = [];
  const byPid = new Map<number, KernelOomLine>();
  for (const line of text.split('\n')) {
    if (line.includes('oom-kill:')) {
      const field = (k: string) => new RegExp(`[:,]${k}=([^,\\s]*)`).exec(line)?.[1] ?? null;
      const pid = Number(field('pid'));
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const taskMemcg = field('task_memcg');
      const oomMemcg = field('oom_memcg');
      const taskScope = taskMemcg ? taskMemcg.split('/').filter(Boolean).pop() ?? null : null;
      const entry: KernelOomLine = {
        pid,
        task: field('task') ?? `pid ${pid}`,
        taskScope,
        scopeCeiling: Boolean(taskMemcg && oomMemcg && taskMemcg === oomMemcg),
        rssBytes: null,
      };
      out.push(entry);
      byPid.set(pid, entry);
      continue;
    }
    const k = /Killed process (\d+) \(([^)]*)\).*?anon-rss:(\d+)kB/.exec(line);
    if (k) {
      const entry = byPid.get(Number(k[1]));
      if (entry) entry.rssBytes = Number(k[3]) * 1024;
    }
  }
  return out;
}

const GB = 1024 ** 3;
function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

/** The sentence the agent reads. It has to stop a blind rerun: say what
 *  died, which ceiling, and that the same command dies the same way. */
export function formatKillNotice(kill: OomKill): string {
  const what = kill.cmd
    ? `\`${kill.cmd}\`${kill.pid ? ` (pid ${kill.pid})` : ''}`
    : kill.pid ? `pid ${kill.pid}` : 'one of your processes';
  const ceiling = kill.ceilingBytes !== null ? `more than ${gb(kill.ceilingBytes)} of memory` : 'too much memory';
  const whose = kill.sliceWide ? 'the ceiling shared by all running missions' : 'the ceiling of this mission';
  const rss = kill.rssBytes !== null ? ` It held ${gb(kill.rssBytes)} when it was killed.` : '';
  return `[Timon resource guard] Your process ${what} was killed by the kernel: it used ${ceiling}, `
    + `${whose}.${rss} Running the same command again will be killed the same way. `
    + 'Find the cause first — an infinite loop, a leak, an unbounded dataset — '
    + 'and run a narrower target (`npm test -- <file>`) once it is fixed.';
}

/** The code of `formatKillNotice`, for the notification centre to translate (TODO #1063). */
export function killNoticeMessage(kill: OomKill, mission: string): DaemonMessage {
  return daemonMessage('resource_mission_killed', {
    mission,
    cmd: kill.cmd ?? 'none',
    pid: kill.pid ? String(kill.pid) : 'none',
    ceiling: kill.ceilingBytes !== null ? gb(kill.ceilingBytes) : 'none',
    whose: kill.sliceWide ? 'slice' : 'mission',
    rss: kill.rssBytes !== null ? gb(kill.rssBytes) : 'none',
  });
}

/** 8-hex mission prefix carried by a scope name (`<prefix>-mission-<id8>-<seq>.scope`). */
export function missionPrefixOfScope(scope: string): string | null {
  return /-mission-([0-9a-z]{8})-[0-9a-z]+\.scope$/.exec(scope)?.[1] ?? null;
}
