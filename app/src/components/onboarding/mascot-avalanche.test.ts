/**
 * The welcome avalanche and the heads mascot packs draw themselves: one look
 * in four wears one, and the cast copies such a head as it is — its canvas,
 * or its SVG — instead of waiting for it as a 3D head; a head that is
 * neither is left out of the drawing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { SHAPES } from '../mascot/agent-look';
import { avalancheLooks } from './avalanche';

// The test runner compiles JSX to `React.createElement`.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

test('without a pack the crowd is Timon\'s skulls; with heads, one look in four wears one', () => {
  const plain = avalancheLooks();
  assert.ok(plain.every((look) => (SHAPES as readonly string[]).includes(look.shape)));
  const heads = ['fire-pack:flame', 'ice-pack:cube'] as const;
  const mixed = avalancheLooks(24, heads);
  const worn = mixed.filter((look) => (heads as readonly string[]).includes(look.shape));
  assert.equal(worn.length, 6);
  assert.deepEqual(new Set(worn.map((look) => look.shape)), new Set(heads), 'every pack shows');
  assert.deepEqual(mixed.map((look) => look.color), plain.map((look) => look.color), 'only the skull changes');
});

test('a cell is copied from the pack\'s canvas or SVG, from Timon\'s drawing otherwise, and left out when it is neither', async () => {
  const { JSDOM } = await import('jsdom');
  const { castSource } = await import('./mascot-avalanche');
  const { document } = new JSDOM('<body></body>').window;
  const cell = (html: string): Element => {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div;
  };
  const canvas = castSource(cell('<span data-mascot-head="fire-pack:flame"><canvas width="40" height="40"></canvas></span>'));
  assert.equal(canvas.kind, 'pack-canvas');
  const svg = castSource(cell('<span data-mascot-head="ice-pack:cube"><svg viewBox="0 0 100 100"></svg></span>'));
  assert.equal(svg.kind, 'pack-svg');
  assert.equal(castSource(cell('<span data-mascot-head="x-pack:div"><div>hello</div></span>')).kind, 'pack-none');
  // Timon's 3D head: its 2D stand-in now, its canvas once drawn.
  const product = castSource(cell('<canvas data-drawn=""></canvas><svg data-mascot=""></svg>'));
  assert.equal(product.kind, 'mascot');
  assert.ok(product.kind === 'mascot' && product.svg && product.head);
});
