/**
 * Same-origin proxy to the publications proposed on a project's forge. The
 * session cookie names the person: the daemon refuses a write from anyone
 * else (`person_required`). Only the `state` filter crosses on a read.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { slug: string } };

const base = (slug: string) => `/api/projects/${encodeURIComponent(slug)}/forge-proposals`;

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  const state = new URL(req.url).searchParams.get('state');
  const suffix = state === null ? '' : `?${new URLSearchParams({ state })}`;
  return proxyJson('GET', `${base(params.slug)}${suffix}`);
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson('POST', base(params.slug), body);
}
