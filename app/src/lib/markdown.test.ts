import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { highlightCode, loadHighlighter, splitHighlightedLines, mdToSafeHtml } from './markdown';
import DOMPurify from 'isomorphic-dompurify';
import { resolveFileLink } from './file-links';

test('copy buttons use real link targets for Markdown links, automatic URLs and HTML links', () => {
  const html = mdToSafeHtml('[Documentation](https://example.test/a?q=1&x=2)\n\nhttps://example.test/b\n\n<a href="https://example.test/c?q=1&amp;x=2">Site</a>', { copyLinks: true });
  const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
  const links = Array.from(fragment.querySelectorAll('a'));
  assert.equal(links.length, 3);
  for (const link of links) {
    const button = link.nextElementSibling;
    assert.equal(button?.tagName, 'BUTTON');
    assert.equal(button?.getAttribute('data-copy'), link.getAttribute('href'));
    assert.equal(button?.getAttribute('type'), 'button');
    assert.equal(button?.getAttribute('aria-label'), 'Copy URL');
  }
  assert.equal(links[0]!.textContent, 'Documentation');
  assert.equal(links[2]!.nextElementSibling?.getAttribute('data-copy'), 'https://example.test/c?q=1&x=2');
});

test('copy decoration is opt-in and never makes unsafe or code URLs actionable', () => {
  assert.doesNotMatch(mdToSafeHtml('https://example.test'), /url-copy/);
  const html = mdToSafeHtml('[Bad](javascript:alert%281%29)\n\n`https://example.test`\n\n<a href="javascript:alert(1)" onclick="alert(1)">Bad</a>', { copyLinks: true });
  assert.doesNotMatch(html, /url-copy|javascript:|onclick/);
});

test('Markdown tables retain semantics inside a keyboard-accessible horizontal scroller', () => {
  const html = mdToSafeHtml('| Feature | A | B |\n| --- | --- | --- |\n| **Speed** | Fast | Slow |');
  assert.match(html, /class="markdown-table-scroll"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /role="region"/);
  assert.match(html, /<table>/);
  assert.match(html, /<thead>/);
  assert.match(html, /<strong>Speed<\/strong>/);
  assert.equal((html.match(/markdown-table-scroll/g) ?? []).length, 1);
});

test('splitHighlightedLines closes and reopens the spans that straddle lines', () => {
  // The case that motivates the function: a multi-line string. Without splitting,
  // the <span> would stay open and recolour the whole rest of the file.
  assert.deepEqual(
    splitHighlightedLines('<span class="hljs-string">"a\nb"</span>\nreste'),
    ['<span class="hljs-string">"a</span>', '<span class="hljs-string">b"</span>', 'reste'],
  );
});

