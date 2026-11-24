// @ts-check
/**
 * The ACP agents Timon ships, as DATA (`docs/PROVIDERS-SDK.md` § 7.1, § 10.2): what used to be
 * a closed table in the core (`AGENTS` in `dialects/acp.ts`, `ADVICE` in `acp/auth.ts`) is a row
 * per agent here. The protocol — transport, session driver, event mapper, permissions through the
 * Allow/Deny card and the classifier, the model probe — is the daemon's, supplied through
 * `ctx.provider.runtime.acp`; an agent's quirk is a field of its row, never a branch.
 *
 * One provider per agent, and its id is the profile's: the folders an agent signs in to and the
 * program it runs are declared by that provider, so two agents on one dialect would share one
 * declaration of them. The profiles themselves (`opencode`, `hermes`, `antigravity`: models,
 * `requiredBinary`, `envFrom`) are in `profiles.js`. Pi left this table for its own plugin (`provider-pi`, driven
 * over Pi's RPC mode, no `pi-acp` adapter). Each agent's `binary` and `credentialDirs` are its
 * entry of the manifest's `timon.provider.backends` (`manifest.js`), the one place they are
 * written: the daemon reads it before this plugin runs (the doctor, the binary search, the mission
 * mask), and why its values are what they are is in `profiles.js`.
 *
 * @typedef {import('@timon-ai/sdk/provider').AcpAgentSpec} AcpAgentSpec
 */
import { randomBytes } from 'node:crypto';
import { manifestBackend } from './manifest.js';
import { oneShotOverlay } from './opencode-config.js';
import { createAntigravityUsage } from './antigravity-usage.js';

const OPENCODE = manifestBackend('opencode');
const HERMES = manifestBackend('hermes');
const ANTIGRAVITY = manifestBackend('antigravity');

/** Said after Hermes' sign-in command: `hermes-acp` is not a way to sign in. */
const HERMES_ACP_NOTE = 'do not start `hermes-acp` yourself: Timon starts it, and run by hand it opens nothing and only waits';

/**
 * The sign-in Timon runs Antigravity on: a personal Google account (`oauth-personal`, the Free, Pro
 * and Ultra plans). The other methods `agy` announces are billed by the token (`gemini-api-key`,
 * `agent-platform`) or tie it to an organisation's project (`oauth-business`), and Timon runs CLI
 * subscriptions only.
 */
/**
 * Where `agy` keeps its sign-in, on each OS, when Timon starts it. It saves it in the system keychain and,
 * when the keychain cannot be reached, in its own folder (`~/.gemini/antigravity-cli/antigravity-oauth-token`,
 * mode 0600, verified on 1.5.9). On Linux the keychain is the Secret Service, reached over the D-Bus session
 * bus, a Unix socket the mission fence refuses: a fenced `agy` then finds no sign-in. Pointing it at no bus
 * (`disabled:` is no transport D-Bus knows) makes every `agy` Timon starts on Linux, fenced or not, mission or
 * quota reading, use that file, which sits in the folder this provider declares (`credentialDirs`): writable by
 * an Antigravity mission, masked from the others. The sign-in command carries the same variable so that it
 * writes the file. macOS keeps the keychain, which its fence leaves reachable.
 *
 * @param {NodeJS.Platform} platform
 */
export function antigravityKeychainEnv(platform) {
  return platform === 'linux' ? { DBUS_SESSION_BUS_ADDRESS: 'disabled:' } : {};
}

/**
 * The command that signs `agy` in where Timon will look for it (`antigravityKeychainEnv`).
 *
 * @param {NodeJS.Platform} platform
 */
export function antigravitySignInCommand(platform) {
  const prefix = Object.entries(antigravityKeychainEnv(platform)).map(([name, value]) => `${name}=${value} `).join('');
  return `${prefix}agy acp --login`;
}

/** @param {NodeJS.Platform} platform */
export function antigravitySignIn(platform) {
  return `run \`${antigravitySignInCommand(platform)}\` in a terminal on this machine and sign in with your personal Google account, then retry`;
}

const ANTIGRAVITY_SIGN_IN = antigravitySignIn(process.platform);

