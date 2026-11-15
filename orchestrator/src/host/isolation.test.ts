/**
 * Mission filesystem isolation (audit finding #4).
 *
 * Two things are tested, and the second one matters more than the first:
 *
 *  1. the directives actually rendered on a launcher that accepts them — the
 *     long `--property=K=V` form, the sensitive paths, and nothing else;
 *  2. the guards that keep the policy from becoming an outage: never mask the
 *     mission's own directory, its backend's credentials, or TIMON_HOME. No
 *     typecheck sees a systemd path list; only these assertions do.
 *
 * And the regression that would hurt the most: the `--scope` line must stay
 * byte-for-byte what it was. A masking directive there is refused by systemd
 * ("Unknown assignment"), `probeWrapper()` marks the whole wrapper unusable,
 * and every mission then launches with no MemoryMax, no nice, no ionice.
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const HOME = mkdtempSync(join(tmpdir(), 'timon-isolation-test-'));
process.env.TIMON_HOME = HOME;

const { TimonConfigSchema } = await import('../config/schema.js');
const {
  isolationArgsFor, isolationProperties, resolveIsolation, sandboxSupported,
  setDeclaredCredentialDirsSource, PROTECTED_HOME_DIRS,
  BACKEND_HOME_DIRS, MISSION_TIMON_ZONES, isRefusedTimonEntry, timonRefusedPaths,
} = await import('./isolation.js');

const FAKE_HOME = '/home/tester';

/**
 * The "never" list of the fence framing (§1), copied here on purpose instead of
 * read from `MISSION_TIMON_ZONES.refused`: a test looping over the list it checks
 * passes whatever is removed from it. A `*` of the framing is spelled as the
 * names it must catch, the copies included.
 */
const FRAMING_REFUSED: readonly string[] = [
  'daemon-token',
  'secret-key', 'secret-key.next', 'secret-key.location', 'secret-key.old',
  'plugin-token-key', 'setup-token', 'update-token', 'remote-key', 'remote.db', 'secrets.env',
  'license.jwt', 'license.key', 'license.state.json', 'license.enrollment-secret', 'license.state.json.tmp-7',
  'device-id', 'install-id', 'partner-leads.json', 'partner-leads.json.tmp-7', 'cli-daemons.json',
  'timon.db', 'timon.db-wal', 'timon.db-shm', 'timon.db-journal',
  'integrations.db', 'integrations.db-wal', 'integrations.db-shm',
  'timon.config.json', 'timon.config.json.bak-20261025',
  'plugins-data', 'browser-profiles', 'browser-native', 'desktop-profile', 'mcp', 'run', 'backups', 'archive',
];
const cfg = (isolation: Record<string, unknown> = {}) =>
  TimonConfigSchema.parse({ host: { isolation } });

test('the rendered directives mask the credential paths, in the long property form', () => {
  const args = isolationArgsFor('service', cfg(), { home: FAKE_HOME, backend: 'claude' });
  const masking = args.filter((a) => a.startsWith('--property=InaccessiblePaths='));
  assert.equal(masking.length, 1, 'exactly one InaccessiblePaths directive');
  // Short form `-p=K=V` is rejected by systemd-run and breaks the spawn.
  for (const a of args) assert.match(a, /^--property=/);
  const paths = masking[0]!.slice('--property=InaccessiblePaths='.length).split(' ');
  // public-name-ok: the archive's home is part of the masked list
  for (const expected of ['.ssh', '.gnupg', '.aws', '.pkos', '.codex', '.grok']) {
    assert.ok(
      paths.includes(`${FAKE_HOME}/${expected}`),
      `${expected} must be masked, got ${paths.join(' ')}`,
    );
  }
});

test('the backend actually in use keeps its credentials, the others do not', () => {
  for (const [backend, dirs] of Object.entries(BACKEND_HOME_DIRS)) {
    const { deny } = resolveIsolation(cfg(), { home: FAKE_HOME, backend });
    for (const dir of dirs) {
      assert.ok(!deny.includes(`${FAKE_HOME}/${dir}`), `${backend} must keep ~/${dir}`);
    }
    // A neighbour backend's directory is still masked: a codex mission has no
    // business reading the claude subscription.
    const other = backend === 'claude' ? '.codex' : '.claude';
    assert.ok(deny.includes(`${FAKE_HOME}/${other}`), `${backend} must not see ~/${other}`);
  }
});

test('a mission cwd living under a masked path is never masked away', () => {
  // Worktrees under a folder the default list masks: masking the ancestor
  // would hide the mission's own repository.
  const { deny } = resolveIsolation(cfg(), {
    home: FAKE_HOME,
    backend: 'claude',
    cwd: `${FAKE_HOME}/.pkos/worktrees/abcd`, // public-name-ok: a masked folder
  });
  assert.ok(!deny.includes(`${FAKE_HOME}/.pkos`), 'an ancestor of the cwd must be spared'); // public-name-ok: a masked folder
  assert.ok(deny.includes(`${FAKE_HOME}/.ssh`), 'the rest of the list still applies');
});

