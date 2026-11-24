import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { slug: string; id: string } };

/** "Do not publish": nothing but the ids crosses. */
export async function POST(_req: Request, { params }: Ctx): Promise<Response> {
  return proxyJson(
    'POST',
    `/api/projects/${encodeURIComponent(params.slug)}/forge-proposals/${encodeURIComponent(params.id)}/discard`,
    {},
  );
}
