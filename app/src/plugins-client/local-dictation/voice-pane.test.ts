/**
 * The Voice pane and the first-dictation card against a fake desktop that
 * lists its catalog: the language and its default, the precise-model card of
 * a Parakeet-only install, the catalog's origins, the import that asks for
 * the kind of model, and the card that offers the model of the language.
  *
  * french-ok-file: the French locale of the pane under test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type State = { modelId: string; status: string; receivedBytes: number; totalBytes: number; error: string | null };

const PARAKEET_ID = 'parakeet-tdt-0.6b-v3-int8';
const CANARY_ID = 'canary-180m-flash-int8';

function catalogEntry(id: string, label: string, codes: string[], mode: string, sizes: number[], origin: unknown = { kind: 'builtin' }) {
  return {
    id,
    model: {
      id, label, family: 'nemo-canary', files: sizes.map((sizeBytes) => ({ sizeBytes })),
      memory: { ramBytes: 340_000_000, peakRamBytes: 630_000_000 },
      languages: { codes, mode }, interim: { mode: 'live' },
      license: { spdx: 'CC-BY-4.0', attribution: `NVIDIA, ${label}`, url: 'https://huggingface.co/nvidia' },
    },
    origin,
  };
}

const COHERE_ID = 'cohere-transcribe-03-2026-int8';
const COHERE_SIZE = 2_888_052_036;
const COHERE_ENTRY = {
  id: COHERE_ID,
  model: {
    id: COHERE_ID, label: 'Cohere Transcribe 03-2026 (14 languages)', tier: 'precise', family: 'cohere-transcribe',
    files: [3_090_822, 2_731_503_072, 153_250_705, 207_437].map((sizeBytes) => ({ sizeBytes })),
    memory: { ramBytes: 2_060_000_000, peakRamBytes: 3_600_000_000 },
    languages: { codes: ['ar', 'de', 'el', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'vi', 'zh'], mode: 'required' },
    interim: { mode: 'final-only' },
    license: { spdx: 'Apache-2.0', attribution: 'Cohere Labs, Cohere Transcribe 03-2026 (sherpa-onnx int8 export)', url: 'https://huggingface.co/CohereLabs/cohere-transcribe-03-2026' },
  },
  origin: { kind: 'builtin' },
};

/** A plugin's pack as the daemon serves it (`/api/plugins/beta/-/dictation-models`). */
const BETA_PACK = {
  pluginId: 'beta',
  version: '1.0.0',
  models: [{
    id: 'beta.de-small', label: 'Beta DE small', family: 'nemo-canary', files: [{ sizeBytes: 150_000_000 }],
    memory: { ramBytes: 200_000_000 }, languages: { codes: ['de'], mode: 'forced' }, interim: { mode: 'live' },
    license: { spdx: 'CC-BY-4.0', attribution: 'Beta, DE small', url: 'https://huggingface.co/beta' },
  }],
};

