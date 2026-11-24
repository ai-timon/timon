/**
 * The two surfaces of the same list: they must fall silent with one
 * voice, and never copy each other's detail.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DelegationsBar } from '../components/chat/delegations-bar';
import type { Delegation } from '../hooks/use-delegations';

function delegation(over: Partial<Delegation> = {}): Delegation {
  return {
    id: 'child-1',
    agent_name: 'timon.coder',
    started_at: Date.now() - 90_000,
    running: true,
    turn_active: true,
    task_id: null,
    task_title: null,
    excerpt: 'composer rework',
    ...over,
  };
}

test('no delegation: the banner paints nothing', () => {
  assert.equal(renderToStaticMarkup(React.createElement(DelegationsBar, { delegations: [] })), '');
});

test('the banner announces the count and names each agent once', () => {
  const html = renderToStaticMarkup(
    React.createElement(DelegationsBar, {
      delegations: [
        delegation(),
        delegation({ id: 'child-2' }),
        delegation({ id: 'child-3', agent_name: 'timon.reviewer' }),
      ],
    }),
  );
  assert.ok(html.includes('3 delegated missions running'));
  assert.ok(html.includes('timon.coder, timon.reviewer'));
  // Restraint: the brief belongs to the rail card, not to the thread.
  assert.ok(!html.includes('composer rework'));
});
