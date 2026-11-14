// @ts-check
/**
 * The profiles of the ACP agents this plugin ships (`opencode`, `hermes`, `antigravity`): models,
 * `requiredBinary`, `envFrom`. The first two moved verbatim from the product's former table
 * (`orchestrator/src/backends/profiles.ts`); the ids are unchanged, they are foreign keys of every
 * installation (missions, roles, series fallbacks, cooldowns).
 *
 * `timon.provider.backends` of the manifest:
 *  - opencode: `curl -fsSL https://opencode.ai/install | bash` (opencode.ai/docs). Its Windows
 *    options are package managers (choco, scoop, npm), and no script: Windows gets the link to the
 *    page. Product decision (29/10/2026): Timon stays on opencode 1 — installer and `updateCheck`
 *    on `opencode-ai`. opencode 2 (`https://opencode.ai/v2/install`, `@opencode/cli`) is not
 *    declared stable and its documentation does not mention `opencode acp`, which this dialect
 *    runs; the two share one binary, so `updateCheck.supportedMajor: 1`: a card that finds a 2.x
 *    offers neither install nor update, which would replace it, and the install route refuses.
 *    `searchDirs`: `~/.opencode/bin` for that script (Git Bash included); on Windows the shims of
 *    `scoop install opencode` and `choco install opencode`, each under its default root unless the
 *    package manager was told another one. `credentialDirs`: its configuration and, apart, where
 *    it keeps the sign-in (`auth.json`).
 *  - hermes: its script installs `hermes-acp`, but the ACP extra is a second step its page
 *    describes (`pm.sync_venv(['acp'])`): run alone, the script would leave a CLI that fails its
 *    first mission, so the card links to the page (`installDocs`). Hermes is a Python agent with
 *    its own installer: there is no package of that name to invent a command for (`install:
 *    none`). On Linux and macOS its installer writes its wrappers in `~/.local/bin`, which every
 *    binary already gets; on Windows `searchDirs` lists `%LOCALAPPDATA%\hermes\bin` and the
 *    `hermes\hermes-agent\bin` layout some installs end up with instead of the documented one.
 *  - antigravity: the vendor's own installers (antigravity.google/docs/getting-started, CLI tab):
 *    `install.sh` writes `~/.local/bin/agy` on Linux and macOS, which every binary already gets;
 *    `install.ps1` writes `%LOCALAPPDATA%\agy\bin\agy.exe` and does not touch the PATH, hence
 *    `searchDirs`. No `updateCheck`: `agy` updates itself. `credentialDirs` is `agy`'s own folder,
 *    not the whole `.gemini`: `~/.gemini/antigravity-acp` holds the sign-in of the ACP registry's
 *    Antigravity agent, and masking it from that backend's missions would sign it out. The sign-in
 *    itself lives in the system keychain (verified on Linux with an empty home folder).
 */
import { manifestBackend } from './manifest.js';

/** @type {import('@timon-ai/sdk/provider').BackendProfile} */
export const OPENCODE_PROFILE = {
  // opencode (`opencode acp`) over the Agent Client Protocol. It holds its own
  // login and its own provider keys (`opencode auth login`); Timon stores
  // none. Its free tier (Muse Spark 1.3) needs no account at all.
  //
  // `requiredBinary`, like grok and copilot: without the CLI the profile does
  // not exist. The command line (`acp`) is a row of the `provider-acp` plugin.
  id: 'opencode',
  dialect: 'opencode',
  label: 'opencode',
  vendor: 'OpenCode',
  brand: 'opencode',
  requiredBinary: manifestBackend('opencode').binary?.names[0],
  // Where opencode reads its configuration. Paths, not credentials: a mission's
  // environment is a whitelist (SECRETS-VAULT.md §6.1), and without these a
  // daemon started with either would spawn missions that read another config.
  // Its provider keys stay in opencode's own store, never in this environment.
  envFrom: { OPENCODE_CONFIG: 'OPENCODE_CONFIG', OPENCODE_CONFIG_DIR: 'OPENCODE_CONFIG_DIR' },
  subscription: {
    note: 'Calls go through the providers opencode itself is signed in to '
      + '(`opencode auth login` on the host), or its free tier, which needs no '
      + 'account. opencode decides its own tool permissions.',
  },
  defaultModel: 'opencode/muse-spark-1.3-contributor-free',
  // FALLBACK only: the live list comes from the agent (`Dialect.discoverModels`),
  // because it depends on the providers the user signed in to. Only what is
  // free and needs no account is written here.
  models: [
    {
      slug: 'opencode/muse-spark-1.3-contributor-free',
      label: 'Muse Spark 1.3 (free, default)',
      presetLabel: 'Muse Spark 1.3',
      presetRank: 130,
    },
  ],
};

/** @type {import('@timon-ai/sdk/provider').BackendProfile} */
export const HERMES_PROFILE = {
  // Hermes agent (`hermes-acp`) over the Agent Client Protocol. It holds its
  // own login (`hermes --setup`, or Nous); Timon stores none.
  id: 'hermes',
  dialect: 'hermes',
  label: 'Hermes (Nous Research)',
  vendor: 'Nous Research',
  brand: 'nous',
  cmd: 'hermes-acp',
  requiredBinary: manifestBackend('hermes').binary?.names[0],
  // Where Hermes keeps its configuration and sessions — a path, not a credential.
  envFrom: { HERMES_HOME: 'HERMES_HOME' },
  subscription: {
    note: 'Calls go through the account Hermes itself is signed in to '
      + '(`hermes --setup` on the host, or Nous). Hermes asks Timon before '
      + 'it uses a tool: the request appears as an Allow / Deny card.',
  },
  // No model is named: the list depends on the account (83 entries on the
  // tested install) and comes from the agent (`Dialect.discoverModels`). An
  // empty field means "the agent's own default".
  defaultModel: null,
  models: [],
};

/** @type {import('@timon-ai/sdk/provider').BackendProfile} */
export const ANTIGRAVITY_PROFILE = {
  // Google Antigravity CLI (`agy acp`) over the Agent Client Protocol. It holds
  // its own sign-in (`agy acp --login`, kept in the system keychain); Timon
  // stores none, and passes none of its variables: `envFrom` is empty on
  // purpose, the ones that would move it to per-token billing are emptied by
  // the agent's row (`agents.js`).
  id: 'antigravity',
  dialect: 'antigravity',
  label: 'Antigravity (Google)',
  vendor: 'Google',
  brand: 'gemini',
  requiredBinary: manifestBackend('antigravity').binary?.names[0],
  subscription: {
    note: 'Calls go through the personal Google account `agy` is signed in to '
      + '(`agy acp --login` on the host; Free, Google AI Pro or Ultra plan). '
      + 'Antigravity asks Timon before an edit, a command or an MCP tool: the '
      + 'request appears as an Allow / Deny card. Its own permission rules '
      + 'decide what it never asks about, and Timon\'s permission mode does not '
      + 'switch its modes.',
  },
  // No model is named: the list depends on the plan (six on the tested
  // account, Gemini, Claude and GPT-OSS) and comes from the agent
  // (`Dialect.discoverModels`). An empty field means "the agent's own default".
  defaultModel: null,
  models: [],
};
