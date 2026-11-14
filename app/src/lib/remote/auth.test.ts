/**
 * The remote API refuses plain HTTP unless `TIMON_ALLOW_HTTP` is exactly `1`,
 * the value `web-app::envOf` writes. The daemon also writes `0`, and a Compose
 * `.env` can hold anything: only the refusals below keep the token off the wire.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { authenticateMaster, requireHttps } from './auth';

const URL_HTTP = 'http://timon.localhost/api/remote/agents';
const saved = { allow: process.env.TIMON_ALLOW_HTTP, master: process.env.TIMON_REMOTE_MASTER };

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => { delete process.env.TIMON_ALLOW_HTTP; });
afterEach(() => {
  restore('TIMON_ALLOW_HTTP', saved.allow);
  restore('TIMON_REMOTE_MASTER', saved.master);
});

const request = (headers: Record<string, string> = {}) => new Request(URL_HTTP, { headers });

test('plain HTTP is refused when the setting is absent, off, or anything but 1', () => {
  assert.equal(requireHttps(request())?.status, 426, 'absent');
  for (const value of ['0', '', 'true', 'yes', '1 ', 'on']) {
    process.env.TIMON_ALLOW_HTTP = value;
    assert.equal(requireHttps(request())?.status, 426, JSON.stringify(value));
  }
});

test('a forwarded protocol other than https is refused', () => {
  assert.equal(requireHttps(request({ 'x-forwarded-proto': 'http' }))?.status, 426);
});

test('the master token is not looked at over plain HTTP, even a correct one', () => {
  process.env.TIMON_REMOTE_MASTER = 'the-master';
  process.env.TIMON_ALLOW_HTTP = '0';
  assert.equal(authenticateMaster(request({ authorization: 'Bearer the-master' }))?.status, 426);
});

test('https forwarded by the proxy passes, and so does an explicit 1', () => {
  assert.equal(requireHttps(request({ 'x-forwarded-proto': 'https' })), null);
  process.env.TIMON_ALLOW_HTTP = '1';
  assert.equal(requireHttps(request()), null);
});

test('over an accepted transport, a wrong master token is still refused', () => {
  process.env.TIMON_REMOTE_MASTER = 'the-master';
  process.env.TIMON_ALLOW_HTTP = '1';
  assert.equal(authenticateMaster(request())?.status, 401);
  assert.equal(authenticateMaster(request({ authorization: 'Bearer wrong' }))?.status, 401);
  assert.equal(authenticateMaster(request({ authorization: 'Bearer the-master' })), null);
});

test('the master token is compared whole: same length, other length and empty are all refused', () => {
  process.env.TIMON_REMOTE_MASTER = 'the-master';
  process.env.TIMON_ALLOW_HTTP = '1';
  for (const value of ['the-masteR', 'xhe-master', 'the-master-and-more', 'the-maste']) {
    assert.equal(authenticateMaster(request({ authorization: `Bearer ${value}` }))?.status, 401, JSON.stringify(value));
  }
  assert.equal(authenticateMaster(request({ authorization: 'Bearer ' }))?.status, 401, 'empty bearer');
  assert.equal(authenticateMaster(request({ authorization: '' }))?.status, 401, 'empty header');
});