/**
 * Emptied in the agent's environment, over the vault and the daemon's own (`secrets.inheritEnv`):
 * the two switches that move `agy` off the Google sign-in onto per-token billing. Verified on 1.5.9:
 * `AGY_ADC_AUTH=1` makes it sign in with Application Default Credentials (Agent Platform), and an
 * empty value keeps the Google sign-in; `GEMINI_API_KEY` is read once its own settings select the
 * API key, and an empty one falls back to the saved sign-in (its 1.5.9 release notes).
 */
const ANTIGRAVITY_BILLED_SWITCHES = Object.freeze({ AGY_ADC_AUTH: '', GEMINI_API_KEY: '' });

/** What every `agy` Timon starts gets: the billing switches emptied, the keychain this OS reaches. */
const ANTIGRAVITY_ENV = Object.freeze({ ...ANTIGRAVITY_BILLED_SWITCHES, ...antigravityKeychainEnv(process.platform) });

/**
 * What opencode may do in a daemon one-shot (summary, title, memory pass): it decides its tool uses
 * alone, so the one-shot's refusal of every permission request never reaches it. Everything is
 * denied, then the read-only trio re-allowed: a list of denials let through every tool it did not
 * name, the MCP servers of the project's `opencode.json` first (verified on 1.18.33 with a real
 * session: `<server>_<tool>` was offered to the model). opencode keeps the LAST rule that matches,
 * so `*` comes first. `read` keeps opencode's own `.env` guard, made a refusal; `invalid` is where
 * opencode routes a malformed call, it runs nothing.
 */
const OPENCODE_ONE_SHOT_PERMISSION = Object.freeze({
  '*': 'deny',
  invalid: 'allow',
  read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' },
  glob: 'allow',
  grep: 'allow',
});

/**
 * Our agent's name is drawn at load. `OPENCODE_CONFIG_CONTENT` is merged over the user's own
 * opencode files (the project's were read too until TODO #587), and an agent's `permission` in
 * such a file wins over the top level (verified on 1.18.33, `opencode debug agent build`): hence an
 * agent of our own, made the default one, the ACP session starting in the default agent's mode.
 * Under a fixed name, a project file declaring the same agent kept its keys ahead of ours in the
 * merge, and a `"*": "allow"` there reopened `bash` (verified with a real session). A file cannot
 * name an agent it cannot predict.
 */
const OPENCODE_ONE_SHOT_AGENT = `timon-one-shot-${randomBytes(6).toString('hex')}`;

/**
 * Built at each one-shot launch: the project's files are not read (`OPENCODE_DISABLE_PROJECT_CONFIG`),
 * so what they said about the model is put back here, with the user's global MCP servers switched off
 * (`opencode-config.js`). The confinement comes last: nothing carried can name its keys.
 * @param {string} cwd
 */
function opencodeOneShotConfig(cwd) {
  return JSON.stringify({
    ...oneShotOverlay(cwd),
    permission: OPENCODE_ONE_SHOT_PERMISSION,
    default_agent: OPENCODE_ONE_SHOT_AGENT,
    agent: {
      [OPENCODE_ONE_SHOT_AGENT]: {
        mode: 'primary',
        description: 'Timon one-shot prompt: answers from the prompt alone, runs nothing.',
        permission: OPENCODE_ONE_SHOT_PERMISSION,
      },
    },
  });
}

/**
 * The method `agy` announces for a personal Google account: it only names the sign-in sentence.
 *
 * Never sent as `authenticate`. `agy` loads a saved sign-in by itself at start (its log:
 * `ChainedAuth: authenticated via keyring`), so `session/new` succeeds without it; `authenticate
 * oauth-personal` is reached only when nothing is saved, and then it opens the Google sign-in page in the
 * person's browser and listens on a local port for the redirect (`Opening browser for ACP sign-in`,
 * verified on 1.5.9). A process Timon starts is stopped long before anyone finishes that page: the
 * redirect then lands on a closed port, and the quota gauge, retrying, opened a new page every minute.
 * Signing in stays the person's gesture, from a terminal (`antigravitySignInCommand`).
 */
const ANTIGRAVITY_AUTH_METHOD = 'oauth-personal';

