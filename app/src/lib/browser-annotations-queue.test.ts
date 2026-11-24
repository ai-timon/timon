/**
 * The current queue of the browser annotations (TODO #491): what "N annotations · Send" posts.
 * The desktop bubble's queue and what this app picked or collected, until sent or deleted; a draft
 * left from an earlier session is never in it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserAnnotationState, currentBrowserAnnotationQueue, mergeBrowserAnnotations, queueBrowserAnnotations,
  resetBrowserAnnotationsForTests, unqueueBrowserAnnotations, type BrowserAnnotationMeta,
} from '@/lib/browser-annotations';

const id = (n: number) => `ba-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, status: BrowserAnnotationMeta['status'] = 'draft'): BrowserAnnotationMeta => ({
  id: id(n), profileId: 'p1', status, createdAt: n, updatedAt: n, capturedAt: n, hasThumbnail: false, sourceDetected: false,
  delivery: null, resolvedAt: null,
});

test('an earlier session\'s draft is never in the queue; the bubble\'s and this app\'s are, each once, in order', () => {
  const state = { annotations: [row(1), row(2), row(3), row(9)], queued: [id(3), id(2)] };
  assert.deepEqual(currentBrowserAnnotationQueue(state, [id(1), id(2)]), [id(1), id(2), id(3)]);
  assert.deepEqual(currentBrowserAnnotationQueue(state, []), [id(3), id(2)], 'draft 9 waits in the history');
  assert.deepEqual(currentBrowserAnnotationQueue({ annotations: [row(9)], queued: [] }, []), []);
});

test('what is sent or gone leaves the queue; a bubble id not listed yet stays (sealed by the next collect)', () => {
  const state = { annotations: [row(1, 'pending'), row(3, 'resolved')], queued: [id(1), id(3), id(4)] };
  assert.deepEqual(currentBrowserAnnotationQueue(state, [id(1), id(5)]), [id(5)]);
});

test('the store: queued as picked, unqueued as sent, and kept per profile', () => {
  resetBrowserAnnotationsForTests();
  queueBrowserAnnotations('p1', [id(1), id(2)]);
  queueBrowserAnnotations('p1', [id(2), id(3)]);
  queueBrowserAnnotations('p2', [id(7)]);
  assert.deepEqual(browserAnnotationState('p1').queued, [id(1), id(2), id(3)]);
  unqueueBrowserAnnotations('p1', [id(2)]);
  assert.deepEqual(browserAnnotationState('p1').queued, [id(1), id(3)]);
  assert.deepEqual(browserAnnotationState('p2').queued, [id(7)]);
  // Merged rows do not touch the queue: a list read is not a pick.
  mergeBrowserAnnotations('p1', [row(9)]);
  assert.deepEqual(browserAnnotationState('p1').queued, [id(1), id(3)]);
  resetBrowserAnnotationsForTests();
});
