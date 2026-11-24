/**
 * `timon backend …` end to end: the real CLI against a witness daemon with the
 * real auth middleware and the real `/api/backends/custom` routes, so "same body
 * as the form" and "the refusal reads well" are proved rather than mocked. The
 * key is the point: never an argument, never on a screen, whatever the route does.
 * Witnesses on 127.0.0.1:0, never the daemon of this machine.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const HOME = mkdtempSync(join(tmpdir(), 'timon-backend-cli-'));
process.env.TIMON_HOME = HOME;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { paidTestLicense } = await import('../tests/helpers/paid-license.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes } = await import('./plugins-bundled/users/routes.js');
const { registerCustomBackendRoutes } = await import('./plugins-bundled/backends/custom-routes.js');
const { dbApi } = await import('./db.js');
const { createSecret, deleteSecret, readSecretValue } = await import('./secrets/store.js');
const { issueMissionApiToken } = await import('./users/api-tokens.js');
const { setLicenseState } = await import('./license/runtime.js');
const localProfiles = await import('./backends/local-profiles.js');
const { backendProfilesReport, cmdBackend, formatBackendProfiles } = await import('../bin/cli-backend.mjs');
const { PROMPT_CANCELLED } = await import('../bin/cli-prompt.mjs');
{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));
const TOKEN = 'witness-daemon-token-backend-cli';
const KEY = 'sk-backend-cli-witness-71c3';
/** Anything that shows this pattern shows a key. */
const LEAK = /sk-backend-cli-witness/;

type Recorded = { method: string; url: string; body: unknown; headers: string };
const recorded: Recorded[] = [];

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/backends/')) recorded.push({ method: req.method, url: req.originalUrl, body: req.body, headers: JSON.stringify(req.headers) });
  next();
});
registerRoutes(app, { setupPolicy: 'free' });
registerCustomBackendRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const provider = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401).end('bad key'); return; }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'witness-1' }] }));
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;

test.after(() => { server.close(); provider.close(); });

const setup = await fetch(`${base}/api/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@example.com', name: 'Admin', password: 'admin-secret' }),
});
assert.equal(setup.status, 201);

type Run = { code: number | null; stdout: string; stderr: string };
type RunOptions = { input?: string; url?: string; env?: Record<string, string> };

function cliEnv(options: RunOptions): NodeJS.ProcessEnv {
  // A test run from a mission inherits its identity: the CLI must speak as a terminal here.
  const { TIMON_MISSION_ID: _mission, TIMON_AGENT: _agent, ...parent } = process.env;
  return {
    ...parent,
    TIMON_API: options.url ?? base,
    TIMON_API_TOKEN: TOKEN,
    TIMON_HOME: mkdtempSync(join(tmpdir(), 'timon-backend-cli-home-')),
    ...options.env,
  };
}

const outputs: string[] = [];

function timon(args: string[], options: RunOptions = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TIMON, 'backend', ...args], {
      env: cliEnv(options),
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (c: Buffer) => { stdout += String(c); });
    child.stderr!.on('data', (c: Buffer) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => { outputs.push(stdout, stderr); resolve({ code, stdout, stderr }); });
    if (options.input !== undefined) child.stdin!.end(options.input);
  });
}

const backendFile = (id: string) => join(HOME, 'backends', `${id}.json`);
const writesSeen = () => recorded.filter((row) => row.method !== 'GET').length;
const secretRows = (id: string) => dbApi.listSecrets().filter((row) => row.name === `BACKEND_${id.toUpperCase().replace(/-/g, '_')}_API_KEY`);

test('add posts exactly the form\'s body, once, and the key travels in that body only', async () => {
  recorded.length = 0;
  const r = await timon(['add', 'Cli box', '--base-url', providerUrl, '--protocol', 'openai-responses', '--models', 'witness-1, witness-2', '--default-model', 'witness-2', '--key-from-stdin'], { input: `${KEY}\n` });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /added cli-box \(Cli box, openai-responses\)/);
  assert.match(r.stdout, /key stored in the vault/);

  const posts = recorded.filter((row) => row.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.url, '/api/backends/custom');
  assert.deepEqual(posts[0]!.body, { name: 'Cli box', baseUrl: providerUrl, protocol: 'openai-responses', key: KEY, models: ['witness-1', 'witness-2'], defaultModel: 'witness-2' });
  assert.doesNotMatch(posts[0]!.headers, LEAK);

  assert.doesNotMatch(readFileSync(backendFile('cli-box'), 'utf8'), LEAK);
  const [secret] = secretRows('cli-box');
  assert.ok(secret, 'the key is in the vault');
  assert.equal(readSecretValue(secret.id), KEY);
});

test('what the CLI adds is the file the form would have written', async () => {
  const form = { baseUrl: 'https://parity.example.com/anthropic', protocol: 'anthropic', key: KEY, models: ['p-1'], brand: 'deepseek' };
  const viaRoute = await fetch(`${base}/api/backends/custom`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ name: 'Parity route', ...form }),
  });
  assert.equal(viaRoute.status, 201);
  const viaCli = await timon(['add', 'Parity cli', '--base-url', form.baseUrl, '--protocol', form.protocol, '--models', 'p-1', '--brand', 'deepseek', '--key-from-stdin'], { input: KEY });
  assert.equal(viaCli.code, 0, viaCli.stderr);

  const normalized = (id: string, name: string) => JSON.parse(readFileSync(backendFile(id), 'utf8')
    .replaceAll(id, 'ID').replaceAll(id.toUpperCase().replace(/-/g, '_'), 'ID').replaceAll(name, 'NAME')
    .replace(/"addedAt":\s*\d+/g, '"addedAt": 0'));
  assert.deepEqual(normalized('parity-cli', 'Parity cli'), normalized('parity-route', 'Parity route'));
});

test('a key given as an argument is refused in every form, before anything is sent, and never echoed', async () => {
  const required = ['Arg box', '--base-url', providerUrl, '--protocol', 'openai-responses'];
  const before = writesSeen();
  for (const attempt of [
    ['--key', KEY], [`--key=${KEY}`], ['--api-key', KEY], [`--apikey=${KEY}`], ['--token', KEY], ['--secret', KEY], ['-k', KEY],
    [KEY], [`--unknown=${KEY}`],
  ]) {
    const r = await timon(['add', ...required, ...attempt]);
    assert.equal(r.code, 64, `${attempt[0]}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout + r.stderr, LEAK, attempt[0]);
  }
  const named = await timon(['add', ...required, '--key', KEY]);
  assert.match(named.stderr, /never passed as an argument/);
  assert.match(named.stderr, /--key-from-stdin/);
  // The ad-hoc test takes a key too, and the other verbs have no reason to.
  for (const args of [['test', '--base-url', providerUrl, '--protocol', 'openai-responses', '--key', KEY], ['test', 'cli-box', `--key=${KEY}`], ['rm', 'cli-box', KEY], ['list', KEY]]) {
    const r = await timon(args);
    assert.equal(r.code, 64, args.join(' '));
    assert.doesNotMatch(r.stdout + r.stderr, LEAK);
  }
  assert.equal(writesSeen(), before);
  assert.equal(existsSync(backendFile('arg-box')), false);
});

