import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { mdToSafeHtml } from '@/lib/markdown';

// A memory file is written by agents and by anyone who can edit a project:
// the page that shows it must not run what the file holds.
const PAGE = readFileSync(join(process.cwd(), 'src', 'plugins-client', 'memory', 'memory-page.tsx'), 'utf8');

function render(md: string): Document {
  return new JSDOM(`<div class="memory-md">${mdToSafeHtml(md)}</div>`).window.document;
}

test('the memory page renders every markdown file through the sanitizing renderer', () => {
  const injected = PAGE.match(/dangerouslySetInnerHTML=\{\{ __html: [^}]+\}\}/g) ?? [];
  assert.equal(injected.length, 2);
  for (const site of injected) assert.match(site, /__html: mdToSafeHtml\(/);
  assert.doesNotMatch(PAGE, /md2html/);
});

test('a link cannot add an event handler or run a javascript: URL', () => {
  const doc = render('[a](https://x/" onmouseover="x=1)\n\n[b](javascript:x=1)\n\n<a href="javascript:x=1" onclick="x=1">c</a>');
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      assert.doesNotMatch(attr.name, /^on/i, `${el.tagName} keeps ${attr.name}`);
    }
  }
  for (const link of Array.from(doc.querySelectorAll('a'))) {
    assert.doesNotMatch((link.getAttribute('href') ?? '').trim(), /^javascript:/i);
  }
});

test('raw HTML in a memory file stays inert', () => {
  const doc = render('<script>x=1</script>\n\n`<script>y=1</script>`\n\n<img src=x onerror="x=1">');
  assert.equal(doc.querySelectorAll('script, img').length, 0);
  assert.match(doc.querySelector('code')?.textContent ?? '', /<script>y=1<\/script>/);
});

test('lists, task boxes and headings keep their structure', () => {
  const doc = render('# Pitfalls\n\n- one\n- two\n\n- [ ] open\n- [x] done\n\n1. first\n2. second');
  assert.equal(doc.querySelector('h1')?.textContent, 'Pitfalls');
  assert.equal(doc.querySelectorAll('ul li').length, 4);
  assert.equal(doc.querySelectorAll('ol li').length, 2);
  const boxes = Array.from(doc.querySelectorAll('input[type="checkbox"]'));
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every((box) => box.hasAttribute('disabled')));
  assert.equal(boxes.filter((box) => box.hasAttribute('checked')).length, 1);
});

test('a thematic break is styled as space, never as a drawn rule', () => {
  assert.equal(render('above\n\n---\n\nbelow').querySelectorAll('hr').length, 1);
  assert.match(PAGE, /\.memory-md hr \{ height: 0; border: 0;/);
});
