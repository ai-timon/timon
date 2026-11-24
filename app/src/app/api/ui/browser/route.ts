import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Every active browser session, across all projects. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/browser');
}
