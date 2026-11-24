'use client';

/**
 * A tool call inside a bubble, in the three shapes the thread offers.
 *
 * `dropdown` is the historical rendering and stays the default: the tool's
 * name, its content behind a disclosure triangle. `full` is the same block
 * already open — for reading a whole turn without clicking. `stacked` shows
 * nothing but overlapping icons: a turn that called eleven tools becomes one
 * short row, which is what a newcomer needs to see that "it worked" without
 * being handed eleven JSON payloads.
 *
 * The three share ONE body renderer: what a mode changes is how the body is
 * reached, never what it says.
 */

import React, { useEffect, useState } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { toolLabel } from '@/lib/tool-label';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ToolCallsMode } from './chat-appearance';

export type ToolCallProps = {
  name?: string;
  title?: string;
  icon: LucideIcon;
  headHtml: string;
  /** `input.description` — the sentence the agent wrote to say what this call
   *  is FOR ("Timestamp the commits"). Contextual where a name can only ever
   *  be generic, and required by Claude Code's Bash tool, so present on
   *  essentially every shell call. */
  intent?: string;
  result?: { html: string; isError: boolean };
};

/** `Task` / `Agent` burn the parent's context — the name is painted as a
 *  warning wherever it appears, stacked included. */
function isBadTool(name?: string): boolean {
  return name === 'Task' || name === 'Agent';
}

/**
 * What a chip says when hovered: what the call is FOR, else what it is.
 *
 * The agent's own sentence first — it knows the mission's context, which no
 * name can carry. `toolLabel` is the fallback and walks its own chain:
 * declared title, then readable MCP name, then raw name.
 *
 * `description` is only an intent on a tool that DEFINES it as one. On an MCP
 * tool it is an ordinary parameter — the description of the Kanban task being
 * created, say — and showing it would label the chip with the payload instead
 * of the call. Same guard as the running-tools bar.
 */
function chipTooltip({ name, title, intent }: Pick<ToolCallProps, 'name' | 'title' | 'intent'>): string {
  const written = name?.startsWith('mcp__') ? null : intent?.trim();
  return written || toolLabel(name, title);
}

function ToolBody({ headHtml, result }: Pick<ToolCallProps, 'headHtml' | 'result'>) {
  return (
    <div className="tool-block-body">
      <div dangerouslySetInnerHTML={{ __html: headHtml }} />
      {result && <div dangerouslySetInnerHTML={{ __html: result.html }} />}
    </div>
  );
}

export function ToolCall({ name, title, icon: Icon, headHtml, result, mode = 'dropdown' }: ToolCallProps & {
  mode?: ToolCallsMode;
}) {
  return (
    // `open` rather than a second markup for `full`: the summary stays a
    // control, so a reader who wants to fold one noisy call back still can.
    <details className="tool-block" open={mode === 'full'}>
      <summary className={cn('tool-summary', isBadTool(name) && 'tool-summary-bad')}>
        <ChevronRight className="tool-summary-chevron size-3 shrink-0" aria-hidden />
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="tool-summary-name">{toolLabel(name, title)}</span>
        {result?.isError && <span className="tool-result-badge">{t('chatCards.toolError')}</span>}
      </summary>
      <ToolBody headHtml={headHtml} result={result} />
    </details>
  );
}

/**
 * Every tool call of one message, as a row of overlapping chips.
 *
 * The grouping is the point: a per-call `<details>` would give back the column
 * of lines this mode exists to remove. Chips overlap by a third of their width,
 * the way a stack of cards does, and spread apart on hover so the one being
 * aimed at is whole before it is clicked.
 *
 * One chip open at a time, its body below the row rather than in a popover:
 * the body is arbitrary HTML (tables, diffs, scrollers) sized by the bubble's
 * width, and a floating layer would have to guess that width.
 */
