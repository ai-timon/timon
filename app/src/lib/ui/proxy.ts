/**
 * Same-origin proxy helpers so the static UI on timon.localhost can talk to the
 * orchestrator without crossing origins. Keep this dumb — no
 * transformation, just pass-through.
 *
 * Auth: a `timon_session` cookie is forwarded as-is. No session → no
 * identity (the daemon then 401s once any user exists). The proxy never
 * reads `TIMON_DAEMON_TOKEN` — that token is for CLI / MCP / agents,
 * which hit the daemon directly.
 *
 * Every upstream call goes through `relayFetch(await targetFor(path))`
 * (`lib/machines/target.ts`): the daemon is the browser's active machine —
 * except the account and fleet routes, anchored on the local one — and the
 * remote-machine policy (identity, `Set-Cookie`, auth routes, origin) is
 * applied there, not here.
 */
import { cookies, headers as requestHeaders, type UnsafeUnwrappedCookies, type UnsafeUnwrappedHeaders } from 'next/headers';
import { machineTarget, relayFetch, targetFor, type RelayOptions } from '../machines/target';
import { browserOriginHeaders, proxyAuthHeaders, SESSION_COOKIE } from './proxy-auth';
import { htmlFailureAsJson } from './proxy-errors';
import { uiDocumentProxyHeaders } from './ui-document-headers';

/** Session cookie plus the browser's `Origin` / `Sec-Fetch-Site` — safe to
 *  spread onto any Next→daemon fetch that serves a browser. Without the
 *  cookie the origin headers are moot: the daemon has no session to protect. */
export function sessionProxyHeaders(): Record<string, string> {
  const auth = proxyAuthHeaders({ sessionToken: sessionTokenFromCookies() });
  if (!auth.cookie) return auth;
  return { ...auth, ...originHeadersFromRequest() };
}

function originHeadersFromRequest(): Record<string, string> {
  const incoming = incomingHeaders();
  return incoming ? browserOriginHeaders(incoming) : {};
}

// Synchronous reads on purpose: Next 15 still unwraps `headers()` and
// `cookies()` in place, and these helpers feed synchronous callers.
function incomingHeaders(): UnsafeUnwrappedHeaders | null {
  try {
    return requestHeaders() as unknown as UnsafeUnwrappedHeaders;
  } catch {
    // Outside a request scope (build, tests): nothing to relay.
    return null;
  }
}

/** Which daemon a proxied call goes to when it is not the active machine's. */
export interface ProxyTarget {
  /** A machine named by the request itself (`local` or a fleet id, already
   *  validated by the route): the push actions answer for the machine that
   *  notified. Absent: the active machine, or local for an anchored path. */
  readonly machine?: string;
}

/** One upstream call to the request's target daemon. Routes that build their
 *  own body (raw text, bytes) use it instead of a fetch of their own,
 *  so they follow the active machine like every other proxied call. */
export async function relay(path: string, init: RequestInit, to: ProxyTarget = {}): Promise<globalThis.Response> {
  const opts: RelayOptions = { incoming: incomingHeaders() };
  const target = to.machine === undefined ? await targetFor(path) : await machineTarget(to.machine);
  return relayFetch(target, path, init, opts);
}

function browserProxyHeaders(): Record<string, string> {
  const headers = sessionProxyHeaders();
  // Session metadata must describe the browser, not Node's fetch client.
  try {
    const userAgent = (requestHeaders() as unknown as UnsafeUnwrappedHeaders).get('user-agent');
    if (userAgent) headers['user-agent'] = userAgent;
  } catch {
    // Outside a request scope (build, tests): skip user-agent relay.
  }
  return headers;
}

function sessionTokenFromCookies(): string | undefined {
  try {
    return (cookies() as unknown as UnsafeUnwrappedCookies).get(SESSION_COOKIE)?.value;
  } catch {
    return undefined;
  }
}

function copySetCookie(upstream: globalThis.Response, headers: Headers): void {
  const lines = typeof upstream.headers.getSetCookie === 'function'
    ? upstream.headers.getSetCookie()
    : [];
  for (const line of lines) headers.append('set-cookie', line);
  if (lines.length === 0) {
    const single = upstream.headers.get('set-cookie');
    if (single) headers.append('set-cookie', single);
  }
}

/** The daemon's `Server-Timing` phases, plus `proxy`: the whole relay seen
 *  from Next (daemon time included), so the browser's network panel splits a
 *  slow answer between the daemon and this hop. */
