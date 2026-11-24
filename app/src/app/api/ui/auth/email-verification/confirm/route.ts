import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The code the signed-in account received; the daemon records the address with the relay. */
export async function POST(req: Request): Promise<Response> {
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/auth/email-verification/confirm', body);
}
