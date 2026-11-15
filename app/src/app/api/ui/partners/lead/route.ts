import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** { state, email, error, at } — the signed-in account's agency offer request. The daemon serves a person only. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/partners/lead');
}

/** { email, locale } — asks for the agency offer; the daemon sends it to the site, never the browser. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  return proxyJson('POST', '/api/partners/lead', body);
}

/** Withdraws the agency offer request. */
export async function DELETE(): Promise<Response> {
  return proxyJson('DELETE', '/api/partners/lead');
}
