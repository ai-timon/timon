import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { slug: string; number: string } };

/** Prepares the comment asking the contributor to resolve their conflict. */
export async function POST(_req: Request, { params }: Ctx): Promise<Response> {
  return proxyJson(
    'POST',
    `/api/projects/${encodeURIComponent(params.slug)}/pull-requests/${encodeURIComponent(params.number)}/conflict/ask`,
    {},
  );
}
