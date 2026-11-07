/**
 * TODO #887: the views that drew an agent's head on their own follow its
 * picked mode (`config.avatar`, docs/AGENT-AVATAR.md) — the Multichat rail and
 * cell, the Agents graph's nodes, the mobile list. One view per family; the
 * chat's bubbles are in `lib/chat-bubble-avatar-mode.test.ts`, the mobile list
 * in `mobile-agent-list-avatar.test.ts` (it needs a DOM before react-dom loads).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentAvatar as RailAvatar } from '@/app/multichat/agent-side-rail';
import { graphNodeFace } from '@/lib/graph-face';
import type { AgentMeta } from '@/app/multichat/types';

Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });
const { createElement } = React;

const LOOK = { shape: 'hex', color: '#7ed957', eyes: 'code', acc: 'coffee' };
const FULL = { emoji: '🦊', icon_url: '/api/uploads/nova.png', look: LOOK };

function railHead(agent: Partial<AgentMeta>, project?: { slug: string; icon?: string | null }): string {
  const meta: AgentMeta = { name: 'nova', project: null, icon_url: null, emoji: null, color: null, role: 'coder', ...agent };
  return renderToStaticMarkup(createElement(RailAvatar, { agent: meta, project, color: '#123456', state: undefined }));
}

test('Multichat rail: the picked head, then the historical order', () => {
  const mascot = railHead({ ...FULL, avatar: 'mascot' });
  assert.match(mascot, /data-agent-head="mascot"/);
  assert.match(mascot, /data-agent-mascot/);
  assert.doesNotMatch(mascot, /<img/);

  const emoji = railHead({ ...FULL, avatar: 'emoji' });
  assert.doesNotMatch(emoji, /data-agent-mascot|<img/);
  assert.match(emoji, />🦊</);

  assert.match(railHead({ ...FULL, avatar: 'image' }), /<img[^>]+nova\.png/);
  // No pick: picture, then project logo, then mascot, then emoji, then initial (upper-cased by CSS).
  assert.match(railHead(FULL), /<img[^>]+nova\.png/);
  assert.match(railHead({ look: LOOK, emoji: '🦊' }, { slug: 'acme', icon: '/api/uploads/acme.png' }), /<img[^>]+acme\.png/);
  assert.match(railHead({ look: LOOK, emoji: '🦊' }), /data-agent-mascot/);
  assert.match(railHead({}), /class="uppercase"[^>]*>N</);
});

test('Agents graph: a node shows the picked head, its own initials when it has nothing', () => {
  const agent = { name: 'nova', role: 'coder', ...FULL };
  const mascot = graphNodeFace({ ...agent, avatar: 'mascot' }, null);
  assert.equal(mascot.iconUrl, null);
  assert.equal(mascot.look?.shape, 'hex');
  assert.deepEqual(graphNodeFace({ ...agent, avatar: 'emoji' }, null), { iconUrl: null, look: null, glyph: '🦊' });
  assert.deepEqual(graphNodeFace({ ...agent, avatar: 'image' }, null), { iconUrl: '/api/uploads/nova.png', look: null, glyph: null });
  // Historical order without a pick.
  assert.equal(graphNodeFace(agent, null).iconUrl, '/api/uploads/nova.png');
  assert.equal(graphNodeFace({ name: 'nova', look: LOOK }, { icon: '/api/uploads/acme.png' }).iconUrl, '/api/uploads/acme.png');
  assert.equal(graphNodeFace({ name: 'nova', look: LOOK }, null).look?.shape, 'hex');
  assert.deepEqual(graphNodeFace({ name: 'nova' }, { icon: '🚀' }), { iconUrl: null, look: null, glyph: '🚀' });
  assert.deepEqual(graphNodeFace({ name: 'nova' }, null), { iconUrl: null, look: null, glyph: null }, 'the node writes its initials');
});

test('a name with a leading underscore still gets the canvas\'s own initials', () => {
  // `_main` falls back on "m" in a round avatar; the graph must recognise that
  // automatic letter and write its two-letter initials ("MA") instead.
  assert.equal(graphNodeFace({ name: '_main' }, null).glyph, null);
});
