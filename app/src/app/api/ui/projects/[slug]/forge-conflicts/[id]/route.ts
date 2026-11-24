import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { slug: string; id: string } };

/** A conflict resolution, its files' versions and, once proposed, its diff. */
export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return proxyJson('GET', `/api/projects/${encodeURIComponent(params.slug)}/forge-conflicts/${encodeURIComponent(params.id)}`);
}
