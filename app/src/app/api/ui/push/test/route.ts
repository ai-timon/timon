import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Verification send — takes the same path as a real permission. */
export async function POST(): Promise<Response> {
  return proxyJson('POST', '/api/push/test');
}
