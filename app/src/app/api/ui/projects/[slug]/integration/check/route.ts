import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { slug: string } };

// Asks gh which account it signs in as: the stored setting, or the draft of
// the settings dialog (its account and folder only; nothing is written).
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const body = await req.json().catch(() => ({})) as Record<string, unknown> | null;
  const draft: Record<string, unknown> = {};
  for (const key of ['account', 'gh_config_dir'] as const) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) draft[key] = body[key];
  }
  return proxyJson('POST', `/api/projects/${encodeURIComponent(params.slug)}/integration/check`, draft);
}
