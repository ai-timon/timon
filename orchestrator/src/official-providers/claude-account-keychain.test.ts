/**
 * macOS: a launch on a Claude subscription account moves the account's sign-in out of the
 * login keychain into the account's own folder, before the CLI starts. Inside the mission's
 * fence the CLI can read the keychain but neither update nor delete it, so a refreshed token
 * written to the folder would stay shadowed by the stale entry the CLI reads first.
 *
 * darwin is injected: the keychain is the SDK testing kit's stand-in, nothing touches the OS.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderContext } from '../../../packages/sdk/src/testing/index.js';
import { createClaudeProvider } from '../../official-providers/provider-claude/lib/claude.js';
import { createClaudeToken } from '../../official-providers/provider-claude/lib/token.js';
import { createClaudeUsage } from '../../official-providers/provider-claude/lib/usage.js';
import { claudeAccountKeychainService } from '../../official-providers/provider-claude/lib/account-keychain.js';

const { timon: { apiVersion } } = JSON.parse(readFileSync(new URL('../../official-providers/provider-claude/package.json', import.meta.url), 'utf8')) as { timon: { apiVersion: number } };

const ACCESS = 'sk-ant-oat01-keychain-access-token-for-the-test';
const REFRESH = 'sk-ant-ort01-keychain-refresh-token-for-the-test';
const FRESH_ACCESS = 'sk-ant-oat01-file-access-token-renewed-in-a-mission';
const FRESH_REFRESH = 'sk-ant-ort01-file-refresh-token-renewed-in-a-mission';
const SECRETS = [ACCESS, REFRESH, FRESH_ACCESS, FRESH_REFRESH];
const HOUR = 3_600_000;

const roots: string[] = [];
process.on('exit', () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function pair(accessToken: string, refreshToken: string, expiresAt: number) {
  return { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } };
}

type Setup = {
  platform?: NodeJS.Platform; keychain?: string; file?: unknown; locked?: boolean; signingIn?: boolean;
  /** Launches (mission ids) outside the fence, and accounts another process runs on outside it. */
  unfencedMissions?: string[]; accountsInUse?: string[];
  /** Runs after each read of the entry by the provider: another CLI writing the keychain then. */
  afterRead?: (count: number, write: (value: string) => void, setInUse: (inUse: boolean) => void) => void;
  /** Runs before each delete and is awaited: a test holds the move there. */
  beforeRemove?: () => Promise<void>;
};

/** One account on macOS (or `platform`), and a provider that launches on it. */
async function accountHarness(setup: Setup) {
  const root = mkdtempSync(join(tmpdir(), 'timon-claude-account-'));
  roots.push(root);
  const configDir = join(root, 'backend-accounts', 'acc-1');
  (await import('node:fs')).mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (setup.file !== undefined) writeFileSync(join(configDir, '.credentials.json'), JSON.stringify(setup.file), { mode: 0o600 });
  const service = claudeAccountKeychainService(configDir);
  const ctx = createProviderContext({
    apiVersion, secrets: SECRETS,
    osCredentials: setup.keychain === undefined ? {} : { [service]: setup.keychain },
    ...(setup.locked ? { lockedOsCredentials: [service] } : {}),
    ...(setup.signingIn ? { signingInAccounts: ['acc-1'] } : {}),
    ...(setup.unfencedMissions ? { unfencedMissions: setup.unfencedMissions } : {}),
    ...(setup.accountsInUse ? { accountsInUse: setup.accountsInUse } : {}),
  });
  process.on('exit', () => ctx.cleanup());
  let reads = 0;
  const removals: string[] = [];
  const own = ctx.provider.account.osCredential.bind(ctx.provider.account);
  ctx.provider.account.osCredential = (profile, name, missionId) => {
    const entry = own(profile, name, missionId);
    if (!entry) return entry;
    return {
      held: () => entry.held(),
      async read() {
        const value = await entry.read();
        reads += 1;
        setup.afterRead?.(reads, (next) => ctx.setOsCredential(service, next), (inUse) => ctx.setAccountInUse('acc-1', inUse));
        return value;
      },
      async remove(expected) {
        await setup.beforeRemove?.();
        const outcome = await entry.remove(expected);
        removals.push(outcome);
        return outcome;
      },
    };
  };
  const warnings: string[] = [];
  const log = { info: () => {}, warn: (...args: unknown[]) => { warnings.push(args.join(' ')); }, error: () => {} };
  const token = createClaudeToken(ctx.provider);
  ctx.provider.registerProvider(createClaudeProvider(ctx.provider, token, createClaudeUsage(ctx.provider, token), { platform: setup.platform ?? 'darwin', log }));
  const dialect = ctx.registered.dialect('claude');
  const profile = { id: 'claude@acc-1', cmd: 'claude', env: {}, account: { id: 'acc-1', name: 'Work', configDir } };
  const file = join(configDir, '.credentials.json');
  return {
    configDir, warnings, logs: ctx.logs, removals,
    launch: (missionId: string) => dialect.buildSpawn({
      agentName: 'claude.account', systemPrompt: 'contract', message: 'ping', resumeSession: null, missionId,
      cfg: { cwd: root, permission_mode: 'auto', mcp_servers: [] },
    } as never, profile as never),
    keychainLeft: () => own(profile as never, service, 'reader')!.read(),
    file: () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : null,
    mode: () => existsSync(file) ? statSync(file).mode & 0o777 : null,
  };
}

