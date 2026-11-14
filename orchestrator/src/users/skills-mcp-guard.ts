/**
 * What a caller who is not the operator may do on `/api/skills` and `/api/mcp`.
 *
 * The routes gate on `skills:manage` / `mcp:manage`; `skills:manage` is in the
 * mission-token cap (an agent is told to `skill_put`), so these rules are what
 * keeps an agent — which a prompt injection can steer — inside its lane.
 * `mcp:manage` is in it too, bounded by `mcpWriteRefusal`.
 *
 * Same polarity as `privileged-overrides.ts`: what cannot be proven safe is
 * refused. The operator (superadmin, daemon-token, verified developer-owner
 * mission) is exempt through `isPrivilegedCaller`, except from one rule: an
 * agent's token, whoever launched it, never adds a tool (a skill's
 * `allowed-tools`) nor declares a stdio MCP server — a person does.
 */
import type { Request, Response } from 'express';
import { lstatSync, realpathSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { join, relative, resolve, sep } from 'node:path';
import { dbApi } from '../db.js';
import type { BrowserRecordingMetadata } from '../browser-recordings.js';
import { conversionMissionOf, isMissionToken } from './conversion-mission.js';
import { EXTERNAL_STUB_PREFIX, isInjectedMcpServer, isInjectedMcpStubId } from '../injected-mcp.js';
import { mcpHostAddressRefusal } from '../mcp-url-guard.js';
import type { McpServer } from '../mcp.js';
import { SKILLS_DIR } from '../paths.js';
import { FRONTMATTER_RE } from '../skill-registry.js';
import { isSystemSkillId, SKILL_FRONTMATTER_RE } from '../skills.js';
import { requestHasPermission } from './identity.js';
import {
  isAgentToken, isPrivilegedCaller, overrideAuthority, PRIVILEGED_CONFIG_PERMISSION, rejectOverride,
} from './privileged-overrides.js';

export { conversionMissionOf, isMissionToken, type ConversionMission } from './conversion-mission.js';

const SKILL_ID_RE = /^[a-z0-9._-]+$/;

/**
 * The id of the Timon skill `path` designates, only when it is lexically
 * `<skills folder>/<id>/SKILL.md`. Anything else (another folder, a free file
 * name, `<skills folder>/SKILL.md`, a `..` walking out) is null.
 *
 * Lexical on purpose: the write and the delete act on THIS path, not on a
 * resolved copy of it, so the identity checked here is the one acted upon.
 * A `..` segment is refused outright, links by `linkedSkillPath`.
 */
function ownSkillId(path: string): string | null {
  // `resolve` folds `a/x/../b` into `a/b`, the file system does not when `x` is
  // a link: the spelling must carry no `..` for the two readings to agree.
  if (path.split(/[\\/]/).includes('..')) return null;
  const parts = relative(resolve(SKILLS_DIR), resolve(path)).split(sep);
  if (parts.length !== 2 || parts[1] !== 'SKILL.md') return null;
  const id = parts[0]!;
  // A trailing dot is dropped by Windows file systems: `timon-task.` would
  // be the product skill's folder under another id.
  if (!SKILL_ID_RE.test(id) || id === '.' || id === '..' || id.endsWith('.')) return null;
  return id;
}

/** Same real location as `expected`? (Catches a Windows alias the lstat misses.) */
function isCanonical(path: string, expected: string): boolean {
  try {
    return realpathSync.native(path) === expected;
  } catch {
    return false;
  }
}

/**
 * True when `<skills folder>/<id>` or its `SKILL.md` is anything but a plain
 * folder / file: a symlink or junction (dangling ones included, which a
 * `realpath` cannot tell from "not created yet"), an alias, or something
 * `lstat` cannot read, or a file with another name elsewhere (hard link). Absent (`ENOENT`) is the only state accepted besides
 * plain: it is a skill that does not exist yet.
 *
 * Both consumers follow the link — `writeFileSync` creates or overwrites its
 * target, and the delete removes the folder the path was spelled with — so a
 * link planted by an agent under the skills folder reaches out of it.
 */
function linkedSkillPath(id: string): boolean {
  const dir = join(resolve(SKILLS_DIR), id);
  const file = join(dir, 'SKILL.md');
  let realDir: string | null = null;
  for (const entry of [dir, file]) {
    try {
      const st = lstatSync(entry);
      if (st.isSymbolicLink()) return true;
      // A hard link looks like a plain file and is the same inode as its
      // twin: writing the skill rewrites a file that lives outside the folder.
      if (entry === file && st.nlink > 1) return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return true;
    }
    if (entry === dir) {
      let realRoot: string;
      try {
        realRoot = realpathSync.native(resolve(SKILLS_DIR));
      } catch {
        return true;
      }
      realDir = join(realRoot, id);
      if (!isCanonical(dir, realDir)) return true;
    } else if (realDir && !isCanonical(file, join(realDir, 'SKILL.md'))) {
      return true;
    }
  }
  return false;
}

/** Does the frontmatter pre-authorise tools? Both spellings, in the very
 *  block each parser reads (`skills.ts` at spawn, `skill-registry.ts` for
 *  Claude Code skills): a guard with its own idea of where the block ends
 *  misses keys a parser still reads (`---\n\n---\nallowed-tools: …`). */
export function declaresAllowedTools(content: string): boolean {
  if (!/^\s*---/.test(content)) return false;
  const blocks = [SKILL_FRONTMATTER_RE, FRONTMATTER_RE]
    .map((re) => re.exec(content)?.[1])
    .filter((block): block is string => block !== undefined);
  // Neither parser finds a block: read it all, fail closed.
  if (!blocks.length) blocks.push(content);
  return blocks.some((block) => /^\s*allowed[-_]tools\s*:/im.test(block));
}

/** A skill id taken from a URL segment, for the one place it is joined to the skills folder. */
export function isPlainSkillSegment(id: string): boolean {
  return id !== '' && id !== '.' && id !== '..' && !/[\\/\0]/.test(id);
}

/**
 * Refusal reason for writing (`content` given) or deleting (`content` absent)
 * the skill file at `path`, or null.
 *
 * Not the operator, so:
 *  - the file must be a Timon skill, `<skills folder>/<id>/SKILL.md`, spelled
 *    so and reached without a link. Free paths (`~/.claude/skills` is shared by
 *    every Claude Code session of the account, a project's `.claude/commands`
 *    is its repository) and linked folders stay an operator gesture;
 *  - product skills are read-only: `timon-task` & co are injected, with their
 *    `allowed_tools`, into every task of every user;
 *  - a skill cannot hand out tools its writer could not give an agent directly:
 *    `agentConfigRefusal` bounds `allowed_tools`, and the spawn merges a
 *    skill's frontmatter into them — without this rule `skill_put` +
 *    `agent_update skills` is a way round it.
 */
export function skillWriteRefusal(
  req: Request,
  target: { path: string; content?: string; byPath?: boolean },
): string | null {
  // A skill's `allowed-tools` lands in the `--allowedTools` of every agent it
  // is attached to: adding a tool to an agent needs a person (decision of
  // 08/11/2026), so an agent's token never writes one, whatever it holds.
  if (isAgentToken(req) && target.content !== undefined && declaresAllowedTools(target.content)) {
    return 'allowed-tools (or allowed_tools) in a skill pre-authorises tools for the agents it is attached to: '
      + 'an agent\'s token cannot write one, whatever its account holds. Leave the key out, '
      + 'or ask a person to add it from the Skills page of the app';
  }
  // Before the operator's exemption: a conversion mission stays bounded whoever launched it.
  const conversion = conversionMissionOf(req);
  if (conversion) {
    return conversionSkillRefusal(conversion.recording, target) ?? nonOperatorSkillRefusal(target, overrideAuthority(req).relaxed);
  }
  if (isPrivilegedCaller(req)) return null;
  return nonOperatorSkillRefusal(target, overrideAuthority(req).relaxed);
}

/** What a conversion mission may name its skill: what `learn-browser-recording` tells it to. */
export const LEARNED_SKILL_PREFIX = 'browser-';

/** The conversion rules on top of the non-operator ones; null when they let the write through. */
export function conversionSkillRefusal(
  recording: BrowserRecordingMetadata | null,
  target: { path: string; content?: string; byPath?: boolean },
): string | null {
  if (target.content === undefined) {
    return 'the conversion mission of a browser recording creates its skill and removes none';
  }
  if (!recording) {
    return 'the browser recording this mission converts was deleted: it writes no skill';
  }
  const id = target.byPath ? null : ownSkillId(target.path);
  if (!id || !id.startsWith(LEARNED_SKILL_PREFIX) || id.length === LEARNED_SKILL_PREFIX.length) {
    return `the conversion mission of a browser recording writes only a new skill by id, named ${LEARNED_SKILL_PREFIX}<slug>`;
  }
  if (recording.learnedSkillId) {
    return `this conversion already created ${recording.learnedSkillId}: a browser recording becomes one skill`;
  }
  return null;
}

/**
 * The rules of `skillWriteRefusal` for a caller who is not the operator,
 * without a request: `relaxed` is whether that caller may pre-authorise tools
 * (`agents:privileged-config`). A plugin's facade (`ctx.skills`) is never relaxed.
 */
export function nonOperatorSkillRefusal(
  target: { path: string; content?: string },
  relaxed: boolean,
): string | null {
  const id = ownSkillId(target.path);
  if (!id) {
    return 'skills are written by id under the Timon skills folder; another location is for the operator';
  }
  if (linkedSkillPath(id)) {
    return `${id} is a link or cannot be verified as a plain skill folder: only the operator writes or removes it`;
  }
  if (isSystemSkillId(id)) {
    return `${id} is a product skill: only the operator changes or removes it, from the Skills page`;
  }
  if (target.content !== undefined && declaresAllowedTools(target.content) && !relaxed) {
    return 'allowed-tools (or allowed_tools) in a skill pre-authorises tools: that needs agents:privileged-config';
  }
  return null;
}

/**
 * An MCP server declaration is a command the host account runs (stdio), or a
 * remote endpoint every attached agent talks to, outside the permission
 * classifier. Overwriting an id agents already use takes effect at their next
 * spawn with no `agent_update`.
 *
 * `mcp:manage` is in the mission cap since 12/10/2026, bounded here (the cap
 * stays ∩ the launcher's grants — an employee without it is refused):
 *  - a server that does not speak plain `http` (stdio: a command on the host) is
 *    a person's to declare or change since the maintainer's decision of 08/11/2026,
 *    whatever the mission holds (`hostCommandRefusal`); removing one stays
 *    `agents:privileged-config` territory;
 *  - an `http` one is accepted when its URL is `http(s)` and its host RESOLVES
 *    to public addresses only, none of them this host's own: not the loopback
 *    (the daemon's own API), the LAN, a Tailscale network nor a link-local one
 *    (cloud metadata). The name a url spells proves nothing — a public name can
 *    point at 127.0.0.1 — and a record can change after the write, so the
 *    launch judges it again (`mcp-url-guard.ts`, TODO #530). A holder of
 *    `agents:privileged-config` is exempt from the host test only: it can
 *    already declare a command that reaches the loopback;
 *  - what Timon injects (`timon`, `timon-browser`…, by id OR by `name`, which is
 *    the key a dialect writes) and what claude.ai discovered (`ext-*`) is never
 *    written or removed from a mission;
 *  - rewriting or removing a server that is not a plain `http` one, or that no
 *    mission of this agent created, needs the same `privileged-config`: it
 *    changes what agents already attached run or talk to. `created_by` is the
 *    stamp the create leaves.
 * Every refusal is a 403 with a `reason` telling what to do. Same polarity as
 * `privileged-overrides.ts`: what cannot be proven safe is refused. Humans are
 * untouched; the verified developer-owner mission (superadmin) is held only to
 * the stdio rule.
 */
export type McpWriteTarget = {
  id: string;
  /** What the request would store; absent for a delete. */
  name?: unknown;
  transport?: unknown;
  /** The stored server of that id, if any. */
  existing: McpServer | null;
};

/** Addresses that mean "this host" or a metadata endpoint; mapped IPv6 forms match the IPv4 rules. */
const LOCAL_ADDRESSES = new BlockList();
LOCAL_ADDRESSES.addSubnet('0.0.0.0', 8, 'ipv4');
LOCAL_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4');
LOCAL_ADDRESSES.addAddress('::', 'ipv6');
LOCAL_ADDRESSES.addAddress('::1', 'ipv6');
LOCAL_ADDRESSES.addSubnet('fe80::', 10, 'ipv6');

/** `WHATWG URL` has already folded `2130706433`, `0x7f.1` and `[::ffff:127.0.0.1]` into their canonical forms. */
function isLocalHostname(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const family = isIP(host);
  if (family === 0) return false;
  return LOCAL_ADDRESSES.check(host, family === 6 ? 'ipv6' : 'ipv4');
}

/** A reason when `url` is not an `http(s)` URL a non-privileged mission may point a server at. */
export async function httpUrlRefusal(url: unknown, relaxed: boolean): Promise<string | null> {
  if (typeof url !== 'string' || !url) return 'an http MCP server needs a url';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'the url of an MCP server must be a valid http(s) URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `the url of an MCP server must be http or https, not ${parsed.protocol}`;
  }
  if (!relaxed && isLocalHostname(parsed.hostname)) {
    return 'the url of an MCP server cannot name this host or a link-local address '
      + `(${parsed.hostname}): it would reach the daemon's own API or a metadata endpoint; `
      + `that needs ${PRIVILEGED_CONFIG_PERMISSION}`;
  }
  if (!relaxed) {
    const address = await mcpHostAddressRefusal(parsed.hostname);
    if (address) {
      return `the url of an MCP server must reach a public address off this host (${address}): `
        + 'it would reach the daemon\'s own API, a service of the local network or a metadata endpoint; '
        + `that needs ${PRIVILEGED_CONFIG_PERMISSION}`;
    }
  }
  return null;
}

