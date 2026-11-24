// french-ok-file: the localised About texts under test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABOUT_CHANNEL, aboutCopy, aboutPage, readThirdPartyNotices, registerAboutIpc, renderNotices, thirdPartyNoticesPath, type AboutSender } from './about.js';
import { canReadAppInfo } from './app-info.js';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const notices = readFileSync(join(desktopRoot, 'THIRD-PARTY-MODELS.md'), 'utf8');
const origin = 'http://127.0.0.1:3110';

test('about: the packaged app reads the notices at the root of its resources, the sources next to package.json', () => {
  assert.equal(thirdPartyNoticesPath({ packaged: true, resourcesPath: join('opt', 'Timon', 'resources'), desktopRoot: 'src' }),
    join('opt', 'Timon', 'resources', 'THIRD-PARTY-MODELS.md'));
  assert.equal(thirdPartyNoticesPath({ packaged: false, resourcesPath: 'res', desktopRoot }), join(desktopRoot, 'THIRD-PARTY-MODELS.md'));
  assert.equal(readThirdPartyNotices(thirdPartyNoticesPath({ packaged: false, resourcesPath: 'res', desktopRoot })), notices);
  assert.equal(readThirdPartyNotices('missing', () => { throw new Error('ENOENT'); }), null);
});

test('about: the page carries the version and the whole Cohere NOTICE, line breaks kept', () => {
  const { html, links } = aboutPage({ version: '0.2.0', electron: '38.1.0', notices, locale: 'en-US', scheme: 'dark' });
  assert.match(html, /About Timon/);
  assert.match(html, /Version 0\.2\.0 · Electron 38\.1\.0/);
  for (const model of ['Parakeet TDT 0.6B v3', 'Canary 180M Flash', 'Cohere Transcribe 03-2026']) assert.ok(html.includes(model), model);
  assert.match(html, /<pre class="notice">Cohere Transcribe 03-2026\nCopyright Cohere Labs\.\n/);
  assert.match(html, /Licensed under the Apache License, Version 2\.0 \(the &quot;License&quot;\);\nyou may not use/);
  assert.ok(links.includes('https://creativecommons.org/licenses/by/4.0/'));
  assert.ok(links.includes('https://www.apache.org/licenses/LICENSE-2.0'));
  assert.ok(links.every((link) => link.startsWith('https://')));
});

test('about: a missing notices file says so instead of an empty section', () => {
  const { html, links } = aboutPage({ version: '0.2.0', electron: '38', notices: null, locale: 'fr-FR', scheme: 'light' });
  assert.match(html, /À propos de Timon/);
  assert.match(html, /role="alert">Le fichier THIRD-PARTY-MODELS\.md est introuvable/);
  assert.deepEqual(links, []);
  assert.equal(aboutCopy('fr').trayItem, 'À propos de Timon');
  assert.equal(aboutCopy('de').trayItem, 'Über Timon');
  assert.equal(aboutCopy('sv').trayItem, 'About Timon');
});

test('about: the notices cannot inject markup, and only https autolinks become links', () => {
  const { html, links } = renderNotices([
    '# <img src=x onerror=alert(1)>',
    '- <javascript:alert(1)> and <http://plain.example> and <https://ok.example/a?b=1&c=2>',
    '```text',
    '</pre><script>alert(1)</script>',
    '```',
  ].join('\n'));
  assert.ok(!/<img|<script|href="javascript|href="http:/.test(html), html);
  assert.deepEqual(links, ['https://ok.example/a?b=1&c=2']);
  assert.match(html, /<a href="https:\/\/ok\.example\/a\?b=1&amp;c=2">/);
  assert.match(html, /<pre class="notice">&lt;\/pre&gt;&lt;script&gt;/);
});

test('about: the window opens only for the main frame of the Timon window; anything else is refused before it opens', () => {
  const handlers = new Map<string, (sender: AboutSender) => void>();
  let opened = 0;
  registerAboutIpc((channel, listener) => handlers.set(channel, listener), (sender) => canReadAppInfo(sender, origin), () => { opened += 1; });
  const open = handlers.get(ABOUT_CHANNEL);
  assert.ok(open, 'the channel is registered');
  const timon = { isWindow: true, isMainFrame: true, url: `${origin}/?settings=system/installation` };
  for (const change of [{ isWindow: false }, { isMainFrame: false }, { url: 'https://evil.example/' }, { url: '' }]) {
    assert.throws(() => open({ ...timon, ...change }), /only available from the Timon window/);
  }
  assert.equal(opened, 0);
  open(timon);
  assert.equal(opened, 1);
});