test('TIMON_HOME and its ancestors are never masked, the private files in it always are', () => {
  const timonHome = `${FAKE_HOME}/state/timon`;
  const { deny } = resolveIsolation(cfg({ deny: ['~/state'] }), { home: FAKE_HOME, timonHome });
  assert.ok(!deny.includes(`${FAKE_HOME}/state`) && !deny.includes(timonHome), 'the folders themselves stay visible');
  // Guard 3 no longer spares what lives inside: every entry of the framing is masked.
  const withCopies = resolveIsolation(cfg(), { home: FAKE_HOME, timonHome, timonHomeEntries: FRAMING_REFUSED });
  for (const name of FRAMING_REFUSED) {
    assert.ok(withCopies.deny.includes(`${timonHome}/${name}`), `${name} must be masked`);
  }
  assert.deepEqual(
    deny.filter((p) => p.startsWith(`${FAKE_HOME}/state`)).sort(),
    MISSION_TIMON_ZONES.refused.map((name) => `${timonHome}/${name}`).sort(),
    'nothing else under the Timon home is masked by this launcher',
  );
});

test('the masking launcher masks the copies of a private file, listed or read from the folder', () => {
  const timonHome = `${FAKE_HOME}/.timon`;
  const listed = resolveIsolation(cfg(), {
    home: FAKE_HOME, timonHome, timonHomeEntries: ['timon.config.json.bak-20261025', 'license.state.json.tmp-7', 'skills'],
  });
  assert.ok(listed.deny.includes(`${timonHome}/timon.config.json.bak-20261025`));
  assert.ok(listed.deny.includes(`${timonHome}/license.state.json.tmp-7`));
  assert.ok(!listed.deny.includes(`${timonHome}/skills`));

  // Without a list, the folder itself is read.
  const real = mkdtempSync(join(tmpdir(), 'timon-isolation-home-'));
  writeFileSync(join(real, 'timon.config.json.bak-pre-x'), '{}');
  writeFileSync(join(real, 'notes.md'), '');
  const read = resolveIsolation(cfg(), { home: FAKE_HOME, timonHome: real });
  assert.ok(read.deny.includes(join(real, 'timon.config.json.bak-pre-x')));
  assert.ok(!read.deny.includes(join(real, 'notes.md')));
});

test('neither the cwd nor allow reopens a private file of the Timon home', () => {
  const timonHome = `${FAKE_HOME}/.timon`;
  const { deny, readOnly } = resolveIsolation(
    cfg({ allow: ['~/.timon', '~/.timon/daemon-token'], readOnly: ['~/.timon/secret-key'] }),
    { home: FAKE_HOME, timonHome, cwd: `${timonHome}/backups/x` },
  );
  for (const name of ['daemon-token', 'secret-key', 'timon.db', 'timon.config.json', 'backups']) {
    assert.ok(deny.includes(`${timonHome}/${name}`), `${name} must stay masked`);
  }
  assert.ok(!readOnly.includes(`${timonHome}/secret-key`), 'a masked path is not also listed read-only');
});

test('the refused entries of the Timon home include the copies a prefix catches', () => {
  const paths = timonRefusedPaths('/t', ['timon.config.json.bak-20261025', 'license.state.json.tmp-42', 'skills', 'timon.db-journal']);
  for (const name of ['daemon-token', 'timon.config.json.bak-20261025', 'license.state.json.tmp-42', 'timon.db-journal']) {
    assert.ok(paths.includes(join('/t', name)), `${name} must be refused`);
  }
  assert.ok(!paths.includes(join('/t', 'skills')));
  for (const name of [...MISSION_TIMON_ZONES.writable, ...MISSION_TIMON_ZONES.readable]) {
    assert.equal(isRefusedTimonEntry(name), false, `${name} cannot be both granted and refused`);
  }
});

test('allow wins over the built-in list, deny and readOnly extend it', () => {
  const policy = resolveIsolation(
    cfg({ allow: ['~/.ssh'], deny: ['~/secrets'], readOnly: ['/etc'] }),
    { home: FAKE_HOME },
  );
  assert.ok(!policy.deny.includes(`${FAKE_HOME}/.ssh`), 'allow must win');
  assert.ok(policy.deny.includes(`${FAKE_HOME}/secrets`));
  assert.deepEqual(policy.readOnly, ['/etc']);
  assert.ok(
    isolationProperties(policy).includes('--property=ReadOnlyPaths=/etc'),
    'readOnly must render its own directive',
  );
});

test('a path holding a space is quoted, or systemd reads two paths', () => {
  const rendered = isolationProperties({
    deny: ['/home/t/my keys'], readOnly: [], enabled: true,
  });
  assert.deepEqual(rendered, ['--property=InaccessiblePaths="/home/t/my keys"']);
});

test('filesystem: off masks nothing at all', () => {
  const policy = resolveIsolation(cfg({ filesystem: 'off' }), { home: FAKE_HOME });
  assert.equal(policy.enabled, false);
  assert.deepEqual(isolationProperties(policy), []);
  assert.deepEqual(isolationArgsFor('service', cfg({ filesystem: 'off' }), { home: FAKE_HOME }), []);
});

test('a scope carries NO masking directive, whatever the policy says', () => {
  // Hard invariant: systemd answers "Unknown assignment" to Exec* directives
  // on a scope, `probeWrapper()` then disables the whole wrapper and missions
  // lose their memory cap. Never trade the resource guard for an inert sandbox.
  assert.equal(sandboxSupported('scope'), false);
  assert.deepEqual(
    isolationArgsFor('scope', cfg({ deny: ['~/anything'] }), { home: FAKE_HOME }),
    [],
  );
});

