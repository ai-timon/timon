// french-ok-file: the French locale of the waiting page under test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitingPage, waitingUrl } from './waiting-page.js';
import { LIGHT_THEME, THEME } from './data-update.js';
import { FIRST_RUN_THEME } from './first-run-theme.js';

test('the waiting page paints the theme background of the scheme', () => {
  assert.ok(waitingPage('en', 'dark', 'service').includes(THEME.background));
  assert.ok(waitingPage('en', 'light', 'service').includes(LIGHT_THEME.background));
});

test('the service step is active first, the interface pending', () => {
  const html = waitingPage('en', 'dark', 'service');
  assert.match(html, /<li class="active">.*Starting the service…/);
  assert.match(html, /<li class="pending">.*Interface</);
  assert.match(html, /Starting Timon…/);
});

test('once the service is ready the interface is the step in progress', () => {
  const html = waitingPage('en', 'dark', 'interface');
  assert.match(html, /<li class="done">.*Service ready/);
  assert.match(html, /<li class="active">.*Starting the interface…/);
});

test('French copy follows the locale', () => {
  const html = waitingPage('fr-FR', 'dark', 'interface');
  assert.match(html, /Démarrage de Timon…/);
  assert.match(html, /Démarrage de l’interface…/);
  assert.match(html, /lang="fr"/);
});

test('a failed startup drops the steps and says so', () => {
  const html = waitingPage('en', 'dark', 'failed');
  assert.match(html, /Timon did not start\./);
  assert.doesNotMatch(html, /<li/);
});

test('the page runs no script and loads nothing remote', () => {
  const html = waitingPage('en', 'dark', 'interface');
  assert.doesNotMatch(html, /<script|src=|href=/);
  assert.match(html, /default-src 'none'/);
  assert.ok(waitingUrl('en', 'dark', 'interface').startsWith('data:text/html;charset=utf-8,'));
});

test('the handover of a first setup says Timon restarts, in both languages', () => {
  assert.match(waitingPage('en', 'dark', 'service', true), /Restarting Timon…/);
  assert.match(waitingPage('fr-FR', 'light', 'service', true), /Timon redémarre…/);
  assert.match(waitingPage('en', 'dark', 'interface', true), /handing over to its background service/);
  assert.doesNotMatch(waitingPage('en', 'dark', 'service'), /Restarting/);
});

test('a first launch waits in the onboarding look, its steps in the corner card', () => {
  for (const step of ['service', 'interface'] as const) {
    const html = waitingPage('fr-FR', 'light', step, false, true);
    assert.ok(html.includes(FIRST_RUN_THEME.light.background), 'the Timon background');
    assert.ok(!html.includes(LIGHT_THEME.background), 'not the product palette');
    assert.match(html, /radial-gradient/);
    assert.doesNotMatch(html, /<h1/, 'nothing in the centre');
    assert.match(html, /<aside class="card" role="status"[^>]*><p class="card-title">Démarrage de Timon…/, 'the steps sit in the card');
  }
  assert.ok(waitingPage('en', 'dark', 'service', false, true).includes(FIRST_RUN_THEME.dark.background));
});

test('the release check of a first launch takes the same look', () => {
  const html = waitingPage('en', 'dark', 'verifying', false, true);
  assert.ok(html.includes(FIRST_RUN_THEME.dark.background));
  assert.ok(!html.includes(THEME.background));
  assert.match(html, /<aside class="card"[^>]*>.*<li class="active">/s);
});

test('the steps never fill the window: a corner card, the centre empty', () => {
  for (const step of ['verifying', 'service', 'interface'] as const) {
    const html = waitingPage('en', 'dark', step);
    assert.match(html, /\.card\{position:fixed;bottom:16px;inset-inline-end:16px/);
    assert.doesNotMatch(html, /<main>/, step);
  }
});

test('a first launch keeps the restart sentence and the failure, in its own look', () => {
  const restart = waitingPage('en', 'dark', 'service', true, true);
  assert.match(restart, /<main><h1>Restarting Timon…/);
  assert.ok(restart.includes(FIRST_RUN_THEME.dark.background));
  const failed = waitingPage('en', 'dark', 'failed', false, true);
  assert.match(failed, /Timon did not start\./);
  assert.doesNotMatch(failed, /class="card"/);
  assert.ok(failed.includes(FIRST_RUN_THEME.dark.background));
  assert.doesNotMatch(waitingPage('en', 'dark', 'service', false, true), /<script|src=|href=/);
});

test('a later launch keeps its diagnostic, in its own palette', () => {
  assert.match(waitingPage('en', 'dark', 'interface'), /<li class="done">.*Service ready/);
  assert.ok(!waitingPage('en', 'dark', 'interface').includes(FIRST_RUN_THEME.dark.background));
});

test('a window without a system title bar keeps a strip to move it by, and only then', () => {
  const frameless = waitingPage('en', 'dark', 'service', false, false, true);
  assert.match(frameless, /<div class="drag" aria-hidden="true"><\/div>/);
  assert.match(frameless, /\.drag\{[^}]*-webkit-app-region:drag/);
  assert.doesNotMatch(waitingPage('en', 'dark', 'service'), /class="drag"/);
  assert.ok(decodeURIComponent(waitingUrl('en', 'dark', 'failed', false, false, true)).includes('class="drag"'), 'the failure page too');
});
