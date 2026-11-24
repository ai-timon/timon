import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mails a code to the signed-in account's own address (docs/EMAIL-CODES.md).
 * The daemon checks the session and that the address still waits for it.
 */
export async function POST(req: Request): Promise<Response> {
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/auth/email-verification', body);
}
