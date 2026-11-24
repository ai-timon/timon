// french-ok-file: the language names in French under test
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { ModelErrorCode, ModelListing, ModelState, SpeechState } from './desktop-speech';
import {
  activeModel, automaticModel, catalogLanguages, chosenModel, confirmsDownload, effectiveLanguage, formatBytes, languageName, modelChoices, modelErrorKey,
  LARGE_DOWNLOAD_BYTES, modelView, preciseSuggestion, recommendedModel,
} from './model-view';
import type { VoiceSettings } from './voice-settings';

const TOTAL = 670_478_772;
const state = (model: Partial<ModelState>, engine: SpeechState['engine'] = 'available'): SpeechState => ({
  engine,
  sessionId: null,
  model: { modelId: 'm', status: 'absent', receivedBytes: 0, totalBytes: TOTAL, error: null, ...model },
});

test('no state yet: loading, never a download button', () => {
  assert.equal(modelView(null, false).phase, 'loading');
});

test('an absent model asks for consent; accepting does not skip the desktop state', () => {
  assert.equal(modelView(state({}), false).phase, 'consent');
  assert.equal(modelView(state({}), true).phase, 'consent');
});

test('the download is followed as the desktop reports it', () => {
  const view = modelView(state({ status: 'downloading', receivedBytes: TOTAL / 4 }), true);
  assert.equal(view.phase, 'downloading');
  assert.equal(view.percent, 25);
  assert.equal(modelView(state({ status: 'verifying', receivedBytes: TOTAL }), true).phase, 'verifying');
  assert.equal(modelView(state({ status: 'ready', receivedBytes: TOTAL }), true).phase, 'ready');
});

test('a partial download is paused in this card, but asks again from an earlier session', () => {
  assert.equal(modelView(state({ status: 'partial', receivedBytes: 10 }), true).phase, 'paused');
  assert.equal(modelView(state({ status: 'partial', receivedBytes: 10 }), false).phase, 'consent');
});

test('a failure carries its reason, and the engine missing wins over everything', () => {
  const view = modelView(state({ status: 'error', error: 'disk-full' }), true);
  assert.equal(view.phase, 'error');
  assert.equal(view.error, 'disk-full');
  assert.equal(modelErrorKey('disk-full'), 'dictation.model.errors.diskFull');
  assert.equal(modelErrorKey('network'), 'dictation.model.errors.network');
  assert.equal(modelView(state({ status: 'ready' }, 'not-installed'), true).phase, 'unavailable');
});

test('the size is formatted at runtime from the catalogue total, in the UI locale', () => {
  assert.equal(formatBytes(TOTAL, 'en'), '670 MB');
  assert.match(formatBytes(TOTAL, 'fr'), /^670\s?Mo$/);
  assert.equal(formatBytes(1_500_000_000, 'en'), '1.5 GB');
});

