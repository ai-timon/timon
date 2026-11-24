/**
 * Module `@timon/http` — the transport itself: SSE stream, statistics,
 * resource health, usage, latest events. Tier `core`.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes as registerLicenseRoutes } from '../../kernel/routes/license.js';
import { registerRoutes } from './routes.js';
import { registerRemoteMcpRoutes } from '../../remote-mcp/routes.js';
import { registerRoutes as registerAppRearmRoute } from '../web-app/routes.js';
import { registerShutdownRoute } from './shutdown-route.js';

export const manifest: ModuleManifest = {
  name: '@timon/http',
  tier: 'core',
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerRoutes(ctx.http.router());
  // Kernel-owned, mounted here because `@timon/http` holds the router. The
  // license is a kernel gate, not an installable module.
  registerLicenseRoutes(ctx.http.router());
  // The MCP tools over HTTP for remote agents: a transport, like the SSE stream.
  registerRemoteMcpRoutes(ctx.http.router());
  // Here rather than in `@timon/web-app`: it must answer while that module is
  // off, to say why there is nothing to rearm (TODO #485).
  registerAppRearmRoute(ctx.http.router());
  // The common stop over the loopback, for the Windows stop paths that have
  // no signal to send (`shutdown-route.ts`).
  registerShutdownRoute(ctx.http.router());
}
