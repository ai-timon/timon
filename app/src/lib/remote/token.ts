import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getSigningKey } from './key';
import { getDb, type RemoteTokenRow } from './db';
import type { Statement } from 'better-sqlite3';
import { TOKEN_TTL_SECONDS } from '../paths';
import { secretEquals } from './constant-time';

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64urlDecode = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

type Payload = { jti: string; sub: string; iat: number; exp: number };

function sign(payload: Payload): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = createHmac('sha256', getSigningKey()).update(`${header}.${body}`).digest();
  return `${header}.${body}.${b64url(sig)}`;
}

function verify(token: string): Payload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts as [string, string, string];
  const expected = createHmac('sha256', getSigningKey()).update(`${h}.${b}`).digest();
  const provided = b64urlDecode(s);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  const payload = JSON.parse(b64urlDecode(b).toString('utf8')) as Payload;
  if (payload.exp * 1000 < Date.now()) return null;
  return payload;
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

// Statements are lazily prepared on first call — the DB itself is
// opened lazily (see getDb()), so any module-load `prepare()` would
// defeat that and run during `next build`. Cached after first use.
let stmts: {
  insert: Statement;
  findById: Statement;
  list: Statement;
  revoke: Statement;
  bump: Statement;
} | null = null;
function S() {
  if (stmts) return stmts;
  const d = getDb();
  stmts = {
    insert: d.prepare(
      `INSERT INTO remote_tokens (id, client_name, token_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
    ),
    findById: d.prepare(`SELECT * FROM remote_tokens WHERE id = ?`),
    list: d.prepare(`SELECT * FROM remote_tokens ORDER BY issued_at DESC`),
    revoke: d.prepare(`UPDATE remote_tokens SET revoked = 1 WHERE id = ?`),
    bump: d.prepare(
      `UPDATE remote_tokens SET call_count = call_count + 1, last_called_at = ? WHERE id = ?`,
    ),
  };
  return stmts;
}

export function issueToken(clientName: string): { token: string; id: string; expires_at: number } {
  const jti = randomBytes(16).toString('hex');
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_TTL_SECONDS;
  const token = sign({ jti, sub: clientName, iat, exp });
  S().insert.run(jti, clientName, hash(token), iat * 1000, exp * 1000);
  return { token, id: jti, expires_at: exp * 1000 };
}

export type VerifiedToken = { row: RemoteTokenRow; payload: Payload };

export function verifyAndLoad(token: string): VerifiedToken | null {
  const payload = verify(token);
  if (!payload) return null;
  const row = S().findById.get(payload.jti) as RemoteTokenRow | undefined;
  if (!row || row.revoked) return null;
  if (!secretEquals(hash(token), row.token_hash)) return null;
  return { row, payload };
}

export function bumpUsage(id: string): void {
  S().bump.run(Date.now(), id);
}

export function revokeToken(id: string): boolean {
  const info = S().revoke.run(id);
  return info.changes > 0;
}

export function listTokens(): RemoteTokenRow[] {
  return S().list.all() as RemoteTokenRow[];
}