test('every download failure the desktop reports has its message in both locales', () => {
  const codes: ModelErrorCode[] = ['network', 'http', 'stalled', 'integrity', 'disk-full', 'io'];
  for (const locale of ['en', 'fr']) {
    const messages = JSON.parse(readFileSync(new URL(`../../locales/${locale}/core.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
    for (const code of codes) {
      const value = modelErrorKey(code).split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], messages);
      assert.equal(typeof value, 'string', `${locale}: no message for ${code}`);
    }
  }
});

const listed = (id: string, codes: string[], mode: ModelListing['languages']['mode'], status: ModelState['status'], origin: ModelListing['origin'] = { kind: 'builtin' }): ModelListing => ({
  id, label: id, family: null, origin, sizeBytes: 1, ramBytes: null, peakRamBytes: null, tier: null, languages: { codes, mode }, interim: 'live', license: null,
  state: { modelId: id, status, receivedBytes: 0, totalBytes: 1, error: null },
});
const PARAKEET = (status: ModelState['status']) => listed('parakeet', ['de', 'en', 'fr', 'it'], 'auto', status);
const CANARY = (status: ModelState['status']) => listed('canary', ['de', 'en', 'es', 'fr'], 'forced', status);
const COHERE = (status: ModelState['status']) => listed('cohere', ['fr', 'ja'], 'required', status);
const NONE: VoiceSettings = { language: null, interim: 'auto', models: {} };

test('the dictation language: the choice, else the UI language a model covers, else Auto', () => {
  const catalog = [PARAKEET('ready'), CANARY('absent')];
  assert.equal(effectiveLanguage(null, 'fr', catalog), 'fr');
  assert.equal(effectiveLanguage(null, 'ja', catalog), 'auto');
  assert.equal(effectiveLanguage('auto', 'fr', catalog), 'auto');
  assert.equal(effectiveLanguage('es', 'fr', catalog), 'es');
  assert.equal(effectiveLanguage('ja', 'fr', catalog), 'fr');
  assert.equal(effectiveLanguage('ja', 'fr', null), 'ja');
  assert.deepEqual(catalogLanguages([...catalog, listed('custom-x', ['und'], 'auto', 'ready', { kind: 'local' })]), ['de', 'en', 'es', 'fr', 'it']);
});

test('the automatic model: the one that imposes the language once installed, never a required one, Parakeet for Auto', () => {
  assert.equal(automaticModel('fr', [PARAKEET('ready'), CANARY('absent')])?.id, 'parakeet');
  assert.equal(automaticModel('fr', [PARAKEET('ready'), CANARY('ready')])?.id, 'canary');
  assert.equal(automaticModel('auto', [PARAKEET('ready'), CANARY('ready')])?.id, 'parakeet');
  assert.equal(automaticModel('auto', [CANARY('ready')]), null);
  assert.equal(automaticModel('ja', [COHERE('ready')]), null);
  assert.equal(automaticModel('ja', [COHERE('ready'), PARAKEET('ready')])?.id, 'parakeet');
});

test('a model picked for a language counts only installed and able to take it', () => {
  const catalog = [PARAKEET('ready'), CANARY('ready'), COHERE('absent')];
  assert.equal(activeModel('fr', { ...NONE, models: { fr: 'parakeet' } }, catalog)?.id, 'parakeet');
  assert.equal(activeModel('auto', { ...NONE, models: { auto: 'canary' } }, catalog)?.id, 'parakeet');
  assert.equal(activeModel('fr', { ...NONE, models: { fr: 'cohere' } }, catalog)?.id, 'canary');
  assert.equal(chosenModel('fr', { ...NONE, models: { fr: 'gone' } }, catalog), undefined);
  assert.deepEqual(modelChoices('auto', catalog).map((entry) => entry.id), ['parakeet']);
  assert.deepEqual(modelChoices('es', catalog).map((entry) => entry.id), ['parakeet', 'canary']);
});

test('the precise-model card: Parakeet alone dictates a language a built-in model imposes', () => {
  assert.equal(preciseSuggestion('fr', [PARAKEET('ready'), CANARY('absent')])?.id, 'canary');
  assert.equal(preciseSuggestion('fr', [PARAKEET('ready'), CANARY('downloading')])?.id, 'canary');
  assert.equal(preciseSuggestion('fr', [PARAKEET('ready'), CANARY('ready')]), null);
  assert.equal(preciseSuggestion('auto', [PARAKEET('ready'), CANARY('absent')]), null);
  assert.equal(preciseSuggestion('it', [PARAKEET('ready'), CANARY('absent')]), null);
  assert.equal(preciseSuggestion('fr', [PARAKEET('absent'), CANARY('absent')]), null);
  assert.equal(preciseSuggestion('fr', [PARAKEET('ready'), listed('acme.fr', ['fr'], 'forced', 'absent', { kind: 'pack', pluginId: 'acme' })]), null);
});

test('the model to download for a language: the built-in one it would run on, never an import that is gone', () => {
  assert.equal(recommendedModel('fr', [PARAKEET('absent'), CANARY('absent')])?.id, 'canary');
  assert.equal(recommendedModel('auto', [PARAKEET('absent'), CANARY('absent')])?.id, 'parakeet');
  assert.equal(recommendedModel('it', [PARAKEET('absent'), CANARY('absent')])?.id, 'parakeet');
});

test('Download asks once more from a gigabyte on: Cohere does, Parakeet and Canary do not', () => {
  assert.equal(confirmsDownload({ sizeBytes: 2_888_052_036 }), true);
  assert.equal(confirmsDownload({ sizeBytes: LARGE_DOWNLOAD_BYTES }), true);
  assert.equal(confirmsDownload({ sizeBytes: 670_478_772 }), false);
  assert.equal(confirmsDownload({ sizeBytes: 207_170_046 }), false);
});

test('a language reads in the UI language, the code when it has no name', () => {
  assert.equal(languageName('fr', 'fr'), 'Français');
  assert.equal(languageName('fr', 'en'), 'French');
  assert.equal(languageName('fr', 'fr', true), 'français');
  assert.equal(languageName('qqq', 'en'), 'qqq');
});