test('the mission wrapper line is unchanged by the isolation wiring', async () => {
  const { wrapMissionLaunch } = await import('../resources.js');
  const { cmd, args } = wrapMissionLaunch('claude', ['--x'], 'aaaaaaaa-0000-4000-8000-000000000000', {
    cwd: '/tmp', backend: 'claude', home: FAKE_HOME,
  });
  if (cmd !== 'systemd-run') return; // no systemd here (CI): nothing to check
  assert.deepEqual(
    args.filter((a) => /InaccessiblePaths|ReadOnlyPaths|ProtectHome/.test(a)),
    [],
    'no masking directive may reach the scope launcher',
  );
});

test('a folder a plugin declared for the running backend is spared, but never one of the user\'s credentials', () => {
  try {
    setDeclaredCredentialDirsSource(() => ({ acme: ['.acme', '.config/acme'] }));
    const ok = resolveIsolation(cfg(), { home: FAKE_HOME, backend: 'acme' });
    assert.ok(!ok.deny.includes(`${FAKE_HOME}/.acme`) && !ok.deny.includes(`${FAKE_HOME}/.config/acme`), 'its own folders are spared');
    assert.ok(ok.deny.includes(`${FAKE_HOME}/.ssh`));
    // Another backend's mission does not see them.
    assert.ok(resolveIsolation(cfg(), { home: FAKE_HOME, backend: 'claude' }).deny.includes(`${FAKE_HOME}/.acme`));

    // A declaration that got past registration still cannot open the user's keys, nor a parent of them.
    // public-name-ok: the archive's home is protected like the keys
    for (const hostile of ['.ssh', '.aws', '.gnupg', '.config', '.config/gcloud', '.pkos', '.claude', '.codex']) {
      setDeclaredCredentialDirsSource(() => ({ acme: [hostile] }));
      const { deny } = resolveIsolation(cfg(), { home: FAKE_HOME, backend: 'acme' });
      for (const protectedDir of ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.pkos', '.claude', '.codex']) { // public-name-ok: as above
        assert.ok(deny.includes(`${FAKE_HOME}/${protectedDir}`), `declaring ${hostile} must not unmask ~/${protectedDir}`);
      }
    }
    // The running backend's own built-in folder is still spared by the built-in table, not by the declaration.
    setDeclaredCredentialDirsSource(() => ({ claude: ['.claude'] }));
    assert.ok(!resolveIsolation(cfg(), { home: FAKE_HOME, backend: 'claude' }).deny.includes(`${FAKE_HOME}/.claude`));
    assert.ok(PROTECTED_HOME_DIRS.includes('.ssh') && PROTECTED_HOME_DIRS.includes('.config/gcloud'));
  } finally {
    setDeclaredCredentialDirsSource(() => ({}));
  }
});

test('the fence settings default to auto, no extra writable path, Unix sockets denied', () => {
  const iso = cfg().host.isolation;
  assert.equal(iso.filesystem, 'auto');
  assert.deepEqual(iso.writable, []);
  assert.equal(iso.unixSockets, 'deny');
  assert.deepEqual(iso.exceptions, { agents: {}, projects: {} });
  assert.equal(cfg({ filesystem: 'enforce' }).host.isolation.filesystem, 'enforce');
  const parsed = cfg({ exceptions: { agents: { 'timon.coder': { unixSockets: 'allow' } } } }).host.isolation;
  assert.deepEqual(parsed.exceptions.agents['timon.coder'], { unixSockets: 'allow', writable: [] });
});

test('an invalid fence setting is refused, not silently defaulted', () => {
  const invalid: Array<Record<string, unknown>> = [
    { filesystem: 'strict' },
    { filesystem: true },
    { unixSockets: 'maybe' },
    { writable: ['relative/path'] },
    { writable: '~/.cache' },
    { exceptions: { agents: { coder: { unixSockets: 'yes' } } } },
    { exceptions: { projects: { app: { writable: ['./build'] } } } },
    // A misspelt key is refused rather than dropped: the fence would differ from what was written.
    { unixSocket: 'allow' },
    { writeable: ['~/.cache'] },
    { exceptions: { agent: { coder: { unixSockets: 'allow' } } } },
    { exceptions: { agents: { coder: { writeable: ['~/.cache'] } } } },
    { egress: { mode: 'log', prot: 8080 } },
  ];
  for (const isolation of invalid) {
    assert.equal(
      TimonConfigSchema.safeParse({ host: { isolation } }).success,
      false,
      `${JSON.stringify(isolation)} must be refused`,
    );
  }
});

/* ── The fence (`resolveFence`, `fenceAccess`) ─────────────────────────────── */

const { resolveFence, fenceAccess } = await import('./isolation.js');

const TH = `${FAKE_HOME}/.timon`;
const MISSION = 'aaaaaaaa-0000-4000-8000-000000000001';
const fullTarget = (over: Record<string, unknown> = {}) => ({
  timonHome: TH,
  home: FAKE_HOME,
  platform: 'linux' as const,
  backend: 'claude',
  cwd: `${TH}/worktrees/task-1`,
  gitDirs: [`${FAKE_HOME}/code/app/.git`],
  missionId: MISSION,
  agent: 'timon.coder',
  project: 'app',
  account: 'acc-mine',
  providerPlugin: 'provider-codex',
  pluginDirs: [`${TH}/plugins/node_modules/acme-mcp`],
  timonRead: [`${TH}/uploads/chat/conv-1`],
  timonHomeEntries: ['timon.config.json.bak-20261025', 'license.state.json.tmp-7', 'skills'],
  // The fake home does not exist: paths resolve to themselves. Links are tested on a real folder.
  realpath: (path: string) => path,
  ...over,
});
const access = (policy: ReturnType<typeof resolveFence>, path: string) => {
  const { read, write, exec } = fenceAccess(policy, path);
  return write ? 'rw' : read ? (exec ? 'rx' : 'r') : 'none';
};

