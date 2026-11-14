/**
 * The local files a shell command would run, as the daemon attaches them to a
 * permission card (`orchestrator/src/script-preview.ts`). The two packages
 * cannot import each other: this side re-reads the payload defensively, since
 * it comes back from a persisted event on every replay.
 */

export const SCRIPT_PREVIEW_KINDS = ['file', 'npm_script', 'make_target'] as const;
export type ScriptPreviewKind = (typeof SCRIPT_PREVIEW_KINDS)[number];

export const SCRIPT_PREVIEW_STATUSES = [
  'ok', 'binary', 'outside_cwd', 'symlink_outside', 'missing', 'not_file', 'unreadable', 'unresolved', 'not_found',
  'too_large',
] as const;
export type ScriptPreviewStatus = (typeof SCRIPT_PREVIEW_STATUSES)[number];

export type ScriptPreview = {
  kind: ScriptPreviewKind;
  path: string;
  name?: string;
  status: ScriptPreviewStatus;
  size?: number;
  excerpt?: string;
  truncated?: boolean;
  sha256?: string;
};

/** Past this many lines the excerpt starts folded. */
export const FOLDED_LINES = 8;
/** The daemon never sends more; a bigger payload is not one of its cards. */
const MAX_PREVIEWS = 8;
const MAX_EXCERPT_CHARS = 16_384;

function oneOf<T extends string>(values: readonly T[], raw: unknown): T | null {
  return values.find((v) => v === raw) ?? null;
}

function shortString(raw: unknown, max: number): string | undefined {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= max ? raw : undefined;
}

/** The previews of a `permission_request` payload; empty when it has none or they are malformed. */
export function scriptPreviewsOf(raw: unknown): ScriptPreview[] {
  if (!Array.isArray(raw)) return [];
  const out: ScriptPreview[] = [];
  for (const item of raw.slice(0, MAX_PREVIEWS)) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const kind = oneOf(SCRIPT_PREVIEW_KINDS, p.kind);
    const status = oneOf(SCRIPT_PREVIEW_STATUSES, p.status);
    const path = shortString(p.path, 4096);
    if (!kind || !status || !path) continue;
    const name = shortString(p.name, 512);
    const excerpt = typeof p.excerpt === 'string' ? p.excerpt.slice(0, MAX_EXCERPT_CHARS) : undefined;
    const sha256 = shortString(p.sha256, 256);
    out.push({
      kind, path, status,
      ...(name ? { name } : {}),
      ...(typeof p.size === 'number' && Number.isFinite(p.size) && p.size >= 0 ? { size: p.size } : {}),
      ...(excerpt !== undefined ? { excerpt } : {}),
      ...(p.truncated === true ? { truncated: true } : {}),
      ...(sha256 ? { sha256 } : {}),
    });
  }
  return out;
}

/** The files a `permission_resolved` payload says changed after the card showed them. */
export function scriptChangedOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 4096).slice(0, MAX_PREVIEWS);
}

/** Whether an excerpt starts folded: more lines than a glance takes in. */
export function startsFolded(preview: ScriptPreview): boolean {
  const lines = preview.excerpt?.split('\n').length ?? 0;
  return lines > FOLDED_LINES;
}
