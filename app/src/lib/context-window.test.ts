import assert from 'node:assert/strict';
import test from 'node:test';
import { formatContextWindow, parseContextWindow } from '@/lib/context-window';
import { contextLimitFor, contextNudgePct } from '@/components/chat/chat-format';
import { blankForm, formErrorKey, formOf, updatePayload, type CustomBackend } from '@/plugins-client/backends/form';
import type { BackendCatalog } from '@/lib/backends';

test('a context window reads as people type it (#175)', () => {
  assert.equal(parseContextWindow('200k'), 200_000);
  assert.equal(parseContextWindow(' 1M '), 1_000_000);
  assert.equal(parseContextWindow('1.05m'), 1_050_000);
  assert.equal(parseContextWindow('1,5M'), 1_500_000);
  assert.equal(parseContextWindow('128 000'), 128_000);
  assert.equal(parseContextWindow('128000 tokens'), 128_000);
  assert.equal(parseContextWindow(''), null, 'empty = back to the detected value');
  for (const bad of ['abc', '12', '200g', '-5k', '1000M']) assert.equal(parseContextWindow(bad), undefined, bad);
  for (const tokens of [200_000, 1_000_000, 1_050_000, 128_000, 131_072]) {
    assert.equal(parseContextWindow(formatContextWindow(tokens)), tokens, `${tokens} survives a round trip`);
  }
});

const catalog = (declared: boolean): BackendCatalog => ({
  backends: [{ id: 'claude', label: 'Claude', defaultModel: 'opus', models: [
    { slug: 'opus', label: 'Opus', contextWindow: 500_000, ...(declared ? { contextWindowDeclared: true } : {}) },
  ] }],
} as unknown as BackendCatalog);

test('a window typed by hand wins over the one the runtime reports (#175)', () => {
  assert.equal(contextLimitFor(catalog(true), 'claude', 'opus', null, { opus: 200_000 }), 500_000);
  // Without the user's figure, the runtime keeps its precedence over the catalogue.
  assert.equal(contextLimitFor(catalog(false), 'claude', 'opus', null, { opus: 200_000 }), 200_000);
});

const saved: CustomBackend = {
  id: 'codex', file: null, origin: 'builtin', label: 'Codex', dialect: 'codex', protocol: null, baseUrl: null,
  models: [
    { slug: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 272_000, contextWindowDeclared: true, detectedContextWindow: 400_000 },
    { slug: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 400_000, detectedContextWindow: 400_000 },
  ],
  defaultModel: 'gpt-5.5', icon: null, brand: null, hasVaultKey: false, active: true, reason: null, warnings: [],
};

test('the form sends the typed window, never the detected one, and null to clear it (#175)', () => {
  const form = formOf(saved);
  const sent = (f: typeof form) => (updatePayload(f).models as { slug: string; contextWindow?: number | null }[])
    .map(({ slug, contextWindow }) => ({ slug, contextWindow }));
  // The declared figure goes back as is; the detected one is not turned into a declaration.
  assert.deepEqual(sent(form), [{ slug: 'gpt-5.5', contextWindow: 272_000 }, { slug: 'gpt-5.4', contextWindow: null }]);
  const typed = { ...form, models: form.models.map((m, i) => (i === 1 ? { ...m, contextWindowText: '1M' } : i === 0 ? { ...m, contextWindowText: '' } : m)) };
  assert.deepEqual(sent(typed), [{ slug: 'gpt-5.5', contextWindow: null }, { slug: 'gpt-5.4', contextWindow: 1_000_000 }]);
  const wrong = { ...form, models: [{ ...form.models[0]!, contextWindowText: 'lots' }] };
  assert.equal(formErrorKey(wrong), 'backendsSettings.errors.contextWindowInvalid');
  assert.equal(formErrorKey({ ...blankForm(), name: 'x', baseUrl: 'https://x.test', models: [{ slug: 'm', label: 'm', contextWindowText: '64k' }] }), null);
});

test('the compaction nudge waits for the agent\'s own model', () => {
  const cat = {
    backends: [{ id: 'claude', label: 'Claude', defaultModel: 'sonnet', models: [
      { slug: 'sonnet', label: 'Sonnet', contextWindow: 200_000 },
      { slug: 'opus', label: 'Opus', contextWindow: 1_000_000 },
    ] }],
  } as unknown as BackendCatalog;
  const used = 376_596;
  // The placeholder agent carries the backend default: its window reads an
  // Opus mission at 1M as 94 % of a 400k tier.
  const placeholder = contextLimitFor(cat, 'claude', 'sonnet', 'claude-opus-5-5', {});
  assert.equal(Math.round(contextNudgePct(used, placeholder, true)!), 94);
  assert.equal(contextNudgePct(used, placeholder, false), null, 'no nudge before the agent lands');
  const own = contextLimitFor(cat, 'claude', 'opus', 'claude-opus-5-5', {});
  assert.equal(Math.round(contextNudgePct(used, own, true)!), 38);
  assert.equal(contextNudgePct(used, null, true), null, 'unknown window');
  assert.equal(contextNudgePct(0, own, true), null, 'no usage yet');
});