test('fence: a read-only workspace keeps the working tree and its git directories readable only', () => {
  const writing = resolveFence(cfg(), fullTarget());
  const reading = resolveFence(cfg(), fullTarget({ workspace: 'ro' }));
  for (const path of [`${TH}/worktrees/task-1/src/a.ts`, `${FAKE_HOME}/code/app/.git/objects/x`]) {
    assert.equal(access(writing, path), 'rw', path);
    assert.equal(access(reading, path), 'rx', path);
  }
  // The CLI's own state is not the workspace: it stays writable.
  for (const path of [`${TH}/tmp/missions/${MISSION}/f`, `${TH}/backend-accounts/acc-mine/x`, '/tmp/x']) {
    assert.equal(access(reading, path), 'rw', path);
  }
});

test('fence: no private entry of the Timon home is reachable, copies included', () => {
  const policy = resolveFence(cfg(), fullTarget());
  assert.equal(policy.enabled, true);
  for (const name of FRAMING_REFUSED) {
    assert.equal(access(policy, `${TH}/${name}`), 'none', `${name} must be out of the projection`);
    assert.equal(access(policy, `${TH}/${name}/inner`), 'none', `${name}/… must be out of the projection`);
  }
  for (const name of ['timon.config.json.bak-20261025', 'license.state.json.tmp-7', 'daemon-token']) {
    assert.ok(policy.denyUnderTimonHome.includes(`${TH}/${name}`), `${name} is named for masking renderers`);
  }
  // Named for the masking renderers once listed, and no handed-over path reopens one.
  const listed = resolveFence(cfg(), fullTarget({ timonHomeEntries: FRAMING_REFUSED }));
  for (const name of FRAMING_REFUSED) {
    assert.ok(listed.denyUnderTimonHome.includes(`${TH}/${name}`), `${name} is named for masking renderers`);
    const path = `${TH}/${name}`;
    const handed = resolveFence(cfg(), fullTarget({ cwd: path, gitDirs: [path], timonRead: [path], pluginDirs: [path] }));
    assert.equal(handed.ignored.filter((i) => i.path === path).length, 4, `${name} must be dropped from every grant`);
    assert.equal(access(handed, path), 'none', `${name} must stay out of the projection`);
  }
  // The home itself cannot be listed, and what nobody listed is refused by default.
  assert.equal(access(policy, TH), 'none');
  assert.equal(access(policy, `${TH}/a-file-added-tomorrow`), 'none');
  assert.equal(access(policy, `${TH}/plugins/node_modules/other-plugin/index.js`), 'none');
  assert.equal(access(policy, `${TH}/agents/timon.main/system-prompt.md`), 'none', 'another agent');
  assert.equal(access(policy, `${TH}/worktrees/task-2/src/a.ts`), 'none', 'another mission\'s worktree');
  assert.equal(access(policy, `${TH}/tmp/missions/other/x`), 'none', 'another mission\'s TMPDIR');
});

test('fence: the mission writes its worktree, its repository, its TMPDIR and its scratch folders', () => {
  const policy = resolveFence(cfg(), fullTarget());
  assert.equal(access(policy, `${TH}/worktrees/task-1/src/a.ts`), 'rw');
  assert.equal(fenceAccess(policy, `${TH}/worktrees/task-1/node_modules/.bin/tsc`).exec, true);
  assert.equal(access(policy, `${FAKE_HOME}/code/app/.git/objects/ab`), 'rw');
  assert.equal(access(policy, `${TH}/tmp/missions/${MISSION}/x`), 'rw');
  assert.equal(access(policy, `${TH}/provider-runs/provider-codex/${MISSION}/config.toml`), 'rw');
  assert.equal(access(policy, `${TH}/provider-runs/provider-codex/other/config.toml`), 'none');
  assert.equal(access(policy, `${TH}/provider-cache/provider-codex/cache`), 'rw');
  assert.equal(access(policy, `${TH}/codex-runs/${MISSION}`), 'rw');
  assert.equal(access(policy, '/tmp/x'), 'rw');
  assert.equal(access(policy, '/dev/null'), 'rw');
});

