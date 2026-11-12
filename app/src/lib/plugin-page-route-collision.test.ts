/**
 * A third-party `page` cannot take a route the product already serves.
 *
 * Two kinds of product routes, two guards: a Next page (`/chat`) is served
 * before the catch-all, so a plugin page keyed `/chat` is never painted; a
 * page a bundled module registers in the `page` slot (`/kanban`) holds its
 * key first, and a second registration under it throws.
 *
 * What these guards do not cover: the manifest reserves no route, so a page
 * may declare `/chat` (never painted, though its nav entry still points
 * there); a bundled page is only guarded while its module mounts it, so with
 * the module off, or hidden from a viewer, a plugin may hold its key; and an
 * exact key beats a product wildcard (`/workflows/*`) for that one path.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { declareLayoutSlots } from './plugin-host/client-plugin-host';
import { clientContext } from './plugin-host/loader';
import { resetSlotsForTests, slotEntry } from './plugin-host/slots';
import { mountBundledClients } from '@/plugins-client/mount';

const Empty = () => React.createElement('div');

test('a Next product route is served before the catch-all a plugin page goes through', () => {
  for (const route of ['chat', 'settings', 'agents', 'projects']) {
    const served = ['page.tsx', 'page.ts'].some((file) =>
      existsSync(new URL(`../app/${route}/${file}`, import.meta.url))
      || existsSync(new URL(`../app/(main)/${route}/${file}`, import.meta.url)));
    assert.ok(served, `/${route} is a Next page`);
  }
});

test('a plugin page cannot take the key of a page a bundled module registered', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(null);
  const product = slotEntry('page', '/kanban');
  assert.ok(product, 'the Kanban page is in the page slot');
  const plugin = clientContext('acme-kanban', ['page', 'nav.item']);
  assert.throws(() => plugin.slots.register({ slot: 'page', key: '/kanban' }, Empty), /Key already taken in page: \/kanban/);
  assert.equal(slotEntry('page', '/kanban')?.pluginId, product.pluginId, 'the product keeps its page');
  plugin.dispose();
});