/**
 * Whether the write of this request is held to public addresses: a mission
 * token neither verified as the operator nor holding `agents:privileged-config`.
 * Such a server is stamped `public_only`, and its host is judged again at launch.
 */
export function missionBoundToPublicUrls(req: Request): boolean {
  const auth = req.auth;
  return !!auth && !auth.isSuperadmin && isMissionToken(req) && !overrideAuthority(req).relaxed;
}

/**
 * Declaring or changing a server that runs a command on the host needs a
 * person (the maintainer's decision of 08/11/2026), whatever an agent's token holds:
 * `agents:privileged-config` and the developer-owner mission included. A
 * mission steered by injected text would otherwise run the command of its
 * choice at the next spawn of every agent the server is attached to. An http
 * server stays under the rules below; removing a server grants nothing.
 */
function hostCommandRefusal(req: Request, target: McpWriteTarget): string | null {
  if (!isAgentToken(req) || target.transport === undefined) return null;
  const transport = target.transport as { type?: unknown } | null;
  if (transport && typeof transport === 'object' && transport.type === 'http') return null;
  const kind = transport && typeof transport === 'object' ? String(transport.type) : 'non-http';
  return `a ${kind} MCP server runs a command on the host, outside the permission classifier: `
    + 'an agent\'s token cannot declare or change one, whatever its account holds. '
    + 'A person declares it from the MCP servers page of the app. An http server (a url) is accepted from a mission';
}

