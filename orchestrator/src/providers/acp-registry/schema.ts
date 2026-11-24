/**
 * The official ACP registry (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`)
 * as Timon reads it. The document is NETWORK INPUT: it is parsed, never trusted.
 *
 * Only the `binary` distribution is supported — a program the daemon downloads,
 * verifies and launches itself. `npx` and `uvx` entries run a package runner
 * (`EXEC_DENIED_LAUNCHERS` in `plugins/policy.ts`: a launcher runs whatever it
 * is handed), so they are listed with that reason instead of being hidden.
 *
 * One invalid agent does not poison the list: entries are validated one by one
 * and the bad ones are counted, not shown.
 */
import { z } from 'zod';

export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

/** An agent id becomes a folder and a profile id: a slug, nothing else. */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const TargetSchema = z.object({
  archive: z.string().url().max(2048),
  cmd: z.string().min(1).max(512),
  args: z.array(z.string().max(512)).max(32).default([]),
  /** Published by the registry for roughly half of the targets. */
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  // `env` is deliberately not read: a registry entry must never decide what the
  // agent's process inherits (`LD_PRELOAD`, `NODE_OPTIONS`…).
});
export type RegistryTarget = z.infer<typeof TargetSchema>;

/** The one host whose icons the daemon downloads: the registry's own CDN. */
export const ICON_HOST = 'cdn.agentclientprotocol.com';

/**
 * The agent's logo address, kept only when it is https on the registry's own CDN:
 * the daemon fetches it once at install, and an address elsewhere would make it
 * call any host a registry entry names. Anything else is dropped, never fatal to
 * the entry: a missing logo only means the initial badge.
 */
export function trustedIconUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.hostname !== ICON_HOST || url.port !== '' || url.username !== '' || url.password !== '') return undefined;
  return url.href;
}

const AgentSchema = z.object({
  id: z.string().regex(AGENT_ID_RE),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(64).regex(/^[A-Za-z0-9._+-]+$/, 'version is a folder name'),
  description: z.string().max(1000).optional(),
  website: z.string().url().max(2048).optional(),
  license: z.string().max(120).optional(),
  icon: z.unknown().optional().transform(trustedIconUrl),
  distribution: z.object({
    binary: z.record(z.string(), TargetSchema).optional(),
    npx: z.unknown().optional(),
    uvx: z.unknown().optional(),
  }),
});
export type RegistryAgent = z.infer<typeof AgentSchema>;

const RegistrySchema = z.object({ version: z.string().max(64), agents: z.array(z.unknown()).max(2000) });

export type ParsedRegistry = { version: string; agents: RegistryAgent[]; dropped: number };

export function parseRegistry(raw: unknown): ParsedRegistry {
  const top = RegistrySchema.parse(raw);
  const agents: RegistryAgent[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const candidate of top.agents) {
    const parsed = AgentSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.id)) { dropped += 1; continue; }
    seen.add(parsed.data.id);
    agents.push(parsed.data);
  }
  return { version: top.version, agents, dropped };
}

/**
 * Registry keys for this machine, best first. Windows on ARM runs the x86_64
 * build through the OS emulation when no native one is published.
 */
export function platformTargets(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string[] {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'windows' : null;
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : null;
  if (!os || !cpu) return [];
  return os === 'windows' && cpu === 'aarch64' ? ['windows-aarch64', 'windows-x86_64'] : [`${os}-${cpu}`];
}

export type AgentSupport =
  | { supported: true; target: string; entry: RegistryTarget; integrity: 'sha256' | 'none' }
  | { supported: false; reason: string };

/** Archive kinds `archive.ts` can open. A raw program (no archive extension) is accepted as it is. */
export type ArchiveKind = 'tar.gz' | 'zip' | 'raw';

const UNSUPPORTED_ARCHIVE_RE = /\.(tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst|7z|rar|dmg|pkg|msi|deb|rpm|appimage)$/i;

export function archiveKind(url: string): ArchiveKind | null {
  let path: string;
  try { path = new URL(url).pathname; } catch { return null; }
  if (/\.(tar\.gz|tgz)$/i.test(path)) return 'tar.gz';
  if (/\.zip$/i.test(path)) return 'zip';
  if (UNSUPPORTED_ARCHIVE_RE.test(path)) return null;
  return 'raw';
}

/** What this machine can do with an agent, with a reason when it cannot. */
export function supportOf(agent: RegistryAgent, platform: NodeJS.Platform = process.platform, arch: string = process.arch): AgentSupport {
  const binary = agent.distribution.binary;
  if (!binary || Object.keys(binary).length === 0) {
    const via = agent.distribution.npx !== undefined ? 'npx' : agent.distribution.uvx !== undefined ? 'uvx' : 'another way';
    return { supported: false, reason: `distributed through ${via}, which runs a package runner — only downloadable programs are supported` };
  }
  const targets = platformTargets(platform, arch);
  const target = targets.find((key) => binary[key] !== undefined);
  if (!target) return { supported: false, reason: `no build for this machine (${platform}/${arch})` };
  const entry = binary[target]!;
  if (archiveKind(entry.archive) === null) return { supported: false, reason: 'its archive format (bzip2, xz, installer…) cannot be opened here' };
  try {
    if (new URL(entry.archive).protocol !== 'https:') return { supported: false, reason: 'its download is not served over https' };
  } catch { return { supported: false, reason: 'its download address is invalid' }; }
  return { supported: true, target, entry, integrity: entry.sha256 ? 'sha256' : 'none' };
}
