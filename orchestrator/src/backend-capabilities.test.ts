/**
 * Declared backend capabilities (extension point 5): the product respects
 * what a backend says it cannot do, instead of discovering it by failing:
 *   - a `code` task on a backend without `worktree` is BLOCKED with a reason,
 *     before any worktree is created;
 *   - a chat turn with files on a backend without `attachments` is refused
 *     before a byte reaches the disk;
 *   - the catalogue carries the resolved capabilities, and the product's own
 *     backends keep all of them.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-backend-caps-'));
await import('../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { backendCatalog, backendCapabilities, resolveCapabilities, DEFAULT_BACKEND_CAPABILITIES } = await import('./backends/index.js');
const { capabilityRefusal, blockIfBackendCannot } = await import('./dispatcher.js');
const { chatAttachmentsRoot } = await import('./chat-attachments.js');
const { attachmentsRefusal, ATTACHMENTS_UNSUPPORTED } = await import('./backends/capabilities.js');
const { dbApi } = await import('./db.js');
const { agentDir } = await import('./paths.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes: registerAgentRoutes } = await import('./plugins-bundled/agents/routes.js');
type Dialect = import('./backends/types.js').Dialect;

/** A one-shot dialect standing for an agent that runs somewhere else. */
const remoteDialect: Dialect = {
  defaultCmd: 'echo',
  persistentProcess: false,
  finishMissionOnExit: false,
  sessionResumable: true,
  sessionStore: 'global',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  capabilities: { worktree: false, timonMcp: false, attachments: false, timonPreamble: false },
  async buildSpawn(_opts, profile) {
    return { cmd: profile.cmd, args: [], initialStdin: null };
  },
  writeUserInput() { /* one-shot */ },
  parseLine() { return []; },
  extractSessionId() { return null; },
};

const remoteProfile = {
  id: 'remote-llm',
  dialect: 'remote-proto',
  label: 'Remote LLM',
  custom: true,
  defaultModel: 'remote-1',
  models: [{ slug: 'remote-1', label: 'remote-1' }],
};

registerDialect('caps-plugin', 'remote-proto', remoteDialect);
registerProfile('caps-plugin', remoteProfile);

