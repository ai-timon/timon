/**
 * Same-origin proxy to a project's landing setting (`project-integration.ts`):
 * read, change and go back to the local merge, from the project's settings.
 * Only the fields the screen edits cross; anything else in the body is
 * dropped here, and the daemon still validates what does cross.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ slug: string }> };

const path = (slug: string) => `/api/projects/${encodeURIComponent(slug)}/integration`;

/** What the screen writes: the pull request row's dialog, and whether Timon
 *  may resolve a contributor's conflict. `forge` stays on its only value. */
const WRITABLE = ['mode', 'remote', 'target', 'account', 'gh_config_dir', 'branch_prefix', 'remote_url', 'push_remote_url', 'contributor_conflicts'] as const;

export async function GET(_req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  return proxyJson('GET', path(params.slug));
}

/** The daemon refuses `resolve` from anyone but a signed-in person. */
export async function PUT(req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  const body = await req.json().catch(() => ({})) as Record<string, unknown> | null;
  const patch: Record<string, unknown> = {};
  for (const key of WRITABLE) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
  }
  return proxyJson('PUT', path(params.slug), patch);
}

/** Back to the local merge: the jobs already under way keep their mode. */
export async function DELETE(_req: Request, props: Ctx): Promise<Response> {
  const params = await props.params;
  return proxyJson('DELETE', path(params.slug));
}
