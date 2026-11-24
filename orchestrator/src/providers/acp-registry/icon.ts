/**
 * The logo the ACP registry publishes for an agent, carried to the provider's
 * brand (C9) so the catalogue serves it as a data URL: the browser never fetches
 * a third-party address.
 *
 * Downloaded once at install, from the registry's own CDN only (`trustedIconUrl`),
 * bounded in size and time, without following a redirect elsewhere. Judged by the
 * same check as any provider's brand (`brandProblems`), then kept on disk so a
 * daemon restart restores it with no network call. The file is checked again
 * when read: a file edited by hand is dropped, never registered.
 *
 * A logo is decoration: whatever goes wrong, the agent installs without one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { brandProblems, MAX_BRAND_SVG_BYTES } from '../../backends/provider-declarations.js';
import { DownloadError, downloadVerified, type Fetcher } from './download.js';

const ICON_TIMEOUT_MS = 15_000;

/** An XML prolog is not part of the picture; `brandProblems` wants the `<svg>` element first. */
function withoutProlog(svg: string): string {
  return svg.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/i, '');
}

/** The SVG ready to declare as a brand, or why it is refused. */
export function checkedIconSvg(raw: string): { svg: string } | { problem: string } {
  const svg = withoutProlog(raw);
  const problems = brandProblems({ svg });
  return problems.length === 0 ? { svg } : { problem: problems.join('; ') };
}

export type IconOutcome =
  | { kind: 'svg'; svg: string }
  /** The registry publishes no usable icon address. */
  | { kind: 'none' }
  /** Served, but not acceptable as a logo (unsafe, wrong type, too big). The reason is safe to log (no address). */
  | { kind: 'refused'; reason: string }
  /** Not served (network error, timeout, non-2xx, redirect). The reason is safe to log (no address). */
  | { kind: 'unreachable'; reason: string };

/** Download failures that judge the icon itself, as opposed to the road to it. */
const REFUSING_CODES = new Set<DownloadError['code']>(['too-large', 'insecure', 'checksum']);

/** Downloads and checks the icon at `url` (already filtered by `trustedIconUrl`); never throws. */
export async function fetchIcon(url: string | undefined, workDir: string, fetchFn: Fetcher): Promise<IconOutcome> {
  if (!url) return { kind: 'none' };
  const file = join(workDir, 'icon.svg');
  try {
    // No redirect: the address was checked to be the registry's CDN, a hop could lead anywhere.
    await downloadVerified(url, file, { fetchFn, maxBytes: MAX_BRAND_SVG_BYTES, maxRedirects: 0, timeoutMs: ICON_TIMEOUT_MS });
    const checked = checkedIconSvg(readFileSync(file, 'utf8'));
    return 'svg' in checked ? { kind: 'svg', svg: checked.svg } : { kind: 'refused', reason: checked.problem };
  } catch (err) {
    if (!(err instanceof DownloadError)) return { kind: 'unreachable', reason: 'the icon could not be read' };
    return { kind: REFUSING_CODES.has(err.code) ? 'refused' : 'unreachable', reason: err.message };
  } finally {
    rmSync(file, { force: true });
  }
}

/** The kept icon, checked again; null when there is none or it no longer passes. Never touches the network. */
export function readIcon(file: string): string | null {
  try {
    if (!existsSync(file) || statSync(file).size > MAX_BRAND_SVG_BYTES) return null;
    const checked = checkedIconSvg(readFileSync(file, 'utf8'));
    return 'svg' in checked ? checked.svg : null;
  } catch {
    return null;
  }
}

export function writeIcon(file: string, svg: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, svg, { mode: 0o600 });
  renameSync(tmp, file);
}
