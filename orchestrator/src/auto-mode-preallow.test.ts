/**
 * A pre-allowed `Bash` asked for again in an autonomous `code` task (GitHub
 * report, 0.1.8). The road, link by link:
 *
 *   agent `allowed_tools: ["Bash"]` → `--allowedTools Bash,…` (claude dialect)
 *   task → role `permission_mode`   → `--permission-mode auto` (resolveRoleSpec)
 *   claude in auto drops `Bash`     → classifier → card → denied after the delay
 *
 * The CLI side was measured on claude 2.1.322: a bare `Bash` lets every command
 * through in `acceptEdits` and `default`, and `--debug-file` in `auto` logs
 * "Ignoring dangerous permission Bash(*) from cliArg (bypasses classifier)".
 * These tests pin Timon's side: what it hands the CLI, that it says so when the
 * rule is dropped, and that it never widens anything to say it.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, dbApi } from './db.js';
import { writeRoles } from './projects.js';
import { resolveRoleSpec, resolveTaskRouting } from './dispatcher.js';
import { agentDir } from './paths.js';
import {
  agentConfigWarnings, inertShellPreallows, lostShellPreallows, reportInertShellPreallow, reportReroutedShellPreallow,
  resetInertShellPreallowReportsForTests, wholeShellPreallows,
} from './auto-mode-preallow.js';

await import('../tests/helpers/claude-provider.js');
const { buildUnderSeal } = await import('../tests/helpers/official-providers.js');
type AgentConfig = import('./agent.js').AgentConfig;

const PROJECT = 'preallowchain';
const CODER = 'preallowchain.coder';
mkdirSync(agentDir(CODER), { recursive: true });
writeFileSync(join(agentDir(CODER), 'config.json'), JSON.stringify({
  role: 'coder', project: PROJECT, backend: 'claude', permission_mode: 'acceptEdits', allowed_tools: ['Bash'],
}));
writeFileSync(join(agentDir(CODER), 'system-prompt.md'), 'coder');

async function claudeArgs(cfg: AgentConfig): Promise<string[]> {
  const spawn = await buildUnderSeal('claude', {
    agentName: CODER, systemPrompt: 'sp', message: 'm', resumeSession: null, missionId: `m-${randomUUID()}`,
    cfg: { cwd: process.cwd(), ...cfg },
  } as never);
  return spawn.args;
}

function after(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function codeTask(): ReturnType<typeof dbApi.getTask> {
  const id = randomUUID();
  dbApi.createTask(id, 'code witness', CODER, { type: 'code', project: PROJECT });
  return dbApi.getTask(id);
}

function notifications(agent: string): string[] {
  return (db.prepare(`SELECT payload FROM agent_messages WHERE kind = 'notification'`).all() as { payload: string }[])
    .map((row) => JSON.parse(row.payload) as { title: string })
    .map((p) => p.title)
    .filter((title) => title.endsWith(`: ${agent}`));
}

test('reproduction: the agent mode passes Bash on; the role mode makes the CLI drop it', async () => {
  // No mode on the role: the agent's acceptEdits reaches the CLI with Bash, which the CLI honours.
  writeRoles(PROJECT, { code: { agent: CODER } });
  assert.equal(resolveRoleSpec(codeTask()!).permissionMode, null);
  const own = await claudeArgs({ permission_mode: 'acceptEdits', allowed_tools: ['Bash'] });
  assert.equal(after(own, '--permission-mode'), 'acceptEdits');
  assert.ok(after(own, '--allowedTools')!.split(',').includes('Bash'));
  assert.deepEqual(inertShellPreallows('acceptEdits', 'mcp-bridge', ['Bash']), []);

  // A role in auto wins over the agent: the same Bash reaches a CLI that drops it.
  writeRoles(PROJECT, { code: { agent: CODER, permission_mode: 'auto' } });
  const mode = resolveRoleSpec(codeTask()!).permissionMode;
  assert.equal(mode, 'auto');
  const roleRun = await claudeArgs({ permission_mode: mode!, allowed_tools: ['Bash'] });
  assert.equal(after(roleRun, '--permission-mode'), 'auto');
  assert.deepEqual(inertShellPreallows(mode, 'mcp-bridge', ['Bash']), ['Bash']);
});

test('the bare name and a match-all pattern are whole-shell pre-allows; a narrow pattern is not', () => {
  assert.deepEqual(wholeShellPreallows(['Bash']), ['Bash']);
  assert.deepEqual(wholeShellPreallows([' Bash ', 'Bash(*)', 'Bash(:*)', 'PowerShell', 'PowerShell(*:*)']),
    ['Bash', 'Bash(*)', 'Bash(:*)', 'PowerShell', 'PowerShell(*:*)']);
  assert.deepEqual(wholeShellPreallows(['Bash(git:*)', 'Bash(npm test)', 'Bashful', 'Read', 'mcp__x__Bash', 'Bash(*']), []);
  assert.deepEqual(wholeShellPreallows(undefined), []);
});

test('only the claude bridge in auto drops the rule', () => {
  for (const mode of ['acceptEdits', 'default', 'plan', 'bypassPermissions', undefined]) {
    assert.deepEqual(inertShellPreallows(mode, 'mcp-bridge', ['Bash']), [], String(mode));
  }
  for (const model of ['sandbox', 'protocol', 'none'] as const) {
    assert.deepEqual(inertShellPreallows('auto', model, ['Bash']), [], model);
  }
  assert.deepEqual(inertShellPreallows('auto', 'mcp-bridge', ['Bash(git:*)']), []);
});

test('a launch that drops the rule is notified once per agent, with who chose auto', () => {
  resetInertShellPreallowReportsForTests();
  const mission = randomUUID();
  dbApi.createMission(mission, CODER, 'witness', { channel: 'dispatcher' });
  const before = notifications(CODER).length;
  const launch = { agent: CODER, missionId: mission, mode: 'auto', permissionModel: 'mcp-bridge', allowed: ['Bash'], modeSource: 'mission' } as const;
  assert.deepEqual(reportInertShellPreallow(launch), ['Bash']);
  assert.deepEqual(reportInertShellPreallow(launch), ['Bash'], 'still logged on the next launch');
  assert.equal(notifications(CODER).length - before, 1, 'one notification, not one per mission');
  const row = db.prepare(`SELECT payload FROM agent_messages WHERE kind = 'notification' ORDER BY rowid DESC LIMIT 1`).get() as { payload: string };
  const payload = JSON.parse(row.payload) as { body: string; code: string; params: Record<string, string> };
  assert.match(payload.body, /acceptEdits/);
  assert.match(payload.body, /task or project role/);
  assert.equal(payload.code, 'shell_preallow_inert');
  assert.deepEqual(payload.params, { agent: CODER, rules: 'Bash', source: 'mission' });
});

test('nothing is said, and nothing is granted, to an agent that asked for nothing', async () => {
  resetInertShellPreallowReportsForTests();
  const quiet = 'preallowchain.quiet';
  const mission = randomUUID();
  dbApi.createMission(mission, quiet, 'witness', { channel: 'dispatcher' });
  const before = notifications(quiet).length;
  assert.deepEqual(reportInertShellPreallow({
    agent: quiet, missionId: mission, mode: 'auto', permissionModel: 'mcp-bridge', allowed: ['Read', 'Bash(git:*)'], modeSource: 'agent',
  }), []);
  assert.equal(notifications(quiet).length, before);
  for (const mode of ['auto', 'acceptEdits']) {
    const allowed = after(await claudeArgs({ permission_mode: mode, allowed_tools: ['Read'] }), '--allowedTools')!.split(',');
    assert.equal(allowed.includes('Bash'), false, `${mode}: no shell pre-allow appears`);
  }
  assert.deepEqual(agentConfigWarnings(quiet, { backend: 'claude', permission_mode: 'auto', allowed_tools: ['Read'] }), []);
});

test('saving an agent in auto with Bash answers with a warning that names the way out', () => {
  const [warning] = agentConfigWarnings(CODER, { backend: 'claude', permission_mode: 'auto', allowed_tools: ['Bash', 'Read'] });
  assert.ok(warning);
  assert.match(warning, /pre-allows Bash but runs in auto mode/);
  assert.match(warning, /acceptEdits/);
  assert.deepEqual(agentConfigWarnings(CODER, { backend: 'claude', permission_mode: 'acceptEdits', allowed_tools: ['Bash'] }), []);
  assert.deepEqual(agentConfigWarnings(CODER, { backend: 'no-such-backend', permission_mode: 'auto', allowed_tools: ['Bash'] }), []);
});

/* ── The other road: the task does not run on the agent that holds Bash ──── */

