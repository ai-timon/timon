import '../test-home.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const { dbApi } = await import('../db.js');
const { createPipeline, runPipeline, seedBundledPipelines } = await import('../pipelines.js');

const PIPELINE_RUN_KEYS = ['pipeline_id', 'run_id', 'started_at', 'steps'];
const PIPELINE_STEP_KEYS = ['step_id', 'task_id'];
const TASK_CREATE_KEYS = ['id', 'title', 'agent_name', 'status', 'priority', 'type', 'description'];
const SPAWN_RESPONSE_KEYS = ['mission_id'];

test('timon pipeline run feature-flow still materialises the same Kanban batch', () => {
  seedBundledPipelines();
  let pipeline = dbApi.listPipelines().find((row) => row.name === 'feature-flow');
  if (!pipeline) {
    createPipeline({
      name: 'feature-flow',
      description: 'Pipeline standard plan → code → review → merge.',
      definition: {
        steps: [
          { id: 'plan', agent: 'planner', type: 'research', prompt: 'Plan la feature suivante : {{input.feature}}' },
          { id: 'code', agent: 'coder', type: 'code', prompt: 'Implémente {{input.feature}}', deps_on: ['plan'] }, // french-ok: a sample prompt
          { id: 'review', agent: 'reviewer', type: 'review', prompt: 'Review.', deps_on: ['code'] },
          { id: 'merge', agent: 'merger', type: 'merge', prompt: 'Merge.', deps_on: ['review'] },
        ],
      },
    });
    pipeline = dbApi.listPipelines().find((row) => row.name === 'feature-flow');
  }
  assert.ok(pipeline);
  const result = runPipeline(pipeline.id, { feature: 'widget' });
  assert.deepEqual(Object.keys(result).sort(), [...PIPELINE_RUN_KEYS].sort());
  assert.equal(result.steps.length, 4);
  assert.deepEqual(result.steps.map((step) => Object.keys(step).sort()), result.steps.map(() => [...PIPELINE_STEP_KEYS].sort()));
  assert.deepEqual(result.steps.map((step) => step.step_id), ['plan', 'code', 'review', 'merge']);
  const tasks = result.steps.map((step) => dbApi.getTask(step.task_id)!);
  assert.deepEqual(tasks.map((task) => task.agent_name), ['planner', 'coder', 'reviewer', 'merger']);
  assert.deepEqual(tasks.map((task) => task.type), ['research', 'code', 'review', 'merge']);
  assert.match(tasks[0]!.description ?? '', /widget/);
  const ids = Object.fromEntries(result.steps.map((step) => [step.step_id, step.task_id]));
  assert.deepEqual(JSON.parse(tasks[1]!.deps), [ids.plan]);
  assert.deepEqual(JSON.parse(tasks[2]!.deps), [ids.code]);
  assert.deepEqual(JSON.parse(tasks[3]!.deps), [ids.review]);
});

test('timon task create still returns a task row with the pre-W envelope', () => {
  const id = randomUUID();
  dbApi.createTask(id, 'compat witness', 'w8.witness', { type: 'chore', description: 'keep the CLI shape' });
  const task = dbApi.getTask(id);
  assert.ok(task);
  for (const key of TASK_CREATE_KEYS) assert.ok(key in task, key);
  assert.equal(task.status, 'PENDING');
  assert.equal(task.agent_name, 'w8.witness');
});

test('timon spawn still prints { mission_id } and task create still prints the task', () => {
  const cli = readFileSync(fileURLToPath(new URL('../../bin/timon', import.meta.url)), 'utf8');
  assert.match(cli, /process\.stdout\.write\(JSON\.stringify\(j\) \+ '\\n'\)/);
  assert.match(cli, /process\.stdout\.write\(JSON\.stringify\(j\.task, null, 2\) \+ '\\n'\)/);
  assert.deepEqual(SPAWN_RESPONSE_KEYS, ['mission_id']);
});
