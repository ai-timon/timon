import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIMON_HOME } from '../paths.js';
import { getBackend } from './index.js';
import { mountOfficialProviders, stubCliBinaries, buildUnderSeal } from '../../tests/helpers/official-providers.js';

await stubCliBinaries('grok');
await mountOfficialProviders();

process.env.CODEX_AUTH_DIR = join(TIMON_HOME, 'codex-auth');
mkdirSync(process.env.CODEX_AUTH_DIR, { recursive: true });
writeFileSync(join(process.env.CODEX_AUTH_DIR, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
for (const backend of ['claude', 'codex', 'grok']) {
  for (const profileId of [null, `bp-${randomUUID()}`]) {
    test(`${backend} adds the mission-bound browser MCP next to the user's chrome-devtools (profile=${profileId === null ? 'disabled' : 'assigned'})`, async () => {
      mkdirSync(join(TIMON_HOME, 'mcp'), { recursive: true });
      writeFileSync(join(TIMON_HOME, 'mcp', 'legacy-chrome.json'), JSON.stringify({
        id: 'legacy-chrome', name: 'chrome-devtools', transport: { type: 'stdio', command: 'unsafe-local-chrome', args: [] },
      }));
      const missionId = randomUUID();
      const build = (opts: import('./types.js').BuildSpawnOpts) => buildUnderSeal(backend, opts);
      const spec = await build({
        agentName: 'browser-test', systemPrompt: 'Test', message: 'Test', resumeSession: null, missionId,
        cfg: { browser_profile_id: profileId, mcp_servers: ['legacy-chrome'] },
      });
      if (backend === 'claude') {
        const raw = spec.args[spec.args.indexOf('--mcp-config') + 1]!;
        const config = readFileSync(raw, 'utf8');
        const entry = JSON.parse(config).mcpServers['timon-browser'];
        assert.equal(entry.command, process.execPath);
        assert.ok(entry.args[0].endsWith('/bin/browser-mcp.mjs'));
        assert.ok(entry.env.TIMON_ORCH_URL);
        assert.ok(config.includes('unsafe-local-chrome'), 'the user\'s own chrome-devtools stays');
      } else {
        const root = spec.env?.[backend === 'codex' ? 'CODEX_HOME' : 'GROK_HOME'];
        assert.ok(root);
        const config = readFileSync(join(root, 'config.toml'), 'utf8');
        assert.equal(config.match(/^\[mcp_servers.timon-browser\]$/gm)?.length, 1);
        assert.match(config, /\/bin\/browser-mcp\.mjs/);
        assert.ok(config.includes('unsafe-local-chrome'), 'the user\'s own chrome-devtools stays');
        const environment = config.split(/^\[/m).find((chunk) => chunk.startsWith('mcp_servers.timon-browser.env]'))!;
        assert.ok(environment.includes(`TIMON_MISSION_ID = "${missionId}"`));
        assert.ok(environment.includes('TIMON_ORCH_URL'));
        if (backend === 'codex') assert.ok(config.includes('env_vars = ["TIMON_API_TOKEN", '));
      }
    });
  }
}
