import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Progress of a catch-up job: status, counters, last error. Only its owner reads it. */
export async function GET(_req: Request, props: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const params = await props.params;
  return proxyJson('GET', `/api/missions/titles/backfill/${encodeURIComponent(params.jobId)}`);
}
