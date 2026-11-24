import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diagnosticCopy, diagnosticRunnerPath, fallbackReport, problemBoxOptions, runDiagnosticRunner, saveReport, showProblem,
  type BoxOptions, type ProblemDeps,
} from './diagnostic-dialog.js';

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'timon-diag-dialog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('OK is first, default and cancel; Windows gets no command links', () => {
  const options = problemBoxOptions({ type: 'error', title: 'Timon', message: 'm', detail: 'd' }, diagnosticCopy('en-US', 'win32'), ['', 'note']);
  assert.deepEqual(options.buttons, ['OK', 'Copy diagnostic', 'Save report', 'Open logs folder']);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  assert.equal(options.noLink, true);
  assert.equal(options.detail, 'd\n\nnote');
  assert.equal(diagnosticCopy('fr-FR', 'darwin').copy, 'Copier le diagnostic');
});

test('on Linux, the copied note says to paste before closing: the clipboard leaves with the app', () => {
  assert.match(diagnosticCopy('en', 'linux').copied, /before clicking OK/);
  assert.doesNotMatch(diagnosticCopy('en', 'win32').copied, /before clicking OK/);
  assert.match(diagnosticCopy('fr', 'linux').copied, /avant de cliquer sur OK/); // french-ok: the French locale under test
});

function deps(over: Partial<ProblemDeps> & Pick<ProblemDeps, 'show'>): ProblemDeps {
  return {
    report: async () => ({ text: 'REPORT', findings: [] }),
    writeClipboard: () => {},
    save: () => '/home/t/.timon/tmp/timon-diagnostic-x.txt',
    showInFolder: () => {},
    openLogs: async () => '',
    log: () => {},
    copy: diagnosticCopy('en', 'win32'),
    ...over,
  };
}

/** Answers boxes in order; records each, with the problem box told apart by its four buttons. */
function script(responses: number[]): { shown: BoxOptions[]; show: ProblemDeps['show'] } {
  const shown: BoxOptions[] = [];
  return { shown, show: async (options) => { shown.push(options); return { response: responses.shift() ?? 0 }; } };
}

test('each action answers in a box of its own, then the problem box comes back until OK', async () => {
  // problem: Copy → copied box OK → problem: Save → saved box OK → problem: Open → problem: OK
  const { shown, show } = script([1, 0, 2, 0, 3, 0]);
  const clipboard: string[] = [];
  const log: string[] = [];
  await showProblem(deps({
    show,
    report: async () => ({ text: 'REPORT', findings: ['The task never ran.'] }),
    writeClipboard: (text) => clipboard.push(text),
    log: (line) => log.push(line),
  }), { type: 'error', title: 'Timon', message: 'The daemon does not answer.', detail: 'Expected at :3010.' });
  assert.deepEqual(shown.map((b) => b.message), [
    'The daemon does not answer.', 'Diagnostic copied',
    'The daemon does not answer.', 'Report saved',
    'The daemon does not answer.', 'The daemon does not answer.',
  ]);
  assert.deepEqual(clipboard, ['REPORT']);
  assert.match(shown[0]!.detail, /What Timon detected:\n• The task never ran\./);
  assert.equal(shown[1]!.type, 'info');
  assert.match(shown[1]!.detail, /copied to the clipboard/);
  assert.deepEqual(shown[1]!.buttons, ['OK']);
  assert.equal(shown[3]!.type, 'info');
  assert.equal(shown[3]!.detail, '/home/t/.timon/tmp/timon-diagnostic-x.txt');
  assert.deepEqual(shown[3]!.buttons, ['OK', 'Show in folder']);
  assert.equal(shown[3]!.cancelId, 0);
  assert.match(log[0]!, /error shown: The daemon does not answer\. — Expected at :3010\./);
  assert.ok(log.some((line) => line.includes('finding: The task never ran.')));
  assert.ok(log.some((line) => /diagnostic report ready in \d+ ms/.test(line)));
  // TODO #478: the copy is logged, and happens while the box is still open.
  assert.ok(log.includes('[desktop] diagnostic copied to the clipboard (6 characters)'), log.join('\n'));
});

test('"Show in folder" selects the saved file in the file manager', async () => {
  const { show } = script([2, 1, 0]);
  const selected: string[] = [];
  await showProblem(deps({ show, showInFolder: (path) => selected.push(path) }), { type: 'error', title: 'Timon', message: 'm', detail: 'd' });
  assert.deepEqual(selected, ['/home/t/.timon/tmp/timon-diagnostic-x.txt']);
});

test('a save that fails gets an error box with the reason', async () => {
  const { shown, show } = script([2, 0, 0]);
  await showProblem(deps({ show, save: () => { throw new Error('EACCES: permission denied'); } }), { type: 'warning', title: 'Timon', message: 'm', detail: 'd' });
  assert.equal(shown[1]!.type, 'error');
  assert.equal(shown[1]!.message, 'Could not save the report');
  assert.equal(shown[1]!.detail, 'EACCES: permission denied');
  assert.match(shown[2]!.detail, /Failed: EACCES/);
});

