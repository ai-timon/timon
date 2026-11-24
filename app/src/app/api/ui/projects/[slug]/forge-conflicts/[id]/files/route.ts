import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { slug: string; id: string } };

/** One file's resolution; the daemon validates the body (`choice`, `path`, `text`). */
export async function PUT(req: Request, { params }: Ctx): Promise<Response> {
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson(
    'PUT',
    `/api/projects/${encodeURIComponent(params.slug)}/forge-conflicts/${encodeURIComponent(params.id)}/files`,
    body,
  );
}
