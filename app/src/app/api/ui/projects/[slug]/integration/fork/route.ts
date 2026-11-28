import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ slug: string }> };

// Creates the account's fork of the target repository. Only the person's
// explicit confirmation crosses: the daemon refuses anything but a signed-in
// person and a body that says `confirm: true`.
export async function POST(req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  const body = await req.json().catch(() => ({})) as Record<string, unknown> | null;
  return proxyJson('POST', `/api/projects/${encodeURIComponent(params.slug)}/integration/fork`, { confirm: body?.confirm === true });
}