export function relayedServerTiming(upstream: string | null, proxyMs: number): string {
  const own = `proxy;dur=${proxyMs.toFixed(1)}`;
  return upstream ? `${upstream}, ${own}` : own;
}

export async function proxyJson(
  method: string,
  path: string,
  body?: unknown,
  to: ProxyTarget = {},
): Promise<Response> {
  // Next 14's fetch() memoises responses by URL by default; that's poison for
  // a proxy to a stateful service. Force a fresh upstream hit every time.
  const headers = browserProxyHeaders();
  const init: RequestInit = { method, headers, cache: 'no-store' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const started = performance.now();
  return relayedAnswer(await relay(path, init, to), started);
}

/** Node's fetch only streams a request body when told it is half-duplex;
 *  the DOM typings do not know the field. */
type StreamingInit = RequestInit & { duplex: 'half' };

/**
 * Relays a body the proxy does not parse — bytes, streamed to the daemon as
 * they arrive, never held whole in Next. `bodyHeaders` carries the caller's
 * `content-type` (and `content-length` when known); the session headers are
 * the same as `proxyJson`'s. The caller bounds the body: this does not.
 */
export async function proxyRawBody(
  method: string,
  path: string,
  body: ReadableStream<Uint8Array> | null,
  bodyHeaders: Readonly<Record<string, string>>,
  to: ProxyTarget = {},
): Promise<Response> {
  const headers = { ...browserProxyHeaders(), ...bodyHeaders };
  const init: RequestInit | StreamingInit = body === null
    ? { method, headers, cache: 'no-store' }
    : { method, headers, body, duplex: 'half', cache: 'no-store' };
  const started = performance.now();
  return relayedAnswer(await relay(path, init, to), started);
}

/** What the browser gets back from a proxied call: the daemon's answer as is,
 *  except an HTML error page (every client of this proxy parses JSON). */
async function relayedAnswer(upstream: globalThis.Response, started: number): Promise<Response> {
  const ct = upstream.headers.get('content-type') ?? '';
  // Pass-through, except an HTML error page: every client of this proxy parses JSON.
  const failure = htmlFailureAsJson(upstream.status, ct || null, upstream.ok);
  const outHeaders = new Headers({
    'content-type': failure ? 'application/json' : ct || 'application/json',
    'cache-control': 'no-store',
  });
  copySetCookie(upstream, outHeaders);
  // A throttled route (`sendThrottled`) says how long to wait in this header only: the page counts it down.
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) outHeaders.set('retry-after', retryAfter);
  if (failure) {
    return new Response(failure.body, { status: upstream.status, headers: outHeaders });
  }
  // Binary response (not JSON, not text/*): read raw bytes to avoid UTF-8 corruption.
  const isBinary = ct.length > 0 && !/^application\/json/i.test(ct) && !/^text\//i.test(ct);
  if (isBinary) {
    const buf = await upstream.arrayBuffer();
    for (const name of ['x-content-type-options', 'content-security-policy'] as const) {
      const value = upstream.headers.get(name);
      if (value) outHeaders.set(name, value);
    }
    return new Response(buf, { status: upstream.status, headers: outHeaders });
  }
  const text = await upstream.text();
  outHeaders.set('server-timing', relayedServerTiming(upstream.headers.get('server-timing'), performance.now() - started));
  return new Response(text, { status: upstream.status, headers: outHeaders });
}

/** Pass-through for binary upstream responses (images, etc.) where we must not
 *  JSON-decode the body. Forwards the raw bytes and the upstream content-type. */
export async function proxyBinary(path: string, opts: { securityHeaders?: boolean } & ProxyTarget = {}): Promise<Response> {
  const upstream = await relay(path, {
    headers: browserProxyHeaders(),
    cache: 'no-store',
  }, { machine: opts.machine });
  const buf = await upstream.arrayBuffer();
  const headers = new Headers({
    'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
  });
  // Opt-in, for plugin covers, stills and pictos: an SVG served on the app's
  // origin must stay the sandboxed, unsniffed document the daemon made it when
  // opened in a tab. Other callers keep their headers as they were.
  if (opts.securityHeaders) {
    for (const name of ['x-content-type-options', 'content-security-policy'] as const) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
  }
  return new Response(buf, { status: upstream.status, headers });
}

