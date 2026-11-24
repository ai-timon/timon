/**
 * The fence of a mission must open every folder of the Timon home its CLI is told to use.
 *
 * The fence is an allow-list computed from the mission's identity (`missionFenceTarget`,
 * `resolveFence`); the folders the CLI reads and writes are chosen by the dialect's `buildSpawn`.
 * Nothing at launch compares the two, so each mismatch so far was found by a tester: a profile
 * whose scratch folder belonged to another plugin than the one the fence named (a profile from a
 * user's file, a provider pack, Ollama Cloud on the codex dialect, Kimi on the claude one).
 *
 * The invariant checked here does not depend on who owns what: for every active profile, every
 * path under the Timon home that the real launch spec names (arguments, environment values, the
 * folders their links lead to, the plugin's shared cache) is readable under the policy the daemon
 * computes for that mission, and every folder the CLI writes to is writable. The policy is also
 * rendered as a Seatbelt profile and read back, since macOS enforces that rendering, not
 * `fenceAccess`.
 *
 * Real registry, the official providers mounted as the loader mounts them, a temporary Timon home
 * and a temporary user home. No CLI runs: stand-in binaries make the profiles exist.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The user's home the fence reasons about: a throwaway one, with the CLIs' own folders in it, so
// that a backend's grant on its folder resolves on any machine and the real home is never read.
const USER_HOME = realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-fence-user-home-')));
process.env.HOME = USER_HOME;
process.env.USERPROFILE = USER_HOME;
for (const dir of ['.claude', '.codex', '.grok', '.copilot', '.pi', '.kimi', '.ollama']) mkdirSync(join(USER_HOME, dir), { recursive: true });
process.on('exit', () => rmSync(USER_HOME, { recursive: true, force: true }));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
// Placeholders that make the API-key profiles active; nothing here sends a request.
process.env.KIMI_API_KEY = 'test-only-kimi';
process.env.OLLAMA_API_KEY = 'test-only-ollama';
process.env.GROK_AUTH_DIR = join(USER_HOME, '.grok');

const OFFICIAL = fileURLToPath(new URL('../official-providers', import.meta.url));
const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn, buildUnderSeal } = await import('../tests/helpers/official-providers.js');
// Every name a manifest lets a profile's CLI go by: a profile exists only when its first one is found,
// and a CLI installed on the machine running the suite must not be what makes it exist.
await stubCliBinaries(...readdirSync(OFFICIAL).flatMap((dir) => {
  const manifest = JSON.parse(readFileSync(join(OFFICIAL, dir, 'package.json'), 'utf8')) as {
    timon?: { provider?: { backends?: Array<{ binary?: { names?: string[] } }> } };
  };
  return (manifest.timon?.provider?.backends ?? []).flatMap((backend) => backend.binary?.names ?? []);
}));
await stubCodexSignIn();
const { activeProfiles, backendOwnerPlugin, getDialect, registerFileProfile, registerPackProfile } = await import('./backends/registry.js');
const { providerServicesFor, PROVIDER_PROFILE_SCRATCH_API_VERSION } = await import('./plugins/provider-facade.js');
const { getBackend } = await import('./backends/index.js');
const { nestedSandboxOf } = await import('./backends/capabilities.js');
const { missionFenceTarget, upsertAgent } = await import('./agent.js');
const { config, setConfig } = await import('./config/load.js');
const { TIMON_HOME } = await import('./paths.js');
const { fenceAccess, systemWritableFolders } = await import('./host/isolation.js');
const { canonicalPaths, renderSeatbeltProfile } = await import('./host/seatbelt.js');
const { fenceMissionCommand } = await import('./resources.js');
type FencePolicy = import('./host/isolation.js').FencePolicy;
type HostFence = import('./host/types.js').HostFence;
type SpawnResult = import('./backends/types.js').SpawnResult;

// Stand-ins of the daemon's private files, so that a refusal is about a path that exists.
for (const name of ['daemon-token', 'timon.db']) writeFileSync(join(TIMON_HOME, name), '');
await mountOfficialProviders();
setConfig({ ...config(), host: { ...config().host, isolation: { ...config().host.isolation, filesystem: 'auto' } } });

/** A dialect that starts a process (a remote one has no `buildSpawn`, hence no folder to hand over). */
const isProcessDialect = (id: string): boolean => {
  const dialect = getDialect(id);
  return dialect !== undefined && 'buildSpawn' in dialect;
};
/** The process dialects the official providers brought, each one a user's file is put on. */
const PROCESS_DIALECTS = [...new Set(activeProfiles()
  .filter((entry) => isProcessDialect(entry.profile.dialect))
  .map((entry) => entry.profile.dialect))].sort();
