/**
 * The remote URLs a user may configure from the Git widget (TODO #278), and
 * the masking of credentials in what is shown back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRemoteUrl, redactUrlCredentials, REMOTE_URL_MESSAGES, urlAuthority } from './git-remote-url.js';

test('accepts what people type for GitHub, GitLab, Gitea or their own server', () => {
  const cases: Array<[string, string]> = [
    ['git@github.com:owner/repo.git', 'ssh'],
    ['gitea@git.example.org:team/app', 'ssh'],
    ['git.example.org:repos/app.git', 'ssh'],
    ['ssh://git@gitlab.com/group/sub/repo.git', 'ssh'],
    ['ssh://git@[::1]:2222/srv/repo.git', 'ssh'],
    ['ssh://deploy@nas.local:2222/volume1/git/app.git', 'ssh'],
    ['git+ssh://git@example.com/r.git', 'ssh'],
    ['https://gitlab.com/group/repo.git', 'https'],
    ['https://git.example.org:3000/me/app', 'https'],
    ['http://192.168.1.10/git/app.git', 'http'],
    ['git://example.com/app.git', 'git'],
    ['file:///srv/git/app.git', 'file'],
    ['  git@github.com:o/r.git  ', 'ssh'],
  ];
  for (const [url, kind] of cases) {
    const r = checkRemoteUrl(url);
    assert.deepEqual(r, { ok: true, url: url.trim(), kind }, url);
  }
});

test('accepts an absolute local path, spaces included', () => {
  const path = process.platform === 'win32' ? 'C:\\Users\\Zoé Lefèvre\\repos\\app.git' : '/srv/git/my repo.git'; // french-ok: an accented user folder
  assert.deepEqual(checkRemoteUrl(path), { ok: true, url: path, kind: 'path' });
});

test('refuses credentials in the URL', () => {
  for (const url of [
    'https://user:secret@github.com/o/r.git',
    'https://ghp_0123456789abcdef@github.com/o/r.git',
    'http://oauth2@gitlab.example.com/o/r.git',
    'ssh://git:secret@example.com/r.git',
    'user:secret@example.com:repo.git',
  ]) {
    assert.deepEqual(checkRemoteUrl(url), { ok: false, reason: 'credentials' }, url);
  }
});

test('refuses what git would run or read as an option', () => {
  const cases: Array<[string, string]> = [
    ['ext::sh -c touch% /tmp/pwned', 'scheme'],
    ['fd::3', 'scheme'],
    ['--upload-pack=touch /tmp/x', 'option'],
    ['-oProxyCommand=x', 'option'],
    ['ssh://-oProxyCommand=x/repo', 'host'],
    ['-x@host:repo', 'option'],
    ['ftp://example.com/r.git', 'scheme'],
    ['javascript://example.com/x', 'scheme'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['git@github.com:o/r.git\nfoo', 'control-chars'],
    ['https://example.com/my repo.git', 'control-chars'],
    ['https://example.com/', 'malformed'],
    ['https://', 'malformed'],
    ['relative/path', 'malformed'],
    ['repo.git', 'malformed'],
    [`https://example.com/${'a'.repeat(2100)}`, 'too-long'],
  ];
  for (const [url, reason] of cases) {
    assert.deepEqual(checkRemoteUrl(url), { ok: false, reason }, url);
  }
});

/**
 * Forms a WHATWG parser and git read as two different hosts. Each would pass
 * as github.com to `new URL` while git, curl or ssh connect to evil.example.
 */