async function mount(options: {
  canary?: string; parakeet?: string; cohere?: string; locale?: 'en' | 'fr'; stored?: unknown; card?: boolean; importAnswers?: unknown[];
  /** What the daemon serves for the active plugin `beta`; none: no plugin brings models. */
  pack?: unknown;
  packAnswers?: unknown[];
} = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, v: unknown) => Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'DocumentFragment',
    'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage', 'getComputedStyle',
  ] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  if (options.stored) dom.window.localStorage.setItem('timon.dictation.local', JSON.stringify(options.stored));

  const states = new Map<string, State>([
    [PARAKEET_ID, { modelId: PARAKEET_ID, status: options.parakeet ?? 'ready', receivedBytes: 0, totalBytes: 670_478_772, error: null }],
    [CANARY_ID, { modelId: CANARY_ID, status: options.canary ?? 'absent', receivedBytes: 0, totalBytes: 207_170_046, error: null }],
    ['acme.fr-large', { modelId: 'acme.fr-large', status: 'absent', receivedBytes: 0, totalBytes: 820_000_000, error: null }],
    [COHERE_ID, { modelId: COHERE_ID, status: options.cohere ?? 'absent', receivedBytes: 0, totalBytes: COHERE_SIZE, error: null }],
  ]);
  const entries: Array<{ id: string; model: unknown; origin: unknown }> = [
    catalogEntry(PARAKEET_ID, 'Parakeet TDT v3', ['de', 'en', 'es', 'fr', 'it'], 'auto', [670_478_772]),
    catalogEntry(CANARY_ID, 'Canary 180M Flash', ['en', 'es', 'de', 'fr'], 'forced', [132_678_643, 74_437_848, 53_555]),
    catalogEntry('acme.fr-large', 'Acme FR large', ['fr'], 'forced', [820_000_000], { kind: 'pack', pluginId: 'acme' }),
    ...(options.cohere ? [COHERE_ENTRY] : []),
  ];
  const calls: unknown[] = [];
  const importAnswers = [...(options.importAnswers ?? [])];
  const packAnswers = [...(options.packAnswers ?? [])];
  const fetched: string[] = [];
  install('fetch', async (url: string) => {
    fetched.push(url);
    if (url === '/api/ui/plugins') {
      return Response.json({ plugins: options.pack ? [
        { id: 'beta', state: 'active', dictation: { engines: [], models: 'dictation-models.json' } },
        { id: 'off', state: 'disabled', dictation: { engines: [], models: 'dictation-models.json' } },
        { id: 'plain', state: 'active', dictation: null },
      ] : [] });
    }
    if (url === '/api/ui/plugins/beta/-/dictation-models') return Response.json(options.pack);
    return new Response('{}', { status: 404 });
  });
  let emit: (event: unknown) => void = () => {};
  const speech = {
    getState: async (id?: string) => ({ engine: 'available', model: states.get(id ?? PARAKEET_ID), sessionId: null }),
    listModels: async () => entries.map((entry) => ({ ...entry, state: states.get(entry.id) })),
    downloadModel: async (id?: string) => { calls.push(`download:${id}`); return new Promise(() => {}); },
    cancelDownload: async (id?: string) => { calls.push(`cancel:${id}`); return true; },
    deleteModel: async (id?: string) => { calls.push(`delete:${id}`); return states.get(id ?? PARAKEET_ID); },
    importModel: async (request?: unknown) => { calls.push(['import', request]); return importAnswers.shift() ?? { ok: false, code: 'cancelled' }; },
    proposePack: async (request: { modelId: string }) => {
      calls.push(['propose', request]);
      const answer = packAnswers.shift() as { ok?: boolean } | undefined;
      if (answer?.ok) {
        const offered = BETA_PACK.models[0]!;
        states.set(request.modelId, { modelId: request.modelId, status: 'absent', receivedBytes: 0, totalBytes: 150_000_000, error: null });
        entries.push({ id: request.modelId, model: offered, origin: { kind: 'pack', pluginId: 'beta' } });
      }
      return answer ?? { ok: false, code: 'declined', message: '' };
    },
    startDictation: async () => ({ ok: false, code: 'model-missing', message: '' }),
    feed: () => {},
    stopDictation: async () => {},
    cancelDictation: async () => {},
    microphone: async () => ({ status: 'granted' }),
    onEvent: (listener: (event: unknown) => void) => { emit = listener; return () => {}; },
  };
  (dom.window as unknown as { timonDesktop: unknown }).timonDesktop = { restartAfterSetup: async () => {}, speech };

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('@/lib/i18n');
  await import('@/lib/i18n-test-locales');
  setLocale(options.locale ?? 'en');
  const { resetVoiceSettingsCache, updateVoiceSettings } = await import('./voice-settings');
  resetVoiceSettingsCache();
  const { LocalDictationSettings } = await import('./local-dictation-settings');
  const { LocalModelConsentCard } = await import('./consent-card');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(options.card ? React.createElement(LocalModelConsentCard, { onClose: () => {} }) : React.createElement(LocalDictationSettings));
  });
  for (let i = 0; i < 3; i += 1) await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const click = async (label: string | RegExp) => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')));
    assert.ok(button, `no "${label}" button in: ${document.body.textContent}`);
    await React.act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const setModel = async (state: State) => {
    states.set(state.modelId, state);
    await React.act(async () => { emit({ type: 'model-state', state }); });
  };
  const settle = async () => { await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); resetVoiceSettingsCache(); };
  return {
    calls, fetched, click, setModel, settle, unmount, updateVoiceSettings, React,
    text: () => document.body.textContent ?? '',
    stored: () => JSON.parse(dom.window.localStorage.getItem('timon.dictation.local') ?? 'null') as unknown,
  };
}

