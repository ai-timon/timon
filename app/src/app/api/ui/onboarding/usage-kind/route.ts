import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** { usageKind, at } — who the signed-in account uses Timon for (`null` until answered). The daemon checks the session. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/onboarding/usage-kind');
}

/** { usageKind } — written by the onboarding's profile step; the daemon validates the value and refuses an anonymous call. */
export async function PUT(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  return proxyJson('PUT', '/api/onboarding/usage-kind', body);
}