test('splitHighlightedLines returns one line per source line', () => {
  assert.deepEqual(splitHighlightedLines('a\nb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(splitHighlightedLines(''), ['']);
  // Final break: a last empty line, as in an editor.
  assert.deepEqual(splitHighlightedLines('a\n'), ['a', '']);
});

test('splitHighlightedLines handles nested spans', () => {
  const lines = splitHighlightedLines(
    '<span class="a"><span class="b">x\ny</span></span>',
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '<span class="a"><span class="b">x</span></span>');
  assert.equal(lines[1], '<span class="a"><span class="b">y</span></span>');
});

test('highlightCode colours a registered language and escapes the rest', async () => {
  await loadHighlighter();
  const json = highlightCode('{"a": 1}', 'json');
  assert.match(json, /hljs-attr/);
  // Unknown language: no made-up colouring, but safe HTML.
  const unknownLang = highlightCode('<script>alert(1)</script>', 'klingon');
  assert.doesNotMatch(unknownLang, /<script>/);
});

test('highlightCode covers the languages added for the file preview', async () => {
  await loadHighlighter();
  // Regression: these grammars were not registered, and a .env or a
  // Dockerfile came out as plain text.
  assert.match(highlightCode('KEY=valeur', 'ini'), /hljs-/);
  assert.match(highlightCode('FROM node:22\nRUN npm ci', 'dockerfile'), /hljs-/);
  assert.match(highlightCode('<?php echo 1; ?>', 'php'), /hljs-/);
});

// TIM-0106: DOMPurify drops a `D:/…` href (unknown scheme `d:`), so the chat
// never got to resolve a link to a file on a Windows machine.
test('links to local Windows files keep a href the chat can resolve', () => {
  const hrefs = (md: string) => Array.from(
    DOMPurify.sanitize(mdToSafeHtml(md), { RETURN_DOM_FRAGMENT: true }).querySelectorAll('a'),
  ).map((a) => a.getAttribute('href'));
  assert.deepEqual(hrefs('[r](<D:/Espace de travail/projet/rapport.md>)'), ['/D:/Espace%20de%20travail/projet/rapport.md']);
  assert.deepEqual(hrefs('[r](D:/Espace%20de%20travail/rapport.md)'), ['/D:/Espace%20de%20travail/rapport.md']);
  assert.deepEqual(hrefs('[r](C:\\x\\r.md)'), ['/C:/x/r.md']);
  assert.deepEqual(hrefs('[r](file:///D:/a/r.md)'), ['/D:/a/r.md']);
  assert.deepEqual(hrefs('<a href="D:/a b/r.md">r</a>'), ['/D:/a b/r.md']);
});

test('a rewritten Windows link resolves to the file the agent named, spaces included', () => {
  const [href] = Array.from(
    DOMPurify.sanitize(mdToSafeHtml('[r](<D:/Espace de travail/projet/rapport.md>)'), { RETURN_DOM_FRAGMENT: true }).querySelectorAll('a'),
  ).map((a) => a.getAttribute('href') ?? '');
  assert.deepEqual(resolveFileLink(href!, ['D:\\Espace de travail\\projet']), { kind: 'file', path: 'rapport.md' });
  assert.deepEqual(resolveFileLink(href!, ['C:\\autre']), { kind: 'outside', path: 'D:/Espace de travail/projet/rapport.md' });
});

test('the Windows path rewrite opens nothing else', () => {
  const html = mdToSafeHtml('[a](javascript:alert(1))\n\n[b](data:text/html,x)\n\n[c](vbscript:x)\n\n[d](file://server/share/x.md)\n\n[e](ab:/x)\n\n[f](<D:evil>)\n\n[g](file:////evil.test/x.md)');
  assert.doesNotMatch(html, /href="\/\/|evil\.test/);
  assert.doesNotMatch(html, /href="(javascript|data|vbscript|file|ab|\/?D):/i);
  assert.match(mdToSafeHtml('[r](https://example.test/D:/x)'), /href="https:\/\/example\.test\/D:\/x"/);
  // The hook is gone afterwards: a plain sanitize elsewhere still drops `D:/…`.
  const plain = DOMPurify.sanitize('<a href="D:/x/r.md">x</a>', { RETURN_DOM_FRAGMENT: true });
  assert.equal(plain.querySelector('a')?.hasAttribute('href'), false);
});

test('the highlight.js grammars stay out of the markdown module (root bundle)', () => {
  // Imported here, they would ship again in every page that renders markdown
  // (docs/BUNDLE-SIZE.md): they go through loadHighlighter().
  const source = readFileSync(join(process.cwd(), 'src', 'lib', 'markdown.ts'), 'utf8');
  assert.doesNotMatch(source, /from 'highlight\.js\/lib\/languages\//);
});

// TIM-0141: CommonMark reads `\.` as an escape, so `C:\Users\toto\.copilot`
// used to render as `C:\Users\toto.copilot`.
test('a Windows path keeps the backslash before punctuation (TIM-0141)', () => {
  const text = (md: string) => DOMPurify.sanitize(mdToSafeHtml(md), { RETURN_DOM_FRAGMENT: true }).textContent?.trim();
  assert.equal(text('C:\\Users\\toto\\.copilot\\session-state\\files'), 'C:\\Users\\toto\\.copilot\\session-state\\files');
  assert.equal(text('Open "C:\\.config\\_cache\\-x\\(1)\\[a]\\#b"'), 'Open "C:\\.config\\_cache\\-x\\(1)\\[a]\\#b"');
  assert.equal(text('In C:\\Program Files\\.hidden\\app.exe now'), 'In C:\\Program Files\\.hidden\\app.exe now');
  assert.equal(text('**C:\\Users\\toto\\.copilot**'), 'C:\\Users\\toto\\.copilot');
});

test('a UNC path keeps its leading double backslash and its escapes (TIM-0141)', () => {
  const text = (md: string) => DOMPurify.sanitize(mdToSafeHtml(md), { RETURN_DOM_FRAGMENT: true }).textContent?.trim();
  assert.equal(text('\\\\server\\share\\.x'), '\\\\server\\share\\.x');
  assert.equal(text('see \\\\nas01\\backups\\_old\\.git'), 'see \\\\nas01\\backups\\_old\\.git');
});

test('Markdown escapes outside a path still apply (TIM-0141)', () => {
  const html = mdToSafeHtml('\\*pas italique\\*');
  assert.doesNotMatch(html, /<em>/);
  assert.match(html, /\*pas italique\*/);
  assert.doesNotMatch(html, /\\/);
  // `*` cannot be in a Windows file name, so it stays an escape even inside a path.
  assert.doesNotMatch(mdToSafeHtml('C:\\Users\\a\\*b\\*'), /\\\*|<em>/);
  assert.match(mdToSafeHtml('\\# not a title'), /<p># not a title<\/p>/);
  assert.match(mdToSafeHtml('a \\_b\\_ c'), /<p>a _b_ c<\/p>/);
  assert.match(mdToSafeHtml('\\[x\\](y)'), /<p>\[x\]\(y\)<\/p>/);
  // A double backslash outside a UNC path is still one backslash.
  assert.match(mdToSafeHtml('a\\\\b'), /<p>a\\b<\/p>/);
  assert.match(mdToSafeHtml('C:\\Users\\toto\\\\.copilot'), /C:\\Users\\toto\\\.copilot/);
});

test('code spans and code blocks keep their backslashes untouched (TIM-0141)', () => {
  assert.match(mdToSafeHtml('`C:\\Users\\toto\\.copilot`'), /<code>C:\\Users\\toto\\\.copilot<\/code>/);
  assert.match(mdToSafeHtml('`\\*x\\*`'), /<code>\\\*x\\\*<\/code>/);
  const block = mdToSafeHtml('```text\n\\\\server\\share\\.x\nC:\\a\\.b \\*c\\*\n```');
  const code = DOMPurify.sanitize(block, { RETURN_DOM_FRAGMENT: true }).querySelector('code')?.textContent;
  assert.equal(code, '\\\\server\\share\\.x\nC:\\a\\.b \\*c\\*');
});

test('the streaming renderer keeps a Windows path as written (TIM-0141)', async () => {
  const { createStreamingMarkdownRenderer } = await import('./markdown');
  const render = createStreamingMarkdownRenderer();
  const html = render('Path: C:\\Users\\toto\\.copilot\\files\n\n\\*plain\\*').map((b) => b.html).join('');
  assert.match(html, /C:\\Users\\toto\\\.copilot\\files/);
  assert.match(html, /<p>\*plain\*<\/p>/);
});
