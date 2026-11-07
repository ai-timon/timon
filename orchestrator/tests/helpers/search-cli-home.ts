/** Ordinary client metadata fixtures, never credentials or live sign-in evidence. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.HOME = mkdtempSync(join(tmpdir(), 'timon-search-os-home-'));
process.env.USERPROFILE = process.env.HOME;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.CODEX_AUTH_DIR;
writeFileSync(join(process.env.HOME, '.claude.json'), JSON.stringify({
  firstStartTime: '2026-11-07T00:00:00Z', firstStartVersion: '2.1.319', machineID: 'fixture-machine',
  opusProMigrationComplete: true, sonnet1m45MigrationComplete: true, seenNotifications: [],
  hasResetAutoModeOptInForDefaultOffer: true, migrationVersion: 1,
  oauthAccount: { accountUuid: 'fixture-account', organizationUuid: 'fixture-organization' }, projects: {},
}));
