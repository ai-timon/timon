/**
 * The daemon's side of the egress proxy (TODO #590): who may use it, where it
 * listens, what it does with a record, and what a mission's environment gets
 * to reach it. The proxy itself is `proxy.ts`.
 *
 * Records go to the journal (`journal.ts`, read by `GET /api/missions/:id/egress`),
 * and a host a project never reached raises a deduplicated alert (`alerts.ts`).
 * The daemon log only gets a record when the journal could not take it.
 */
import { daemonMessage } from '../daemon-message.js';
import type { AddressInfo } from 'node:net';
import { apiBaseUrl } from '../api-url.js';
import { config } from '../config/load.js';
import type { TimonConfig } from '../config/schema.js';
import { dbApi } from '../db.js';
import { loadConfig as loadAgentConfig } from '../agent-config.js';
import { taskProjectSlug } from '../task-project.js';
import { createNotification } from '../notifications.js';
import { issueMissionEgressToken, missionOfEgressToken } from '../users/api-tokens.js';
import { createEgressProxy, type EgressProxy, type EgressRecord, type EgressRefusal, type EgressTarget } from './proxy.js';
import { learnEgressHost, normalizeEgressHost, recordEgress } from './journal.js';
import { createNewHostAlerts, type NewHostAlert, type NewHostAlerts } from './alerts.js';

/**
 * The egress credential of THIS mission (`issueMissionEgressToken`), and
 * nothing else: the daemon-token, a user's API token and a mission's API token
 * open routes, not the proxy, and a mission's credential never speaks for
 * another one. A mission that stopped running no longer passes.
 */
export function authenticateMissionToken(missionId: string, token: string): boolean {
  if (!missionId || !token) return false;
  return missionOfEgressToken(token) === missionId;
}

export function formatEgressRecord(record: EgressRecord): string {
  const target = record.host.includes(':') ? `[${record.host}]:${record.port}` : `${record.host}:${record.port}`;
  return `[egress] mission=${record.missionId} ${record.method} ${target} status=${record.status}`
    + ` out=${record.bytesOut} in=${record.bytesIn} ${record.durationMs}ms${record.error ? ` error=${record.error}` : ''}`;
}

/** Journals a record; the daemon log is the fallback, so a failing write still leaves a trace. */
export function journalRecord(record: EgressRecord): void {
  try {
    recordEgress(record);
  } catch (err) {
    console.warn(`[egress] journal write failed (${(err as Error).message}): ${formatEgressRecord(record)}`);
  }
}

const PROJECT_KEYS_MAX = 1_000;
const projectKeys = new Map<string, string>();

/**
 * What "this project" means for the new-host alert: the task's project, else
 * the agent's (`config.project`, else its cwd) — the resolution the
 * dispatcher uses. An agent outside any project is its own scope, so its
 * missions learn their hosts together without mixing them with a project's.
 * Cached per mission: the proxy asks on every connection.
 */
export function missionProjectKey(missionId: string): string | null {
  const cached = projectKeys.get(missionId);
  if (cached) return cached;
  const mission = dbApi.getMission(missionId);
  if (!mission) return null;
  const task = mission.task_id ? dbApi.getTask(mission.task_id) : undefined;
  let slug: string | null = null;
  try {
    slug = taskProjectSlug(task ?? {}, loadAgentConfig(mission.agent_name));
  } catch { /* an unreadable agent config: the agent scope below stands */ }
  const key = slug ? `project:${slug}` : `agent:${mission.agent_name}`;
  if (projectKeys.size >= PROJECT_KEYS_MAX) projectKeys.delete(projectKeys.keys().next().value as string);
  projectKeys.set(missionId, key);
  return key;
}

function scopeLabel(projectKey: string): string {
  return projectKey.startsWith('project:') ? `project ${projectKey.slice('project:'.length)}` : `agent ${projectKey.slice('agent:'.length)}`;
}

/** The notification of a new-host alert, for the mission's owner. Hosts only: never a path, never a credential. */
export function sendNewHostNotification(alert: NewHostAlert): void {
  const mission = dbApi.getMission(alert.missionId);
  if (!mission) return;
  const named = alert.hosts.join(', ') + (alert.more > 0 ? ` and ${alert.more} more` : '');
  const count = alert.hosts.length + alert.more;
  createNotification({
    type: 'alert',
    title: count === 1 ? `New outbound host for ${scopeLabel(alert.projectKey)}` : `${count} new outbound hosts for ${scopeLabel(alert.projectKey)}`,
    body: `Mission of ${mission.agent_name} reached ${named} for the first time in this ${alert.projectKey.startsWith('project:') ? 'project' : 'scope'}. `
      + `Nothing was blocked; the mission's connections are listed by \`timon mission egress ${mission.id}\`.`,
    missionId: mission.id,
    ownerUserId: mission.owner_user_id,
    anchor: `egress:${mission.id}`,
    message: daemonMessage('egress_new_hosts', {
      count,
      scopeKind: alert.projectKey.startsWith('project:') ? 'project' : 'agent',
      scopeName: alert.projectKey.slice(alert.projectKey.indexOf(':') + 1),
      agent: mission.agent_name,
      hosts: alert.hosts.join(', '),
      more: alert.more,
      missionId: mission.id,
    }),
  });
}

