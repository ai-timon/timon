// french-ok-file: the French texts an app card ships
/**
 * The app card slot `apps.card` (TODO #832): declared at boot, the product's
 * card is painted while nothing claims it, a plugin that takes the slot paints
 * every card with the app its host puts in context, and its removal gives the
 * product's card back. The page's own logic (status, language, search) is
 * checked beside it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement, type ComponentType } from 'react';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { register, resetSlotsForTests, slotEntries, APP_CARD_SLOT } from '@/lib/plugin-host/slots';
import { setLocale } from '@/lib/i18n';
import { AppCardHost, monogramInk } from './app-card';
import { useAppCard, type AppCardValue } from './app-card-context';
import { appCardApp, appMatches, appStatus, connectorsInOrder, type AppView } from '@/plugins-client/mcp-apps/connectors-section';

// The components are compiled with the classic JSX runtime under the test runner.
(globalThis as { React?: typeof React }).React = React;

const VIEW: AppView = {
  slug: 'acme',
  name: 'Acme',
  publisher: 'Acme Inc.',
  category: 'code',
  tagline: { en: 'Builds and deploys', fr: 'Builds et déploiements' },
  description: { en: 'Lets your agents deploy.', fr: 'Vos agents déploient.' },
  examples: { en: ['Deploy main', 'Show the logs'], fr: ['Déploie main', 'Montre les logs'] },
  mcp: { url: 'https://mcp.acme.example/mcp' },
  auth: { type: 'oauth' },
  links: { website: 'https://acme.example', privacy: 'https://acme.example/privacy', terms: 'https://acme.example/terms' },
  icon: { monogram: 'Ac', color: '#5E6AD2' },
  state: { connected: false, blocked: false, mcp_id: 'app-acme', oauth_status: null },
};

function value(view: AppView = VIEW): AppCardValue {
  return {
    app: appCardApp(view, 'en'),
    status: appStatus(view, false),
    consentUrl: null,
    vaultOff: false,
    connect: async () => true,
    disconnect: async () => true,
  };
}

test('apps.card is a boot slot, painted by the product card while nothing claims it', () => {
  resetSlotsForTests();
  setLocale('en');
  assert.equal(slotEntries(APP_CARD_SLOT).length, 0);
  const html = renderToStaticMarkup(createElement(AppCardHost, { value: value() }));
  assert.match(html, /Acme/);
  assert.match(html, /Builds and deploys/);
  assert.match(html, /Connect/);
});

test('a plugin that takes the slot paints every card from useAppCard, and leaves it to the product', () => {
  resetSlotsForTests();
  function Replacement() {
    const host = useAppCard();
    return createElement('div', { 'data-replacement': '' }, `${host?.app.name}:${host?.status}`);
  }
  const dispose = register({ slot: APP_CARD_SLOT, pluginId: 'acme-cards' }, Replacement);
  const connected: AppView = { ...VIEW, state: { ...VIEW.state, connected: true, oauth_status: 'authorized' } };
  assert.match(renderToStaticMarkup(createElement(AppCardHost, { value: value(connected) })), /data-replacement="">Acme:connected</);
  assert.throws(() => register({ slot: APP_CARD_SLOT, pluginId: 'second' }, Replacement), 'a single slot takes one replacement');
  dispose();
  assert.doesNotMatch(renderToStaticMarkup(createElement(AppCardHost, { value: value() })), /data-replacement/);
});

test('status: a server without consent waits for it, a hand-made one blocks', () => {
  assert.equal(appStatus(VIEW, false), 'available');
  assert.equal(appStatus(VIEW, true), 'connecting');
  assert.equal(appStatus({ ...VIEW, state: { ...VIEW.state, connected: true, oauth_status: 'pending' } }, false), 'consent');
  assert.equal(appStatus({ ...VIEW, state: { ...VIEW.state, connected: true, oauth_status: 'expired' } }, false), 'consent');
  assert.equal(appStatus({ ...VIEW, state: { ...VIEW.state, connected: true, oauth_status: 'authorized' } }, false), 'connected');
  const keyApp: AppView = { ...VIEW, auth: { type: 'key', help_url: 'https://acme.example/keys', label: { en: 'API key', fr: 'Clé API' } } };
  assert.equal(appStatus({ ...keyApp, state: { ...VIEW.state, connected: true, oauth_status: 'none' } }, false), 'connected');
  assert.equal(appStatus({ ...VIEW, state: { ...VIEW.state, blocked: true } }, false), 'blocked');
});

test('the card speaks the viewer language; search ignores case and accents', () => {
  const fr = appCardApp(VIEW, 'fr');
  assert.equal(fr.tagline, 'Builds et déploiements');
  assert.deepEqual(fr.examples, ['Déploie main', 'Montre les logs']);
  assert.equal(appMatches(fr, 'DEPLOIEMENTS', 'Code'), true);
  assert.equal(appMatches(fr, 'acme inc', 'Code'), true);
  assert.equal(appMatches(fr, 'code', 'Code'), true);
  assert.equal(appMatches(fr, 'stripe', 'Code'), false);
});

test('a logo is drawn from its path data in place of the monogram', () => {
  resetSlotsForTests();
  setLocale('en');
  const withLogo: AppView = {
    ...VIEW,
    icon: { ...VIEW.icon, logo: { viewBox: '0 0 24 24', paths: [{ d: 'M0 0L24 24Z' }, { d: 'M1 1Z', fill: '#FB275D' }], source: 'https://acme.example' } },
  };
  const html = renderToStaticMarkup(createElement(AppCardHost, { value: value(withLogo) }));
  assert.match(html, /<svg viewBox="0 0 24 24"/);
  // A path without its own fill takes the ink that reads on the tile.
  assert.match(html, /<path d="M0 0L24 24Z" fill="#FFFFFF"/);
  assert.match(html, /<path d="M1 1Z" fill="#FB275D"/);
  assert.doesNotMatch(html, />Ac</);
  assert.doesNotMatch(html, /acme\.example"/, 'the source of the mark is not painted');
});

test('the monogram ink reads on its colour', () => {
  assert.equal(monogramInk('#FFD21E'), '#000000');
  assert.equal(monogramInk('#000000'), '#FFFFFF');
  assert.equal(monogramInk('#5E6AD2'), '#FFFFFF');
});

test('the examples/plugin-app-card template paints the cards with the SDK alone', async () => {
  resetSlotsForTests();
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-app-card', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__appCardTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__appCardTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __appCardTestReact: React, __appCardTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'app-card-example-'));
  try {
    const file = join(dir, 'client.mjs');
    writeFileSync(file, platform);
    const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => () => void };
    const dispose = mod.apply({ slots: { register: (options: { slot: string }, Component: ComponentType) => register({ ...options, pluginId: 'example-app-card' }, Component) } });
    const keyApp: AppView = { ...VIEW, slug: 'keyed', auth: { type: 'key', help_url: 'https://acme.example/keys', label: { en: 'API key', fr: 'Clé API' } } };
    const html = renderToStaticMarkup(createElement(AppCardHost, { value: value(keyApp) }));
    assert.match(html, /data-app-card="keyed"/);
    assert.match(html, /type="password"/, 'a key app asks for its key in a masked field');
    const connected: AppView = { ...VIEW, state: { ...VIEW.state, connected: true, oauth_status: 'authorized' } };
    assert.match(renderToStaticMarkup(createElement(AppCardHost, { value: value(connected) })), /data-app-card-action="disconnect"/);
    dispose();
    assert.doesNotMatch(renderToStaticMarkup(createElement(AppCardHost, { value: value() })), /data-app-card=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the connected connectors come first, the rest keeps the catalogue order', () => {
  const named = (slug: string, connected: boolean): AppView => ({ ...VIEW, slug, state: { ...VIEW.state, connected } });
  const order = connectorsInOrder([named('a', false), named('b', true), named('c', false), named('d', true)]).map((v) => v.slug);
  assert.deepEqual(order, ['b', 'd', 'a', 'c']);
});
