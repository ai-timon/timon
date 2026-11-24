/**
 * M.3 invariant: no HTTP route reads an owned table without going through
 * `scopedDb` / a viewer-bound helper. A new list/get that talks to `dbApi`
 * directly would re-open the leak M.1f closed for missions (list scoped,
 * stream not).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'plugins-bundled');
const EXTRA = [
  join(fileURLToPath(new URL('.', import.meta.url)), 'sse.ts'),
  join(fileURLToPath(new URL('.', import.meta.url)), 'http-helpers.ts'),
];

const OWNED_READS = [
  'listTasks', 'getTask', 'listTasksByRoutine',
  'listNotifications', 'getNotification', 'countActiveNotifications',
  'countActiveByType', 'listActiveNotifications',
  'listProjectTodo', 'getProjectTodo', 'countOpenProjectTodo', 'countProjectTodo', 'listTodoIntegrations',
  'listInbox', 'listAllInbox', 'getMessage', 'listMessagesForMission', 'pickMessage',
  'listBrowserSessions', 'getBrowserSession',
  'listPendingProposals', 'getProposal',
  'listDreamProposals', 'listActiveDreams', 'getDreamProposal', 'countActiveDreams',
  'listMissions', 'getMission', 'searchMissions', 'listChildMissions', 'listMissionsByTask',
  'getStats',
];

const CALL = new RegExp(
  String.raw`\bdbApi\.(${OWNED_READS.join('|')})\s*\(`,
);

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (name === 'routes.ts' || name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

const files = [
  ...walk(ROOT).filter((f) => f.endsWith('routes.ts')),
  ...EXTRA,
];

test('HTTP routes do not call dbApi owned-reads; they go through scopedDb', () => {
  const hits: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('typeof dbApi.')) continue;
      if (CALL.test(line)) {
        hits.push(`${relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(hits, [], `unscoped owned reads in routes:\n${hits.join('\n')}`);
});

/**
 * SECU-USERS U-1 / U-6: the mutations of `/api/missions/:id*` and
 * `/api/workflows/:id*` go through the same viewer as their reads. A route
 * handler on those prefixes that never calls `scopedDb(` (or the
 * `ownedMissionOr404` helper built on it) would re-open the write IDOR the
 * audit found: kill / fork / reconfigure the mission of another user.
 */
const OWNED_MUTATION_PREFIXES = ['/api/missions/:id', '/api/workflows/:id', '/api/human/:id', '/api/permissions/:id'];
const ROUTE_HEAD = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;

test('HTTP mutations on missions / workflows / cards are viewer-scoped', () => {
  const misses: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const heads = [...src.matchAll(ROUTE_HEAD)];
    for (let i = 0; i < heads.length; i++) {
      const head = heads[i]!;
      const [, verb, path] = head;
      if (verb === 'get') continue;
      if (!OWNED_MUTATION_PREFIXES.some((prefix) => path!.startsWith(prefix))) continue;
      // The handler body is what sits between this head and the next one.
      const body = src.slice(head.index!, heads[i + 1]?.index ?? src.length);
      // Mission-token routes (`/done`, `/proposals`) authenticate by the
      // mission that owns the node instead — explicit 401/403 on missionId.
      if (/req\.auth\?\.missionId/.test(body)) continue;
      if (/\bscopedDb\(|\bownedMissionOr404\(/.test(body)) continue;
      misses.push(`${relative(process.cwd(), file)}: ${verb.toUpperCase()} ${path}`);
    }
  }
  assert.deepEqual(misses, [], `unscoped owned mutations:\n${misses.join('\n')}`);
});
