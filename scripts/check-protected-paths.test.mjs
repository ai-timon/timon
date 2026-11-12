import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL_LABEL, PACKAGE_DEPENDENCY_FIELDS, decide, evaluate, packageFieldChanges, parseProtectedList, patternToRegExp, protectedBy } from './check-protected-paths.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const list = parseProtectedList(readFileSync(join(ROOT, '.github', 'protected-paths'), 'utf8'));

test('the list names the maintainers account and protects itself and its check', () => {
  assert.deepEqual(list.allowed, ['ai-timon-admin']);
  assert.ok(protectedBy('.github/protected-paths', list.patterns));
  assert.ok(protectedBy('.github/workflows/protected-paths.yml', list.patterns));
  assert.ok(protectedBy('scripts/check-protected-paths.mjs', list.patterns));
});

// Lockfiles and npm settings of formats the repository does not use yet: they
// are listed so a pull request cannot slip one in, hence match no tracked file.
const NOT_YET_TRACKED = ['npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', '.npmrc'];

test('every pattern without a wildcard matches a tracked file, so a typo cannot leave a file unguarded', () => {
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.ok(tracked.length > 100, 'git ls-files lists the repository');
  for (const name of NOT_YET_TRACKED) assert.ok(list.patterns.includes(name), `${name} is exempted but not listed`);
  for (const pattern of list.patterns.filter((p) => !/[*?]/.test(p) && !NOT_YET_TRACKED.includes(p))) {
    const re = patternToRegExp(pattern);
    assert.ok(tracked.some((path) => re.test(path)), `${pattern} is listed but matches no tracked file`);
  }
});

test('licences, governance, trust anchors and the brand are protected; ordinary files are not', () => {
  for (const path of [
    'LICENSE', 'LICENSING.md', 'CLA.md', 'TRADEMARKS.md', 'packages/sdk/LICENSE', 'examples/LICENSE',
    'app/src/vendor/vault-graph/LICENSE', 'plugins/hermes-gateway/NOTICE', 'app/src/styles/fonts/NOTICE.md',
    '.github/workflows/ci.yml', '.github/workflows/cla.yml', '.github/CODEOWNERS', 'AGENTS.md', 'CONTRIBUTING.md',
    'orchestrator/src/license/pubkey.ts', 'orchestrator/src/plugins-bundled/updates/keyring.ts',
    'scripts/install.sh', 'scripts/install.ps1', 'orchestrator/src/brand.ts', 'app/src/lib/brand.ts',
  ]) {
    assert.ok(protectedBy(path, list.patterns), `${path} should be protected`);
  }
  for (const path of [
    'README.md', 'app/src/lib/license.ts', 'orchestrator/src/license-client.test.ts', 'app/src/locales/zh-CN/core.json',
    'orchestrator/src/plugins-bundled/updates/index.ts', 'scripts/install-linux.sh', 'public-docs/docs/usage/licence-api.md',
  ]) {
    assert.equal(protectedBy(path, list.patterns), null, `${path} should not be protected`);
  }
});

test('patterns: ** crosses folders, * stays within a name, a bare name matches in any folder', () => {
  assert.ok(patternToRegExp('.github/**').test('.github/workflows/ci.yml'));
  assert.ok(!patternToRegExp('docs/*').test('docs/a/b.md'));
  assert.ok(patternToRegExp('LICENSE').test('a/b/LICENSE'));
  assert.ok(!patternToRegExp('LICENSE').test('a/LICENSES.md'));
  assert.ok(patternToRegExp('LICENSE.*').test('LICENSE.md'));
  assert.ok(!patternToRegExp('brand.ts').test('a/subbrand.ts'));
});

const contributor = { author: 'someone', ...list };

test('a maintainer may change anything', () => {
  const files = [{ filename: 'LICENSE', status: 'modified' }, { filename: '.github/workflows/ci.yml', status: 'modified' }];
  assert.deepEqual(evaluate({ files, ...list, author: 'ai-timon-admin' }), []);
  assert.deepEqual(evaluate({ files, ...list, author: 'AI-Timon-Admin' }), []);
});

test('a contributor touching a protected path, even by renaming it away, is refused', () => {
  const violations = evaluate({ files: [{ filename: 'docs-old/LICENSE.txt', previous_filename: 'LICENSE', status: 'renamed' }], ...contributor });
  assert.deepEqual(violations.map((v) => v.path), ['docs-old/LICENSE.txt', 'LICENSE']);
  assert.equal(evaluate({ files: [{ filename: 'app/src/locales/zh-CN/core.json', status: 'added' }], ...contributor }).length, 0);
});

test('package.json: identity fields and install-time scripts are guarded', () => {
  const base = { name: 'timon-app', license: 'AGPL-3.0-only', scripts: { test: 'x' }, dependencies: { a: '1' } };
  assert.deepEqual(packageFieldChanges(base, { ...base, scripts: { test: 'y' } }, 'modified'), []);
  assert.deepEqual(packageFieldChanges(base, { ...base, license: 'MIT', author: 'Mallory' }, 'modified'), ['author', 'license']);
  assert.deepEqual(packageFieldChanges(base, { ...base, scripts: { ...base.scripts, postinstall: 'curl x | sh' } }, 'modified'), ['scripts.postinstall']);
  assert.deepEqual(packageFieldChanges(null, { name: 'new-plugin', license: 'MIT' }, 'added'), []);
  assert.deepEqual(packageFieldChanges(null, { name: 'new-plugin', scripts: { preinstall: 'x' } }, 'added'), ['scripts.preinstall']);
  assert.deepEqual(packageFieldChanges(base, null, 'removed'), ['the whole package.json (removed)']);
  const violations = evaluate({ files: [{ filename: 'app/package.json', status: 'modified', base, head: { ...base, name: 'other' } }], ...contributor });
  assert.deepEqual(violations, [{ path: 'app/package.json', reason: 'package fields: name' }]);
});

