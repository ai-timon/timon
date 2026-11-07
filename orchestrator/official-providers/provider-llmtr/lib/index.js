// @ts-check
import { createLlmtrDialect } from './dialect.js';
import { LLMTR_PROFILE } from './profile.js';

export const name = 'provider-llmtr';

/** @param {import('@timon-ai/sdk/provider').ProviderPluginContext} ctx */
export function apply(ctx) {
  ctx.backends.registerDialect('llmtr', createLlmtrDialect(ctx.provider.runtime));
  ctx.provider.registerProductProfile(LLMTR_PROFILE);
}
