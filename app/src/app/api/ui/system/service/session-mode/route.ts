import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Settings › System: keep the service running once the user logs out, or
 *  not. Only the two answers travel; the daemon decides what they mean on
 *  this machine and refuses anyone but a signed-in superadmin. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { mode?: unknown };
  if (body.mode !== 'session' && body.mode !== 'always') {
    return Response.json({ error: 'mode must be "session" or "always"' }, { status: 400 });
  }
  return proxyJson('POST', '/api/admin/service/session-mode', { mode: body.mode });
}
