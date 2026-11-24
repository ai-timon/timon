/**
 * The setup wizard's refusals as coded bodies the webview translates.
 *
 * The onboarding modules throw their reason as the error's message
 * (`MainAgentSetupError('name_taken')`): that name stays their contract, read
 * by the agent-facing setup routes too. The wizard's own routes answer it here,
 * one literal code per reason, so `api-error-codes.test.ts` can check that
 * every one has a message.
 */
import { apiError, type ApiErrorBody } from '../../api-error.js';
import { MainAgentSetupError } from '../../onboarding-main-agent.js';
import { ResumeError } from '../../onboarding-resume.js';
import { TeamSetupError } from '../../onboarding-team.js';
import { SetupError } from '../../setup.js';

const ALREADY_COMPLETE = () => apiError('setup_already_complete', 'Setup is already complete.');

/** `POST /api/setup/resume`. */
export function resumeErrorBody(error: unknown): ApiErrorBody {
  if (error instanceof ResumeError) {
    if (error.message === 'setup_complete') return ALREADY_COMPLETE();
    if (error.message === 'nothing_to_resume') return apiError('setup_nothing_to_resume', 'This installation holds nothing to resume.');
  }
  // An unknown edition or profile: the reason names the value, it stays technical.
  if (error instanceof SetupError) return apiError('setup_failed', error.message, { detail: error.message });
  return apiError('setup_resume_failed', 'The existing installation could not be resumed.');
}

/** `POST /api/setup/main-agent`, the identity step. */
export function mainAgentErrorBody(error: unknown): ApiErrorBody {
  switch (error instanceof MainAgentSetupError ? error.message : '') {
    case 'step_not_pending': return apiError('setup_main_agent_step_done', 'This step is already done.');
    case 'main_agent_unavailable': return apiError('setup_main_agent_unavailable', 'No main agent was found on this installation.');
    case 'invalid_name': return apiError('setup_main_agent_invalid_name', 'This name contains no letter or digit Timon can use.');
    case 'name_taken': return apiError('setup_main_agent_name_taken', 'An agent already goes by this name.');
    case 'workspace_unavailable': return apiError('setup_workspace_unavailable', 'The working folder is unavailable.');
    case 'rename_failed': return apiError('setup_main_agent_rename_failed', 'The agent could not be renamed.');
    case 'invalid_avatar': return apiError('setup_main_agent_invalid_avatar', 'This picture is not one Timon stored.');
    default: return apiError('setup_main_agent_failed', 'The main agent could not be saved.');
  }
}

export const invalidIdentityBody = () => apiError('setup_invalid_identity', 'The name or the picture of the main agent is invalid.');

/** `POST /api/setup/team`. */
export function teamErrorBody(error: unknown): ApiErrorBody {
  switch (error instanceof TeamSetupError ? error.message : '') {
    case 'workspace_unavailable': return apiError('setup_workspace_unavailable', 'The working folder is unavailable.');
    case 'backend_unavailable': return apiError('setup_team_backend_unavailable', 'No agent tool is available.');
    case 'agent_conflict': return apiError('setup_team_agent_conflict', 'A starter agent has been changed since creation began.');
    case 'team_unavailable': return apiError('setup_team_unavailable', 'Team setup is not available on this installation.');
    case 'preset_locked': return apiError('setup_team_preset_locked', 'Team creation has already started.');
    case 'instance_not_empty': return apiError('setup_team_instance_not_empty', 'This installation already holds agents or work.');
    default: return apiError('setup_team_failed', 'The team could not be fully created.');
  }
}

export const invalidPresetBody = () => apiError('setup_team_invalid_preset', 'Unknown team preset.');

/** Why the restart step cannot restart the daemon (`restartForOnboarding`). */
export function restartRefusalBody(reason: 'setup_complete' | 'steps_pending' | 'restart_not_available'): ApiErrorBody {
  switch (reason) {
    case 'setup_complete': return ALREADY_COMPLETE();
    case 'steps_pending': return apiError('setup_restart_steps_pending', 'Finish the previous setup steps before restarting.');
    case 'restart_not_available': return apiError('setup_restart_unavailable', 'Timon cannot restart itself on this machine.');
  }
}

export const alreadyCompleteBody = ALREADY_COMPLETE;
export const restartRequiredBody = () => apiError('setup_restart_required', 'This machine runs Timon as a service: restart it to finish setup.');
