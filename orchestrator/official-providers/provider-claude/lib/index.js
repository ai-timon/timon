import { createClaudeProvider } from './claude.js';
import { createClaudeToken, runsOutsideGuiSession, MISSING_TOKEN_MESSAGE } from './token.js';
import { createClaudeUsage } from './usage.js';
import { CLAUDE_PROFILE } from './profile.js';
import { registerClaudeTokenRoutes } from './routes.js';
export const name = 'provider-claude';
export function apply(ctx) {
  const token = createClaudeToken(ctx.provider);
  const usage = createClaudeUsage(ctx.provider, token);
  ctx.provider.registerProvider(createClaudeProvider(ctx.provider, token, usage, { log: ctx.log }));
  ctx.provider.registerProductProfile(CLAUDE_PROFILE);
  registerClaudeTokenRoutes(ctx, token, usage);
  token.syncClaudeTokenMarker();
  if (runsOutsideGuiSession() && !token.claudeTokenStatus().readable) ctx.log.warn(MISSING_TOKEN_MESSAGE);
}
