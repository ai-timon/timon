import { themeFor } from './data-update.js';
import { FIRST_RUN_THEME } from './first-run-theme.js';
import { shellText } from './shell-i18n.js';

/** Where startup stands: the service is coming up, then the interface, or neither made it. */
export type WaitingStep = 'service' | 'interface' | 'failed';
/** What a page can show: the release check (TODO #439) comes before the window of the startup view. */
export type PageStep = WaitingStep | 'verifying';

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function waitingCopy(locale: string) {
  const t = shellText(locale);
  const steps = (own: 'service' | 'interface') => ({ active: t(`waiting.${own}.active`), done: t(`waiting.${own}.done`), pending: t(`waiting.${own}.pending`) });
  return {
    title: t('waiting.title'),
    hint: t('waiting.hint'),
    restartTitle: t('waiting.restartTitle'),
    restartHint: t('waiting.restartHint'),
    verifying: t('waiting.verifying'),
    verifyingHint: t('waiting.verifyingHint'),
    service: steps('service'),
    interface: steps('interface'),
    failedTitle: t('waiting.failedTitle'),
    failedDetail: t('waiting.failedDetail'),
  };
}

/**
 * Local page shown in the window until the interface answers; no remote document, no script.
 * `restart`: the end of a first setup, where the embedded daemon hands over to the service.
 * `firstRun`: no configuration yet, the onboarding comes next: the page takes
 * its look (Timon theme, its halo).
 *
 * The steps (release check, service, interface) sit in a small card in the
 * bottom-right corner, as the onboarding's "Preparing Timon" card does: a
 * slow computer used to stare at a full-window list of spinners. The centre
 * stays empty, except for the restart's sentence and a failure's explanation.
 *
 * `frameless`: the window has no system title bar (`window-frame.ts`), and
 * the top bar of the interface that stands for it is not there yet: a strip
 * across the top keeps the window movable, by a drag or a double click.
 */
export function waitingPage(locale: string, scheme: 'light' | 'dark', step: PageStep, restart = false, firstRun = false, frameless = false): string {
  const THEME = firstRun ? FIRST_RUN_THEME[scheme] : themeFor(scheme);
  const copy = waitingCopy(locale);
  const state = (own: 'service' | 'interface'): 'done' | 'active' | 'pending' =>
    step === 'verifying' ? 'pending'
      : step === 'interface' ? (own === 'service' ? 'done' : 'active') : own === 'service' ? 'active' : 'pending';
  const row = (own: 'service' | 'interface') => {
    const s = state(own);
    return `<li class="${s}"><span class="mark" aria-hidden="true"></span>${escape(copy[own][s])}</li>`;
  };
  const verifying = step === 'verifying' ? `<li class="active"><span class="mark" aria-hidden="true"></span>${escape(copy.verifying)}</li>` : '';
  const hint = step === 'verifying' ? copy.verifyingHint : restart ? null : copy.hint;
  const card = `<aside class="card" role="status" aria-live="polite"><p class="card-title">${escape(restart ? copy.restartTitle : copy.title)}</p>`
    + `<ul>${verifying}${row('service')}${row('interface')}</ul>${hint ? `<p class="muted">${escape(hint)}</p>` : ''}</aside>`;
  const body = step === 'failed'
    ? `<main><h1>${escape(copy.failedTitle)}</h1><p class="muted">${escape(copy.failedDetail)}</p></main>`
    : (restart ? `<main><h1>${escape(copy.restartTitle)}</h1><p class="muted">${escape(copy.restartHint)}</p></main>` : '') + card;
  // The onboarding's halo (`onboarding-shell.tsx`): the primary at 10 %, high on the page.
  const halo = firstRun ? `;background-image:radial-gradient(ellipse 55% 45% at 50% 15%,${THEME.primary}1a,transparent 70%)` : '';
  const { tag, dir } = shellText(locale);
  const drag = frameless ? '<div class="drag" aria-hidden="true"></div>' : '';
  return `<!doctype html><html lang="${tag}" dir="${dir}"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<title>Timon</title><style>
:root{color-scheme:${scheme}}*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:${THEME.background}${halo};color:${THEME.foreground};font:15px/1.6 system-ui,sans-serif;display:flex;align-items:center;justify-content:center}main{padding:32px;min-width:280px;text-align:center}h1{font-size:24px;line-height:1.3;margin:0 0 12px}.muted{color:${THEME.muted};font-size:13px;margin:0}`
    + `.card{position:fixed;bottom:16px;inset-inline-end:16px;width:min(260px,calc(100vw - 32px));padding:12px 14px;border-radius:14px;background:${THEME.chip};box-shadow:0 10px 30px rgba(0,0,0,.25);font-size:12.5px;line-height:1.4}.card-title{margin:0 0 8px;font-size:13px;font-weight:600}.card .muted{font-size:12px;margin-top:8px}`
    + `ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}li{display:flex;align-items:center;gap:9px;color:${THEME.muted}}li.active,li.done{color:${THEME.foreground}}.mark{width:13px;height:13px;border-radius:50%;border:1.5px solid ${THEME.border};flex:none}li.done .mark{background:${THEME.primary};border-color:${THEME.primary}}li.active .mark{border-color:${THEME.border};border-top-color:${THEME.primary};animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){li.active .mark{animation:none;border-color:${THEME.primary}}}`
    + `.drag{position:fixed;top:0;inset-inline:0;height:48px;-webkit-app-region:drag;app-region:drag}
</style>${drag}${body}</html>`;
}

export const waitingUrl = (locale: string, scheme: 'light' | 'dark', step: PageStep, restart = false, firstRun = false, frameless = false): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(waitingPage(locale, scheme, step, restart, firstRun, frameless))}`;
