// french-ok-file: an accented agent tag, the Unicode routing under test
/**
 * A channel message that starts with `@tag` goes to the agent the channel's
 * routing table names for it; tags are written in any script, like agent names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeMessage } from './router';

const ROUTING = { '@dev': 'coder', '@马斯克': '马斯克', '@Zoë': 'Zoë' };

test('a known tag routes the message and is taken out of it', () => {
  assert.deepEqual(routeMessage('@dev fix this', 'main', ROUTING), { agent: 'coder', cleanedText: 'fix this' });
  assert.deepEqual(routeMessage('@马斯克 你好', 'main', ROUTING), { agent: '马斯克', cleanedText: '你好' });
  assert.deepEqual(routeMessage('@Zoë hi', 'main', ROUTING), { agent: 'Zoë', cleanedText: 'hi' }, 'a decomposed tag is the composed one');
});

test('anything else goes to the default agent untouched', () => {
  assert.deepEqual(routeMessage('@unknown hi', 'main', ROUTING), { agent: 'main', cleanedText: '@unknown hi' });
  assert.deepEqual(routeMessage('hello @dev', 'main', ROUTING), { agent: 'main', cleanedText: 'hello @dev' });
  assert.deepEqual(routeMessage('@dev', 'main', ROUTING), { agent: 'main', cleanedText: '@dev' });
});
