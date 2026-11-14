/**
 * `POST /api/triggers/hooks/<slug>` — the public entry of webhook triggers.
 *
 * Public in the daemon-auth sense only (`PUBLIC_ENDPOINTS`): the route
 * authenticates every call itself, with the trigger's secret, and never looks
 * at `req.auth`. The trigger's frozen grants decide what the call may do.
 *
 * Order: IP rate limit → bounded raw body (the HMAC needs the exact bytes) →
 * signature → route rate limit → JSON → pipeline. An unknown route, a disabled one and a bad
 * signature get the same 401: no oracle on which names exist.
 */
import type { Request, Response, Router } from 'express';
import { config } from '../config/load.js';
import { directLoopbackVerdict } from '../http-peer.js';
import { fireTrigger } from './engine.js';
import { flatHeaders, hookFront } from './hook-front.js';
import { TRIGGER_RELAY_HEADER } from './hook-path.js';
import { rateLimiter } from './limiter.js';
import { DEFAULT_RATE_LIMIT, SLUG_RE } from './schema.js';
import { publicHeaders, verifySignature } from './signature.js';
import { excerptOf, getWebhookTrigger, recordDelivery } from './store.js';
import { apiError } from '../api-error.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function daemonListensOnLoopback(): boolean {
  return isLoopbackHost(config().daemon.listen.host);
}

/** Whether an `auth: "none"` webhook can be reached at all on this daemon. */
export function unauthenticatedHooksPossible(): boolean {
  return daemonListensOnLoopback() && !config().daemon.behindTlsProxy;
}

/** Why an `auth: "none"` call is refused, `null` when it comes straight from this machine. */
export function unauthenticatedHookRefusal(req: Request, listensOnLoopback: boolean, behindTlsProxy: boolean): string | null {
  // The app's relay is checked first: it also writes `X-Forwarded-Host`, and its own reason is the clearer one.
  if (req.headers[TRIGGER_RELAY_HEADER] !== undefined) return 'unauthenticated route called through the app relay';
  const verdict = directLoopbackVerdict(req, behindTlsProxy);
  if (!verdict.direct && verdict.reason === 'proxy_header') {
    return `unauthenticated route called through a proxy (${(verdict.header ?? '').slice(0, 64)} header)`;
  }
  if (!verdict.direct && verdict.reason === 'behind_tls_proxy') {
    return 'unauthenticated route refused while the daemon is declared behind a proxy (daemon.behindTlsProxy)';
  }
  if (!verdict.direct || !listensOnLoopback) return 'unauthenticated route called from outside loopback';
  return browserPageRefusal(req);
}

/**
 * A page open in a browser on this machine is a loopback peer with no proxy
 * header, so the checks above take it for a local sender: any site could fire
 * the trigger with a plain `fetch`, the slug being guessable. A script or
 * `curl` sends no fetch metadata and no `Origin`; a browser does. Only the
 * daemon's own origin passes: `same-site` is refused too, since another port
 * of `localhost` is the same site and may serve anything.
 */
export function browserPageRefusal(req: Request): string | null {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return 'unauthenticated route called by a page of another origin (Sec-Fetch-Site)';
  const origin = req.headers.origin;
  if (origin === undefined) return null;
  const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : '';
  let originHost = '';
  try { originHost = typeof origin === 'string' && origin !== 'null' ? new URL(origin).host : ''; } catch { originHost = ''; }
  if (!originHost || originHost !== host) return 'unauthenticated route called by a page of another origin (Origin)';
  return null;
}

function slugOf(req: Request): string {
  const value: unknown = req.params.slug;
  return typeof value === 'string' ? value : '';
}

export function registerTriggerWebhook(router: Router, options: {
  now?: () => number;
  listensOnLoopback?: () => boolean;
  behindTlsProxy?: () => boolean;
} = {}): void {
  const now = options.now ?? Date.now;
  const listensOnLoopback = options.listensOnLoopback ?? daemonListensOnLoopback;
  const behindTlsProxy = options.behindTlsProxy ?? (() => config().daemon.behindTlsProxy);
  const allow = rateLimiter(now);
  const unauthorized = (res: Response) => { res.status(401).json({ error: 'authentication failed' }); };
  const tooMany = (res: Response) => { res.setHeader('Retry-After', '60'); res.status(429).json(apiError('rate_limited', 'rate limited')); };

  router.post('/api/triggers/hooks/:slug', hookFront({
    allow, accepts: (req) => SLUG_RE.test(slugOf(req)), unauthorized, tooMany,
  }), (req: Request, res: Response) => {
    const trigger = getWebhookTrigger(slugOf(req));
    if (!trigger || !trigger.enabled || trigger.source !== 'webhook') { unauthorized(res); return; }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const headers = flatHeaders(req);
    const scheme = trigger.config.auth;
    const rejected = (reason: string) => {
      recordDelivery({ triggerId: trigger.id, status: 'rejected', reason });
      unauthorized(res);
    };
    if (scheme === 'none') {
      // An unauthenticated route only exists for a sender on this machine,
      // and only while the daemon itself is not reachable from elsewhere: a
      // proxy on this host (`tailscale serve`) is a loopback peer too.
      const refusal = unauthenticatedHookRefusal(req, listensOnLoopback(), behindTlsProxy());
      if (refusal) { rejected(refusal); return; }
    } else if (!trigger.secret) {
      rejected('no secret configured'); return;
    }
    const verified = verifySignature(scheme, trigger.secret ?? '', body, headers, now());
    if (!verified.ok) { rejected(verified.reason); return; }
    if (!allow([{ key: `route:${trigger.id}`, max: trigger.config.rate_limit ?? DEFAULT_RATE_LIMIT }])) {
      recordDelivery({ triggerId: trigger.id, status: 'error', reason: 'rate limited', deliveryKey: verified.deliveryKey ?? verified.replayKey });
      tooMany(res);
      return;
    }

    let payload: unknown = {};
    if (body.length) {
      try { payload = JSON.parse(body.toString('utf8')); } catch {
        recordDelivery({ triggerId: trigger.id, status: 'error', reason: 'invalid JSON body', excerpt: excerptOf(body.toString('utf8')) });
        res.status(400).json({ error: 'invalid JSON body' });
        return;
      }
    }
    try {
      const result = fireTrigger(trigger, { body: payload, headers: publicHeaders(headers) }, {
        replayKey: verified.replayKey, deliveryKey: verified.deliveryKey,
      });
      switch (result.status) {
        case 'duplicate': res.status(200).json({ status: 'duplicate' }); return;
        case 'ignored': res.status(200).json({ status: 'ignored', reason: result.reason }); return;
        case 'coalesced': res.status(202).json({ status: 'coalesced' }); return;
        case 'received':
          res.status(200).json({ status: 'received', results: result.outcomes.map((o) => ({ type: o.type, id: o.ok ? o.id : null })) });
          return;
        // 502 so the sender retries; the detail stays in the journal, not
        // in a response read by whoever holds the secret.
        case 'error': res.status(502).json({ status: 'error' }); return;
      }
    } catch (err) {
      recordDelivery({ triggerId: trigger.id, status: 'error', reason: (err as Error).message });
      res.status(502).json({ status: 'error' });
    }
  });
}
