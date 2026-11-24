import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { slug: string; id: string } };

/** A person publishes the proposal on GitHub, with the text they read. */
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson(
    'POST',
    `/api/projects/${encodeURIComponent(params.slug)}/forge-proposals/${encodeURIComponent(params.id)}/publish`,
    body,
  );
}
