/**
 * Same-origin proxy to `@timon/telemetry`: what the web app reports about the
 * person using it (opening, page, licence offers, onboarding screens). The
 * daemon refuses anyone but a signed-in person, except an onboarding screen
 * while the machine has no account yet, and validates the event; the session
 * cookie is what is forwarded.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/telemetry/ui-event', body);
}