export function ToolCallStack({ tools, running = [], live = false }: {
  tools: readonly (ToolCallProps & { id: string })[];
  /** The turn is still open on this bubble. Between a tool_result and the
   *  model's next token `running` is empty while the wait goes on: the row
   *  then shows the bare dots, so the wait never leaves the bubble. */
  live?: boolean;
  /** Calls of THIS bubble still in flight, with the sentence to show for
   *  them. Never derived here from `result === undefined`: a turn killed
   *  mid-Bash leaves a result-less call forever, and the stack would
   *  announce it as running for good. Only the page knows the turn is
   *  alive, so only the page may say so. */
  running?: readonly RunningTool[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  // Local ticker, like the bar above the composer: a still counter would
  // say nothing about a seven-minute Bash. Only runs while something is in
  // flight, so an idle thread re-renders nothing.
  const [now, setNow] = useState(() => Date.now());
  const ticking = running.length > 0;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  if (tools.length === 0) return null;
  const open = tools.find((tool) => tool.id === openId) ?? null;
  const runningIds = new Set(running.map((r) => r.id));

  return (
    <div className="tool-stack">
      {/* One provider for the whole row, not one per chip: it is what makes
        * the group behave as a group — the first hover waits, moving along
        * the row does not wait again.
        *
        * `disableHoverableContent` is what makes sliding along the row work at
        * all. By default Radix keeps a grace polygon between a trigger and its
        * open tooltip, and raises `isPointerInTransit` while the pointer is
        * inside it; a trigger entered during that transit REFUSES to open
        * (react-tooltip, Trigger.onPointerMove). Chips sit a few pixels apart
        * under a bubble hovering right above them, so a horizontal move
        * crosses that polygon most of the time: the neighbour stayed silent
        * and the first chip's text stayed on screen. There is nothing to hover
        * inside these tooltips anyway — they are one line of text. */}
      <TooltipProvider delayDuration={120} skipDelayDuration={400} disableHoverableContent>
        <div className="tool-stack-row">
          {tools.map((tool) => {
            const { id, name, icon: Icon, result } = tool;
            const label = chipTooltip(tool);
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-expanded={id === openId}
                    onClick={() => setOpenId(id === openId ? null : id)}
                    className={cn(
                      'tool-chip',
                      runningIds.has(id) && 'tool-chip-live',
                      id === openId && 'tool-chip-open',
                      isBadTool(name) && 'tool-chip-bad',
                      result?.isError && 'tool-chip-error',
                    )}
                  >
                    <Icon className="size-3.5" aria-hidden />
                    {/* The accessible name is the one shown: a reader who
                      * cannot see the tooltip must hear what it says, and the
                      * tool's own name is still spelled out in the panel the
                      * chip opens. */}
                    <span className="sr-only">{label}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  className="max-w-[min(20rem,80vw)] border border-border bg-popover text-[11px] text-popover-foreground shadow-elev-2 [overflow-wrap:anywhere]"
                >
                  {label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>
      {running.map((r) => {
        const elapsed = r.startedAt ? Math.max(0, Math.floor((now - r.startedAt) / 1000)) : null;
        return (
          <div key={r.id} className="tool-stack-live">
            <span className="tool-stack-live-name">{r.name}</span>
            {elapsed !== null && (
              // Past a minute a running tool deserves flagging: it is the
              // threshold where you start wondering whether it crashed.
              <span className={cn('tool-stack-live-time', elapsed >= 60 && 'tool-stack-live-long')}>
                {fmtElapsedShort(elapsed)}
              </span>
            )}
            {r.label && <span className="tool-stack-live-what">{r.label}</span>}
            <ThinkingDots />
          </div>
        );
      })}
      {live && running.length === 0 && (
        <div className="tool-stack-live">
          <span className="tool-stack-live-name">{t('chatCards.thinking')}</span>
          <ThinkingDots />
        </div>
      )}
      {open && (
        <div className="tool-stack-open">
          <div className="tool-stack-open-name">
            {toolLabel(open.name, open.title)}
            {open.result?.isError && <span className="tool-result-badge">{t('chatCards.toolError')}</span>}
          </div>
          <ToolBody headHtml={open.headHtml} result={open.result} />
        </div>
      )}
    </div>
  );
}

/** One in-flight call of a bubble, as the page hands it over. */
export type RunningTool = {
  id: string;
  /** The tool's own name — `Bash`, `Read`, the readable MCP name. */
  name: string;
  /** What the call is FOR, in one line. Empty when nothing better than the
   *  name is known. */
  label?: string;
  startedAt?: number;
};

/** `7m12s` / `43s` / `1h04m` — compact, stable width. */
export function fmtElapsedShort(s: number): string {
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

/**
 * The three dots of a wait, bouncing in turn.
 *
 * They take `currentColor`, so the same markup serves a grey "thinking"
 * bubble and the amber line of a running tool. The keyframes live in
 * `globals.css` (`.timon-dots`), which both this file and the chat page
 * can reach — and which honours `prefers-reduced-motion`.
 */
export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span className={cn('timon-dots', className)} aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}