test('a credential in the address is refused too, and never echoed', async () => {
  const before = writesSeen();
  for (const url of [`https://user:${KEY}@example.com/v1`, `https://example.com/v1?api_key=${KEY}`, `https://example.com/v1#${KEY}`]) {
    for (const args of [['add', 'Url box', '--base-url', url, '--protocol', 'anthropic', '--no-key'], ['test', '--base-url', url, '--protocol', 'anthropic', '--no-key']]) {
      const r = await timon(args);
      assert.equal(r.code, 64, r.stderr);
      assert.match(r.stderr, /--base-url cannot carry/);
      assert.doesNotMatch(r.stdout + r.stderr, LEAK);
    }
  }
  assert.equal(writesSeen(), before);
});

test('no key, no terminal: a clear refusal, and an empty pipe is not a keyless backend', async () => {
  const required = ['Nokey box', '--base-url', providerUrl, '--protocol', 'openai-responses'];
  const before = writesSeen();
  const silent = await timon(['add', ...required]);
  assert.equal(silent.code, 64);
  assert.match(silent.stderr, /--key-from-stdin/);
  assert.match(silent.stderr, /--no-key/);
  // Without the flag, what sits on a pipe is not taken for a key.
  assert.equal((await timon(['add', ...required], { input: KEY })).code, 64);
  const empty = await timon(['add', ...required, '--key-from-stdin'], { input: '  \n' });
  assert.equal(empty.code, 64);
  assert.match(empty.stderr, /empty/);
  assert.equal((await timon(['add', ...required, '--key-from-stdin', '--no-key'], { input: KEY })).code, 64);
  // Missing pieces are reported before any key is asked for.
  assert.equal((await timon(['add', 'Nokey box', '--key-from-stdin'], { input: KEY })).code, 64);
  assert.equal((await timon(['add', ...required.slice(0, 3), '--protocol'])).code, 64);
  assert.equal(writesSeen(), before);
});

