import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { notificationHref } from './notification-href';

/**
 * Same cases as the daemon's `web-push/href.test.ts`: the rail and the phone
 * must open the same page for one card.
 */
const none = { mission_id: null, task_id: null };

test('a plugin consent card opens the Secrets page with the grant to confirm', () => {
  assert.equal(
    notificationHref({ ...none, anchor: 'plugin-secret:acme-connector:GITHUB_TOKEN' }),
    '/secrets?grant=GITHUB_TOKEN&plugin=acme-connector',
  );
  assert.equal(
    notificationHref({ ...none, anchor: 'plugin-secret:@acme/todo:sync:API_KEY' }),
    '/secrets?grant=API_KEY&plugin=%40acme%2Ftodo%3Async',
  );
});

test('a refused provider launch opens the providers settings on that plugin', () => {
  assert.equal(
    notificationHref({ ...none, anchor: 'provider-launch:acme-provider' }),
    '/?settings=models%2Fbackends&provider=acme-provider',
  );
  assert.equal(
    notificationHref({ ...none, anchor: 'provider-launch:@acme/x' }),
    '/?settings=models%2Fbackends&provider=%40acme%2Fx',
  );
  assert.equal(notificationHref({ ...none, anchor: 'provider-launch:' }), null);
  // The Program section is the full level's: no link for anyone else.
  const launch = { ...none, anchor: 'provider-launch:acme-provider' };
  assert.equal(notificationHref(launch, { providers: 'full' }), '/?settings=models%2Fbackends&provider=acme-provider');
  assert.equal(notificationHref(launch, { providers: 'accounts' }), null);
  assert.equal(notificationHref(launch, { providers: 'none' }), null);
  assert.equal(notificationHref(launch, { providers: null }), null, 'not a link while the level is being read');
});

test("a new outbound host opens the mission's chat on its Network view", () => {
  assert.equal(
    notificationHref({ mission_id: 'm-1', task_id: null, anchor: 'egress:m-1' }),
    '/chat?mission=m-1&egress=1',
  );
  assert.equal(notificationHref({ ...none, anchor: 'egress:a b' }), '/chat?mission=a%20b&egress=1');
  assert.equal(notificationHref({ mission_id: 'm-1', task_id: null, anchor: 'egress:' }), '/chat?mission=m-1&highlight=egress%3A');
});

test('anything that is not a well-formed consent anchor keeps its old meaning', () => {
  assert.equal(notificationHref({ ...none, anchor: 'plugin-secret:acme:lower_case' }), null);
  assert.equal(notificationHref({ ...none, anchor: 'plugin-secret::API_KEY' }), null);
  assert.equal(notificationHref({ ...none, anchor: 'plugin-spawn:acme' }), null);
  assert.equal(notificationHref({ ...none, anchor: '/settings' }), '/settings');
  assert.equal(
    notificationHref({ mission_id: 'm1', task_id: null, anchor: 'plugin-secret:acme:API_KEY' }),
    '/chat?mission=m1&highlight=plugin-secret%3Aacme%3AAPI_KEY',
  );
});

test('a proposed GitHub publication opens its dialog, as the push payload does', () => {
  const id = '0f9c2a54-61f7-4c55-9b0e-0d6b2f6c1e11';
  assert.equal(notificationHref({ ...none, anchor: `forge-proposal:acme:${id}` }), `/?forge-proposal=${id}&forge-project=acme`);
  assert.equal(notificationHref({ ...none, anchor: `forge-proposal:${id}` }), null);
  assert.equal(notificationHref({ ...none, anchor: 'forge-proposal:acme:not-an-id' }), null);
});