/**
 * Refusal reason for a write (`transport` given) or a delete (absent) of the
 * MCP server `target` by a mission token, or null (also for any other caller).
 */
export async function mcpWriteRefusal(req: Request, target: McpWriteTarget): Promise<string | null> {
  const auth = req.auth;
  const stdio = hostCommandRefusal(req, target);
  if (stdio) return stdio;
  if (!auth || auth.isSuperadmin || !isMissionToken(req)) return null;
  const verb = target.transport === undefined ? 'remove' : 'declare or change';
  if (!requestHasPermission(req, 'mcp:manage')) {
    return `the account that launched this mission does not hold mcp:manage: it cannot ${verb} MCP servers. `
      + 'Ask them to do it from the MCP servers page of the app, then attach the server with agent_update mcp_servers';
  }
  const mission = dbApi.getMission(auth.missionId!);
  return mcpDeclarationRefusal(target, {
    relaxed: overrideAuthority(req).relaxed,
    ownsExisting: (existing) => !!mission && !!existing.created_by && existing.created_by.agent === mission.agent_name,
  });
}

/**
 * The rules of `mcpWriteRefusal` once the caller's right to manage MCP servers
 * is established, without a request. `relaxed`: the caller may declare a
 * command on the host. `ownsExisting`: the caller declared that server itself.
 * `who` / `owner` / `need` word the refusals for a caller that is not a mission
 * (a plugin's facade).
 */