const AMBIGUOUS = [
  'https://github.com\\@evil.example/acme/app.git',
  'https://github.com\\\\@evil.example/acme/app.git',
  'HTTPS://GITHUB.COM\\@EVIL.EXAMPLE/acme/app.git',
  'https://github.com:443\\@evil.example/acme/app.git',
  'https://[::1]\\@evil.example/acme/app.git',
  'https://github.com/acme\\app.git',
  'http://github.com\\@evil.example/acme/app.git',
  'ssh://github.com\\@evil.example/acme/app.git',
  'ssh://evil.example%2F@github.com/acme/app.git',
  'ssh://evil.example%2f@github.com/acme/app.git',
  'ssh://git@evil.example@github.com/acme/app.git',
  'ssh://git@github%2Ecom/acme/app.git',
  'https://github%2Ecom/acme/app.git',
  'https://gíthub.com/acme/app.git', // french-ok: an IDN look-alike, not French
  'https://github。com/acme/app.git',
  'https://127.1/acme/app.git',
  'https://github.com:0443/acme/app.git',
  'ssh://git@github.com:022/acme/app.git',
  'ssh://git@github.com:/acme/app.git',
  'github.com\\@evil.example:acme/app.git',
  'file://C:\\repos\\app.git',
];

test('refuses a URL git would read as another host than a URL parser (backslash, %, second @, rewritten host)', () => {
  for (const url of AMBIGUOUS) {
    const r = checkRemoteUrl(url);
    assert.equal(r.ok, false, url);
    if (!r.ok) assert.ok(['ambiguous', 'host', 'user', 'malformed'].includes(r.reason), `${url}: ${r.reason}`);
  }
  // A user before the host is a credential over https, an empty one included.
  for (const url of [
    'https://github.com%5C@evil.example/acme/app.git',
    'https://a@b@evil.example/acme/app.git',
    'https://@github.com/acme/app.git',
    'https://github.com:x@evil.example/acme/app.git',
  ]) {
    const r = checkRemoteUrl(url);
    assert.equal(r.ok, false, url);
  }
  for (const url of ['https://evil.example#@github.com/acme/app.git', 'https://evil.example?@github.com/acme/app.git']) {
    assert.equal(checkRemoteUrl(url).ok, false, url);
  }
  assert.deepEqual(checkRemoteUrl('ssh://@github.com/acme/app.git'), { ok: false, reason: 'user' });
});

/**
 * A bracket in the user of an ssh URL: git's `host_end()` takes the bracketed
 * text as the host (`ssh -p 22 evil.example`, or an alias of the user's SSH
 * configuration for `[x]`), every URL parser reads github.com.
 */
const BRACKET_USERS = [
  'ssh://[evil.example]@github.com/acme/app.git',
  'git+ssh://[evil.example]@github.com/acme/app.git',
  'ssh+git://[evil.example]@github.com/acme/app.git',
  'ssh://[evil.example]x@github.com/acme/app.git',
  'ssh://x[evil.example]@github.com/acme/app.git',
  'ssh://[evil.example]@github.com:22/acme/app.git',
  'ssh://[x]@github.com/acme/app.git',
  'ssh://[@github.com/acme/app.git',
  'ssh://]@github.com/acme/app.git',
  'ssh://[git@evil.example]@github.com/acme/app.git',
  '[evil.example]@github.com:acme/app.git',
  '[evil.example]x@github.com:acme/app.git',
  '[x]@github.com:acme/app.git',
  'x[@github.com:acme/app.git',
  'x]@github.com:acme/app.git',
];

test('refuses a bracket in the user of an ssh remote, URL or scp form, with or without a port', () => {
  for (const url of BRACKET_USERS) {
    const r = checkRemoteUrl(url);
    assert.equal(r.ok, false, url);
    if (!r.ok) assert.ok(['ambiguous', 'user', 'malformed'].includes(r.reason), `${url}: ${r.reason}`);
    if (url.includes('://')) assert.equal(urlAuthority(url), null, url);
  }
});

