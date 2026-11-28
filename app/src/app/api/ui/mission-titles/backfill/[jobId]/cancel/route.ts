import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Stops a catch-up job between two conversations. */
export async function POST(_req: Request, props: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('POST', `/api/missions/titles/backfill/${encodeURIComponent(params.jobId)}/cancel`);
}
