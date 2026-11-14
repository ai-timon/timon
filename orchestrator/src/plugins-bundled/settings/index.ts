/**
 * Module `@timon/settings` — settings registry and installation export/import.
 * Tier `core`: everything else reads its values.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerDirectoryRoutes } from './directory-routes.js';
import { registerIslandRoutes } from './island-routes.js';
import { registerIsolationRoutes } from './isolation-routes.js';
import { registerNavigateRoutes } from './navigate-routes.js';
import { registerNavRoutes } from './nav-routes.js';
import { registerOnboardingProfileRoutes } from './onboarding-profile-routes.js';
import { registerLayoutProposalRoutes } from './layout-proposals.js';
import { registerRoutes } from './routes.js';
import { registerWidgetRoutes } from './widget-routes.js';
import { resolve, settingBool, settingInt, settingStr } from '../../settings.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    settings: { resolve: typeof resolve; settingStr: typeof settingStr; settingInt: typeof settingInt; settingBool: typeof settingBool };
  }
}

export const manifest: ModuleManifest = {
  name: '@timon/settings',
  tier: 'core',
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerRoutes(ctx.http.router());
  // What an agent may do with its owner's screen: read it, propose a change
  // the owner applies from a card, save a preset (`widget-routes.ts`).
  registerWidgetRoutes(ctx.http.router());
  registerIslandRoutes(ctx.http.router());
  registerNavigateRoutes(ctx.http.router());
  registerNavRoutes(ctx.http.router());
  registerOnboardingProfileRoutes(ctx.http.router());
  registerLayoutProposalRoutes(ctx.http.router());
  // The folders of this machine, for a picker that is not on it (TIM-0136).
  registerDirectoryRoutes(ctx.http.router());
  // The mission fence's card in Settings › System › Security (GHSA-f58g).
  registerIsolationRoutes(ctx.http.router());

  // The service does not hide the registry (all the code still imports it
  // directly): it serves as an ordering token, like `db`. A module that
  // injects it knows the settings are resolved before its `apply`.
  ctx.provide('settings', { resolve, settingStr, settingInt, settingBool });
}
