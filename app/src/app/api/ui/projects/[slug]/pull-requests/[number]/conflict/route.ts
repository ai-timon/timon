import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { slug: string; number: string } };

/** Merges the pull request without a working tree and keeps its conflicts for a person to resolve. */
export async function POST(_req: Request, { params }: Ctx): Promise<Response> {
  return proxyJson(
    'POST',
    `/api/projects/${encodeURIComponent(params.slug)}/pull-requests/${encodeURIComponent(params.number)}/conflict`,
    {},
  );
}
