import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = new Set(['start', 'stop', 'restart', 'rebuild']);

export async function POST(
  req: Request,
  { params }: { params: { slug: string; action: string } },
): Promise<Response> {
  if (!ACTIONS.has(params.action)) {
    return Response.json({ error: 'action must be start|stop|restart|rebuild' }, { status: 400 });
  }
  // Optional body: `{ container }` targets a single container; absent = the whole stack.
  const body = await req.json().catch(() => ({}));
  return proxyJson(
    'POST',
    `/api/docker/${encodeURIComponent(params.slug)}/${params.action}`,
    body,
  );
}
