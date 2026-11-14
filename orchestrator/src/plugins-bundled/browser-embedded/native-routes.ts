import { scopedDb } from '../../users/scoped-db.js';
import type { Request, Router } from 'express';
import { z } from 'zod';
import { dbApi } from '../../db.js';
import { loadConfig } from '../../agent-config.js';
import { resolveBrowserProject } from '../../browser-project.js';
import { createBrowserProfile, getBrowserProfile, listBrowserProfiles, resolveBrowserProfile, resolveMissionBrowserProfile, type BrowserProfile } from '../../browser-profiles.js';
import { requireAuth, viewerFromRequest, isPersonAuth } from '../../users/identity.js';
import { callNativeBrowser, chromeMissingMessage, nativeBrowserCapabilities, NativeBrowserError } from '../../native-browser-provider.js';
import { detectChromeBinary, type ChromeDetection } from '../../host/chrome-binary.js';
import { settingStr } from '../../settings.js';
import { browserControls, type BrowserActor } from '../../native-browser-control.js';
import { fillBrowserCredential, fillRequestedCredential, isRequestedCredentialId, listBrowserCredentials, listRequestedCredentials,
  saveBrowserCredentialFromPage } from '../../browser-credentials.js';
import { registerBrowserCredentialRoutes } from './credential-routes.js';
import { conversionBrowserCommand, conversionBrowserRefusal, conversionMissionOf } from '../../users/conversion-mission.js';
import { noteCollectedBrowserRecording, saveBrowserRecording, stopBrowserRecording, type BrowserRecordingMetadata, type BrowserRecordingOrigin } from '../../browser-recordings.js';
import { annotationStateOf, picksOf, saveBrowserAnnotations, type BrowserAnnotationOrigin } from '../../browser-annotations.js';

// `annotateHighlight` shows a stored selector again: a rectangle comes back, never the page's words.
// `annotateUnpin` drops the desktop bubble's pins of annotations sent or deleted elsewhere (TODO #481).
// `annotatePins` reports where the PWA's pins' elements are now (TODO #491): rectangles, never words.
const annotationCommands = ['annotateStart', 'annotateStop', 'annotatePick', 'annotateCollect', 'annotateHighlight', 'annotateUnpin', 'annotatePins'] as const;
const commands = new Set(['start', 'status', 'stop', 'navigate', 'back', 'forward', 'reload', 'resize', 'input',
  'screenshot', 'newTab', 'activateTab', 'closeTab', 'evaluate', 'presentation', 'claimControl', 'releaseControl',
  'dialogRespond', 'permissionRespond', 'audio', 'clipboardRead', 'clipboardPaste', 'contextMenuDismiss',
  'fileUploadBegin', 'fileUploadChunk', 'fileUploadCommit', 'fileUploadCancel',
  'downloadRead', 'downloadCancel', 'downloadDelete', 'listCredentials', 'fillCredential', 'saveCredentialFromPage',
  'mediaStart', 'mediaOffer', 'mediaRead', 'mediaStop', 'mediaRenew',
  'consoleList', 'consoleGet', 'networkList', 'networkGet', 'emulate', 'performanceStart', 'performanceStop',
  'chromeSigninStart', 'chromeSigninStatus', 'chromeSigninFinish', 'chromeSigninCancel',
  'recordStart', 'recordStop', 'recordStatus', ...annotationCommands]);
const reads = new Set(['start', 'status', 'screenshot', 'listCredentials', 'downloadRead',
  'consoleList', 'consoleGet', 'networkList', 'networkGet', 'chromeSigninStatus', 'recordStatus']);
