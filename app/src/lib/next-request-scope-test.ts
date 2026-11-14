/**
 * Test helper: runs a route handler or a server helper inside the request
 * scope Next sets up for a real request, so `cookies()` and `headers()`
 * answer as they do in production.
 *
 * Next 15 reads them from two stores, the work store of the route and the
 * work-unit store of the request, and refuses to answer when either is
 * missing; this sets both. Load it after `globalThis.AsyncLocalStorage` is
 * set: Next creates its stores from that global when its modules first load.
 */

interface ScopeCookie { readonly value?: string }

export interface RequestScope {
  /** Absent: `headers()` throws, as in a scope that only knows its cookies. */
  headers?: Headers;
  cookies?: { get(name: string): ScopeCookie | undefined };
}

export interface RequestScopeRunner {
  run<T>(scope: RequestScope, fn: () => T): T;
}

/** The cookie jar Next expects behind `cookies()`, read through the test's
 *  `get`. Writes are refused: no route under test sets a request cookie. */
function cookieJar(source: RequestScope['cookies']) {
  const get = (name: string) => source?.get(name);
  const readOnly = (): never => { throw new Error('request cookies are read-only in tests'); };
  return {
    get,
    getAll: (): ScopeCookie[] => [],
    has: (name: string) => get(name) !== undefined,
    set: readOnly,
    delete: readOnly,
    clear: readOnly,
    size: 0,
    toString: () => '',
    [Symbol.iterator]: function* () { /* the test only answers named reads */ },
  };
}

export async function loadRequestScope(): Promise<RequestScopeRunner> {
  const { workAsyncStorage } = await import('next/dist/server/app-render/work-async-storage.external');
  const { workUnitAsyncStorage } = await import('next/dist/server/app-render/work-unit-async-storage.external');
  return {
    run(scope, fn) {
      const cookies = cookieJar(scope.cookies);
      const work = { route: '/test', forceStatic: false, dynamicShouldError: false, isStaticGeneration: false };
      const request = {
        type: 'request', phase: 'action', headers: scope.headers,
        cookies, mutableCookies: cookies, userspaceMutableCookies: cookies,
      };
      return workAsyncStorage.run(work as never, () => workUnitAsyncStorage.run(request as never, fn));
    },
  };
}
