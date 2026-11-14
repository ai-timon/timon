/**
 * `timon plugin check` (TODO #643): each rule fires on the package that breaks
 * it and stays quiet on one that does not. npm is injected so the cases do not
 * depend on the machine; one case runs the real `npm pack --dry-run` on every
 * template of the repository, each of which must pass with no error.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signCrypto } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { checkPluginFolder, checkExitCode, formatCheckReport, npmPackLister, npmCouldNotStart } = await import('./preship-check.js');
const { hashPluginDirectory } = await import('./signature.js');
const { PLUGIN_API_VERSION } = await import('./manifest.js');
const { getHost } = await import('../host/index.js');
type PackLister = import('./preship-check.js').PackLister;

const pair = generateKeyPairSync('ed25519');
const KEYS = [{ keyId: 'test-check', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
const WORK = mkdtempSync(join(tmpdir(), 'timon-check-'));
let serial = 0;

type Files = Record<string, string>;
const MANIFEST = { id: 'acme-check', apiVersion: 1, kind: 'behavior', label: 'Check', permissions: [] as string[] };

function pkg(opts: { json?: Record<string, unknown>; manifest?: Record<string, unknown>; files?: Files; signed?: boolean } = {}): string {
  const dir = join(WORK, `p-${++serial}`);
  mkdirSync(dir, { recursive: true });
  const json = {
    name: '@acme/check', version: '1.0.0', type: 'module', main: 'lib/index.js', files: ['lib', 'README.md'],
    timon: { ...MANIFEST, ...(opts.manifest ?? {}) },
    ...(opts.json ?? {}),
  };
  const files: Files = {
    'package.json': JSON.stringify(json, null, 2),
    'lib/index.js': 'export function apply() {}\n',
    'README.md': '# Check\n\nA plugin.\n',
    ...(opts.files ?? {}),
  };
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, ...path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  if (opts.signed) {
    const hash = hashPluginDirectory(dir);
    writeFileSync(join(dir, 'SIGNATURE'), JSON.stringify({
      alg: 'ed25519', keyId: 'test-check', hash, sig: signCrypto(null, Buffer.from(hash, 'hex'), pair.privateKey).toString('base64'),
    }));
  }
  return dir;
}

/** What npm would answer: the folder through `files` here, without npm itself. */
const noNpm: PackLister = async () => null;
const packed = (files: string[]): PackLister => async () => ({ files });
const DEFAULT_PACK = packed(['README.md', 'lib/index.js', 'package.json']);

const rules = (r: { findings: Array<{ rule: string }> }) => r.findings.map((f) => f.rule);

test('a clean signed package passes with no finding, and its install sheet is what the manifest says', async () => {
  const dir = pkg({ signed: true, manifest: { permissions: ['storage', 'missions:control'] } });
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: async () => ({ files: ['README.md', 'SIGNATURE', 'lib/index.js', 'package.json'] }) });
  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
  assert.equal(report.signature, 'signed');
  assert.equal(checkExitCode(report), 0);
  assert.equal(report.sheet?.id, 'acme-check');
  assert.deepEqual(report.sheet?.permissions.find((p) => p.name === 'missions:control'), { name: 'missions:control', sensitive: true });
  assert.match(formatCheckReport(report), /0 error\(s\), 0 warning\(s\)/);
  assert.ok(report.manual.length >= 4, 'the rules no regex decides are listed');
});

test('an invalid manifest is an error pointing at the `timon` field', async () => {
  const dir = pkg({ manifest: { id: 'Bad Id' } });
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: DEFAULT_PACK });
  const finding = report.findings.find((f) => f.rule === 'manifest');
  assert.ok(finding);
  assert.equal(finding.level, 'error');
  assert.equal(finding.file, 'package.json');
  assert.ok(finding.line > 1, 'the line of `"timon"`');
  assert.equal(report.sheet, null);
  assert.equal(checkExitCode(report), 1);
});

