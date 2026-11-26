import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const qs = new URLSearchParams();
  qs.set('limit', url.searchParams.get('limit') ?? '200');
  const project = url.searchParams.get('project');
  if (project) qs.set('project', project);
  const agent = url.searchParams.get('agent');
  if (agent) qs.set('agent', agent);
  // Validated by the daemon (400 on an unknown value).
  const origin = url.searchParams.get('origin');
  if (origin) qs.set('origin', origin);
  // Validated by the daemon: exclude (its default), include or only.
  const archived = url.searchParams.get('archived');
  if (archived) qs.set('archived', archived);
  return proxyJson('GET', `/api/missions?${qs}`);
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/missions', body);
}
