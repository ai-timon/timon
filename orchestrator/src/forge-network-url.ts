/**
 * The URL a conflict resolution fetches from and pushes to, REBUILT by the
 * daemon from checked parts: never a URL someone wrote (`docs/SECURITY.md`
 * §9.9, "a URL rebuilt, never passed on").
 *
 * git, curl, ssh and every URL parser do not cut a remote URL the same way:
 * a `\`, a `%`, a second `@`, a bracket in the user each made git reach
 * another host than the one Timon checked. Refusing those forms one by one
 * leaves the next one open. Here the project's `remote_url` only CHOOSES the
 * scheme, the ssh user, the host (or SSH alias) and the port; each part is
 * checked against a strict allow-list, the repository comes from GitHub's
 * answer, and the URL handed to git is written from those parts alone, in one
 * form git reads exactly as it is written:
 *
 *   https://<host>[:<port>]/<owner>/<name>.git
 *   ssh://<user>@<host or alias>[:<port>]/<owner>/<name>.git
 */
import { checkRemoteUrl, scpAuthority, SSH_USER, urlAuthority } from './git-remote-url.js';

/** A DNS name, lowercased: what a forge host is. No IPv6 literal, no trailing dot. */
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** A `Host` of the user's SSH configuration (`github-timon`). Never starts with `-`. */
export const SSH_ALIAS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** One half of `owner/name` as GitHub spells it. */
const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const PORT = /^[1-9][0-9]{0,4}$/;
const DEFAULT_PORT = { https: '443', ssh: '22' } as const;

export type ForgeEndpoint =
  | { scheme: 'https'; host: string; port: string | null }
  | { scheme: 'ssh'; user: string; host: string; port: string | null };

function validPort(port: string | null): boolean {
  return port === null || (PORT.test(port) && Number(port) <= 65535);
}

/** Whether `host` may stand in a rebuilt URL of `scheme`: a DNS name, or an SSH alias over ssh. */
function validHost(scheme: ForgeEndpoint['scheme'], host: string): boolean {
  return DNS_NAME.test(host) || (scheme === 'ssh' && SSH_ALIAS_NAME.test(host));
}

/**
 * The parts of an ssh or https remote a rebuilt URL may take, or null when
 * one of them is not plain: a user outside `SSH_USER`, an IPv6 or odd host, a
 * port out of range. An ssh remote without a user gets `git`, GitHub's.
 */
export function forgeEndpointOf(remoteUrl: string): ForgeEndpoint | null {
  const check = checkRemoteUrl(remoteUrl);
  if (!check.ok || (check.kind !== 'ssh' && check.kind !== 'https')) return null;
  let user: string | null;
  let host: string;
  let port: string | null = null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(check.url)) {
    const authority = urlAuthority(check.url);
    if (!authority) return null;
    ({ user, host, port } = authority);
  } else {
    const scp = scpAuthority(check.url);
    if (!scp) return null;
    ({ user, host } = scp);
  }
  host = host.toLowerCase();
  if (port !== null && port === DEFAULT_PORT[check.kind]) port = null;
  if (!validPort(port) || !validHost(check.kind, host)) return null;
  if (check.kind === 'https') return user === null ? { scheme: 'https', host, port } : null;
  const sshUser = user ?? 'git';
  return SSH_USER.test(sshUser) ? { scheme: 'ssh', user: sshUser, host, port } : null;
}

/** `owner/name.git` for a repository GitHub named, or null when either half is not plain. */
export function forgeRepositoryPath(repo: string): string | null {
  const parts = repo.split('/');
  if (parts.length !== 2) return null;
  for (const part of parts) {
    if (!REPO_PART.test(part) || part === '.' || part === '..') return null;
  }
  const name = parts[1]!.replace(/\.git$/i, '');
  if (!name || name === '.' || name === '..') return null;
  return `${parts[0]}/${name}.git`;
}

/**
 * The URL git is given for `repo` at `endpoint`, written here from its checked
 * parts, or null when one does not pass. The same parts give the same URL: a
 * publication compares it with the one its dialog showed.
 */
export function forgeNetworkUrl(endpoint: ForgeEndpoint, repo: string): string | null {
  const path = forgeRepositoryPath(repo);
  if (!path || !validPort(endpoint.port) || !validHost(endpoint.scheme, endpoint.host)) return null;
  const port = endpoint.port !== null && endpoint.port !== DEFAULT_PORT[endpoint.scheme] ? `:${endpoint.port}` : '';
  if (endpoint.scheme === 'https') return `https://${endpoint.host}${port}/${path}`;
  if (!SSH_USER.test(endpoint.user)) return null;
  return `ssh://${endpoint.user}@${endpoint.host}${port}/${path}`;
}
