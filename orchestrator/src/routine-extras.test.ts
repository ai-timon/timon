/**
 * A routine carries the extras of the tasks it opens.
 *
 * A Kanban task starts with zero MCP server by default: only its role's and
 * its own extras reach the mission. An agent with no project role (an
 * assistant whose config lists a mail server) therefore had none of its tools
 * at every routine run. The routine stores the extras once; each tick copies
 * them onto the task, and the dispatcher's override picks them up. The agent's
 * own config is still never inherited.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
await import('../tests/helpers/claude-provider.js');

const { db, dbApi } = await import('./db.js');
const { agentDir } = await import('./paths.js');
const { createRoutine, tickRoutines, updateRoutine } = await import('./routines.js');
const { resolveRoleSpec, taskMcpServers } = await import('./dispatcher.js');

mkdirSync(agentDir('assistant'), { recursive: true });
writeFileSync(join(agentDir('assistant'), 'config.json'), JSON.stringify({
  cwd: process.env.TIMON_HOME, mcp_servers: ['mail', 'calendar'],
}));
writeFileSync(join(agentDir('assistant'), 'system-prompt.md'), 'Test agent.');

async function tickedTaskOf(routineId: string) {
  db.prepare(`UPDATE triggers SET next_run_at = 1 WHERE id = ?`).run(routineId);
  await tickRoutines();
  const tasks = dbApi.listTasks().filter((t) => t.routine_id === routineId);
  return tasks[tasks.length - 1];
}

test('the task a routine opens carries its extras, and the mission gets its MCP servers', async () => {
  const routine = createRoutine({
    name: 'Inbox', agent_name: 'assistant', prompt: 'Sort the inbox.', cron_expr: '0 8 * * *',
    extra_mcp_servers: ['mail'], extra_skills: ['inbox-rules'], extra_allowed_tools: ['Read'],
  });
  assert.equal(dbApi.getRoutine(routine.id)?.extra_mcp_servers, '["mail"]');
  const task = await tickedTaskOf(routine.id);
  assert.ok(task, 'the tick opened a task');
  assert.equal(task.extra_mcp_servers, '["mail"]');
  assert.equal(task.extra_skills, '["inbox-rules"]');
  assert.equal(task.extra_allowed_tools, '["Read"]');
  assert.deepEqual(taskMcpServers(resolveRoleSpec(task).roleMcpServers, task), ['mail']);
});

test('without extras the task keeps zero MCP server: the agent config is not inherited', async () => {
  const routine = createRoutine({ name: 'Plain', agent_name: 'assistant', prompt: 'Report.', cron_expr: '0 8 * * *' });
  assert.equal(dbApi.getRoutine(routine.id)?.extra_mcp_servers, null);
  const task = await tickedTaskOf(routine.id);
  assert.ok(task);
  assert.equal(task.extra_mcp_servers, null);
  assert.deepEqual(taskMcpServers(resolveRoleSpec(task).roleMcpServers, task), []);
});

test('an update keeps the extras it does not name, and an empty list clears them', () => {
  const routine = createRoutine({
    name: 'Edited', agent_name: 'assistant', prompt: 'Report.', cron_expr: '0 8 * * *',
    extra_mcp_servers: ['mail'], extra_allowed_tools: ['Read'],
  });
  updateRoutine(routine.id, { prompt: 'Report again.', extra_skills: ['inbox-rules'] });
  let row = dbApi.getRoutine(routine.id)!;
  assert.equal(row.extra_mcp_servers, '["mail"]');
  assert.equal(row.extra_skills, '["inbox-rules"]');
  updateRoutine(routine.id, { extra_mcp_servers: [], extra_allowed_tools: null });
  row = dbApi.getRoutine(routine.id)!;
  assert.equal(row.extra_mcp_servers, null);
  assert.equal(row.extra_allowed_tools, null);
  assert.equal(row.extra_skills, '["inbox-rules"]');
});

test('a malformed stored list opens the task with none rather than failing the tick', async () => {
  const routine = createRoutine({ name: 'Broken', agent_name: 'assistant', prompt: 'Report.', cron_expr: '0 8 * * *' });
  db.prepare(`UPDATE triggers SET extra_mcp_servers = '{not json' WHERE id = ?`).run(routine.id);
  const task = await tickedTaskOf(routine.id);
  assert.ok(task);
  assert.equal(task.extra_mcp_servers, null);
});
