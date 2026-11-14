// @ts-check
/**
 * What this plugin's own manifest says about a backend it brings (`timon.provider.backends`,
 * SDK-COMPAT § 51), in the shape the definition declares it to the core: the program (C1) and the
 * sign-in folders (C2). The daemon reads the manifest before any plugin runs (doctor, binary
 * search, mission mask, onboarding) and the definition reads the same file, so the two cannot
 * drift apart. The same file sits in every official provider: a plugin imports nothing outside
 * its own package (`official-providers/imports.test.ts`).
 *
 * @typedef {import('@timon-ai/sdk/provider').ProviderBinaryDeclaration} ProviderBinaryDeclaration
 * @typedef {{ readonly binary?: ProviderBinaryDeclaration; readonly credentialDirs: readonly string[] }} ManifestBackend
 */
import { readFileSync } from 'node:fs';

/**
 * The product's own narrowing, read from a release-vouched manifest only: what the provider cards
 * may run, which folders count as a desktop build. A plugin's declaration of them is never read,
 * so it does not carry them.
 */
const PRODUCT_ONLY = new Set(['standaloneInstaller', 'folderPattern']);

/** @type {{ timon?: { provider?: { backends?: Array<{ id?: unknown }> } } }} */
const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * The declaration of the backend `id` this manifest lists. Throws when it lists none: a plugin
 * that declares a backend its manifest does not name would run with nothing the operator saw.
 *
 * @param {string} id
 * @returns {ManifestBackend}
 */
export function manifestBackend(id) {
  const entry = MANIFEST.timon?.provider?.backends?.find((backend) => backend.id === id);
  if (!entry) throw new Error(`the manifest lists no backend \`${id}\` in \`timon.provider.backends\``);
  /** @type {{ binary?: ProviderBinaryDeclaration; credentialDirs?: string[] }} */
  const { binary, credentialDirs = [] } = JSON.parse(JSON.stringify(entry, (key, value) => (PRODUCT_ONLY.has(key) ? undefined : value)));
  return deepFreeze(binary ? { binary, credentialDirs } : { credentialDirs });
}
