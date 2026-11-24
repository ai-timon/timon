import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

// Only a draft title and description cross: the daemon validates both.
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { title?: unknown; body?: unknown };
  return proxyJson('POST', `/api/kanban/landings/${encodeURIComponent(params.id)}/preview`, {
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.body !== undefined ? { body: body.body } : {}),
  });
}
