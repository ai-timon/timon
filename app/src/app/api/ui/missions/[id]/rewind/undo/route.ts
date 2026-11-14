import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Takes back a chat's rewinds made since the last message sent (docs/specs/rewind.md).
 *  The daemon checks that the session's user owns the chat. */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return proxyJson('POST', `/api/missions/${encodeURIComponent(params.id)}/rewind/undo`, {});
}