for (const dialect of PROCESS_DIALECTS) {
  // Data only, the way `~/.timon/backends/<id>.json` is loaded: the dialect's plugin runs it.
  registerFileProfile('local-file', { id: `user-${dialect}`, dialect, label: `User ${dialect}`, models: [], defaultModel: null });
}
// A provider pack's entry: data again, on another plugin's dialect.
registerPackProfile('acme-pack', { id: 'pack-codex', dialect: 'codex', label: 'Pack', models: [], defaultModel: null });

/**
 * Profiles that must be covered: a test that silently covers fewer is worse than none. Antigravity
 * is off until the user switches it on (`disabled` in its profile), so it is not among them.
 */
const EXPECTED = [
  'claude', 'codex', 'grok', 'copilot', 'pi', 'kimi', 'ollama-cloud', 'opencode', 'hermes',
  'pack-codex', ...PROCESS_DIALECTS.map((d) => `user-${d}`),
];
/**
 * Dialects whose launch names no folder of the Timon home: the ACP agents get their instructions
 * and MCP servers over the protocol and keep their state in their own folders of the user's home.
 * Their missions are still checked for what they must not reach.
 */
const NO_TIMON_FOLDER = new Set(['opencode', 'hermes']);

const PROJECT = realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-fence-project-')));
process.on('exit', () => rmSync(PROJECT, { recursive: true, force: true }));
const AGENT = 'fence.coverage';
upsertAgent({ name: AGENT, system_prompt: 'coverage witness — does nothing.', config: { backend: 'codex', cwd: PROJECT, skills: [], memory_scope: 'NONE' } });

/** A launcher that applies nothing and keeps the policy it was handed. */
function recordingFence(): { fence: HostFence; policies: FencePolicy[] } {
  const policies: FencePolicy[] = [];
  return {
    policies,
    fence: {
      mechanism: 'landlock',
      probe: () => ({ available: true, abi: 6 }),
      wrap: (policy, cmd, args) => { policies.push(policy); return { cmd, args: [...args] }; },
      witness: async () => ({ ran: true, status: 0, stderr: '' }),
    },
  };
}

const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const underHome = (path: string): boolean => path !== TIMON_HOME && inside(TIMON_HOME, path);
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOME_PATH = new RegExp(`${escapeRegExp(TIMON_HOME)}(?:[\\\\/][^\\s"',;:=\`)]*)?`, 'g');

/** Where `path` leads, links followed; for a path not made yet, where its nearest existing parent leads. */
function realOf(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(current.slice(parent.length).replace(/^[\\/]/, ''));
      current = parent;
    }
  }
}

type Need = { path: string; write: boolean; why: string };

/** Each link below `root` (its own tree, not where the links lead), as the CLI would follow it. */
function linksBelow(root: string, depth = 4): Array<{ link: string; target: string }> {
  if (depth < 0 || !existsSync(root) || !lstatSync(root).isDirectory()) return [];
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      try { return [{ link: path, target: realpathSync.native(path) }]; } catch { return []; }
    }
    return stat.isDirectory() ? linksBelow(path, depth - 1) : [];
  });
}

/**
 * Every folder and file of the Timon home the launch hands the CLI: the paths its arguments and
 * environment name, the mission's scratch folders the build made, where their links lead, and the
 * shared cache of the plugin that made them. `HOME`-like variables and scratch folders are written to.
 */