test('package.json: every dependency field is guarded, down to a version bump', () => {
  const base = { name: 'timon-app', version: '1.0.0', dependencies: { a: '1.0.0' }, devDependencies: { t: '2.0.0' } };
  assert.deepEqual(packageFieldChanges(base, { ...base, dependencies: { a: '1.0.0', evil: '1.0.0' } }, 'modified'), ['dependencies']);
  assert.deepEqual(packageFieldChanges(base, { ...base, dependencies: { a: '1.0.1' } }, 'modified'), ['dependencies']);
  assert.deepEqual(packageFieldChanges(base, { ...base, dependencies: {} }, 'modified'), ['dependencies']);
  for (const field of PACKAGE_DEPENDENCY_FIELDS) {
    assert.deepEqual(packageFieldChanges(base, { ...base, [field]: { x: '1' } }, 'modified'), [field], `${field} should be guarded`);
  }
  const violations = evaluate({ files: [{ filename: 'app/package.json', status: 'modified', base, head: { ...base, devDependencies: { t: '2.0.1' } } }], ...contributor });
  assert.deepEqual(violations, [{ path: 'app/package.json', reason: 'package fields: devDependencies' }]);
});

test('package.json: an unchanged dependency block passes, even when other fields move', () => {
  const base = { name: 'timon-app', version: '1.0.0', description: 'a', dependencies: { a: '1.0.0' }, overrides: { b: '2' } };
  const head = { ...base, version: '1.0.1', description: 'b', dependencies: { a: '1.0.0' } };
  assert.deepEqual(packageFieldChanges(base, head, 'modified'), []);
  assert.deepEqual(evaluate({ files: [{ filename: 'app/package.json', status: 'modified', base, head }], ...contributor }), []);
});

test('package.json: a new one passes only if it pulls nothing in', () => {
  const bare = { name: 'new-plugin', license: 'MIT', dependencies: {}, devDependencies: {}, workspaces: [], bundleDependencies: false };
  assert.deepEqual(evaluate({ files: [{ filename: 'plugins/new/package.json', status: 'added', base: null, head: bare }], ...contributor }), []);
  const pulling = { ...bare, dependencies: { 'left-pad': '1.3.0' }, bundleDependencies: true };
  assert.deepEqual(
    evaluate({ files: [{ filename: 'plugins/new/package.json', status: 'added', base: null, head: pulling }], ...contributor }),
    [{ path: 'plugins/new/package.json', reason: 'package fields: dependencies, bundleDependencies' }],
  );
});

test('lockfiles and npm configuration are protected in any folder', () => {
  for (const path of ['package-lock.json', 'app/package-lock.json', 'plugins/x/npm-shrinkwrap.json', 'yarn.lock', 'desktop/pnpm-lock.yaml', '.npmrc', 'app/.npmrc']) {
    assert.ok(protectedBy(path, list.patterns), `${path} should be protected`);
  }
  assert.deepEqual(
    evaluate({ files: [{ filename: 'orchestrator/package-lock.json', status: 'modified' }], ...contributor }),
    [{ path: 'orchestrator/package-lock.json', reason: 'protected path (package-lock.json)' }],
  );
});

test('a maintainer may change dependencies and lockfiles', () => {
  const base = { name: 'timon-app', dependencies: { a: '1' } };
  const files = [
    { filename: 'app/package.json', status: 'modified', base, head: { ...base, dependencies: { a: '2' } } },
    { filename: 'plugins/new/package.json', status: 'added', base: null, head: { name: 'n', dependencies: { b: '1' } } },
    { filename: 'app/package-lock.json', status: 'modified' },
  ];
  assert.equal(evaluate({ files, ...contributor }).length, 3);
  assert.deepEqual(evaluate({ files, ...list, author: 'ai-timon-admin' }), []);
});

test('a maintainer label approves the protected changes it saw, and a new push withdraws it', () => {
  const violations = [{ path: 'THIRD_PARTY_NOTICES.md', reason: 'protected path' }];
  assert.deepEqual(decide({ violations: [], labels: [], action: 'opened' }), { pass: true, removeLabel: false, approved: false });
  assert.equal(decide({ violations, labels: [], action: 'opened' }).pass, false);
  assert.deepEqual(decide({ violations, labels: [APPROVAL_LABEL], action: 'labeled' }), { pass: true, removeLabel: false, approved: true });
  assert.deepEqual(decide({ violations, labels: [APPROVAL_LABEL], action: 'synchronize' }), { pass: false, removeLabel: true, approved: false });
  assert.equal(decide({ violations, labels: ['other'], action: 'labeled' }).pass, false);
});
