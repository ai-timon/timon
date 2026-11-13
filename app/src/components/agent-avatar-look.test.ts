/**
 * An agent without a picture shows its mascot, drawn from its `look`, through
 * the `agent.mascot` slot; a picture still wins, and an agent with no look
 * keeps its initial.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentAvatar, agentIdentity, lookOfAgent } from './agent-avatar';
import { defaultLookFor } from './mascot/agent-look';

// The test runner compiles JSX to `React.createElement`.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });
const { createElement } = React;

test('the look an agent row carries: none without one, checked field by field with one', () => {
  assert.equal(lookOfAgent({ look: null, role: 'coder' }), null);
  assert.equal(lookOfAgent({ role: 'coder' }), null);
  assert.deepEqual(lookOfAgent({ look: { shape: 'round', color: '#D4A373', eyes: 'happy', acc: 'coffee' } }), { shape: 'round', color: '#d4a373', eyes: 'happy', acc: 'coffee' });
  const coder = defaultLookFor('coder');
  assert.deepEqual(lookOfAgent({ look: { shape: 'round', acc: 'sword' }, role: 'coder' }), { ...coder, shape: 'round' }, 'an unknown tool falls back to the role\'s');
});

test('no picture but a look: the mascot; a picture: the picture; neither: the initial', () => {
  const look = { shape: 'hex', color: '#7ed957', eyes: 'code', acc: 'coffee' };
  const mascot = renderToStaticMarkup(createElement(AgentAvatar, { identity: agentIdentity({ name: 'nova', role: 'coder', look }, null) }));
  assert.match(mascot, /data-agent-mascot/);
  assert.match(mascot, /<svg/);
  const picture = renderToStaticMarkup(createElement(AgentAvatar, { identity: agentIdentity({ name: 'nova', look, icon_url: '/api/uploads/nova.png' }, null) }));
  assert.doesNotMatch(picture, /data-agent-mascot/);
  assert.match(picture, /<img[^>]+nova\.png/);
  const initial = renderToStaticMarkup(createElement(AgentAvatar, { identity: agentIdentity({ name: 'nova' }, null) }));
  assert.doesNotMatch(initial, /data-agent-mascot/);
  assert.match(initial, /<span>N<\/span>/);
});

test('a picked head wins over the order; a pick without its setting, an unknown pick or none keeps the order', () => {
  const look = { shape: 'hex', color: '#7ed957', eyes: 'code', acc: 'coffee' };
  const project = { icon: '/api/uploads/acme.png', color: '#123456' } as Parameters<typeof agentIdentity>[1];
  const head = (agent: Omit<Parameters<typeof agentIdentity>[0], 'name'>, p: Parameters<typeof agentIdentity>[1] = null) =>
    renderToStaticMarkup(createElement(AgentAvatar, { identity: agentIdentity({ ...agent, name: 'nova' }, p) }));
  const full = { look, emoji: '🦊', icon_url: '/api/uploads/nova.png' };

  // mascot: over the agent's picture and over the project's logo.
  assert.match(head({ ...full, avatar: 'mascot' }), /data-agent-mascot/);
  assert.match(head({ look, avatar: 'mascot' }, project), /data-agent-mascot/);
  // emoji: over the picture and the mascot.
  const emoji = head({ ...full, avatar: 'emoji' }, project);
  assert.doesNotMatch(emoji, /data-agent-mascot|<img/);
  assert.match(emoji, /<span>🦊<\/span>/);
  // image: over the mascot (a look but no pick would show the picture too, the order puts it first).
  assert.match(head({ ...full, avatar: 'image' }), /<img[^>]+nova\.png/);

  // A pick whose setting is missing falls back to the order.
  assert.match(head({ emoji: '🦊', icon_url: '/api/uploads/nova.png', avatar: 'mascot' }), /<img[^>]+nova\.png/, 'mascot without a look');
  assert.match(head({ look, avatar: 'emoji' }), /data-agent-mascot/, 'emoji without an emoji');
  assert.match(head({ look, emoji: '🦊', avatar: 'image' }), /data-agent-mascot/, 'image without a picture');

  // No pick, or one a newer daemon knows: the historical order, unchanged.
  for (const avatar of [undefined, null, 'hologram']) {
    assert.match(head({ ...full, avatar }), /<img[^>]+nova\.png/, `picture first (${String(avatar)})`);
    assert.match(head({ look, emoji: '🦊', avatar }, project), /<img[^>]+acme\.png/, 'then the project logo');
    assert.match(head({ look, emoji: '🦊', avatar }), /data-agent-mascot/, 'then the mascot');
    assert.match(head({ emoji: '🦊', avatar }), /<span>🦊<\/span>/, 'then the emoji');
  }
});