function launchNeeds(spec: SpawnResult, missionId: string): Need[] {
  const needs: Need[] = [];
  const add = (path: string, write: boolean, why: string) => {
    const real = realOf(path);
    const same = needs.find((need) => need.path === real);
    if (!same) needs.push({ path: real, write, why });
    else if (write && !same.write) Object.assign(same, { write, why });
  };
  const scan = (text: string, write: boolean, why: string) => {
    for (const match of text.matchAll(HOME_PATH)) if (underHome(match[0])) add(match[0], write, why);
  };
  spec.args.forEach((arg, i) => scan(arg, false, `argument ${i} (${arg.slice(0, 60)})`));
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    for (const part of value.split(delimiter)) scan(part, /(?:^|_)HOME$|^TMPDIR$/.test(key), `env ${key}`);
  }
  if (spec.cwd) scan(spec.cwd, true, 'working directory');
  const runs = join(TIMON_HOME, 'provider-runs');
  for (const plugin of existsSync(runs) ? readdirSync(runs) : []) {
    const scratch = join(runs, plugin, missionId);
    if (!existsSync(scratch)) continue;
    add(scratch, true, `scratch folder of ${plugin}`);
    const cache = join(TIMON_HOME, 'provider-cache', plugin);
    if (existsSync(cache)) add(cache, true, `shared cache of ${plugin}`);
  }
  // A link is followed by the kernel: what counts is where it leads, not the folder it sits in.
  for (const need of [...needs]) {
    for (const { link, target } of linksBelow(need.path)) {
      if (!underHome(target)) continue;
      add(target, need.write && statSync(target).isDirectory(), `${need.why}, link ${relative(TIMON_HOME, link)}`);
    }
  }
  return needs;
}

/**
 * `policy` as checked: without the system folders every program writes to. Both homes of this suite
 * sit in the temporary folder, which is one of them: left in, any path of the user's home that is
 * not refused outright would pass for a grant. The Timon home is refused explicitly, so nothing
 * under it changes.
 */
type Launch = { id: string; missionId: string; spec: SpawnResult; policy: FencePolicy; strict: FencePolicy; needs: Need[] };

/** The launch the daemon makes, in its order: the spec is built first, then the fence around it. */
async function launchOf(id: string): Promise<Launch> {
  const missionId = randomUUID();
  const spec = await buildUnderSeal(id, {
    agentName: AGENT, systemPrompt: 'coverage witness', message: 'ping', resumeSession: null, missionId,
    cfg: { cwd: PROJECT, permission_mode: 'auto', mcp_servers: [] },
  });
  const { fence, policies } = recordingFence();
  fenceMissionCommand(spec.cmd, spec.args, `timon-mission-${missionId.slice(0, 8)}`, {
    cwd: spec.cwd ?? PROJECT, backend: id, timonHome: TIMON_HOME, missionId,
    ...missionFenceTarget({ missionId, agentName: AGENT, project: '', backend: id, cwd: spec.cwd ?? PROJECT, mcpServers: [] }),
  }, { fence, mode: 'auto', nestedSandbox: nestedSandboxOf(id), warn: () => undefined });
  const policy = policies[0];
  assert.ok(policy?.enabled, `${id}: the launch was fenced`);
  const system = systemWritableFolders(process.platform);
  const strict = { ...policy, rw: policy.rw.filter((path) => !system.includes(path)) };
  return { id, missionId, spec, policy, strict, needs: launchNeeds(spec, missionId) };
}

const dialectOf = (id: string): string => activeProfiles().find((entry) => entry.profile.id === id)?.profile.dialect ?? '';
const ACTIVE = activeProfiles()
  .filter((entry) => !entry.account && isProcessDialect(entry.profile.dialect))
  .map((entry) => entry.profile.id);
const launches = new Map<string, Launch>();
// No fence runs missions on Windows yet (`doctor.ts`): there is no policy whose coverage to check.
const NO_FENCE = process.platform === 'win32' && 'missions are not fenced on Windows';

/**
 * Every profile's own folder, made the way a provider makes it: through `ctx.provider.scratch.profile`
 * of the plugin that launches it, before the fence is computed, as `buildSpawn` would. The fence must
 * open each mission's own one, and only it: a hand-made folder would not prove the two agree on where.
 */
