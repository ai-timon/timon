import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Authenticated by the daemon (owner only); a running mission answers 409 on archive. */
export async function POST(_req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('POST', `/api/missions/${encodeURIComponent(params.id)}/unarchive`, {});
}
