/**
 * The push of a ticket branch by a merger, without a card.
 *
 * Why the daemon pushes, and the agent does not run `git push` itself: the
 * claude CLI's classifier judges the shell command in `auto` mode and refuses a
 * push to the forge, and an op it refuses never reaches Timon's permission tool
 * (`approval-rules.ts`), so no rule on our side can stand in for it. An
 * `--allowedTools` pattern is matched by the CLI on a prefix, cannot say "this
 * task's branch to a ticket branch", and is dropped in `auto` when it looks
 * broad. The daemon, on the other hand, knows the task, its project, the
 * remote and the credentials; it pushes only what `checkTicketBranchPush`
 * accepts, with no shell, and writes an audit row for every push.
 *
 * `checkTicketBranchPush` is the ONE rule. It is pure: it reads a `git push`
 * command line and a context, and answers either the parsed push or the reason
 * it is not covered. A command outside the frame is simply not covered: it keeps
 * the normal path (the classifier, then a card).
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** What the caller knows about the merger's project. */
export type TicketPushContext = {
  /** The remote of the task's repository (`origin` by default); no URL, no other name. */
  remote: string;
  /** The ticket prefixes of the project (`SELP`), when known. Empty: any prefix of the generic pattern. */
  ticketPrefixes: readonly string[];
  /** Branches the project knows to be protected, on top of the built-in list. */
  protectedBranches: readonly string[];
  /** Whether `timon/task/<taskId>` is the branch of an existing task of the merger's project. */
  isProjectTaskBranch: (taskId: string) => boolean;
  /** Whether `dir` (absolute) is the project's repository or one of its worktrees. */
  isProjectDir: (dir: string) => boolean;
};

export type TicketPush = {
  remote: string;
  /** `timon/task/<id>`. */
  src: string;
  taskId: string;
  /** The ticket branch, without `refs/heads/`. */
  dst: string;
  setUpstream: boolean;
  /** The directory given with `-C`, if any. */
  dir: string | null;
};

export type TicketPushCheck = { ok: true; push: TicketPush } | { ok: false; reason: string };

/** Never a destination, whatever its spelling. */
const ALWAYS_PROTECTED = ['develop', 'main', 'master', 'production', 'release'];
const GENERIC_TICKET = /^([A-Z][A-Z0-9]+)-[0-9]+_[a-z0-9._-]+$/;
const TASK_BRANCH = /^timon\/task\/([A-Za-z0-9-]{1,64})$/;
/** Anything a shell would read, quote or expand, plus git's own refspec magic. */
const UNSAFE = /[;&|<>$`()\\'"\n\r\t*?[\]{}!#~^+@]/;

function refuse(reason: string): TicketPushCheck {
  return { ok: false, reason };
}

/** `PREFIX-<n>_<description>`, with the project's prefixes when they are known. */
export function isTicketBranchName(name: string, prefixes: readonly string[]): boolean {
  const m = GENERIC_TICKET.exec(name);
  if (!m) return false;
  if (name.includes('..') || name.endsWith('.') || name.endsWith('.lock') || name.includes('.lock.')) return false;
  return prefixes.length === 0 || prefixes.includes(m[1]!);
}

/**
 * The ticket prefixes a project's pole declares: timon-config writes them in the
 * project's speech as "ticket prefixes `SELP-`, `IT-`", and a `ticket_prefixes: [SELP, IT]`
 * line is read the same way. Empty when none is declared.
 */
export function ticketPrefixesFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const sentence = /ticket prefixes\s+((?:`[A-Z][A-Z0-9]+-?`[\s,]*(?:and\s+)?)+)/i.exec(text);
  const list = /ticket_prefixes\s*:\s*\[([^\]]*)\]/i.exec(text);
  for (const chunk of [sentence?.[1], list?.[1]]) {
    for (const m of (chunk ?? '').matchAll(/[A-Z][A-Z0-9]+/g)) found.add(m[0]);
  }
  return [...found];
}

/**
 * Whether `command` is `git push [remote] <src>:[refs/heads/]<dst>` with `src`
 * the branch of a task of the project and `dst` a ticket branch, and nothing
 * else: no force, no deletion, no extra option, no chaining.
 */
export function checkTicketBranchPush(command: string, ctx: TicketPushContext): TicketPushCheck {
  if (UNSAFE.test(command)) return refuse('the command chains, quotes, expands or forces something');
  const words = command.trim().split(/\s+/).filter(Boolean);
  if (words.shift() !== 'git') return refuse('not a git command');

  let dir: string | null = null;
  if (words[0] === '-C') {
    words.shift();
    dir = words.shift() ?? null;
    if (!dir || dir.startsWith('-') || !isAbsolute(dir)) return refuse('-C needs an absolute directory');
    if (!ctx.isProjectDir(resolve(dir))) return refuse('-C points outside the project');
  }
  if (words.shift() !== 'push') return refuse('not a git push');

  let setUpstream = false;
  const positional: string[] = [];
  for (const w of words) {
    if (w === '-u' || w === '--set-upstream') { setUpstream = true; continue; }
    if (w.startsWith('-')) return refuse(`option ${w} is not covered`);
    positional.push(w);
  }
  if (positional.length === 0 || positional.length > 2) return refuse('exactly one refspec is expected');
  const refspec = positional.pop()!;
  const remote = positional.pop() ?? ctx.remote;
  if (remote !== ctx.remote) return refuse(`the remote must be ${ctx.remote}`);

  const parts = refspec.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return refuse('the refspec must be <src>:<dst>');
  const [src, rawDst] = parts as [string, string];
  const task = TASK_BRANCH.exec(src);
  if (!task) return refuse('the source must be a timon/task/<id> branch');
  if (!ctx.isProjectTaskBranch(task[1]!)) return refuse('the source is not the branch of a task of this project');

  const dst = rawDst.startsWith('refs/heads/') ? rawDst.slice('refs/heads/'.length) : rawDst;
  if (dst.startsWith('refs/') || dst.includes('/')) return refuse('the destination must be a plain branch under refs/heads');
  const lower = dst.toLowerCase();
  if (ALWAYS_PROTECTED.includes(lower) || ctx.protectedBranches.includes(dst)) return refuse(`${dst} is a protected branch`);
  if (!isTicketBranchName(dst, ctx.ticketPrefixes)) {
    return refuse(ctx.ticketPrefixes.length
      ? `the destination must be <${ctx.ticketPrefixes.join('|')}>-<n>_<description>`
      : 'the destination must be <PREFIX>-<n>_<description>');
  }
  return { ok: true, push: { remote, src, taskId: task[1]!, dst, setUpstream, dir } };
}

/** Whether `dir` is `root` or sits under it. */
export function isUnder(root: string, dir: string): boolean {
  const rel = relative(resolve(root), resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/** The words after `git` for an accepted push: always this shape, never a shell. */
export function ticketPushArguments(push: TicketPush, cwd: string): string[] {
  return [
    '-C', push.dir ?? cwd, 'push',
    ...(push.setUpstream ? ['--set-upstream'] : []),
    push.remote, `${push.src}:refs/heads/${push.dst}`,
  ];
}
