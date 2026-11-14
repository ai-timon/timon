// @ts-check
import { createLlmtrDialect } from './dialect.js';
import { LLMTR_PROFILE } from './profile.js';

export const name = 'provider-llmtr';

/**
 * @param {import('@timon-ai/sdk/provider').ProviderPluginContext & { fetch?: typeof fetch }} ctx
 */
export function apply(ctx) {
  // `ctx.fetch` is absent without `http:outbound`, and it refuses a host the
  // operator has not allowed. There is no other client.
  ctx.backends.registerDialect('llmtr', createLlmtrDialect(ctx.provider.runtime, {
    fetch: typeof ctx.fetch === 'function' ? ctx.fetch : undefined,
  }));
  ctx.provider.registerProductProfile(LLMTR_PROFILE);
}
