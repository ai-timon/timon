'use client';

import { useState } from 'react';
import { Copy, Pencil } from 'lucide-react';
import { toast } from 'sonner';

import {
  formatTokens,
  freshConversationAgents,
  maskingNotice,
  neverReadSkills,
  saveRequest,
  skillReadState,
  whyNotEditable,
  type EditTarget,
  type InjectionBlock,
  type InjectionOrigin,
  type SkillReadState,
  type SkillReads,
} from '@/lib/agent-injections';
import { t } from '@/lib/i18n';
import { mdToSafeHtml } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipArrow, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { readError } from './use-agent-injections';

/** One colour per origin: told apart at a glance in a list of a dozen rows. */
const ORIGIN_STYLE: Record<InjectionOrigin, string> = {
  timon: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  user: 'border-teal-500/40 bg-teal-500/10 text-teal-300',
  agent: 'border-violet-500/40 bg-violet-500/10 text-violet-300',
  memory: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  skills: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  project: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
};

export function OriginBadge({ origin }: { origin: InjectionOrigin }) {
  return (
    <span className={cn('shrink-0 rounded border px-1 text-[9.5px] uppercase', ORIGIN_STYLE[origin])}>
      {t(`agentInjections.origin.${origin}`)}
    </span>
  );
}

/** The solid colour of each origin, for the bar and the dot of its legend. */
const ORIGIN_FILL: Record<InjectionOrigin, string> = {
  timon: 'bg-sky-400',
  user: 'bg-teal-400',
  agent: 'bg-violet-400',
  memory: 'bg-amber-400',
  skills: 'bg-emerald-400',
  project: 'bg-rose-400',
};

/** Below this share a segment is too narrow for its number: the tooltip carries it. */
const NUMBERED_FROM = 0.1;

/** The arrow of a tooltip takes the colour of its segment. */
const ORIGIN_ARROW: Record<InjectionOrigin, string> = {
  timon: 'fill-sky-400',
  user: 'fill-teal-400',
  agent: 'fill-violet-400',
  memory: 'fill-amber-400',
  skills: 'fill-emerald-400',
  project: 'fill-rose-400',
};

/**
 * Where the context comes from: one thin bar, a segment per origin as wide as
 * its share of the total. Hovering a segment names it, in a bubble of its colour,
 * with its token count and share.
 */
export function OriginBar({ origins }: { origins: { origin: InjectionOrigin; tokens: number }[] }) {
  const total = origins.reduce((sum, o) => sum + o.tokens, 0);
  if (total <= 0) return null;
  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex flex-col gap-1.5">
        <ul aria-label={t('agentInjections.byOrigin')} className="flex h-2 w-full gap-px overflow-hidden rounded-full">
          {origins.map((o) => (
            <Tooltip key={o.origin}>
              <TooltipTrigger asChild>
                <li
                  tabIndex={0}
                  style={{ width: `${((o.tokens / total) * 100).toFixed(2)}%` }}
                  className={cn('h-full min-w-[2px] outline-none transition-opacity hover:opacity-80 focus-visible:opacity-80', ORIGIN_FILL[o.origin])}
                />
              </TooltipTrigger>
              <TooltipContent
                side="top"
                sideOffset={6}
                className={cn('border-0 px-2 py-1 text-[11px] font-medium tabular-nums text-black/80', ORIGIN_FILL[o.origin])}
              >
                {t(`agentInjections.origin.${o.origin}`)} · {formatTokens(o.tokens)} · {Math.round((o.tokens / total) * 100)}%
                <TooltipArrow className={ORIGIN_ARROW[o.origin]} width={10} height={5} />
              </TooltipContent>
            </Tooltip>
          ))}
        </ul>
      </div>
    </TooltipProvider>
  );
}