/** Learns the host for the mission's project; a host it never reached goes to the alerts. */
export function noteEgressOpen(target: EgressTarget, alerts: Pick<NewHostAlerts, 'noteNewHost'>): void {
  const projectKey = missionProjectKey(target.missionId);
  if (!projectKey) return;
  const host = normalizeEgressHost(target.host);
  if (learnEgressHost(projectKey, host, target.missionId)) alerts.noteNewHost(target.missionId, projectKey, host);
}

function logRefusal(refusal: EgressRefusal): void {
  console.warn(`[egress] refused ${refusal.method} from ${refusal.remoteAddress ?? 'unknown'}: ${refusal.reason} credentials`);
}

let running: { proxy: EgressProxy; address: AddressInfo | null } | null = null;

/** Where missions reach the proxy, or `null` when it is off or not listening yet. */
export function egressProxyAddress(): AddressInfo | null {
  return running?.address ?? null;
}

/**
 * Starts the proxy per `host.isolation.egress`; the returned function stops it.
 * A failure to bind is logged, not thrown: missions run as before without it.
 */
export function startEgressProxy(settings: TimonConfig['host']['isolation']['egress'] = config().host.isolation.egress): () => void {
  if (settings.mode === 'off') {
    console.log('[egress] proxy off (host.isolation.egress.mode): missions get no proxy variables');
    return () => {};
  }
  const alerts = createNewHostAlerts({ send: sendNewHostNotification });
  const proxy = createEgressProxy({
    authenticate: authenticateMissionToken,
    onOpen: (target) => noteEgressOpen(target, alerts),
    onRecord: journalRecord,
    onRefusal: logRefusal,
  });
  const mine = { proxy, address: null as AddressInfo | null };
  running = mine;
  proxy.listen(settings.host, settings.port).then(
    (address) => {
      mine.address = address;
      console.log(`[egress] proxy listening on ${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port} (mode=${settings.mode})`);
    },
    (err: NodeJS.ErrnoException) => {
      console.warn(`[egress] proxy not started on ${settings.host}:${settings.port}: ${err.code ?? err.message}`);
      if (running === mine) running = null;
    },
  );
  return () => {
    if (running === mine) running = null;
    alerts.stop();
    void proxy.close();
  };
}

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;
const NO_PROXY_VARS = ['NO_PROXY', 'no_proxy'] as const;
/** The daemon's loopback, in every spelling a tool may match `NO_PROXY` against. */
const LOOPBACK_NO_PROXY = ['127.0.0.1', '::1', '[::1]', 'localhost'];

/** `env[name]` whatever its case: on Windows `Https_Proxy` is `HTTPS_PROXY`. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && value) return value;
  }
  return undefined;
}

let lastSkip: string | null = null;

/** Once per reason in a row: a reason is about the daemon, not about one mission. */
function noteSkip(reason: string): void {
  if (lastSkip === reason) return;
  lastSkip = reason;
  console.warn(`[egress] missions launched without the proxy: ${reason}`);
}

/**
 * The proxy variables of one launch: `HTTP(S)_PROXY` (both cases — curl reads
 * only the lower one, most others the upper) pointing at the daemon's proxy
 * under this mission's own egress credential, and `NO_PROXY` keeping the
 * daemon's loopback (`TIMON_API`, the MCP servers, a local browser) off it.
 *
 * Empty — the launch runs as before — when the mode is `off`, when the proxy
 * does not listen, and when `inherited` already names a proxy: this one does
 * not chain to an upstream proxy, so taking a corporate proxy's place would
 * cut the mission off instead of journaling it.
 *
 * The returned values carry a secret: they go to the process environment and
 * nowhere else — never a log line, an error, an event or a response.
 */
export function missionEgressEnv(missionId: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (config().host.isolation.egress.mode === 'off') return {};
  const address = egressProxyAddress();
  if (!address) {
    // Never started (tests, a component without the missions module) or bind failed: `startEgressProxy` said why.
    if (running) noteSkip('the proxy is not listening yet');
    return {};
  }
  if (PROXY_VARS.some((name) => readEnv(inherited, name))) {
    noteSkip('an upstream proxy is set in the environment (HTTP(S)_PROXY), which the egress proxy does not chain to');
    return {};
  }
  lastSkip = null;
  const token = issueMissionEgressToken(missionId);
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const url = `http://${encodeURIComponent(missionId)}:${encodeURIComponent(token)}@${host}:${address.port}`;
  const noProxy = new Set<string>();
  for (const entry of (readEnv(inherited, 'NO_PROXY') ?? '').split(',')) {
    if (entry.trim()) noProxy.add(entry.trim());
  }
  for (const entry of LOOPBACK_NO_PROXY) noProxy.add(entry);
  // A daemon reached under another name (`TIMON_ORCH_URL`) must stay off the proxy too.
  try {
    noProxy.add(new URL(apiBaseUrl()).hostname.replace(/^\[(.*)\]$/, '$1'));
  } catch { /* an unparsable TIMON_ORCH_URL: the loopback entries stand */ }
  const exclusions = [...noProxy].join(',');
  return {
    ...Object.fromEntries(PROXY_VARS.map((name) => [name, url])),
    ...Object.fromEntries(NO_PROXY_VARS.map((name) => [name, exclusions])),
  };
}
