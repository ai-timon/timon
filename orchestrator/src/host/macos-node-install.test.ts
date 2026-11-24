import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installMacNodeUserLocal, nodeArchiveFromChecksums } from './macos-node-install.js';

const ARM = `${'a'.repeat(64)}  node-v22.23.2-darwin-arm64.tar.gz`;
const X64 = `${'b'.repeat(64)}  node-v22.23.2-darwin-x64.tar.gz`;

test('the macOS installer picks the archive matching the processor', () => {
  assert.deepEqual(nodeArchiveFromChecksums(`${ARM}\n${X64}\n`, 'arm64'), {
    sha256: 'a'.repeat(64), filename: 'node-v22.23.2-darwin-arm64.tar.gz',
  });
  assert.deepEqual(nodeArchiveFromChecksums(`${ARM}\n${X64}\n`, 'x64'), {
    sha256: 'b'.repeat(64), filename: 'node-v22.23.2-darwin-x64.tar.gz',
  });
  assert.throws(() => nodeArchiveFromChecksums(ARM, 'ia32'), /unsupported/);
});

test('the install links Node and npm into ~/.local/bin without a system manager', async () => {
  const home = await mkdtemp(join(tmpdir(), 'timon-node-home-'));
  const bytes = Buffer.from('verified archive fixture');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const filename = 'node-v22.23.2-darwin-arm64.tar.gz';
  let fetchCall = 0;
  const previousPath = process.env.PATH;
  try {
    const lines = await installMacNodeUserLocal({
      homeDir: home,
      arch: 'arm64',
      fetcher: async () => {
        fetchCall += 1;
        return {
          ok: true,
          status: 200,
          text: async () => `${checksum}  ${filename}\n`,
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        };
      },
      exec: async (_command, args) => {
        const stage = args[args.indexOf('-C') + 1]!;
        const bin = join(stage, filename.replace(/\.tar\.gz$/, ''), 'bin');
        await mkdir(bin, { recursive: true });
        await Promise.all(['node', 'npm', 'npx', 'corepack'].map((name) => writeFile(join(bin, name), name)));
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(fetchCall, 2);
    assert.match(lines[0] ?? '', /v22\.23\.2/);
    // The link target uses the host separator; only macOS runs this for real.
    assert.match(await readlink(join(home, '.local', 'bin', 'node')), /node-v22\.23\.2.*[\\/]bin[\\/]node$/);
    assert.match(await readlink(join(home, '.local', 'bin', 'npm')), /node-v22\.23\.2.*[\\/]bin[\\/]npm$/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(home, { recursive: true, force: true });
  }
});
