/**
 * The launch path of a spawned lead mission (`missionFenceTarget` into `resolveFence`): a project
 * registered outside the `.../projects/<slug>` layout still opens its repository's `.git`.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { missionFenceTarget } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { config } = await import('./config/load.js');
const { resolveFence } = await import('./host/isolation.js');
const { TIMON_HOME } = await import('./paths.js');

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fence-lead-')));
// No `projects` segment in the path: `projectFromCwd` reads it as no project.
const clone = join(root, 'work', 'app');
mkdirSync(join(clone, '.git', 'objects'), { recursive: true });
dbApi.upsertProject('lead-app', { name: 'lead-app', cwd: clone });

function policyOf(role: string | null, project = ''): readonly string[] {
  const target = missionFenceTarget({
    missionId: randomUUID(), agentName: 'lead-witness', project, backend: 'claude', cwd: clone, mcpServers: [], role,
  });
  const iso = { ...config(), host: { ...config().host, isolation: { ...config().host.isolation, filesystem: 'auto' as const } } };
  return resolveFence(iso, { ...target, cwd: clone, timonHome: TIMON_HOME }).rw;
}

test('a lead mission with no project slug of its own still gets the common .git read-write', () => {
  assert.ok(policyOf('orchestrator').includes(join(clone, '.git')));
});

test('a coder mission on the same project does not', () => {
  assert.equal(policyOf('coder').includes(join(clone, '.git')), false);
});

test('a lead that gets no grant says so', () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (line: unknown) => { warnings.push(String(line)); };
  try {
    const target = missionFenceTarget({
      missionId: randomUUID(), agentName: 'lead-witness', project: '', backend: 'claude', cwd: join(root, 'elsewhere'), mcpServers: [], role: 'orchestrator',
    });
    assert.deepEqual(target.projectGitDirs, []);
  } finally {
    console.warn = warn;
  }
  assert.ok(warnings.some((line) => line.includes('project git directory not opened to the fence')));
});