test('fence: the agent\'s package cache is writable and executable, nothing above it nor beside it', () => {
  const policy = resolveFence(cfg(), fullTarget());
  const own = `${TH}/provider-cache/.agents/timon.coder`;
  assert.equal(access(policy, `${own}/npm/_cacache/index-v5/ab`), 'rw');
  assert.equal(fenceAccess(policy, `${own}/npm/_npx/0f3a/node_modules/.bin/server`).exec, true, 'npx runs what it installed');
  assert.equal(policy.rw.filter((p) => p.startsWith(`${TH}/provider-cache/.agents`)).length, 1, 'one grant, the agent\'s folder');
  for (const above of [`${TH}/provider-cache/.agents`, `${TH}/provider-cache`, `${TH}/provider-cache/.agents/x`]) {
    assert.equal(access(policy, above), 'none', `${above} lists other agents' caches`);
  }
  assert.equal(access(policy, `${TH}/provider-cache/.agents/timon.main/npm/_npx/x`), 'none', 'another agent\'s cache');
  // A mission of another agent, on the same provider, does not reach it.
  const other = resolveFence(cfg(), fullTarget({ agent: 'timon.main', missionId: 'bbbbbbbb-0000-4000-8000-000000000002' }));
  assert.equal(access(other, `${own}/npm/_npx/x`), 'none');
  assert.equal(access(other, `${TH}/provider-cache/.agents/timon.main/npm/x`), 'rw');
  // No agent, no cache; a name that is not a plain folder name, no cache either.
  assert.ok(!resolveFence(cfg(), fullTarget({ agent: undefined })).rw.some((p) => p.includes('/.agents')));
  const odd = resolveFence(cfg(), fullTarget({ agent: '../timon.main' }));
  assert.ok(!odd.rw.some((p) => p.includes('/.agents')));
  assert.ok(odd.ignored.some((i) => i.path === '../timon.main'));
});

test('fence: no provider plugin id reaches the agents\' caches, nor does a handed-over path', () => {
  // A provider plugin id starts with a letter or a digit: `.agents` is never one.
  const plugin = resolveFence(cfg(), fullTarget({ providerPlugin: '.agents' }));
  assert.equal(access(plugin, `${TH}/provider-cache/.agents/timon.main/npm/x`), 'none');
  assert.ok(plugin.ignored.some((i) => i.path === '.agents'));
  for (const path of [`${TH}/provider-cache/.agents`, `${TH}/provider-cache/.agents/timon.main`]) {
    const handed = resolveFence(cfg(), fullTarget({ cwd: path, gitDirs: [path] }));
    assert.equal(handed.ignored.filter((i) => i.path === path).length, 2, `${path} must be dropped twice`);
  }
});

test('fence: the mission\'s own account is writable, every other account is refused', () => {
  const policy = resolveFence(cfg(), fullTarget());
  assert.equal(access(policy, `${TH}/backend-accounts/acc-mine/.credentials.json`), 'rw');
  assert.equal(access(policy, `${TH}/backend-accounts/acc-other/.credentials.json`), 'none');
  assert.equal(access(policy, `${TH}/backend-accounts/.login/acc-x`), 'none');
  assert.equal(access(policy, `${TH}/backend-accounts`), 'none', 'the accounts cannot be listed');
});

test('fence: identity docs, skills, project memory and attachments are read-only, the own memory writable', () => {
  const policy = resolveFence(cfg(), fullTarget());
  assert.equal(access(policy, `${TH}/agents/timon.coder/SOUL.md`), 'r', 'readable, not executable');
  assert.equal(access(policy, `${TH}/agents/timon.coder/config.json`), 'r');
  assert.equal(access(policy, `${TH}/agents/timon.coder/memory/learnings.jsonl`), 'rw');
  assert.equal(access(policy, `${TH}/agents/timon.coder/missions/${MISSION}/memory/x`), 'rw');
  assert.equal(access(policy, `${TH}/skills/timon-task/SKILL.md`), 'r');
  assert.equal(access(policy, `${TH}/projects/app/memory/decisions.md`), 'r');
  assert.equal(access(policy, `${TH}/projects/app/roles.json`), 'none');
  assert.equal(access(policy, `${TH}/uploads/projects/app/shot.png`), 'r');
  assert.equal(access(policy, `${TH}/uploads/chat/conv-1/a.png`), 'r');
  assert.equal(access(policy, `${TH}/uploads/chat/conv-2/a.png`), 'none');
  assert.equal(access(policy, `${TH}/plugins/node_modules/acme-mcp/server.js`), 'rx', 'a declared MCP server runs');
});

test('fence: the user\'s home is read-only, credentials and other backends are refused', () => {
  const policy = resolveFence(cfg(), fullTarget());
  assert.equal(access(policy, `${FAKE_HOME}/.gitconfig`), 'rx', 'readable, never writable');
  assert.equal(access(policy, `${FAKE_HOME}/.local/bin/git`), 'rx');
  assert.equal(access(policy, '/usr/bin/git'), 'rx');
  for (const dir of ['.ssh', '.gnupg', '.aws', '.codex', '.grok']) {
    assert.equal(access(policy, `${FAKE_HOME}/${dir}/x`), 'none', `~/${dir} must be refused`);
  }
  // With an account the host's own sign-in stays read-only; without one it is the mission's state.
  assert.equal(access(policy, `${FAKE_HOME}/.claude/settings.json`), 'rx');
  const hostLogin = resolveFence(cfg(), fullTarget({ account: undefined }));
  assert.equal(access(hostLogin, `${FAKE_HOME}/.claude/settings.json`), 'rw');
  assert.equal(access(hostLogin, `${FAKE_HOME}/.gitconfig`), 'rx');
});

test('fence: a Timon home under a writable system folder stays refused', () => {
  const policy = resolveFence(cfg(), fullTarget({ timonHome: '/tmp/timon-x', cwd: '/tmp/timon-x/worktrees/t' }));
  assert.equal(access(policy, '/tmp/other'), 'rw');
  assert.equal(access(policy, '/tmp/timon-x/daemon-token'), 'none');
  assert.equal(access(policy, '/tmp/timon-x/worktrees/t/a'), 'rw');
});

