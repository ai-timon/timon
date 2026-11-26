import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Asks for a new generated title. Body: { force?: boolean } — force replaces a name typed by hand or set by the launcher. */
export async function POST(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/missions/${encodeURIComponent(params.id)}/title/regenerate`, body);
}
