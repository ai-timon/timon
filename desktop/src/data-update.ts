import { request as httpRequest } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readReleaseNotes, selectReleaseNotes } from '../scripts/release-notes.mjs';
import { readDataVersion, localUpdateOffer } from '../scripts/data-update.mjs';
import { compareVersions, markSnapshotWarningShown, snapshotFailureDialog, type SnapshotFailure } from './data-restore.js';
import { isTimon, probeHealth, type HealthResult } from './health.js';
import { windowsLauncherUnmarked } from './service.js';
import { shellText } from './shell-i18n.js';

export { localUpdateOffer };
export const DOWNGRADE_URL = 'https://docs.timon-ai.com/installation/downgrading';
export const updateOffer = (home: string, version: string) => localUpdateOffer(home, version, compareVersions);
export type UpdateOffer = NonNullable<ReturnType<typeof updateOffer>>;

/**
 * Why the daemon already serving this home is not one the app can migrate,
 * or null when the offer stands. Only a packaged daemon (embedded, or the
 * app's service) mounts the update routes and writes `update-token`; a daemon
 * run from the sources never writes `data-version` either, so `updateOffer`
 * alone offered it a migration from 0.1.0 that could only fail (TODO #477).
 *
 * The configured supervisor cannot decide this: the packaged onboarding writes
 * `systemd-user`, `launchd` or `windows` too, with or without a service. What
 * decides is the daemon that answers. Nothing answering means this app will
 * start its own daemon, which waits for the approval: the offer stays. So does
 * every home with the app's service installed — never weaken a real package.
 */
export function unmanagedDaemon(home: string, health: HealthResult, serviceInstalled: boolean,
  tokenPresent: boolean = existsSync(join(home, 'update-token'))): string | null {
  if (serviceInstalled || !health.ok || !isTimon(health, home) || health.packaged === true) return null;
  if (health.packaged === false) return 'it was not started by the Timon app (it says so on /api/health)';
  // A daemon older than the `packaged` field: every packaged one since 0.1.1 wrote the token at boot.
  return tokenPresent ? null : 'it was not started by the Timon app (it never wrote an update token)';
}

/**
 * `update-token` is written by a packaged daemon only. Without it no request
 * can be authenticated, so none is sent, and the failure says so instead of a
 * raw ENOENT (TODO #477).
 */
export class UpdateTokenMissingError extends Error {
  constructor() {
    super('The Timon daemon of this data directory was not started by the Timon app (it never wrote an update token), '
      + 'so it cannot apply this update. Nothing was sent to it. Quit Timon, stop that daemon, then open Timon again.');
    this.name = 'UpdateTokenMissingError';
  }
}

/**
 * How far an approved update went, which bounds what its failure may claim:
 * `none` — nothing sent, no service touched; `service` — the service runner
 * ran, but no approval left; `approval` — the daemon received the approval
 * (or had it already), so a migration may have started.
 */
export type UpdateStage = 'none' | 'service' | 'approval';
export type UpdateStatus = {
  status: 'pending' | 'applying' | 'ready' | 'failed'; daemonVersion: string;
  backup: { failure: SnapshotFailure | null }; error: string | null;
};
export type Progress = { version: string; phase: 'scanning' | 'database' | 'plugins' | 'complete' | 'failed'; copiedBytes: number; totalBytes: number; at: number };
/**
 * The app's default dark theme, so this window looks like the onboarding that
 * follows it. Source: app/src/plugins-client/ui-theme-tokens.ts (dark block),
 * copied because the desktop package does not depend on app/.
 */
export const THEME = {
  background: '#101114', // --surface-0
  foreground: '#ebebeb', // --foreground
  muted: '#acb0b9', // --muted-foreground
  border: '#383c42', // --border
  chip: '#25282c', // --surface-chip (--surface-3)
  primary: '#e07d61', // --primary (salmon)
  primaryForeground: '#141414', // --primary-foreground
} as const;

