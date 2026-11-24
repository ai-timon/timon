import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { slug: string; id: string } };

/** Commits the resolution and prepares its publication: nothing is pushed yet. */
export async function POST(_req: Request, { params }: Ctx): Promise<Response> {
  return proxyJson(
    'POST',
    `/api/projects/${encodeURIComponent(params.slug)}/forge-conflicts/${encodeURIComponent(params.id)}/propose`,
    {},
  );
}