test('fence: no grant lands on the Timon home, on a refused entry or outside the mission zones', () => {
  const policy = resolveFence(
    cfg({ writable: ['~/.timon', '~/.timon/plugins', '~/.cache'], allow: ['~/.timon/daemon-token'], readOnly: ['~/.timon/worktrees'] }),
    fullTarget({
      cwd: `${TH}/backups/x`,
      gitDirs: [TH],
      timonRead: [`${TH}/daemon-token`, `${TH}/worktrees/task-2`, `${TH}/timon.db`],
      pluginDirs: [`${TH}/plugins`, `${TH}/plugins-data/acme`, `${FAKE_HOME}/elsewhere`],
      agent: '../timon.main',
      account: 'acc/../../daemon-token',
    }),
  );
  for (const path of [
    TH, `${TH}/plugins/x`, `${TH}/daemon-token`, `${TH}/worktrees/task-2/a`, `${TH}/backups/x/y`,
    `${TH}/timon.db`, `${TH}/plugins-data/acme/a`, `${TH}/agents/timon.main/SOUL.md`,
  ]) {
    assert.equal(access(policy, path), 'none', `${path} must stay refused`);
  }
  assert.equal(fenceAccess(policy, `${TH}/plugins/node_modules/x`).write, false);
  assert.equal(access(policy, `${FAKE_HOME}/.cache/npm/x`), 'rw', 'a writable path outside the Timon home is honoured');
  const dropped = policy.ignored.map((i) => i.path);
  for (const path of [`${TH}`, `${TH}/plugins`, `${TH}/daemon-token`, `${TH}/backups/x`, `${TH}/worktrees`, '../timon.main']) {
    assert.ok(dropped.includes(path), `${path} must be reported as ignored`);
  }
});

test('fence: a working directory in the home reopens only itself', () => {
  const policy = resolveFence(cfg(), fullTarget({ cwd: `${FAKE_HOME}/.ssh/work` }));
  assert.equal(access(policy, `${FAKE_HOME}/.ssh/work/a`), 'rw');
  assert.equal(access(policy, `${FAKE_HOME}/.ssh/id_ed25519`), 'none');
  const atHome = resolveFence(cfg(), fullTarget({ cwd: FAKE_HOME }));
  assert.equal(access(atHome, `${FAKE_HOME}/notes.md`), 'rw');
  assert.equal(access(atHome, `${TH}/daemon-token`), 'none', 'the Timon home stays carved out');
  assert.equal(access(atHome, `${FAKE_HOME}/.ssh/id_ed25519`), 'none');
});

test('fence: readOnly beats a writable grant on the same path, allow reopens a credential folder', () => {
  const policy = resolveFence(
    cfg({ readOnly: [`${TH}/worktrees/task-1`, `${FAKE_HOME}/code/app/.git`], allow: ['~/.ssh'] }),
    fullTarget(),
  );
  assert.equal(access(policy, `${FAKE_HOME}/code/app/.git/HEAD`), 'rx');
  assert.equal(access(policy, `${TH}/worktrees/task-1/a`), 'rw', 'readOnly cannot reach into the Timon home');
  assert.equal(access(policy, `${FAKE_HOME}/.ssh/config`), 'rx');
});

test('fence: Unix sockets are denied by default, an exception relaxes them per project then per agent', () => {
  assert.equal(resolveFence(cfg(), fullTarget()).unixSockets, 'deny');
  const iso = {
    unixSockets: 'deny',
    writable: ['~/.cache'],
    exceptions: {
      projects: { app: { unixSockets: 'allow', writable: ['~/.docker'] } },
      agents: { 'timon.coder': { unixSockets: 'deny', writable: ['~/.npm'] }, 'timon.ops': { unixSockets: 'allow' } },
    },
  };
  const coder = resolveFence(cfg(iso), fullTarget());
  assert.equal(coder.unixSockets, 'deny', 'the agent wins over the project');
  for (const dir of ['.cache', '.docker', '.npm']) assert.equal(access(coder, `${FAKE_HOME}/${dir}/x`), 'rw');
  assert.equal(resolveFence(cfg(iso), fullTarget({ agent: 'timon.reviewer' })).unixSockets, 'allow', 'the project applies');
  assert.equal(resolveFence(cfg(iso), fullTarget({ agent: 'timon.ops', project: 'other' })).unixSockets, 'allow');
  assert.equal(resolveFence(cfg(iso), fullTarget({ agent: '__proto__', project: 'constructor' })).unixSockets, 'deny');
});

test('fence: off confines nothing, enforce resolves the same projection as auto', () => {
  const off = resolveFence(cfg({ filesystem: 'off' }), fullTarget());
  assert.equal(off.enabled, false);
  assert.deepEqual([off.ro, off.rw, off.deny], [[], [], []]);
  const auto = resolveFence(cfg(), fullTarget());
  const enforce = resolveFence(cfg({ filesystem: 'enforce' }), fullTarget());
  assert.equal(enforce.mode, 'enforce');
  assert.deepEqual({ ...enforce, mode: 'auto' }, auto);
});

test('fence: macOS writes go to the resolved temporary folders', () => {
  const policy = resolveFence(cfg(), fullTarget({ platform: 'darwin', home: '/Users/tester', timonHome: '/Users/tester/.timon', cwd: '/Users/tester/code/app', gitDirs: [] }));
  assert.equal(access(policy, '/private/var/folders/xy/T/tmp.1'), 'rw');
  assert.equal(access(policy, '/private/tmp/x'), 'rw');
  assert.equal(access(policy, '/Users/tester/.zshrc'), 'rx');
  assert.equal(access(policy, '/Users/tester/.timon/daemon-token'), 'none');
});

