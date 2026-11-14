/**
 * The words of a permission card: what the agent asks to use, in the reader's
 * language, by a name a person can read rather than the tool's identifier.
 */
import { humanizeTool } from '@/lib/humanize-tool';
import { t } from '@/lib/i18n';
import { toolLabel } from '@/lib/tool-label';

export type PermissionRequestText = {
  /** "The agent asks permission to use Timon · Kanban Add". */
  heading: string;
  /** What the call does, when the tool and its input say it: the agent's own
   *  description first, the generic sentence otherwise. */
  intent: string | null;
  /** The identifier, when the readable name hides it: an allow rule and the
   *  logs name the tool by it. */
  rawName: string | null;
};

function field(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') return '';
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** The argument `humanizeTool` reads for the tools it knows. */
function detailOf(toolName: string, input: unknown): string {
  switch (toolName) {
    case 'Bash': return field(input, 'command');
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': return field(input, 'file_path');
    case 'WebFetch': return field(input, 'url');
    default: return '';
  }
}

export function permissionRequestText(toolName: string, input: unknown): PermissionRequestText {
  const label = toolLabel(toolName);
  // An MCP tool's generic sentence is its server and action again: the
  // heading already says them.
  const intent = toolName.startsWith('mcp__')
    ? null
    : field(input, 'description') || humanizeTool(toolName, detailOf(toolName, input));
  return {
    heading: t('chatSurface.permissionToUse', { tool: label }),
    intent: intent || null,
    rawName: label !== toolName ? toolName : null,
  };
}
