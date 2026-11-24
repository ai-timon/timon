/**
 * The call that saves an agent says when its shell pre-allow will do nothing:
 * `timon agent update <name> --allowed-tools Bash` on an agent in auto mode is
 * saved, and answered with a warning the CLI prints (`auto-mode-preallow.ts`).
 *
 * Real auth middleware, isolated TIMON_HOME, witness on :0, the operator's
 * daemon token as the caller.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-preallow-warning-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
await mountOfficialProviders();
const { registerRoutes: registerAgentRoutes } = await import('./plugins-bundled/agents/routes.js');
const { loadConfig } = await import('./agent-config.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerAgentRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
test.after(() => { server.closeAllConnections(); server.close(); });

async function call(method: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('Bash in acceptEdits is saved quietly; the switch to auto is saved with a warning', async () => {
  const created = await call('POST', '/api/agents', {
    name: 'preallow-witness', system_prompt: 'witness',
    config: { backend: 'claude', cwd: process.env.TIMON_HOME, permission_mode: 'acceptEdits', allowed_tools: ['Bash'] },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json.warnings, undefined);

  const patched = await call('PATCH', '/api/agents/preallow-witness/config', { permission_mode: 'auto' });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  const warnings = patched.json.warnings as string[];
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /pre-allows Bash but runs in auto mode/);
  // A warning, not a refusal and not a rewrite: the person's values are stored as sent.
  assert.equal(loadConfig('preallow-witness').permission_mode, 'auto');
  assert.deepEqual(loadConfig('preallow-witness').allowed_tools, ['Bash']);

  const narrowed = await call('PATCH', '/api/agents/preallow-witness/config', { allowed_tools: ['Bash(git:*)'] });
  assert.equal(narrowed.status, 200);
  assert.equal(narrowed.json.warnings, undefined, 'a narrow pattern keeps working in auto mode');
});
