import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { slug: string; number: string } };

/** Prepares "update the branch" as a publication: nothing reaches GitHub before it is published. */
export async function POST(_req: Request, { params }: Ctx): Promise<Response> {
  return proxyJson(
    'POST',
    `/api/projects/${encodeURIComponent(params.slug)}/pull-requests/${encodeURIComponent(params.number)}/update-branch`,
    {},
  );
}