test('a manifest asking a newer contract than this daemon is refused the way admission refuses it', async () => {
  const dir = pkg({ manifest: { apiVersion: PLUGIN_API_VERSION + 1 } });
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: DEFAULT_PACK });
  assert.match(report.findings.find((f) => f.rule === 'manifest')?.message ?? '', /apiVersion/);
});

test('engines.node the daemon\'s Node does not satisfy is an error naming both versions (TODO #763)', async () => {
  const runtime = { node: '20.18.3', electron: '33.4.11', packaged: true, source: 'daemon' as const };
  const dir = pkg({ json: { engines: { node: '>=22.5' } } });
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: DEFAULT_PACK, runtime });
  const finding = report.findings.find((f) => f.rule === 'node-engine');
  assert.equal(finding?.level, 'error');
  assert.ok((finding?.line ?? 0) > 0, 'points at the engines key');
  assert.match(finding?.message ?? '', /requires Node >=22\.5.*runs Node 20\.18\.3/);
  assert.equal(report.ok, false);

  const fits = await checkPluginFolder(pkg({ json: { engines: { node: '>=20' } } }), { keys: KEYS, pack: DEFAULT_PACK, runtime });
  assert.ok(!rules(fits).includes('node-engine'));
  const unreadable = await checkPluginFolder(pkg({ json: { engines: { node: 'lts' } } }), { keys: KEYS, pack: DEFAULT_PACK, runtime });
  assert.equal(unreadable.findings.find((f) => f.rule === 'node-engine')?.level, 'warn');
});

test('a signature that no longer matches is an error, even without --strict', async () => {
  const dir = pkg({ signed: true });
  writeFileSync(join(dir, 'lib', 'index.js'), 'export function apply() { /* edited after signing */ }\n');
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: DEFAULT_PACK });
  assert.equal(report.signature, 'invalid');
  assert.deepEqual(report.findings.map((f) => [f.level, f.rule, f.file]), [['error', 'signature', 'SIGNATURE']]);
  assert.equal(checkExitCode(report), 1);
});

test('a signature by a key this Timon does not know is invalid too, not "unsigned"', async () => {
  const dir = pkg({ signed: true });
  const report = await checkPluginFolder(dir, { keys: [], pack: DEFAULT_PACK });
  assert.equal(report.signature, 'invalid');
  assert.equal(report.findings[0]?.level, 'error');
});

test('an unsigned package is a warning; --strict makes every warning an error', async () => {
  const dir = pkg();
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: DEFAULT_PACK });
  assert.equal(report.signature, 'unsigned');
  assert.deepEqual(report.findings.map((f) => [f.level, f.rule]), [['warn', 'unsigned']]);
  assert.equal(checkExitCode(report), 0);

  const strict = await checkPluginFolder(dir, { keys: KEYS, pack: DEFAULT_PACK, strict: true });
  assert.deepEqual(strict.findings.map((f) => [f.level, f.rule]), [['error', 'unsigned']]);
  assert.equal(strict.strict, true);
  assert.equal(checkExitCode(strict), 1);
});

test('npm absent: the shipped files come from `files`, with a warning that says so', async () => {
  const dir = pkg({ signed: true, files: { 'notes/todo.md': 'private notes\n', 'lib/extra.js': 'export {};\n' } });
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: noNpm });
  assert.deepEqual(rules(report), ['npm-missing']);
  assert.equal(report.findings[0]?.level, 'warn');
  assert.equal(report.packed.source, 'files');
  assert.deepEqual(report.packed.files, ['README.md', 'lib/extra.js', 'lib/index.js', 'package.json']);
  assert.equal(checkExitCode(report), 0);
});

test('npm absent and no `files`: the whole folder is read as shipped, and the missing allow-list is an error', async () => {
  const dir = pkg({ json: { files: undefined }, files: { '.env': 'TOKEN=x\n' } });
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: noNpm });
  assert.equal(report.packed.source, 'folder');
  assert.ok(rules(report).includes('files'));
  assert.ok(rules(report).includes('packed-env'));
  assert.ok(rules(report).includes('npm-missing'));
});

