import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const { AGENTS_DIR, TIMON_HOME, PROJECTS_DIR, WORKSPACE_DIR, ONBOARDING_WORKSPACE_DIR } = await import('./paths.js');
const { CONFIG_FILE } = await import('./config/load.js');
const { db, dbApi } = await import('./db.js');
const { seedDefaultAgent, getAgent, listAgents, patchAgentConfig, deleteAgent } = await import('./agent.js');
const { TEAM_STATE_KEY, initializeTeamOnboarding, readTeamState, writeTeamState, teamOnboardingPending } = await import('./onboarding-team-state.js');
const { applyTeam, teamStatus } = await import('./onboarding-team.js');
const { applyMainAgent } = await import('./onboarding-main-agent.js');
const { seedLibrarianAgent } = await import('./librarian.js');
const { getHost } = await import('./host/index.js');
const { registerRoutes } = await import('./plugins-bundled/http/routes.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');

// The daemon seeds `_main` once the release providers have registered (`whenProvidersLoaded`): mounted
// here the same way, so the seed finds its default backend without a CLI on the PATH.
{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

function reset() {
  for (const path of [AGENTS_DIR, PROJECTS_DIR, CONFIG_FILE]) rmSync(path, { force: true, recursive: true });
  dbApi.deleteSetting(TEAM_STATE_KEY);
}
function configure() {
  writeFileSync(CONFIG_FILE, JSON.stringify({ workspacesRoot: join(TIMON_HOME, 'workspace') }));
}

test('first boot seeds only the technical agent; eligibility survives configuration', () => {
  reset();
  seedDefaultAgent();
  assert.deepEqual(listAgents().map((a) => a.name), ['_main']);
  assert.equal(teamOnboardingPending(), true);
  configure();
  seedDefaultAgent();
  assert.equal(teamOnboardingPending(), true);
  assert.deepEqual(listAgents().map((a) => a.name), ['_main']);
});

test('an archivist module starting first cannot preempt the team choice', () => {
  reset();
  seedLibrarianAgent();
  assert.equal(teamOnboardingPending(), true);
  assert.equal(getAgent('TIMON.librarian'), null);
  seedDefaultAgent();
  assert.deepEqual(listAgents().map((a) => a.name), ['_main']);
});

test('existing config, agent or project prevents new-install eligibility', () => {
  for (const kind of ['config', 'agent', 'project']) {
    reset();
    if (kind === 'config') configure();
    else mkdirSync(join(kind === 'agent' ? AGENTS_DIR : PROJECTS_DIR, 'custom'), { recursive: true });
    initializeTeamOnboarding();
    assert.equal(readTeamState(), null, kind);
  }
});

test('scratch stays empty across boots and completion is idempotent', () => {
  reset(); seedDefaultAgent(); configure();
  const result = applyTeam('scratch');
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.agents, []);
  assert.deepEqual(applyTeam('scratch'), result);
  seedDefaultAgent();
  assert.deepEqual(listAgents().map((a) => a.name), ['_main']);
  assert.equal(teamOnboardingPending(), false);
  assert.throws(() => applyTeam('team'), /preset_locked/);
});

test('Agent Team creates independent agents without tasks or missions; retries preserve edits', () => {
  reset(); seedDefaultAgent(); configure();
  const host = getHost();
  const original = host.bin;
  host.bin = ((name: string) => { if (name === 'codex') return '/test/codex'; throw new Error('absent'); }) as typeof host.bin;
  try {
    applyTeam('team');
    assert.equal(listAgents().length, 5);
    for (const name of ['assistant', 'researcher', 'writer', 'developer']) {
      const agent = getAgent(name)!;
      // No lead, by design: the preset is four specialists the user talks to
      // directly, so nobody reports to anybody.
      assert.equal(agent.reports_to, null);
      assert.equal(agent.backend, 'codex');
      assert.equal(agent.cwd, join(TIMON_HOME, 'workspace'));
      assert.match(agent.system_prompt, /independent agent/);
    }
    for (const table of ['missions', 'tasks', 'routines', 'triggers']) {
      assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
    }
    patchAgentConfig('writer', { model: 'custom-model' });
    const before = readFileSync(join(AGENTS_DIR, 'writer', 'config.json'), 'utf8');
    applyTeam('team');
    assert.equal(readFileSync(join(AGENTS_DIR, 'writer', 'config.json'), 'utf8'), before);
    deleteAgent('developer');
    applyTeam('team'); seedDefaultAgent();
    assert.equal(getAgent('developer'), null, 'completed teams do not resurrect deleted agents');
  } finally { host.bin = original; }
});

test('an unreadable config file is workspace_unavailable, not a crash', () => {
  reset(); seedDefaultAgent();
  writeFileSync(CONFIG_FILE, '{ "workspacesRoot": ');
  const host = getHost();
  const original = host.bin;
  host.bin = ((name: string) => { if (name === 'codex') return '/test/codex'; throw new Error('absent'); }) as typeof host.bin;
  try {
    assert.throws(() => applyTeam('team'), /workspace_unavailable/);
    assert.equal(getAgent('assistant'), null);
  } finally { host.bin = original; }
});

test('without a workspacesRoot the team shares a folder inside the workspace folder, never the user home', () => {
  reset(); seedDefaultAgent();
  writeFileSync(CONFIG_FILE, JSON.stringify({}));
  const host = getHost();
  const original = host.bin;
  host.bin = ((name: string) => { if (name === 'codex') return '/test/codex'; throw new Error('absent'); }) as typeof host.bin;
  try {
    applyTeam('team');
    // The workspace folder itself lists every agent's folder: the fence never hands it over.
    for (const name of ['assistant', 'researcher', 'writer', 'developer']) {
      assert.equal(getAgent(name)!.cwd, realpathSync(ONBOARDING_WORKSPACE_DIR));
      assert.notEqual(getAgent(name)!.cwd, realpathSync(WORKSPACE_DIR));
      assert.notEqual(getAgent(name)!.cwd, homedir());
    }
    assert.equal(ONBOARDING_WORKSPACE_DIR, join(WORKSPACE_DIR, 'home'));
  } finally { host.bin = original; }
});