async function launchOnAccount(setup: Setup, missionId = `mission-account-${roots.length + 1}`) {
  const harness = await accountHarness(setup);
  const spec = await harness.launch(missionId);
  return {
    spec, configDir: harness.configDir, warnings: harness.warnings, logs: harness.logs, removals: harness.removals,
    keychainLeft: await harness.keychainLeft(), file: harness.file(), mode: harness.mode(),
  };
}

/** No secret on the command line, in the environment, in a warning or a log line. */
function assertNoSecretOut(result: Awaited<ReturnType<typeof launchOnAccount>>): void {
  const out = JSON.stringify([result.spec.cmd, result.spec.args, result.spec.env, result.warnings, result.logs]);
  for (const secret of SECRETS) assert.ok(!out.includes(secret), 'a token leaked into the launch, a warning or a log');
}

test('the CLI names an account\'s keychain entry after its folder: first 8 hex of sha256, NFC', () => {
  // Measured on macOS: `printf %s /private/tmp/kc-cli.Gxaa/acct | shasum -a 256`.
  assert.equal(claudeAccountKeychainService('/private/tmp/kc-cli.Gxaa/acct'), 'Claude Code-credentials-74619e8d');
  assert.equal(claudeAccountKeychainService('/Users/me/A\u030angstrom'), claudeAccountKeychainService('/Users/me/\u00c5ngstrom'));
});

test('darwin: the entry moves into the account\'s folder and leaves the keychain, before the CLI starts', async () => {
  const stored = { ...pair(ACCESS, REFRESH, Date.now() + 4 * HOUR), mcpOAuth: { server: { accessToken: 'mcp' } } };
  const result = await launchOnAccount({ keychain: JSON.stringify(stored) });
  assert.deepEqual(result.file, stored);
  if (process.platform !== 'win32') assert.equal(result.mode, 0o600);
  assert.equal(result.keychainLeft, null, 'no entry is left to shadow the file');
  // The CLI reads that folder, and its keychain name is pinned to it.
  assert.equal(result.spec.env?.CLAUDE_CONFIG_DIR, result.configDir);
  assert.equal(result.spec.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR, result.configDir);
  assert.equal(result.spec.env?.CLAUDE_CODE_OAUTH_TOKEN, '');
  assert.deepEqual(result.warnings, []);
  assertNoSecretOut(result);
});