test('npm refusing the package is an error, and the check still reads the folder', async () => {
  const dir = pkg();
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: async () => ({ error: 'Invalid name' }) });
  assert.match(report.findings.find((f) => f.rule === 'pack')?.message ?? '', /Invalid name/);
  assert.equal(report.packed.source, 'files');
});

test('development leftovers in what ships are errors; an `.env.example` is not', async () => {
  const dir = pkg();
  const report = await checkPluginFolder(dir, {
    keys: KEYS,
    pack: packed(['package.json', 'README.md', 'lib/index.js', '.env', '.env.example', 'data/app.db', 'debug.log', 'tests/a.test.js', 'lib/x.spec.ts', 'state/cache.json', 'lib/state/store.js', 'key.pem']),
  });
  const byFile = Object.fromEntries(report.findings.map((f) => [f.file, f.rule]));
  assert.equal(byFile['.env'], 'packed-env');
  assert.equal(byFile['.env.example'], undefined);
  assert.equal(byFile['data/app.db'], 'packed-data');
  assert.equal(byFile['debug.log'], 'packed-log');
  assert.equal(byFile['tests/a.test.js'], 'packed-dev');
  assert.equal(byFile['lib/x.spec.ts'], 'packed-dev');
  assert.equal(byFile['state/cache.json'], 'packed-dev');
  assert.equal(byFile['lib/state/store.js'], undefined, 'a source folder named state is code, not local state');
  assert.equal(byFile['key.pem'], 'packed-key');
});

test('an entry point the package does not ship is an error', async () => {
  const dir = pkg({ json: { exports: { './client': './lib/client.js' } } });
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: DEFAULT_PACK });
  const entry = report.findings.find((f) => f.rule === 'entry');
  assert.match(entry?.message ?? '', /lib\/client\.js/);
  assert.equal(entry?.level, 'error');
});

test('machine paths, repository files, personal emails and literal secret names are errors with their line', async () => {
  const dir = pkg({
    files: {
      'lib/index.js': [
        'export function apply(ctx) {',
        "  const root = '/home/jane/notes';",
        "  const brief = 'read AGENTS.md first';",
        "  const to = 'jane.doe@gmail.com';",
        "  return ctx.secrets.get('OPENAI_KEY');",
        '}',
      ].join('\n'),
    },
  });
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: DEFAULT_PACK });
  const at = (rule: string) => report.findings.find((f) => f.rule === rule);
  assert.deepEqual([at('machine-path')?.line, at('author-file')?.line, at('personal-email')?.line, at('secret-literal')?.line], [2, 3, 4, 5]);
  for (const rule of ['machine-path', 'author-file', 'personal-email', 'secret-literal']) assert.equal(at(rule)?.level, 'error');
  assert.match(formatCheckReport(report), /^error  machine-path  lib\/index\.js:2  /m);
});

test('localhost, a hard-coded zone or locale and a dev hook are warnings', async () => {
  const dir = pkg({
    files: {
      'lib/index.js': "const a = 'http://localhost:8080';\nconst z = 'Europe/Paris';\nconst l = d.toLocaleString('fr-FR');\nwindow.__demoBoot = 1;\nconst t = createTranslator({ 'zh-CN': { title: 'x' } });\n",
    },
  });
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: DEFAULT_PACK });
  const got = report.findings.filter((f) => f.rule !== 'unsigned').map((f) => [f.level, f.rule, f.line]);
  assert.deepEqual(got, [['warn', 'localhost', 1], ['warn', 'locale', 2], ['warn', 'locale', 3], ['warn', 'dev-hook', 4]]);
});

test('--deny words are errors in code, but not in the publisher metadata of package.json or in LICENSE', async () => {
  const dir = pkg({
    json: { name: '@janedoe/check', author: 'Jane Doe <jane@gmail.com>', repository: 'github:janedoe/check' },
    files: { 'lib/index.js': "// written for JaneDoe's setup\n", LICENSE: 'Copyright Jane Doe <jane@gmail.com>\n' },
  });
  const report = await checkPluginFolder(dir, { keys: KEYS, deny: ['janedoe'], pack: packed(['LICENSE', 'README.md', 'lib/index.js', 'package.json']) });
  const deny = report.findings.filter((f) => f.rule === 'deny' || f.rule === 'personal-email');
  assert.deepEqual(deny.map((f) => [f.rule, f.file, f.line]), [['deny', 'lib/index.js', 1]]);
});

