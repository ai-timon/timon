/**
 * A command request is a card of the conversation, rebuilt from the events the
 * daemon persisted: a reload must show it as it was left, and nothing typed at
 * a prompt may hold a character that would run it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyResolution,
  commandScope,
  freshest,
  parseCommandRequest,
  parseCommandResolution,
  pasteIntoTerminal,
  pendingFor,
  shellCardOf,
} from './command-requests';
import type { TerminalOpenRequest } from './terminal-web';

const raw = {
  id: 'r1', missionId: 'm1', agent: 'timon.coder', command: 'sudo systemctl restart nginx', note: 'needs root',
  sessionId: null, project: 'timon', missionTitle: 'Fix nginx', taskId: null, choices: ['allow', 'paste', 'deny'],
  status: 'pending', createdAt: 1, resolvedAt: null,
};

test('a request is read from its event, and a command that could run on its own is dropped', () => {
  const request = parseCommandRequest(raw);
  assert.equal(request?.command, 'sudo systemctl restart nginx');
  assert.deepEqual(request?.choices, ['allow', 'paste', 'deny']);
  assert.equal(parseCommandRequest({ ...raw, command: 'ls\nrm -rf /' }), null);
  assert.equal(parseCommandRequest({ ...raw, command: 'ls x' }), null);
  assert.equal(parseCommandRequest({ ...raw, id: undefined }), null);
  assert.deepEqual(parseCommandRequest({ ...raw, choices: ['paste', 'run', 'deny'] })?.choices, ['paste', 'deny']);
});

test('replayed in order, the request and its outcome rebuild the card in its final state', () => {
  const request = parseCommandRequest(raw)!;
  const resolution = parseCommandResolution({ id: 'r1', status: 'paste', origin: 'ui_card_paste', resolvedAt: 5 })!;
  const after = applyResolution(request, resolution);
  assert.equal(after.status, 'paste');
  assert.equal(after.resolvedAt, 5);
  // A late or duplicated event never changes a decision.
  assert.equal(applyResolution(after, { id: 'r1', status: 'deny', resolvedAt: 9, run: null, running: false }).status, 'paste');
  assert.equal(applyResolution(request, { id: 'other', status: 'deny', resolvedAt: 9, run: null, running: false }).status, 'pending');
  assert.equal(parseCommandResolution({ id: 'r1', status: 'pending' }), null);
});

test('the run of an allowed command follows its decision in a second event', () => {
  const request = parseCommandRequest(raw)!;
  const first = applyResolution(request, parseCommandResolution({ id: 'r1', status: 'allow', resolvedAt: 5, running: true })!);
  assert.equal(first.status, 'allow');
  assert.equal(first.running, true);
  assert.equal(first.run, null);
  const second = applyResolution(first, parseCommandResolution({
    id: 'r1', status: 'allow', resolvedAt: 5, running: false,
    run: { exitCode: 3, timedOut: false, output: 'boom', durationMs: 1200, notRun: false },
  })!);
  assert.equal(second.running, false);
  assert.equal(second.run?.exitCode, 3);
  assert.equal(second.run?.output, 'boom');
  // Replayed again, or a different decision: nothing moves.
  assert.equal(applyResolution(second, { id: 'r1', status: 'allow', resolvedAt: 5, running: false, run: { ...second.run!, exitCode: 0 } }).run?.exitCode, 3);
  assert.equal(applyResolution(second, { id: 'r1', status: 'deny', resolvedAt: 9, running: false, run: null }).status, 'allow');
  // A row with no run (paste, dismiss, older daemon) reads as not running.
  assert.deepEqual([parseCommandRequest(raw)!.run, parseCommandRequest(raw)!.running], [null, false]);
});

test('a pending card takes the buttons the daemon offers now; a decided one keeps its decision', () => {
  const replayed = parseCommandRequest(raw)!;
  const listed = { ...replayed, choices: ['paste', 'deny'] as const };
  assert.deepEqual(freshest(replayed, { ...listed, choices: [...listed.choices] }).choices, ['paste', 'deny']);
  const decided = { ...replayed, status: 'deny' as const };
  assert.equal(freshest(decided, { ...replayed }).status, 'deny');
  assert.equal(freshest(replayed, null), replayed);
});

test('a request goes to the terminal of its project, else of its own agent', () => {
  assert.deepEqual(commandScope({ project: 'timon', agent: 'a' }), { kind: 'project', slug: 'timon' });
  assert.deepEqual(commandScope({ project: null, agent: 'alice' }), { kind: 'agent', name: 'alice' });
});

test('paste records the decision first, then types the command without Enter', async () => {
  const calls: string[] = [];
  let opened: TerminalOpenRequest | null = null;
  const outcome = await pasteIntoTerminal({
    resolve: async () => { calls.push('resolve'); return true; },
    scope: { kind: 'project', slug: 'timon' },
    command: 'sudo make install',
    open: (request) => { calls.push('open'); opened = request; return true; },
  });
  assert.deepEqual(outcome, { kind: 'pasted' });
  assert.deepEqual(calls, ['resolve', 'open']);
  assert.deepEqual(opened, { scope: { kind: 'project', slug: 'timon' }, insert: 'sudo make install' });
});

test('paste opens nothing when the decision was not recorded, and says when the window refused', async () => {
  let opens = 0;
  const open = () => { opens += 1; return false; };
  assert.deepEqual(await pasteIntoTerminal({ resolve: async () => false, scope: null, command: 'x', open }), { kind: 'not_resolved' });
  assert.equal(opens, 0);
  assert.deepEqual(await pasteIntoTerminal({ resolve: async () => true, scope: null, command: 'x', open }), { kind: 'window_refused' });
});

test('a permission card offers paste only for a one-line command the daemon marked pasteable', () => {
  assert.deepEqual(shellCardOf({ shell_command: 'npm test', choices: ['allow', 'paste', 'deny'] }), { shell_command: 'npm test', choices: ['allow', 'paste', 'deny'] });
  assert.equal(shellCardOf({ shell_command: 'npm test' }), null);
  assert.equal(shellCardOf({ shell_command: 'npm test', choices: ['allow', 'deny'] }), null);
  assert.equal(shellCardOf({ shell_command: 'a\nb', choices: ['paste'] }), null);
});

test('the badge counts a project\'s pending requests whatever the case of its slug', () => {
  const pending = { total: 3, projects: [{ project: 'Timon', pending: 2 }, { project: null, pending: 1 }] };
  assert.equal(pendingFor(pending, 'timon'), 2);
  assert.equal(pendingFor(pending, 'globex'), 0);
});
