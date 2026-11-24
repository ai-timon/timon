/**
 * Same-origin proxy to a job's repairs. Only the kind of repair crosses: the
 * daemon reads the forge again, checks that a signed-in person asks, and
 * decides whether a task starts.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { kind?: unknown };
  return proxyJson('POST', `/api/kanban/landings/${encodeURIComponent(params.id)}/repairs`, { kind: body.kind });
}