const profileFolders = new Map<string, string>();
for (const id of ACTIVE) {
  const pluginId = backendOwnerPlugin(id);
  assert.ok(pluginId, `${id}: no plugin launches it`);
  const services = providerServicesFor({
    pluginId, apiVersion: PROVIDER_PROFILE_SCRATCH_API_VERSION, assertPermission: () => undefined, trusted: true,
    authorizedBinaries: [], authorizedCredentialDirs: [], osCredentials: [], effect: (register) => register(),
  });
  const runtime = activeProfiles().find((entry) => entry.profile.id === id)!;
  profileFolders.set(id, services.scratch.profile({ id: runtime.profile.id, cmd: '', env: {} }).path);
}
if (!NO_FENCE) for (const id of ACTIVE) launches.set(id, await launchOf(id));

test('every profile that must be covered is active and launched', { skip: NO_FENCE }, () => {
  const missing = EXPECTED.filter((id) => !ACTIVE.includes(id));
  assert.deepEqual(missing, [], `inactive, hence not covered: ${missing.join(', ')}`);
  for (const id of ACTIVE) assert.ok(getBackend(id), id);
});

test('the profiles on another plugin\'s dialect, the cases this suite is about, are among them', { skip: NO_FENCE }, () => {
  assert.equal(dialectOf('ollama-cloud'), 'codex', 'Ollama Cloud, a plugin\'s profile on the codex dialect');
  assert.equal(dialectOf('kimi'), 'claude', 'Kimi, a plugin\'s profile on the claude dialect');
});

for (const id of ACTIVE) {
  test(`${id}: every folder of the Timon home its launch names is open to the mission`, { skip: NO_FENCE }, () => {
    const run = launches.get(id)!;
    if (NO_TIMON_FOLDER.has(dialectOf(id))) {
      assert.deepEqual(run.needs, [], `${id}: its launch now names folders of the Timon home, which this suite must check`);
      return;
    }
    assert.ok(run.needs.length > 0, `${id}: the launch names no folder of the Timon home, so this check would prove nothing`);
    const refused = run.needs.flatMap((need) => {
      const access = fenceAccess(run.strict, need.path);
      if (!access.read) return [`${need.path} not readable (${need.why})`];
      if (need.write && !access.write) return [`${need.path} not writable (${need.why})`];
      return [];
    });
    assert.deepEqual(refused, [], `${id}: the fence refuses what the CLI is told to use`);
  });

  test(`${id}: the mission still cannot reach the daemon's secrets or another mission's folders`, { skip: NO_FENCE }, () => {
    const run = launches.get(id)!;
    for (const name of ['daemon-token', 'timon.db', 'secret-key', 'timon.config.json']) {
      const access = fenceAccess(run.strict, join(TIMON_HOME, name));
      assert.equal(access.read, false, `${id}: ${name} readable`);
      assert.equal(access.write, false, `${id}: ${name} writable`);
    }
    const others = [...launches.values()].filter((other) => other.missionId !== run.missionId);
    for (const other of others) {
      for (const need of other.needs) {
        if (!need.path.includes(other.missionId)) continue;
        assert.equal(fenceAccess(run.strict, need.path).read, false, `${id}: reads ${other.id}'s ${need.path}`);
      }
      assert.equal(fenceAccess(run.strict, join(TIMON_HOME, 'tmp', 'missions', other.missionId)).read, false, `${id}: reads ${other.id}'s TMPDIR`);
    }
  });

  // Seatbelt matches the profile text, not `fenceAccess`: the rendering must agree on these paths.
  test(`${id}: the Seatbelt rendering of the policy opens the same folders`, { skip: NO_FENCE }, () => {
    const run = launches.get(id)!;
    const rules = rulesOf(renderSeatbeltProfile(run.policy, { spellings: (path) => canonicalPaths(path, (p) => realpathSync.native(p)) }).text);
    const refused = run.needs.flatMap((need) => {
      const access = evaluate(rules, need.path);
      if (!access.read) return [`${need.path} not readable (${need.why})`];
      if (need.write && !access.write) return [`${need.path} not writable (${need.why})`];
      return [];
    });
    assert.deepEqual(refused, [], `${id}: the Seatbelt profile refuses what the CLI is told to use`);
    assert.equal(evaluate(rules, join(TIMON_HOME, 'daemon-token')).read, false, `${id}: daemon-token readable under Seatbelt`);
  });
}

