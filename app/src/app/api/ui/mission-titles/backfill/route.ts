import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Capped catch-up of old titles. Body: { since?, limit?, dryRun? } — a dry run unless dryRun is false, which answers 202 { jobId } and runs in the background. */
export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/missions/titles/backfill', body);
}

/** The account's current (running, else latest) catch-up job: `{ job }`, `null` when none. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/missions/titles/backfill');
}
