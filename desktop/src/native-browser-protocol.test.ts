import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizedBearer, browserUrlOf, BrowserPresentationTickets, profileIdOf, trustedBrowserSender, viewportOf,
  browserFileName, browserFileChunk, BROWSER_FILE_CHUNK_BYTES,
} from './native-browser-protocol.js';

test('profile IDs cannot escape or alias another persistent profile directory', () => {
  for (const valid of ['project-a', '__timon_general__', 'agent_0192']) assert.equal(profileIdOf(valid), valid);
  for (const invalid of ['Project-a', '../personal', '..', '.', '/tmp/profile', 'project/a', 'a\\b', '', {}, 'a'.repeat(129)]) {
    assert.throws(() => profileIdOf(invalid), /Invalid browser profile/);
  }
});

test('transferred files cannot name host paths, reserved devices or alternate streams', () => {
  assert.equal(browserFileName('résumé final.pdf'), 'résumé final.pdf'); // french-ok: an accented file name, kept as is
  for (const invalid of ['../secret', '/etc/passwd', 'a\\b', 'C:secret', 'file.txt:stream', 'NUL', 'con.txt', 'a.', 'a ', '', '\0']) {
    assert.throws(() => browserFileName(invalid));
  }
});

test('file chunks are strict bounded base64, not arbitrary permissively decoded input', () => {
  const bytes = Buffer.from('uploaded data');
  assert.deepEqual(browserFileChunk(bytes.toString('base64')), bytes);
  for (const invalid of ['***', 'YQ', 'YQ==\n', 'YR==', Buffer.alloc(BROWSER_FILE_CHUNK_BYTES + 1).toString('base64')]) {
    assert.throws(() => browserFileChunk(invalid));
  }
});

test('navigation permits web sites and blank tabs but never local files or OS handlers', () => {
  assert.equal(browserUrlOf('https://example.com'), 'https://example.com/');
  assert.equal(browserUrlOf('about:blank'), 'about:blank');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'mailto:user@example.com', '//example.com', null]) {
    assert.throws(() => browserUrlOf(url));
  }
});

test('provider authentication requires the exact secret bearer', () => {
  const token = 'a'.repeat(64);
  assert.equal(authorizedBearer(`Bearer ${token}`, token), true);
  for (const value of [undefined, token, `Bearer ${token}x`, `Bearer ${'b'.repeat(64)}`, `bearer ${token}`]) {
    assert.equal(authorizedBearer(value, token), false);
  }
});

test('presentation tickets expire, stay profile scoped and can be revoked', () => {
  let now = 1000;
  const tickets = new BrowserPresentationTickets(() => now);
  const first = tickets.issue('project-a');
  assert.equal(tickets.permits('project-a', first), true);
  assert.equal(tickets.permits('project-b', first), false);
  assert.equal(tickets.permits('project-a', {}), false);
  now += 59_999;
  assert.equal(tickets.permits('project-a', first), true);
  now += 1;
  assert.equal(tickets.permits('project-a', first), false);
  const second = tickets.issue('project-a');
  const third = tickets.issue('project-b');
  tickets.revoke('project-a');
  assert.equal(tickets.permits('project-a', second), false);
  assert.equal(tickets.permits('project-b', third), true);
});

test('presentation IPC accepts only the trusted window main frame and origin', () => {
  const origin = 'http://127.0.0.1:4312';
  const sender = { isWindow: true, isMainFrame: true, url: `${origin}/agents` };
  assert.equal(trustedBrowserSender(sender, origin), true);
  for (const change of [{ isWindow: false }, { isMainFrame: false }, { url: 'https://example.com' }, { url: 'invalid' }]) {
    assert.equal(trustedBrowserSender({ ...sender, ...change }, origin), false);
  }
});

test('viewports validate dimensions and explicit mobile emulation', () => {
  assert.deepEqual(viewportOf({ width: 390, height: 844, mobile: true }), { width: 390, height: 844, mobile: true });
  for (const invalid of [{ width: 0 }, { width: 4096 }, { height: Infinity }, { width: 390.5 }, { mobile: 'true' }]) {
    assert.throws(() => viewportOf({ width: 1366, height: 768, mobile: false, ...invalid }));
  }
});
