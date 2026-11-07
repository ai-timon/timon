/** Normal mission startup, including init persistence/discovery, with realistic
 * client metadata. The child emits fixture protocol events; no inference runs. */
import './test-home.js';
import { linuxSearch } from '../tests/helpers/search-cli-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mountOfficialProviders } from '../tests/helpers/official-providers.js';
import { installedProgram } from '../tests/helpers/witness-cli.js';
import { PARALLEL_SEARCH_KEY, PARALLEL_SEARCH_TOOL } from './web-search.js';
import { invalidateSettingsCache } from './settings.js';
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
await mountOfficialProviders();
installedProgram('claude');
const { spawnAgent, upsertAgent, killAgent, isRunning } = await import('./agent.js');
const { getHost } = await import('./host/index.js');
const { dbApi } = await import('./db.js');
const { listMcp, defaultExcludedMcpIds, refreshToolsCacheFromInit } = await import('./mcp.js');
const cwd = join(process.env.TIMON_HOME!, 'work');
mkdirSync(cwd, { recursive: true });

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('normal mission startup did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('ordinary Claude startup routes with metadata, persists host provenance and preserves same-name custom exclusions', linuxSearch, async () => {
  const host = getHost();
  const original = host.spawn;
  const launches: string[][] = [];
  host.spawn = ((_cmd, args) => {
    launches.push(args as string[]);
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4246;
    child.kill = (() => { setImmediate(() => { child.emit('exit', 0, 'SIGTERM'); child.emit('close', 0, 'SIGTERM'); }); return true; }) as typeof child.kill;
    setImmediate(() => {
      child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fixture-startup',
        tools: [PARALLEL_SEARCH_TOOL], mcp_servers: [{ name: PARALLEL_SEARCH_KEY, status: 'connected' }],
        timon_injected_mcp_servers: ['untrusted-cli-claim'],
      }) + '\n');
      child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'Fixture answer.', is_error: false }) + '\n');
    });
    return child;
  }) as typeof host.spawn;
  let mission: string | undefined;
  try {
    for (const mode of [undefined, 'parallel', 'custom'] as const) {
      if (mode === 'parallel') process.env.TIMON_WEB_SEARCH_PROVIDER = mode;
      else delete process.env.TIMON_WEB_SEARCH_PROVIDER;
      invalidateSettingsCache();
      const custom = mode === 'custom';
      if (custom) {
        const file = join(process.env.HOME!, '.claude.json');
        const metadata = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file, JSON.stringify({ ...metadata, mcpServers: { [PARALLEL_SEARCH_KEY]: { type: 'http', url: 'https://example.com/custom' } } }));
        // Discovered from the user's own CLI, without a host-injected marker.
        refreshToolsCacheFromInit({ mcp_servers: [{ name: PARALLEL_SEARCH_KEY, status: 'connected' }] });
        assert.ok(defaultExcludedMcpIds().includes(`ext-${PARALLEL_SEARCH_KEY}`));
      }
      upsertAgent({ name: 'search-startup', system_prompt: 'Fixture research task.', config: {
        backend: 'claude', cwd, skills: [], memory_scope: 'NONE', permission_mode: 'default',
        ...(custom ? { excluded_mcp_servers: [`ext-${PARALLEL_SEARCH_KEY}`] } : {}),
      } });
      mission = await spawnAgent('search-startup', 'Research the fixture.');
      await until(() => dbApi.listEvents(mission!).some((event) => event.type === 'system'));
      const init = JSON.parse(dbApi.listEvents(mission).find((event) => event.type === 'system')!.payload);
      assert.deepEqual(init.timon_injected_mcp_servers, custom ? [] : [PARALLEL_SEARCH_KEY]);
      const args = launches.at(-1)!;
      const servers = JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers;
      if (custom) {
        assert.equal(servers[PARALLEL_SEARCH_KEY], undefined);
        assert.ok(args[args.indexOf('--disallowedTools') + 1]!.includes(`mcp__${PARALLEL_SEARCH_KEY}`));
        assert.ok(listMcp().some((server) => server.id === `ext-${PARALLEL_SEARCH_KEY}`));
      } else {
        assert.equal(servers[PARALLEL_SEARCH_KEY].url, 'https://mcp.parallel.ai/mcp?tools=web_search');
        assert.ok(args[args.indexOf('--disallowedTools') + 1]!.split(',').includes('WebSearch'));
        refreshToolsCacheFromInit(dbApi.getLatestInitPayload());
        assert.equal(listMcp().some((server) => server.id === `ext-${PARALLEL_SEARCH_KEY}`), false);
      }
      killAgent(mission, { source: 'test' });
      await until(() => !isRunning(mission!));
      mission = undefined;
    }
  } finally {
    if (mission) killAgent(mission, { source: 'test' });
    host.spawn = original;
    delete process.env.TIMON_WEB_SEARCH_PROVIDER;
    invalidateSettingsCache();
  }
});
