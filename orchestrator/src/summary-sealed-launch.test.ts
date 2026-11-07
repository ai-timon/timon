/**
 * A one-shot prompt (compaction, backend-switch summary, mission titles, memory
 * jobs, Dreaming) runs under a throwaway launch seal, like a mission's launch:
 * a provider plugin asks `ctx.provider.scratch` and `ctx.provider.mcp` from its
 * `buildSpawn`, and both refused a one-shot before (regression of af2f7573,
 * "ctx.provider.scratch needs a launch in progress"). The seal and the scratch
 * folder go with the launch, however it ends; and the one-shot is handed none of
 * Timon's servers, which would otherwise fall back to the daemon-token.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import type { BackendEvent, BuildSpawnOpts, Dialect } from './backends/types.js';

await import('../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
await mountOfficialProviders();
const { installedProgram } = await import('../tests/helpers/witness-cli.js');
// The provider's CLI is installed and authorized: a third party's launch is compared with what was (TODO #531).
installedProgram('acme-oneshot-cli');
const { getHost } = await import('./host/index.js');
const { oneShotPrompt } = await import('./summary.js');
const { sealFor, SealedEnvError } = await import('./backends/launch-seal.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { readManifest } = await import('./plugins/manifest.js');
const { createPluginContext, daemonHost } = await import('./plugins/context.js');
type AgentConfig = import('./agent.js').AgentConfig;

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4245;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (child.killed) return true;
    child.killed = true;
    setImmediate(() => { child.emit('exit', null, signal ?? null); child.emit('close', null, signal ?? null); });
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

type Spawned = { cmd: string; args: string[]; env: NodeJS.ProcessEnv; stdin: string };

/** Runs `fn` with the host's spawn replaced: the fake CLI prints `lines`, then exits unless `hang`. */
async function withFakeCli<T>(lines: string[], fn: (spawned: Spawned[], during: Array<() => void>) => Promise<T>, hang = false): Promise<T> {
  const host = getHost();
  const original = host.spawn;
  const spawned: Spawned[] = [];
  const during: Array<() => void> = [];
  host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const child = fakeChild();
    const record: Spawned = { cmd, args, env: (opts?.env ?? {}) as NodeJS.ProcessEnv, stdin: '' };
    spawned.push(record);
    child.stdin.on('data', (chunk: Buffer) => { record.stdin += chunk.toString('utf8'); });
    // What must hold while the CLI is alive (its folder, its seal) is checked here.
    for (const check of during) check();
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${line}\n`);
      if (!hang) setImmediate(() => { if (!child.killed) { child.emit('exit', 0, null); child.emit('close', 0, null); } });
    });
    return child;
  }) as typeof host.spawn;
  try {
    return await fn(spawned, during);
  } finally {
    host.spawn = original;
  }
}

/* ── The official Claude provider: the regression as the user met it ─────────── */

const CLAUDE_ANSWER = [
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The summary.' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'The summary.' }),
];

const claudeCfg = { backend: 'claude', model: 'sonnet', cwd: tmpdir() } as AgentConfig;

function claudeScratch(args: string[]): string {
  return dirname(args[args.indexOf('--append-system-prompt-file') + 1]!);
}

test('Claude: a one-shot runs under a seal, with no built-in tool and none of Timon\'s servers, and leaves nothing behind', async () => {
  await withFakeCli(CLAUDE_ANSWER, async (spawned, during) => {
    let alive: { folder: boolean; sealed: boolean } | null = null;
    during.push(() => {
      const folder = claudeScratch(spawned[0]!.args);
      alive = { folder: existsSync(folder), sealed: sealFor(basename(folder)) !== undefined };
    });
    const out = await oneShotPrompt('acme.summarizer', claudeCfg, 'Summarize this.', 'Be brief.');
    assert.equal(out, 'The summary.');
    const { args } = spawned[0]!;
    assert.deepEqual(alive, { folder: true, sealed: true }, 'the CLI starts with its folder and its seal');
    const folder = claudeScratch(args);
    assert.equal(existsSync(folder), false, 'the scratch folder is removed once the CLI is done');
    assert.equal(sealFor(basename(folder)), undefined, 'the seal is closed');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
    assert.ok(args.includes('--tools=') && args.includes('--strict-mcp-config'), 'no built-in tool, no account connector');
    const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]!) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(mcp.mcpServers), [], 'no Timon server: without a token, it would fall back to the daemon-token');
    assert.equal(args.includes('--permission-prompt-tool'), false);
    assert.equal(spawned[0]!.env.TIMON_API_TOKEN, undefined, 'a one-shot holds no token');
    assert.equal(args.some((arg) => arg.includes('timon-seal-')), false);
  });
});

test('Claude: a one-shot that asks for a tool keeps it, in plan mode, still without Timon\'s servers', async () => {
  await withFakeCli(CLAUDE_ANSWER, async (spawned) => {
    await oneShotPrompt('acme.dreamer', claudeCfg, 'Look around.', 'Be brief.', ['WebSearch', 'WebFetch']);
    const { args } = spawned[0]!;
    assert.equal(args.includes('--tools='), false);
    assert.match(args[args.indexOf('--allowedTools') + 1]!, /(^|,)WebSearch(,|$)/);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
    const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]!) as { mcpServers: Record<string, unknown> };
    assert.equal('timon' in mcp.mcpServers || 'timon_ask' in mcp.mcpServers, false);
    assert.equal(existsSync(claudeScratch(args)), false);
  });
});

/* ── A provider plugin of a third party: every way a one-shot can end ───── */

const OWNER = 'acme-oneshot';
const manifest = readManifest({ timon: { id: OWNER, apiVersion: 12, permissions: ['backends:register'] } });
if (!manifest.ok) throw new Error('unreachable');
const ctx = createPluginContext(new Context(), { manifest: manifest.manifest, version: '1.0.0' }, daemonHost());

const plugin = {
  mode: 'ok' as 'ok' | 'throw' | 'env-ref',
  seen: [] as Array<{ folder: string; opts: BuildSpawnOpts; roles: string[] }>,
};

const dialect: Dialect = {
  defaultCmd: 'acme-oneshot-cli',
  persistentProcess: false,
  finishMissionOnExit: false,
  sessionResumable: false,
  sessionStore: 'per-mission',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  async buildSpawn(opts, profile) {
    const scratch = await ctx.provider.scratch.mission(opts);
    const file = scratch.writeFile('system-prompt.md', opts.systemPrompt);
    const plan = await ctx.provider.mcp(opts);
    plugin.seen.push({ folder: scratch.path, opts, roles: plan.servers.map((s) => s.role) });
    if (plugin.mode === 'throw') throw new Error('the plugin gave up');
    const env = { ...profile.env, ...(plugin.mode === 'env-ref' ? { ACME_TOKEN: plan.identityEnv.TIMON_API_TOKEN ?? '' } : {}) };
    return { cmd: profile.cmd, args: ['--prompt-file', file], env, cwd: opts.cfg.cwd, initialStdin: opts.message };
  },
  writeUserInput() { /* one-shot: the prompt is on stdin */ },
  parseLine(line): BackendEvent[] {
    const parsed = JSON.parse(line) as { text?: string; done?: boolean };
    if (parsed.text) return [{ type: 'assistant', payload: { message: { content: [{ type: 'text', text: parsed.text }] } } }];
    if (parsed.done) return [{ type: 'result', payload: { is_error: false } }];
    return [];
  },
  extractSessionId: () => null,
};
registerDialect(OWNER, 'acme-oneshot', dialect);
registerProfile(OWNER, { id: 'acme-oneshot-profile', label: 'Acme', vendor: 'Acme', dialect: 'acme-oneshot', models: [], defaultModel: null });

const pluginCfg = { backend: 'acme-oneshot-profile', cwd: tmpdir() } as AgentConfig;
const ANSWER = [JSON.stringify({ text: 'Title' }), JSON.stringify({ done: true })];

function lastLaunch(): { folder: string; opts: BuildSpawnOpts; roles: string[] } {
  return plugin.seen.at(-1)!;
}

function assertReleased(): void {
  const { folder, opts } = lastLaunch();
  assert.equal(existsSync(folder), false, 'the scratch folder is removed');
  assert.equal(sealFor(opts.missionId), undefined, 'the seal is closed');
}

test('plugin: scratch.mission and mcp answer inside a one-shot; the folder and the seal go with it', async () => {
  plugin.mode = 'ok';
  await withFakeCli(ANSWER, async (spawned, during) => {
    let prompt = '';
    during.push(() => { prompt = readFileSync(spawned[0]!.args[1]!, 'utf8'); });
    assert.equal(await oneShotPrompt('acme.titler', pluginCfg, 'Name this.', 'Titles only.'), 'Title');
    assert.equal(prompt, 'Titles only.', 'the file the plugin wrote is there while its CLI runs');
    assert.equal(spawned[0]!.stdin, 'Name this.');
  });
  const { opts, roles } = lastLaunch();
  assert.equal(opts.timonMcp, false);
  assert.equal(opts.cfg.permission_mode, 'plan');
  assert.equal(opts.readOnlyTools, undefined, 'a third-party dialect is not trusted to honour it');
  assert.equal(roles.includes('timon') || roles.includes('forms'), false);
  assertReleased();
});

test('plugin: a buildSpawn that fails releases the seal and the folder', async () => {
  plugin.mode = 'throw';
  await withFakeCli(ANSWER, async (spawned) => {
    await assert.rejects(oneShotPrompt('acme.titler', pluginCfg, 'Name this.', 'Titles only.'), /the plugin gave up/);
    assert.equal(spawned.length, 0);
  });
  assertReleased();
});

test('plugin: a reference in the environment is refused, and released', async () => {
  plugin.mode = 'env-ref';
  await withFakeCli(ANSWER, async (spawned) => {
    await assert.rejects(oneShotPrompt('acme.titler', pluginCfg, 'Name this.', 'Titles only.'), SealedEnvError);
    assert.equal(spawned.length, 0);
  });
  assertReleased();
});

test('plugin: a CLI that dies without a result releases the seal and the folder', async () => {
  plugin.mode = 'ok';
  await withFakeCli([], async () => {
    await assert.rejects(oneShotPrompt('acme.titler', pluginCfg, 'Name this.', 'Titles only.'), /exited without result/);
  });
  assertReleased();
});

test('plugin: a one-shot past its timeout is killed and released', async () => {
  plugin.mode = 'ok';
  await withFakeCli([], async () => {
    await assert.rejects(oneShotPrompt('acme.titler', pluginCfg, 'Name this.', 'Titles only.', undefined, 50), /timeout/);
    await new Promise((resolve) => setImmediate(resolve));
  }, true);
  assertReleased();
});


test('Dreaming opportunity pass uses the sealed search-only launch and persists fixture sources', async () => {
  const { invalidateSettingsCache } = await import('./settings.js');
  const { runDreamPass } = await import('./dreaming.js');
  const { dbApi } = await import('./db.js');
  process.env.TIMON_DREAM_IMPROVE_TOP_N = '0';
  process.env.TIMON_DREAM_SPACING_MS = '1';
  process.env.TIMON_DREAM_OPP_MAX = '1';
  invalidateSettingsCache();
  const sources = ['https://example.com/fixture-source'];
  const output = JSON.stringify([{ title: 'Synthetic opportunity', body: 'A fixture proposal.', sources }]);
  const lines = [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: output }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: output })];
  await withFakeCli(lines, async (spawned) => {
    assert.deepEqual(await runDreamPass(), { improve: 0, opportunity: 1 });
    assert.equal(spawned.length, 1);
    const { args, env } = spawned[0]!;
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(env.TIMON_API_TOKEN, undefined);
    const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
    assert.deepEqual(Object.keys(mcp.mcpServers), ['timon-parallel-search']);
    assert.match(args[args.indexOf('--disallowedTools') + 1]!, /WebSearch/);
    const proposal = dbApi.listDreamProposals({ kind: 'opportunity' }).find(row => row.title === 'Synthetic opportunity');
    assert.deepEqual(JSON.parse(proposal!.sources!), sources);
  });
  for (const mode of ['off', undefined]) {
    if (mode) process.env.TIMON_WEB_SEARCH_PROVIDER = mode;
    else { delete process.env.TIMON_WEB_SEARCH_PROVIDER; process.env.TIMON_DREAM_OPP_MAX = '0'; }
    invalidateSettingsCache();
    await withFakeCli(lines, async (spawned) => {
      assert.deepEqual(await runDreamPass(), { improve: 0, opportunity: 0 });
      assert.equal(spawned.length, 0);
    });
  }
});

test('one-shot search preserves the original agent denial and fetch domain rule', async () => {
  const { invalidateSettingsCache } = await import('./settings.js');
  delete process.env.TIMON_WEB_SEARCH_PROVIDER;
  invalidateSettingsCache();
  await withFakeCli(CLAUDE_ANSWER, async (spawned) => {
    await oneShotPrompt('acme.dreamer', { ...claudeCfg, disallowed_tools: ['WebSearch', 'WebFetch(domain:private.example)'] },
      'Research.', 'Cite sources.', ['WebSearch', 'WebFetch']);
    const { args } = spawned[0]!;
    const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
    assert.deepEqual(mcp.mcpServers, {});
    assert.ok(args[args.indexOf('--disallowedTools') + 1]!.includes('WebFetch(domain:private.example)'));
  });
});


test('one-shot callers cannot broaden a scoped search preapproval', async () => {
  await withFakeCli([], async (spawned) => {
    await assert.rejects(oneShotPrompt('scoped', { ...claudeCfg, allowed_tools: ['WebSearch(domain:example.com)'] },
      'Research.', 'Cite sources.', ['WebSearch']), /scoped search grant/);
    assert.equal(spawned.length, 0);
  });
});