test('darwin: a fresher pair a fenced refresh already wrote to the folder wins over the stale entry', async () => {
  const fresh = pair(FRESH_ACCESS, FRESH_REFRESH, Date.now() + 8 * HOUR);
  const result = await launchOnAccount({ keychain: JSON.stringify(pair(ACCESS, REFRESH, Date.now() - HOUR)), file: fresh });
  assert.deepEqual(result.file?.claudeAiOauth, fresh.claudeAiOauth);
  assert.equal(result.keychainLeft, null);
  assertNoSecretOut(result);
});

test('darwin: a fresher entry replaces the folder\'s pair and keeps what else the file holds; hex is read', async () => {
  const stored = pair(ACCESS, REFRESH, Date.now() + 4 * HOUR);
  const result = await launchOnAccount({
    keychain: Buffer.from(JSON.stringify(stored), 'utf8').toString('hex'),
    file: { ...pair(FRESH_ACCESS, FRESH_REFRESH, Date.now() - HOUR), mcpOAuth: { kept: true } },
  });
  assert.deepEqual(result.file?.claudeAiOauth, stored.claudeAiOauth);
  assert.deepEqual(result.file?.mcpOAuth, { kept: true });
  assert.equal(result.keychainLeft, null);
  assertNoSecretOut(result);
});

test('darwin: a keychain that refuses the delete keeps its entry, and the warning names no secret', async () => {
  const result = await launchOnAccount({ keychain: JSON.stringify(pair(ACCESS, REFRESH, Date.now() + HOUR)), locked: true });
  assert.ok(result.keychainLeft, 'the entry is still there');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /account acc-1 stays in the macOS keychain \(kept\)/);
  assertNoSecretOut(result);
});

test('darwin: an entry that is not the CLI\'s JSON is left alone, and nothing is written', async () => {
  const result = await launchOnAccount({ keychain: 'not json' });
  assert.equal(result.keychainLeft, 'not json');
  assert.equal(result.file, null);
  assert.match(result.warnings[0] ?? '', /\(unreadable\)/);
});

test('darwin: a pair a sign-in writes between the read and the delete is never lost', async () => {
  const fresh = pair(FRESH_ACCESS, FRESH_REFRESH, Date.now() + 8 * HOUR);
  const result = await launchOnAccount({
    keychain: JSON.stringify(pair(ACCESS, REFRESH, Date.now() + HOUR)),
    // The CLI replaces the entry right after the provider read the old one, before its delete.
    afterRead: (count, write) => { if (count === 1) write(JSON.stringify(fresh)); },
  });
  assert.deepEqual(result.removals, ['changed', 'removed'], 'the replaced entry was kept, then the fresh one moved');
  assert.deepEqual(result.file?.claudeAiOauth, fresh.claudeAiOauth, 'the fresh pair is in the folder');
  assert.equal(result.keychainLeft, null);
  assert.deepEqual(result.warnings, []);
  assertNoSecretOut(result);
});

test('darwin: an entry that changes on every pass stays in the keychain, the freshest pair with it', async () => {
  const stamps = [FRESH_ACCESS, `${FRESH_ACCESS}-2`, `${FRESH_ACCESS}-3`];
  const result = await launchOnAccount({
    keychain: JSON.stringify(pair(ACCESS, REFRESH, Date.now() + HOUR)),
    afterRead: (count, write) => write(JSON.stringify(pair(stamps[count - 1]!, FRESH_REFRESH, Date.now() + (count + 1) * HOUR))),
  });
  assert.deepEqual(result.removals, ['changed', 'changed', 'changed']);
  assert.equal(JSON.parse(result.keychainLeft!).claudeAiOauth.accessToken, stamps[2], 'the last pair written is still there');
  assert.match(result.warnings[0] ?? '', /\(changed\)/);
  assertNoSecretOut(result);
});

test('darwin: nothing moves while a sign-in flow runs on the account', async () => {
  const keychain = JSON.stringify(pair(ACCESS, REFRESH, Date.now() + HOUR));
  const result = await launchOnAccount({ keychain, signingIn: true });
  assert.equal(result.keychainLeft, keychain);
  assert.equal(result.file, null, 'the folder is not touched either');
  assert.deepEqual(result.removals, []);
  assert.match(result.warnings[0] ?? '', /\(signing-in\)/);
  assertNoSecretOut(result);
});

