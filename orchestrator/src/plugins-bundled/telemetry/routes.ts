/**
 * Routes of `@timon/telemetry`. Each declares who may call it:
 *
 *  - `GET /api/telemetry/preference` — any signed-in caller; never anonymous,
 *    even during first run;
 *  - `PUT /api/telemetry/preference` — a PERSON (session or paired device)
 *    holding `settings:write`. Never anonymous, never a mission or API token:
 *    an agent does not decide what its user shares;
 *  - `POST /api/telemetry/desktop-opened` — the daemon token alone, i.e. the
 *    desktop shell of this machine. Its body is a version, nothing else;
 *  - `POST /api/telemetry/ui-event` — a PERSON (session or paired device): the
 *    web app reports what that person opened. Never anonymous, never a token:
 *    an agent does not report page views on anyone's behalf. The body is one
 *    event of a closed list; the page path is reduced to its section here.
 *    One exception, `onboarding_screen` while the machine has no account yet:
 *    the screens before the account (welcome, background, account) have no
 *    one to sign in. The auth middleware lets an anonymous caller reach this
 *    route only then, and only on the loopback; the event is a closed list of
 *    words, and at most `ANONYMOUS_SCREEN_EVENTS` of them per daemon run.
 */
import type { Router } from 'express';
import { z } from 'zod';
import { forbidden, isPersonAuth, rejectIfDenied, rejectIfNotDaemonToken, requireAuth } from '../../users/identity.js';
import { preferenceEditable, writePreference, type TelemetryPreference } from './preference.js';
import { telemetry } from './runtime.js';
import { versionValue } from './events.js';
import { apiError } from '../../api-error.js';
import { dbApi } from '../../db.js';
import {
  ONBOARDING_LLM_CHOICES, ONBOARDING_LLM_CONNECTIONS, ONBOARDING_LLM_FAILURES, ONBOARDING_SCREEN_ACTIONS, ONBOARDING_SCREENS,
} from '../../onboarding-events.js';

/** Enough for several people trying the onboarding over and over; a script posting in a loop stops here. */
export const ANONYMOUS_SCREEN_EVENTS = 300;

const PreferenceBody = z.object({ enabled: z.boolean() }).strict();
const DesktopOpenedBody = z.object({ version: z.string().max(64).optional() }).strict();
const UiSurface = z.enum(['web', 'desktop']);
const UiEventBody = z.discriminatedUnion('name', [
  z.object({ name: z.literal('app_opened'), surface: UiSurface, setupCompleted: z.boolean(), loadMs: z.number().min(0).max(600_000).optional() }).strict(),
  z.object({ name: z.literal('ui_error'), surface: UiSurface, path: z.string().max(512) }).strict(),
  z.object({ name: z.literal('page_viewed'), surface: UiSurface, path: z.string().max(512) }).strict(),
  z.object({
    name: z.literal('upgrade_action'), surface: UiSurface,
    action: z.enum(['plans_viewed', 'buy_opened']),
    entryPoint: z.enum(['license_page', 'users', 'settings', 'banner', 'other']),
  }).strict(),
  z.object({
    name: z.literal('onboarding_screen'), surface: UiSurface,
    screen: z.enum(ONBOARDING_SCREENS),
    action: z.enum(ONBOARDING_SCREEN_ACTIONS),
    llmChoice: z.enum(ONBOARDING_LLM_CHOICES).optional(),
    // A CLI's binary name, mapped to a product backend or `other` before it leaves.
    backend: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional(),
    connection: z.enum(ONBOARDING_LLM_CONNECTIONS).optional(),
    failureCode: z.enum(ONBOARDING_LLM_FAILURES).optional(),
  }).strict(),
]);

function view(pref: TelemetryPreference): Record<string, unknown> {
  return {
    enabled: pref.enabled,
    source: pref.source,
    malformed: pref.malformed,
    editable: preferenceEditable(pref),
    // False on a source checkout or under tests: nothing would be sent anyway.
    active: telemetry().active,
  };
}

export function registerRoutes(app: Router, preference: () => TelemetryPreference): void {
  let anonymousScreens = 0;

  app.get('/api/telemetry/preference', (req, res) => {
    if (!requireAuth(req, res)) return;
    res.json(view(preference()));
  });

  app.put('/api/telemetry/preference', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (!isPersonAuth(auth)) {
      forbidden(req, res, { kind: 'scope', reason: 'only a person changes what this installation shares', hint: 'Change it in Settings › System › Privacy.' });
      return;
    }
    if (rejectIfDenied(req, res, 'settings:write')) return;
    const body = PreferenceBody.safeParse(req.body);
    if (!body.success) { res.status(400).json(apiError('enabled_required', 'enabled must be a boolean')); return; }
    const before = preference();
    if (!preferenceEditable(before)) {
      res.status(409).json({ ...apiError('telemetry_preference_forced', 'the statistics preference is set outside Timon (environment or configuration file)'), source: before.source });
      return;
    }
    writePreference(body.data.enabled);
    const after = telemetry().active ? telemetry().refreshPreference() : preference();
    res.json(view(after));
  });

  app.post('/api/telemetry/ui-event', (req, res) => {
    if (!req.auth) {
      const body = UiEventBody.safeParse(req.body);
      // Anything else, or once an account exists, gets the usual 401.
      if (body.success && body.data.name === 'onboarding_screen' && dbApi.countUsers() === 0) {
        if (anonymousScreens < ANONYMOUS_SCREEN_EVENTS) {
          anonymousScreens += 1;
          telemetry().trackUi(body.data, { userId: null });
        }
        res.json({ ok: true });
        return;
      }
    }
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (!isPersonAuth(auth)) {
      forbidden(req, res, { kind: 'scope', reason: 'only the app a person uses reports what they open' });
      return;
    }
    const body = UiEventBody.safeParse(req.body);
    if (!body.success) { res.status(400).json(apiError('telemetry_event_invalid', 'invalid event')); return; }
    telemetry().trackUi(body.data, { userId: auth.user?.id ?? null });
    res.json({ ok: true });
  });

  app.post('/api/telemetry/desktop-opened', (req, res) => {
    if (rejectIfNotDaemonToken(req, res)) return;
    const body = DesktopOpenedBody.safeParse(req.body ?? {});
    if (!body.success) { res.status(400).json(apiError('invalid_request', 'invalid body')); return; }
    const version = versionValue(body.data.version);
    telemetry().track('desktop_app_opened', version ? { desktop_version: version } : {}, 'desktop');
    res.json({ ok: true });
  });
}
