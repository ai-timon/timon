import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Read-only: the account picker of a shared subscription account
// (`backend-accounts-settings.tsx`) names the people it is shared with. The
// daemon serves id and display name to a superadmin only.
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/users/directory');
}