test('fence: a handed-over path never opens a whole zone of the Timon home', () => {
  // The four measured exposures: each zone root handed over as it is.
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ cwd: `${TH}/backend-accounts` }, `${TH}/backend-accounts/acc-other/.credentials.json`],
    [{ cwd: `${TH}/tmp` }, `${TH}/tmp/missions/other/x`],
    [{ cwd: `${TH}/worktrees` }, `${TH}/worktrees/task-2/src/a.ts`],
    [{ timonRead: [`${TH}/agents`] }, `${TH}/agents/timon.main/memory/learnings.jsonl`],
  ];
  for (const [over, victim] of cases) {
    const policy = resolveFence(cfg(), fullTarget(over));
    assert.equal(access(policy, victim), 'none', `${JSON.stringify(over)} must not reach ${victim}`);
  }
  // Every zone root, handed over as a working directory (writable zones) or a file (readable zones).
  for (const zone of MISSION_TIMON_ZONES.writable) {
    const policy = resolveFence(cfg(), fullTarget({ cwd: `${TH}/${zone}` }));
    assert.ok(policy.ignored.some((i) => i.path === `${TH}/${zone}`), `cwd ${zone} must be dropped`);
    assert.equal(access(policy, `${TH}/${zone}/someone-else/x`), 'none', `${zone}/… must stay refused`);
  }
  for (const zone of MISSION_TIMON_ZONES.readable) {
    const policy = resolveFence(cfg(), fullTarget({ timonRead: [`${TH}/${zone}`], pluginDirs: [`${TH}/${zone}`] }));
    assert.ok(policy.ignored.some((i) => i.path === `${TH}/${zone}`), `${zone} must be dropped`);
    // Every skill is readable by design: the fence grants the skills folder itself.
    if (zone !== 'skills') assert.equal(access(policy, `${TH}/${zone}/someone-else/x`), 'none', `${zone}/… must stay refused`);
  }
  // A folder that lists a kind of entry is no better than the zone root.
  for (const path of [`${TH}/uploads/chat`, `${TH}/plugins/node_modules`]) {
    const policy = resolveFence(cfg(), fullTarget({ timonRead: [path], pluginDirs: [path] }));
    assert.ok(policy.ignored.some((i) => i.path === path), `${path} must be dropped`);
  }
});

test('fence: a handed-over path never lands in another account\'s or mission\'s folder', () => {
  const other = 'bbbbbbbb-0000-4000-8000-000000000002';
  for (const path of [
    `${TH}/backend-accounts/acc-other`,
    `${TH}/backend-accounts/acc-other/.credentials.json`,
    `${TH}/backend-accounts/acc-mine/projects`,
    `${TH}/tmp/missions`,
    `${TH}/tmp/missions/${other}`,
    `${TH}/provider-runs/provider-codex/${other}`,
    `${TH}/provider-cache/provider-codex`,
    `${TH}/codex-runs/${other}`,
    `${TH}/grok-runs/${other}/x`,
  ]) {
    const policy = resolveFence(cfg(), fullTarget({ cwd: path, gitDirs: [path] }));
    assert.equal(policy.ignored.filter((i) => i.path === path).length, 2, `${path} must be dropped twice`);
  }
  // The mission's own folders are still granted, from its identity.
  const policy = resolveFence(cfg(), fullTarget());
  assert.equal(access(policy, `${TH}/backend-accounts/acc-mine/.credentials.json`), 'rw');
  assert.equal(access(policy, `${TH}/tmp/missions/${MISSION}/x`), 'rw');
  // A folder one level inside the other zones is what a working directory is.
  for (const path of [`${TH}/worktrees/task-9`, `${TH}/tmp/scratch-1`, `${TH}/workflows/nightly`]) {
    assert.equal(access(resolveFence(cfg(), fullTarget({ cwd: path })), `${path}/a`), 'rw', `${path} is a working directory`);
  }
});

/* ── Links and case: every grant is checked on the path it resolves to ──── */

// A real folder: links are followed by the default `realpath`. The temporary
// root is resolved first, since `/var/folders` is a link to `/private/var/folders` on macOS.
const LINKS = realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-fence-links-')));
const LTH = join(LINKS, '.timon');
for (const dir of ['worktrees/task-1', 'backend-accounts/acc-mine', 'backend-accounts/acc-other', 'tmp/missions', 'skills']) {
  mkdirSync(join(LTH, dir), { recursive: true });
}
writeFileSync(join(LTH, 'daemon-token'), 'x');
// Creating a link may need a privilege on Windows (developer mode or an
// elevated account): the link tests are skipped there rather than failing.
const linkSkip = ((): string | false => {
  try {
    symlinkSync(join(LTH, 'skills'), join(LINKS, 'probe-link'), 'dir');
    return false;
  } catch (err) {
    return `this account cannot create a symbolic link (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`;
  }
})();
const linkTarget = (over: Record<string, unknown> = {}) => ({
  timonHome: LTH, home: LINKS, platform: process.platform, cwd: join(LTH, 'worktrees', 'task-1'),
  missionId: MISSION, account: 'acc-mine', timonHomeEntries: [], ...over,
});

