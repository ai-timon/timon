/**
 * A daemon that stops while an allowed command runs never records its end: at
 * the next start the row is closed as interrupted and the agent is told, so the
 * card does not show a run forever and the agent does not wait for a result.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { dbApi } = await import('../../db.js');
const { interruptStaleRuns, runReportOf, runReply, commandRequestView } = await import('./command-requests.js');

const owner = createTestAccount(dbApi, { email: 'owner@example.com', name: 'owner', passwordHash: 'x', isSuperadmin: true });
dbApi.createMission('m-int', 'timon.coder', 'work', undefined, owner.id);

function allowed(id: string): void {
  dbApi.insertCommandRequest({
    id, mission_id: 'm-int', owner_user_id: owner.id, agent: 'timon.coder', command: 'git push', note: null,
    session_id: null, project: null, mission_title: 't', task_id: null, choices: '["allow","paste","deny"]',
    origin_kind: 'agent', origin_id: null,
  });
  assert.ok(dbApi.settleCommandRequest(id, 'allow'));
}

test('an allowed command with no recorded end is closed as interrupted and the agent is told', () => {
  allowed('r-stale');
  const sent: string[] = [];
  const closed = interruptStaleRuns((_m, text) => sent.push(text), Date.now() + 1000);
  assert.equal(closed, 1);
  const row = dbApi.getCommandRequest('r-stale')!;
  assert.notEqual(row.run_finished_at, null);
  const run = runReportOf(row)!;
  assert.equal(run.exitCode, null);
  assert.equal(commandRequestView(row).running, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /daemon stopped or restarted/);
  assert.match(runReply('git push', run), /may have run partly or entirely/);
  assert.doesNotMatch(runReply('git push', run), /could not run it/);
});

test('a run that began after the process started, or already finished, is left alone', () => {
  allowed('r-live');
  assert.equal(interruptStaleRuns(() => {}, Date.now() - 60_000), 0);
  assert.equal(dbApi.getCommandRequest('r-live')!.run_finished_at, null);
  dbApi.completeCommandRun('r-live', { exitCode: 0, timedOut: false, output: 'ok', durationMs: 5, cwd: null });
  assert.equal(interruptStaleRuns(() => {}, Date.now() + 1000), 0);
  assert.equal(dbApi.getCommandRequest('r-live')!.run_exit_code, 0);
});