test('--deny still catches the word in a manifest string that is not metadata', async () => {
  const dir = pkg({ manifest: { description: 'Sync for janedoe only' } });
  const report = await checkPluginFolder(dir, { keys: KEYS, deny: ['JaneDoe'], pack: DEFAULT_PACK });
  const hit = report.findings.find((f) => f.rule === 'deny');
  assert.equal(hit?.file, 'package.json');
  assert.ok((hit?.line ?? 0) > 0);
});

test('`timon-check: <reason>` on the line or the one above justifies a finding; an empty one does not', async () => {
  const dir = pkg({
    files: {
      'lib/index.js': [
        "const a = 'http://localhost:11434'; // timon-check: Ollama's documented default, editable in settings",
        '// timon-check: example shown in the setup screen',
        "const b = 'Europe/Paris';",
        "const c = 'en-US'; // timon-check:",
      ].join('\n'),
    },
  });
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: DEFAULT_PACK });
  assert.deepEqual(report.justified.map((f) => [f.rule, f.line, f.reason]), [
    ['localhost', 1, "Ollama's documented default, editable in settings"],
    ['locale', 3, 'example shown in the setup screen'],
  ]);
  assert.deepEqual(report.findings.filter((f) => f.rule !== 'unsigned').map((f) => [f.rule, f.line]), [['locale', 4]]);
});

test('hosts and programs the manifest declares must be named in the README', async () => {
  const dir = pkg({
    manifest: {
      permissions: ['http:outbound', 'secrets:read'],
      secrets: [{ name: 'API_TOKEN', mode: 'read' }],
      http: { hosts: [{ host: 'api.example.com' }, { host: 'cdn.example.org' }] },
    },
    files: { 'README.md': '# Check\n\nCalls api.example.com.\n' },
  });
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: DEFAULT_PACK });
  assert.deepEqual(report.findings.filter((f) => f.rule === 'readme-hosts').map((f) => f.message.includes('cdn.example.org')), [true]);
  assert.deepEqual(report.sheet?.hosts, ['api.example.com', 'cdn.example.org']);
  assert.deepEqual(report.sheet?.secrets, [{ name: 'API_TOKEN', mode: 'read' }]);
});

test('`http:outbound` without `http.hosts` is a warning, unless the destinations are approved connections', async () => {
  const bare = pkg({ manifest: { permissions: ['http:outbound'] } });
  const warned = await checkPluginFolder(bare, { keys: KEYS, pack: DEFAULT_PACK });
  assert.deepEqual(warned.findings.filter((f) => f.rule === 'http-hosts').map((f) => f.level), ['warn']);

  const named = pkg({ manifest: { permissions: ['http:outbound'], http: { hosts: [{ host: 'api.example.com' }] } }, files: { 'README.md': '# Check\n\nCalls api.example.com.\n' } });
  assert.ok(!rules(await checkPluginFolder(named, { keys: KEYS, pack: DEFAULT_PACK })).includes('http-hosts'));

  // Each connection's address is approved by an administrator, one by one.
  const connections = pkg({ manifest: { apiVersion: 7, permissions: ['connections:register', 'connections:users:read', 'http:outbound'] } });
  const report = await checkPluginFolder(connections, { keys: KEYS, pack: DEFAULT_PACK });
  assert.ok(report.sheet, formatCheckReport(report));
  assert.ok(!rules(report).includes('http-hosts'), formatCheckReport(report));

  // Reading connections is not declaring them: the exemption stays narrow.
  const reader = pkg({ manifest: { apiVersion: 3, permissions: ['connections:read', 'http:outbound'] } });
  const readerReport = await checkPluginFolder(reader, { keys: KEYS, pack: DEFAULT_PACK });
  assert.ok(readerReport.sheet, formatCheckReport(readerReport));
  assert.ok(rules(readerReport).includes('http-hosts'));
});

