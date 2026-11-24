/**
 * The URL a conflict resolution hands git is written by the daemon from
 * checked parts, never passed on as someone wrote it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgeEndpointOf, forgeNetworkUrl, forgeRepositoryPath } from './forge-network-url.js';

test('the parts of a remote: scheme, ssh user (git by default), host or alias, port without its default', () => {
  assert.deepEqual(forgeEndpointOf('git@github.com:acme/app.git'), { scheme: 'ssh', user: 'git', host: 'github.com', port: null });
  assert.deepEqual(forgeEndpointOf('GitHub-Timon:acme/app.git'), { scheme: 'ssh', user: 'git', host: 'github-timon', port: null });
  assert.deepEqual(forgeEndpointOf('ssh://org-1@ssh.github.com:443/acme/app'), { scheme: 'ssh', user: 'org-1', host: 'ssh.github.com', port: '443' });
  assert.deepEqual(forgeEndpointOf('ssh://git@github.com:22/acme/app'), { scheme: 'ssh', user: 'git', host: 'github.com', port: null });
  assert.deepEqual(forgeEndpointOf('git+ssh://git@github.com/acme/app'), { scheme: 'ssh', user: 'git', host: 'github.com', port: null });
  assert.deepEqual(forgeEndpointOf('https://GitHub.com:443/acme/app'), { scheme: 'https', host: 'github.com', port: null });
  assert.deepEqual(forgeEndpointOf('https://ghe.example.com:8443/acme/app'), { scheme: 'https', host: 'ghe.example.com', port: '8443' });
});

test('a remote with one part that is not plain gives no parts at all', () => {
  for (const url of [
    // A bracket in the user: git's host_end() reads the bracketed text as the host.
    'ssh://[evil.example]@github.com/acme/app.git',
    'ssh://[x]@github.com/acme/app.git',
    '[evil.example]@github.com:acme/app.git',
    // Forms git and a URL parser cut differently.
    'https://github.com\\@evil.example/acme/app.git',
    'ssh://evil.example%2F@github.com/acme/app.git',
    'ssh://git@evil.example@github.com/acme/app.git',
    // Not a host a forge is reached by.
    'ssh://git@[::1]/acme/app.git',
    'git@[::1]:acme/app.git',
    'https://github.com./acme/app.git',
    'https://git_hub.com/acme/app.git',
    'ssh://_alias/acme/app.git',
    'ssh://git@github.com:99999/acme/app.git',
    // Not ssh or https.
    'http://github.com/acme/app.git',
    'git://github.com/acme/app.git',
    'file:///srv/acme/app.git',
    '/srv/acme/app.git',
    // A user is a credential over https, and an ssh one is a plain name.
    'https://git@github.com/acme/app.git',
    'ssh://-oProxyCommand=x@github.com/acme/app.git',
  ]) {
    assert.equal(forgeEndpointOf(url), null, url);
  }
});

test('the repository path comes from GitHub\'s owner/name, each half plain', () => {
  assert.equal(forgeRepositoryPath('acme/app'), 'acme/app.git');
  assert.equal(forgeRepositoryPath('Acme/my.app_2-x'), 'Acme/my.app_2-x.git');
  assert.equal(forgeRepositoryPath('acme/app.git'), 'acme/app.git');
  for (const repo of ['acme', 'acme/app/x', '../app', 'acme/..', './app', 'acme/.git', 'acme/a b', 'acme/a@b', 'acme/a:b', 'acme/a%2F', '', '/app', `acme/${'a'.repeat(101)}`]) {
    assert.equal(forgeRepositoryPath(repo), null, repo);
  }
});

test('the URL is written from the parts alone, in one form', () => {
  const ssh = forgeEndpointOf('git@github-timon:acme/app.git')!;
  assert.equal(forgeNetworkUrl(ssh, 'contrib/app'), 'ssh://git@github-timon/contrib/app.git');
  const port = forgeEndpointOf('ssh://git@ssh.github.com:443/acme/app')!;
  assert.equal(forgeNetworkUrl(port, 'acme/app'), 'ssh://git@ssh.github.com:443/acme/app.git');
  const https = forgeEndpointOf('https://github.com/acme/app')!;
  assert.equal(forgeNetworkUrl(https, 'contrib/app'), 'https://github.com/contrib/app.git');
  assert.equal(forgeNetworkUrl(https, '../app'), null);
  // Parts that did not come through forgeEndpointOf are checked again.
  assert.equal(forgeNetworkUrl({ scheme: 'ssh', user: '[evil.example]', host: 'github.com', port: null }, 'acme/app'), null);
  assert.equal(forgeNetworkUrl({ scheme: 'ssh', user: 'git', host: '-oProxyCommand=x', port: null }, 'acme/app'), null);
  assert.equal(forgeNetworkUrl({ scheme: 'https', host: 'github-timon_x', port: null }, 'acme/app'), null);
  assert.equal(forgeNetworkUrl({ scheme: 'https', host: 'github.com', port: '0443' }, 'acme/app'), null);
});
