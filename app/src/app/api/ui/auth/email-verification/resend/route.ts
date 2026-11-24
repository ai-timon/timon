import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A new code for the signed-in account's own challenge; the daemon checks both. */
export async function POST(req: Request): Promise<Response> {
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/auth/email-verification/resend', body);
}
