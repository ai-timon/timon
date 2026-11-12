/**
 * `/api/ui/plugins/developer` → the daemon's `/api/plugins/-/developer`, the
 * developer-mode switch of Settings › Plugins.
 *
 * Auth: the `timon_session` cookie only (`proxyJson`). The daemon admits a
 * superadmin SESSION and nothing else; the daemon token never travels here,
 * and would be refused if it did. The body is checked again by the daemon:
 * this hop only refuses what is not JSON.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DAEMON_PATH = '/api/plugins/-/developer';

export async function GET(): Promise<Response> {
  return proxyJson('GET', DAEMON_PATH);
}

export async function PUT(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid-body' }, { status: 400 });
  }
  return proxyJson('PUT', DAEMON_PATH, body);
}