test('fence: a link planted in a worktree carries no grant into the Timon home', { skip: linkSkip }, () => {
  const worktree = join(LTH, 'worktrees', 'task-1');
  symlinkSync(LTH, join(worktree, 'to-home'), 'dir');
  symlinkSync(join(LTH, 'backend-accounts', 'acc-other'), join(worktree, 'to-other'), 'dir');
  for (const link of ['to-home', 'to-other']) {
    const path = join(worktree, link);
    for (const over of [{ cwd: path }, { gitDirs: [path] }, { timonRead: [path] }]) {
      const policy = resolveFence(cfg(), linkTarget(over));
      assert.ok(policy.ignored.some((i) => i.path === path), `${JSON.stringify(over)} must be dropped`);
      assert.ok(![...policy.rw, ...policy.ro].some((p) => p === LTH || p.startsWith(join(LTH, 'backend-accounts', 'acc-other'))));
      assert.equal(access(policy, join(LTH, 'daemon-token')), 'none');
      assert.equal(access(policy, join(LTH, 'backend-accounts', 'acc-other', 'x')), 'none');
    }
  }
  // The same through `host.isolation.writable`, which grants nothing in the Timon home.
  const viaConfig = resolveFence(cfg({ writable: [join(worktree, 'to-home')] }), linkTarget());
  assert.ok(viaConfig.ignored.some((i) => i.path === join(worktree, 'to-home')));
  assert.equal(access(viaConfig, join(LTH, 'daemon-token')), 'none');
});

test('fence: the mission\'s own folder is refused when a link leads it elsewhere in the Timon home', { skip: linkSkip }, () => {
  const own = join(LTH, 'backend-accounts', 'acc-linked');
  symlinkSync(join(LTH, 'backend-accounts', 'acc-other'), own, 'dir');
  const policy = resolveFence(cfg(), linkTarget({ account: 'acc-linked' }));
  assert.ok(policy.ignored.some((i) => i.path === own && i.reason.includes('a link leads it elsewhere')));
  assert.equal(access(policy, join(LTH, 'backend-accounts', 'acc-other', '.credentials.json')), 'none');
});

test('fence: an agent\'s package cache is refused when a link leads it to another agent\'s', { skip: linkSkip }, () => {
  const caches = join(LTH, 'provider-cache', '.agents');
  mkdirSync(join(caches, 'victim'), { recursive: true });
  symlinkSync(join(caches, 'victim'), join(caches, 'planter'), 'dir');
  const policy = resolveFence(cfg(), linkTarget({ agent: 'planter' }));
  assert.ok(policy.ignored.some((i) => i.path === join(caches, 'planter') && i.reason.includes('a link leads it elsewhere')));
  assert.equal(access(policy, join(caches, 'victim', 'npm', 'x')), 'none');
});

test('fence: a Timon home reached through a link is refused under its real name', { skip: linkSkip }, () => {
  const linkedHome = join(LINKS, 'home-link');
  symlinkSync(LTH, linkedHome, 'dir');
  const policy = resolveFence(cfg(), linkTarget({ timonHome: linkedHome, cwd: join(linkedHome, 'worktrees', 'task-1') }));
  assert.ok(policy.deny.includes(LTH) && policy.deny.includes(linkedHome));
  assert.equal(access(policy, join(LTH, 'daemon-token')), 'none');
  assert.equal(access(policy, join(LTH, 'worktrees', 'task-1', 'a.ts')), 'rw', 'the worktree is granted under its real name');
  assert.ok(policy.denyUnderTimonHome.includes(join(LTH, 'daemon-token')));
});

test('fence: a path that does not resolve gets no grant at all', () => {
  const missing = join(LTH, 'worktrees', 'task-gone');
  const policy = resolveFence(cfg(), linkTarget({ cwd: missing, gitDirs: [join(LINKS, 'nowhere', '.git')] }));
  assert.ok(policy.ignored.some((i) => i.path === missing && i.reason.includes('does not resolve')));
  assert.ok(policy.ignored.some((i) => i.path === join(LINKS, 'nowhere', '.git')));
  assert.ok(![...policy.rw, ...policy.ro].includes(missing));
});

test('fence: the Timon home is matched without case on macOS and Windows, with case on Linux', () => {
  const home = resolve('/Users/tester');
  const timonHome = join(home, '.timon');
  const upper = join(home, '.TIMON');
  const handed = { cwd: join(upper, 'backend-accounts'), timonRead: [join(upper, 'agents')], gitDirs: [join(upper, 'tmp')] };
  for (const platform of ['darwin', 'win32'] as const) {
    const policy = resolveFence(cfg(), {
      timonHome, home, platform, missionId: MISSION, realpath: (path: string) => path, ...handed,
    });
    for (const path of [handed.cwd, ...handed.timonRead, ...handed.gitDirs]) {
      assert.ok(policy.ignored.some((i) => i.path === path), `${platform}: ${path} is the Timon home's zone root`);
    }
    // A refused entry spelled in another case is still refused.
    const token = resolveFence(cfg(), {
      timonHome, home, platform, realpath: (path: string) => path, cwd: join(upper, 'Daemon-Token'),
    });
    assert.ok(token.ignored.some((i) => i.path === join(upper, 'Daemon-Token')), `${platform}: the token in another case`);
  }
  // On Linux, `.TIMON` is another folder of the user's home.
  const linux = resolveFence(cfg(), { timonHome, home, platform: 'linux', realpath: (path: string) => path, cwd: handed.cwd });
  assert.ok(linux.rw.includes(handed.cwd));
});
