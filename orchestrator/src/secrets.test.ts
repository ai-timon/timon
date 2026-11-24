/**
 * `secrets.env`: the contract that matters: the secrets reach the env of the
 * daemon without overwriting what is already set, and they leak nowhere
 * (neither into the loading log nor into an export archive).
 */
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A TIMON_HOME of our own: this test writes a `secrets.env` and builds an export
// archive from the folder, two gestures that would skew a shared home.
process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-secrets-test-'));
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const { parseEnvFile, loadSecrets, loadSecretsAtBoot, SECRETS_FILE } = await import('./secrets.js');
const { ZONES } = await import('./paths.js');

/** Writes a throwaway secrets.env, in 0600 like the real one. */
function writeSecrets(dir: string, body: string): string {
  const file = join(dir, 'secrets.env');
  writeFileSync(file, body);
  chmodSync(file, 0o600);
  return file;
}

test('the parser reads KEY=VALUE and ignores comments, empty lines and malformed lines', () => {
  const parsed = parseEnvFile([
    '# un commentaire',
    '',
    '   ',
    'FOO=bar',
    'export QUOTED="avec espaces"',
    "SIMPLE='simple'",
    'VIDE=',
    'AVEC_DIESE=jeton#pas-un-commentaire',
    'pas une ligne de config',
    '=sans-cle',
    '1MAUVAISE_CLE=x',
  ].join('\n'));

  assert.deepEqual(parsed, {
    FOO: 'bar',
    QUOTED: 'avec espaces',
    SIMPLE: 'simple',
    VIDE: '',
    AVEC_DIESE: 'jeton#pas-un-commentaire',
  });
});

test('missing file: no-op, the daemon starts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-secrets-vide-'));
  assert.deepEqual(loadSecrets(join(dir, 'secrets.env')), []);
});

test('the keys of the file land in process.env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-secrets-charge-'));
  const file = writeSecrets(dir, 'FOO=bar\nTIMON_TEST_TOKEN="t0k3n"\n');
  delete process.env.FOO;
  delete process.env.TIMON_TEST_TOKEN;

  const applied = loadSecrets(file);

  assert.equal(process.env.FOO, 'bar');
  assert.equal(process.env.TIMON_TEST_TOKEN, 't0k3n');
  assert.deepEqual(applied.sort(), ['FOO', 'TIMON_TEST_TOKEN']);
});

test('a variable already defined in the environment is not overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-secrets-priorite-'));
  const file = writeSecrets(dir, 'TIMON_TEST_DEJA_LA=valeur-du-fichier\n');
  // systemd / the shell set the variable: they win.
  process.env.TIMON_TEST_DEJA_LA = 'valeur-de-systemd';

  const applied = loadSecrets(file);

  assert.equal(process.env.TIMON_TEST_DEJA_LA, 'valeur-de-systemd');
  assert.deepEqual(applied, [], 'a key not set must not be announced as loaded');
});

test('loading logs no value, only the key names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-secrets-log-'));
  const file = writeSecrets(dir, 'TIMON_TEST_SECRET=s3cr3t-a-ne-jamais-logger\n');
  delete process.env.TIMON_TEST_SECRET;

  const lignes: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => { lignes.push(a.join(' ')); };
  console.warn = (...a: unknown[]) => { lignes.push(a.join(' ')); };
  try {
    // `loadSecretsAtBoot` is the only variant that writes to the log.
    loadSecretsAtBoot(file);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }

  const journal = lignes.join('\n');
  assert.ok(journal.includes('TIMON_TEST_SECRET'), 'the key name must appear');
  assert.ok(!journal.includes('s3cr3t-a-ne-jamais-logger'), 'the VALUE must never appear in the log');
});

test('secrets.env is in the secrets zone and goes into no export archive', async () => {
  assert.ok((ZONES.secrets as readonly string[]).includes('secrets.env'));
  assert.ok(!(ZONES.config as readonly string[]).includes('secrets.env'));

  const home = mkdtempSync(join(tmpdir(), 'timon-secrets-export-'));
  writeSecrets(home, 'TIMON_REMOTE_MASTER=s3cr3t-export\n');
  // A bit of config, so that the archive is not empty.
  mkdirSync(join(home, 'agents', 'temoin'), { recursive: true });
  writeFileSync(join(home, 'agents', 'temoin', 'config.json'), '{"name":"temoin"}\n');

  const { exportTimon } = await import('./export.js');
  const out = join(mkdtempSync(join(tmpdir(), 'timon-secrets-archive-')), 'export.tar.gz');
  exportTimon({ out, home, vacuumInto: () => {} });
  assert.ok(statSync(out).size > 0);

  const listing = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' });
  assert.ok(listing.includes('agents/temoin/config.json'), 'the config, for its part, must indeed be exported');
  assert.ok(!listing.includes('secrets.env'), 'secrets.env must never enter an archive');

  const contenu = execFileSync('tar', ['-xzOf', out], { encoding: 'utf8' });
  assert.ok(!contenu.includes('s3cr3t-export'), 'no secret value must end up in the archive');
});

test('SECRETS_FILE vit bien sous TIMON_HOME', () => {
  assert.equal(SECRETS_FILE, join(process.env.TIMON_HOME!, 'secrets.env'));
});