const ROUTED_PROJECT = 'preallowroute';
const OWN = 'preallowroute-own';
const ROLE = 'preallowroute.coder';
function agent(name: string, cfg: Record<string, unknown>): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ project: ROUTED_PROJECT, cwd: process.cwd(), backend: 'claude', ...cfg }));
  writeFileSync(join(agentDir(name), 'system-prompt.md'), name);
}
// The reporter's agent: created in acceptEdits, given Bash, holding no role.
agent(OWN, { permission_mode: 'acceptEdits', allowed_tools: ['Bash'] });
agent(ROLE, { role: 'coder', permission_mode: 'auto' });

function taskFor(named: string, creatorMission: string | null = null) {
  const id = randomUUID();
  dbApi.createTask(id, 'code witness', named, { type: 'code', project: ROUTED_PROJECT, creatorMissionId: creatorMission });
  return dbApi.getTask(id)!;
}

test('reproduction: a task naming the Bash agent runs on it, in its mode, unless something reroutes it', () => {
  writeRoles(ROUTED_PROJECT, {});
  const kept = taskFor(OWN);
  assert.equal(resolveTaskRouting(kept).agent, OWN);
  assert.equal(resolveRoleSpec(kept).permissionMode, null, 'no role mode: the agent\'s acceptEdits applies');

  // A pinned role sends the same task to the role's agent, seeded in auto, without Bash.
  writeRoles(ROUTED_PROJECT, { code: { agent: ROLE } });
  const pinned = resolveTaskRouting(taskFor(OWN));
  assert.equal(pinned.agent, ROLE);
  assert.equal(pinned.refusal, 'pinned');

  // So does a task the agent created for itself: the dispatcher never hands a pilot its own work.
  writeRoles(ROUTED_PROJECT, {});
  const creator = randomUUID();
  dbApi.createMission(creator, OWN, 'pilot', { channel: 'ui' });
  assert.equal(resolveTaskRouting(taskFor(OWN, creator)).agent, ROLE);
});

test('a rerouted task that loses the shell pre-allow is reported once per named agent', () => {
  resetInertShellPreallowReportsForTests();
  const before = notifications(OWN).length;
  const lost = { taskId: randomUUID(), named: OWN, routed: ROLE, why: 'the coder role is pinned', namedAllowed: ['Bash'], routedAllowed: ['Read'] };
  assert.deepEqual(reportReroutedShellPreallow(lost), ['Bash']);
  assert.deepEqual(reportReroutedShellPreallow({ ...lost, taskId: randomUUID() }), ['Bash']);
  assert.equal(notifications(OWN).length - before, 1);
  // The routed agent already holds it, or the task's own extras give it: nothing lost, nothing said.
  assert.deepEqual(lostShellPreallows(['Bash'], ['Read', 'Bash']), []);
  assert.deepEqual(lostShellPreallows(['Bash(git:*)'], []), [], 'a narrow pattern is the CLI\'s to keep');
  // Reporting changes no one's tools.
  assert.deepEqual(JSON.parse(readFileSync(join(agentDir(ROLE), 'config.json'), 'utf8')).allowed_tools, undefined);
});
