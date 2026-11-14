/**
 * The variables that point the package managers an MCP server is commonly
 * launched with (`npx -y`, `pnpm dlx`, `uvx`) at one cache folder. A fenced
 * mission gets them with its agent's cache (`agentPackageCacheDir`): the
 * user's own caches sit in the home, which the fence keeps read-only, and npm
 * fails at once there (measured: `EACCES` on `~/.npm/_cacache/tmp`, even with
 * the package already cached). A leaf, so that the MCP serializers can name
 * the variables a CLI must hand on to its servers.
 */
import { join } from 'node:path';

export function packageCacheEnv(dir: string): Record<string, string> {
  return {
    // npm and npx (`_cacache`, and `_npx` where npx installs what it runs).
    npm_config_cache: join(dir, 'npm'),
    // pnpm reads its settings from `npm_config_*` too: `dlx` needs both folders.
    npm_config_cache_dir: join(dir, 'pnpm', 'cache'),
    npm_config_store_dir: join(dir, 'pnpm', 'store'),
    // uv and uvx: downloads and the throwaway environments of `uvx`.
    UV_CACHE_DIR: join(dir, 'uv'),
  };
}

/** The names `packageCacheEnv` sets, for a CLI whose MCP servers inherit nothing it is not told to pass. */
export const PACKAGE_CACHE_ENV_NAMES: readonly string[] = Object.freeze(Object.keys(packageCacheEnv('')));
