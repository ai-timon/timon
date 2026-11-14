/**
 * What the ACP-registry provider keeps on disk, under
 * `~/.timon/providers/acp-registry/`:
 *
 *   state.json                       which agents are installed, at which version, with which hashes
 *   agents/<id>/<version>/…          the extracted program, one folder per version
 *   tmp/                             downloads in flight, always removed
 *
 * `treeSha256` is the second half of "sha256 before any launch": the archive is
 * checked against the registry when it is downloaded, and the EXTRACTED tree is
 * hashed once and re-hashed every time the profile is registered (daemon start,
 * update). A file changed on disk afterwards — a launcher swapped, a library
 * replaced — refuses the registration instead of running it.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { COMMAND_WORD_RE } from '../../backends/acp/auth.js';

/** What the agent's `initialize` announced (`readAuthMethods`), re-read before it is kept. */
const AuthMethodSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  kind: z.enum(['agent', 'terminal', 'env_var']),
  billedPerToken: z.boolean(),
  // The same check as when it was read: a state file edited by hand cannot slip a second command into the advice.
  terminal: z.object({ program: z.string().regex(COMMAND_WORD_RE).nullable(), args: z.array(z.string().regex(COMMAND_WORD_RE)).max(16).readonly() }).nullable(),
});

export const InstalledAgentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().max(120),
  version: z.string().regex(/^[A-Za-z0-9._+-]+$/).max(64),
  target: z.string().max(32),
  /** `unverified` = the registry published no hash and the person accepted that. */
  integrity: z.enum(['sha256', 'unverified']),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  treeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Forward-slash path of the program inside the version folder. */
  cmd: z.string().min(1).max(512),
  args: z.array(z.string().max(512)).max(32),
  installedAt: z.number(),
  previousVersion: z.string().regex(/^[A-Za-z0-9._+-]+$/).max(64).optional(),
  /** How the agent signs in, read from its `initialize`; absent until it was read once. */
  authMethods: z.array(AuthMethodSchema).max(16).optional(),
});
export type InstalledAgent = z.infer<typeof InstalledAgentSchema>;

const StateSchema = z.object({ agents: z.record(z.string(), z.unknown()).default({}) });

export type AcpRegistryPaths = {
  root: string;
  state: string;
  agents: string;
  tmp: string;
  versionDir(id: string, version: string): string;
};

export function acpRegistryPaths(home: string): AcpRegistryPaths {
  const root = join(home, 'providers', 'acp-registry');
  return {
    root,
    state: join(root, 'state.json'),
    agents: join(root, 'agents'),
    tmp: join(root, 'tmp'),
    versionDir: (id, version) => join(root, 'agents', id, version),
  };
}

export function readState(paths: AcpRegistryPaths): Record<string, InstalledAgent> {
  if (!existsSync(paths.state)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(paths.state, 'utf8')); } catch { return {}; }
  const parsed = StateSchema.safeParse(raw);
  if (!parsed.success) return {};
  const out: Record<string, InstalledAgent> = {};
  for (const [id, value] of Object.entries(parsed.data.agents)) {
    const entry = InstalledAgentSchema.safeParse(value);
    if (entry.success && entry.data.id === id) out[id] = entry.data;
  }
  return out;
}

export function writeState(paths: AcpRegistryPaths, agents: Record<string, InstalledAgent>): void {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const tmp = `${paths.state}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ agents }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, paths.state);
}

function* walk(dir: string, base: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) yield* walk(full, base);
    else if (info.isFile()) yield relative(base, full).split(sep).join('/');
  }
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** Digest of a folder: every file's path, size, executable bit and content hash. */
export async function hashTree(dir: string): Promise<string> {
  const outer = createHash('sha256');
  for (const rel of walk(dir, dir)) {
    const full = join(dir, ...rel.split('/'));
    const info = statSync(full);
    const exec = process.platform !== 'win32' && info.mode & 0o111 ? 'x' : '-';
    outer.update(`${rel}\0${info.size}\0${exec}\0${await hashFile(full)}\n`);
  }
  return outer.digest('hex');
}
