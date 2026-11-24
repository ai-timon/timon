import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return proxyJson('GET', `/api/kanban/landings/${encodeURIComponent(params.id)}`);
}
