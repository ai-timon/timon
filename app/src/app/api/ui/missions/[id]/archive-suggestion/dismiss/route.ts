import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Authenticated by the daemon (owner only): the person turns an agent's archive proposal down. */
export async function POST(_req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('POST', `/api/missions/${encodeURIComponent(params.id)}/archive-suggestion/dismiss`, {});
}