/**
 * A provider keeps one folder per profile it launches (`ctx.provider.scratch.profile`): its CLI's
 * sessions and settings, which another profile's mission must neither read nor plant a hook in.
 */
for (const id of ACTIVE) {
  test(`${id}: the mission reaches its own profile folder, no other profile's`, { skip: NO_FENCE }, () => {
    const run = launches.get(id)!;
    const own = profileFolders.get(id)!;
    const rules = rulesOf(renderSeatbeltProfile(run.policy, { spellings: (path) => canonicalPaths(path, (p) => realpathSync.native(p)) }).text);
    for (const [name, access] of [['fenceAccess', fenceAccess(run.strict, join(own, 'projects', 's.jsonl'))], ['Seatbelt', evaluate(rules, join(own, 'projects', 's.jsonl'))]] as const) {
      assert.ok(access.read && access.write, `${id}: its own folder ${own} is refused (${name})`);
    }
    // Every other profile's folder, and one not made yet, where a planted settings file would wait for it.
    const others = [...profileFolders].filter(([other]) => other !== id).map(([, folder]) => folder);
    for (const folder of [...others, join(dirname(own), 'not-made-yet')]) {
      const path = join(folder, 'settings.json');
      for (const [name, access] of [['fenceAccess', fenceAccess(run.strict, path)], ['Seatbelt', evaluate(rules, path)]] as const) {
        assert.equal(access.read, false, `${id}: reads ${path} (${name})`);
        assert.equal(access.write, false, `${id}: writes ${path} (${name})`);
      }
    }
    if (id !== 'claude') {
      assert.equal(fenceAccess(run.strict, join(USER_HOME, '.claude', '.credentials.json')).read, false, `${id}: reads the user's Claude sign-in`);
    }
  });
}

/**
 * The claude CLI keeps its sessions, debug logs and settings in its config folder: the one
 * `CLAUDE_CONFIG_DIR` names, else `~/.claude`, which holds the user's own Claude sign-in and stays
 * refused to any other backend. A profile on the claude dialect without an account of its own is
 * given its profile folder instead (TODO #1104), which its CLI must be able to write.
 */
const CLAUDE_DIALECT = ACTIVE.filter((id) => dialectOf(id) === 'claude');
for (const id of CLAUDE_DIALECT) {
  test(`${id}: the claude CLI can write its config folder, and never the user's sign-in of another backend`, { skip: NO_FENCE }, () => {
    const run = launches.get(id)!;
    const configDir = run.spec.env?.CLAUDE_CONFIG_DIR ?? join(USER_HOME, '.claude');
    if (id !== 'claude') assert.equal(configDir, profileFolders.get(id), `${id}: the CLI is not told to use its profile folder`);
    const access = fenceAccess(run.strict, join(configDir, 'debug', 'latest'));
    assert.ok(access.read && access.write, `${id}: ${configDir} is refused to the claude CLI`);
    if (id !== 'claude') assert.equal(fenceAccess(run.strict, join(USER_HOME, '.claude', '.credentials.json')).read, false, `${id}: reads the user's Claude sign-in`);
  });
}

/* ── Seatbelt, read back: `(allow default)`, then the last matching rule wins (as `host/seatbelt.test.ts`). ── */

type Rule = { allow: boolean; ops: string[]; path: string };
const RULE = /^\((allow|deny) ([a-z*\- ]+?) \(subpath "((?:[^"\\]|\\.)*)"\)\)$/;

function unquote(literal: string): string {
  return literal.replace(/\\(.)/g, (_, c: string) => ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[c] ?? c);
}

function rulesOf(text: string): Rule[] {
  return text.split('\n').flatMap((line) => {
    const match = RULE.exec(line);
    return match ? [{ allow: match[1] === 'allow', ops: (match[2] ?? '').split(' '), path: unquote(match[3] ?? '') }] : [];
  });
}

const under = (root: string, path: string) => root === '/' || path === root || path.startsWith(`${root}/`);

function evaluate(rules: readonly Rule[], path: string): { read: boolean; write: boolean } {
  const decide = (op: string) => rules.reduce((allowed, rule) => (rule.ops.includes(op) && under(rule.path, path) ? rule.allow : allowed), true);
  return { read: decide('file-read-data'), write: decide('file-write*') };
}
