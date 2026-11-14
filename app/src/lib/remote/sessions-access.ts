/**
 * Who may read `/remote/sessions`: the page lists the remote API tokens of
 * THIS computer (`remote.db`, read from disk by the app), so it answers to
 * this computer's daemon, whatever machine the browser is switched to.
 *
 * The middleware only checks that a session cookie is PRESENT; any value
 * passed it, and the page then listed every token, its client and its recent
 * calls. The local daemon is asked who the session is: a superadmin of this
 * computer, or nobody.
 */
import { cookies } from 'next/headers';
import { localTarget, relayFetch } from '../machines/target';
import { proxyAuthHeaders, SESSION_COOKIE } from '../ui/proxy-auth';

export async function localSuperadmin(): Promise<boolean> {
  let session: string | undefined;
  try {
    session = (await cookies()).get(SESSION_COOKIE)?.value;
  } catch {
    return false;
  }
  if (!session) return false;
  const target = localTarget();
  try {
    const res = await relayFetch(target, '/api/auth/me', {
      headers: { ...proxyAuthHeaders({ sessionToken: session }), accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(target.timeoutMs),
    });
    if (!res.ok) return false;
    const body = await res.json() as { user?: { is_superadmin?: unknown } | null };
    return body.user?.is_superadmin === true;
  } catch {
    return false;
  }
}