/** Upstream headers a media response keeps. The security ones matter as much
 *  as the type: opened in a tab of its own, the file must stay a sandboxed,
 *  unsniffed document. */
const MEDIA_HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'content-disposition',
  'x-content-type-options', 'content-security-policy', 'cross-origin-resource-policy', 'referrer-policy',
] as const;

/** Streams a chat media file: forwards `Range` so a video can seek, and never
 *  buffers a whole video in memory the way `proxyBinary` does. */
export async function proxyMedia(path: string, req: Request): Promise<Response> {
  const headers = browserProxyHeaders();
  const range = req.headers.get('range');
  if (range) headers.range = range;
  const upstream = await relay(path, { headers, cache: 'no-store' });
  const out = new Headers();
  for (const name of MEDIA_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  if (!out.has('cache-control')) out.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/** The HTML of a conversation document (ADR-MCPUI D3): session cookie only,
 *  headers through a white list that keeps the daemon's sandboxing CSP. */
export async function proxyUiDocument(path: string): Promise<Response> {
  const upstream = await relay(path, { headers: browserProxyHeaders(), cache: 'no-store' });
  return new Response(upstream.body, { status: upstream.status, headers: uiDocumentProxyHeaders(upstream.headers, upstream.ok) });
}

/** `?client=<id>` the page put on its stream URL, forwarded when well formed.
 *  The daemon uses it to replace this window's previous stream (one stream per
 *  window and scope) — the id names a window, it is not a credential. */
export function sseClientQuery(request: Request): string {
  const id = new URL(request.url).searchParams.get('client');
  return id !== null && /^[A-Za-z0-9._-]{1,64}$/.test(id) ? `?client=${id}` : '';
}

/** Status for a stream whose client left before there was anything to relay.
 *  Nobody reads it; it only has to be a `Response` that holds nothing open. */
const CLIENT_GONE = 499;

/**
 * Relays one SSE stream from the daemon. `request.signal` is the browser's
 * connection: when it aborts, the upstream connection must go with it.
 *
 * Do not lean on `ReadableStream.cancel` alone. Next drops a response whose
 * socket already closed (`pipeToNodeResponse` returns early on a destroyed
 * response) WITHOUT cancelling its body, so a client that left while the
 * daemon was still answering — a daemon busy enough to be slow is exactly
 * when windows give up and reconnect — left a daemon-side stream open that
 * nothing would ever read or close (TIM-0081: 177 streams).
 */
export async function proxySse(path: string, request: Request): Promise<Response> {
  const { signal } = request;
  if (signal.aborted) return new Response(null, { status: CLIENT_GONE });

  const upstreamAbort = new AbortController();
  let closeDownstream: (() => void) | null = null;
  const onAbort = (): void => {
    upstreamAbort.abort();
    closeDownstream?.();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const release = (): void => {
    signal.removeEventListener('abort', onAbort);
    upstreamAbort.abort();
  };

  let upstream: globalThis.Response;
  try {
    // cache:'no-store' is critical — without it Next 14 wraps fetch with the
    // Data Cache, which waits for the full body before returning. SSE never
    // closes, so the proxy hangs forever and the chat sits on "thinking…".
    upstream = await relay(path, {
      headers: { accept: 'text/event-stream', ...sessionProxyHeaders() },
      cache: 'no-store',
      signal: upstreamAbort.signal,
    });
  } catch (err) {
    release();
    if (signal.aborted) return new Response(null, { status: CLIENT_GONE });
    throw err;
  }
  if (!upstream.body) {
    release();
    return new Response('upstream missing body', { status: 502 });
  }
  // The client left while the daemon was answering: the response is already
  // in our hands, so close it ourselves.
  if (signal.aborted) {
    release();
    void upstream.body.cancel().catch(() => {});
    return new Response(null, { status: CLIENT_GONE });
  }
  // Manual pump: returning `upstream.body` directly lets Next 14 buffer the
  // stream before forwarding it to the client (the Data Cache wraps fetch
  // even with no-store on some paths). A hand-made ReadableStream flushes
  // each chunk as soon as it arrives from upstream — that is what keeps the
  // event-stream sidebar live instead of silent for seconds.
  const reader = upstream.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      closeDownstream = () => {
        try { controller.close(); } catch { /* already closed or cancelled */ }
        void reader.cancel().catch(() => {});
      };
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    cancel(reason) {
      release();
      reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(stream, {
    status: upstream.status,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