/**
 * The weekly quota of each of the account's model groups, asked of `agy` itself
 * (`antigravity-usage.js`). `AcpAgentSpec` carries no usage hook, so the plugin adds this strategy to
 * the definition the runtime built for the row (`index.js`): the definition is the SDK's contract, the
 * row is only a shorthand for most of it.
 *
 * @param {Pick<import('@timon-ai/sdk/provider').ProviderServices, 'binary' | 'runtime'>} services
 * @returns {import('@timon-ai/sdk/provider').UsageStrategy}
 */
export function antigravityUsage(services) {
  const { getUsage } = createAntigravityUsage({
    services,
    names: ANTIGRAVITY.binary?.names ?? [],
    env: ANTIGRAVITY_ENV,
    signIn: ANTIGRAVITY_SIGN_IN,
  });
  return {
    // `options.force`: a person's ↻, already spaced by the daemon's floor.
    probe: (profile, options) => getUsage(profile, { force: options?.force === true }),
  };
}

/** @type {readonly AcpAgentSpec[]} */
export const ACP_AGENTS = Object.freeze([
  {
    // opencode 1.18.33 verified against the real agent.
    id: 'opencode',
    // A whole CLI whose `acp` subcommand speaks the protocol.
    args: ['acp'],
    // It refuses a write outside its working directory without asking: the agent arbitrates its own tool uses.
    permissionsByAgent: true,
    // A one-shot reads no file of the project: its MCP servers were started, its `.opencode/` plugins run (TODO #587).
    oneShotEnv: { OPENCODE_DISABLE_PROJECT_CONFIG: '1' },
    env: (spawn) => (spawn.oneShot ? { OPENCODE_CONFIG_CONTENT: opencodeOneShotConfig(spawn.cfg.cwd ?? process.cwd()) } : {}),
    modelProbe: 'session-new',
    signIn: {
      byMethod: { 'opencode-login': 'run `opencode auth login` in a terminal on this machine, then retry' },
      fallback: 'run `opencode auth login` in a terminal on this machine, then retry',
    },
    binary: OPENCODE.binary,
    declares: { credentialDirs: OPENCODE.credentialDirs },
  },
  {
    // hermes-agent 0.21.0 verified against the real agent.
    id: 'hermes',
    // `hermes-acp` speaks the protocol as launched.
    args: [],
    permissionsByAgent: false,
    modelProbe: 'session-new',
    // `hermes-acp` is the stdio server Timon starts: run by hand it opens nothing and waits, which a
    // tester took for a sign-in stuck on a browser (TIM-0153). The sentence names the command that does sign in.
    signIn: {
      byMethod: {
        nous: `sign in to Nous with \`hermes portal\` in a terminal on this machine, then retry the mission (${HERMES_ACP_NOTE})`,
        'hermes-setup': `run \`hermes setup\` in a terminal on this machine, then retry the mission (${HERMES_ACP_NOTE})`,
      },
      fallback: `run \`hermes setup\` in a terminal on this machine, then retry the mission (${HERMES_ACP_NOTE})`,
    },
    binary: HERMES.binary,
    declares: { credentialDirs: HERMES.credentialDirs },
  },
  {
    // Google Antigravity CLI (`agy`) 1.5.9 verified against the real agent: a stdio MCP server handed in
    // `session/new` is started and its tool called; a session is found again by `session/resume` and by
    // `session/load` after the process died.
    id: 'antigravity',
    // A whole CLI whose `acp` subcommand speaks the protocol. No `--dangerously-skip-permissions`: the
    // session stays in agy's `default` mode, which asks before every edit, command and MCP tool, so each
    // one reaches Timon's card and classifier (agy's own permission rules still decide what it never asks
    // about). `AcpAgentSpec` has no hook to pick another of agy's session modes from `permission_mode`.
    args: ['acp'],
    permissionsByAgent: false,
    env: () => ({ ...ANTIGRAVITY_ENV }),
    modelProbe: 'session-new',
    // No `authenticateWith` (`ANTIGRAVITY_AUTH_METHOD`): it would open a browser page nobody can finish.
    signIn: {
      byMethod: { [ANTIGRAVITY_AUTH_METHOD]: ANTIGRAVITY_SIGN_IN },
      fallback: ANTIGRAVITY_SIGN_IN,
    },
    binary: ANTIGRAVITY.binary,
    declares: { credentialDirs: ANTIGRAVITY.credentialDirs },
  },
]);