{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('the product backends keep every capability: nothing changes for claude and codex', () => {
  for (const id of ['claude', 'codex']) {
    assert.deepEqual(backendCapabilities(id), DEFAULT_BACKEND_CAPABILITIES, id);
    const entry = backendCatalog().find((b) => b.id === id);
    assert.ok(entry, `${id} is in the catalogue`);
    assert.deepEqual(entry.capabilities, { worktree: true, timonMcp: true, attachments: true, timonPreamble: true }, id);
  }
});

test('the catalogue carries what a backend declared it cannot do', () => {
  const entry = backendCatalog().find((b) => b.id === 'remote-llm');
  assert.ok(entry);
  assert.deepEqual(entry.capabilities, { worktree: false, timonMcp: false, attachments: false, timonPreamble: false });
  assert.deepEqual(backendCapabilities('remote-llm'), entry.capabilities);
});

test('a profile narrows its dialect and can never widen it', () => {
  assert.deepEqual(
    resolveCapabilities({ capabilities: { worktree: false } }, { capabilities: { worktree: true, attachments: false } }),
    { worktree: false, timonMcp: true, attachments: false, timonPreamble: true },
  );
  assert.deepEqual(resolveCapabilities(undefined, undefined), DEFAULT_BACKEND_CAPABILITIES);
  assert.deepEqual(backendCapabilities('nobody-registered-this'), DEFAULT_BACKEND_CAPABILITIES);
});

test('an unknown capability or a non-boolean value is refused at registration', () => {
  assert.throws(
    () => registerDialect('caps-plugin', 'typo-proto', { ...remoteDialect, capabilities: { worktrees: false } as never }),
    /unknown capability `worktrees`/,
  );
  assert.throws(
    () => registerProfile('caps-plugin', { ...remoteProfile, id: 'typo-llm', capabilities: { worktree: 'no' } as never }),
    /must be a boolean/,
  );
});

test('a code or merge task on a backend without worktree is refused; review and the product backends pass', () => {
  assert.match(capabilityRefusal({ type: 'code' }, 'remote-llm') ?? '', /remote-llm.*worktree/);
  assert.match(capabilityRefusal({ type: 'merge' }, 'remote-llm') ?? '', /worktree/);
  assert.equal(capabilityRefusal({ type: 'review' }, 'remote-llm'), null);
  assert.equal(capabilityRefusal({ type: 'chore' }, 'remote-llm'), null);
  assert.equal(capabilityRefusal({ type: 'code' }, 'claude'), null);
  assert.equal(capabilityRefusal({ type: 'code' }, 'codex'), null);
});

test('a task with attached files is refused on a backend that cannot read this host, whatever its type', () => {
  assert.match(capabilityRefusal({ type: 'review' }, 'remote-llm', 2) ?? '', /remote-llm.*attachments.*2 attached/);
  assert.match(capabilityRefusal({ type: 'chore' }, 'remote-llm', 1) ?? '', /attachments/);
  assert.equal(capabilityRefusal({ type: 'chore' }, 'remote-llm', 0), null);
  assert.equal(capabilityRefusal({ type: 'code' }, 'claude', 3), null);
  const id = randomUUID();
  dbApi.createTask(id, 'Remote chore with a mockup', 'caps.agent', { type: 'chore' });
  assert.equal(blockIfBackendCannot(dbApi.getTask(id)!, 'remote-llm', 1), true);
  assert.match(dbApi.getTask(id)!.blocked_reason ?? '', /attached file/);
  // The webview translates this one (TODO #845).
  assert.deepEqual(JSON.parse(dbApi.getTask(id)!.blocked_reason_code ?? 'null'), {
    code: 'backend_cannot_read_attachments', params: { backend: 'remote-llm', count: 1 },
  });
});

test('the refused task is BLOCKED with its reason, not lost', () => {
  const id = randomUUID();
  dbApi.createTask(id, 'Remote code task', 'caps.agent', { type: 'code' });
  assert.equal(blockIfBackendCannot(dbApi.getTask(id)!, 'remote-llm'), true);
  const task = dbApi.getTask(id)!;
  assert.equal(task.status, 'BLOCKED');
  assert.match(task.blocked_reason ?? '', /worktree/);
  assert.deepEqual(JSON.parse(task.blocked_reason_code ?? 'null'), {
    code: 'backend_cannot_use_worktree', params: { backend: 'remote-llm', type: 'code' },
  });

  const local = randomUUID();
  dbApi.createTask(local, 'Local code task', 'caps.agent', { type: 'code' });
  assert.equal(blockIfBackendCannot(dbApi.getTask(local)!, 'claude'), false);
  assert.notEqual(dbApi.getTask(local)!.status, 'BLOCKED');
});

test('files are refused for a backend without attachments, never for the default ones', () => {
  const files = [{ name: 'report.pdf', data: 'JVBERi0=' }];
  assert.match(attachmentsRefusal('remote-llm', files) ?? '', /does not accept attached files/);
  assert.equal(attachmentsRefusal('remote-llm', []), null, 'no file, nothing to refuse');
  assert.equal(attachmentsRefusal('remote-llm', undefined), null);
  assert.equal(attachmentsRefusal('claude', files), null);
});

test('a spawn with files on a backend without attachments answers 400 and writes nothing', async () => {
  const token = 'caps-daemon-token';
  const agent = 'caps.remote';
  mkdirSync(agentDir(agent), { recursive: true });
  writeFileSync(join(agentDir(agent), 'config.json'), JSON.stringify({ cwd: process.env.TIMON_HOME, backend: 'remote-llm' }));
  writeFileSync(join(agentDir(agent), 'system-prompt.md'), 'Test');

  const app = express();
  app.use(createDaemonAuthMiddleware({ token, required: true }));
  app.use(express.json({ limit: '5mb' }));
  registerAgentRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/agents/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent, mission: 'read this', attachments: [{ name: 'report.pdf', data: 'JVBERi0=' }] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { code?: string; error?: string };
    assert.equal(body.code, ATTACHMENTS_UNSUPPORTED);
    assert.match(body.error ?? '', /remote-llm/);
    assert.equal(existsSync(chatAttachmentsRoot()), false, 'nothing was written on disk');
  } finally {
    server.close();
  }
});
