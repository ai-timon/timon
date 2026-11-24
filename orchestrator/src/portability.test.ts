import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'timon-portability-test-'));
process.env.TIMON_HOME = HOME;

const { rewriteAbsolutePaths } = await import('./portability.js');

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), 'timon-export-'));
  mkdirSync(join(root, 'agents', 'projet.coder'), { recursive: true });
  mkdirSync(join(root, 'agents', 'projet.reviewer'), { recursive: true });
  mkdirSync(join(root, 'projects', 'projet'), { recursive: true });
  mkdirSync(join(root, 'mcp'), { recursive: true });

  writeFileSync(
    join(root, 'agents', 'projet.coder', 'config.json'),
    JSON.stringify({ name: 'projet.coder', cwd: join(homedir(), 'webdev/projects/projet') }),
  );
  writeFileSync(
    join(root, 'agents', 'projet.reviewer', 'config.json'),
    JSON.stringify({ name: 'projet.reviewer', cwd: '/opt/ailleurs' }),
  );
  writeFileSync(
    join(root, 'projects', 'projet', 'meta.json'),
    JSON.stringify({ slug: 'projet', cwd: join(homedir(), 'webdev/projects/projet') }),
  );
  writeFileSync(
    join(root, 'mcp', 'notes.json'),
    JSON.stringify({
      id: 'notes',
      transport: {
        type: 'stdio',
        command: join(homedir(), '.local/bin/notes-mcp'),
        args: ['--vault', join(homedir(), 'projects/notes/vault')],
        env: { VAULT: join(homedir(), 'vault'), MODE: 'ro' },
      },
    }),
  );
  return root;
}

test('export: the paths under the home become ~, the others do not move', () => {
  const root = seed();
  const dry = rewriteAbsolutePaths(root, 'export');
  assert.equal(dry.written.length, 0, 'dry-run: no file written');
  assert.equal(dry.changes.length, 5);

  const report = rewriteAbsolutePaths(root, 'export', { write: true });
  assert.equal(report.written.length, 3, 'an agent outside the home stays intact');

  const agent = JSON.parse(readFileSync(join(root, 'agents', 'projet.coder', 'config.json'), 'utf8'));
  assert.equal(agent.cwd, '~/webdev/projects/projet');
  const other = JSON.parse(readFileSync(join(root, 'agents', 'projet.reviewer', 'config.json'), 'utf8'));
  assert.equal(other.cwd, '/opt/ailleurs');
  const meta = JSON.parse(readFileSync(join(root, 'projects', 'projet', 'meta.json'), 'utf8'));
  assert.equal(meta.cwd, '~/webdev/projects/projet');
  const mcp = JSON.parse(readFileSync(join(root, 'mcp', 'notes.json'), 'utf8'));
  assert.equal(mcp.transport.command, '~/.local/bin/notes-mcp');
  assert.equal(mcp.transport.args[1], '~/projects/notes/vault');
  assert.equal(mcp.transport.env.VAULT, '~/vault');
  assert.equal(mcp.transport.env.MODE, 'ro');
});

test('export then import give back the original paths', () => {
  const root = seed();
  const before = readFileSync(join(root, 'mcp', 'notes.json'), 'utf8');
  rewriteAbsolutePaths(root, 'export', { write: true });
  rewriteAbsolutePaths(root, 'import', { write: true });
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, 'mcp', 'notes.json'), 'utf8')),
    JSON.parse(before),
  );
  const agent = JSON.parse(readFileSync(join(root, 'agents', 'projet.coder', 'config.json'), 'utf8'));
  assert.equal(agent.cwd, join(homedir(), 'webdev/projects/projet'));
});

test('replaying an export is a no-op', () => {
  const root = seed();
  rewriteAbsolutePaths(root, 'export', { write: true });
  const again = rewriteAbsolutePaths(root, 'export', { write: true });
  assert.equal(again.changes.length, 0);
});
