import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The page of a pull request, read from the forge. Only `fresh` and
 *  `updated` cross: the daemon validates both. */
export async function GET(
  req: Request,
  { params }: { params: { slug: string; number: string } },
): Promise<Response> {
  const from = new URL(req.url).searchParams;
  const query = new URLSearchParams();
  for (const key of ['fresh', 'updated']) {
    const value = from.get(key);
    if (value !== null) query.set(key, value);
  }
  const suffix = query.size > 0 ? `?${query}` : '';
  return proxyJson(
    'GET',
    `/api/projects/${encodeURIComponent(params.slug)}/pull-requests/${encodeURIComponent(params.number)}${suffix}`,
  );
}
