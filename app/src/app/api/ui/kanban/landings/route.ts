/**
 * Same-origin proxy to the landing of Kanban jobs (integration branches and
 * pull requests). The session cookie names the reader; only the daemon's own
 * filters are forwarded.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FILTERS = ['project', 'series', 'todo'];

export async function GET(req: Request): Promise<Response> {
  const incoming = new URL(req.url).searchParams;
  const query = new URLSearchParams();
  for (const name of FILTERS) {
    const value = incoming.get(name);
    if (value !== null) query.set(name, value);
  }
  const suffix = query.size ? `?${query}` : '';
  return proxyJson('GET', `/api/kanban/landings${suffix}`);
}