test('a Parakeet-only install in French: French by default, the precise model offered with its size, downloaded only on the click', async () => {
  const pane = await mount({ locale: 'fr' });
  try {
    assert.match(pane.text(), /Langue de dictée/);
    assert.match(pane.text(), /La dictée se fait en français/);
    assert.match(pane.text(), /Un modèle plus précis en français \(207\sMo\)/);
    assert.match(pane.text(), /Canary 180M Flash reconnaît cette langue/);
    assert.match(pane.text(), /Utilisé pour : Français/);
    assert.deepEqual(pane.calls, []);
    await pane.click(/^Télécharger 207\sMo$/);
    assert.deepEqual(pane.calls, [`download:${CANARY_ID}`]);
    await pane.setModel({ modelId: CANARY_ID, status: 'ready', receivedBytes: 207_170_046, totalBytes: 207_170_046, error: null });
    assert.doesNotMatch(pane.text(), /Un modèle plus précis/);
  } finally { await pane.unmount(); }
});

test('Auto drops the precise card; the language and the provisional text are kept by this client', async () => {
  const pane = await mount({ stored: { v: 1, language: 'auto', interim: 'auto', models: {} } });
  try {
    assert.match(pane.text(), /Auto lets the model guess the language/);
    assert.doesNotMatch(pane.text(), /A more precise model/);
    await pane.click('Final only');
    assert.deepEqual(pane.stored(), { v: 1, language: 'auto', interim: 'final-only', models: {} });
    await pane.React.act(async () => { pane.updateVoiceSettings((current) => ({ ...current, language: 'fr' })); });
    assert.match(pane.text(), /A more precise model for French \(207\sMB\)/);
  } finally { await pane.unmount(); }
});

test('the catalog: size, memory, languages and licence of each model; a plugin\'s model says where it comes from, never vouched for', async () => {
  const pane = await mount();
  try {
    assert.match(pane.text(), /Installed/);
    assert.match(pane.text(), /670\sMB · 630\sMB of memory at peak · 5 languages · CC-BY-4\.0/);
    assert.match(pane.text(), /207\sMB · 630\sMB of memory at peak · English, Spanish, German, French · CC-BY-4\.0/);
    assert.match(pane.text(), /From plugins/);
    assert.match(pane.text(), /From the plugin acme\. Timon cannot vouch for a third-party model\./);
    assert.doesNotMatch(pane.text(), /Proposed by/);
    await pane.click(/^Download 820\sMB$/);
    assert.deepEqual(pane.calls, ['download:acme.fr-large']);
  } finally { await pane.unmount(); }
});

test('an import the desktop cannot place asks for the kind of model, then picks the folder again with the answer', async () => {
  const pane = await mount({
    importAnswers: [
      { ok: false, code: 'family-needed', message: '', candidates: ['nemo-canary', 'whisper'] },
      { ok: false, code: 'unsafe-graph', message: '' },
    ],
  });
  try {
    await pane.click('Add a local model…');
    assert.match(pane.text(), /Which kind of model does this folder hold\?/);
    const pickAgain = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Choose the folder again');
    assert.equal(pickAgain?.disabled, true);
    await pane.click('Whisper');
    await pane.click('Choose the folder again');
    await pane.settle();
    assert.deepEqual(pane.calls, [['import', undefined], ['import', { family: 'whisper' }]]);
    assert.match(pane.text(), /This model points to files outside its folder: it was refused\./);
  } finally { await pane.unmount(); }
});

test('the first-dictation card offers the model of the dictation language: Canary in French, Parakeet in Auto', async () => {
  const french = await mount({ card: true, locale: 'fr', parakeet: 'absent' });
  try {
    assert.match(french.text(), /Canary 180M Flash, un modèle vocal de 207\sMo, sera téléchargé une seule fois/);
    await french.click('Télécharger');
    assert.deepEqual(french.calls, [`download:${CANARY_ID}`]);
  } finally { await french.unmount(); }
  const auto = await mount({ card: true, parakeet: 'absent', stored: { v: 1, language: 'auto', interim: 'auto', models: {} } });
  try {
    assert.match(auto.text(), /Parakeet TDT v3, a speech model of 670\sMB/);
  } finally { await auto.unmount(); }
});