const mediaCommands = new Set(['mediaStart', 'mediaOffer', 'mediaRead', 'mediaStop', 'mediaRenew']);
// Signing in is the user's act: an agent is never handed the window where a password is typed.
const humanOnly = new Set(['presentation', 'claimControl', 'releaseControl', 'permissionRespond', 'audio', 'saveCredentialFromPage',
  'chromeSigninStart', 'chromeSigninStatus', 'chromeSigninFinish', 'chromeSigninCancel', ...mediaCommands,
  // Recording is the user showing a flow: an agent neither starts it nor collects what was typed.
  'recordStart', 'recordStop',
  // Annotating is the user pointing at the page: an agent's input would make a pick they never made (TODO #468).
  ...annotationCommands]);
// What the profile's owner alone may do, like its saved passwords.
const ownerOnly = new Set(['listCredentials', 'fillCredential', 'saveCredentialFromPage', 'recordStart', 'recordStop', ...annotationCommands]);

/**
 * Who the desktop sees behind a command. It trusts `commandActor: 'human'` to let a command
 * through while the user records (TODO #461), so the value is the daemon's, from the
 * authentication, never the caller's: a person's session is human, anything else is an agent.
 */
export function commandActorOf(req: Request): 'human' | 'agent' {
  return isPersonAuth(req.auth) ? 'human' : 'agent';
}

export function recordingOriginOf(req: Request): BrowserRecordingOrigin {
  if (isPersonAuth(req.auth)) return { kind: 'user', id: req.auth.user?.id ?? null };
  if (req.auth?.missionId) return { kind: 'agent', id: scopedDb(viewerFromRequest(req)).getMission(req.auth.missionId)?.agent_name ?? null };
  return { kind: 'system', id: null };
}

/** For the parity test with the desktop's recording rules. */
/** The page a Chrome sign-in window opens on: it becomes a command-line argument of the launched browser. */
const chromeSigninUrl = z.string().max(16_384).refine((value) => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}).optional();

export const NATIVE_COMMAND_SETS = Object.freeze({ commands, reads, humanOnly, ownerOnly });

function operatorOnly(req: Request): void {
  if (!req.auth || req.auth.kind === 'api-token') throw new NativeBrowserError('This operation requires a signed-in user.', 403);
}

function missionProfile(req: Request): BrowserProfile {
  if (req.auth?.kind !== 'api-token' || !req.auth.missionId) {
    throw new NativeBrowserError('A mission-bound token is required to use the agent browser.', 403);
  }
  const mission = scopedDb(viewerFromRequest(req)).getMission(req.auth.missionId);
  if (!mission || !mission.browser_profile_resolved || !mission.browser_profile_id) {
    throw new NativeBrowserError('No browser profile is authorized for this mission.', 403);
  }
  const profile = getBrowserProfile(mission.browser_profile_id);
  if (!profile || profile.owner_user_id !== mission.owner_user_id) throw new NativeBrowserError('Browser profile is unavailable.', 403);
  const run = mission.workflow_run_id ? dbApi.getWorkflowRun(mission.workflow_run_id) : undefined;
  const workflowSlug = run ? dbApi.getWorkflow(run.workflow_id)?.slug : undefined;
  const authorized = resolveMissionBrowserProfile(mission, { workflowSlug });
  if (!authorized) throw new NativeBrowserError('Browser access is disabled.', 403);
  return authorized;
}