export async function mcpDeclarationRefusal(
  target: McpWriteTarget,
  caller: {
    relaxed: boolean;
    ownsExisting: (existing: McpServer) => boolean;
    /** May a `http` server name this host or a link-local address? Default: `relaxed`. */
    allowLocalHttp?: boolean;
    who?: string;
    owner?: string;
    need?: string;
  },
): Promise<string | null> {
  const { id, existing } = target;
  const { relaxed, who = 'a mission', owner = 'this agent' } = caller;
  const verb = target.transport === undefined ? 'remove' : 'declare or change';
  const name = typeof target.name === 'string' ? target.name : '';
  const reservedBy = [id, name].find((key) => key && (isInjectedMcpServer(key) || isInjectedMcpStubId(key)));
  if (reservedBy) {
    return `${reservedBy} is an MCP server Timon injects itself: ${who} cannot ${verb} it, nor shadow it under another id`;
  }
  if (id.startsWith(EXTERNAL_STUB_PREFIX) || existing?.transport.type === 'external' || existing?.source === 'claude_ai' || existing?.source === 'claude_cli') {
    return `${id} is an account connector discovered by the harness: ${who} cannot ${verb} it. `
      + 'Manage connectors from the MCP servers page of the app';
  }

  const need = caller.need ?? `that needs ${PRIVILEGED_CONFIG_PERMISSION}, or do it from the MCP servers page of the app`;
  if (target.transport !== undefined) {
    const transport = target.transport as { type?: unknown; url?: unknown } | null;
    if (!transport || typeof transport !== 'object') return 'transport must be an object';
    if (transport.type !== 'http') {
      if (!relaxed) {
        return `a ${String(transport.type)} MCP server runs a command on the host, outside the permission classifier: ${need}. `
          + `An http server (a url) is accepted from ${who}`;
      }
    } else {
      const refusal = await httpUrlRefusal(transport.url, caller.allowLocalHttp ?? relaxed);
      if (refusal) return refusal;
    }
  }
  if (existing && !relaxed) {
    if (existing.transport.type !== 'http') {
      return `${id} runs a command on the host: ${who} cannot ${verb} it; ${need}`;
    }
    if (!caller.ownsExisting(existing)) {
      return `${id} was not declared by ${owner}: changing or removing it alters what agents already attached talk to; ${need}`;
    }
  }
  return null;
}