/** Same tokens, light block of ui-theme-tokens.ts. */
export const LIGHT_THEME = {
  background: '#f6f7f8', // --surface-0
  foreground: '#171717', // --foreground
  muted: '#5e636e', // --muted-foreground
  border: '#cfd2d8', // --border
  chip: '#ffffff', // --surface-chip (--surface-3)
  primary: '#cc583e', // --primary
  primaryForeground: '#ffffff', // --primary-foreground
} as const;

export function themeFor(scheme: 'light' | 'dark'): { [K in keyof typeof THEME]: string } {
  return scheme === 'light' ? LIGHT_THEME : THEME;
}

export function readProgress(home: string, version: string, since: number): Progress | null {
  try {
    const p = JSON.parse(readFileSync(join(home, 'backups', 'snapshot-progress.json'), 'utf8')) as Progress;
    return p.version === version && Number.isFinite(p.at) && p.at >= since && ['scanning', 'database', 'plugins', 'complete', 'failed'].includes(p.phase)
      && Number.isFinite(p.copiedBytes) && p.copiedBytes >= 0 && Number.isFinite(p.totalBytes) && p.totalBytes >= 0 ? p : null;
  } catch { return null; }
}
export function updateCopy(locale: string) {
  const t = shellText(locale);
  return {
    title: (o: UpdateOffer) => t('update.title', { from: o.from, to: o.to }),
    detail: t('update.detail'),
    intact: t('update.intact'),
    quitDetail: t('update.quitDetail'),
    approve: t('update.approve'), quit: t('update.quit'),
    /** A refused AppImage update: the replaced AppImage is still beside it, one click puts it back. */
    rollback: (o: UpdateOffer) => t('update.rollback', { from: o.from }),
    quitDetailRollback: (o: UpdateOffer) => t('update.quitDetailRollback', { from: o.from }),
    rollbackRestarting: (o: UpdateOffer) => t('update.rollbackRestarting', { from: o.from }),
    rolledBack: (o: UpdateOffer) => t('update.rolledBack', { from: o.from }),
    rolledBackDetail: t('update.rolledBackDetail'),
    rollbackFailed: (o: UpdateOffer) => t('update.rollbackFailed', { from: o.from }),
    rollbackFailedDetail: t('update.rollbackFailedDetail'),
    /** Running missions on the version being replaced (P3): the approval would stop them. */
    missions: (count: number, from: string) => t('update.missions', { count, from }),
    wait: t('update.wait'), approveAnyway: t('update.approveAnyway'), notes: t('update.notes'), changelog: t('update.changelog'), downgrade: t('update.downgrade'),
    working: t('update.working'), waiting: t('update.waiting'),
    /** The update approved by "Restart and install": a progress, no question (docs/AUTO-UPDATE.md §10). */
    progressTitle: (o: UpdateOffer) => t('update.progressTitle', { from: o.from, to: o.to }),
    preparing: t('update.preparing'),
    ready: t('update.ready'), partial: t('update.partial'),
    phases: {
      scanning: t('update.phases.scanning'), database: t('update.phases.database'), plugins: t('update.phases.plugins'),
      complete: t('update.phases.complete'), failed: t('update.phases.failed'),
    },
    /** Shown after the progress message; numbers in the reader's format. */
    bytes: (copied: number, total: number) => t('update.bytes', { copied, total }),
    failure: t('update.failure'),
    stillStarting: t('update.stillStarting'),
    stillStartingDetail: t('update.stillStartingDetail'),
    failureDetail: t('update.failureDetail'),
    failureDetailNotSent: t('update.failureDetailNotSent'),
    failureDetailServiceOnly: t('update.failureDetailServiceOnly'),
  };
}
/** The failure dialog of an approved update: it says only what happened (TODO #477). */
export function updateFailureDialog(locale: string, stage: UpdateStage, error: string): { message: string; detail: string } {
  const copy = updateCopy(locale);
  const detail = stage === 'approval' ? copy.failureDetail : stage === 'service' ? copy.failureDetailServiceOnly : copy.failureDetailNotSent;
  return { message: copy.failure, detail: `${detail}\n\n${error}` };
}

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Code spans, bold and link text, on already escaped text. */
function inline(text: string): string {
  return text.split(/(`[^`]+`)/).map(part => part.length > 2 && part.startsWith('`') && part.endsWith('`')
    ? `<code>${part.slice(1, -1)}</code>`
    // The window refuses any navigation it did not offer, so a link keeps only its text.
    : part.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')).join('');
}

/**
 * The Markdown subset CHANGELOG.md uses: headings, `-` lists whose items wrap
 * onto indented lines, paragraphs, and inline code, bold and links. The text is
 * escaped first, so nothing in the notes can inject markup.
 */
export function renderNotes(markdown: string): string {
  const html: string[] = [];
  let list: string[] | null = null;
  let paragraph: string[] = [];
  const flushParagraph = () => { if (paragraph.length) html.push(`<p>${inline(paragraph.join(' '))}</p>`); paragraph = []; };
  const flushList = () => { if (list) html.push(`<ul>${list.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`); list = null; };
  for (const raw of escape(markdown).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!line.trim()) { flushParagraph(); flushList(); }
    else if (heading) { flushParagraph(); flushList(); html.push(`<h4>${inline(heading[1] ?? '')}</h4>`); }
    else if (item) { flushParagraph(); (list ??= []).push(item[1] ?? ''); }
    else if (list && /^\s/.test(line)) list[list.length - 1] += ` ${line.trim()}`;
    else { flushList(); paragraph.push(line.trim()); }
  }
  flushParagraph(); flushList();
  return html.join('');
}
/**
 * `rollback`: the AppImage this update replaced is still beside it, so the
 * screen offers to go back to it (`update-install.ts`, `rollBackAppImage`).
 */
export function updatePage(offer: UpdateOffer, notesPath: string, locale: string, scheme: 'light' | 'dark' = 'dark', rollback = false): { html: string; links: string[] } {
  const THEME = themeFor(scheme);
  const copy = updateCopy(locale);
  const catalog = readReleaseNotes(notesPath);
  const entries = selectReleaseNotes(catalog, offer.from, offer.to).filter(n => n.content.trim());
  const links = [DOWNGRADE_URL, ...(catalog ? [catalog.changelogUrl] : [])];
  const { tag, dir } = shellText(locale);
  return { links, html: `<!doctype html><html lang="${tag}" dir="${dir}"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<title>${escape(copy.title(offer))}</title><style>
:root{color-scheme:${scheme}}*{box-sizing:border-box}body{margin:0;background:${THEME.background};color:${THEME.foreground};font:15px/1.6 system-ui,sans-serif}main{max-width:760px;margin:auto;padding:32px}h1{font-size:24px;line-height:1.3;margin:0 0 20px}h2{font-size:18px}p{max-width:70ch}.muted{color:${THEME.muted};font-size:13px}a{color:${THEME.primary}}a:focus-visible{outline:3px solid ${THEME.primary};outline-offset:4px}.notes{overflow-wrap:anywhere}h4{font-size:15px;margin:16px 0 4px}ul{margin:4px 0;padding-left:22px}li{margin:4px 0}code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:${THEME.chip};padding:1px 5px;border-radius:4px}section{border-top:1px solid ${THEME.border};margin-top:24px}footer{display:flex;flex-wrap:wrap;gap:12px;justify-content:flex-end;margin-top:28px}.button{padding:9px 20px;border:1px solid ${THEME.border};border-radius:6px;text-decoration:none;color:${THEME.foreground}}.primary{background:${THEME.primary};border-color:${THEME.primary};color:${THEME.primaryForeground}}.button:hover{filter:brightness(1.2)}.button[aria-disabled=true]{opacity:.55;pointer-events:none}progress{width:100%;accent-color:${THEME.primary}}#status{white-space:pre-wrap}#progress-area:empty{display:none}.missions{background:${THEME.chip};padding:12px 16px;border-radius:6px}
</style><main><h1>${escape(copy.title(offer))}</h1><div id="intro"><p>${escape(copy.detail)}</p><p class="muted">${escape(copy.intact)}</p><p>${escape(rollback ? copy.quitDetailRollback(offer) : copy.quitDetail)}</p></div>
<p id="missions" class="missions" role="alert" hidden></p>
<p><a href="${DOWNGRADE_URL}">${escape(copy.downgrade)}</a>${catalog ? ` · <a href="${escape(catalog.changelogUrl)}">${escape(copy.changelog)}</a>` : ''}</p>
${entries.length ? `<section><h2>${escape(copy.notes)}</h2>${entries.map(n => `<h3>${escape(n.version)}${n.date ? ` · ${escape(n.date)}` : ''}</h3><div class="notes">${renderNotes(n.content)}</div>`).join('')}</section>` : ''}
<div id="progress-area"><p id="status" role="status" aria-live="polite"></p><progress id="progress" hidden></progress></div>
<footer><a class="button" id="quit" role="button" href="timon-update:quit">${escape(copy.quit)}</a>${rollback ? `<a class="button" id="rollback" role="button" href="timon-update:rollback">${escape(copy.rollback(offer))}</a>` : ''}<a class="button primary" id="approve" role="button" href="timon-update:approve">${escape(copy.approve)}</a></footer></main></html>` };
}

/**
 * The update the person already approved by clicking "Restart and install":
 * its title and a progress, nothing to read or choose. The `pre-<version>`
 * copy is still taken; only the question is gone.
 */
export function updateProgressPage(offer: UpdateOffer, locale: string, scheme: 'light' | 'dark' = 'dark'): { html: string; links: string[] } {
  const THEME = themeFor(scheme);
  const copy = updateCopy(locale);
  const { tag, dir } = shellText(locale);
  return { links: [], html: `<!doctype html><html lang="${tag}" dir="${dir}"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<title>${escape(copy.progressTitle(offer))}</title><style>
:root{color-scheme:${scheme}}*{box-sizing:border-box}body{margin:0;background:${THEME.background};color:${THEME.foreground};font:15px/1.6 system-ui,sans-serif}main{max-width:560px;margin:auto;padding:48px 32px}h1{font-size:22px;line-height:1.3;margin:0 0 24px}progress{width:100%;accent-color:${THEME.primary}}#status{white-space:pre-wrap;color:${THEME.muted}}
</style><main><h1>${escape(copy.progressTitle(offer))}</h1>
<div id="progress-area"><p id="status" role="status" aria-live="polite">${escape(copy.preparing)}</p><progress id="progress"></progress></div></main></html>` };
}

// A synchronous plugin backup can exceed fetch's default header timeout.
// Keep the approval connection open without treating that silence as a dead daemon.
const updateFetch: typeof fetch = async (input, init) => {
  if (init?.method !== 'POST') return fetch(input, init);
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(String(input), { method: 'POST', headers: init.headers as Record<string, string>, agent: false }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) { response.destroy(new Error('Update response too large.')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks).toString('utf8'), { status: response.statusCode ?? 500 })));
    });
    request.on('error', reject);
    request.end(String(init.body));
  });
};

/**
 * Only a packaged daemon mounts the update routes: a 401 means the daemon on
 * the port was started without that environment. The one case the desktop can
 * tell apart without a secret is a Windows task whose launcher lacks the
 * marker (TIM-0087); anything else may be an older Timon still running.
 */
export function updateUnauthorizedMessage(home: string, launcherUnmarked = windowsLauncherUnmarked(home)): string {
  return launcherUnmarked
    ? 'The Timon background service was installed by `timon service install` from Timon 0.1.3 or earlier, '
      + 'which does not run it as the app\'s service, so it cannot apply this update (401). '
      + 'Open Timon again and accept the Windows permission prompt: Timon rewrites the service before updating. '
      + 'If no prompt appears, run `timon service install` again from this version of Timon.'
    : 'The Timon daemon on this port was not started by the Timon app and cannot apply this update (401): '
      + 'an older Timon, or a service installed from a terminal, may still hold the port. '
      + 'Quit Timon, end every Timon process (or restart the computer), then open Timon again.';
}

export async function requestUpdate(origin: string, home: string, version?: string, fetcher: typeof fetch = updateFetch): Promise<UpdateStatus> {
  const url = new URL(origin);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password) throw new Error('Update requests require a local daemon.');
  let token: string;
  try { token = readFileSync(join(home, 'update-token'), 'utf8').trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UpdateTokenMissingError(); throw error; }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid update token file.');
  const res = await fetcher(new URL(version ? '/api/update/approve' : '/api/update/status', url), {
    method: version ? 'POST' : 'GET', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, ...(version ? { 'Content-Type': 'application/json' } : {}) },
    ...(version ? { body: JSON.stringify({ version, approve: true }) } : { signal: AbortSignal.timeout(3000) }),
  });
  if (res.status === 401) throw new Error(updateUnauthorizedMessage(home));
  const value = await res.json() as Partial<UpdateStatus>;
  if (!['pending', 'applying', 'ready', 'failed'].includes(value.status ?? '') || typeof value.daemonVersion !== 'string'
    || !value.backup || !(value.error === null || typeof value.error === 'string')) throw new Error(`Update request failed (${res.status}).`);
  const failure = value.backup.failure;
  if (failure !== null && (!failure || typeof failure.message !== 'string' || typeof failure.blocking !== 'boolean')) throw new Error('Invalid backup status.');
  if (!res.ok && value.status !== 'failed') throw new Error(`Update request refused (${res.status}).`);
  return value as UpdateStatus;
}

/**
 * The migration is done and the daemon said `ready`; only its normal boot is
 * left, and it has not answered within the budget. Not a failed update: the
 * shell must say "still starting", never "data may have changed" (a Windows
 * tester read that after a boot that took two and a half minutes, 21/10/2026).
 */
export class DaemonStartTimeoutError extends Error {
  constructor(message: string, readonly detail: string) { super(message); this.name = 'DaemonStartTimeoutError'; }
}

/**
 * How long the normal boot gets after the migration. A packaged daemon
 * verifies its release before anything else and a managed Windows PC
 * (antivirus, Entra profile) counts that in tens of seconds, on top of the
 * plugins and the providers' first checks.
 */
export const START_BUDGET_MS = 300_000;

/**
 * How long the installed version gets to answer its update routes once the
 * previous version's daemon was replaced: the task starts, the launcher waits
 * for the session, the daemon verifies its release. Bounded, so a service
 * that never comes back ends in a message and not in a window that waits.
 */
export const REPLACE_BUDGET_MS = 180_000;

export type FinishUpdateInput = { home: string; origin: string; version: string; locale: string;
  progress: (message: string, progress?: Progress | null) => void;
  warning: (message: string, detail: string) => Promise<void>;
  /** Called once the daemon holds the approval: from here, the data may change. */
  approving?: () => void;
  /** Called before the previous version's daemon is replaced: from here, the service was touched. */
  replacing?: () => void;
};

export type FinishUpdateDeps = {
  request: typeof requestUpdate;
  health: typeof probeHealth;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Ends the daemon of this data directory that still runs another version
   * and starts the installed one (the service runner's `restart`). Absent:
   * this shell has nothing that could replace it, and the failure says what
   * the person can do.
   */
  replaceStaleDaemon?: () => Promise<void>;
};

export const finishUpdateDeps: FinishUpdateDeps = {
  request: requestUpdate, health: probeHealth, sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)), now: Date.now,
};

const STALE_ADVICE = 'Quit Timon, restart the computer, then open Timon again.';

/**
 * The daemon that answers runs another version than the one installed: an
 * update replaced the application under a daemon that was never ended, which
 * keeps the port and the data directory, so the installed version cannot
 * start (Windows, 0.1.7 to 0.1.8). It used to be a dead end, "The running
 * daemon is not the installed version", at every launch.
 *
 * Replaced once, and only when it is the daemon of THIS data directory: a
 * daemon of another home on the port is someone else's, and is never ended.
 * Nothing was approved yet, so the data are untouched whatever happens here.
 */
async function replaceStaleDaemon(input: FinishUpdateInput, deps: FinishUpdateDeps, health: HealthResult, running: string): Promise<UpdateStatus> {
  const wrong = `The running daemon is not the installed version: it runs ${running}, and Timon ${input.version} is installed.`;
  if (!deps.replaceStaleDaemon || !isTimon(health, input.home)) throw new Error(`${wrong} ${STALE_ADVICE}`);
  input.replacing?.();
  input.progress(updateCopy(input.locale).working);
  try {
    await deps.replaceStaleDaemon();
  } catch (error) {
    throw new Error(`${wrong} Timon could not replace it: ${(error as Error).message || String(error)}\n\n${STALE_ADVICE}`);
  }
  const now = deps.now ?? Date.now;
  const deadline = now() + REPLACE_BUDGET_MS;
  let last = `version ${running} still answers`;
  while (now() < deadline) {
    try {
      const status = await deps.request(input.origin, input.home);
      if (status.daemonVersion === input.version) return status;
      last = `version ${status.daemonVersion} still answers`;
    } catch (error) {
      // The service is restarting: a refused connection is the expected answer for a while.
      last = (error as Error).message || String(error);
    }
    await deps.sleep(500);
  }
  throw new Error(`${wrong} Timon restarted its background service, but version ${input.version} did not answer in time (${last}).\n\n${STALE_ADVICE}`);
}

export async function finishUpdate(input: FinishUpdateInput, deps: FinishUpdateDeps = finishUpdateDeps): Promise<void> {
  const copy = updateCopy(input.locale);
  const initialHealth = await deps.health(input.origin);
  // Another shell or an interrupted, already approved boot may have finished meanwhile.
  if (isTimon(initialHealth, input.home) && initialHealth.ok && !initialHealth.updatePending
    && readDataVersion(input.home) === input.version) return;
  let status = await deps.request(input.origin, input.home);
  if (status.daemonVersion !== input.version) status = await replaceStaleDaemon(input, deps, initialHealth, status.daemonVersion);
  const since = Date.now();
  input.progress(copy.waiting);
  const timer = setInterval(() => {
    const progress = readProgress(input.home, input.version, since);
    if (progress) input.progress(copy.phases[progress.phase], progress);
  }, 300);
  let result: UpdateStatus;
  // `ready` means an earlier launch already approved it: the data were migrated then.
  input.approving?.();
  try { result = status.status === 'ready' ? status : await deps.request(input.origin, input.home, input.version); }
  finally { clearInterval(timer); }
  if (result.backup.failure) {
    const message = snapshotFailureDialog(result.backup.failure, input.locale);
    // Shown here, not again when the main window opens right after.
    if (!result.backup.failure.blocking) markSnapshotWarningShown(input.home, result.backup.failure);
    await input.warning(message.message, message.detail);
    if (result.backup.failure.blocking) throw new Error(message.detail);
  }
  if (result.status !== 'ready') throw new Error(result.error ?? copy.failure);
  input.progress(copy.ready);
  const now = deps.now ?? Date.now;
  const deadline = now() + START_BUDGET_MS;
  while (now() < deadline) {
    const health = await deps.health(input.origin);
    if (isTimon(health, input.home) && health.ok && !health.updatePending) return;
    await deps.sleep(300);
  }
  throw new DaemonStartTimeoutError(copy.stillStarting, copy.stillStartingDetail);
}