test('the ssh user is a plain name, in both forms', () => {
  for (const url of [
    'ssh://git@github.com/acme/app.git', 'ssh://deploy.bot_1-x@nas.local:2222/app.git', 'org-123@github.com:acme/app.git', 'git@[::1]:repo.git',
    'ssh://git@[::1]:2222/srv/app.git', 'ssh://[::1]/srv/app.git', '[::1]:srv/app.git',
  ]) {
    assert.equal(checkRemoteUrl(url).ok, true, url);
  }
  for (const url of [
    'ssh://-x@github.com/acme/app.git', 'ssh://.x@github.com/acme/app.git', 'ssh://a!b@github.com/acme/app.git',
    'ssh://a+b@github.com/acme/app.git', "a'b@github.com:acme/app.git", 'a;b@github.com:acme/app.git', '.x@github.com:acme/app.git',
    'ssh://git@[evil.example]/acme/app.git', 'git@[evil.example]:acme/app.git', '[evil.example]:acme/app.git',
  ]) {
    assert.equal(checkRemoteUrl(url).ok, false, url);
  }
});

test('the authority is the one git cuts, or null when a URL parser reads another', () => {
  assert.deepEqual(urlAuthority('https://GitHub.com/acme/app'), { user: null, host: 'github.com', port: null });
  assert.deepEqual(urlAuthority('https://github.com:443/acme/app'), { user: null, host: 'github.com', port: '443' });
  assert.deepEqual(urlAuthority('ssh://git@GitHub.com/acme/app'), { user: 'git', host: 'github.com', port: null });
  assert.deepEqual(urlAuthority('ssh://git@[::1]:2222/srv/app.git'), { user: 'git', host: '[::1]', port: '2222' });
  assert.deepEqual(urlAuthority('ssh://git@ssh.github.com:443/acme/app'), { user: 'git', host: 'ssh.github.com', port: '443' });
  for (const url of AMBIGUOUS.filter((u) => u.includes('://'))) assert.equal(urlAuthority(url), null, url);
  assert.equal(urlAuthority('https://a@b@evil.example/x'), null);
  assert.equal(urlAuthority('https://evil.example#@github.com/x'), null);
  assert.equal(urlAuthority('https://[0:0::1]/x'), null, 'an IPv6 address WHATWG compresses');
  assert.equal(urlAuthority('git@github.com:acme/app'), null, 'not a scheme URL');
});

test('what people type still passes the authority check', () => {
  for (const url of [
    'https://GitHub.com/acme/widgets',
    'https://github.com:443/acme/widgets.git',
    'ssh://git@GitHub.com/acme/widgets.git',
    'ssh://git@ssh.github.com:443/acme/widgets.git',
    'git://example.com:9418/app.git',
    'http://192.168.1.10:8080/git/app.git',
  ]) {
    assert.equal(checkRemoteUrl(url).ok, true, url);
  }
});

test('a refusal message never quotes the URL', () => {
  for (const message of Object.values(REMOTE_URL_MESSAGES)) {
    assert.doesNotMatch(message, /secret|ghp_/);
  }
});

test('redaction masks credentials and keeps the rest of the text', () => {
  assert.equal(redactUrlCredentials('https://user:secret@github.com/o/r.git'), 'https://***@github.com/o/r.git');
  assert.equal(redactUrlCredentials('https://ghp_token@github.com/o/r.git'), 'https://***@github.com/o/r.git');
  assert.equal(
    redactUrlCredentials("fatal: unable to access 'https://u:p4ss@example.com/r.git/': Could not resolve host: example.com"),
    "fatal: unable to access 'https://***@example.com/r.git/': Could not resolve host: example.com",
  );
  assert.equal(redactUrlCredentials('ssh://git:pw@example.com/r.git'), 'ssh://***@example.com/r.git');
  // A user name alone is not a secret over ssh, and git's message is kept whole.
  assert.equal(redactUrlCredentials('ssh://git@example.com/r.git'), 'ssh://git@example.com/r.git');
  assert.equal(
    redactUrlCredentials('git@github.com: Permission denied (publickey).'),
    'git@github.com: Permission denied (publickey).',
  );
});
