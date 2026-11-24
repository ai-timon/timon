import type { Request, Router } from 'express';
import type { BrowserProfile } from '../../browser-profiles.js';
import { deleteBrowserCredential, listBrowserCredentials, upsertBrowserCredential } from '../../browser-credentials.js';
import { NativeBrowserError } from '../../native-browser-provider.js';
import { requireAuth, isPersonAuth } from '../../users/identity.js';
import { apiError } from '../../api-error.js';

/** The parent resolver applies the fixed mission profile and current grants.
 * These routes never accept provider endpoints, plaintext reads, or fill scripts. */
export function registerBrowserCredentialRoutes(app: Router, deps: {
  profileForRequest: (req: Request, profileId: string) => BrowserProfile;
}): void {
  const profile = (req: Request, write = false): BrowserProfile => {
    if (write && req.auth?.kind === 'api-token') throw new NativeBrowserError(apiError('browser_credential_owner_only', 'Only a signed-in owner can save or delete browser credentials.'), 403);
    if (req.auth?.kind !== 'api-token' && (!isPersonAuth(req.auth) || !req.auth.user)) {
      throw new NativeBrowserError(apiError('browser_credential_auth_required', 'Browser credentials require a signed-in owner or an authorized mission.'), 403);
    }
    const resolved = deps.profileForRequest(req, String(req.params.profileId));
    // Administrator visibility does not grant use of somebody else's passwords.
    if (req.auth?.kind !== 'api-token' && resolved.owner_user_id !== (req.auth?.user?.id ?? null)) {
      throw new NativeBrowserError(apiError('browser_profile_not_found', 'Browser profile not found.'), 404);
    }
    return resolved;
  };
  const handle = (operation: (req: Request) => unknown) => (req: Request, res: import('express').Response) => {
    if (!requireAuth(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(operation(req)); }
    catch (error) {
      if (error instanceof NativeBrowserError) res.status(error.status).json(error.body);
      else res.status(500).json(apiError('browser_credential_failed', 'The browser credential operation failed.'));
    }
  };
  app.get('/api/native-browser/:profileId/credentials', handle((req) => ({ credentials: listBrowserCredentials(profile(req)) })));
  app.post('/api/native-browser/:profileId/credentials', handle((req) => {
    const ownerProfile = profile(req, true);
    const { id, origin, label, username, password } = req.body ?? {};
    return { credential: upsertBrowserCredential(ownerProfile, { id, origin, label, username, password }) };
  }));
  app.delete('/api/native-browser/:profileId/credentials/:credentialId', handle((req) => ({
    ok: deleteBrowserCredential(profile(req, true), String(req.params.credentialId)),
  })));
}
