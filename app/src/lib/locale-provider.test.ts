/**
 * The production path of the interface language (TODO #498): the root layout
 * resolves the request's locale and mounts `LocaleProvider`, which must fetch
 * the French dictionary itself. Only the loader is set here (the sources,
 * standing in for the browser's fetch), nothing is loaded beforehand: the
 * test fails if the provider renders French without loading it.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React, { Suspense, type ReactElement } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { LocaleProvider } from '../components/locale-provider';
import { getLocale, isLocaleLoaded, t, type Locale } from './i18n';
import { useSourceLocaleLoader } from './i18n-sources';

useSourceLocaleLoader();

Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

function Probe(): ReactElement {
  return React.createElement('p', null, t('taskForm.create'));
}

function render(locale: Locale): Promise<string> {
  const tree = React.createElement(
    Suspense,
    { fallback: null },
    React.createElement(LocaleProvider, { locale, children: React.createElement(Probe) }),
  );
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    sink.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    const stream = renderToPipeableStream(tree, {
      onAllReady: () => stream.pipe(sink),
      onShellError: reject,
      onError: reject,
    });
  });
}

test('French: the provider loads the dictionary, then renders in it', async () => {
  assert.equal(isLocaleLoaded('fr'), false, 'nothing loaded French before the provider');
  const html = await render('fr');
  assert.match(html, /Créer la tâche/); // french-ok: the French locale under test
  assert.equal(isLocaleLoaded('fr'), true);
  assert.equal(getLocale(), 'fr');
});

test('a request in English after a French one renders in English', async () => {
  const html = await render('en');
  assert.match(html, /Create task/);
  assert.equal(getLocale(), 'en');
});

test('the root layout mounts the provider around every page it renders, with the request locale', () => {
  const layout = readFileSync(fileURLToPath(new URL('../app/layout.tsx', import.meta.url)), 'utf8');
  assert.match(layout, /const locale = await applyRequestLocale\(\);/);
  const bodies = layout.match(/^\s*<body>$/gm)?.length ?? 0;
  assert.ok(bodies > 0);
  assert.equal(layout.match(/<LocaleProvider locale=\{locale\}>/g)?.length, bodies, 'one provider per <body>');
  assert.equal(layout.match(/<html[^>]*\s+lang=\{locale\}/g)?.length, bodies, 'lang follows the locale');
  assert.equal(layout.match(/<html[^>]*\s+dir=\{localeDirection\(locale\)\}/g)?.length, bodies, 'dir follows the locale');
  assert.doesNotMatch(layout, /lang="en"/);
});
