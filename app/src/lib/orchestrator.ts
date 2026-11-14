/**
 * REST client for the standalone Express orchestrator. Used by:
 *  - the channels inbound flow (spawn with source_channel tracking)
 *  - the bearer-auth remote API (spawn/get/kill)
 *  - the reply worker (`mission-watcher`)
 *
 * Server-to-server, not a browser: send the daemon token so a populated
 * users table does not 401 these callers. The Next `/api/ui` proxy does
 * not use this helper.
 *
 * Always the local daemon (`localTarget()`), never the machine a browser has
 * switched to: the daemon token read here is this host's, and must never be
 * presented to another machine.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localTarget, relayFetch } from './machines/target';

export function orchestratorAuthHeaders(): Record<string, string> {
  const fromEnv = (process.env.TIMON_API_TOKEN ?? process.env.TIMON_DAEMON_TOKEN ?? '').trim();
  const token = fromEnv || tokenFromHome();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function tokenFromHome(): string {
  const home = process.env.TIMON_HOME?.trim();
  if (!home) return '';
  try {
    return readFileSync(join(home, 'daemon-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

export type MissionDetails = {
  id: string;
  agent_name: string;
  mission: string;
  status: 'running' | 'completed' | 'failed' | string;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  source_channel: string | null;
  source_meta?: unknown;
  running: boolean;
  turn_active?: boolean;
  events: { id: number; type: string; timestamp: number; payload: unknown }[];
};

export async function spawnMission(input: {
  agent: string;
  mission: string;
  sourceChannel?: string;
  sourceMeta?: unknown;
  idempotencyKey?: string;
  apiToken?: string;
}): Promise<string> {
  const body: Record<string, unknown> = { agent: input.agent, input: input.mission };
  if (input.idempotencyKey) body.idempotency_key = input.idempotencyKey;
  if (input.sourceChannel) body.source_channel = input.sourceChannel;
  if (input.sourceMeta !== undefined) body.source_meta = input.sourceMeta;
  const res = await relayFetch(localTarget(), '/api/missions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(input.apiToken ? { Authorization: `Bearer ${input.apiToken}` } : orchestratorAuthHeaders()) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`orchestrator spawn failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { mission_id: string }).mission_id;
}

export async function getMission(id: string, apiToken?: string): Promise<MissionDetails | null> {
  const res = await relayFetch(localTarget(), `/api/missions/${id}`, {
    headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : orchestratorAuthHeaders(), signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`orchestrator getMission failed: ${res.status}`);
  return (await res.json()) as MissionDetails;
}

export async function killMission(id: string): Promise<boolean> {
  const res = await relayFetch(localTarget(), `/api/missions/${id}`, {
    method: 'DELETE',
    headers: orchestratorAuthHeaders(), signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`orchestrator kill failed: ${res.status}`);
  return true;
}

/** Concatenate the final assistant text blocks from a mission's stream-json events. */
export function extractAssistantText(events: MissionDetails['events']): string {
  const parts: string[] = [];
  for (const ev of events) {
    if (ev.type !== 'assistant') continue;
    const p = ev.payload as { message?: { content?: Array<{ type: string; text?: string }> } };
    const content = p.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}
