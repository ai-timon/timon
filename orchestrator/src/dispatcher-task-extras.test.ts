/**
 * The extras a task stores are judged again when it starts.
 *
 * Adding a tool, a skill that pre-authorises one or a stdio MCP server to an
 * agent takes a person. The task route refuses an agent's token at creation;
 * a task an agent's mission created before that check (or through a path that
 * escaped it) is caught here, at dispatch, and BLOCKED with a reason that sends
 * the user to the app. A task a person wrote starts as before.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbApi } from './db.js';
import { agentDir } from './paths.js';
import { upsertSkill } from './skills.js';
import { blockIfExtrasWiden, taskExtrasRefusal } from './dispatcher.js';
await import('../tests/helpers/claude-provider.js');

function agent(name: string, config: Record<string, unknown>): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify(config));
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'Test agent.');
}

agent('acme.main', { cwd: process.env.TIMON_HOME, role: 'orchestrator', project: 'acme' });
agent('acme.coder', { cwd: process.env.TIMON_HOME, project: 'acme', allowed_tools: ['Read'] });
agent('acme.shell', { cwd: process.env.TIMON_HOME, project: 'acme', allowed_tools: ['Read', 'Bash'] });
upsertSkill('shell-runner', '---\nname: shell-runner\nallowed-tools: Bash\n---\n\nRun.\n');
upsertSkill('plain-notes', '---\nname: plain-notes\n---\n\nNo tool declared.\n');
upsertSkill('timon-task', '---\nname: timon-task\nallowed-tools: Bash(timon:*)\n---\n\nClose your task.\n');

const pilot = randomUUID();
dbApi.createMission(pilot, 'acme.main', 'pilot the series');

type Extras = { tools?: string[]; mcp?: string[]; skills?: string[] };

function task(agentName: string, extras: Extras, creatorMissionId: string | null) {
  const id = randomUUID();
  dbApi.createTask(id, 'code task', agentName, {
    type: 'chore',
    creatorMissionId,
    extraAllowedTools: extras.tools,
    extraMcpServers: extras.mcp,
    extraSkills: extras.skills,
  });
  return dbApi.getTask(id)!;
}

test('an extra tool written by an agent\'s mission is refused at dispatch', () => {
  const t = task('acme.coder', { tools: ['Bash'] }, pilot);
  assert.match(taskExtrasRefusal(t, 'acme.coder') ?? '', /extra_allowed_tools adds Bash/);
});

test('the same extras written by a person start as before', () => {
  const t = task('acme.coder', { tools: ['Bash'], mcp: ['undeclared-stdio'], skills: ['shell-runner'] }, null);
  assert.equal(taskExtrasRefusal(t, 'acme.coder'), null);
  assert.equal(blockIfExtrasWiden(t, 'acme.coder'), false);
  assert.equal(dbApi.getTask(t.id)!.status, 'PENDING');
});

test('an MCP server nothing declares is refused, it could become a stdio command', () => {
  const t = task('acme.coder', { mcp: ['undeclared-stdio'] }, pilot);
  assert.match(taskExtrasRefusal(t, 'acme.coder') ?? '', /extra_mcp_servers attaches undeclared-stdio/);
});

test('a skill that pre-authorises a tool the agent lacks is refused', () => {
  const t = task('acme.coder', { skills: ['shell-runner'] }, pilot);
  assert.match(taskExtrasRefusal(t, 'acme.coder') ?? '', /extra_skills adds skill shell-runner, which pre-authorises Bash/);
});

test('extras the agent already holds, or that grant nothing, pass', () => {
  assert.equal(taskExtrasRefusal(task('acme.coder', { tools: ['Read'], skills: ['plain-notes'] }, pilot), 'acme.coder'), null);
  assert.equal(taskExtrasRefusal(task('acme.coder', {}, pilot), 'acme.coder'), null);
});

test('the task skill the dispatcher injects itself is not a widening', () => {
  // The doc tasks the daemon chains carry it, with their pilot as creator.
  assert.equal(taskExtrasRefusal(task('acme.coder', { skills: ['timon-task'] }, pilot), 'acme.coder'), null);
});

test('the extras are judged against the agent that really runs the task', () => {
  // A rerouted task runs on the role's holder, not on the agent it names.
  const t = task('acme.shell', { tools: ['Bash'] }, pilot);
  assert.equal(taskExtrasRefusal(t, 'acme.shell'), null);
  assert.match(taskExtrasRefusal(t, 'acme.coder') ?? '', /adds Bash/);
});

test('a refused task is BLOCKED with a reason that sends the user to the app, and audited', () => {
  const t = task('acme.coder', { tools: ['Bash'] }, pilot);
  assert.equal(blockIfExtrasWiden(t, 'acme.coder'), true);
  const after = dbApi.getTask(t.id)!;
  assert.equal(after.status, 'BLOCKED');
  assert.match(after.blocked_reason ?? '', /An agent's mission wrote this task/);
  assert.match(after.blocked_reason ?? '', /Agents page of the app/);
  assert.match(after.blocked_reason ?? '', /acme\.coder/);
  const audit = dbApi.listAuditLog().find((row) => row.target?.startsWith(`task:${t.id}`));
  assert.equal(audit?.action, 'task.override_denied');
  assert.equal(audit?.actor, 'api-token');
});

test('a malformed stored list grants nothing and is read as none', () => {
  const t = { ...task('acme.coder', {}, pilot), extra_allowed_tools: '{not json' };
  assert.equal(taskExtrasRefusal(t, 'acme.coder'), null);
});
