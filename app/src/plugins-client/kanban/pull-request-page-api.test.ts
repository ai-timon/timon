/**
 * The logic the pull request's window keeps out of its component: the diff
 * cut by file, review threads placed under their line, the addresses it may
 * link to, and the markdown of a text written on the forge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSeconds, forgeHref, forgeMarkdownHtml, placeThreads, splitDiffByFile, type PageThread,
} from './pull-request-page-api';

const DIFF = [
  'diff --git a/src/theme.ts b/src/theme.ts',
  'index 1..2 100644',
  '--- a/src/theme.ts',
  '+++ b/src/theme.ts',
  '@@ -10,3 +10,4 @@ export',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
  'diff --git a/old.md b/old.md',
  'deleted file mode 100644',
  '--- a/old.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
].join('\n');

test('a diff is cut by file, keyed by its path', () => {
  const files = splitDiffByFile(DIFF);
  assert.deepEqual([...files.keys()], ['src/theme.ts', 'old.md']);
  assert.match(files.get('src/theme.ts')!, /\+const c = 4;/);
  assert.doesNotMatch(files.get('src/theme.ts')!, /gone/);
  assert.match(files.get('old.md')!, /-gone/);
});

const thread = (extra: Partial<PageThread>): PageThread => ({
  path: 'src/theme.ts', line: 11, resolved: false, outdated: false, comments: [], commentsMore: 0, ...extra,
});

test('a thread sits under the line of the new file it was written on', () => {
  const lines = splitDiffByFile(DIFF).get('src/theme.ts')!.split('\n');
  const onB = thread({ line: 11 });
  const onD = thread({ line: 13 });
  const elsewhere = thread({ line: 99 });
  const outdated = thread({ line: 11, outdated: true });
  const { at, unplaced } = placeThreads(lines, [onB, onD, elsewhere, outdated]);
  assert.equal(lines[[...at.entries()].find(([, ts]) => ts.includes(onB))![0]], '+const b = 3;');
  assert.equal(lines[[...at.entries()].find(([, ts]) => ts.includes(onD))![0]], ' const d = 5;');
  assert.deepEqual(unplaced, [elsewhere, outdated]);
});

test('only an https address on a GitHub host is linked', () => {
  assert.equal(forgeHref('https://github.com/acme/widgets/pull/1'), 'https://github.com/acme/widgets/pull/1');
  assert.equal(forgeHref('http://github.com/acme'), null);
  assert.equal(forgeHref('javascript:alert(1)'), null);
  assert.equal(forgeHref('https://github.com.evil.example/'), null);
  assert.equal(forgeHref(null), null);
});

test('a check\'s duration comes from its timing, when it finished', () => {
  const base = { name: 'test', status: 'pass' as const, url: null, workflow: null };
  assert.equal(checkSeconds({ ...base, startedAt: '2026-11-17T09:01:00Z', completedAt: '2026-11-17T09:04:30Z' }), 210);
  assert.equal(checkSeconds({ ...base, startedAt: '2026-11-17T09:01:00Z', completedAt: null }), null);
});

test('markdown from the forge keeps no raw HTML, and a link leaves only for http(s), apart from the app', async () => {
  const { JSDOM } = await import('jsdom');
  const html = forgeMarkdownHtml([
    '## Why',
    '',
    '<!-- template comment -->',
    '<script>alert(1)</script> <img src=x onerror=alert(1)> <b>bold?</b>',
    '',
    '[docs](https://example.com/docs) [bad](javascript:alert(1)) [local](/etc/passwd)',
  ].join('\n'));
  const doc = new JSDOM(`<div>${html}</div>`).window.document;
  assert.ok(!doc.querySelector('script'));
  assert.ok(!doc.querySelector('img'));
  assert.ok(!doc.querySelector('b'), 'raw HTML is not rendered');
  // Its tags are dropped, its text kept.
  assert.match(doc.body.textContent ?? '', /bold\?/);
  assert.doesNotMatch(doc.body.textContent ?? '', /<b>|onerror/);
  assert.doesNotMatch(doc.body.textContent ?? '', /template comment/);
  const links = Array.from(doc.querySelectorAll('a'));
  assert.deepEqual(links.map((a) => a.getAttribute('href')), ['https://example.com/docs']);
  assert.equal(links[0]!.getAttribute('target'), '_blank');
  assert.match(links[0]!.getAttribute('rel') ?? '', /noopener/);
  assert.match(links[0]!.getAttribute('rel') ?? '', /noreferrer/);
  assert.match(doc.body.textContent ?? '', /bad/);
  assert.equal(forgeMarkdownHtml('   '), '');
  // A bot's signature, as GitHub's CLA action writes it.
  const bot = new JSDOM(`<div>${forgeMarkdownHtml('All signed.<br/><sub>Posted by the **CLA Assistant**</sub>')}</div>`).window.document;
  assert.ok(!bot.querySelector('sub'));
  assert.match(bot.body.textContent ?? '', /All signed\. Posted by the CLA Assistant/);
});
