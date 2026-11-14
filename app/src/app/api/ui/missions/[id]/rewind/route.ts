import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Rewinds a chat to one of its user messages (docs/specs/rewind.md). The
 *  daemon checks the body and that the session's user owns the chat. */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', `/api/missions/${encodeURIComponent(params.id)}/rewind`, body);
}
