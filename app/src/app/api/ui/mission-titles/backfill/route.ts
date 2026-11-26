import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Capped catch-up of old titles. Body: { since?, limit?, dryRun? } — a dry run unless dryRun is false. */
export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/missions/titles/backfill', body);
}