export function Badge({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 rounded border border-border px-1 text-[9.5px] uppercase text-muted-foreground">{children}</span>;
}

/** What reading the catalogue skills would add, apart from the prompt: paid only when the agent reads one. */
export function OnDemandNote({ tokens }: { tokens: number | undefined }) {
  if (!tokens) return null;
  return <p className="text-[11px] leading-snug text-muted-foreground/80">{t('agentInjections.onDemand', { tokens: formatTokens(tokens) })}</p>;
}

/** The badges of a block, in a fixed order: where it comes from, then what can be done with it. */
export function BlockBadges({ block, reads = null }: {
  block: Pick<InjectionBlock, 'origin' | 'injected_by' | 'redacted' | 'sent_masked' | 'editable' | 'items'>;
  /** Flags the catalogue skills no mission read: the row says so before it is opened. */
  reads?: SkillReads | null;
}) {
  const never = neverReadSkills(block, reads).length;
  return (
    <>
      <OriginBadge origin={block.origin} />
      {block.injected_by === 'cli' && <Badge>{t('agentInjections.badge.cli')}</Badge>}
      {block.redacted && <Badge>{t(block.sent_masked ? 'agentInjections.badge.redactedSent' : 'agentInjections.badge.redacted')}</Badge>}
      {block.editable && <Badge>{t('agentInjections.badge.editable')}</Badge>}
      {never > 0 && <span className={NEVER_READ_STYLE}>{t('agentInjections.skillReads.neverCount', { n: never })}</span>}
    </>
  );
}

const NEVER_READ_STYLE = 'shrink-0 rounded border border-amber-500/50 bg-amber-500/15 px-1 text-[10px] font-medium tabular-nums text-amber-300';
const QUIET_READ_STYLE = 'shrink-0 rounded border border-border px-1 text-[10px] tabular-nums text-muted-foreground';

/** How often the agent's missions read a catalogue skill; a skill never read stands out. */
export function SkillReadsBadge({ state }: { state: SkillReadState }) {
  const title = t('agentInjections.skillReads.title', { days: state.days });
  if (state.kind === 'never') {
    return <span title={title} className={NEVER_READ_STYLE}>{t('agentInjections.skillReads.never', { total: state.total, days: state.days })}</span>;
  }
  if (state.kind === 'unmeasured') {
    return <span title={t('agentInjections.skillReads.unmeasuredTitle')} className={QUIET_READ_STYLE}>{t('agentInjections.skillReads.unmeasured', { days: state.days })}</span>;
  }
  const label = state.kind === 'idle'
    ? t('agentInjections.skillReads.idle', { days: state.days })
    : t('agentInjections.skillReads.read', { reads: state.reads, missions: state.missions, total: state.total, days: state.days });
  return <span title={title} className={QUIET_READ_STYLE}>{label}</span>;
}

export function tokensLabel(tokens: number): string {
  return t('agentInjections.tokens', { n: formatTokens(tokens) });
}

/** Identity of an editor: the source it writes to. Keying a `Body` on it makes
 *  React drop an unsaved draft the moment the row shows another source. */
export function targetKey(target: EditTarget | null): string {
  return target ? JSON.stringify(target) : 'none';
}

/** The text of one injection, rendered as markdown (or as the raw source), and
 *  — when its source is editable — the editor that writes it back to that source. */
export function Body({ content, note, editableText, target, onSaved, fill = false }: {
  content: string;
  note: string | null;
  editableText: string | null;
  target: EditTarget | null;
  onSaved: () => void;
  /** The parent already scrolls (Settings): no inner scroll box, or two bars stack. */
  fill?: boolean;
}) {
  // The draft remembers the source it was opened on: a save can only ever go
  // there, whatever the view shows by then.
  const [editing, setEditing] = useState<{ text: string; target: EditTarget } | null>(null);
  const [raw, setRaw] = useState(false);
  const draft = editing?.text ?? null;
  const setDraft = (text: string | null) => setEditing((prev) => (text === null ? null : prev && { ...prev, text }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const req = saveRequest(editing.target, editing.text);
      const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
      if (!res.ok) { setError(await readError(res)); return; }
      if (editing.target.kind === 'memory_rule') {
        const fresh = freshConversationAgents(await res.json().catch(() => null));
        if (fresh.length > 0) toast.info(t('agentInjections.freshConversation', { agents: fresh.join(', ') }));
      }
      setDraft(null);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (draft !== null) {
    return (
      <div className="flex flex-col gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={t('agentInjections.editor')}
          spellCheck={false}
          // code-font: raw source of a prompt file, edited as text
          className="min-h-64 w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-[12px] leading-snug outline-none focus:border-primary/60"
        />
        {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
        <div className="flex gap-2">
          <button type="button" disabled={saving} onClick={() => void save()}
            className="rounded-md border border-primary/60 bg-primary/15 px-2.5 py-1 text-[11px] text-primary disabled:opacity-40">
            {t('agentInjections.save')}
          </button>
          <button type="button" disabled={saving} onClick={() => { setDraft(null); setError(null); }}
            className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground">
            {t('agentInjections.cancel')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {content && (raw ? (
        // code-font: the raw source, as the model receives it
        <pre className={`scrollbar-thin ${fill ? '' : 'max-h-[55vh] overflow-auto '}whitespace-pre-wrap break-words rounded-md border border-border bg-background/60 p-2.5 font-mono text-[12px] leading-snug`}>
          {content}
        </pre>
      ) : (
        // `chat-bubble` carries the typography of rendered markdown (globals.css).
        <div
          className={`chat-bubble ${fill ? '' : 'max-h-[55vh] overflow-y-auto '}rounded-md border border-border bg-background/40 px-3 py-2 text-[13px]`}
          dangerouslySetInnerHTML={{ __html: mdToSafeHtml(content) }}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {content && (
          <button type="button" aria-pressed={raw} onClick={() => setRaw((v) => !v)}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
            {raw ? t('agentInjections.view.rendered') : t('agentInjections.view.source')}
          </button>
        )}
        {editableText !== null && target && (
          <button type="button" onClick={() => setEditing({ text: editableText, target })}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-primary">
            <Pencil className="size-3" aria-hidden />
            {t('agentInjections.edit')}
          </button>
        )}
        {note && <span className="text-[11px] text-muted-foreground/70">{note}</span>}
      </div>
    </div>
  );
}

/** Where the text lives on disk, with a way to take the path away — a project
 *  file is edited in the project, not from here. */
function SourcePath({ path }: { path: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {/* code-font: a file path */}
      <code className="min-w-0 flex-1 truncate font-mono" title={path}>{path}</code>
      <button type="button" aria-label={t('agentInjections.copyPath')} title={t('agentInjections.copyPath')}
        onClick={() => void navigator.clipboard?.writeText(path)}
        className="shrink-0 rounded p-1 hover:text-foreground">
        <Copy className="size-3" aria-hidden />
      </button>
    </div>
  );
}

/**
 * One block in full: where it comes from, its weight, and its text. A block that
 * gathers several sources (memory rules, skills) shows each on its own, with the
 * editor of its own source.
 */
export function BlockDetail({ agent, block, onSaved, reads = null }: { agent: string; block: InjectionBlock; onSaved: () => void; reads?: SkillReads | null }) {
  const note = (why: ReturnType<typeof whyNotEditable>): string | null => (why ? t(`agentInjections.why.${why}`) : null);
  const masking = maskingNotice(block);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="mr-1 text-sm font-semibold">{block.label}</h3>
          <BlockBadges block={block} reads={reads} />
          <span className="text-[11px] tabular-nums text-muted-foreground/80">{tokensLabel(block.tokens)}</span>
        </div>
        {block.source_path && <SourcePath path={block.source_path} />}
        {masking && (
          <p role="note" className={cn('text-[11px] leading-snug', masking === 'sent' ? 'text-muted-foreground' : 'text-amber-300/90')}>
            {t(`agentInjections.masking.${masking}`)}
          </p>
        )}
      </div>
      {block.items.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {block.items.map((it) => {
            // Only a catalogue line is read on demand: an imported body is always there.
            const readState = reads && it.skill_mode === 'include' ? skillReadState(reads, it.label) : null;
            return (
            <li key={it.id} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card/40 p-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium">{it.label}</span>
                {it.skill_mode && <Badge>{t(`agentInjections.skillMode.${it.skill_mode}`)}</Badge>}
                {it.skill_via && <Badge>{t(`agentInjections.skillVia.${it.skill_via}`)}</Badge>}
                {readState && <SkillReadsBadge state={readState} />}
                {it.editable && <Badge>{t('agentInjections.badge.editable')}</Badge>}
                <span className="text-[10.5px] tabular-nums text-muted-foreground/80">{tokensLabel(it.tokens)}</span>
                {it.on_demand_tokens != null && (
                  <span className="text-[10.5px] tabular-nums text-muted-foreground/70" title={t('agentInjections.onDemandHint')}>
                    {t('agentInjections.onDemandItem', { n: formatTokens(it.on_demand_tokens) })}
                  </span>
                )}
              </div>
              {readState?.kind === 'never' && (
                <p className="text-[11px] leading-snug text-amber-300/90">{t('agentInjections.skillReads.neverHint', { days: readState.days })}</p>
              )}
              {it.skill_promoted && (
                <p className="text-[11px] leading-snug text-muted-foreground">{t('agentInjections.skillPromotedHint')}</p>
              )}
              {it.source_path && <SourcePath path={it.source_path} />}
              <Body key={`${agent}:${targetKey(it.edit_target)}`} content={it.content} note={null} editableText={it.editable_text} target={it.edit_target} onSaved={onSaved} />
            </li>
            );
          })}
        </ol>
      ) : (
        <Body key={`${agent}:${targetKey(block.edit_target)}`} content={block.content}
          note={block.source === 'role' && block.editable ? t('agentInjections.why.roleShared') : note(whyNotEditable(block))}
          editableText={block.editable_text} target={block.edit_target} onSaved={onSaved} />
      )}
    </div>
  );
}
