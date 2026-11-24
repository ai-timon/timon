/**
 * Per-request identity for third-party plugins (`docs/MULTI-USER.md` §7).
 *
 * A plugin is loaded once; `ctx.user` cannot be a field on the fiber. The
 * auth middleware already stamps `req.auth`. Plugin routers enter this
 * store so facades (`missions.list`, `kanban.list`, `user()`,
 * `assertPermission`) read the caller of THIS request. Outside a request
 * (job, `ctx.effect`) the store is empty: system identity `plugin:<id>`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';
import { PLUGIN_OWNER_PREFIX } from '../users/api-tokens.js';
import { isPersonAuth, viewerFromRequest } from '../users/identity.js';
import type { DbViewer } from '../users/owned.js';
import { viewerAllows } from '../users/surfaces.js';

import type { PluginUser } from './contract/core.js';
export type { PluginUser } from './contract/core.js';

export type PluginRequestIdentity = {
  viewer: DbViewer | null;
  user: PluginUser | undefined;
  /** `auth.user.id` when the caller is a real account; otherwise `null`. */
  ownerUserId: string | null;
  /**
   * Nobody is in front of this call although it acts for an account: an
   * event handler, an inbound webhook delivery, a workflow or transport
   * callback (`integrationRequestIdentity` sets it by default). What a job may
   * not do without the operator's approval (open a task that runs) it may not
   * do either.
   */
  unattended?: true;
  /**
   * A person at a screen made this request (a session or a paired device),
   * not the daemon token, a mission's token or a plugin's. Only
   * `identityFromRequest` sets it.
   */
  person?: true;
};

const pluginRequestAls = new AsyncLocalStorage<PluginRequestIdentity>();

export function identityFromRequest(req: Request): PluginRequestIdentity {
  const auth = req.auth;
  const user = auth?.user
    ? {
        id: auth.user.id,
        email: auth.user.email,
        name: auth.user.name,
        is_superadmin: auth.user.is_superadmin,
      }
    : undefined;
  return {
    viewer: viewerFromRequest(req),
    user,
    ownerUserId: auth?.user?.id ?? null,
    ...(isPersonAuth(auth) && auth.user ? { person: true as const } : {}),
  };
}

export function runPluginRequest<T>(identity: PluginRequestIdentity, fn: () => T): T {
  return pluginRequestAls.run(identity, fn);
}

/**
 * Runs `fn` with no request identity: AsyncLocalStorage follows `setImmediate`
 * and promises, so work scheduled from inside a request would otherwise keep
 * that request's caller. Used for event handlers, which act as the plugin.
 */
export function outsidePluginRequest<T>(fn: () => T): T {
  return pluginRequestAls.exit(fn);
}

export function inPluginRequest(): boolean {
  return pluginRequestAls.getStore() !== undefined;
}

/** A job (no request) or an unattended callback: no human answers for this call. */
export function pluginCallUnattended(): boolean {
  const store = pluginRequestAls.getStore();
  return !store || store.unattended === true;
}

/** A signed-in person made the request this call serves. False in a job. */
export function pluginCallByPerson(): boolean {
  return pluginRequestAls.getStore()?.person === true;
}

export function currentPluginUser(): PluginUser | undefined {
  return pluginRequestAls.getStore()?.user;
}

/**
 * Viewer the facades pass to `scopedDb`. A missing store is a job: own
 * rows only (`plugin:<id>`), never `:all`. A store with `viewer: null` is
 * an anonymous first-run request — historical unscoped read.
 */
export function currentPluginViewer(pluginId: string): DbViewer | null {
  const store = pluginRequestAls.getStore();
  if (store) return store.viewer;
  return { id: `${PLUGIN_OWNER_PREFIX}${pluginId}`, isSuperadmin: false, permissions: [] };
}

/**
 * Owner stamped on writes. A job is `plugin:<id>`. A request without a
 * user account (daemon-token before setup) is `null`, matching HTTP spawn.
 */
export function currentPluginOwnerUserId(pluginId: string): string | null {
  const store = pluginRequestAls.getStore();
  if (store) return store.ownerUserId;
  return `${PLUGIN_OWNER_PREFIX}${pluginId}`;
}

/** M.2/M.4 evaluator: no viewer = unrestricted (first-run). */
export function pluginCallerAllows(
  viewer: DbViewer | null | undefined,
  permission: string,
): boolean {
  return viewerAllows(viewer, permission);
}