test('a report that cannot be built says so in an error box instead of copying nothing', async () => {
  const { shown, show } = script([1, 0, 0]);
  await showProblem(deps({
    show,
    report: () => Promise.reject(new Error('disk full')),
    writeClipboard: () => assert.fail('nothing to copy'),
    findingsWaitMs: 10,
  }), { type: 'warning', title: 'Timon', message: 'm', detail: 'd' });
  assert.equal(shown[1]!.message, 'Could not copy the diagnostic');
  assert.equal(shown[1]!.detail, 'disk full');
});

test('a logs folder that will not open gets an error box; one that opens needs none', async () => {
  const { shown, show } = script([3, 3, 0, 0]);
  const answers = ['', 'no file manager'];
  await showProblem(deps({ show, openLogs: async () => answers.shift()! }), { type: 'error', title: 'Timon', message: 'm', detail: 'd' });
  assert.deepEqual(shown.map((b) => b.message), ['m', 'm', 'Could not open the logs folder', 'm']);
  assert.equal(shown[2]!.detail, 'no file manager');
});

test('a click that has to wait shows "Preparing report…", closed by its signal once the report is ready', async () => {
  let finish!: (report: { text: string; findings: string[] }) => void;
  const shown: BoxOptions[] = [];
  const responses = [2, 0, 0];
  const saved: string[] = [];
  await showProblem(deps({
    show: (options) => {
      shown.push(options);
      if (options.signal) {
        setTimeout(() => finish({ text: 'LATE', findings: [] }), 5);
        return new Promise((resolve) => options.signal!.addEventListener('abort', () => resolve({ response: 0 })));
      }
      return Promise.resolve({ response: responses.shift() ?? 0 });
    },
    report: () => new Promise((resolve) => { finish = resolve; }),
    save: (text) => { saved.push(text); return '/r.txt'; },
    findingsWaitMs: 1,
  }), { type: 'error', title: 'Timon', message: 'm', detail: 'd' });
  assert.deepEqual(shown.map((b) => b.message), ['m', 'Preparing report…', 'Report saved', 'm']);
  assert.deepEqual(shown[1]!.buttons, ['Cancel']);
  assert.deepEqual(saved, ['LATE']);
});

test('cancelling "Preparing report…" before the report is ready goes back to the problem box', async () => {
  const { shown, show } = script([1, 0, 0]);
  await showProblem(deps({
    show,
    // A ref'd timer: an unsettled report alone would let the event loop drain.
    report: () => new Promise((resolve) => setTimeout(() => resolve({ text: 'LATE', findings: [] }), 200)),
    writeClipboard: () => assert.fail('nothing to copy yet'),
    findingsWaitMs: 1,
  }), { type: 'error', title: 'Timon', message: 'm', detail: 'd' });
  assert.deepEqual(shown.map((b) => b.message), ['m', 'Preparing report…', 'm']);
});

test('a saved report lands in the logs folder, a fallback report keeps the desktop log newest first', (t) => {
  const home = scratch(t);
  const path = saveReport(home, 'text', new Date(2026, 9, 13, 19, 6, 11));
  assert.equal(path, join(home, 'tmp', 'timon-diagnostic-20261013-190611.txt'));
  assert.equal(readFileSync(path, 'utf8'), 'text');
  writeFileSync(join(home, 'tmp', 'desktop-2026-10-12.log'), 'a\nb\n');
  writeFileSync(join(home, 'tmp', 'desktop-2026-10-13.log'), 'c\n');
  const { text } = fallbackReport({ home, appVersion: '0.1.5', platform: 'win32', error: 'Startup failed.', why: 'runner missing' });
  assert.match(text, /reduced: runner missing/);
  assert.match(text, /== Desktop log \(newest first\) ==\nc\nb\na\n$/);
});

test('the runner is the orchestrator\'s, run with the error, its JSON parsed', async (t) => {
  const resources = scratch(t);
  await assert.rejects(runDiagnosticRunner({ execPath: process.execPath, resourcesPath: resources, env: process.env, error: 'x' }), /not in this build/);
  const runner = diagnosticRunnerPath(resources);
  mkdirSync(join(resources, 'orchestrator', 'dist', 'host'), { recursive: true });
  writeFileSync(runner, "const at = process.argv.indexOf('--error'); process.stdout.write(JSON.stringify({ text: 'R:' + process.argv[at + 1], findings: [{ id: 'a', text: 'F' }] }));");
  const report = await runDiagnosticRunner({ execPath: process.execPath, resourcesPath: resources, env: process.env, error: 'boom' });
  assert.deepEqual(report, { text: 'R:boom', findings: ['F'] });
  writeFileSync(runner, "process.exit(3)");
  await assert.rejects(runDiagnosticRunner({ execPath: process.execPath, resourcesPath: resources, env: process.env, error: 'x' }), /runner failed/);
});