test('no README shipped is a warning; a bundled React in the browser half is a warning', async () => {
  const dir = pkg({ files: { 'lib/client.js': 'var x = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;\n' } });
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: packed(['lib/client.js', 'lib/index.js', 'package.json']) });
  assert.ok(rules(report).includes('readme'));
  assert.equal(report.findings.find((f) => f.rule === 'bundled-react')?.file, 'lib/client.js');
});

test('no package.json: an error, and nothing else is guessed', async () => {
  const dir = join(WORK, `empty-${++serial}`);
  mkdirSync(dir);
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: DEFAULT_PACK });
  assert.equal(report.findings[0]?.rule, 'package-json');
  assert.equal(checkExitCode(report), 1);
});

test('every repository template passes the check with the real npm: no error, no warning but the signature (TODO #694)', async (t) => {
  const probe = await getHost().execAsync('npm', ['--version']).catch(() => null);
  if (!probe || probe.code !== 0) { t.skip('npm is not available here'); return; }
  // A third-party developer starts from these folders: what they ship is
  // what the recipient installs, so a template must already pass.
  const root = fileURLToPath(new URL('../../../examples/', import.meta.url));
  const templates = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'package.json')))
    .map((e) => e.name);
  assert.ok(templates.length >= 24, `only ${templates.length} templates found`);
  const reports = await Promise.all(templates.map(async (name) => {
    const report = await checkPluginFolder(join(root, name), { pack: npmPackLister });
    return { name, report };
  }));
  // Every template at once: one failing folder must not hide the others.
  const failing = reports.filter(({ report }) => report.packed.source !== 'npm'
    || !report.packed.files.includes('package.json')
    || report.findings.some((f) => f.rule !== 'unsigned'));
  assert.deepEqual(failing.map((r) => r.name), [], failing.map((r) => `── ${r.name}\n${formatCheckReport(r.report)}`).join('\n\n'));
});

test('listing with the real npm never runs a script of the plugin (`prepack`, `prepare`)', async (t) => {
  const probe = await getHost().execAsync('npm', ['--version']).catch(() => null);
  if (!probe || probe.code !== 0) { t.skip('npm is not available here'); return; }
  // An absolute target: the script would run in whatever folder npm is given.
  const ran = join(WORK, `ran-${++serial}`);
  const marker = `node -e "require('fs').writeFileSync(${JSON.stringify(ran).replace(/"/g, "'")}, 'x')"`;
  const dir = pkg({ json: { scripts: { prepack: marker, prepare: marker, postpack: marker } } });
  const report = await checkPluginFolder(dir, { keys: KEYS, pack: npmPackLister });
  assert.equal(report.packed.source, 'npm');
  assert.equal(existsSync(ran), false, 'a lifecycle script ran');
});

test('npm that could not start is told apart from npm refusing the package, in any language', () => {
  // `env` finds no `node`: its message follows the user's locale, the exit code does not.
  assert.equal(npmCouldNotStart({ code: 127, stdout: '', stderr: '/usr/bin/env: «node»: Aucun fichier ou dossier de ce nom\n' }), true);
  assert.equal(npmCouldNotStart({ code: 127, stdout: '', stderr: '' }), true);
  assert.equal(npmCouldNotStart({ code: 1, stdout: '', stderr: "'npm' is not recognized as an internal or external command" }), true);
  assert.equal(npmCouldNotStart({ code: 1, stdout: '', stderr: 'spawn npm ENOENT' }), true);
  // npm ran and said no: a real `pack` error.
  assert.equal(npmCouldNotStart({ code: 1, stdout: '', stderr: 'npm error code EJSONPARSE' }), false);
  assert.equal(npmCouldNotStart({ code: 127, stdout: '[]', stderr: '' }), false);
});
