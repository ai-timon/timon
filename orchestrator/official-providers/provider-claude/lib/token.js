/** Long-lived subscription token. The daemon seals storage; this plugin owns validation and launch policy. */
export const CLAUDE_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
export const CLAUDE_TOKEN_STORE = '@timon/claude-oauth';
export const CLAUDE_TOKEN_KEY = '@settings/claude-oauth-token';
export class ClaudeTokenError extends Error {
  constructor(code, message) { super(message); this.name = 'ClaudeTokenError'; this.code = code; }
}
export function normalizeClaudeToken(raw) {
  if (typeof raw !== 'string') throw new ClaudeTokenError('invalid', 'The token must be a string.');
  const value = raw.trim();
  if (value.length < 20 || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value))
    throw new ClaudeTokenError('invalid', 'This does not look like a token printed by `claude setup-token`.');
  return value;
}
export function runsOutsideGuiSession(env = process.env) { return env.TIMON_SERVICE_KIND === 'launchd-system'; }
export const MISSING_TOKEN_MESSAGE = 'Timon runs as a macOS background service, which cannot read the login keychain where `claude` keeps its sign-in. '
  + 'Run `claude setup-token`, then `timon auth claude-token set` (or Settings › AI models › Providers › Claude), '
  + 'or run `timon service install` to go back to a service that only runs while you are logged in.';
/**
 * An account's CLI: its own folder, none of the host's credentials. The keychain entry is pinned
 * to the same folder: an inherited `CLAUDE_SECURESTORAGE_CONFIG_DIR` would otherwise name another
 * entry (empty, the host's own sign-in) while the daemon moves this one (`account-keychain.js`).
 */
export function claudeAccountEnv(configDir) {
  return {
    CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir,
    [CLAUDE_TOKEN_ENV]: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
  };
}
export function createClaudeToken(services) {
  const store = services.credentialStore({ store: CLAUDE_TOKEN_STORE, key: CLAUDE_TOKEN_KEY, marker: 'claude-token-configured' });
  const readClaudeToken = () => store.read();
  function setClaudeToken(raw) {
    const value = normalizeClaudeToken(raw);
    try { store.write(value); }
    catch { throw new ClaudeTokenError('unavailable', 'The secrets vault is unavailable; the token was not saved.'); }
  }
  function claudeSpawnEnv(profileEnv, token = readClaudeToken, outsideSession = runsOutsideGuiSession()) {
    if (Object.keys(profileEnv).length) return { ...profileEnv };
    const value = token();
    if (value) return { [CLAUDE_TOKEN_ENV]: value };
    if (outsideSession) throw new Error(MISSING_TOKEN_MESSAGE);
    return undefined;
  }
  return { readClaudeToken, setClaudeToken, claudeSpawnEnv,
    clearClaudeToken: () => store.clear(), claudeTokenStatus: () => store.status(),
    syncClaudeTokenMarker: () => store.syncMarker(), parseBody: (body) => store.parseBody(body) };
}
