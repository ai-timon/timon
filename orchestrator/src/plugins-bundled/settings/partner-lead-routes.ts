/**
 * The agency offer of the signed-in account (`partner-lead.ts`):
 *
 *  - `GET /api/partners/lead` — its state;
 *  - `POST /api/partners/lead` `{ email, locale }` — asks for the offer. Only
 *    for an account whose usage kind is `agency`;
 *  - `DELETE /api/partners/lead` — withdraws it.
 *
 * A PERSON only (session or paired device), never anonymous, never a mission
 * or API token, never the CLI's daemon token: subscribing an address to an
 * offer is a consent its owner gives, not something an agent does for them.
 * The address is never echoed into an error, a log or the audit trail.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { forbidden, isPersonAuth } from '../../users/identity.js';
import type { UserRow } from '../../db.js';
import { auditRequest } from '../../users/audit-actor.js';
import { readUsageKind } from '../../onboarding-usage-kind.js';
import { normalizeLocale, partnerLeads, type PartnerLeads } from './partner-lead.js';

/** The site refuses a body over 2 KB; an address and a locale are far below. */
const BODY_MAX_BYTES = 1024;

const SubscribeBody = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  locale: z.string().max(16),
}).strict();

function personOf(req: Request, res: Response): UserRow | null {
  const auth = req.auth;
  if (!auth) { res.status(401).json({ error: 'unauthorized' }); return null; }
  if (!isPersonAuth(auth) || !auth.user) {
    forbidden(req, res, {
      kind: 'scope',
      reason: 'only the account\'s owner asks for, or withdraws, the agency offer',
      hint: 'Do it in Settings › Profile.',
    });
    return null;
  }
  return auth.user;
}

export function registerPartnerLeadRoutes(app: Router, leads: () => PartnerLeads = partnerLeads): void {
  app.get('/api/partners/lead', (req, res) => {
    const user = personOf(req, res);
    if (!user) return;
    res.json(leads().view(user.id));
  });

  app.post('/api/partners/lead', async (req, res) => {
    const user = personOf(req, res);
    if (!user) return;
    if (Buffer.byteLength(JSON.stringify(req.body ?? null)) > BODY_MAX_BYTES) {
      res.status(413).json({ error: 'too_large' });
      return;
    }
    const parsed = SubscribeBody.safeParse(req.body);
    const locale = parsed.success ? normalizeLocale(parsed.data.locale) : null;
    if (!parsed.success || !locale) {
      res.status(400).json({ error: 'invalid_request', message: 'a valid email address and locale are required' });
      return;
    }
    if (readUsageKind(user.id)?.usageKind !== 'agency') {
      res.status(409).json({ error: 'not_agency', message: 'the agency offer is for accounts that use Timon for an agency' });
      return;
    }
    try {
      const view = await leads().subscribe(user.id, parsed.data.email, locale);
      auditRequest(req, 'partners.lead_subscribe', view.state);
      res.json(view);
    } catch {
      res.status(500).json({ error: 'storage_failed', message: 'the request could not be recorded on this machine' });
    }
  });

  app.delete('/api/partners/lead', async (req, res) => {
    const user = personOf(req, res);
    if (!user) return;
    try {
      const view = await leads().withdraw(user.id);
      auditRequest(req, 'partners.lead_withdraw', view.state);
      res.json(view);
    } catch {
      res.status(500).json({ error: 'storage_failed', message: 'the withdrawal could not be recorded on this machine' });
    }
  });
}