test('--no-key adds an endpoint that asks for none', async () => {
  const r = await timon(['add', 'Open box', '--base-url', providerUrl, '--protocol', 'openai-responses', '--no-key', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const backend = JSON.parse(r.stdout) as { id: string; hasVaultKey: boolean };
  assert.equal(backend.id, 'open-box');
  assert.equal(backend.hasVaultKey, false);
  assert.equal(secretRows('open-box').length, 0);
});

function fakeDeps(overrides: Record<string, unknown> = {}) {
  const log = { out: '', err: '', exit: null as number | null, prompts: 0, bodies: [] as unknown[] };
  return {
    log,
    deps: {
      httpRaw: async (_method: string, _path: string, body: unknown) => {
        log.bodies.push(body);
        return { ok: true, status: 201, body: { backend: { id: 'x', label: 'X', protocol: 'anthropic', hasVaultKey: true, reason: null } } };
      },
      readAll: async () => { throw new Error('stdin must not be read on a terminal'); },
      readHiddenLine: async () => { log.prompts += 1; return `  ${KEY}  `; },
      stdin: { isTTY: true },
      out: (text: string) => { log.out += text; },
      err: (text: string) => { log.err += text; },
      exit: (code: number) => { log.exit = code; },
      ...overrides,
    },
  };
}

test('a terminal is asked through the hidden prompt, and --key-from-stdin does not read a terminal', async () => {
  const asked = fakeDeps();
  await cmdBackend(['add', 'X', '--base-url', 'https://x.example.com', '--protocol', 'anthropic'], asked.deps);
  assert.equal(asked.log.prompts, 1);
  assert.equal(asked.log.exit, null, asked.log.err);
  assert.equal((asked.log.bodies[0] as { key: string }).key, KEY);
  assert.doesNotMatch(asked.log.out + asked.log.err, LEAK);

  const blank = fakeDeps({ readHiddenLine: async () => '   ' });
  await cmdBackend(['add', 'X', '--base-url', 'https://x.example.com', '--protocol', 'anthropic'], blank.deps);
  assert.equal(blank.log.exit, 64);
  assert.equal(blank.log.bodies.length, 0);

  const flagged = fakeDeps();
  await cmdBackend(['add', 'X', '--base-url', 'https://x.example.com', '--protocol', 'anthropic', '--key-from-stdin'], flagged.deps);
  assert.equal(flagged.log.exit, 64);
  assert.equal(flagged.log.prompts, 0);
  assert.equal(flagged.log.bodies.length, 0);
});

test('Ctrl-C at the prompt stops with 130, says nothing and sends nothing', async () => {
  const cancelled = async () => { throw Object.assign(new Error('cancelled'), { code: PROMPT_CANCELLED }); };
  for (const args of [
    ['add', 'X', '--base-url', 'https://x.example.com', '--protocol', 'anthropic'],
    ['test', '--base-url', 'https://x.example.com', '--protocol', 'anthropic'],
  ]) {
    const { log, deps } = fakeDeps({ readHiddenLine: cancelled });
    await cmdBackend(args, deps);
    assert.equal(log.exit, 130, args[0]);
    assert.equal(log.err + log.out, '', args[0]);
    assert.equal(log.bodies.length, 0, args[0]);
  }
  // Only the cancellation is a clean stop: a prompt that breaks is still reported.
  const broken = fakeDeps({ readHiddenLine: async () => { throw new Error('setRawMode failed'); } });
  await assert.rejects(cmdBackend(['add', 'X', '--base-url', 'https://x.example.com', '--protocol', 'anthropic'], broken.deps), /setRawMode failed/);
  assert.equal(broken.log.exit, null);
});

// portability: `script` is how a test gets a real terminal without a new dependency; the prompt itself is covered above on every OS.
const scriptBinary = '/usr/bin/script';
const realTerminal = process.platform === 'linux' && existsSync(scriptBinary);
test('in a real terminal the key typed at the prompt does not appear', { skip: !realTerminal }, async () => {
  const command = `'${process.execPath}' '${TIMON}' backend add 'Tty box' --base-url ${providerUrl} --protocol openai-responses`;
  const child = spawn(scriptBinary, ['-qfec', command, '/dev/null'], { env: cliEnv({}), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let typed = false;
  const onData = (chunk: Buffer) => {
    output += String(chunk);
    // Only once the prompt is up: before raw mode, the terminal itself would echo it.
    if (!typed && output.includes('input hidden')) { typed = true; child.stdin.write(`${KEY}\r`); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const [code] = await once(child, 'close') as [number | null];
  assert.equal(code, 0, output);
  assert.match(output, /added tty-box/);
  assert.doesNotMatch(output, LEAK);
  const [secret] = secretRows('tty-box');
  assert.ok(secret);
  assert.equal(readSecretValue(secret.id), KEY);
});

test('in a real terminal Ctrl-C at the prompt exits 130 and leaves the terminal as it found it', { skip: process.platform !== 'linux' || !existsSync(scriptBinary) }, async () => {
  const before = writesSeen();
  // The same shell reads the settings on both sides. If the keypress reached the
  // terminal as a signal instead of the prompt, this shell dies with it and the second read is missing.
  const command = `stty -g; '${process.execPath}' '${TIMON}' backend add 'Ctrlc box' --base-url ${providerUrl} --protocol openai-responses; code=$?; stty -g; exit $code`;
  const child = spawn(scriptBinary, ['-qfec', command, '/dev/null'], { env: cliEnv({}), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let typed = false;
  const onData = (chunk: Buffer) => {
    output += String(chunk);
    if (!typed && output.includes('input hidden')) { typed = true; child.stdin.write('sk-half-typed\u0003'); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const [code] = await once(child, 'close') as [number | null];
  assert.equal(code, 130, output);
  const settings = output.match(/^[0-9a-f]+(?::[0-9a-f]+)+(?=\r?$)/gm) ?? [];
  assert.equal(settings.length, 2, output);
  assert.equal(settings[1], settings[0], 'raw mode was left behind');
  assert.doesNotMatch(output, /cancelled|timon:|Error|sk-half-typed/);
  assert.equal(writesSeen(), before);
  assert.equal(existsSync(backendFile('ctrlc-box')), false);
});

/** Runs a command in a real terminal, and types `keys` once its prompt is up. */
async function atRealPrompt(command: string, promptText: string, keys: string) {
  const child = spawn(scriptBinary, ['-qfec', command, '/dev/null'], { env: cliEnv({}), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let typed = false;
  const onData = (chunk: Buffer) => {
    output += String(chunk);
    if (!typed && output.includes(promptText)) { typed = true; child.stdin.write(keys); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const [code] = await once(child, 'close') as [number | null];
  return { code, output };
}

test('in a real terminal Ctrl-D on an empty line exits 130; on a typed line it leaves no trace in the key', { skip: process.platform !== 'linux' || !existsSync(scriptBinary) }, async () => {
  const add = (name: string) => `'${process.execPath}' '${TIMON}' backend add '${name}' --base-url ${providerUrl} --protocol openai-responses`;
  const before = writesSeen();
  const empty = await atRealPrompt(add('Ctrld box'), 'input hidden', '\u0004');
  assert.equal(empty.code, 130, empty.output);
  assert.doesNotMatch(empty.output, /cancelled|timon:|Error/);
  assert.equal(writesSeen(), before);
  assert.equal(existsSync(backendFile('ctrld-box')), false);

  const typed = await atRealPrompt(add('Ctrld typed'), 'input hidden', `${KEY}\u0004\r`);
  assert.equal(typed.code, 0, typed.output);
  const [secret] = secretRows('ctrld-typed');
  assert.ok(secret);
  assert.equal(readSecretValue(secret.id), KEY);
});

test('the prompt of `timon auth claude-token set` backs out the same way', { skip: process.platform !== 'linux' || !existsSync(scriptBinary) }, async () => {
  const before = recorded.length;
  for (const keys of ['sk-half-typed\u0003', '\u0004']) {
    const r = await atRealPrompt(`'${process.execPath}' '${TIMON}' auth claude-token set`, 'claude setup-token', keys);
    assert.equal(r.code, 130, r.output);
    assert.doesNotMatch(r.output, /cancelled|timon:|Error|sk-half-typed/);
  }
  assert.equal(recorded.length, before, 'nothing was sent');
});

test('list shows state and address, never a key, even for a file written by hand', async () => {
  mkdirSync(join(HOME, 'backends'), { recursive: true });
  writeFileSync(backendFile('hand-box'), JSON.stringify({
    id: 'hand-box', dialect: 'claude', label: 'Hand box',
    env: { ANTHROPIC_BASE_URL: `https://user:${KEY}@hand.example.com/anthropic?t=${KEY}`, ANTHROPIC_AUTH_TOKEN: KEY },
    defaultModel: null, models: [],
  }));
  const text = await timon(['list']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /cli-box +active +openai-responses +vault key +2 model\(s\)/);
  assert.match(text.stdout, /hand-box .*https:\/\/hand\.example\.com\/anthropic/);
  assert.match(text.stdout, /warning: ANTHROPIC_AUTH_TOKEN holds a credential in clear text/);
  assert.doesNotMatch(text.stdout + text.stderr, LEAK);

  const json = await timon(['list', '--json']);
  assert.equal(json.code, 0, json.stderr);
  assert.doesNotMatch(json.stdout, LEAK);
  const listing = JSON.parse(json.stdout) as { backends: { id: string; baseUrl: string | null }[]; protocols: unknown[] };
  // Same payload as the route, the address made safe.
  const direct = await (await fetch(`${base}/api/backends/custom`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { backends: { id: string }[]; protocols: unknown };
  assert.deepEqual(listing.backends.map((row) => row.id), direct.backends.map((row) => row.id));
  assert.deepEqual(listing.protocols, direct.protocols);
  assert.equal(listing.backends.find((row) => row.id === 'hand-box')!.baseUrl, 'https://hand.example.com/anthropic');
  localProfiles.removeLocalBackend('hand-box');
});

test('test reports each outcome, with an exit code a script can use', async () => {
  const saved = await timon(['test', 'cli-box']);
  assert.equal(saved.code, 0, saved.stderr);
  assert.match(saved.stdout, /^ok — .*\(HTTP 200\)\nmodels: witness-1\n$/);
  const posted = recorded.filter((row) => row.url === '/api/backends/custom/test').at(-1)!;
  assert.deepEqual(posted.body, { id: 'cli-box' });

  const savedJson = await timon(['test', 'cli-box', '--json']);
  assert.equal((JSON.parse(savedJson.stdout) as { outcome: string }).outcome, 'ok');

  const good = await timon(['test', '--base-url', providerUrl, '--protocol', 'openai-responses', '--key-from-stdin'], { input: KEY });
  assert.equal(good.code, 0, good.stderr);
  assert.deepEqual(recorded.filter((row) => row.url === '/api/backends/custom/test').at(-1)!.body, { protocol: 'openai-responses', baseUrl: providerUrl, key: KEY });

  const refused = await timon(['test', '--base-url', providerUrl, '--protocol', 'openai-responses', '--no-key']);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /^key refused — .*HTTP 401/);

  const dead = await timon(['test', '--base-url', 'http://127.0.0.1:1/v1', '--protocol', 'openai-responses', '--key-from-stdin'], { input: KEY });
  assert.equal(dead.code, 1);
  assert.match(dead.stdout, /^unreachable/);
  assert.doesNotMatch(dead.stdout + dead.stderr, LEAK);

  assert.equal((await timon(['test', 'nobody-here'])).code, 2);
  // A saved key goes to its saved address only: said before any prompt, as the route would.
  assert.equal((await timon(['test', 'cli-box', '--base-url', 'https://elsewhere.example.com'])).code, 64);
  assert.equal((await timon(['test', 'cli-box', '--key-from-stdin'], { input: KEY })).code, 64);
  assert.equal((await timon(['test'])).code, 64);
});

test('a route\'s refusal is one readable line naming the flag, and the body it refused is not repeated', async () => {
  const invalid = await timon(['add', 'Bad box', '--base-url', 'ftp://nowhere', '--protocol', 'telnet', '--key-from-stdin'], { input: KEY });
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /refused \(400 invalid_fields\) — check --base-url, --protocol/);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, LEAK);

  const duplicate = await timon(['add', 'Cli box', '--base-url', providerUrl, '--protocol', 'openai-responses', '--key-from-stdin'], { input: KEY });
  assert.equal(duplicate.code, 2);
  assert.match(duplicate.stderr, /refused \(409 backend_duplicate\) — a backend named cli-box already exists/);
  assert.doesNotMatch(duplicate.stdout + duplicate.stderr, LEAK);
});

test('a mission is refused every change, readably, and nothing moves', async () => {
  const admin = dbApi.listUsers().find((user) => user.email === 'admin@example.com')!;
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'admin.agent', 'work', undefined, admin.id);
  const file = readFileSync(backendFile('cli-box'), 'utf8');
  const secrets = secretRows('cli-box').map((row) => row.id);
  // The everyday mission token stops at the Providers level, listing included: never in the mission cap.
  const plainMission = { TIMON_API_TOKEN: issueMissionApiToken(missionId), TIMON_MISSION_ID: missionId, TIMON_AGENT: 'admin.agent' };
  for (const args of [['list'], ['test', 'cli-box'], ['rm', 'cli-box'], ['add', 'Agent box', '--base-url', providerUrl, '--protocol', 'openai-responses', '--no-key']]) {
    const r = await timon(args, { env: plainMission });
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /refused \(403 not_in_mission_cap\) — mission tokens never carry providers:manage/);
    assert.match(r.stderr, /Do it from the UI/);
    assert.doesNotMatch(r.stderr, /^\{/m);
  }
  // A developer account's missions carry its authority: the strongest token an agent can hold.
  setLicenseState({ ...paidTestLicense(), planId: 'internal', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  try {
    const agent = issueMissionApiToken(missionId);
    const identities: Record<string, string>[] = [
      { TIMON_API_TOKEN: agent, TIMON_MISSION_ID: missionId, TIMON_AGENT: 'admin.agent' },
      // The daemon-token inside a mission announces it, and the claim is honoured.
      { TIMON_API_TOKEN: TOKEN, TIMON_MISSION_ID: missionId, TIMON_AGENT: 'admin.agent' },
    ];
    for (const env of identities) {
      const form = ['--base-url', providerUrl, '--protocol', 'openai-responses', '--key-from-stdin'];
      const attempts: [string[], string?][] = [
        [['add', 'Agent box', ...form], KEY],
        [['test', '--base-url', providerUrl, '--protocol', 'openai-responses', '--key-from-stdin'], KEY],
        [['test', 'cli-box']],
        [['rm', 'cli-box']],
      ];
      for (const [args, input] of attempts) {
        const r = await timon(args, { env, ...(input === undefined ? {} : { input }) });
        assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
        assert.match(r.stderr, /refused \(403 operator_only\)/);
        assert.match(r.stderr, /by a person, never by an agent/);
        assert.match(r.stderr, /Settings › AI models › Providers \(Add a provider, or the provider's page\)/);
        assert.doesNotMatch(r.stderr, /^\{/m, 'a sentence, not a raw body');
        assert.doesNotMatch(r.stdout + r.stderr, LEAK);
      }
    }
    const read = await timon(['list'], { env: identities[0]! });
    assert.equal(read.code, 0, 'the listing stays readable');
    assert.doesNotMatch(read.stdout, LEAK);
  } finally {
    setLicenseState(paidTestLicense());
  }
  assert.equal(readFileSync(backendFile('cli-box'), 'utf8'), file);
  assert.equal(existsSync(backendFile('agent-box')), false);
  assert.deepEqual(secretRows('cli-box').map((row) => row.id), secrets);
});

test('an anonymous caller is refused, and a daemon that is down is said so', async () => {
  const anonymous = await timon(['list'], { env: { TIMON_API_TOKEN: '' } });
  assert.equal(anonymous.code, 2);
  assert.match(anonymous.stderr, /refused \(401/);
  const down = await timon(['list'], { url: 'http://127.0.0.1:1' });
  assert.equal(down.code, 1);
  assert.match(down.stderr, /does not answer/);
  const unknown = await timon(['frobnicate']);
  assert.equal(unknown.code, 64);
  assert.match(unknown.stderr, /usage: timon backend add/);
});

test('a daemon or a proxy that echoes the key still does not get it on screen', async () => {
  const echoed = JSON.stringify({ error: `bad value ${KEY}`, reason: `got ${KEY}`, hint: KEY });
  for (const status of [400, 500]) {
    const echo = createServer((_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }).end(echoed); });
    echo.listen(0, '127.0.0.1');
    await once(echo, 'listening');
    const url = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
    try {
      const r = await timon(['add', 'Echo', '--base-url', providerUrl, '--protocol', 'anthropic', '--key-from-stdin'], { input: KEY, url });
      assert.equal(r.code, 2);
      assert.doesNotMatch(r.stdout + r.stderr, LEAK);
      assert.match(r.stderr, /\[key hidden\]/);
    } finally { echo.close(); }
  }
  // A success can echo too, and a page that is not ours is not relayed at all.
  const lucky = createServer((req, res) => {
    if (req.url === '/api/backends/custom/test') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ outcome: 'ok', status: 200, models: [KEY] }));
    res.writeHead(502, { 'content-type': 'text/html' }).end(`<h1>${KEY}</h1>`);
  });
  lucky.listen(0, '127.0.0.1');
  await once(lucky, 'listening');
  const url = `http://127.0.0.1:${(lucky.address() as AddressInfo).port}`;
  try {
    const ok = await timon(['test', '--base-url', providerUrl, '--protocol', 'anthropic', '--key-from-stdin', '--json'], { input: KEY, url });
    assert.equal(ok.code, 0, ok.stderr);
    assert.doesNotMatch(ok.stdout, LEAK);
    const page = await timon(['add', 'Echo', '--base-url', providerUrl, '--protocol', 'anthropic', '--key-from-stdin'], { input: KEY, url });
    assert.equal(page.code, 2);
    assert.match(page.stderr, /refused \(502\)/);
    assert.doesNotMatch(page.stderr, /h1/);
  } finally { lucky.close(); }
});

const fetchListing = async () => {
  const res = await fetch(`${base}/api/backends/custom`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { ok: res.ok, status: res.status, body: await res.json() as unknown };
};
const loadLocalProfiles = async () => localProfiles;

test('doctor counts the profiles present, testable and in error, and shows no key', async () => {
  writeFileSync(backendFile('doctor-json'), `{ "id": "doctor-json", "env": { "ANTHROPIC_AUTH_TOKEN": "${KEY}" `);
  writeFileSync(backendFile('doctor-refused'), JSON.stringify({ id: 'doctor-refused', dialect: 'claude', label: 'R', cmd: KEY, env: { ANTHROPIC_AUTH_TOKEN: KEY }, defaultModel: null, models: [] }));
  writeFileSync(backendFile('doctor-clear'), JSON.stringify({
    id: 'doctor-clear', dialect: 'claude', label: 'Clear',
    env: { ANTHROPIC_BASE_URL: `https://u:${KEY}@clear.example.com?k=${KEY}`, ANTHROPIC_AUTH_TOKEN: KEY }, defaultModel: null, models: [],
  }));
  writeFileSync(backendFile('doctor-missing'), JSON.stringify({
    id: 'doctor-missing', dialect: 'claude', label: 'Missing',
    env: { ANTHROPIC_BASE_URL: 'https://missing.example.com', ANTHROPIC_AUTH_TOKEN: { secret: 'NOT_IN_THE_VAULT' } }, defaultModel: null, models: [],
  }));
  assert.equal((await fetch(`${base}/api/backends/custom/open-box`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ disabled: true }),
  })).status, 200);

  const report = await backendProfilesReport({ local: true, fetchListing, loadLocalProfiles });
  assert.equal(report.source, 'daemon');
  assert.equal(report.note, null);
  const row = (id: string) => report.profiles.find((entry: { id: string }) => entry.id === id)!;
  assert.deepEqual(
    { state: row('cli-box').state, testable: row('cli-box').testable, hasVaultKey: row('cli-box').hasVaultKey },
    { state: 'active', testable: true, hasVaultKey: true },
  );
  assert.equal(row('open-box').state, 'disabled');
  assert.equal(row('doctor-json').state, 'error');
  assert.equal(row('doctor-json').testable, false);
  assert.match(row('doctor-json').reason, /not valid JSON/);
  assert.equal(row('doctor-refused').state, 'error');
  assert.match(row('doctor-refused').reason, /`cmd` is not allowed/);
  assert.equal(row('doctor-missing').state, 'error');
  assert.match(row('doctor-missing').reason, /NOT_IN_THE_VAULT/);
  assert.match(row('doctor-clear').warnings.join(), /holds a credential in clear text/);
  assert.equal(report.present, report.profiles.length);
  assert.equal(report.inError, report.profiles.filter((entry: { state: string }) => entry.state === 'error').length);
  assert.ok(report.inError >= 3);

  const text = formatBackendProfiles(report);
  assert.match(text, new RegExp(`^Backend profiles: ${report.present} present, ${report.testable} testable, ${report.inError} in error\\n`));
  assert.match(text, /cli-box +active +testable +vault key/);
  assert.match(text, /open-box +disabled +testable +no key/);
  assert.match(text, /doctor-json +ERROR +not testable +no key\n +not valid JSON/);
  assert.match(text, /timon backend test <id>/);
  for (const shown of [text, JSON.stringify(report)]) {
    assert.doesNotMatch(shown, LEAK);
    assert.doesNotMatch(shown, /clear\.example\.com/, 'doctor text is pasted in support requests: no address');
  }
});

test('doctor falls back on the files when the daemon cannot say, and says what it does not know', async () => {
  const notes: [Parameters<typeof backendProfilesReport>[0]['fetchListing'] | null, RegExp][] = [
    [async () => { throw new Error('connection refused'); }, /does not answer/],
    [async () => ({ ok: false, status: 403, body: { error: 'forbidden', code: 'not_in_mission_cap' } }), /refused the listing \(403\)/],
    [null, /another daemon/],
  ];
  for (const [listing, note] of notes) {
    const report = await backendProfilesReport({
      local: listing !== null,
      fetchListing: listing ?? (async () => { throw new Error('a remote daemon does not describe this machine'); }),
      loadLocalProfiles,
    });
    assert.equal(report.source, 'files');
    assert.match(report.note, note);
    assert.equal(report.testable, null);
    const file = report.profiles.find((entry: { id: string }) => entry.id === 'cli-box')!;
    assert.equal(file.state, 'unknown');
    assert.equal(file.testable, null);
    assert.equal(file.hasVaultKey, true);
    assert.equal(report.profiles.find((entry: { id: string }) => entry.id === 'doctor-json')!.state, 'error');
    const text = formatBackendProfiles(report);
    assert.match(text, /cli-box +file ok +not checked +vault key/);
    assert.doesNotMatch(text, /Check one/);
    assert.doesNotMatch(text + JSON.stringify(report), LEAK);
  }

  const noData = await backendProfilesReport({
    local: true,
    fetchListing: async () => { throw new Error('down'); },
    loadLocalProfiles: async () => { throw new Error('update pending'); },
  });
  assert.equal(noData.source, 'unavailable');
  assert.match(formatBackendProfiles(noData), /could not be read either/);
});

test('rm removes the backend and the key added with it; an unknown id is refused', async () => {
  const r = await timon(['rm', 'cli-box']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'removed cli-box; BACKEND_CLI_BOX_API_KEY left the vault too\n');
  assert.equal(existsSync(backendFile('cli-box')), false);
  assert.equal(secretRows('cli-box').length, 0);
  assert.equal(recorded.filter((row) => row.method === 'DELETE').at(-1)!.url, '/api/backends/custom/cli-box');

  const again = await timon(['rm', 'cli-box', '--json']);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /refused \(404 backend_unknown\) — unknown backend/);
  assert.equal((await timon(['rm'])).code, 64);
});

test('rm says nothing about a key the backend did not have', async () => {
  assert.equal(secretRows('open-box').length, 0);
  const r = await timon(['rm', 'open-box']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'removed open-box\n');
  assert.equal(existsSync(backendFile('open-box')), false);
});

test('rm on a profile that references a shared secret does not claim it left: it did not', async () => {
  const shared = createSecret({ name: 'TEAM_SHARED_API_KEY', value: KEY, grants: [{ scope_kind: 'global', scope_ref: null }] });
  writeFileSync(backendFile('shared-box'), JSON.stringify({
    id: 'shared-box', dialect: 'claude', label: 'Shared box',
    env: { ANTHROPIC_BASE_URL: 'https://shared.example.com', ANTHROPIC_AUTH_TOKEN: { secret: 'TEAM_SHARED_API_KEY' } }, defaultModel: null, models: [],
  }));
  const listed = JSON.parse((await timon(['list', '--json'])).stdout) as { backends: { id: string; hasVaultKey: boolean }[] };
  assert.equal(listed.backends.find((row) => row.id === 'shared-box')!.hasVaultKey, true, 'the listing reads it as holding a key');

  const r = await timon(['rm', 'shared-box']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'removed shared-box\n');
  assert.equal(existsSync(backendFile('shared-box')), false);
  assert.equal(readSecretValue(shared.id), KEY, 'the secret others use is still there');
  deleteSecret(shared.id);
});

test('rm repeats what the route removed, and claims nothing when the route does not say', async () => {
  const rm = async (body: unknown, args: string[] = ['rm', 'x']) => {
    const { log, deps } = fakeDeps({
      httpRaw: async (method: string) => {
        log.bodies.push(method);
        return { ok: true, status: 200, body };
      },
    });
    await cmdBackend(args, deps);
    return log;
  };

  assert.equal((await rm({ ok: true, removedSecrets: ['BACKEND_X_API_KEY'] })).out, 'removed x; BACKEND_X_API_KEY left the vault too\n');
  for (const body of [
    { ok: true, removedSecrets: [] },
    { ok: true }, // A daemon from before the field.
    { ok: true, removedSecrets: 'not a list' },
    '<h1>a proxy page</h1>',
  ]) {
    const log = await rm(body);
    assert.equal(log.out, 'removed x\n');
    assert.equal(log.exit, null, log.err);
    assert.deepEqual(log.bodies, ['DELETE'], 'the route alone answers: no listing before it');
  }

  const refused = fakeDeps({ httpRaw: async () => ({ ok: false, status: 403, body: { code: 'operator_only', reason: 'by a person' } }) });
  await cmdBackend(['rm', 'x'], refused.deps);
  assert.equal(refused.log.exit, 2);
  assert.equal(refused.log.out, '', 'a removal that was refused does not claim anything left');
  assert.match(refused.log.err, /refused \(403 operator_only\) — by a person/);

  // The JSON stays the route's answer.
  const json = await rm({ ok: true, removedSecrets: ['BACKEND_X_API_KEY'] }, ['rm', 'x', '--json']);
  assert.deepEqual(JSON.parse(json.out), { ok: true, removedSecrets: ['BACKEND_X_API_KEY'] });
});

test('the key reached no output, no file and no audit line over the whole file', () => {
  assert.ok(outputs.length > 30);
  for (const output of outputs) assert.doesNotMatch(output, LEAK);
  assert.doesNotMatch(JSON.stringify(dbApi.listAuditLog(500)), LEAK);
  // `tty-box` only exists where the real-terminal test ran.
  for (const id of ['parity-cli', 'parity-route', ...(realTerminal ? ['tty-box'] : [])]) assert.doesNotMatch(readFileSync(backendFile(id), 'utf8'), LEAK);
});