test('darwin: a mission running on the account outside the fence keeps the entry where it is: never deleted', async () => {
  const keychain = JSON.stringify(pair(ACCESS, REFRESH, Date.now() + HOUR));
  const result = await launchOnAccount({ keychain, accountsInUse: ['acc-1'] });
  assert.deepEqual(result.removals, [], '`remove` is never called');
  assert.equal(result.keychainLeft, keychain, 'the pair stays in the keychain');
  assert.equal(result.file, null, 'the folder is not touched either');
  assert.equal(result.spec.env?.CLAUDE_CONFIG_DIR, result.configDir, 'the launch goes on');
  assert.match(result.warnings[0] ?? '', /\(in-use\)/);
  assertNoSecretOut(result);
});

test('darwin: a launch outside the fence moves nothing, and says nothing: its CLI updates the keychain itself', async () => {
  const keychain = JSON.stringify(pair(ACCESS, REFRESH, Date.now() + HOUR));
  const result = await launchOnAccount({ keychain, unfencedMissions: ['mission-outside'] }, 'mission-outside');
  assert.deepEqual(result.removals, []);
  assert.equal(result.keychainLeft, keychain);
  assert.equal(result.file, null);
  assert.deepEqual(result.warnings, []);
  assertNoSecretOut(result);
});

test('darwin: a process that starts outside the fence during a move makes the delete renounce', async () => {
  const keychain = JSON.stringify(pair(ACCESS, REFRESH, Date.now() + HOUR));
  const result = await launchOnAccount({ keychain, afterRead: (_count, _write, setInUse) => setInUse(true) });
  assert.deepEqual(result.removals, ['in-use'], 'the delete saw it and kept the entry');
  assert.equal(result.keychainLeft, keychain);
  assert.match(result.warnings[0] ?? '', /\(in-use\)/);
  assertNoSecretOut(result);
});

test('darwin: a launch outside the fence that starts during a move waits for it; no delete runs beside it', async () => {
  const keychain = JSON.stringify(pair(ACCESS, REFRESH, Date.now() + HOUR));
  let holdDelete!: () => void;
  const held = new Promise<void>((resolve) => { holdDelete = resolve; });
  let entered!: () => void;
  const atDelete = new Promise<void>((resolve) => { entered = resolve; });
  const harness = await accountHarness({
    keychain, unfencedMissions: ['mission-outside'],
    beforeRemove: () => { entered(); return held; },
  });
  const fenced = harness.launch('mission-fenced');
  await atDelete;
  // The move is in its delete: a launch outside the fence on the same account starts now.
  let outsideDone = false;
  const outside = harness.launch('mission-outside').then((spec) => { outsideDone = true; return spec; });
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outsideDone, false, 'it waits for the move in progress');
  assert.deepEqual(harness.removals, [], 'the delete is still held');
  holdDelete();
  await fenced;
  const spec = await outside;
  assert.deepEqual(harness.removals, ['removed'], 'one delete only, the fenced launch\'s, finished before the other launch went on');
  assert.equal(await harness.keychainLeft(), null);
  assert.equal(spec.env?.CLAUDE_CONFIG_DIR, harness.configDir);
  assert.deepEqual(harness.warnings, []);
});

test('darwin: an account with no entry launches as before, with nothing written', async () => {
  const result = await launchOnAccount({});
  assert.equal(result.file, null);
  assert.deepEqual(result.warnings, []);
});

test('Linux and Windows: the account\'s folder already holds its sign-in, the keychain is never asked', async () => {
  for (const platform of ['linux', 'win32'] as const) {
    const keychain = JSON.stringify(pair(ACCESS, REFRESH, Date.now() + HOUR));
    const result = await launchOnAccount({ platform, keychain });
    assert.equal(result.file, null, platform);
    assert.equal(result.keychainLeft, keychain, platform);
    assertNoSecretOut(result);
  }
});
