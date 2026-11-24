import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The diff of a pull request, as text read from the forge. */
export async function GET(
  _req: Request,
  { params }: { params: { slug: string; number: string } },
): Promise<Response> {
  return proxyJson(
    'GET',
    `/api/projects/${encodeURIComponent(params.slug)}/pull-requests/${encodeURIComponent(params.number)}/diff`,
  );
}
