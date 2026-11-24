import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

// Nothing crosses but the id: the daemon decides whether the forge is asked.
export async function POST(_req: Request, { params }: Ctx): Promise<Response> {
  return proxyJson('POST', `/api/kanban/landings/${encodeURIComponent(params.id)}/checks`, {});
}