/** Dependencies are injected in HTTP tests; production never accepts a caller-selected endpoint. */
export function registerNativeBrowserRoutes(app: Router, deps: {
  call?: typeof callNativeBrowser;
  capabilities?: typeof nativeBrowserCapabilities;
  detectChrome?: () => ChromeDetection;
} = {}): void {
  const call = deps.call ?? callNativeBrowser;
  // The TIMON_CHROME_PATH setting (environment first, then the settings table) pins the browser.
  const detectChrome = deps.detectChrome ?? (() => detectChromeBinary({ env: { ...process.env, TIMON_CHROME_PATH: settingStr('TIMON_CHROME_PATH') } }));
  const controls = browserControls();
  const profileForRequest = (req: Request, profileId: string): BrowserProfile => {
    const profile = req.auth?.kind === 'api-token' ? missionProfile(req) : getBrowserProfile(profileId, viewerFromRequest(req));
    if (!profile || profile.id !== profileId) throw new NativeBrowserError('Browser profile not found.', 404);
    return profile;
  };
  registerBrowserCredentialRoutes(app, { profileForRequest });
  const queues = new Map<string, Promise<unknown>>();
  const serial = async <T>(profile: string, work: () => Promise<T>): Promise<T> => {
    const pending = (queues.get(profile) ?? Promise.resolve()).catch(() => {}).then(work);
    queues.set(profile, pending);
    try { return await pending; } finally { if (queues.get(profile) === pending) queues.delete(profile); }
  };
  const actorOf = (req: Request): BrowserActor => {
    if (req.auth?.missionId) return { id: `mission:${req.auth.missionId}`, kind: 'agent' };
    const clientId = req.body?.clientId;
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(clientId)) {
      throw new NativeBrowserError('A browser client identifier is required for control.');
    }
    return { id: `user:${viewerFromRequest(req)?.id ?? 'operator'}:${clientId}`, kind: 'human' };
  };
  const runCommand = async (req: Request, profile: BrowserProfile): Promise<unknown> => {
    const action = req.body?.action;
    if (typeof action !== 'string' || !commands.has(action)) throw new NativeBrowserError('Unknown browser command.');
    if (req.auth?.kind === 'api-token' && humanOnly.has(action)) {
      throw new NativeBrowserError('This browser operation is reserved for the user.', 403);
    }
    if (ownerOnly.has(action)
      && req.auth?.kind !== 'api-token' && (!isPersonAuth(req.auth) || profile.owner_user_id !== req.auth.user?.id)) {
      throw new NativeBrowserError('Browser profile not found.', 404);
    }
    // A mission also sees the values its own user typed for a page (`secret_request`); a human never does.
    if (action === 'listCredentials') {
      const requested = req.auth?.kind === 'api-token' ? listRequestedCredentials(req.auth.missionId) : [];
      return { credentials: [...listBrowserCredentials(profile), ...requested] };
    }
    let actor: BrowserActor | null = null;
    if (!reads.has(action) || req.auth?.missionId || req.body?.clientId) actor = actorOf(req);
    const command = { ...req.body, action } as Record<string, unknown>;
    delete command.clientId;
    delete command.profileId;
    delete command.mediaActor;
    command.commandActor = commandActorOf(req);
    // The binary the desktop launches is named here, by the daemon, and by nobody else.
    delete command.executable;
    if (action === 'chromeSigninStart') {
      if (!chromeSigninUrl.safeParse(command.url).success) throw new NativeBrowserError('The sign-in page must be an http or https address.', 400);
      const detection = detectChrome();
      if (!detection.found) throw new NativeBrowserError(chromeMissingMessage(detection.reason), 409);
      command.executable = detection.binary.path;
    }
    if (mediaCommands.has(action)) {
      return call(profile.id, { ...command, mediaActor: actor!.id });
    }
    // Agents never take the control lease: the user and the agent drive the same
    // browser together, each command going through the per-profile queue. The lease
    // only arbitrates between several human clients (a desktop and a phone).
    const human = actor?.kind === 'human';
    // A page can be waiting inside another command for its dialog answer.
    // The established controller must be able to respond without waiting for that queue.
    if (['dialogRespond', 'permissionRespond'].includes(action) && (!human || controls.status(profile.id, actor).holder === 'you')) {
      if (human) controls.renew(profile.id, actor!);
      const result = await call(profile.id, command);
      return result && typeof result === 'object' && 'running' in result
        ? { ...result, control: controls.status(profile.id, actor) } : result;
    }
    if (reads.has(action)) {
      if (human) controls.renew(profile.id, actor!);
      const result = await call(profile.id, command);
      if (action === 'status' || action === 'start') return { ...(result as Record<string, unknown>), control: controls.status(profile.id, actor) };
      return result;
    }
    return serial(profile.id, async () => {
      if (action === 'releaseControl') {
        controls.release(profile.id, actor!);
        await call(profile.id, { action: 'revokePresentation' });
        return { control: controls.status(profile.id, actor) };
      }
      if (human) {
        const changed = controls.acquire(profile.id, actor!, action === 'claimControl');
        if (changed) await call(profile.id, { action: 'revokePresentation' });
      }
      if (action === 'claimControl') return { control: controls.status(profile.id, actor) };
      // Plaintext is read only inside these helpers. Caller-provided secrets or
      // scripts never cross this public command boundary into the provider.
      if (action === 'fillCredential' && isRequestedCredentialId(req.body?.credentialId)) {
        // Bound to the mission behind the token: a person's session has no such value.
        if (req.auth?.kind !== 'api-token') throw new NativeBrowserError('Browser credential not found.', 404);
        return fillRequestedCredential(profile, req.auth.missionId, req.body?.credentialId, call);
      }
      if (action === 'fillCredential') return fillBrowserCredential(profile, req.body?.credentialId, call, commandActorOf(req));
      if (action === 'saveCredentialFromPage') return saveBrowserCredentialFromPage(profile, req.body?.label, call, commandActorOf(req));
      // What was recorded leaves the desktop for the sealed store only, never in a response.
      if (action === 'recordStop') return stopBrowserRecording(profile, () => call(profile.id, command), recordingOriginOf(req));
      // What was pointed at leaves the desktop for the sealed store only, like a recording.
      if (action === 'annotateStop' || action === 'annotateCollect' || action === 'annotatePick') {
        const result = await call(profile.id, command);
        if (action === 'annotatePick' && command.preview === true) return { hover: (result as { hover?: unknown } | null)?.hover ?? null };
        const saved = saveBrowserAnnotations(profile, picksOf(result), recordingOriginOf(req));
        const answer = { annotations: saved.annotations, refused: saved.refused, thumbnailsDropped: saved.thumbnailsDropped };
        if (action === 'annotatePick') return answer;
        const { annotation: _annotation, ...rest } = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
        return { ...rest, annotation: annotationStateOf(result), ...answer,
          ...('running' in rest ? { control: controls.status(profile.id, actor) } : {}) };
      }
      if (action === 'stop') await collectPendingAnnotations(profile);
      if (action === 'stop' && command.commandActor !== 'human') await collectFinishedRecording(profile, req);
      const result = await call(profile.id, command);
      if (action === 'stop' && result && typeof result === 'object' && 'recordingResult' in result) {
        const { recordingResult, ...rest } = result as Record<string, unknown>;
        const saved = recordingResult ? saveBrowserRecording(profile, recordingResult, recordingOriginOf(req)) : null;
        return { ...rest, ...(saved ? { recordingSaved: { id: saved.id } } : {}), control: controls.status(profile.id, actor) };
      }
      return result && typeof result === 'object' && 'running' in result
        ? { ...result, control: controls.status(profile.id, actor) } : result;
    });
  };
  /**
   * An agent stopping the browser after the recording ended on its own (idle, step limit): the
   * desktop only hands the steps to a human command, so the daemon collects them first, into the
   * sealed store. The agent gets nothing of them.
   */
  const collectFinishedRecording = async (profile: BrowserProfile, req: Request): Promise<BrowserRecordingMetadata | null> => {
    const state = await call(profile.id, { action: 'recordStatus', commandActor: 'agent' }).catch(() => null) as { recording?: { active?: unknown; stoppedReason?: unknown } } | null;
    if (!state?.recording || state.recording.active !== false || !state.recording.stoppedReason) return null;
    const stopped = await call(profile.id, { action: 'recordStop', commandActor: 'human' }).catch(() => null) as { recording?: unknown } | null;
    if (!stopped?.recording) return null;
    const saved = saveBrowserRecording(profile, stopped.recording, recordingOriginOf(req));
    noteCollectedBrowserRecording(saved);
    return saved;
  };
  /**
   * Stopping the browser drops the picks still waiting on the desktop (the user's, or an agent's
   * stop after the annotate mode ended on its own): the daemon collects them first, into the
   * owner's sealed store. Whoever asked for the stop gets nothing of them.
   */
  const collectPendingAnnotations = async (profile: BrowserProfile): Promise<void> => {
    const collected = await call(profile.id, { action: 'annotateCollect', commandActor: 'human' }).catch(() => null);
    const picks = picksOf(collected);
    if (!picks.length) return;
    const origin: BrowserAnnotationOrigin = { kind: 'user', id: profile.owner_user_id };
    saveBrowserAnnotations(profile, picks, origin);
  };
  const handle = (operation: (req: Request) => unknown | Promise<unknown>) => async (req: Request, res: import('express').Response) => {
    if (!requireAuth(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await operation(req)); }
    catch (error) {
      res.status(error instanceof NativeBrowserError ? error.status : 400).json({ error: (error as Error).message });
    }
  };
  app.get('/api/native-browser/capabilities', handle(async () => (deps.capabilities ?? nativeBrowserCapabilities)(detectChrome)));
  app.get('/api/native-browser/profiles', handle((req) => {
    if (req.auth?.kind === 'api-token') return { profiles: [missionProfile(req)] };
    return { profiles: listBrowserProfiles(viewerFromRequest(req)) };
  }));
  app.post('/api/native-browser/profiles', handle((req) => {
    operatorOnly(req);
    const { name, scope_kind, scope_ref, grants } = req.body ?? {};
    return { profile: createBrowserProfile({ name, scope_kind, scope_ref, grants }, viewerFromRequest(req)) };
  }));
  app.get('/api/native-browser/resolve', handle((req) => {
    if (req.auth?.kind === 'api-token') return { profile: missionProfile(req) };
    if (typeof req.query.mission === 'string') {
      const viewer = viewerFromRequest(req);
      const mission = scopedDb(viewer).getMission(req.query.mission);
      if (!mission) throw new NativeBrowserError('Mission not found.', 404);
      if (!mission.browser_profile_resolved || !mission.browser_profile_id) return { profile: null };
      const profile = getBrowserProfile(mission.browser_profile_id, viewer);
      if (!profile || profile.owner_user_id !== mission.owner_user_id) throw new NativeBrowserError('Browser profile unavailable.', 403);
      return { profile };
    }
    const agentName = typeof req.query.agent === 'string' ? req.query.agent : undefined;
    if (agentName && !/^[A-Za-z0-9._-]{1,128}$/.test(agentName)) throw new NativeBrowserError('Invalid agent.');
    const cfg = agentName ? loadConfig(agentName) : undefined;
    const project = resolveBrowserProject({ agentProject: cfg?.project, agentCwd: cfg?.cwd,
      requested: typeof req.query.project === 'string' ? req.query.project : null });
    return { profile: resolveBrowserProfile({ ownerUserId: viewerFromRequest(req)?.id ?? null, agentName, project }) };
  }));
  app.post('/api/native-browser/mission/command', handle(async (req) => {
    const profile = missionProfile(req);
    const conversion = conversionMissionOf(req);
    const refusal = conversion ? conversionBrowserRefusal(conversion, req.body) : null;
    if (refusal) throw new NativeBrowserError(refusal, 403);
    if (conversion) req.body = conversionBrowserCommand(req.body);
    return { result: await runCommand(req, profile) };
  }));
  app.post('/api/native-browser/:profileId/command', handle(async (req) => {
    const profileId = String(req.params.profileId);
    const profile = profileForRequest(req, profileId);
    return { result: await runCommand(req, profile) };
  }));
}
