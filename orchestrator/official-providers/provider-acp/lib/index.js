// @ts-check
/**
 * opencode, Hermes and Antigravity as one official provider plugin, written against `ctx.provider` and
 * nothing else (`docs/PROVIDERS-SDK.md` § 11.1, § 12.1). It ships in the release, is loaded the
 * way a third party's plugin is, and its files are vouched for by the signed inventory.
 *
 * Each agent is a row of data (`agents.js`) handed to the daemon's own ACP runtime, so what the
 * plugin brings is the declaration, not a copy of the protocol: a fix to the session driver or to
 * the model probe reaches every agent with the daemon. The profile ids and the id of each
 * provider are the product's own (`opencode`, `hermes`, `antigravity`); the
 * profiles themselves are in `profiles.js`. Pi has a plugin of its own (`provider-pi`).
 */
import { ACP_AGENTS } from './agents.js'
import { ANTIGRAVITY_PROFILE, HERMES_PROFILE, OPENCODE_PROFILE } from './profiles.js'

export const name = 'provider-acp'

/** @param {import('@timon-ai/sdk/provider').ProviderPluginContext} ctx */
export function apply(ctx) {
  const { acp } = ctx.provider.runtime
  for (const agent of ACP_AGENTS) ctx.provider.registerProvider(acp.defineProvider(ctx.provider, agent))
  for (const profile of [OPENCODE_PROFILE, HERMES_PROFILE, ANTIGRAVITY_PROFILE]) ctx.provider.registerProductProfile(profile)
}
