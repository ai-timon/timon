import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { reopenHint } from './reopen-hint.js';

test('the tray is only named when it exists', () => {
  assert.equal(reopenHint('en', true, 'Timon', 'moment'), 'reopen the window from the Timon icon in the notification area in a moment');
  assert.equal(reopenHint('en', false, 'Timon', 'minute'), 'quit Timon and launch it again in a minute');
  assert.equal(reopenHint('en', false, 'Timon'), 'quit Timon and launch it again');
});

test('the hint speaks the dialog\'s language', () => {
  assert.equal(reopenHint('fr', true, 'Timon', 'moment'), 'rouvrez la fenêtre depuis l’icône Timon de la zone de notification dans un instant'); // french-ok: the French locale under test
  assert.equal(reopenHint('fr-CA', false, 'Timon'), 'quittez Timon puis relancez-le');
});

test('no startup message promises a tray that may be missing', () => {
  const main = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
  assert.doesNotMatch(main, /from the tray/);
  assert.equal(main.match(/reopenHint\(locale, tray !== null/g)?.length, 3);
});