/** The host of `url` for an audit line: never the path, query or credentials, which may carry a secret. */
export function mcpHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid url';
  }
}

/** Who a successful mission write is logged against: the mission AND its agent. */
export function missionActorLabel(req: Request): string {
  const missionId = req.auth?.missionId;
  if (!missionId) return 'unknown mission';
  const mission = dbApi.getMission(missionId);
  return `mission ${missionId} agent ${mission?.agent_name ?? 'unknown'}`;
}

/** The stamp a mission leaves on a server it declares, or null outside a mission. */
export function missionCreatedBy(req: Request): { mission_id: string; agent: string } | null {
  const missionId = req.auth?.missionId;
  if (!missionId || !isMissionToken(req)) return null;
  const mission = dbApi.getMission(missionId);
  return mission ? { mission_id: missionId, agent: mission.agent_name } : null;
}

/**
 * OAuth is a browser round trip with the human: a mission never starts it,
 * whatever it holds. Returns true when the response has been sent.
 */
export function rejectMissionMcpOAuth(req: Request, res: Response, target: string): boolean {
  if (!req.auth || req.auth.isSuperadmin || !isMissionToken(req)) return false;
  return rejectOverride(
    req, res, 'mcp.write_denied', target,
    'a mission cannot start an OAuth authorisation: it is a sign-in the account owner completes in the browser '
    + 'from the MCP servers page of the app',
  );
}
