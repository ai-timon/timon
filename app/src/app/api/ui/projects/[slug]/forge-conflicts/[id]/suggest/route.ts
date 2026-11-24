import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { slug: string; id: string } };

/** An agent with no tool suggests a text for one file; the daemon never applies it. */
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson(
    'POST',
    `/api/projects/${encodeURIComponent(params.slug)}/forge-conflicts/${encodeURIComponent(params.id)}/suggest`,
    body,
  );
}
