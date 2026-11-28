/**
 * The merge-request chip: label by forge, colour by state, a link that opens in
 * a new tab, and nothing at all when the task opened no request or the stored
 * URL is not a web link.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '@/lib/i18n-test-locales';
import { setLocale } from '@/lib/i18n';
import { MergeRequestChip, mergeRequestLabel, mergeRequestOf } from './merge-request-chip';

const GITLAB = { mr_url: 'https://gitlab.example.com/g/p/-/merge_requests/1875', mr_forge: 'gitlab', mr_number: 1875, mr_state: 'open', mr_pipeline: 'running' } as const;
const GITHUB = { mr_url: 'https://github.com/ai-timon/timon/pull/12', mr_forge: 'github', mr_number: 12, mr_state: 'merged', mr_pipeline: null } as const;

test('GitLab reads MR !n, GitHub reads PR #n', () => {
  assert.equal(mergeRequestLabel({ forge: 'gitlab', number: 1875 }), 'MR !1875');
  assert.equal(mergeRequestLabel({ forge: 'github', number: 12 }), 'PR #12');
});

test('a task with no request, or a non-web URL, has none', () => {
  assert.equal(mergeRequestOf({}), null);
  assert.equal(mergeRequestOf({ ...GITLAB, mr_url: 'javascript:alert(1)' }), null);
  assert.equal(mergeRequestOf({ ...GITLAB, mr_forge: null }), null);
  assert.equal(mergeRequestOf({ ...GITLAB, mr_state: null })?.state, 'open');
});

test('the chip links out in a new tab and carries its state, in English and French', () => {
  setLocale('en');
  const html = renderToStaticMarkup(createElement(MergeRequestChip, { task: GITLAB }));
  assert.match(html, /href="https:\/\/gitlab\.example\.com\/g\/p\/-\/merge_requests\/1875"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /data-merge-request-chip="open"/);
  assert.match(html, /MR !1875/);
  assert.match(html, /title="Open MR !1875 in a new tab · open · pipeline running"/);
  assert.match(renderToStaticMarkup(createElement(MergeRequestChip, { task: GITHUB })), /data-merge-request-chip="merged"[\s\S]*PR #12/);
  setLocale('fr');
  // french-ok: the French translation is what this line checks
  assert.match(renderToStaticMarkup(createElement(MergeRequestChip, { task: GITHUB })), /Ouvrir PR #12 dans un nouvel onglet · fusionnée/);
  setLocale('en');
});

test('nothing renders without a request', () => {
  assert.equal(renderToStaticMarkup(createElement(MergeRequestChip, { task: {} })), '');
});
