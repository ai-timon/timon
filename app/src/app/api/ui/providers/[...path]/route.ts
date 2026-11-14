/**
 * `/api/ui/providers/*` → the daemon's `/api/plugins/-/providers/*`.
 * An allow-list, not a pass-through: the provider list, the authorization of a
 * provider's resolved binary, and the ACP registry (list / install / sign-in
 * methods / remove).
 *
 * Auth: the `timon_session` cookie only (`proxyJson`). The daemon admits a
 * superadmin SESSION and nothing else — the daemon token never travels here.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: { path: string[] } };
const DAEMON = '/api/plugins/-/providers';
const PLUGIN_ID = /^[a-z0-9-]{3,40}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const notFound = (): Response => Response.json({ error: 'not found' }, { status: 404 });

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const path = params.path.join('/');
  if (path === 'list') return proxyJson('GET', DAEMON);
  if (path === 'acp-registry') {
    const refresh = new URL(request.url).searchParams.get('refresh') === '1' ? '?refresh=1' : '';
    return proxyJson('GET', `${DAEMON}/acp-registry${refresh}`);
  }
  return notFound();
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const [head, tail, ...rest] = params.path;
  const body: unknown = await request.json().catch(() => undefined);
  if (body === undefined) return Response.json({ error: 'invalid-body' }, { status: 400 });
  if (head === 'acp-registry' && tail === 'install' && rest.length === 0) {
    return proxyJson('POST', `${DAEMON}/acp-registry/install`, body);
  }
  if (head === 'acp-registry' && tail && AGENT_ID.test(tail) && rest.length === 1 && rest[0] === 'auth-methods') {
    return proxyJson('POST', `${DAEMON}/acp-registry/${tail}/auth-methods`, body);
  }
  if (head && PLUGIN_ID.test(head) && tail === 'authorize' && rest.length === 0) {
    return proxyJson('POST', `${DAEMON}/${head}/authorize`, body);
  }
  return notFound();
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  const [head, agent, ...rest] = params.path;
  if (head !== 'acp-registry' || !agent || !AGENT_ID.test(agent) || rest.length > 0) return notFound();
  const response = await proxyJson('DELETE', `${DAEMON}/acp-registry/${agent}`);
  // 204 carries no body.
  return response.status === 204 ? new Response(null, { status: 204 }) : response;
}
