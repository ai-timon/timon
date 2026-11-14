/**
 * Google refuses to sign in from a browser whose `window.chrome` is an empty object, which is what
 * Electron exposes; Chrome has `loadTimes`, `csi` and `app` there. With them, the same sign-in that
 * was sent to `/signin/rejected` goes on (manual A/B on Electron 33, 13/11/2026).
 *
 * The source runs in the page's main world on every document of every site, through two paths:
 * DevTools' `Page.addScriptToEvaluateOnNewDocument` (every frame) and the tab preload (the main
 * frame, in case Electron sets `window.chrome` again after the DevTools script). So it must be
 * idempotent: it replaces nothing that exists, and does nothing at all when `window.chrome`
 * already has all three. A sandboxed preload can require nothing but `electron`, so
 * `native-browser-preload.cts` keeps a copy; `native-browser-preload.test.ts` compares the two.
 *
 * The functions are methods, like Chrome's: named, without `prototype`, not constructible. The
 * `toString` of a function the shim added answers as native code, as Chrome's do; the page's own
 * functions keep their source.
 */
export const CHROME_SHIM_SOURCE = String.raw`(() => {
  if (!window.chrome || typeof window.chrome !== 'object') window.chrome = {};
  const chrome = window.chrome;
  if (chrome.loadTimes && chrome.csi && chrome.app) return;
  const natives = new WeakMap();
  const native = (holder, name) => { natives.set(holder[name], 'function ' + name + '() { [native code] }'); return holder[name]; };
  if (!chrome.loadTimes) chrome.loadTimes = native({ loadTimes() {
    const now = Date.now() / 1000;
    return { commitLoadTime: now, connectionInfo: 'h2', finishDocumentLoadTime: now, finishLoadTime: now,
      firstPaintAfterLoadTime: 0, firstPaintTime: now, navigationType: 'Other', npnNegotiatedProtocol: 'h2',
      requestTime: now, startLoadTime: now, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true,
      wasNpnNegotiated: true };
  } }, 'loadTimes');
  if (!chrome.csi) chrome.csi = native({ csi() {
    return { onloadT: Date.now(), pageT: performance.now(), startE: Date.now(), tran: 15 };
  } }, 'csi');
  if (!chrome.app) {
    const methods = {
      getDetails() { return null; },
      getIsInstalled() { return false; },
      runningState() { return 'cannot_run'; },
    };
    chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: native(methods, 'getDetails'),
      getIsInstalled: native(methods, 'getIsInstalled'),
      runningState: native(methods, 'runningState'),
    };
  }
  const toString = new Proxy(Function.prototype.toString, {
    apply(target, self, args) {
      const known = natives.get(self);
      return known === undefined ? Reflect.apply(target, self, args) : known;
    },
  });
  natives.set(toString, 'function toString() { [native code] }');
  Function.prototype.toString = toString;
})();`;