test('Cohere, the precise model: its tier, 2.9 GB, 3.6 GB of memory at peak; Download first says what it costs, Cancel downloads nothing', async () => {
  const pane = await mount({ locale: 'fr', cohere: 'absent' });
  try {
    assert.match(pane.text(), /Cohere Transcribe 03-2026 \(14 languages\)Précis/);
    assert.match(pane.text(), /2,9\sGo · 3,6\sGo de RAM au pic · 14 langues · Apache-2\.0/);
    assert.match(pane.text(), /Demande une langue de dictée : il ne sait pas la deviner \(pas d'Auto\)\./);
    assert.match(pane.text(), /N'affiche que le texte final\./);
    assert.match(pane.text(), /Cohere Labs, Cohere Transcribe 03-2026/);
    // Never offered by itself: the precise-model card of French stays Canary.
    assert.match(pane.text(), /Un modèle plus précis en français \(207\sMo\)/);

    await pane.click(/^Télécharger 2,9\sGo$/);
    assert.deepEqual(pane.calls, [], 'the first click only asks');
    assert.match(pane.text(), /Cohere Transcribe 03-2026 \(14 languages\) pèse 2,9\sGo\. Il se télécharge une seule fois et demande jusqu'à 3,6\sGo de RAM pendant la dictée\./);
    await pane.click('Annuler');
    assert.deepEqual(pane.calls, []);
    assert.doesNotMatch(pane.text(), /pèse 2,9\sGo/);

    await pane.click(/^Télécharger 2,9\sGo$/);
    await pane.click(/^Télécharger 2,9\sGo$/);
    assert.deepEqual(pane.calls, [`download:${COHERE_ID}`]);
  } finally { await pane.unmount(); }
});

test('a model under a gigabyte downloads on the first click, as before', async () => {
  const pane = await mount({ cohere: 'absent' });
  try {
    await pane.click(/^Download 820\sMB$/);
    assert.deepEqual(pane.calls, ['download:acme.fr-large']);
  } finally { await pane.unmount(); }
});

test('a model an active plugin offers is shown before it is added; Add names it to the desktop, never hands it over, then downloads', async () => {
  const pane = await mount({ pack: BETA_PACK, packAnswers: [{ ok: true, modelId: 'beta.de-small', state: { modelId: 'beta.de-small', status: 'absent', receivedBytes: 0, totalBytes: 150_000_000, error: null } }] });
  try {
    assert.match(pane.text(), /Beta DE small/);
    assert.match(pane.text(), /150\sMB · 200\sMB of memory · German · CC-BY-4\.0/);
    assert.match(pane.text(), /From the plugin beta\./);
    // Only the active plugin that declares a pack is read.
    assert.deepEqual(pane.fetched, ['/api/ui/plugins', '/api/ui/plugins/beta/-/dictation-models']);
    assert.deepEqual(pane.calls, []);
    await pane.click(/^Add and download 150\sMB…$/);
    await pane.settle();
    assert.deepEqual(pane.calls, [['propose', { pluginId: 'beta', modelId: 'beta.de-small' }], 'download:beta.de-small']);
    // Now a catalog entry: no second Add.
    assert.equal(Array.from(document.querySelectorAll('button')).some((b) => /^Add and download/.test(b.textContent ?? '')), false);
  } finally { await pane.unmount(); }
});

test('an offer the desktop refuses says why, and a declined box says nothing', async () => {
  const pane = await mount({ locale: 'fr', pack: BETA_PACK, packAnswers: [{ ok: false, code: 'not-found', message: 'x' }, { ok: false, code: 'declined', message: 'x' }] });
  try {
    await pane.click(/^Ajouter et télécharger 150\sMo…$/);
    assert.match(pane.text(), /Le plugin ne propose plus ce modèle\./);
    await pane.click(/^Ajouter et télécharger 150\sMo…$/);
    assert.doesNotMatch(pane.text(), /Le plugin ne propose plus ce modèle\./);
    assert.deepEqual(pane.calls.filter((call) => typeof call === 'string'), [], 'nothing downloads');
  } finally { await pane.unmount(); }
});
