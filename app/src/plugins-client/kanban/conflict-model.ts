/**
 * What the Conflict dialog shows of a file, computed here rather than in the
 * component: the blocks in conflict of the merged text, and a line diff of a
 * resolution against the contributor's version (what the pushed commit
 * changes on their branch), cut down to the changed lines and a little
 * context so that a 1 MB file stays readable.
 */

/** How many conflict blocks a merged text holds (lines opening one). */
export function conflictBlocks(merged: string | null): number {
  if (!merged) return 0;
  let n = 0;
  for (const line of merged.split('\n')) if (line.startsWith('<<<<<<<')) n++;
  return n;
}

/** Mirror of the daemon's check (`hasConflictMarkers`): a resolved text keeps none. */
export function hasConflictMarkers(text: string): boolean {
  return /^(?:<{7}(?: |$)|>{7}(?: |$)|\|{7}(?: |$)|={7}\r?$)/m.test(text);
}

export type ShownLine =
  | { kind: 'same' | 'add' | 'del' | 'marker' | 'ours' | 'base' | 'theirs'; text: string; line: number | null }
  | { kind: 'gap'; count: number };

/** Lines of context kept around what changed. */
const CONTEXT = 3;
/** Most lines painted for one file; past it, the rest is counted. */
export const MAX_SHOWN_LINES = 600;

/** Keeps the lines `keep` marks and `CONTEXT` lines around them; the rest becomes gaps. */
function condense<T extends { text: string }>(rows: readonly T[], keep: (row: T) => boolean, shown: (row: T, index: number) => ShownLine): ShownLine[] {
  const wanted = new Uint8Array(rows.length);
  rows.forEach((row, i) => {
    if (!keep(row)) return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) wanted[k] = 1;
  });
  const out: ShownLine[] = [];
  let skipped = 0;
  rows.forEach((row, i) => {
    if (wanted[i]) {
      if (skipped) { out.push({ kind: 'gap', count: skipped }); skipped = 0; }
      out.push(shown(row, i));
    } else skipped++;
  });
  if (skipped) out.push({ kind: 'gap', count: skipped });
  return out;
}

/** The conflict blocks of a merged text with a few lines around each, the two sides told apart. */
export function conflictHunks(merged: string): ShownLine[] {
  type Row = { text: string; kind: 'same' | 'marker' | 'ours' | 'base' | 'theirs' };
  const rows: Row[] = [];
  let side: 'same' | 'ours' | 'base' | 'theirs' = 'same';
  for (const text of merged.split('\n')) {
    if (text.startsWith('<<<<<<<')) { rows.push({ text, kind: 'marker' }); side = 'ours'; continue; }
    if (side === 'ours' && text.startsWith('|||||||')) { rows.push({ text, kind: 'marker' }); side = 'base'; continue; }
    if (side !== 'same' && /^={7}\r?$/.test(text)) { rows.push({ text, kind: 'marker' }); side = 'theirs'; continue; }
    if (side !== 'same' && text.startsWith('>>>>>>>')) { rows.push({ text, kind: 'marker' }); side = 'same'; continue; }
    rows.push({ text, kind: side });
  }
  return condense(rows, (r) => r.kind !== 'same', (r, i) => ({ kind: r.kind, text: r.text, line: i + 1 }));
}

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** Past this many line pairs, a text reads as replaced rather than diffed (time and memory). */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * A line diff of `before` to `after` (longest common subsequence), with the
 * lines common to both ends set aside first, which keeps the usual case (a few
 * blocks changed in a long file) small.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: 'same' as const, text }));
  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    for (const text of midA) out.push({ kind: 'del', text });
    for (const text of midB) out.push({ kind: 'add', text });
  } else {
    const cols = midB.length + 1;
    const lcs = new Uint32Array((midA.length + 1) * cols);
    const cell = (i: number, j: number): number => lcs[i * cols + j] ?? 0;
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        lcs[i * cols + j] = midA[i] === midB[j] ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1));
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      const left = midA[i] ?? '';
      const right = midB[j] ?? '';
      if (left === right) { out.push({ kind: 'same', text: left }); i++; j++; }
      else if (cell(i + 1, j) >= cell(i, j + 1)) { out.push({ kind: 'del', text: left }); i++; }
      else { out.push({ kind: 'add', text: right }); j++; }
    }
    for (; i < midA.length; i++) out.push({ kind: 'del', text: midA[i] ?? '' });
    for (; j < midB.length; j++) out.push({ kind: 'add', text: midB[j] ?? '' });
  }
  for (const text of a.slice(a.length - tail)) out.push({ kind: 'same', text });
  return out;
}

/** The diff of `after` against `before`, cut to what changed; empty when nothing did. */
export function shownDiff(before: string, after: string): ShownLine[] {
  const diff = lineDiff(before, after);
  if (!diff.some((d) => d.kind !== 'same')) return [];
  // Numbered in the resolved text; a removed line has no number there.
  let line = 0;
  const rows = diff.map((d) => ({ ...d, line: d.kind === 'del' ? null : ++line }));
  return condense(rows, (d) => d.kind !== 'same', (d) => ({ kind: d.kind, text: d.text, line: d.line }));
}

/** At most `MAX_SHOWN_LINES` lines, and how many were left out. */
export function capLines(lines: readonly ShownLine[]): { lines: ShownLine[]; hidden: number } {
  if (lines.length <= MAX_SHOWN_LINES) return { lines: [...lines], hidden: 0 };
  return { lines: lines.slice(0, MAX_SHOWN_LINES), hidden: lines.length - MAX_SHOWN_LINES };
}