test('with a workspacesRoot the team works in that folder, as before', () => {
  reset(); seedDefaultAgent();
  const root = join(TIMON_HOME, 'chosen-root');
  writeFileSync(CONFIG_FILE, JSON.stringify({ workspacesRoot: root }));
  const host = getHost();
  const original = host.bin;
  host.bin = ((name: string) => { if (name === 'codex') return '/test/codex'; throw new Error('absent'); }) as typeof host.bin;
  try {
    applyTeam('team');
    for (const name of ['assistant', 'researcher', 'writer', 'developer']) assert.equal(getAgent(name)!.cwd, realpathSync(root));
  } finally { host.bin = original; }
});

test('interrupted team creation resumes missing files and rejects changes to its saved choice', () => {
  reset(); seedDefaultAgent(); configure();
  const host = getHost(); const original = host.bin;
  host.bin = (() => '/test/cli') as typeof host.bin;
  try {
    applyTeam('team');
    const saved = readTeamState()!;
    assert.ok(saved.agents?.every((a) => a.config.reports_to === null));
    writeTeamState({ ...saved, status: 'applying' });
    deleteAgent('writer'); deleteAgent('developer');
    assert.throws(() => applyTeam('scratch'), /preset_locked/);
    applyTeam('team');
    assert.equal(readdirSync(AGENTS_DIR).length, 5);
    assert.equal(getAgent('writer')?.reports_to, null);
    writeTeamState({ ...saved, status: 'applying' });
    patchAgentConfig('assistant', { model: 'user-choice' });
    assert.throws(() => applyTeam('team'), /agent_conflict/);
    assert.equal(getAgent('assistant')?.model, 'user-choice');
    assert.equal(teamStatus().status, 'applying');
  } finally { host.bin = original; }
});

test('a custom agent added during setup is preserved; scratch lets the owner finish', () => {
  reset(); seedDefaultAgent(); configure();
  mkdirSync(join(AGENTS_DIR, 'custom'));
  writeFileSync(join(AGENTS_DIR, 'custom', 'system-prompt.md'), 'Keep me');
  assert.throws(() => applyTeam('team'), /instance_not_empty/);
  applyTeam('scratch');
  assert.equal(readFileSync(join(AGENTS_DIR, 'custom', 'system-prompt.md'), 'utf8'), 'Keep me');
});

test('answering step 3 answers the team step too, as the main agent alone', () => {
  reset(); seedDefaultAgent(); configure();
  const host = getHost(); const original = host.bin;
  host.bin = (() => '/test/cli') as typeof host.bin;
  try {
    // The wizard has no team step any more: naming the agent closes it.
    applyMainAgent({ name: 'Nova' });
    assert.equal(teamStatus().status, 'complete');
    assert.deepEqual(readdirSync(AGENTS_DIR).sort(), ['Nova']);
  } finally { host.bin = original; }
});

test('HTTP requires operator auth, validates the preset and handles concurrent retries', async () => {
  reset(); seedDefaultAgent(); configure();
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: 'test-operator', required: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers['x-test-restricted']) req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: [] };
    next();
  });
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/setup/team`;
  const headers = { authorization: 'Bearer test-operator', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { headers: { ...headers, 'x-test-restricted': '1' } })).status, 403);
    assert.equal((await fetch(base, { method: 'POST', headers: { ...headers, 'x-test-restricted': '1' }, body: '{"preset":"scratch"}' })).status, 403);
    assert.equal((await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"preset":"scratch"}' })).status, 401);
    const invalid = await fetch(base, { method: 'POST', headers, body: '{"preset":"custom","force":true}' });
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as { code?: string }).code, 'setup_team_invalid_preset');
    const results = await Promise.all([1, 2].map(() => fetch(base, { method: 'POST', headers, body: '{"preset":"scratch"}' })));
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.equal(listAgents().length, 1);
    assert.equal(teamOnboardingPending(), false);
  } finally { server.close(); }
});

test('the wizard answers every team and identity refusal with a translatable code', async () => {
  const { teamErrorBody, mainAgentErrorBody, resumeErrorBody } = await import('./plugins-bundled/http/setup-errors.js');
  const { TeamSetupError } = await import('./onboarding-team.js');
  const { MainAgentSetupError } = await import('./onboarding-main-agent.js');
  const { ResumeError } = await import('./onboarding-resume.js');
  assert.equal(teamErrorBody(new TeamSetupError('instance_not_empty')).code, 'setup_team_instance_not_empty');
  assert.equal(teamErrorBody(new TeamSetupError('workspace_unavailable')).code, 'setup_workspace_unavailable');
  assert.equal(teamErrorBody(new Error('disk full')).code, 'setup_team_failed', 'an unexpected failure never leaks its text');
  assert.equal(mainAgentErrorBody(new MainAgentSetupError('name_taken')).code, 'setup_main_agent_name_taken');
  assert.equal(mainAgentErrorBody(new Error('boom')).code, 'setup_main_agent_failed');
  assert.equal(resumeErrorBody(new ResumeError('setup_complete')).code, 'setup_already_complete');
  assert.equal(resumeErrorBody(new Error('boom')).code, 'setup_resume_failed');
});
