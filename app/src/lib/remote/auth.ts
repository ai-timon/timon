import { NextResponse } from 'next/server';
import { verifyAndLoad, bumpUsage, type VerifiedToken } from './token';
import { rateLimit } from './rateLimit';
import { audit } from './audit';
import { secretEquals } from './constant-time';

export type AuthContext = { tokenId: string; clientName: string };

export function requireHttps(req: Request): NextResponse | null {
  if (process.env.TIMON_ALLOW_HTTP === '1') return null;
  const proto = req.headers.get('x-forwarded-proto');
  // Tailscale serve / reverse proxy sets x-forwarded-proto=https.
  // Direct connections won't have it — refuse unless explicitly allowed.
  if (proto === 'https') return null;
  return NextResponse.json(
    { error: 'HTTPS required. Set TIMON_ALLOW_HTTP=1 for local dev.' },
    { status: 426 },
  );
}

function extractBearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]! : null;
}

export function clientIp(req: Request): string | null {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    null
  );
}

/** Run before every /api/remote/* handler (except issue-token and openapi). */
export function authenticate(
  req: Request,
  pathLabel: string,
): { ctx: AuthContext; verified: VerifiedToken } | NextResponse {
  const tls = requireHttps(req);
  if (tls) {
    audit({ tokenId: null, clientName: null, method: req.method, path: pathLabel, status: 426, ip: clientIp(req) });
    return tls;
  }
  const raw = extractBearer(req);
  if (!raw) {
    audit({ tokenId: null, clientName: null, method: req.method, path: pathLabel, status: 401, ip: clientIp(req) });
    return NextResponse.json({ error: 'missing bearer token' }, { status: 401 });
  }
  const verified = verifyAndLoad(raw);
  if (!verified) {
    audit({ tokenId: null, clientName: null, method: req.method, path: pathLabel, status: 401, ip: clientIp(req) });
    return NextResponse.json({ error: 'invalid or expired token' }, { status: 401 });
  }
  const { row, payload } = verified;
  if (!rateLimit(row.id)) {
    audit({ tokenId: row.id, clientName: row.client_name, method: req.method, path: pathLabel, status: 429, ip: clientIp(req) });
    return NextResponse.json({ error: 'rate limit exceeded' }, { status: 429 });
  }
  bumpUsage(row.id);
  return {
    ctx: { tokenId: row.id, clientName: payload.sub },
    verified,
  };
}

/** Issue-token endpoint guard: require master env bearer. */
export function authenticateMaster(req: Request): NextResponse | null {
  const tls = requireHttps(req);
  if (tls) return tls;
  const master = process.env.TIMON_REMOTE_MASTER;
  if (!master) {
    return NextResponse.json(
      { error: 'TIMON_REMOTE_MASTER not configured on server' },
      { status: 500 },
    );
  }
  const raw = extractBearer(req);
  if (!raw || !secretEquals(raw, master)) {
    return NextResponse.json({ error: 'master auth required' }, { status: 401 });
  }
  return null;
}
