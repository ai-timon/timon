/**
 * Same-origin proxy to the landing gesture of a job kept on its branch. Only a
 * pull request's title and description cross: the daemon checks the session,
 * `projects:manage` and the job's scope, and decides what moves.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { title?: unknown; body?: unknown };
  return proxyJson('POST', `/api/kanban/landings/${encodeURIComponent(params.id)}/land`, {
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.body !== undefined ? { body: body.body } : {}),
  });
}
