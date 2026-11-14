/**
 * Remote MCP tokens: hashed storage, one mission, short life, revoked with the
 * mission, never accepted where an `api_tokens` row is expected.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-remote-mcp-tokens-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { db, dbApi } = await import('../db.js');
const { hashPassword } = await import('../users/password.js');
const {
  hashApiToken, issueMissionDelegateToken, issueMissionApiToken, MissionNotRunningError,
} = await import('../users/api-tokens.js');
const {
  issueRemoteMcpToken, verifyRemoteMcpToken, revalidateRemoteMcpGrant, revokeRemoteMcpToken, scopeAllows,
  RemoteMcpTokenError, REMOTE_MCP_MAX_TTL_MS,
} = await import('./tokens.js');

const ada = createTestAccount(dbApi, {
  email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false,
});

function runningMission(agent = 'ada.agent'): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'remote work', undefined, ada.id);
  return id;
}

test('the plaintext is returned once and only its hash is stored', () => {
  const missionId = runningMission();
  const issued = issueRemoteMcpToken({ missionId, scopes: ['kanban_*'], issuedBy: 'acme' });
  assert.match(issued.token, /^tmcp_[A-Za-z0-9_-]{43}$/);
  const rows = db.prepare(`SELECT * FROM mcp_tokens WHERE id = ?`).all(issued.id) as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(issued.token.slice(5)), 'no part of the plaintext is stored');
  const grant = verifyRemoteMcpToken(issued.token);
  assert.equal(grant?.missionId, missionId);
  assert.equal(grant?.agentName, 'ada.agent');
  assert.deepEqual(grant?.scopes, ['kanban_*']);
});

test('the token is not a REST credential', () => {
  const missionId = runningMission();
  const { token } = issueRemoteMcpToken({ missionId, scopes: ['kanban_list'], issuedBy: 'acme' });
  assert.equal(dbApi.getLiveApiToken(hashApiToken(token)), undefined);
});

test('expired, revoked and finished-mission tokens are refused', () => {
  const missionId = runningMission();
  const now = Date.now();
  const short = issueRemoteMcpToken({ missionId, scopes: ['kanban_list'], ttlMs: 60_000, issuedBy: 'acme', now });
  assert.ok(verifyRemoteMcpToken(short.token, now + 59_000));
  assert.equal(verifyRemoteMcpToken(short.token, now + 60_000), undefined);

  const revoked = issueRemoteMcpToken({ missionId, scopes: ['kanban_list'], issuedBy: 'acme' });
  assert.equal(revokeRemoteMcpToken(revoked.id), true);
  assert.equal(verifyRemoteMcpToken(revoked.token), undefined);

  const ended = issueRemoteMcpToken({ missionId, scopes: ['kanban_list'], issuedBy: 'acme' });
  dbApi.finishMission(missionId, 'completed', 0);
  assert.equal(verifyRemoteMcpToken(ended.token), undefined);
  const left = db.prepare(`SELECT COUNT(*) AS n FROM mcp_tokens WHERE mission_id = ?`).get(missionId) as { n: number };
  assert.equal(left.n, 0, 'finishing the mission deletes its tokens');
});

test('a token is refused for a mission that is not running', () => {
  const missionId = runningMission();
  dbApi.finishMission(missionId, 'completed', 0);
  assert.throws(
    () => issueRemoteMcpToken({ missionId, scopes: ['kanban_list'], issuedBy: 'acme' }),
    (err: unknown) => err instanceof RemoteMcpTokenError && err.code === 'mission_not_running',
  );
});

test('scopes are a closed list and ttl is bounded', () => {
  const missionId = runningMission();
  for (const scopes of [[], ['*'], ['kanban*'], ['Kanban_list'], ['kanban list']]) {
    assert.throws(() => issueRemoteMcpToken({ missionId, scopes, issuedBy: 'acme' }), RemoteMcpTokenError);
  }
  assert.throws(() => issueRemoteMcpToken({ missionId, scopes: ['kanban_list'], ttlMs: REMOTE_MCP_MAX_TTL_MS + 1, issuedBy: 'acme' }), RemoteMcpTokenError);
  assert.throws(() => issueRemoteMcpToken({ missionId, scopes: ['kanban_list'], ttlMs: 1_000, issuedBy: 'acme' }), RemoteMcpTokenError);
  assert.equal(scopeAllows(['kanban_*'], 'kanban_add'), true);
  assert.equal(scopeAllows(['kanban_*'], 'kanbanx'), false);
  assert.equal(scopeAllows(['kanban_list'], 'kanban_add'), false);
  assert.equal(scopeAllows(['memory_rule_add'], 'memory_rule_add'), true);
});

test('a delegate token acts as the mission without revoking the token its process holds', () => {
  const missionId = runningMission();
  const own = issueMissionApiToken(missionId);
  const delegate = issueMissionDelegateToken(missionId, 'remote-mcp:test', 60_000);
  const live = dbApi.getLiveApiToken(delegate.hash);
  assert.equal(live?.user?.id, ada.id);
  assert.equal(live?.token.mission_id, missionId);
  assert.ok(live?.token.expires_at && live.token.expires_at <= Date.now() + 60_000);
  assert.ok(dbApi.getLiveApiToken(hashApiToken(own)), 'the mission keeps its own token');
  dbApi.revokeApiToken(delegate.hash);
  assert.equal(dbApi.getLiveApiToken(delegate.hash), undefined);
});

test('a delegate token is refused for a mission that is not running', () => {
  const missionId = runningMission();
  dbApi.finishMission(missionId, 'completed', 0);
  for (const id of [missionId, randomUUID()]) {
    assert.throws(() => issueMissionDelegateToken(id, 'remote-mcp:test', 60_000), MissionNotRunningError);
  }
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM api_tokens WHERE mission_id = ?`).get(missionId) as { n: number };
  assert.equal(rows.n, 0, 'no row was written');
});

test('a delegate token is refused when the mission runs under another agent than the grant', () => {
  const missionId = runningMission('ada.agent');
  assert.throws(() => issueMissionDelegateToken(missionId, 'remote-mcp:test', 60_000, 'other.agent'), MissionNotRunningError);
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM api_tokens WHERE mission_id = ?`).get(missionId) as { n: number };
  assert.equal(rows.n, 0, 'no row was written');
  const delegate = issueMissionDelegateToken(missionId, 'remote-mcp:test', 60_000, 'ada.agent');
  assert.equal(dbApi.getLiveApiToken(delegate.hash)?.token.mission_id, missionId, 'the right agent still gets one');
  dbApi.revokeApiToken(delegate.hash);
});

test('a verified grant is revalidated against the table at every use', () => {
  const now = Date.now();
  const missionId = runningMission();
  const issued = issueRemoteMcpToken({ missionId, scopes: ['kanban_list'], ttlMs: 60_000, issuedBy: 'acme', now });
  const grant = verifyRemoteMcpToken(issued.token, now)!;
  assert.equal(revalidateRemoteMcpGrant(grant, now + 59_000)?.id, issued.id);
  assert.equal(revalidateRemoteMcpGrant(grant, now + 60_000), undefined, 'expired');

  const moved = issueRemoteMcpToken({ missionId, scopes: ['kanban_list'], issuedBy: 'acme' });
  const movedGrant = verifyRemoteMcpToken(moved.token)!;
  db.prepare(`UPDATE missions SET agent_name = ? WHERE id = ?`).run('ada.other', missionId);
  assert.equal(revalidateRemoteMcpGrant(movedGrant), undefined, 'agent changed');
  db.prepare(`UPDATE missions SET agent_name = ? WHERE id = ?`).run('ada.agent', missionId);
  assert.ok(revalidateRemoteMcpGrant(movedGrant));

  revokeRemoteMcpToken(moved.id);
  assert.equal(revalidateRemoteMcpGrant(movedGrant), undefined, 'revoked');

  const ended = issueRemoteMcpToken({ missionId, scopes: ['kanban_list'], issuedBy: 'acme' });
  const endedGrant = verifyRemoteMcpToken(ended.token)!;
  dbApi.finishMission(missionId, 'completed', 0);
  assert.equal(revalidateRemoteMcpGrant(endedGrant), undefined, 'mission ended');
});
