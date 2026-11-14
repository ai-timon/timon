import { migrateTodoOutcomeColumns } from './todo-outcome-migration.js';
import { permissionsFromSource } from './users/permission-source.js';
import { emitAccountChange } from './users/account-changes.js';
import Database from 'better-sqlite3';
import { mutationLicenseState } from './license/runtime.js';
import { assertAccountWrite } from './license/capabilities.js';
import { randomUUID } from 'node:crypto';
import {
  DuplicateEmailError,
  LastSuperadminError,
} from './users/errors.js';
import { isDeveloperAccount } from './users/agent-permissions.js';
import { EGRESS_PROXY_TOKEN_SCOPE, intersectMissionTokenPermissions } from './users/permissions.js';
import { dedupeModelFavorites, parseStoredModelFavorites, type ModelFavorite } from './users/model-favorites.js';
import { parseStoredPlanPresets, stampPlanPresets, type PlanPreset, type PlanPresetInput } from './users/plan-presets.js';
import {
  OWNED_TABLES,
  SHARED_SYSTEM_ROW_TABLES,
  ownerSql,
  rowVisible,
  type DbViewer,
  type OwnedTable,
} from './users/owned.js';

export {
  DuplicateEmailError,
  LastSuperadminError,
};
export { OWNED_TABLES, ownerSql, rowVisible, viewerSeesAll } from './users/owned.js';
export type { DbViewer, OwnedTable } from './users/owned.js';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DB_PATH, LEGACY_ACCOUNT_TABLES_FILE, TIMON_HOME } from './paths.js';
import {
  LEGACY_ACCOUNT_TABLES,
  moveLegacyAccountTables,
  readLegacyAccountRows,
  type LegacyAccountTable,
} from './users/legacy-account-tables.js';
import { prepareOwnerOnlyFile, tightenToOwner } from './host/owner-only.js';
import { assertDataUpdateApproved, assertPackagedCliMayOpen, packagedCli, packagedDaemon, protectDataBeforeOpen, timonVersion, unpackagedDataNotice } from './data-version.js';
import { holdDataOpenLock, releaseDataOpenLock } from './data-open-lock.js';
import { bus, type TaskDeletedSnapshot } from './bus.js';
import {
  BACKEND_FALLBACK_REASONS,
  countsTowardCrashLoop,
  isRequeueableInterruption,
  requeueBackoffMs,
  toInterruptionReason,
  type InterruptionReason,
} from './interruption.js';
import { bestRateLimit, isOverloadedEvent, rateLimitFromEvent, type RateLimitHit } from './rate-limit.js';
import { extractSearchFragments, toMissionFtsQuery } from './mission-search.js';
import { missionOriginSql, type MissionOrigin, type MissionOriginFilter } from './mission-origin.js';
import type { MissionTitleOrigin, MissionTitleSource } from './mission-title-source.js';
import {
  isSecretMode,
  isSecretScopeKind,
  isValidSecretName,
  type SecretGrant,
  type SecretMode,
  type SecretScopeKind,
} from './secrets/resolve.js';
import { parseBrokerSpec } from './secrets/broker-spec.js';
import { renameAgentInEventFilter } from './triggers/filter.js';
import { isSealed, open as openSecret } from './secrets/box.js';
import { requireMasterKey } from './secrets/key.js';
import type { TodoUrgency, TodoProgress } from './project-todo-tags.js';
import { CHAT_VIEW_SQL, keepLatestState } from './mission-events-view.js';
import { resultModelOf, resultModelSql, steeredResultSql } from './result-model.js';
import {
  invalidateRedactionCache,
  redactDeep,
  redactNullable,
  redactText,
  setRedactionSource,
} from './secrets/redact.js';

mkdirSync(dirname(DB_PATH), { recursive: true });

// Before the first migration below: the copy is what an older version can go back to.
// Without it, a pending destructive migration (DESTRUCTIVE_MIGRATIONS) throws and nothing opens the database.
// Held from the copy to the last migration of this module: the daemon and a packaged CLI
// approved at the same moment must not both copy, nor both migrate (TODO #592).
if (packagedDaemon()) {
  assertDataUpdateApproved({ home: TIMON_HOME, dbPath: DB_PATH, configPath: join(TIMON_HOME, 'timon.config.json') }, timonVersion());
  holdDataOpenLock(TIMON_HOME);
  try { protectDataBeforeOpen({ home: TIMON_HOME, dbPath: DB_PATH, configPath: join(TIMON_HOME, 'timon.config.json') }, timonVersion()); }
  catch (error) { releaseDataOpenLock(TIMON_HOME); throw error; }
} else if (packagedCli()) {
  // Once approved, the CLI may be first to open the data: it keeps the same copy the daemon would.
  assertPackagedCliMayOpen({ home: TIMON_HOME, dbPath: DB_PATH, configPath: join(TIMON_HOME, 'timon.config.json') }, timonVersion());
  holdDataOpenLock(TIMON_HOME);
  try { protectDataBeforeOpen({ home: TIMON_HOME, dbPath: DB_PATH, configPath: join(TIMON_HOME, 'timon.config.json') }, timonVersion()); }
  catch (error) { releaseDataOpenLock(TIMON_HOME); throw error; }
} else {
  const notice = unpackagedDataNotice({ home: TIMON_HOME, dbPath: DB_PATH, configPath: join(TIMON_HOME, 'timon.config.json') }, timonVersion());
  if (notice) console.warn(notice);
}

// After the data-version checks above, which read whether a database exists:
// creating it earlier would turn a first start into an update to approve.
// Owner-only before SQLite creates it at 0644: the `-wal` / `-shm` it then creates
// take the database's mode. Existing ones are tightened too, never widened (TODO #864).
prepareOwnerOnlyFile(DB_PATH);
for (const suffix of ['-wal', '-shm']) tightenToOwner(`${DB_PATH}${suffix}`);

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// `todo_later` becomes `project_todo` (volet 3/4 of the Kanban work): the
// table name IS the permission key (`OWNED_TABLES` is interpolated into SQL) and the
// name of the MCP tool surface. The rename runs BEFORE the schema block:
// after it, `CREATE TABLE IF NOT EXISTS project_todo` would already have created an
// empty table, this guard would have seen it present and skipped — the ideas
// staying orphaned in `todo_later`, without the slightest error. Idempotent: it
// only does something if the old one exists and the new one does not.
{
  const tableNames = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
      .map((t) => t.name),
  );
  if (tableNames.has('todo_later') && !tableNames.has('project_todo')) {
    db.exec(`ALTER TABLE todo_later RENAME TO project_todo`);
    db.exec(`DROP INDEX IF EXISTS idx_todo_later_status`);
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  agent_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  priority INTEGER NOT NULL DEFAULT 3,
  deps TEXT NOT NULL DEFAULT '[]',
  mission_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  scheduled_at INTEGER,
  blocked_reason TEXT,
  done_comment TEXT,
  extra_skills TEXT,
  extra_mcp_servers TEXT,
  extra_allowed_tools TEXT,
  FOREIGN KEY (mission_id) REFERENCES missions(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_mission ON tasks(mission_id);

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  mission TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_code INTEGER,
  source_channel TEXT,
  source_meta TEXT,
  total_cost_usd REAL,
  tokens_in INTEGER,
  tokens_out INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id)
);

CREATE INDEX IF NOT EXISTS idx_events_mission ON events(mission_id, id);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'chore',
  cron_expr TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  project TEXT,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_routines_enabled_next ON routines(enabled, next_run_at);

-- Native triggers (TODO #216): source (schedule | webhook | event) → filter →
-- actions. Routines live here since then, as schedule triggers created_by
-- 'routine'; the routines table above is frozen, kept only so a downgrade
-- still finds what it reads. JSON columns are validated by zod on the way in.
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT,
  source TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',
  filter TEXT,
  actions TEXT NOT NULL DEFAULT '[]',
  secret TEXT,
  owner_user_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'user',
  creator_agent TEXT,
  -- Agent whose delegation list bounds the task actions, re-checked at every
  -- run; follows the last editor like grants. NULL = a human's trigger.
  acting_agent TEXT,
  grants TEXT,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_triggers_slug ON triggers(slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_triggers_source_next ON triggers(source, enabled, next_run_at);

CREATE TABLE IF NOT EXISTS trigger_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  delivery_key TEXT,
  excerpt TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS idx_trigger_deliveries_trigger ON trigger_deliveries(trigger_id, id);

-- Calls of the "webhook" action waiting to be sent or retried. A row keeps
-- the exact body it signs, so every retry carries the same webhook-id and bytes.
CREATE TABLE IF NOT EXISTS trigger_outbox (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  url TEXT NOT NULL,
  body TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  delivered_at INTEGER,
  failed_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trigger_outbox_due ON trigger_outbox(delivered_at, failed_at, next_at);

-- Replay guard, apart from the journal: the journal is pruned to its last
-- rows, and a pruned delivery id must not become replayable.
CREATE TABLE IF NOT EXISTS trigger_dedupe (
  trigger_id TEXT NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (trigger_id, key)
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  from_mission TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  to_mission TEXT,
  kind TEXT NOT NULL DEFAULT 'msg',
  payload TEXT NOT NULL,
  in_reply_to TEXT,
  created_at INTEGER NOT NULL,
  picked_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  FOREIGN KEY (from_mission) REFERENCES missions(id)
);
CREATE INDEX IF NOT EXISTS idx_msgs_to_status ON agent_messages(to_agent, status, created_at);
CREATE INDEX IF NOT EXISTS idx_msgs_from ON agent_messages(from_mission);
CREATE INDEX IF NOT EXISTS idx_msgs_reply ON agent_messages(in_reply_to);
-- The mission list counts each row's owed messages. Without it, each count was
-- a full table scan (6k rows, ~0.35 ms), 105 ms for a 300-row page; pending
-- rows are a handful, so the partial index stays tiny.
CREATE INDEX IF NOT EXISTS idx_msgs_pending ON agent_messages(to_mission, to_agent) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS agent_request_deliveries (
  request_id TEXT PRIMARY KEY REFERENCES agent_messages(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_request_deliveries_open
  ON agent_request_deliveries(mission_id) WHERE settled_at IS NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  body TEXT,
  task_id TEXT,
  mission_id TEXT,
  anchor TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  dismissed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notifications_active ON notifications(dismissed_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_task ON notifications(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_mission ON notifications(mission_id) WHERE mission_id IS NOT NULL;

-- A command an agent asked its owner to decide on (terminal_propose), shown
-- as a card in the mission's conversation. Its own table, not the events: the
-- card outlives its mission (the coder proposes the rebuild, then closes its
-- task) and the daemon (the rebuild restarts it), and a per-project badge
-- counts the pending ones without scanning every event. No foreign key: an
-- archived mission must not take its owner's pending command with it.
CREATE TABLE IF NOT EXISTS command_requests (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  command TEXT NOT NULL,
  note TEXT,
  session_id TEXT,
  project TEXT,
  mission_title TEXT NOT NULL,
  task_id TEXT,
  choices TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_command_requests_owner ON command_requests(owner_user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_command_requests_mission ON command_requests(mission_id, created_at);

-- A screen arrangement an agent proposes to its owner (widgets_propose, and
-- the island layouts after it), shown as a card in the mission's conversation.
-- The owner's browser applies it; the daemon only keeps the validated payload
-- and the decision. Same lifetime as a command request: no foreign key.
CREATE TABLE IF NOT EXISTS layout_proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  payload TEXT NOT NULL,
  note TEXT,
  project TEXT,
  mission_title TEXT NOT NULL,
  task_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_layout_proposals_owner ON layout_proposals(owner_user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_layout_proposals_mission ON layout_proposals(mission_id, created_at);

-- An HTML document shown in a mission's conversation (ui_render, MCPUI —
-- docs/ADR-MCPUI.md D2). The HTML lives in the row: status and content change
-- in one transaction, masking applies once at write time, and no path is ever
-- built. No foreign key, like command_requests; the purge timer removes the
-- rows of missions finished longer than the chat attachments' retention.
CREATE TABLE IF NOT EXISTS ui_documents (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  origin_id TEXT,
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  bridge TEXT NOT NULL DEFAULT 'timon',
  height INTEGER,
  expects_reply INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  reply TEXT,
  resolved_by_kind TEXT,
  resolved_by_id TEXT,
  resolved_at INTEGER,
  ref_provider TEXT,
  ref TEXT,
  project TEXT,
  mission_title TEXT NOT NULL,
  task_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ui_documents_mission ON ui_documents(mission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ui_documents_owner ON ui_documents(owner_user_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ui_documents_ref ON ui_documents(origin_id, ref_provider, ref) WHERE ref IS NOT NULL;

-- An Allow wider than "this once" that Timon remembers itself, for an agent
-- whose CLI cannot (claude): the next card with the same motif is answered
-- without a human. 'session' rows hold for one mission, 'always' rows for every
-- mission of the agent run by the same owner. A shell command is matched on its
-- hash: the stored command is masked like any event and only shown.
CREATE TABLE IF NOT EXISTS approval_rules (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  mission_id TEXT,
  tool_name TEXT NOT NULL,
  command TEXT,
  command_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_rules_agent ON approval_rules(agent, owner_user_id, scope);
CREATE INDEX IF NOT EXISTS idx_approval_rules_mission ON approval_rules(mission_id) WHERE mission_id IS NOT NULL;

-- Persisted settings. Only OVERRIDDEN keys are stored: a missing key means
-- "registry default" (see settings.ts). We therefore never pre-fill the table,
-- which lets a default evolve in the code without leaving old frozen values
-- behind. The value is always TEXT: settings.ts parses it according to the
-- declared type.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backend_overlays (
  id TEXT PRIMARY KEY,
  disabled INTEGER NOT NULL DEFAULT 0,
  label TEXT, icon TEXT, brand TEXT, rank INTEGER,
  models TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  definition TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  input_payload TEXT,
  started_at INTEGER NOT NULL,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id)
);

CREATE TABLE IF NOT EXISTS pipeline_run_steps (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  PRIMARY KEY (run_id, step_id),
  FOREIGN KEY (run_id) REFERENCES pipeline_runs(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline ON pipeline_runs(pipeline_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_task ON pipeline_run_steps(task_id);

CREATE TABLE IF NOT EXISTS browser_profiles (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  name TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('general','project','agent','custom')),
  scope_ref TEXT,
  grants TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_profiles_owner ON browser_profiles(owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_profiles_scope ON browser_profiles(
  COALESCE(owner_user_id, ''), scope_kind, COALESCE(scope_ref, '')
) WHERE scope_kind <> 'custom';

-- Teams group project-less bots. Membership lives in the agent's config.json
-- (team), this table only holds the team's identity: an agent is a directory
-- on disk, not a row, so there is nothing here to join it to.
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  name TEXT NOT NULL,
  color TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_user_id);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT,
  project TEXT, owner_user_id TEXT, draft TEXT NOT NULL, published_version INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  agent_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflows_owner ON workflows(owner_user_id);
CREATE TABLE IF NOT EXISTS workflow_versions (
  workflow_id TEXT NOT NULL, version INTEGER NOT NULL, definition TEXT NOT NULL,
  published_at INTEGER NOT NULL, published_by TEXT, PRIMARY KEY (workflow_id, version)
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
  trigger TEXT NOT NULL, input TEXT, context TEXT NOT NULL, error TEXT, started_at INTEGER NOT NULL,
  ended_at INTEGER, owner_user_id TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_wf_runs_wf ON workflow_runs(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_wf_runs_open ON workflow_runs(status) WHERE status IN ('running','waiting');
CREATE INDEX IF NOT EXISTS idx_wf_runs_owner ON workflow_runs(owner_user_id);
CREATE TABLE IF NOT EXISTS workflow_run_nodes (
  run_id TEXT NOT NULL, node_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
  mission_id TEXT, input TEXT, output TEXT, error TEXT, taken_port TEXT, started_at INTEGER, ended_at INTEGER,
  tokens_in INTEGER, tokens_out INTEGER, PRIMARY KEY (run_id, node_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_wf_nodes_mission ON workflow_run_nodes(mission_id);
CREATE TABLE IF NOT EXISTS workflow_triggers (
  workflow_id TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL, token TEXT,
  next_run_at INTEGER, last_run_at INTEGER, PRIMARY KEY (workflow_id, node_id)
);

-- ── Memory & projects (file → DB migration) ─────────────────────────────────
-- projects: project meta. kind/status are manual (UI); last_activity is auto
-- (touched at mission_complete). Replaces ~/.timon/projects/<slug>/meta.json.
CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
  name TEXT,
  color TEXT,
  icon TEXT,
  workspace TEXT,
  cwd TEXT,
  speech TEXT,
  kind TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_activity INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_status_activity ON projects(status, last_activity DESC);

-- workspaces: the poles that group projects. A project points to one through
-- projects.workspace (its slug, compared case-insensitively). lead_agent is the
-- optional agent that orchestrates the pole; without one the pole only groups.
CREATE TABLE IF NOT EXISTS workspaces (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  lead_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- learnings: raw facts distilled by the post-mission Haiku capture. Replaces
-- ~/.timon/agents/<name>/memory/learnings.jsonl. status raw → synthesized by the
-- night synthesiser.
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT,
  agent TEXT,
  project TEXT,
  role TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  hash TEXT,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'raw'
);
CREATE INDEX IF NOT EXISTS idx_learnings_project_status ON learnings(project, status);
CREATE INDEX IF NOT EXISTS idx_learnings_kind_status ON learnings(kind, status);

-- memory_rules: curated rules INJECTED into agents. Replaces the .md files
-- (instructions/decisions/pieges). Recall via FTS5 (memory_rules_fts).
CREATE TABLE IF NOT EXISTS memory_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,            -- project | agent | global
  project TEXT,
  agent TEXT,
  kind TEXT NOT NULL,            -- decision | pitfall | preference
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual', -- manual | synthesis
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_scope_project ON memory_rules(scope, project);
CREATE INDEX IF NOT EXISTS idx_rules_agent ON memory_rules(agent);

-- External-content FTS5 full-text index for lexical-semantic recall on the
-- task description. Synced by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_rules_fts USING fts5(
  text,
  content='memory_rules',
  content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS memory_rules_ai AFTER INSERT ON memory_rules BEGIN
  INSERT INTO memory_rules_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_rules_ad AFTER DELETE ON memory_rules BEGIN
  INSERT INTO memory_rules_fts(memory_rules_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_rules_au AFTER UPDATE ON memory_rules BEGIN
  INSERT INTO memory_rules_fts(memory_rules_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memory_rules_fts(rowid, text) VALUES (new.id, new.text);
END;

-- memory_proposals: human validation queue. Produced by the night synthesiser
-- (source=synthesis). Replaces the HTML-comment hack of proposals.md.
CREATE TABLE IF NOT EXISTS memory_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'project',
  project TEXT,
  agent TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  rationale TEXT,
  cluster_size INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'synthesis',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON memory_proposals(status, project);

-- skill_attachments: which skill reaches which agents, and how (skill-attachments.ts).
-- Lives here, not in SKILL.md: the file stays an Agent Skills standard file.
-- target = '' (global) | project slug | role id | agent name.
CREATE TABLE IF NOT EXISTS skill_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill TEXT NOT NULL,
  scope TEXT NOT NULL,           -- global | project | role | agent
  target TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'include', -- include (catalogue line) | import (whole body)
  exclude INTEGER NOT NULL DEFAULT 0,   -- 1 = removes the skill inherited from a wider scope
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(skill, scope, target)
);
CREATE INDEX IF NOT EXISTS idx_skill_attachments_scope ON skill_attachments(scope, target);

-- skill_reads: one row per skill_get a mission made (skill-reads.ts). Its own
-- table rather than an events row: the widget counts reads per skill and
-- per agent over 30 days, an indexed GROUP BY here, a JSON scan there.
CREATE TABLE IF NOT EXISTS skill_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_reads_agent ON skill_reads(agent, at);
CREATE INDEX IF NOT EXISTS idx_skill_reads_at ON skill_reads(at);

-- dream_proposals: review queue of the night "Dreaming". kind=improve
-- (improvement axis of an existing project) | opportunity (new passive-revenue
-- vein). project = targeted slug (improve) or suggestion/null (opportunity).
-- sources = JSON array of URLs (web citations from the opportunity phase). Status:
-- pending → accepted (→ the user turns it into a task by hand) | rejected | snoozed
-- (shown again after snooze_until). ZERO auto-execution: everything goes through review.
CREATE TABLE IF NOT EXISTS dream_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- 'improve' | 'opportunity'
  project TEXT,                    -- target slug (improve) or suggestion (opportunity)
  title TEXT NOT NULL,             -- short title (dedup key, normalised)
  body TEXT NOT NULL,              -- the content of the proposal
  rationale TEXT,                  -- why it serves the ultimate goal
  effort TEXT,                     -- S|M|L estimate (optional)
  conviction INTEGER,              -- 0-100, the agent's conviction level (optional)
  sources TEXT,                    -- JSON array of URLs (opportunity phase)
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected | snoozed
  run_id TEXT,                     -- groups the batch of one night
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  snooze_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dreams_status ON dream_proposals(status, kind);

-- project_todo: improvement ideas noted on the fly (all projects combined),
-- deliberately OUTSIDE the Kanban until they are ripe. Driveable by the user from
-- the cockpit and by the dreaming agent via the API/MCP/CLI. No side effect: nothing here
-- spawns an agent; it is a notebook, not an execution queue.
CREATE TABLE IF NOT EXISTS project_todo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  project TEXT,                        -- target project slug (optional)
  status TEXT NOT NULL DEFAULT 'open', -- open | done | promoted
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_at INTEGER,
  -- Task born from this idea (Kanban part 3/4). IT, not the status, records the
  -- promotion: a PATCH of the status could put the idea back to open, and
  -- without this link it would be promoted a second time, orphaning the first.
  promoted_task_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_project_todo_status ON project_todo(status, created_at);

-- todo_external_ref: where an idea lives outside Timon (Discord thread, GitHub
-- issue, Jira ticket…), written by plugins through ctx.kanban.todos.links.
-- UNIQUE(provider, ref): an external ticket points at ONE idea, which is what
-- lets an incoming ticket find its idea instead of creating a duplicate.
CREATE TABLE IF NOT EXISTS todo_external_ref (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER NOT NULL REFERENCES project_todo(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  ref TEXT NOT NULL,
  url TEXT,
  label TEXT,
  plugin_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, ref)
);
CREATE INDEX IF NOT EXISTS idx_todo_external_ref_todo ON todo_external_ref(todo_id);

-- task_external_ref: where a task lives outside Timon (GitHub Projects card,
-- Linear issue, Jira ticket…), written by plugins through ctx.kanban.refs. Same
-- shape and same rule as todo_external_ref: UNIQUE(provider, ref) makes an
-- external ticket point at ONE task, so an incoming ticket finds its task
-- instead of creating a duplicate. The task's deletion takes its refs with it.
CREATE TABLE IF NOT EXISTS task_external_ref (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  ref TEXT NOT NULL,
  url TEXT,
  label TEXT,
  plugin_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, ref)
);
CREATE INDEX IF NOT EXISTS idx_task_external_ref_task ON task_external_ref(task_id);

-- Key/value storage of third-party plugins (§10.4 of the modular plan). The
-- primary key carries plugin_id FIRST, and every read filters on it: that
-- isolation is what makes a plugin never see another plugin's keys. There is
-- deliberately no API that returns the whole table. The value column is JSON:
-- the facade serialises. Manifest settings of type secret (S.9) store an
-- enc:1: envelope wrapping that JSON, so a copy of this database does not
-- leak them.
CREATE TABLE IF NOT EXISTS plugin_kv (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, key)
);

-- Outgoing calls of third-party plugins (ctx.outbox, plugins/outbox.ts).
-- seq orders the queue: calls sharing a key leave one after the other.
-- No credential is ever stored: url_secret, sign_secret and
-- auth_secret hold the NAME of a vault entry granted to the plugin, read
-- again at each attempt.
CREATE TABLE IF NOT EXISTS plugin_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  plugin_id TEXT NOT NULL,
  key TEXT,
  method TEXT NOT NULL,
  url TEXT,
  url_secret TEXT,
  headers TEXT NOT NULL,
  body TEXT,
  sign_secret TEXT,
  auth_secret TEXT,
  auth_header TEXT,
  auth_scheme TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  delivered_at INTEGER,
  failed_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_outbox_due ON plugin_outbox(delivered_at, failed_at, next_at);
CREATE INDEX IF NOT EXISTS idx_plugin_outbox_key ON plugin_outbox(plugin_id, key, seq);

-- Widget placement in the UI. One row per (owner, scope): owner='' is the
-- machine template (first-run / daemon-token without a user), otherwise
-- users.id. No FK on owner — the empty string must stay legal, and a
-- disabled account keeps its rows. The value column is opaque JSON: the
-- daemon stores and returns it untouched. The shape of a layout belongs
-- to the front, which is free to change it (adding a zone, a hidden flag)
-- without a migration here.
CREATE TABLE IF NOT EXISTS ui_layout (
  owner TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, scope)
);

-- Secrets vault (SECRETS-VAULT.md §5.1). value_enc is the sealed envelope
-- (enc:1:<iv>:<tag>:<ciphertext>), never a plaintext value: nothing in this
-- table is readable from a copy of timon.db alone. name is deliberately NOT
-- unique — GITHUB_TOKEN may exist at three scopes with three different values,
-- and the collision is settled at resolution time (§5.3), not by the schema.
CREATE TABLE IF NOT EXISTS secrets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,              -- ^[A-Z][A-Z0-9_]*$
  value_enc   TEXT NOT NULL,
  mode        TEXT NOT NULL,              -- 'inject' | 'broker'
  broker_spec TEXT,                       -- JSON, required when mode='broker' (§6.2)
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_secrets_name ON secrets(name);

-- Who may receive a secret. NO row at all = the daemon alone, which is the
-- default and the correct state for the VAPID key or the remote master (§5.2).
-- Grants add up: project:x AND agent:y on the same secret both open access.
-- Except 'backend': a reservation, intersected with the others (secrets/resolve.ts).
CREATE TABLE IF NOT EXISTS secret_grants (
  secret_id   TEXT NOT NULL,
  scope_kind  TEXT NOT NULL,              -- 'global' | 'project' | 'agent' | 'backend'
  scope_ref   TEXT,                       -- project slug, agent name, backend id, NULL if global
  PRIMARY KEY (secret_id, scope_kind, scope_ref),
  FOREIGN KEY (secret_id) REFERENCES secrets(id) ON DELETE CASCADE
);
-- A NULL inside a PRIMARY KEY does NOT constrain in SQLite (non-STRICT rowid
-- table): without this index, global grants would duplicate silently, one row
-- per click on the UI. COALESCE gives NULL a comparable value.
CREATE UNIQUE INDEX IF NOT EXISTS ux_secret_grants
  ON secret_grants(secret_id, scope_kind, COALESCE(scope_ref, ''));

-- Access journal (SECRETS-VAULT.md §8). One row per injection resolution and
-- per broker call, answering the two questions the vault exists for: who read
-- this token, and has it been used since it leaked. NEVER the value — not
-- truncated, not hashed, not in debug: a journal that holds a fragment of a
-- secret is a second copy of it. The name is denormalised so a deleted secret
-- still reads as something in the journal instead of a dangling id, hence no
-- foreign key here.
CREATE TABLE IF NOT EXISTS secret_access (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  secret_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  mission_id TEXT,
  agent      TEXT,
  at         INTEGER NOT NULL,
  kind       TEXT NOT NULL,             -- 'inject' | 'broker' | 'reveal' | 'create' | 'request' | 'erase' | 'fill'
  outcome    TEXT NOT NULL,             -- 'ok' | 'denied'
  detail     TEXT                       -- why it was denied; never a value
);
CREATE INDEX IF NOT EXISTS idx_secret_access_secret ON secret_access(secret_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_secret_access_at ON secret_access(at);
`);

// T.1 — ui_layout PK (owner, scope). SQLite cannot widen a PRIMARY KEY, so
// existing installs rebuild the table once. Rows already stored become the
// machine template (owner=''): Ada's first drag copy-on-writes, Bob is
// untouched. Fresh installs already have `owner` from CREATE TABLE above.
{
  const uiLayoutCols = (db.prepare(`PRAGMA table_info(ui_layout)`).all() as { name: string }[])
    .map((c) => c.name);
  if (!uiLayoutCols.includes('owner')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE ui_layout_new (
          owner TEXT NOT NULL DEFAULT '',
          scope TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (owner, scope)
        );
        INSERT INTO ui_layout_new (owner, scope, value, updated_at)
          SELECT '', scope, value, updated_at FROM ui_layout;
        DROP TABLE ui_layout;
        ALTER TABLE ui_layout_new RENAME TO ui_layout;
      `);
    })();
  }
}

// Notification source: `plugin:<id>` when it comes from a third-party plugin (§10.4).
// NULL = a notification from the daemon itself, which describes every earlier row —
// hence a nullable column rather than a default, which would wrongly attribute the
// history. Lightweight migration for installs that pre-date newer columns. Task type:
const notifCols = (db.prepare(`PRAGMA table_info(notifications)`).all() as { name: string }[]).map((c) => c.name);
if (!notifCols.includes('source')) db.exec(`ALTER TABLE notifications ADD COLUMN source TEXT`);
// SUG-0048: what closes an agent's action_required card by itself (`dismiss_on`,
// a JSON list) and when it lapses (`expires_at`). NULL on every earlier row and on
// the daemon's own cards, which keep their anchor-driven lifecycle.
if (!notifCols.includes('dismiss_on')) db.exec(`ALTER TABLE notifications ADD COLUMN dismiss_on TEXT`);
if (!notifCols.includes('expires_at')) db.exec(`ALTER TABLE notifications ADD COLUMN expires_at INTEGER`);

// classifies what a task actually represents. No distinct behaviour at the dispatcher
const taskCols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name);
if (!taskCols.includes('extra_skills')) db.exec(`ALTER TABLE tasks ADD COLUMN extra_skills TEXT`);
if (!taskCols.includes('extra_mcp_servers')) db.exec(`ALTER TABLE tasks ADD COLUMN extra_mcp_servers TEXT`);
if (!taskCols.includes('extra_allowed_tools')) db.exec(`ALTER TABLE tasks ADD COLUMN extra_allowed_tools TEXT`);
// (except for `code`, which will trigger a
// worktree, implemented later) — first of all
// it serves Kanban readability and the agentic
// chain (code → review → merge) prescribed
if (!taskCols.includes('type')) db.exec(`ALTER TABLE tasks ADD COLUMN type TEXT NOT NULL DEFAULT 'chore'`);
// by the skills. Worktree fields. A
// `type=code` task (and its review/merge descendants)
// runs in an isolated git worktree, created at spawn by the dispatcher. The task
// carries the path + the branch so the
// timon-worktree skill can find them, and the sha
if (!taskCols.includes('worktree_path')) db.exec(`ALTER TABLE tasks ADD COLUMN worktree_path TEXT`);
if (!taskCols.includes('branch_name')) db.exec(`ALTER TABLE tasks ADD COLUMN branch_name TEXT`);
if (!taskCols.includes('base_branch')) db.exec(`ALTER TABLE tasks ADD COLUMN base_branch TEXT`);
if (!taskCols.includes('merged_commit_sha')) db.exec(`ALTER TABLE tasks ADD COLUMN merged_commit_sha TEXT`);
// of the final merged commit for later audit (the branch itself will be cleaned after
// merge — the trail stays in events
// + the sha). Per-task LLM/permission overrides. When
// non-null, the dispatcher passes these values to spawn (which stores them on the
// mission); they take precedence over the project role and the agent config. Used for
// one-off exceptions (e.g. force Opus + bypass on a large overnight feature). Task
// pipeline: which steps chain automatically after it. null | 'full' → code → review →
// merge → doc (historical default, unchanged) 'code-self'
// → no auto review or doc; the
// coder merges THEIR branch and closes with --merged-sha (the sha guard applies to
// them, see guardMergeDone) 'code-group' → no auto
// review or doc; a final `merge` task
// created by the orchestrator consolidates the whole
if (!taskCols.includes('pipeline')) db.exec(`ALTER TABLE tasks ADD COLUMN pipeline TEXT`);
if (!taskCols.includes('backend_override')) db.exec(`ALTER TABLE tasks ADD COLUMN backend_override TEXT`);
if (!taskCols.includes('model_override')) db.exec(`ALTER TABLE tasks ADD COLUMN model_override TEXT`);
if (!taskCols.includes('permission_mode_override')) db.exec(`ALTER TABLE tasks ADD COLUMN permission_mode_override TEXT`);
// group Any other value (or null) =
// full pipeline: the degraded mode must be the SAFE mode, never the reverse. EXPLICIT
// fallback set on THIS task at creation, distinct from `backend_override` (which
// chooses the PRIMARY backend). NULL = no manual fallback for this specific task:
// `fallbackFor` then falls back to the series rule, then the global setting, then the
// default equivalence matrix (see backend-fallback.ts).
if (!taskCols.includes('fallback_backend_override')) db.exec(`ALTER TABLE tasks ADD COLUMN fallback_backend_override TEXT`);
if (!taskCols.includes('fallback_model_override')) db.exec(`ALTER TABLE tasks ADD COLUMN fallback_model_override TEXT`);
// 'none' = explicit refusal, same
// semantics as the `--backend none` sentinel of
if (!taskCols.includes('routine_id')) db.exec(`ALTER TABLE tasks ADD COLUMN routine_id TEXT`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_routine ON tasks(routine_id)`);
// Native trigger that created the task (TODO #216). Lets an event trigger
// ignore the events its own tasks cause, instead of feeding on itself.
if (!taskCols.includes('trigger_id')) db.exec(`ALTER TABLE tasks ADD COLUMN trigger_id TEXT`);

// Routines become schedule triggers (TODO #216), copied with the SAME ids so
// tasks.routine_id, missions.routine_id and the agent graph stay valid.
// `migrated_at` marks a copied row rather than a one-shot flag: a routine
// deleted as a trigger must not come back at the next boot, while one created
// by a downgraded build in between still moves over at the next upgrade.
// `raw` keeps the prompt out of the template engine: an old prompt holding
// `{…}` (JSON, code) must reach the task exactly as before.
const routineCols = (db.prepare(`PRAGMA table_info(routines)`).all() as { name: string }[]).map((c) => c.name);
if (!routineCols.includes('migrated_at')) db.exec(`ALTER TABLE routines ADD COLUMN migrated_at INTEGER`);
db.transaction(() => {
  const pending = db.prepare(`SELECT * FROM routines WHERE migrated_at IS NULL`).all() as Array<{
    id: string; name: string; agent_name: string; prompt: string; task_type: string; cron_expr: string;
    enabled: number; project: string | null; last_run_at: number | null; next_run_at: number | null;
    created_at: number; updated_at: number;
  }>;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO triggers (id, name, source, enabled, config, actions, created_by, last_run_at, next_run_at, created_at, updated_at)
     VALUES (?, ?, 'schedule', ?, ?, ?, 'routine', ?, ?, ?, ?)`,
  );
  const mark = db.prepare(`UPDATE routines SET migrated_at = ? WHERE id = ?`);
  const now = Date.now();
  for (const r of pending) {
    insert.run(
      r.id, r.name, r.enabled ? 1 : 0, JSON.stringify({ cron: r.cron_expr }),
      JSON.stringify([routineAction(r)]),
      r.last_run_at, r.next_run_at, r.created_at, r.updated_at,
    );
    mark.run(now, r.id);
  }
})();
// series rules. Lineage: if the task was
// created by a routine tick, we keep the link for the graph view. Null for tasks
// created by hand. Verification loop: `iteration` is the code↔review iteration number
// (1 for the original code task, 2 for the first respawn after changes_requested,
if (!taskCols.includes('iteration')) db.exec(`ALTER TABLE tasks ADD COLUMN iteration INTEGER NOT NULL DEFAULT 1`);
if (!taskCols.includes('verification_root_id')) db.exec(`ALTER TABLE tasks ADD COLUMN verification_root_id TEXT`);
// etc.). `verification_root_id` points at the original
// code task — used to recover the
// initial prompt on every respawn and to block the right task on escalation. Group
// lineage: a batch of tasks created together by the orchestrator (e.g. splitting a
// feature into N parallel slices + merge) shares a `group_id`. Lets us follow group
if (!taskCols.includes('group_id')) db.exec(`ALTER TABLE tasks ADD COLUMN group_id TEXT`);
// Plan group (TODO #433): the name of the group of volets a task belongs to in
// its series plan (`kanban_plan`), NULL for a task outside any group. Set at
// creation only, inherited by the review, merge, doc and iteration tasks the
// chain creates from their root. The dispatcher reads it to pick the group's
// LLM and fallback (`series_group_roles`, `series_group_fallbacks`) before the
// series-wide ones. Never interpreted: a label, not a path or a command.
if (!taskCols.includes('plan_group')) db.exec(`ALTER TABLE tasks ADD COLUMN plan_group TEXT`);
if (!taskCols.includes('group_notified')) db.exec(`ALTER TABLE tasks ADD COLUMN group_notified INTEGER NOT NULL DEFAULT 0`);
// completion to wake the orchestrator when the batch is finished. `group_notified` is
// an idempotent flag: once the end of the
// group has been notified (wake emitted), we do
// not wake again. Work return already delivered
// to the pilot for THIS execution of the
// task. The return now goes out at TASK CLOSURE (event `task_done` / `task_blocked`),
// no longer at process death: without this flag, the late `mission_complete` in
// agent.ts would queue a second message for the same unit of work and cause a second
if (!taskCols.includes('return_notified')) db.exec(`ALTER TABLE tasks ADD COLUMN return_notified INTEGER NOT NULL DEFAULT 0`);
// wake. Reset to 0 on (re-)dispatch: a relaunched task must be able to report back
// again. Measured on 2026-08-21 (series `e6893b9e`): review `693469fa` closed at 09:18
// was only reported at 09:29, at mission death — 11 min late. Follow-up chaining
// (review/merge/doc/group recap) already triggered for THIS execution of the task.
// Chaining now starts at CLOSURE of the
// task (`task_done`), no longer at process death:
// `mission_complete` arrives up to TIMON_REAP_IDLE_MS (600 000 ms) later — 11 min
// measured on 2026-08-21 between review `98e28f1a` closed at 09:47 and the next code
// iteration created at 09:58. This flag closes the double-run: the chain can only run
// once per task execution, whatever the number of re-emitted `task_done` (re-close
// after a merge-integrity bounce, reconcile at boot…). Reset to 0 on (re-)dispatch,
// like `return_notified`: a relaunched task must be able to chain again. Three values,
// NOT a boolean (see TaskChainState): 0 never
// attempted, 1 in progress, 2 finished. The
// boolean version set the flag before the first await and only cleared it in a JS
// `catch` — but a SIGTERM, an OOM (V8 heap cap at 4 GB, chronic here) or a restart
// between set and finish left `chain_ran = 1`
// on a chain that had produced nothing, and
// reconcile only resumed the `0`s: that task was NEVER caught up again. The safety net
// A task whose work return must never reach the pilot (`silent_return` of a
// trigger's task action, `silentReturn` of a plugin's `ctx.kanban.add`). Kept
// apart from `return_notified` because dispatch resets that one: the re-arm
// copies this value instead of a hard 0, so a silent task stays silent on
// every execution (retry, requeue, recovery).
if (!taskCols.includes('silent_return')) db.exec(`ALTER TABLE tasks ADD COLUMN silent_return INTEGER NOT NULL DEFAULT 0`);
// A mirror task is the image of a ticket that lives in another system (GitHub
// Projects, Linear, Jira), kept by a plugin. It is INERT: never dispatched, and
// its closure never chains a review, a doc or a pilot wake-up (`isMirrorTask`,
// task-mirror.ts). Fixed at creation — no write path flips it afterwards, so a
// task that can run can never be turned into a mirror, nor the reverse.
if (!taskCols.includes('mirror')) db.exec(`ALTER TABLE tasks ADD COLUMN mirror INTEGER NOT NULL DEFAULT 0`);
if (!taskCols.includes('chain_ran')) db.exec(`ALTER TABLE tasks ADD COLUMN chain_ran INTEGER NOT NULL DEFAULT 0`);
if (!taskCols.includes('chain_started_at')) db.exec(`ALTER TABLE tasks ADD COLUMN chain_started_at INTEGER`);
// was therefore blind to the very scenario that created it. `chain_started_at` dates
// the transition to 1: a 1 older than CHAIN_STALE_MS is a chain dead in flight, not a
// chain in progress. Number of chaining attempts, to bound replay (see
// MAX_CHAIN_ATTEMPTS, task-chain.ts). Without a ceiling, a chain that fails
// DETERMINISTICALLY — worktree already cleaned, reviewer role unresolvable, exception
// in doc-task — restarted every 120 s for the 6 h catch-up window, i.e. ~180 times,
// without ever telling anyone. Everything else in the system is bounded
if (!taskCols.includes('chain_attempts')) db.exec(`ALTER TABLE tasks ADD COLUMN chain_attempts INTEGER NOT NULL DEFAULT 0`);
// (MAX_ITERATIONS, MAX_REPAIRS, requeue_count, MAX_INVALID_ASK_USER): chaining was the
// only unbounded replay with no escalation. MIGRATION — `chain_ran` changed SEMANTICS,
// not just type. Under the boolean version, 1 = "chain finished"; under the tri-state,
// 1 = CHAIN_RUNNING = "chain started and never finished". Without this line, the tasks
// chained by the previous version (36 in the database on 2026-08-21) would pass the
// reconcile filter and be replayed on first boot, logging "chain started at 1970-01-01
// and never finished" on chains that had
// run perfectly. The discrimination is exact and
// has no false positive: `chain_started_at` did
db.exec(`UPDATE tasks SET chain_ran = 2 WHERE chain_ran = 1 AND chain_started_at IS NULL`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id) WHERE group_id IS NOT NULL`);

// not exist when those rows were written,
// so a 1 WITHOUT a start date can only come from the old semantics. Orchestrator
// lineage → batch of tasks. `creator_mission_id` = the orchestrator mission that
// created the task. The dispatcher copies it to `parent_mission_id` of the spawned
// mission so that the orchestrator's wake/resume (T4) knows which session to pick up.
// NB: `group_id` is already added above (see the "Group lineage" block). Do NOT
// re-ALTER it here: `taskCols` is a snapshot taken before this block, so on a fresh DB
// the guard does not see the freshly added column and would re-run an ALTER →
if (!taskCols.includes('creator_mission_id')) db.exec(`ALTER TABLE tasks ADD COLUMN creator_mission_id TEXT`);

// `duplicate column name: group_id` at boot. Kanban series: STABLE identity of a batch
// of tasks piloted by the same orchestrator mission. `creator_mission_id` could not
// play that role — it MUST be allowed to move (when the orchestrator switches to
// another backend, or a fresh wake mission takes the helm), and moving it then erased
// every way to find the tasks of the same project. So we freeze the identity
// (`series_id`, value of the FIRST
// orchestrator mission) and leave `creator_mission_id`
// naming the mission that pilots NOW. Founding incident (2026-08-20):
// Claude quota exhausted mid- project → every task return woke a new `.main` that died
// of the same limit, never recovering the plan. See backend-fallback.ts. Backfill:
if (!taskCols.includes('series_id')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN series_id TEXT`);
  // history never changed pilot mission, so for
  // it series == creating mission. Makes past
  db.exec(`UPDATE tasks SET series_id = creator_mission_id WHERE creator_mission_id IS NOT NULL`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_series ON tasks(series_id) WHERE series_id IS NOT NULL`);

// batches queryable without replay. Exhausted quotas per backend. Persisted (not kept
// in memory) because an orchestrator restart does not reopen the provider's quota:
// believing it would immediately relaunch every mission into the wall. `exact`: does
db.exec(`CREATE TABLE IF NOT EXISTS backend_cooldowns (
  backend TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  quota_window TEXT,
  noted_at INTEGER NOT NULL
)`);
// the reopen time come from the provider (1) or from a mere estimate "now + configured
// duration" (0)? Without this distinction, an error message with no timestamp
// overwrites the exact time announced just before and extends the cooldown by several
// hours (incident 2026-08-22: real reopen 04:40, backend held out until 07:34 by
// drift). Fallback plan of a SERIES, by scope. A long project does not want the same
const cooldownCols = (db.prepare(`PRAGMA table_info(backend_cooldowns)`).all() as { name: string }[])
  .map((c) => c.name);
if (!cooldownCols.includes('exact')) {
  db.exec(`ALTER TABLE backend_cooldowns ADD COLUMN exact INTEGER NOT NULL DEFAULT 0`);
}
// `kind`: a full quota window ('rate_limit', it reopens on its own) or an account
// with no credit left ('exhausted', it does not). Persisted rather than derived,
// because the precedence rules read it: an estimate must never shorten an
// exhaustion, and a restart must not forget that the account is dry (incident
// 2026-09-01, grok 402). Old rows read as 'rate_limit', the historical behaviour.
if (!cooldownCols.includes('kind')) {
  db.exec(`ALTER TABLE backend_cooldowns ADD COLUMN kind TEXT NOT NULL DEFAULT 'rate_limit'`);
}

// fallback everywhere: the coder runs on a large model and must fall back to another
// large model, whereas a review can make do with a small one. And the orchestrator has
// its own fallback — it is the one that receives every alert; if it falls the project
// stops even if the rest of the fleet still has quota. Scopes: 'orchestrator' | a
// TaskType | '*' (default for types not named). Embedded browsers: one Chromium
// container per project, created ON DEMAND (never at boot) so the user and the agents (via
db.exec(`CREATE TABLE IF NOT EXISTS series_fallbacks (
  series_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  backend TEXT,
  model TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (series_id, scope)
)`);

// LLM choices of a SERIES, by task type — the planner's per-role picks. A sister
// of `series_fallbacks` rather than an extension of it: a fallback is what takes
// over when a backend dies (and is APPLIED to pending tasks), a role is who runs
// in the first place (read live at dispatch). Writing these picks into
// `roles.json` would change the default of every later task of the project; this
// table scopes them to the series. Resolution: task override > this > roles.json
// > agent config (see `resolveRoleSpec`).
db.exec(`CREATE TABLE IF NOT EXISTS series_roles (
  series_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  backend TEXT,
  model TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (series_id, scope)
)`);

// The same two rules, per GROUP of volets of the series plan (TODO #433):
// `tasks.plan_group` names the group, and a task of that group resolves here
// first (task override > group > series > project role; same order for the
// fallback). Sister tables rather than a `plan_group` column on the two above:
// widening their primary key means rewriting the tables, and the
// `ON CONFLICT(series_id, scope)` of every earlier version would stop matching
// after a downgrade — whereas these two are simply unknown to it. No existing
// row changes; a series without groups never reads them.
db.exec(`CREATE TABLE IF NOT EXISTS series_group_fallbacks (
  series_id TEXT NOT NULL,
  plan_group TEXT NOT NULL,
  scope TEXT NOT NULL,
  backend TEXT,
  model TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (series_id, plan_group, scope)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS series_group_roles (
  series_id TEXT NOT NULL,
  plan_group TEXT NOT NULL,
  scope TEXT NOT NULL,
  backend TEXT,
  model TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (series_id, plan_group, scope)
)`);

// CDP) browse with an isolated session per project. One row per project, never deleted
// on stop: it keeps the assigned CDP port, which makes the port STABLE from one start
// to the next — an MCP tool configured once on `127.0.0.1:9312` keeps targeting the
// right browser after a stop/start.
//
// `cdp_port` is published on the host loopback (the orchestrator runs in host mode, it
// cannot see the docker network). `novnc_port` is the INTERNAL WEB port of the
// container, the one Traefik routes to over the docker network. It is stored anyway
// because the image can change port from one version to the next and the router set at
// creation freezes that choice for the life of the container. A database that went
// through multi-machine V10b also carries `novnc_host_port` (the web port published on
// the host loopback for a noVNC relay, withdrawn on 25/10/2026): it is no longer
// created, and an existing one stays inert — nothing reads or writes it, and dropping
// it would be a destructive migration. `last_used_at` carries the activity signal
// that makes automatic close on idle possible (see browser-sessions.ts,
db.exec(`CREATE TABLE IF NOT EXISTS browser_sessions (
  project TEXT PRIMARY KEY,
  container_name TEXT NOT NULL,
  cdp_port INTEGER NOT NULL,
  novnc_port INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'stopped',
  started_at INTEGER,
  stopped_at INTEGER
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_browser_sessions_status ON browser_sessions(status)`);

// closeIdleBrowserSessions): NULL until a signal has ever bumped it, in which case the
// calculation falls back to `started_at` — a
// session that just opened is never overdue,
// even with no detected navigation. `open_tabs` is the restore SAFETY NET: the URLs
// captured just before stop (while CDP still answers), consumed and reset to NULL once
// reopened on the next start — see `missingTabs` for deduplication against what
// Chromium restored on its own. Both columns are PURELY ADDITIVE migrations: every
// earlier row stays readable (NULL = "nothing to say about it"). SYSTEM death cause of
// a mission (rate_limit | killed | timeout | crash). NULL = the task was not
// interrupted by the system: either it is running,
const browserSessionCols = (db.prepare(`PRAGMA table_info(browser_sessions)`).all() as { name: string }[])
  .map((c) => c.name);
if (!browserSessionCols.includes('last_used_at')) {
  db.exec(`ALTER TABLE browser_sessions ADD COLUMN last_used_at INTEGER`);
}
if (!browserSessionCols.includes('open_tabs')) {
  db.exec(`ALTER TABLE browser_sessions ADD COLUMN open_tabs TEXT`);
}

// or it was closed by the agent itself
// (`timon task done/block`). Purely additive migration: every earlier task stays
// readable with NULL. See interruption.ts for
// WHY this is separate from blocked_reason.
// Number of automatic requeues after a SYSTEM death (see `setTaskInterrupted`).
if (!taskCols.includes('interrupted_reason')) db.exec(`ALTER TABLE tasks ADD COLUMN interrupted_reason TEXT`);

// DEDICATED column, and above all NOT `iteration`: that is the verification-loop
// counter (MAX_ITERATIONS in verification-loop.ts). Incrementing it for a `code` task
// killed by the reap would consume its review-iteration budget and make it end blocked
// for a reason with no relation to
// its contents. `interrupted_reason` cannot serve as a
// counter either: it is reset to NULL on re-dispatch. EXPLICIT project slug of the
// task. NULL = historical behaviour: the slug is derived from the assigned agent
if (!taskCols.includes('requeue_count')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN requeue_count INTEGER NOT NULL DEFAULT 0`);
}
// When the provider said the quota that stopped this task reopens (TIM-0134). On
// the task and not only in `backend_cooldowns`: that row can be lifted, or
// replaced by an estimate from another mission, and the task must still know.
if (!taskCols.includes('quota_resets_at')) db.exec(`ALTER TABLE tasks ADD COLUMN quota_resets_at INTEGER`);
// Deaths read as a quota wall on the exclusion alone (TODO #724). In the database,
// like `requeue_count`: a restart must not hand a crash loop a new allowance.
if (!taskCols.includes('blind_quota_deaths')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN blind_quota_deaths INTEGER NOT NULL DEFAULT 0`);
}

// (`cfg.project`, otherwise the cwd). Without this column, a task carried by an agent
// not attached to a project had no slug, hence no review/merge role resolved —
// auto-chaining never started, in silence. See taskProjectSlug (task-project.ts) for
// precedence. Cross-provider continuation: stash a pre-computed summary so a fork onto
// a different LLM doesn't have to replay the full transcript every turn.
if (!taskCols.includes('project')) db.exec(`ALTER TABLE tasks ADD COLUMN project TEXT`);

// The waiting-for-dispatch status used to be called `TODO`. The Kanban is
// gaining an idea column literally named "TO DO", so the status was renamed to
// `PENDING` to keep `--status` unambiguous. Historical rows MUST follow: a row
// left in `TODO` matches no query any more — invisible to the dispatcher, to
// the board, to every count. Idempotent by construction (the second run
// updates nothing); the column default on an already-created table still says
// `TODO`, which SQLite cannot alter in place and which nothing reads (every
// INSERT passes the status explicitly).
db.exec(`UPDATE tasks SET status = 'PENDING' WHERE status = 'TODO'`);

const cols =(db.prepare(`PRAGMA table_info(missions)`).all() as { name: string }[]).map((c) => c.name);
if (!cols.includes('source_channel')) db.exec(`ALTER TABLE missions ADD COLUMN source_channel TEXT`);
if (!cols.includes('source_meta')) db.exec(`ALTER TABLE missions ADD COLUMN source_meta TEXT`);
if (!cols.includes('total_cost_usd')) db.exec(`ALTER TABLE missions ADD COLUMN total_cost_usd REAL`);
if (!cols.includes('tokens_in')) db.exec(`ALTER TABLE missions ADD COLUMN tokens_in INTEGER`);
if (!cols.includes('tokens_out')) db.exec(`ALTER TABLE missions ADD COLUMN tokens_out INTEGER`);
if (!cols.includes('session_id')) db.exec(`ALTER TABLE missions ADD COLUMN session_id TEXT`);
// `summary_event_id` records the highest events.id covered by the summary so callers
// can detect stale summaries cheaply. Lineage: when fork-mission creates a
// continuation, point back to the source so the UI can render "continued from <id>"
// breadcrumbs. Per-mission LLM overrides. When set, these take precedence over the
if (!cols.includes('summary')) db.exec(`ALTER TABLE missions ADD COLUMN summary TEXT`);
if (!cols.includes('summary_at')) db.exec(`ALTER TABLE missions ADD COLUMN summary_at INTEGER`);
if (!cols.includes('summary_event_id')) db.exec(`ALTER TABLE missions ADD COLUMN summary_event_id INTEGER`);
// agent's config.json for every spawn turn of this
// mission — letting a fork stay on the
if (!cols.includes('forked_from')) db.exec(`ALTER TABLE missions ADD COLUMN forked_from TEXT`);
// same agent but switch backend/model (e.g. claude
// → codex at end-of-quota). NULL = use
// agent config as usual. Per-spawn skill/MCP injections. JSON arrays stored as TEXT so
// the dispatcher can add timon-task (or any skill) without touching the agent
if (!cols.includes('backend_override')) db.exec(`ALTER TABLE missions ADD COLUMN backend_override TEXT`);
if (!cols.includes('model_override')) db.exec(`ALTER TABLE missions ADD COLUMN model_override TEXT`);
// Name the user gave the mission from the list; NULL = show the task title or the brief.
if (!cols.includes('title')) db.exec(`ALTER TABLE missions ADD COLUMN title TEXT`);
// config.json. Per-mission cwd override. Lets the dispatcher run an agent in a task
// worktree instead of its usual cfg.cwd — the session stays attached to the agent
if (!cols.includes('extra_skills')) db.exec(`ALTER TABLE missions ADD COLUMN extra_skills TEXT`);
if (!cols.includes('extra_mcp_servers')) db.exec(`ALTER TABLE missions ADD COLUMN extra_mcp_servers TEXT`);
if (!cols.includes('extra_allowed_tools')) db.exec(`ALTER TABLE missions ADD COLUMN extra_allowed_tools TEXT`);
// (skills, system prompt) but sees
// the worktree filesystem. Per-mission permission_mode
// override. Same as model_override: NULL = use the agent's cfg.permission_mode;
if (!cols.includes('cwd_override')) db.exec(`ALTER TABLE missions ADD COLUMN cwd_override TEXT`);
// otherwise overwrite for every turn of the mission. Set by the dispatcher from the
// project role or the task override. Denormalised lineage: lets us trace the
// missions/tasks/routines graph without parsing source_meta on every query, and index
// parent/task. All null by default. Primary source remains source_channel/source_meta;
if (!cols.includes('permission_mode_override')) {
  db.exec(`ALTER TABLE missions ADD COLUMN permission_mode_override TEXT`);
}
// these columns are written from index.ts handleSpawn when the info is available.
// Librarian post-mortem: ms timestamp of when
// the librarian was spawned to extract this
// mission's lessons into the vault. Set AHEAD of the spawn to serve as an idempotent lock
if (!cols.includes('parent_mission_id')) db.exec(`ALTER TABLE missions ADD COLUMN parent_mission_id TEXT`);
if (!cols.includes('parent_agent')) db.exec(`ALTER TABLE missions ADD COLUMN parent_agent TEXT`);
if (!cols.includes('task_id')) db.exec(`ALTER TABLE missions ADD COLUMN task_id TEXT`);
if (!cols.includes('routine_id')) db.exec(`ALTER TABLE missions ADD COLUMN routine_id TEXT`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_missions_parent ON missions(parent_mission_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_missions_task ON missions(task_id)`);
// — a mission_complete retry (e.g. zombie sweep at boot) finds the flag set and does
// not re-spawn. MCP override: when set (JSON array), replaces cfg.mcp_servers instead
// of merging. NULL = legacy behaviour (merge with extra_mcp_servers). '[]' = zero MCP.
// Used by the dispatcher to force "zero MCP by default" on task missions. Mission-side
if (!cols.includes('documented_at')) db.exec(`ALTER TABLE missions ADD COLUMN documented_at INTEGER`);
// counterpart of `tasks.interrupted_reason`. Required because the cause is not always
// known at the moment the mission is finalised: an exit on usage limit leaves the
// mission `running` (the turn can resume when quota returns), and it is the reaper —
if (!cols.includes('mcp_servers_override')) db.exec(`ALTER TABLE missions ADD COLUMN mcp_servers_override TEXT`);

// several minutes later, with no in-memory state at
// all — that finalises it. So we mark
// the cause as soon as we observe it, and finalisation re-reads it. Also survives an
// orchestrator restart (the in-memory `running`
// registry, itself, does not). ── Curated
// memory: memory_rules enrichment for the LLM curator. status : active (injectable) |
// superseded (replaced, kept for history) | archived tier : core (foundational, ALWAYS
if (!cols.includes('interrupted_reason')) db.exec(`ALTER TABLE missions ADD COLUMN interrupted_reason TEXT`);
if (!cols.includes('reasoning_effort')) db.exec(`ALTER TABLE missions ADD COLUMN reasoning_effort TEXT`);
// Work return already delivered to the pilot for THIS TURN of the mission, the
// mission-level counterpart of `tasks.return_notified`. A mission WITHOUT a task
// (`mission_spawn` delegation) reports at the END OF ITS TURN (wake.ts,
// `handleMissionTurnComplete`), no longer at the death of its process — with a
// persistent backend that death only comes at the idle reap, up to
// TIMON_REAP_IDLE_MS (600 000 ms) later. Measured 11/09/2026: turn finished at
// 12:34, return delivered at 12:48. The flag closes the duplicate: once the return
// has gone out, the later `mission_complete` says nothing new and stays silent.
// Reset to 0 at the START of every turn (spawn, `timon send`): a mission relaunched
// in place owes a new return, one per turn and never two.
if (!cols.includes('return_notified')) db.exec(`ALTER TABLE missions ADD COLUMN return_notified INTEGER NOT NULL DEFAULT 0`);
// Where `title` came from (TODO #358): `manual` (the user renamed it), `preset`
// (the launcher named it at spawn), `native` (read from the CLI's own session)
// or `generated` (a one-shot at the end of the first turn). NULL = no title.
// The rank decides who may overwrite whom: manual and preset are never touched
// by native or generated. A title that predates the column was typed by the
// user — the only way one could exist — so it is marked `manual`.
// `title_generation` is the per-mission idempotence marker of the one-shot
// (same pattern as `tasks.return_notified`): 0 = never attempted, 1 = claimed.
// Claimed BEFORE the asynchronous generation starts, so a replayed turn or a
// second `turn_complete` never pays a second one-shot. Every mission that
// predates the column is marked claimed at once: the one-shot belongs to the
// first turn, which those missions have all had, and no backfill was decided
// (21/10/2026, quota) — resuming an old conversation must not pay for a title.
if (!cols.includes('title_source')) {
  db.exec(`ALTER TABLE missions ADD COLUMN title_source TEXT`);
  db.exec(`UPDATE missions SET title_source = 'manual' WHERE title IS NOT NULL AND TRIM(title) <> ''`);
}
if (!cols.includes('title_generation')) {
  db.exec(`ALTER TABLE missions ADD COLUMN title_generation INTEGER NOT NULL DEFAULT 0`);
  db.exec(`UPDATE missions SET title_generation = 1`);
}

// What a remote backend's driver keeps to find its session again after a daemon
// restart (`RemoteSessionHost.saveResume`). A table of its own rather than a
// `missions` column: mission rows are read with `SELECT *` and spread into API
// answers, and this opaque blob has no business reaching a browser. One row per
// live mission, deleted when the mission ends.
db.exec(`CREATE TABLE IF NOT EXISTS mission_remote_resume (
  mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`);

// A rewind waiting for the mission's next spawn (docs/specs/rewind.md § 8): the
// provider session the cut part was spoken in, and the `rewind` event. Its own
// table for the reason above: it never reaches an API answer.
db.exec(`CREATE TABLE IF NOT EXISTS mission_rewind_pending (
  mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
  session_id TEXT,
  rewind_event_id INTEGER NOT NULL
)`);

// What the opening of a mission's chat has folded so far (mission-history-page.ts).
// Derived from `events` and rebuilt from them when absent, so nothing backfills
// it. Written when a chat opens rather than per inserted event: the insert path
// runs for every streamed row, and most missions are never reopened.
db.exec(`CREATE TABLE IF NOT EXISTS mission_prelude_fold (
  mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  up_to INTEGER NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`);

// Phase M.1 — accounts and sessions. Additive: CREATE TABLE IF NOT EXISTS so a
// database that already has everything else keeps working. `is_superadmin` is a
// flag, not a role (`docs/MULTI-USER.md` §3). Sessions store a hash of the
// cookie value so a stolen row is not a stolen login.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

// T.2 — chrome preferences (theme plugin, layout plugin, light/dark). Not
// columns on `users`: prefs are not identity; a disabled account keeps
// them, an export carries them. No row = product defaults. user_id is
// never the empty string (unlike ui_layout.owner).
db.exec(`
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT PRIMARY KEY,
  theme TEXT NOT NULL,
  layout TEXT NOT NULL,
  scheme TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);
// TODO #358 — the account's own choice of the model that titles its
// conversations (`mission-title-model.ts`: `auto`, `off`, `<backend>:<model>`).
// NULL = the instance setting applies. Same table as the chrome: a preference,
// not identity; not a column of `UserPrefs`, which the browser reads at every
// `/api/auth/me` and mirrors in `app/src/lib/auth.ts`.
{
  const prefCols = (db.prepare(`PRAGMA table_info(user_prefs)`).all() as { name: string }[]).map((c) => c.name);
  if (!prefCols.includes('mission_title_model')) db.exec(`ALTER TABLE user_prefs ADD COLUMN mission_title_model TEXT`);
  // The account's favourite models (`users/model-favorites.ts`): a JSON array of
  // `{backend, model}`, kept here so the stars follow the account, not the browser.
  if (!prefCols.includes('model_favorites')) db.exec(`ALTER TABLE user_prefs ADD COLUMN model_favorites TEXT`);
  // The account's model presets for the series planner (`users/plan-presets.ts`):
  // a JSON array of `{id, name, roles, updatedAt}`, the account's like the stars.
  if (!prefCols.includes('plan_presets')) db.exec(`ALTER TABLE user_prefs ADD COLUMN plan_presets TEXT`);
  // The Timon theme became the default in 0.1.7 (the maintainer, 05/11/2026) without
  // changing anyone's screen: every account that exists when this column
  // appears gets a row holding the theme it had (the product theme, which no
  // row meant until then), marked `theme_kept = 1`. The backfill runs with
  // the ALTER only, so an account made afterwards — a fresh install's first
  // one included — has no row and gets the new default.
  if (!prefCols.includes('theme_kept')) {
    db.transaction(() => {
      db.exec(`ALTER TABLE user_prefs ADD COLUMN theme_kept INTEGER`);
      db.prepare(
        `INSERT INTO user_prefs (user_id, theme, layout, scheme, updated_at, theme_kept)
         SELECT id, '@timon/ui-theme', '@timon/ui-layout', 'dark', ?, 1 FROM users
         WHERE id NOT IN (SELECT user_id FROM user_prefs)`,
      ).run(Date.now());
    })();
  }
}

// The seven account tables (roles, groups, memberships, invitations) and
// `users.role_id` leave the core's schema: the plugin that serves the accounts
// keeps them (TODO #906). Their rows go to an owner-only file of the home
// first, for that plugin to read once; then they are dropped. A new install
// never had them, and a second open finds nothing left to move.
moveLegacyAccountTables(db, LEGACY_ACCOUNT_TABLES_FILE);

// Phase M.5 — per-mission (and plugin-job) API tokens. The listed columns
// are MULTI-USER.md §3; `expires_at` + `mission_id` are how a token dies
// with its mission (§6). `user_id` is nullable: a plugin job has no
// account, its identity is `scope = plugin:<id>`.
db.exec(`
CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT,
  label TEXT,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  mission_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_mission ON api_tokens(mission_id);
`);

// Remote MCP tokens (`remote-mcp/tokens.ts`): a separate table, not
// `api_tokens`, so the REST auth lookup can never find one. Bound to one
// mission and its agent, limited to listed tools, plaintext never stored.
db.exec(`
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  mission_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_mission ON mcp_tokens(mission_id);
`);

// Self-service profile — the avatar a user picks for themselves. Additive and
// nullable: an account without one falls back to its initials, so no backfill
// is needed. Holds the service URL of an upload, never the bytes.
{
  const userCols = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((c) => c.name);
  if (!userCols.includes('avatar_url')) {
    db.exec(`ALTER TABLE users ADD COLUMN avatar_url TEXT`);
  }
}

// The upgrade welcome (docs/ONBOARDING.md, section `Upgrade welcome`): every
// account that exists when this column appears was made by a version older
// than the new onboarding, so it is shown that onboarding once. `signin`: its
// sessions are dropped at its next `/api/auth/me` and it signs in again from
// the onboarding; `mascot`: signed in, it is offered its main agent's mascot;
// `NULL`: nothing to show. The backfill runs with the ALTER only, so an account
// created afterwards — a fresh install's first one included — stays `NULL`.
{
  const userCols = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((c) => c.name);
  if (!userCols.includes('welcome_stage')) {
    db.transaction(() => {
      db.exec(`ALTER TABLE users ADD COLUMN welcome_stage TEXT`);
      db.exec(`UPDATE users SET welcome_stage = 'signin'`);
    })();
  }
}

// Self-service email change. The new address is only written onto the account
// once the owner has proved they can read it, so the request lives here in the
// meantime. Same hashing rule as sessions and invitations: the plaintext token
// is handed out once and never stored.
db.exec(`
CREATE TABLE IF NOT EXISTS email_changes (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  new_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_email_changes_user ON email_changes(user_id);
CREATE INDEX IF NOT EXISTS idx_email_changes_expires ON email_changes(expires_at);`);
db.exec(`

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  at INTEGER NOT NULL,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
`);

// secu-9 — who acted when it was not a person: 'daemon' (daemon-token, i.e.
// the CLI or the dispatcher), 'api-token' (a spawned agent), NULL (a browser
// session). Added late, hence the ALTER: existing rows keep NULL.
{
  const cols = (db.prepare(`PRAGMA table_info(audit_log)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('actor')) db.exec(`ALTER TABLE audit_log ADD COLUMN actor TEXT`);
}

// Plugin API 10 — the origin of a secret a plugin created (`plugin:<id>`), so a
// plugin may rotate what it deposited and nothing else. NULL for every secret
// a person or an agent made, and for those that predate the column.
{
  const cols = (db.prepare(`PRAGMA table_info(secrets)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('created_by')) db.exec(`ALTER TABLE secrets ADD COLUMN created_by TEXT`);
}

// M.1c / M.3 — owned tables (`docs/MULTI-USER.md` §5). NULL = system row
// (jobs, pre-setup history): visible only with `:read:all`. Existing rows
// are attributed at first-user setup (`assignUnownedOwnedTo`).
{
  for (const table of OWNED_TABLES) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('owner_user_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN owner_user_id TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_owner ON ${table}(owner_user_id)`);
  }
}

// A workflow is piloted by an existing agent (decision of 20/10/2026): the
// column replaces the `workflow.<uuid>` agent the engine used to create for
// each workflow. NULL on rows minted before that: publish and run refuse them
// until the user assigns an agent from the builder.
{
  const cols = (db.prepare(`PRAGMA table_info(workflows)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('agent_name')) db.exec(`ALTER TABLE workflows ADD COLUMN agent_name TEXT`);
}

// injected) | normal (recall by relevance) supersedes : id of the rule this one
// replaces (non-destructive pointer) support : number of facts/missions backing the
// rule (inherited from cluster_size) ALTER ADD COLUMN with a default = metadata-only
// (safe even on a large DB). scope='role': JOB rule injected to every agent of that
// role (merger, orchestrator, coder…), across projects.
// `role` = the role id; `project`
const ruleCols = (db.prepare(`PRAGMA table_info(memory_rules)`).all() as { name: string }[]).map((c) => c.name);
if (!ruleCols.includes('status')) db.exec(`ALTER TABLE memory_rules ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
if (!ruleCols.includes('tier')) db.exec(`ALTER TABLE memory_rules ADD COLUMN tier TEXT NOT NULL DEFAULT 'normal'`);
if (!ruleCols.includes('supersedes')) db.exec(`ALTER TABLE memory_rules ADD COLUMN supersedes INTEGER`);
if (!ruleCols.includes('support')) db.exec(`ALTER TABLE memory_rules ADD COLUMN support INTEGER NOT NULL DEFAULT 1`);
// NULL = every project, otherwise limited to that project. Curator audit log: every
// decision (merge/supersede/new/reject) is traced and individually reversible (an
// after-the-fact veto only makes sense if we can undo ONE decision, not just read a
if (!ruleCols.includes('role')) db.exec(`ALTER TABLE memory_rules ADD COLUMN role TEXT`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_rules_status_tier ON memory_rules(status, tier, scope)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_rules_role ON memory_rules(role) WHERE scope='role'`);

// counter). best-effort. Project scoring (feeds the inter-project digest + the advisor
// advisor agent). `revenue_potential` (0-100) = estimated PASSIVE revenue potential
// from the objectives.md grid; auto by the night scorer UNLESS `revenue_locked=1`
db.exec(`
CREATE TABLE IF NOT EXISTS memory_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  run_id TEXT,
  scope TEXT,
  project TEXT,
  agent TEXT,
  action TEXT NOT NULL,          -- new | merge | supersede | reject | retier | rescope
  rule_id INTEGER,               -- rule created/affected
  target_rule_id INTEGER,        -- rule merged/replaced (if any)
  candidate_text TEXT,           -- text of the fact/candidate concerned
  rationale TEXT,
  reverted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_audit_run ON memory_audit(run_id);
`);

// (value set by hand by the user → the scorer no longer touches it). `progress` (0-100) =
// progress toward ship, itself always
// auto-estimable. `score_rationale` = 1-2 sentences
// justifying both. `score_updated_at` = last scorer pass (staleness gate: we only
// re-score if there is more recent activity). Column snapshot taken HERE (do not reuse
// an earlier snapshot). `grepai_watch` = intent
// to supervise the semantic index: 'auto'
// (default, NULL included) → reconciliation restarts the
const projectCols = (db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]).map((c) => c.name);
if (!projectCols.includes('revenue_potential')) db.exec(`ALTER TABLE projects ADD COLUMN revenue_potential INTEGER`);
if (!projectCols.includes('revenue_locked')) db.exec(`ALTER TABLE projects ADD COLUMN revenue_locked INTEGER NOT NULL DEFAULT 0`);
if (!projectCols.includes('progress')) db.exec(`ALTER TABLE projects ADD COLUMN progress INTEGER`);
if (!projectCols.includes('score_rationale')) db.exec(`ALTER TABLE projects ADD COLUMN score_rationale TEXT`);
if (!projectCols.includes('score_updated_at')) db.exec(`ALTER TABLE projects ADD COLUMN score_updated_at INTEGER`);
// watcher if it is dead; 'off' →
// The user stopped it by hand, we no longer touch it. Without this column, a stop from the
// UI would be undone by the next reconcile pass. `author` = who noted the idea (agent
// name, or `user` from the cockpit). Earlier rows stay NULL: we cannot rewrite history,
if (!projectCols.includes('grepai_watch')) db.exec(`ALTER TABLE projects ADD COLUMN grepai_watch TEXT`);
// `created_by` = `plugin:<id>` when a plugin registered the project (`ctx.projects.create`); NULL for every other project. Written by the facade only.
if (!projectCols.includes('created_by')) db.exec(`ALTER TABLE projects ADD COLUMN created_by TEXT`);

// the UI shows them as "unknown author"
// rather than wrongly attributing them. Web Push:
// device subscriptions (one per browser/device) + delivery trace. The endpoint is the
// `outbound_secret` signs what a trigger SENDS (its `webhook` action), apart
// from `secret`, which checks what it receives: whoever receives our calls
// must not be able to forge calls to us.
const triggerLaterCols = (db.prepare(`PRAGMA table_info(triggers)`).all() as { name: string }[]).map((c) => c.name);
if (!triggerLaterCols.includes('outbound_secret')) db.exec(`ALTER TABLE triggers ADD COLUMN outbound_secret TEXT`);
// `approved_at` = when a person last switched the trigger on (TODO #572). An
// agent's trigger keeps its `acting_agent` when the user only flips its switch,
// so that column alone no longer tells a consented one from one nobody looked at.
if (!triggerLaterCols.includes('approved_at')) db.exec(`ALTER TABLE triggers ADD COLUMN approved_at INTEGER`);
// Pipelines and their runs gain an owner for `ctx.pipelines` (a plugin sees what
// it created, a user what is theirs). Earlier pipelines stay NULL: shared system
// rows, readable and runnable by every account, changed by a superadmin only
// (TODO #797, `pipelines.ts`). An earlier run stays NULL too, read with `:read:all`.
// Remembered approvals (TODO #534). A rule without `command_hash` was written
// when a non-shell motif was the tool name alone, so it covers every file,
// address and input of that tool: no motif produces one any more, and those
// still here are dropped (their owner gets the card again, with what the new
// rule will cover). A `session` rule dies with its mission (`finishMission`);
// one left behind by a daemon that stopped before the mission ended goes here.
function pruneApprovalRules(): number {
  return db.prepare(`DELETE FROM approval_rules WHERE command_hash IS NULL`).run().changes
    + db.prepare(`DELETE FROM approval_rules WHERE scope = 'session'
        AND mission_id NOT IN (SELECT id FROM missions WHERE status = 'running')`).run().changes;
}
pruneApprovalRules();
const pipelineLaterCols = (db.prepare(`PRAGMA table_info(pipelines)`).all() as { name: string }[]).map((c) => c.name);
if (!pipelineLaterCols.includes('owner_user_id')) db.exec(`ALTER TABLE pipelines ADD COLUMN owner_user_id TEXT`);
const pipelineRunLaterCols = (db.prepare(`PRAGMA table_info(pipeline_runs)`).all() as { name: string }[]).map((c) => c.name);
if (!pipelineRunLaterCols.includes('owner_user_id')) db.exec(`ALTER TABLE pipeline_runs ADD COLUMN owner_user_id TEXT`);
// The plugin that started the run through `ctx.pipelines.run`, whoever owns its
// tasks: what its cap of runs at once counts (TODO #571).
if (!pipelineRunLaterCols.includes('plugin_id')) db.exec(`ALTER TABLE pipeline_runs ADD COLUMN plugin_id TEXT`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pipeline_runs_plugin ON pipeline_runs(plugin_id) WHERE plugin_id IS NOT NULL`);
const todoLaterCols = (db.prepare(`PRAGMA table_info(project_todo)`).all() as { name: string }[]).map((c) => c.name);
if (!todoLaterCols.includes('author')) db.exec(`ALTER TABLE project_todo ADD COLUMN author TEXT`);
// Promotion of an idea into a task (Kanban volet 3/4): ideas from before the column
// stay NULL, that is never promoted — which is what they are.
if (!todoLaterCols.includes('promoted_task_id')) db.exec(`ALTER TABLE project_todo ADD COLUMN promoted_task_id TEXT`);
// Tags (urgency + progress, closed vocabulary in project-todo-tags.ts). Older
// ideas stay NULL: untagged, shown as plain "todo" without a stored value.
if (!todoLaterCols.includes('urgency')) db.exec(`ALTER TABLE project_todo ADD COLUMN urgency TEXT`);
if (!todoLaterCols.includes('progress')) db.exec(`ALTER TABLE project_todo ADD COLUMN progress TEXT`);
// The outcome of an idea (resolution, public note, duplicate reference) moved
// to the `@timon/todo-outcomes` plugin, in its own table. The move runs here,
// whether the plugin is enabled or not, and renames the table it had under
// its former name: see `todo-outcome-migration.ts`.
migrateTodoOutcomeColumns(db);

// natural identity of a subscription (the browser provides a new one on every
// re-subscribe), hence the UNIQUE: a device
// that re-subscribes replaces its row instead
// of accumulating them. `p256dh` / `auth` are the client's public keys, not server
// secrets — they only encrypt the payload
// destined for THIS device. ── Full-text search
db.exec(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_label TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_error TEXT
);

-- Delivery idempotence at the (notification, subscription) TUPLE level: a
-- failure towards one device must never block delivery towards the others, and
-- a re-fan-out (restart, retry) must not re-notify a device already served.
CREATE TABLE IF NOT EXISTS push_deliveries (
  notification_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  status TEXT NOT NULL,          -- sent | failed | gone
  sent_at INTEGER NOT NULL,
  error TEXT,
  PRIMARY KEY (notification_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_push_deliveries_sub ON push_deliveries(subscription_id);
`);

// in mission history ───────────────────────────────────── `mission_search` holds the
// USEFUL text extracted from missions (initial
// prompt + `text` blocks of assistant/user
// events); `mission_search_fts` is its external-content FTS5 index, synced by triggers
// — same setup as `memory_rules_fts`, which is the implementation reference.
//
// Why a derived table rather than FTS directly on `events`: event payloads weigh 1.3
// GB, of which 1 GB is `tool_result` which is never what we look for when searching a
// conversation. The actually useful text fits in 19 MB (measured 2026-08-23 on the maintainer's
// database). Indexing the raw table would mean paying 70× the space to degrade
// relevance.
//
// `seq` = rank of the fragment in its event (a message can carry several `text`
// blocks). The (event_id, seq) key makes re-indexing idempotent; event_id NULL = the
// mission's initial prompt.
db.exec(`
CREATE TABLE IF NOT EXISTS mission_search (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  event_id INTEGER,
  seq INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL,            -- prompt | assistant | user
  ts INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mission_search_mission ON mission_search(mission_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_search_event ON mission_search(event_id, seq)
  WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_search_prompt ON mission_search(mission_id)
  WHERE event_id IS NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS mission_search_fts USING fts5(
  text,
  content='mission_search',
  content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS mission_search_ai AFTER INSERT ON mission_search BEGIN
  INSERT INTO mission_search_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS mission_search_ad AFTER DELETE ON mission_search BEGIN
  INSERT INTO mission_search_fts(mission_search_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS mission_search_au AFTER UPDATE ON mission_search BEGIN
  INSERT INTO mission_search_fts(mission_search_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO mission_search_fts(rowid, text) VALUES (new.id, new.text);
END;

-- Catch-up cursor: id of the last event already passed to the indexer. Without
-- it the index would only cover missions AFTER its deployment, and a search on
-- history — the whole point of the feature — would return zero results without
-- saying so.
CREATE TABLE IF NOT EXISTS mission_search_state (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
`);

// Per-mission aggregates of `events`, kept by triggers in the same transaction
// as the event insert. The mission list read them per row with subqueries over
// the events table: on a 2.2M-event home, MAX(timestamp) alone cost ~45 ms for
// a 300-row page, and better-sqlite3 holds the whole daemon while it runs.
// Monotonic: they count what was ever written, an archived event included.
//
// `ready = 0`: a mission that predates the table. Its row only carries the
// events written since it was seeded (`id > backfill_upto`); mission-stats.ts
// folds the older ones in, chunk by chunk, then flips `ready`. Readers fall
// back to the subqueries until then. A mission created now starts ready.
db.exec(`
CREATE TABLE IF NOT EXISTS mission_stats (
  mission_id TEXT PRIMARY KEY,
  ready INTEGER NOT NULL DEFAULT 1,
  backfill_cursor INTEGER NOT NULL DEFAULT 0,
  backfill_upto INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  last_event_at INTEGER,
  last_result_id INTEGER,
  last_user_id INTEGER,
  last_result_model TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_mission_stats_pending ON mission_stats(ready) WHERE ready = 0;
CREATE TRIGGER IF NOT EXISTS mission_stats_on_mission AFTER INSERT ON missions BEGIN
  INSERT OR IGNORE INTO mission_stats (mission_id) VALUES (new.id);
END;
`);
// `last_result_id` answers "has the turn ended?" for the mission list, hence not
// on the `result` of a turn a steer stopped (same rule as `missionTurnEnded`).
// The backfill and the list's fallback need no such test: they read events older
// than this table, and the steer mark is younger than it.
export const MISSION_STATS_EVENT_TRIGGER = `CREATE TRIGGER mission_stats_on_event AFTER INSERT ON events BEGIN
  UPDATE mission_stats SET
    event_count = event_count + 1,
    last_event_at = CASE WHEN last_event_at IS NULL OR new.timestamp > last_event_at
                         THEN new.timestamp ELSE last_event_at END,
    last_result_id = CASE WHEN new.type = 'result' AND NOT (${steeredResultSql('new.payload')})
                          THEN new.id ELSE last_result_id END,
    last_user_id = CASE WHEN new.type = 'user' THEN new.id ELSE last_user_id END,
    last_result_model = CASE WHEN new.type = 'result' THEN ${resultModelSql('new.payload')}
                             ELSE last_result_model END
  WHERE mission_id = new.mission_id;
END`;
// `IF NOT EXISTS` would keep the body an older version installed. Compared first
// so that a normal boot does not rewrite the schema.
if ((db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'mission_stats_on_event'`)
  .get() as { sql: string } | undefined)?.sql !== MISSION_STATS_EVENT_TRIGGER) {
  db.transaction(() => {
    db.exec(`DROP TRIGGER IF EXISTS mission_stats_on_event`);
    db.exec(MISSION_STATS_EVENT_TRIGGER);
  })();
}

// Phase W.0 — traceability (docs/PRD-WORKFLOWS.md §3). `trace_id` is the causal
// root shared by a mission, everything it spawns, the tasks it creates and the
// messages it sends. A mission that nothing precedes is its own root. The two
// `workflow_*` columns name the workflow node that spawned the mission; NULL
// outside a workflow run. All additive: existing rows are backfilled at boot
// (trace-backfill.ts), never rewritten by a migration.
if (!cols.includes('trace_id')) db.exec(`ALTER TABLE missions ADD COLUMN trace_id TEXT`);
if (!cols.includes('workflow_run_id')) db.exec(`ALTER TABLE missions ADD COLUMN workflow_run_id TEXT`);
if (!cols.includes('workflow_node_id')) db.exec(`ALTER TABLE missions ADD COLUMN workflow_node_id TEXT`);
if (!cols.includes('browser_profile_id')) db.exec(`ALTER TABLE missions ADD COLUMN browser_profile_id TEXT`);
if (!cols.includes('browser_profile_resolved')) db.exec(`ALTER TABLE missions ADD COLUMN browser_profile_resolved INTEGER NOT NULL DEFAULT 0`);
// A person wrote in this mission, or it carries on a person's conversation
// (a `wake` that resumed their session): the origin then reads `user`, even on
// a mission the machine started (`mission-origin.ts`).
if (!cols.includes('user_engaged')) db.exec(`ALTER TABLE missions ADD COLUMN user_engaged INTEGER NOT NULL DEFAULT 0`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_missions_trace ON missions(trace_id)`);
// The run view reads the missions of one run on every refresh (listSpansByRun).
// Partial: outside workflows the column stays NULL, which is almost every row.
db.exec(`CREATE INDEX IF NOT EXISTS idx_missions_workflow_run ON missions(workflow_run_id) WHERE workflow_run_id IS NOT NULL`);
// /api/agents/active is polled every few seconds by every open window: its
// `status = 'running' OR ended_at >= ?` filter must stay an index lookup,
// never a scan of the whole missions table.
db.exec(`CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_missions_ended ON missions(ended_at)`);
// The mission list pages by `started_at DESC`: without it, every poll sorted
// the whole table, brief text included, in a temp B-tree.
db.exec(`CREATE INDEX IF NOT EXISTS idx_missions_started ON missions(started_at)`);
// /api/stats (dashboard, every 5 s) filters events by a time window three
// times: without this index each one scanned the whole table — ~0.6 s on a
// 1M-event home, with the event loop frozen. `mission_id` makes it covering
// for the per-agent join.
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp, mission_id)`);
/** Id of the `rewind` event that hid this row from the thread (docs/specs/rewind.md
 *  § 9): rows are hidden, never deleted. Added before the chat view index, whose
 *  condition reads it. */
function ensureRewoundByColumn(schema: 'main' | 'archive'): void {
  const eventCols = (db.prepare(`PRAGMA ${schema}.table_info(events)`).all() as { name: string }[]).map((c) => c.name);
  if (!eventCols.includes('rewound_by')) db.exec(`ALTER TABLE ${schema}.events ADD COLUMN rewound_by INTEGER`);
}
ensureRewoundByColumn('main');
/**
 * Partial index of the chat view's rows (docs/MISSION-HISTORY-PAGES.md § 8).
 * `idx_events_mission` holds every row, and 61 % of them are per-token noise
 * (`thinking_tokens` is `type = 'system'`, so a `type` column in the index
 * cannot tell it from an `init`): a tail page or a prelude scan of a 100 000-row
 * mission walked them all, 37 to 170 ms per opening with the daemon blocked.
 * SQLite picks this index for any query whose WHERE carries `CHAT_VIEW_SQL`
 * verbatim, so the readers add that condition and nothing else.
 */
export const CHAT_VIEW_INDEX = 'idx_events_mission_chat';

/**
 * Creates the index, or rebuilds it when its condition is not today's
 * `CHAT_VIEW_SQL`: an index left on an older condition would no longer match
 * the queries, which would silently fall back to the full index.
 */
export function ensureChatViewIndex(schema: 'main' | 'archive'): void {
  const existing = db.prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type = 'index' AND name = ?`)
    .get(CHAT_VIEW_INDEX) as { sql: string | null } | undefined;
  if (existing?.sql?.endsWith(` WHERE ${CHAT_VIEW_SQL}`)) return;
  const started = Date.now();
  if (existing) db.exec(`DROP INDEX ${schema}.${CHAT_VIEW_INDEX}`);
  // Built once, over the whole table: a few seconds on a home of millions of
  // events, which is why it says so.
  db.exec(`CREATE INDEX ${schema}.${CHAT_VIEW_INDEX} ON events(mission_id, id) WHERE ${CHAT_VIEW_SQL}`);
  const elapsed = Date.now() - started;
  if (elapsed >= 1000) console.log(`[db] ${schema}.${CHAT_VIEW_INDEX} built in ${elapsed} ms`);
}

ensureChatViewIndex('main');
if (!taskCols.includes('trace_id')) db.exec(`ALTER TABLE tasks ADD COLUMN trace_id TEXT`);
// TO DO notebook idea this task implements (`project_todo.id`). Set on the ROOT
// task of a chain only: review, repair iterations, merge and doc never copy it —
// the closure (todo-closure.ts) walks back to the root. No foreign key: an idea
// deleted afterwards just leaves a dangling number that closes nothing.
if (!taskCols.includes('todo_id')) db.exec(`ALTER TABLE tasks ADD COLUMN todo_id INTEGER`);
// The closure counts the sibling chains of an idea before closing it (TODO #462).
db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_todo_id ON tasks(todo_id)`);
// Short human-facing summary the agent gives when it closes the task (1-2
// sentences). Shown on the return card in the chat; `done_comment` stays the
// full report for the pilot. Rewritten on every close, NULL when absent.
if (!taskCols.includes('done_summary')) db.exec(`ALTER TABLE tasks ADD COLUMN done_summary TEXT`);
// First dispatch of the task (TODO #424): set once, never cleared, so a requeue
// or a restart of the same task does not announce it a second time. Tasks that
// already ran when this column appeared are stamped with their last move, or a
// task BLOCKED then restarted after the upgrade would sound like a new start.
if (!taskCols.includes('started_at')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN started_at INTEGER`);
  db.exec(`UPDATE tasks SET started_at = updated_at
           WHERE started_at IS NULL AND (status <> 'PENDING' OR mission_id IS NOT NULL OR requeue_count > 0)`);
}
// Task the orchestrator created in reaction to another (review, merge, doc,
// repair iteration): the start of such a follow-up is not announced.
if (!taskCols.includes('parent_task_id')) db.exec(`ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`);
const msgCols = (db.prepare(`PRAGMA table_info(agent_messages)`).all() as { name: string }[]).map((c) => c.name);
if (!msgCols.includes('trace_id')) db.exec(`ALTER TABLE agent_messages ADD COLUMN trace_id TEXT`);
// Who raised a card in a conversation: the mission's agent (default) or a third-party
// plugin (`ctx.layout`, `ctx.chat`, API 10). A plugin's card is never delivered to the
// agent, and its `agent` column carries `plugin:<id>` instead of the agent's name.
for (const table of ['layout_proposals', 'command_requests']) {
  const cardCols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!cardCols.includes('origin_kind')) db.exec(`ALTER TABLE ${table} ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'agent'`);
  if (!cardCols.includes('origin_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN origin_id TEXT`);
}

// One span per unit of work inside a mission (turn, tool call, permission,
// spawn…). `events` stays the raw truth; a span points at its events through
// `event_id_start` / `event_id_end`. `id` is the backend's tool_use_id when
// there is one, so a close operation needs no lookup.
db.exec(`
CREATE TABLE IF NOT EXISTS trace_spans (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  parent_span_id TEXT,
  workflow_run_id TEXT,
  workflow_node_id TEXT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  input TEXT,
  output TEXT,
  error TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  event_id_start INTEGER,
  event_id_end INTEGER,
  FOREIGN KEY (mission_id) REFERENCES missions(id)
);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON trace_spans(trace_id, started_at);
CREATE INDEX IF NOT EXISTS idx_spans_mission ON trace_spans(mission_id, seq);
-- Covers the per-mission aggregates of the mission list (span_tools,
-- span_errors, duration_ms) without touching the wide span rows.
CREATE INDEX IF NOT EXISTS idx_spans_mission_agg ON trace_spans(mission_id, kind, status, duration_ms);
CREATE INDEX IF NOT EXISTS idx_spans_run ON trace_spans(workflow_run_id, workflow_node_id, started_at);
CREATE INDEX IF NOT EXISTS idx_spans_open ON trace_spans(status) WHERE status = 'running';
-- What the spans removed by retention weighed, per mission. A list that reads
-- tools, errors and duration in trace_spans would otherwise show 0 for every
-- old mission. Its own table, not mission_stats: that row's lifecycle belongs to
-- the event trigger and its backfill, and a legacy mission may not have one yet.
CREATE TABLE IF NOT EXISTS mission_span_totals (
  mission_id TEXT PRIMARY KEY,
  spans INTEGER NOT NULL,
  tools INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_usd REAL NOT NULL
) WITHOUT ROWID;
`);

export {
  SPAN_KINDS, SPAN_STATUSES,
  type SpanKind, type SpanStatus, type SpanOpenOp, type SpanCloseOp, type SpanOp,
} from './backends/span-types.js';
import type { SpanKind, SpanOp, SpanStatus } from './backends/span-types.js';
import type { MessageKind, MessageStatus } from './plugins/contract/messages.js';
import type { TaskType as ContractTaskType } from './plugins/contract/tasks.js';
import type { Assert, Equals } from './type-equality.js';
import type { NotificationType } from './plugins/contract/notifications.js';
import type { LayoutProposalStatus, CommandRequestStatus } from './plugins/contract/layout.js';
import type { UiDocumentStatus, UiDocumentOriginKind, UiDocumentBridge } from './plugins/contract/ui-documents.js';
export type { UiDocumentStatus, UiDocumentOriginKind, UiDocumentBridge } from './plugins/contract/ui-documents.js';
export type { LayoutProposalStatus, CommandRequestStatus } from './plugins/contract/layout.js';
export type { NotificationType } from './plugins/contract/notifications.js';
export type { MessageKind, MessageStatus } from './plugins/contract/messages.js';

export type SpanRow = {
  /** Backend tool_use_id when there is one, otherwise a uuid. */
  id: string;
  trace_id: string;
  mission_id: string;
  /** Enclosing turn, or the workflow node. */
  parent_span_id: string | null;
  workflow_run_id: string | null;
  workflow_node_id: string | null;
  /** Order inside the mission (starting events.id). */
  seq: number;
  kind: SpanKind;
  /** 'Read', 'Bash', 'mcp__notes__search', 'turn', 'ask_user'… */
  name: string;
  status: SpanStatus;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  /** Truncated JSON (TIMON_TRACE_SPAN_MAX_BYTES). */
  input: string | null;
  output: string | null;
  error: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  /** Bridge to the raw events. */
  event_id_start: number | null;
  event_id_end: number | null;
};


/** Status of an embedded browser. Only two values: the container is running,
 *  or it no longer exists. No "paused" state — closing is explicit
 *  (`docker stop` + `rm`), the on-disk profile being what carries continuity
 *  between two sessions. */
export type BrowserSessionStatus = 'running' | 'stopped';

export type TeamRow = {
  id: string;
  /** Creator account. Non-privileged viewers only see and edit their own. */
  owner_user_id: string | null;
  name: string;
  /** Free CSS colour used by the UI to tint the team's bots. */
  color: string | null;
  created_at: number;
};

export type BrowserSessionRow = {
  /** project slug — primary key: one browser per project, no more */
  project: string;
  container_name: string;
  /** CDP port published on 127.0.0.1 ONLY (range 9300-9399) */
  cdp_port: number;
  /** container web port (Selkies client), routed by Traefik, not published.
   *  The `novnc_port` column name remains from the original setup. */
  novnc_port: number;
  status: BrowserSessionStatus;
  started_at: number | null;
  stopped_at: number | null;
  /** Last activity signal (agent usage, detected navigation, connected spectator).
   *  NULL = never bumped since the current start. */
  last_used_at: number | null;
  /** JSON `{url,title}[]` captured before the last stop, or NULL — consumed
   *  on the next start. See `parseStoredTabs` in browser-sessions.ts. */
  open_tabs: string | null;
  owner_user_id: string | null;
};

export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED';

/**
 * Accepts `TODO` on the way IN as a DEPRECATED alias of `PENDING`, so that the
 * missions and skills already in flight when the rename landed keep working.
 * Nothing ever renders `TODO` back out — the alias is one-way and temporary.
 *
 * Anything else passes through untouched on purpose: this is a translation,
 * not a validator. Turning an unknown status into `undefined` here would turn
 * "writes garbage" into "silently changes nothing", which is worse.
 */
export function normalizeTaskStatusInput<T extends string | undefined>(status: T): T {
  return (status === 'TODO' ? 'PENDING' : status) as T;
}

/**
 * Follow-up chaining state of a task (`chain_ran` column).
 *
 * Three values, not two: with a boolean, a chain killed in flight (SIGTERM,
 * OOM, orchestrator restart) left the flag set without producing anything,
 * and reconcile — which only resumed the `0`s — never saw it again. An old
 * `CHAIN_RUNNING` is therefore treated as a chain to replay, not as a chain
 * in progress.
 */
export const CHAIN_NEVER = 0;
export const CHAIN_RUNNING = 1;
export const CHAIN_DONE = 2;
/** Terminal failure state: the chain exhausted its attempts (MAX_CHAIN_ATTEMPTS,
 *  task-chain.ts) and the user was alerted. Excluded from replay just like
 *  CHAIN_DONE — otherwise a deterministic failure loops until the 6 h window
 *  expires. This is an EXPLICIT, notified abandonment, not an oversight. */
export const CHAIN_FAILED = 3;
export type TaskChainState =
  | typeof CHAIN_NEVER
  | typeof CHAIN_RUNNING
  | typeof CHAIN_DONE
  | typeof CHAIN_FAILED;

/**
 * Past this delay, a `CHAIN_RUNNING` is no longer a chain in progress but a
 * chain dead in flight. Upper bound of what a healthy chain can take: its
 * slowest await is the verification-loop `git diff --stat`, 5 s timeout. Five
 * minutes leave two orders of magnitude of slack while staying well under the
 * catch-up window (6 h).
 */
export const CHAIN_STALE_MS = 5 * 60 * 1000;

export const TASK_TYPES = ['code', 'review', 'merge', 'research', 'doc', 'chore'] as const;
export type TaskType = (typeof TASK_TYPES)[number];
/** The public contract spells this list out; compilation fails if they part. */
type _TaskTypesMatchContract = Assert<Equals<TaskType, ContractTaskType>>;

export function isTaskType(v: unknown): v is TaskType {
  return typeof v === 'string' && (TASK_TYPES as readonly string[]).includes(v);
}

/** Accepted values for `tasks.pipeline` (null = 'full'). Validated at the API
 *  boundary: an unknown value that slipped through would silently disable the
 *  review. */
export const PIPELINES = ['full', 'code-self', 'code-group'] as const;

export type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  agent_name: string;
  status: TaskStatus;
  priority: number;
  deps: string;
  mission_id: string | null;
  created_at: number;
  updated_at: number;
  scheduled_at: number | null;
  blocked_reason: string | null;
  done_comment: string | null;
  extra_skills: string | null;
  extra_mcp_servers: string | null;
  extra_allowed_tools: string | null;
  type: TaskType;
  worktree_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  merged_commit_sha: string | null;
  backend_override: string | null;
  model_override: string | null;
  fallback_backend_override: string | null;
  fallback_model_override: string | null;
  permission_mode_override: string | null;
  routine_id: string | null;
  /** Native trigger that created the task (TODO #216), null otherwise. */
  trigger_id: string | null;
  iteration: number;
  verification_root_id: string | null;
  group_id: string | null;
  /** Group of volets in the series plan (see migration). NULL = no group. */
  plan_group: string | null;
  group_notified: number;
  /** see migration: work return already delivered to the pilot for the current
   *  execution (anti-double-wake). */
  return_notified: number;
  /** see migration: 1 = the work return never goes up to the pilot. */
  silent_return: number;
  /** see migration: 1 = inert image of an external ticket, never dispatched. */
  mirror: number;
  /** see migration: follow-up chaining state for the current execution
   *  (anti-double-chain AND detection of chains dead in flight). */
  chain_ran: TaskChainState;
  /** see migration: instant of the transition to `CHAIN_RUNNING`. NULL until the
   *  chain has ever started. */
  chain_started_at: number | null;
  /** Chaining attempts consumed (see MAX_CHAIN_ATTEMPTS, task-chain.ts). */
  chain_attempts: number;
  /** Orchestrator mission that drives the task NOW (may change). */
  creator_mission_id: string | null;
  /** STABLE identity of the project (= the first pilot mission). Never changes,
   *  unlike `creator_mission_id`. see migration. */
  series_id: string | null;
  /** cf. migration ci-dessus : null | 'full' | 'code-self' | 'code-group'. */
  pipeline: string | null;
  /** Explicit project slug; NULL → derived from the agent. see taskProjectSlug. */
  project: string | null;
  /** System death cause (see InterruptionReason). NULL when the task was closed
   *  by the agent — that is what distinguishes a business block from a mission
   *  killed in flight. */
  interrupted_reason: string | null;
  /** Automatic requeues already consumed after a system death.
   *  DEDICATED counter — do not confuse with `iteration` (verification loop),
   *  see this column's migration. */
  requeue_count: number;
  /** Reopening the provider announced for the quota that blocked this task, in
   *  epoch ms. NULL = none announced, or the task is not blocked by a quota. */
  quota_resets_at?: number | null;
  /** Deaths requalified as `rate_limit` with no quota word in their own stream,
   *  see `MAX_BLIND_QUOTA_DEATHS`. */
  blind_quota_deaths?: number;
  reasoning_effort: string | null;
  /** Owning account (`docs/MULTI-USER.md` §5). NULL = system / unattributed. */
  owner_user_id: string | null;
  /** Causal root, from the creator mission. NULL when no mission created it. */
  trace_id: string | null;
  /** TO DO notebook idea this task implements; closed when its chain lands
   *  (todo-closure.ts). NULL = no idea attached. */
  todo_id: number | null;
  /** Human-facing summary given at close (see migration). NULL = none. */
  done_summary: string | null;
  /** First dispatch (see migration). NULL = never started. */
  started_at: number | null;
  /** Task this one follows, when the orchestrator created it (see migration). */
  parent_task_id: string | null;
};

/**
 * Ceiling of automatic requeues after a system death. Same value as the other
 * recovery loops (verification-loop, merge-integrity): after 3 attempts it is
 * no longer a fluke but a stable problem, and insisting costs more than calling
 * a human.
 */
export const MAX_SYSTEM_REQUEUES = 3;

/**
 * System deaths past which nothing but a human restarts the task (TIM-0065).
 * Past `MAX_SYSTEM_REQUEUES` the task is blocked and its pilot woken; an agent
 * may still requeue it once it changed something (agent, backend, model), and
 * this second budget is what keeps a pilot and a dying mission from replaying
 * each other forever. A human restart clears the count.
 */
export const CRASH_LOOP_HARD_CEILING = 2 * MAX_SYSTEM_REQUEUES;

/**
 * Deaths of one task read as a quota wall on the exclusion alone, with nothing
 * about quota in the mission's own stream (TODO #724). A real crash looks the
 * same: a CLI that reports no limit exits just as silently, so nothing tells the
 * two apart, and a `rate_limit` costs no requeue. Past this, the death keeps the
 * cause it was given and the crash-loop budget applies. Same patience as that
 * budget, for the same reason: past 3 it is no longer a fluke.
 */
export const MAX_BLIND_QUOTA_DEATHS = MAX_SYSTEM_REQUEUES;

/** Outcome of `setTaskInterrupted`. `escalated` = retry cap reached, to be
 *  raised to a human; `blocked` = ordinary qualified blockage. */
/** Why `deleteTask` kept a task. `chain`: the task is the root of a verification
 *  chain, whose children point at it through `verification_root_id` and never
 *  through `deps` — told apart from `dependents` so the refusal does not ask the
 *  user to remove a dependency that `deps` does not show (TIM-0078). */
export type TaskDeleteResult =
  | 'deleted' | 'not_found' | 'forbidden' | 'state' | 'dependents' | 'chain' | 'mission' | 'worktree' | 'pipeline';

export type TaskDeleteOutcome = {
  result: TaskDeleteResult;
  /** The task the refusal is about: the one asked for, or the chain member holding the chain back. */
  taskId: string;
  /** What keeps the task alive: its explicit dependents, or the rest of its chain. */
  blockers: TaskRow[];
  /** Every task a chain deletion covers, root included (just the task when it heads no chain). */
  chain: string[];
};

export type TaskInterruptionOutcome = 'requeued' | 'blocked' | 'escalated' | 'noop';

/** "Code-only" pipelines: no auto review, no auto doc. Any other value —
 *  including null, 'full' and any typo — falls back to the full pipeline.
 *  Fail-safe: a guard is only disabled on an explicitly recognised value. */
export function isCodeOnlyPipeline(pipeline: string | null | undefined): boolean {
  return pipeline === 'code-self' || pipeline === 'code-group';
}

/** The coder integrates their own branch: the `merged_commit_sha` guard applies
 *  to the `code` task itself (otherwise nothing detects a never-merged branch —
 *  see incident 2026-05-25). */
export function isSelfMergePipeline(pipeline: string | null | undefined): boolean {
  return pipeline === 'code-self';
}

export type MissionRow = {
  /** Frozen browser assignment. Null with resolved=1 explicitly disables browsing. */
  browser_profile_id: string | null;
  browser_profile_resolved: number;
  id: string;
  agent_name: string;
  mission: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  source_channel: string | null;
  source_meta: string | null;
  total_cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  session_id: string | null;
  summary: string | null;
  summary_at: number | null;
  summary_event_id: number | null;
  forked_from: string | null;
  backend_override: string | null;
  model_override: string | null;
  extra_skills: string | null;
  extra_mcp_servers: string | null;
  extra_allowed_tools: string | null;
  cwd_override: string | null;
  permission_mode_override: string | null;
  parent_mission_id: string | null;
  parent_agent: string | null;
  task_id: string | null;
  routine_id: string | null;
  documented_at: number | null;
  mcp_servers_override: string | null;
  /** Observed system death cause (see InterruptionReason), NULL otherwise. */
  interrupted_reason: string | null;
  reasoning_effort: string | null;
  /** Display name, NULL when the mission has none. Who set it is `title_source`. */
  title: string | null;
  /** Where `title` came from (`mission-titles.ts`): manual > preset > native > generated. NULL = no title. */
  title_source: MissionTitleSource | null;
  /** 1 once the one-shot title generation has been claimed for this mission (never twice). */
  title_generation: number;
  /** Work return already delivered to the pilot for the current turn. */
  return_notified: number;
  /** Owning account (`docs/MULTI-USER.md` §5). NULL = system / unattributed. */
  owner_user_id: string | null;
  /** Causal root (PRD workflows §3.1). Own id when nothing precedes the
   *  mission; non-null after boot backfill and after spawn. */
  trace_id: string | null;
  /** Workflow node that spawned the mission. NULL outside a workflow run. */
  workflow_run_id: string | null;
  workflow_node_id: string | null;
};

/** MissionRow + joins for UI listings: title/type of the Kanban task that spawned
 *  the mission, and timestamp of the last event (max on events.timestamp). Used
 *  by GET /api/missions so the UI can sort by last activity and show the Kanban
 *  role. */
export type ActiveMissionRow = Pick<
  MissionRow,
  'id' | 'agent_name' | 'status' | 'started_at' | 'ended_at' | 'source_channel' | 'task_id'
>;
export type MissionListRow = MissionRow & {
  /** Who started it — `mission-origin.ts`. */
  origin: MissionOrigin;
  task_title: string | null;
  task_type: TaskType | null;
  last_event_at: number | null;
  /** Event aggregates (`mission_stats`, or the events table while not backfilled). */
  event_count: number;
  last_result_id: number | null;
  last_user_id: number | null;
  /** 1 when `last_result_model` is authoritative; 0 = ask `getLastResultModel`. */
  stats_ready: number;
  last_result_model: string | null;
  span_tools: number;
  span_errors: number;
  duration_ms: number;
  /** Owner's display fields, joined on `users` (null: no owner, or user gone). */
  owner_name: string | null;
  owner_avatar_url: string | null;
};

/** A row of `listLatestMissionCandidates`. */
export type LatestMissionCandidate = {
  id: string;
  agent_name: string;
  status: string;
  started_at: number;
  source_channel: string | null;
  last_event_at: number | null;
};

/** Who a mission belongs to, as the UI shows it (TIM-0118). */
export type MissionOwner = { id: string; name: string; avatar_url: string | null };

/** A conversation fragment found by `dbApi.searchMissions`, enriched with enough
 *  to reopen the mission in one click (agent, task, status) without a second call. */
export type MissionSearchHit = {
  mission_id: string;
  role: 'prompt' | 'assistant' | 'user';
  ts: number;
  event_id: number | null;
  agent_name: string;
  status: string;
  started_at: number;
  mission: string;
  task_id: string | null;
  task_title: string | null;
  snippet: string;
};

/**
 * Death cause derived from a mission's events (see
 * `dbApi.detectMissionDeathSignal`). The rate_limit variant says WHEN the quota
 * reopens, which is when the task leaves again (`tasks.quota_resets_at`).
 */
export type MissionDeathSignal =
  // `pending`: the request was queued and nothing came after it. The stream only
  // said "paused", so no exclusion was recorded while the turn could still succeed.
  | { reason: 'rate_limit'; rateLimitType: string | null; resetsAt: number | null; pending?: boolean }
  // No window, no reopening time, and that is the whole point: an account with
  // no credit left announces nothing because nothing reopens by itself.
  | { reason: 'exhausted' }
  // A model at capacity: the provider says which model, never for how long.
  | { reason: 'overloaded' }
  | { reason: 'permission_denied' };

/**
 * The quota a mission was still waiting on when it ended: a queued request, a
 * reopening still ahead, and nothing after it to say the provider served it
 * (TIM-0134). `events` are newest first.
 *
 * Queueing alone is no cause of death (`bestRateLimit`), since the turn can still
 * succeed. A mission that ended there never got that far, and the reaper comes
 * minutes later with `killed` or `timeout`, causes that replay the task into the
 * same wall and count against its budget. No time window here, unlike the
 * rejected case: what proves the wait is over is the stream moving on, and
 * output with no turn behind it (status, init) is not that.
 */
function queuedQuotaWall(events: ReadonlyArray<{ type: string; payload: unknown }>): RateLimitHit & { resetsAt: number } | null {
  for (const ev of events) {
    if (ev.type === 'assistant') return null;
    if (ev.type === 'result' && (ev.payload as { is_error?: unknown } | null)?.is_error !== true) return null;
    const hit = rateLimitFromEvent(ev.type, ev.payload);
    // Any other status of the dedicated event means the limit no longer applies.
    if (!hit && ev.type === 'rate_limit_event') return null;
    if (!hit) continue;
    return hit.pending && hit.kind === 'rate_limit' && hit.resetsAt !== null && hit.resetsAt > Date.now()
      ? { ...hit, resetsAt: hit.resetsAt }
      : null;
  }
  return null;
}

/** Number of events re-read from the end of the mission. Large enough to cover
 *  the burst of a last turn, short enough to stay O(1). */
const DEATH_SIGNAL_SCAN = 30;
/** A signal only counts if it is contemporaneous with the mission's last event
 *  (see detectMissionDeathSignal for the measurements that fix this threshold). */
const DEATH_SIGNAL_WINDOW_MS = 60_000;

export type EventRow = {
  id: number;
  mission_id: string;
  type: string;
  timestamp: number;
  payload: string;
};

export type PipelineRow = {
  id: string;
  name: string;
  description: string | null;
  definition: string;
  /** The account (or `plugin:<id>`) that created it; NULL = made before owners existed. */
  owner_user_id?: string | null;
  created_at: number;
  updated_at: number;
};
export type PipelineRunRow = {
  id: string;
  pipeline_id: string;
  input_payload: string | null;
  /** Whose tasks the run opened. */
  owner_user_id?: string | null;
  /** The plugin that started it (`ctx.pipelines.run`); null from the app, the CLI or an agent. */
  plugin_id?: string | null;
  started_at: number;
};
export type PipelineRunStepRow = {
  run_id: string;
  step_id: string;
  task_id: string;
};

export type WorkflowRow = { id: string; slug: string; name: string; description: string | null; project: string | null; owner_user_id: string | null; draft: string; published_version: number | null; enabled: number; created_at: number; updated_at: number; agent_name: string | null };
export type WorkflowVersionRow = { workflow_id: string; version: number; definition: string; published_at: number; published_by: string | null };
export type WorkflowRunRow = { id: string; workflow_id: string; version: number; status: string; trigger: string; input: string | null; context: string; error: string | null; started_at: number; ended_at: number | null; owner_user_id: string | null; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null };
export type WorkflowRunNodeRow = { run_id: string; node_id: string; attempt: number; status: string; mission_id: string | null; input: string | null; output: string | null; error: string | null; taken_port: string | null; started_at: number | null; ended_at: number | null; tokens_in: number | null; tokens_out: number | null };

/** What closes an agent's card: the human answering in its mission (`reply`),
 *  or its task reaching DONE (`task_done`). */
export type NotificationDismissOn = 'reply' | 'task_done';
export const NOTIFICATION_DISMISS_ON: readonly NotificationDismissOn[] = ['reply', 'task_done'];

/** The stored column read defensively: anything unreadable closes on nothing. */
export function parseDismissOn(raw: string | null): NotificationDismissOn[] {
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list)
      ? NOTIFICATION_DISMISS_ON.filter((t) => list.includes(t))
      : [];
  } catch {
    return [];
  }
}

/** Who raised a card (layout proposal, command request) in a conversation. */
export type CardOriginKind = 'agent' | 'plugin';

export type LayoutProposalRow = {
  id: string;
  /** What the payload arranges: `widgets` today, island layouts next. */
  kind: string;
  mission_id: string;
  owner_user_id: string;
  agent: string;
  /** JSON, validated by the kind's schema before it was stored. */
  payload: string;
  note: string | null;
  project: string | null;
  mission_title: string;
  task_id: string | null;
  /** `agent` (the mission's) or `plugin` (`origin_id` = its id). */
  origin_kind: CardOriginKind;
  origin_id: string | null;
  status: LayoutProposalStatus;
  created_at: number;
  resolved_at: number | null;
};

export type UiDocumentRow = {
  id: string;
  mission_id: string;
  /** The mission's owner: the only one who may answer. */
  owner_user_id: string;
  origin_kind: UiDocumentOriginKind;
  /** Agent name, user id or plugin id. */
  origin_id: string | null;
  title: string;
  /** Masked at write time. Never leaves except through the session-only document route. */
  html: string;
  bridge: UiDocumentBridge;
  height: number | null;
  expects_reply: number;
  status: UiDocumentStatus;
  /** JSON, masked. Read only through `projectUiDocument` (ADR-MCPUI D8). */
  reply: string | null;
  resolved_by_kind: string | null;
  resolved_by_id: string | null;
  resolved_at: number | null;
  ref_provider: string | null;
  ref: string | null;
  project: string | null;
  mission_title: string;
  task_id: string | null;
  created_at: number;
};

export type CommandRequestRow = {
  id: string;
  mission_id: string;
  owner_user_id: string;
  agent: string;
  command: string;
  note: string | null;
  session_id: string | null;
  project: string | null;
  mission_title: string;
  task_id: string | null;
  /** JSON array of the decisions the card offers. */
  choices: string;
  origin_kind: CardOriginKind;
  origin_id: string | null;
  status: CommandRequestStatus;
  created_at: number;
  resolved_at: number | null;
};

export type ApprovalRuleScope = 'session' | 'always';
export type ApprovalRuleRow = {
  id: string;
  scope: ApprovalRuleScope;
  owner_user_id: string;
  agent: string;
  /** Set for `session`, null for `always`. */
  mission_id: string | null;
  tool_name: string;
  /** Masked, for display only: a shell rule matches on `command_hash`. */
  command: string | null;
  command_hash: string | null;
  created_at: number;
};

export type NotificationRow = {
  id: string;
  type: NotificationType;
  urgent: number;
  title: string;
  body: string | null;
  task_id: string | null;
  mission_id: string | null;
  anchor: string | null;
  /** `plugin:<id>` if the notification comes from a third-party plugin, otherwise null. */
  source: string | null;
  /** JSON list of `NotificationDismissOn`: what closes the card by itself. */
  dismiss_on: string | null;
  /** Epoch ms after which the card is dismissed by the sweep; null = never. */
  expires_at: number | null;
  created_at: number;
  read_at: number | null;
  dismissed_at: number | null;
  owner_user_id: string | null;
};

/** Web Push subscription of a device. `p256dh`/`auth` = client's public keys
 *  (base64url), provided by the browser — not server secrets. */
export type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_label: string | null;
  created_at: number;
  last_seen_at: number;
  last_error: string | null;
};

export type AgentMessageRow = {
  id: string;
  from_mission: string;
  from_agent: string;
  to_agent: string;
  to_mission: string | null;
  kind: MessageKind;
  payload: string;
  in_reply_to: string | null;
  created_at: number;
  picked_at: number | null;
  status: MessageStatus;
  owner_user_id: string | null;
  /** Causal root, from `from_mission`. */
  trace_id: string | null;
};

export type RoutineRow = {
  id: string;
  name: string;
  agent_name: string;
  prompt: string;
  task_type: TaskType;
  cron_expr: string;
  enabled: number;
  project: string | null;
  /** The account that created it: the tasks it opens belong to that account,
   *  and so do the missions of those tasks (a remote backend picks its
   *  per-user connection from it). Null = created by the daemon itself. */
  owner_user_id: string | null;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
};

/** The one action a routine carries, as stored on its trigger row (TODO #216). */
function routineAction(r: { agent_name: string; prompt: string; task_type: string; project: string | null }) {
  return { type: 'task', agent: r.agent_name, prompt: r.prompt, task_type: r.task_type, project: r.project, raw: true };
}

/** RoutineRow projection of the schedule triggers that are routines. */
const ROUTINE_VIEW = `SELECT id, name,
  json_extract(actions, '$[0].agent') AS agent_name,
  json_extract(actions, '$[0].prompt') AS prompt,
  json_extract(actions, '$[0].task_type') AS task_type,
  json_extract(config, '$.cron') AS cron_expr,
  enabled,
  json_extract(actions, '$[0].project') AS project,
  owner_user_id,
  last_run_at, next_run_at, created_at, updated_at
  FROM triggers WHERE created_by = 'routine'`;

// ── task prepared statements ──────────────────────────────────────────────────
const insertTaskStmt = db.prepare(
  `INSERT INTO tasks (id, title, description, agent_name, status, priority, deps, created_at, updated_at, scheduled_at, extra_skills, extra_mcp_servers, extra_allowed_tools, type, backend_override, model_override, fallback_backend_override, fallback_model_override, permission_mode_override, group_id, creator_mission_id, series_id, pipeline, project, owner_user_id, trace_id, mirror, plan_group)
   VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const getTaskStmt = db.prepare(`SELECT * FROM tasks WHERE id = ?`);
const listTasksStmt = db.prepare(`SELECT * FROM tasks ORDER BY priority DESC, created_at ASC`);
const listTasksByStatusStmt = db.prepare(
  `SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC`,
);
const listPendingReadyStmt = db.prepare(
  `SELECT * FROM tasks WHERE status = 'PENDING' AND mirror = 0 AND (scheduled_at IS NULL OR scheduled_at <= ?)
   ORDER BY priority DESC, created_at ASC`,
);
const countInProgressStmt = db.prepare(
  // A mirror task can sit IN_PROGRESS forever (a card in a column elsewhere): counted, it would
  // fill the parallelism cap and stop every real task from starting.
  `SELECT COUNT(*) as n FROM tasks WHERE status = 'IN_PROGRESS' AND mirror = 0`,
);
const updateTaskStatusStmt = db.prepare(
  `UPDATE tasks SET status = ?, updated_at = ?, blocked_reason = ?, done_comment = ? WHERE id = ?`,
);
// interrupted_reason reset to NULL on
// (re-)dispatch: the previous attempt's death cause
// must not survive a new execution, otherwise a relaunched task blocked for a real
// business reason would stay labelled "mission killed" even though it ran. System
const assignTaskMissionStmt = db.prepare(
  `UPDATE tasks SET status = 'IN_PROGRESS', mission_id = ?, updated_at = ?,
                    interrupted_reason = NULL
   WHERE id = ?`,
);
// death: we set BLOCKED, the qualified cause and a readable sentence in one go.
// `done_comment` is NOT touched (no clobber of
// what the agent wrote before dying), and
// `blocked_reason` is overwritten only if empty —
const setTaskInterruptedStmt = db.prepare(
  `UPDATE tasks SET status = 'BLOCKED', updated_at = ?, interrupted_reason = ?,
                    quota_resets_at = ?,
                    blocked_reason = COALESCE(NULLIF(blocked_reason, ''), ?)
   WHERE id = ?`,
);
// a business reason already set by the
// agent always wins. Requeue after a system death: the task restarts as if never
// dispatched (mission detached, reasons cleared), and we increment the DEDICATED
// counter. Blockage is never set, so no
// `task_blocked` is emitted: that is exactly the
// `scheduled_at`: the backoff (cf. `requeueBackoffMs`). The task goes back to
// PENDING but not INTO THE DISPATCHER'S HANDS right away — `listPendingReady` already
// gates on that column, so the delay costs no new mechanism. `max()` keeps a
// date further out that someone set on purpose: a backoff postpones, it never
// brings a task forward.
// Counts a system death that does not requeue (cap reached, or a cause that is
// never replayed): `requeue_count` is the number of deaths since the last human
// restart, so a task that keeps dying past its cap keeps climbing (TIM-0065).
const countSystemDeathStmt = db.prepare(
  `UPDATE tasks SET requeue_count = requeue_count + 1 WHERE id = ?`,
);
const resetTaskRequeuesStmt = db.prepare(
  `UPDATE tasks SET requeue_count = 0, blind_quota_deaths = 0, updated_at = ? WHERE id = ?`,
);
const countBlindQuotaDeathStmt = db.prepare(
  `UPDATE tasks SET blind_quota_deaths = blind_quota_deaths + 1 WHERE id = ?`,
);
// Holds a requeued task back without ever bringing it forward, like the backoff
// of `requeueInterruptedStmt`.
const deferTaskStmt = db.prepare(
  `UPDATE tasks SET scheduled_at = max(COALESCE(scheduled_at, 0), ?), updated_at = ? WHERE id = ?`,
);
const requeueInterruptedStmt = db.prepare(
  `UPDATE tasks SET status = 'PENDING', mission_id = NULL, interrupted_reason = NULL,
                    blocked_reason = NULL, requeue_count = requeue_count + 1,
                    scheduled_at = max(COALESCE(scheduled_at, 0), ?),
                    updated_at = ?
   WHERE id = ?`,
);
// orchestrator wake we want to avoid for a cause that asks for no decision. Type
// requalification: a blockage reason set by a guard that no longer applies to the NEW
// type is a stale residue (task bceeb4cd of 2026-08-15, switched from code(code-self)
// to chore and left dead on the board with the merge-guard reason). We clear it,
// without re-evaluating anything: if the condition still holds for the new type, the
// guard will fire again on the next dispatch. `scheduled_at`: COALESCE alone makes the
const clearBlockedReasonsStmt = db.prepare(
  `UPDATE tasks SET blocked_reason = NULL, interrupted_reason = NULL, updated_at = ?
   WHERE id = ?`,
);
// field UNERASABLE — passing null is indistinguishable from "field absent", so the old
// timestamp survived every unschedule attempt, with no error (seen in prod on
// 2026-08-06: a task "unscheduled" from the UI
// stayed armed on its old hour). Hence the
// dedicated `clearScheduledAt` sentinel (1 = clear), which explicitly distinguishes
// erasure from no-op instead of overloading null.
const updateTaskStmt = db.prepare(
  `UPDATE tasks SET title = COALESCE(?, title),
                    description = COALESCE(?, description),
                    agent_name = COALESCE(?, agent_name),
                    priority = COALESCE(?, priority),
                    deps = COALESCE(?, deps),
                    scheduled_at = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, scheduled_at) END,
                    extra_skills = COALESCE(?, extra_skills),
                    extra_mcp_servers = COALESCE(?, extra_mcp_servers),
                    extra_allowed_tools = COALESCE(?, extra_allowed_tools),
                    type = COALESCE(?, type),
                    backend_override = CASE WHEN ? = 1 THEN ? ELSE backend_override END,
                    model_override = CASE WHEN ? = 1 THEN ? ELSE model_override END,
                    fallback_backend_override = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, fallback_backend_override) END,
                    fallback_model_override = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, fallback_model_override) END,
                    permission_mode_override = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, permission_mode_override) END,
                    updated_at = ?
   WHERE id = ?`,
);
const getTaskByMissionStmt = db.prepare(`SELECT * FROM tasks WHERE mission_id = ?`);
const deleteTaskStmt = db.prepare(`DELETE FROM tasks WHERE id = ?`);
const setTaskWorktreeStmt = db.prepare(
  `UPDATE tasks SET worktree_path = ?, branch_name = ?, base_branch = ?, updated_at = ? WHERE id = ?`,
);
/** `updated_at` is INTENTIONALLY left intact: clearing the reference to a
 *  worktree is technical cleanup, not business activity on the task.
 *
 *  Touching it has a violent side effect: several reconciliation rules only look
 *  at recently modified tasks (see `RECONCILE_MAX_AGE_MS` in verification-loop).
 *  On 2026-08-05 the worktree garbage collector cleaned 557 old tasks at once;
 *  their `updated_at` reset to now put them back under the cutoff, and chains
 *  dead for two months were "caught up": 17 merges and 17 doc tasks replayed on
 *  6 projects. */
const clearTaskWorktreeStmt = db.prepare(
  `UPDATE tasks SET worktree_path = NULL, branch_name = NULL WHERE id = ?`,
);
// The branch stays recorded: it still holds the task's commits.
const detachTaskWorktreeStmt = db.prepare(
  `UPDATE tasks SET worktree_path = NULL, updated_at = ? WHERE id = ?`,
);
const setTaskMergedShaStmt = db.prepare(
  `UPDATE tasks SET merged_commit_sha = ?, updated_at = ? WHERE id = ?`,
);
// Appended, never prepended: the first line of a review's comment is its verdict.
const appendTaskDoneCommentStmt = db.prepare(
  `UPDATE tasks SET done_comment = CASE WHEN done_comment IS NULL OR done_comment = '' THEN @text
     ELSE done_comment || char(10) || char(10) || @text END, updated_at = @now WHERE id = @id`,
);
const setTaskDoneSummaryStmt = db.prepare(
  `UPDATE tasks SET done_summary = ? WHERE id = ?`,
);
const setTaskRoutineStmt = db.prepare(
  `UPDATE tasks SET routine_id = ?, updated_at = ? WHERE id = ?`,
);
const setTaskVerificationMetaStmt = db.prepare(
  `UPDATE tasks SET iteration = ?, verification_root_id = ?, updated_at = ? WHERE id = ?`,
);
// Variant of updateTaskStatusStmt that touches ONLY the status. Used by the
// mission_complete watcher: if the agent already closed its task via `timon task done
// --comment` just before exit, we do not want to clobber its done_comment with NULL.
// Verification chain (code → review → code → …) of the same work: used by the merge
const setTaskStatusOnlyStmt = db.prepare(
  `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`,
);
const setTaskBaseBranchStmt = db.prepare(
  `UPDATE tasks SET base_branch = ?, updated_at = ? WHERE id = ?`,
);
const setTaskTodoIdStmt = db.prepare(
  `UPDATE tasks SET todo_id = ?, updated_at = ? WHERE id = ?`,
);
const listTasksByRoutineStmt = db.prepare(
  `SELECT * FROM tasks WHERE routine_id = ? ORDER BY created_at DESC`,
);
const listTasksByGroupStmt = db.prepare(
  `SELECT * FROM tasks WHERE group_id = ? ORDER BY created_at ASC`,
);
const listTasksByTodoStmt = db.prepare(
  `SELECT * FROM tasks WHERE todo_id = ? ORDER BY created_at ASC`,
);
// dispatch gate, which must see ALL reviews of the chain and not only the one it
// depends on. `chain_started_at` is written only
// on the transition to CHAIN_RUNNING: on
const listTasksByVerificationRootStmt = db.prepare(
  `SELECT * FROM tasks WHERE verification_root_id = ? ORDER BY created_at ASC`,
);
const listChainDependentsStmt = db.prepare(
  `SELECT * FROM tasks WHERE type IN ('review', 'merge')
     AND EXISTS (SELECT 1 FROM json_each(tasks.deps) WHERE value = ?)
   ORDER BY created_at ASC`,
);
const listTaskDependentsStmt = db.prepare(
  `SELECT * FROM tasks WHERE EXISTS (SELECT 1 FROM json_each(tasks.deps) WHERE value = ?)
   ORDER BY created_at ASC`,
);
const isVerificationRootStmt = db.prepare(`SELECT 1 FROM tasks WHERE verification_root_id = ? LIMIT 1`);
const groupActiveCountStmt = db.prepare(
  `SELECT COUNT(*) as n FROM tasks WHERE group_id = ? AND status IN ('PENDING', 'IN_PROGRESS')`,
);
const markReturnNotifiedStmt = db.prepare(
  `UPDATE tasks SET return_notified = ? WHERE id = ?`,
);
const rearmReturnNotifiedStmt = db.prepare(
  `UPDATE tasks SET return_notified = silent_return WHERE id = ?`,
);
const setTaskParentStmt = db.prepare(`UPDATE tasks SET parent_task_id = ? WHERE id = ?`);
// Only the first dispatch writes: `changes` says whether this one was it.
const markTaskStartedStmt = db.prepare(`UPDATE tasks SET started_at = ? WHERE id = ? AND started_at IS NULL`);
const markTaskSilentReturnStmt = db.prepare(
  `UPDATE tasks SET silent_return = 1, return_notified = 1 WHERE id = ?`,
);
const markMissionReturnNotifiedStmt = db.prepare(
  `UPDATE missions SET return_notified = ? WHERE id = ?`,
);
const missionReturnNotifiedStmt = db.prepare(
  `SELECT return_notified FROM missions WHERE id = ?`,
);
// the other two states it no longer means anything, and overwriting it would erase the
// date that lets reconcile say "this 1 is
// too old to be a live chain". `chain_attempts`
// increments on the ONLY transition to
// CHAIN_RUNNING: that is where an attempt actually
// starts, and counting there covers both failure
// modes at once (JS exception AND silent
// death replayed by reconcile). Reset to zero
const setChainStateStmt = db.prepare(
  `UPDATE tasks SET chain_ran = ?,
                    chain_started_at = CASE WHEN ? = 1 THEN ? ELSE chain_started_at END,
                    chain_attempts = CASE WHEN ? = 1 THEN chain_attempts + 1
                                          WHEN ? = 2 THEN 0
                                          ELSE chain_attempts END
   WHERE id = ?`,
);
// on CHAIN_DONE: a chain that succeeds does
const resetChainStmt = db.prepare(
  `UPDATE tasks SET chain_ran = 0, chain_started_at = NULL, chain_attempts = 0 WHERE id = ?`,
);
// not drag the history of its failures into a possible next execution. (Re-)dispatch:
// chaining starts from zero, attempt counter included. The filter belongs in SQL, not
// JS. Measured 2026-08-21: 1290 DONE tasks in the database, of which 1262 with
// chain_ran = 0 (all history prior to the column) and ZERO in the 6 h window.
// `listTasks('DONE')` materialised 1290 rows every 120 s to keep none of them — pure
const listTasksNeedingChainStmt = db.prepare(
  `SELECT * FROM tasks
    WHERE status = 'DONE' AND mirror = 0 AND chain_ran NOT IN (2, 3) AND updated_at > ?
      AND (chain_ran = 0 OR COALESCE(chain_started_at, 0) < ?)
    ORDER BY updated_at ASC`,
);
// heap churn on a process with chronic OOM at the 4 GB cap. A follow-up task = a task
// that DEPENDS on this one. `deps` is a JSON array of ids: LIKE on the id (a UUID, so
// no realistic collision) avoids adding a join table for such a punctual read. `doc`
// tasks are excluded: they chain nothing, so their existence does not prove the chain
// continues.
const hasFollowUpTaskStmt = db.prepare(
  `SELECT 1 FROM tasks WHERE id != ? AND type != 'doc' AND deps LIKE '%' || ? || '%' LIMIT 1`,
);
const markGroupNotifiedStmt = db.prepare(
  `UPDATE tasks SET group_notified = 1, updated_at = ? WHERE group_id = ?`,
);
const groupNotifiedCountStmt = db.prepare(
  `SELECT COUNT(*) as n FROM tasks WHERE group_id = ? AND group_notified = 1`,
);

/**
 * Hard guard of the merge pipeline: a `type='merge'` task can only reach `DONE`
 * if its `merged_commit_sha` is set. Without a sha the branch was never integrated
 * and a DONE status lies to the Kanban — incident 2026-05-25: 8 DONE tasks whose
 * fixes had never shipped.
 *
 * We degrade the transition to `BLOCKED` (explicit reason) rather than throw: this
 * guard is called from bus handlers (mission_complete) where an uncaught exception
 * would break the dispatcher.
 *
 * Scope: `merge` tasks, PLUS `code` tasks with `pipeline='code-self'` — there the
 * coder integrates their own branch, so the sha must land on THEIR task. Without
 * this extension, code-self would entirely bypass the 2026-05-25 safety net. `code`
 * tasks in full or grouped pipeline land via their chained `merge` task and remain
 * free to go DONE without a direct sha.
 */
/** Extract a git sha (40 hex) from free text. Fallback when the merger writes the
 *  sha in its done_comment ("merged on main (sha <40hex>)") instead of passing
 *  --merged-sha — the most common case, which left the task BLOCKED even though the
 *  branch was actually integrated. */
function extractGitSha(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /\b[0-9a-f]{40}\b/i.exec(text);
  return m ? m[0].toLowerCase() : null;
}

function guardMergeDone(
  prev: TaskRow | undefined,
  status: TaskStatus,
  blockedReason: string | null,
  doneComment?: string | null,
): { status: TaskStatus; blockedReason: string | null; mergedSha?: string } {
  const needsSha =
    prev?.type === 'merge' ||
    (prev?.type === 'code' && isSelfMergePipeline(prev.pipeline));
  if (status === 'DONE' && needsSha && !prev?.merged_commit_sha) {
    // Robust fallback: recover the sha from the comment (new or existing) before
    // blocking. A branch that was actually merged whose sha is in the prose must not
    // stay BLOCKED for lack of --merged-sha.
    const text = doneComment ?? prev?.done_comment;
    const sha = extractGitSha(text);
    if (sha) return { status, blockedReason, mergedSha: sha };
    // By far the most common case: the merge DID happen, but the agent wrote the
    // ABBREVIATED sha git displays everywhere (`fe2dd84`). The guard refuses — rightly,
    // a 7-hex fragment proves nothing — and the agent re-reads a message that does not
    // say what is wrong: it goes looking for a merge already done.
    // Three agents exhausted themselves on this on one series (2026-08-20). So we name
    // the problem and give the command that solves it.
    const short = /\b[0-9a-f]{7,39}\b/i.exec(text ?? '')?.[0];
    return {
      status: 'BLOCKED',
      blockedReason:
        (prev?.type === 'code'
          ? 'Code-self guard: this task must merge its own branch. '
          : '') +
        'Merge guard: DONE is rejected without merged_commit_sha  the branch ' +
        'was not merged (or the SHA was not recorded). ' +
        (short
          ? `Your comment contains ${short}, which looks like an ABBREVIATED SHA: `
            + `the guard accepts only the full form (40 hex). Resolve it with `
            + `\`git rev-parse ${short}\` then close with `
            + '`timon task done <id> --merged-sha <SHA-40-hex>`.'
          : 'Close with `timon task done <id> --merged-sha <SHA>` (40 hex; see '
            + '`git rev-parse HEAD`), or include that full sha in your comment.'),
    };
  }
  return { status, blockedReason };
}

/**
 * Task columns whose change is news to a board mirrored elsewhere. Execution
 * bookkeeping (mission, worktree, chain state, counters, `updated_at`) is left
 * out on purpose: a sync plugin must not wake for it.
 */
const TASK_WATCHED_COLUMNS = [
  'title', 'description', 'agent_name', 'status', 'priority', 'deps', 'scheduled_at', 'type',
  'blocked_reason', 'done_comment', 'extra_skills', 'extra_mcp_servers', 'extra_allowed_tools',
  'backend_override', 'model_override', 'fallback_backend_override', 'fallback_model_override',
  'permission_mode_override', 'reasoning_effort',
] as const satisfies readonly (keyof TaskRow)[];

/**
 * Publishes `task_updated` (and `task_assigned`) for what a write changed,
 * comparing the row read BEFORE the write with the row now. Synchronous, so the
 * origin store of the writer (`task-origin.ts`) is still the current one.
 */
function publishTaskDiff(prev: TaskRow | undefined): void {
  if (!prev) return;
  const next = getTaskStmt.get(prev.id) as TaskRow | undefined;
  if (!next) return;
  const changed = TASK_WATCHED_COLUMNS.filter((c) => prev[c] !== next[c]);
  if (changed.length === 0) return;
  bus.publish({
    kind: 'task_updated',
    taskId: prev.id,
    changed,
    previous: Object.fromEntries(changed.map((c) => [c, prev[c]])),
  });
  if (changed.includes('agent_name')) bus.publish({ kind: 'task_assigned', taskId: prev.id, previousAgent: prev.agent_name });
}

/** Set the qualified BLOCKED of a system death + emit `task_blocked` (orchestrator
 *  wake + recovery loop). The reason already in the database wins, see
 *  `setTaskInterruptedStmt`. */
function blockOnInterruption(
  id: string,
  reason: InterruptionReason,
  blockedReason: string,
  quotaResetsAt: number | null,
): 'blocked' {
  const prev = getTaskStmt.get(id) as TaskRow | undefined;
  setTaskInterruptedStmt.run(Date.now(), reason, quotaResetsAt, blockedReason, id);
  const after = getTaskStmt.get(id) as TaskRow | undefined;
  bus.publish({ kind: 'task_blocked', taskId: id, reason: after?.blocked_reason ?? blockedReason });
  publishTaskDiff(prev);
  return 'blocked';
}

// ── mission prepared statements ───────────────────────────────────────────────
const insertMissionStmt = db.prepare(
  `INSERT INTO missions (id, agent_name, mission, status, started_at, source_channel, source_meta, owner_user_id, trace_id, workflow_run_id, workflow_node_id)
   VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
);
const setMissionOwnerStmt = db.prepare(`UPDATE missions SET owner_user_id = ? WHERE id = ?`);
const assignUnownedMissionsStmt = db.prepare(
  `UPDATE missions SET owner_user_id = ? WHERE owner_user_id IS NULL`,
);
// COALESCE(interrupted_reason, ?) — the cause ALREADY IN THE DATABASE wins, the
// parameter is only a default. Intended order: a persisted cause comes from a
// direct stream signal (rate_limit_event, 429, quota message), observed well before
// finalisation; the one passed here by the reaper or the boot sweep is only a
// guess made without context. The reliable signal must take precedence over the guess.
const finishMissionStmt = db.prepare(
  `UPDATE missions SET status = ?, ended_at = ?, exit_code = ?,
                       interrupted_reason = COALESCE(interrupted_reason, ?)
   WHERE id = ?`,
);
const setMissionInterruptedStmt = db.prepare(
  `UPDATE missions SET interrupted_reason = ? WHERE id = ?`,
);
// Reactivate a finished mission we re-spawn with --resume (permission safety net:
// process dead then user answers → we resurrect the conversation). Without this
// reset, the row stays `completed`/`failed` while the process is running again →
// inconsistent UI and stats.
// interrupted_reason reset to NULL: the mission starts again, the previous death
// cause must not stay glued to the row (otherwise a future reap would re-read it
// via finishMission's COALESCE and qualify wrongly).
const reopenMissionStmt = db.prepare(
  `UPDATE missions SET status = 'running', ended_at = NULL, exit_code = NULL,
                       interrupted_reason = NULL
   WHERE id = ?`,
);
// Every `permission_resolved` of a mission, newest first. Used to recover a decision
// already taken for a given tool_use_id when the shim reconnects (after an
// orchestrator restart, the in-memory cache is empty).
const hasPermissionRequestStmt = db.prepare(
  `SELECT 1 FROM events
    WHERE mission_id = ? AND type = 'permission_request' AND json_extract(payload, '$.id') = ?
    LIMIT 1`,
);
const resolvedPermissionsStmt = db.prepare(
  `SELECT payload FROM events
    WHERE mission_id = ? AND type = 'permission_resolved'
    ORDER BY id DESC`,
);
const listRunningMissionsStmt = db.prepare(
  `SELECT id FROM missions WHERE status = 'running'`,
);
const listRunningMissionRowsStmt = db.prepare(
  `SELECT * FROM missions WHERE status = 'running'`,
);
// Zombie = mission still `running` while the orchestrator has just booted: its
// process died with the previous one. Default cause `crash` (systemd restart / OOM),
// unless we had already observed better before dying (typically `rate_limit`) — hence
// COALESCE rather than a dry write.
const upsertRemoteResumeStmt = db.prepare(
  `INSERT INTO mission_remote_resume (mission_id, state, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(mission_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
);
const deleteRemoteResumeStmt = db.prepare(`DELETE FROM mission_remote_resume WHERE mission_id = ?`);
const getRemoteResumeStmt = db.prepare(`SELECT state FROM mission_remote_resume WHERE mission_id = ?`);
const upsertPreludeFoldStmt = db.prepare(
  `INSERT INTO mission_prelude_fold (mission_id, version, up_to, state, updated_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(mission_id) DO UPDATE SET
     version = excluded.version, up_to = excluded.up_to, state = excluded.state, updated_at = excluded.updated_at`,
);
const getPreludeFoldStmt = db.prepare(`SELECT version, up_to, state FROM mission_prelude_fold WHERE mission_id = ?`);
const markZombiesFailedStmt = db.prepare(
  `UPDATE missions SET status = 'failed', ended_at = ?, exit_code = -1,
                       interrupted_reason = COALESCE(interrupted_reason, 'crash')
   WHERE status = 'running'`,
);
const markZombieFailedStmt = db.prepare(
  `UPDATE missions SET status = 'failed', ended_at = ?, exit_code = -1,
                       interrupted_reason = COALESCE(interrupted_reason, 'crash')
   WHERE id = ? AND status = 'running'`,
);
const getMissionStmt = db.prepare(`SELECT * FROM missions WHERE id = ?`);
// Two columns, not `SELECT *`: the board reads it for every listed task, and a
// mission row carries its whole prompt.
const missionRunnerStmt = db.prepare(`SELECT agent_name, source_meta FROM missions WHERE id = ?`);
const insertEventStmt = db.prepare(
  `INSERT INTO events (mission_id, type, timestamp, payload) VALUES (?, ?, ?, ?)`,
);
// The thread: rows a rewind hid are left out of every reader of it (docs/specs/rewind.md § 9).
const listEventsStmt = db.prepare(`SELECT * FROM events WHERE mission_id = ? AND rewound_by IS NULL ORDER BY id ASC`);
// The chat view of ONE mission (mission-events-view.ts): same rows minus the
// per-token noise, filtered in SQL so it never crosses into JS.
const listChatEventsStmt = db.prepare(
  `SELECT * FROM events WHERE mission_id = ? AND ${CHAT_VIEW_SQL} ORDER BY id ASC`,
);
let listChatEventsUnionStmt: import('better-sqlite3').Statement | null = null;
// Tail of ONE mission's chat view (SSE replay): newest N rows, returned oldest
// first. Filtered BEFORE the limit: a mission streaming thinking tokens writes
// hundreds of noise rows a minute, which otherwise filled the whole window and
// left the replay nothing the chat renders.
const listEventsTailStmt = db.prepare(
  `SELECT * FROM (SELECT * FROM events WHERE mission_id = ? AND ${CHAT_VIEW_SQL} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
);
let listEventsTailUnionStmt: import('better-sqlite3').Statement | null = null;

/* ── Cold archive of events ──────────────────────────────────────────────
   The `events` table is the bulk of the database weight (1.8 GB on the maintainer's install),
   which makes it impossible to move. Old rows go into an attached database;
   every read of ONE mission must therefore cover both tables, otherwise an
   archived mission displays empty. */

let listEventsUnionStmt: import('better-sqlite3').Statement | null = null;

/** Attach `<file>` under the name `archive` and create the `events` table there
 *  if it is missing. Idempotent: a second call does nothing. */
export function attachEventsArchive(file: string): void {
  if (listEventsUnionStmt) return;
  db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS archive`);
  // Same columns as the hot table, without
  // the foreign key: `missions` lives in the other
  db.exec(`
CREATE TABLE IF NOT EXISTS archive.events (
  id INTEGER PRIMARY KEY,
  mission_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS archive.idx_events_mission ON events(mission_id, id);
`);
  ensureRewoundByColumn('archive');
  ensureChatViewIndex('archive');
  listEventsUnionStmt = db.prepare(
    `SELECT id, mission_id, type, timestamp, payload FROM events WHERE mission_id = ? AND rewound_by IS NULL
     UNION ALL
     SELECT id, mission_id, type, timestamp, payload FROM archive.events WHERE mission_id = ? AND rewound_by IS NULL
     ORDER BY id ASC`,
  );
  listChatEventsUnionStmt = db.prepare(
    `SELECT id, mission_id, type, timestamp, payload FROM events WHERE mission_id = ? AND ${CHAT_VIEW_SQL}
     UNION ALL
     SELECT id, mission_id, type, timestamp, payload FROM archive.events WHERE mission_id = ? AND ${CHAT_VIEW_SQL}
     ORDER BY id ASC`,
  );
  listEventsTailUnionStmt = db.prepare(
    `SELECT * FROM (
       SELECT id, mission_id, type, timestamp, payload FROM events WHERE mission_id = ? AND ${CHAT_VIEW_SQL}
       UNION ALL
       SELECT id, mission_id, type, timestamp, payload FROM archive.events WHERE mission_id = ? AND ${CHAT_VIEW_SQL}
       ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`,
  );
}

export function eventsArchiveAttached(): boolean {
  return listEventsUnionStmt !== null;
}

/** A read of ONE mission's events under a condition of the calling module. */
export interface MissionEventScan {
  /** AND-ed after `mission_id = ?`. A constant of the caller: request values go in `params`. */
  where: string;
  params?: readonly (string | number)[];
  order: 'ASC' | 'DESC';
  limit?: number;
  /** Must include `id`, the sort key. Defaults to the five stored columns. */
  columns?: string;
}

// Keyed by SQL text: the conditions are constants, so the cache stays bounded.
const missionScanStmts = new Map<string, import('better-sqlite3').Statement>();

/** Hot and archived rows alike, like every other read of one mission: an
 *  archived mission must not page through an empty journal. */
/** The SQL and bound values of a {@link MissionEventScan} (tests read its query plan). */
export function missionScanQuery(missionId: string, scan: MissionEventScan): { sql: string; args: (string | number)[] } {
  const columns = scan.columns ?? 'id, mission_id, type, timestamp, payload';
  const archived = listEventsUnionStmt !== null;
  // Rows a rewind hid are not part of the thread, whatever the caller scans for.
  const side = (table: string): string => `SELECT ${columns} FROM ${table} WHERE mission_id = ? AND rewound_by IS NULL AND (${scan.where})`;
  const sql = (archived ? `${side('events')} UNION ALL ${side('archive.events')}` : side('events'))
    + ` ORDER BY id ${scan.order === 'DESC' ? 'DESC' : 'ASC'}`
    + (scan.limit === undefined ? '' : ' LIMIT ?');
  const params = scan.params ?? [];
  const args: (string | number)[] = archived ? [missionId, ...params, missionId, ...params] : [missionId, ...params];
  if (scan.limit !== undefined) args.push(Math.max(1, Math.floor(scan.limit)));
  return { sql, args };
}

function scanMissionEvents(missionId: string, scan: MissionEventScan): unknown[] {
  const { sql, args } = missionScanQuery(missionId, scan);
  let stmt = missionScanStmts.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    missionScanStmts.set(sql, stmt);
  }
  return stmt.all(...args);
}
const listRecentEventsStmt = db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`);
// database and SQLite does not reference across
// an ATTACH. Last events of ONE mission,
// newest first. Used to derive the death cause after the fact (see
const lastMissionEventsStmt = db.prepare(
  `SELECT * FROM events WHERE mission_id = ? ORDER BY id DESC LIMIT ?`,
);
// detectMissionDeathSignal): the reliable signal is in
// the persisted stream, not in the
// process exit code. Date of a mission's last
const lastMissionEventAtStmt = db.prepare(
  `SELECT MAX(timestamp) AS ts FROM events WHERE mission_id = ?`,
);
// event. Used by the reaper to date the end
// of a one-shot backend turn, whose
// process has already disappeared (so no in-memory
// `turnSince` to query). ── full-text search in mission history
const insertMissionSearchStmt = db.prepare(
  `INSERT OR REPLACE INTO mission_search (mission_id, event_id, seq, role, ts, text)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const deleteMissionSearchEventStmt = db.prepare(
  `DELETE FROM mission_search WHERE event_id = ?`,
);
const getSearchStateStmt = db.prepare(`SELECT v FROM mission_search_state WHERE k = ?`);
const setSearchStateStmt = db.prepare(
  `INSERT INTO mission_search_state (k, v) VALUES (?, ?)
   ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
);
const eventsAfterStmt = db.prepare(
  `SELECT id, mission_id, type, timestamp, payload FROM events WHERE id > ? AND rewound_by IS NULL ORDER BY id LIMIT ?`,
);
const maxEventIdStmt = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM events`);
const unindexedMissionsStmt = db.prepare(
  `SELECT id, mission, started_at FROM missions m
    WHERE NOT EXISTS (SELECT 1 FROM mission_search s WHERE s.mission_id = m.id AND s.event_id IS NULL)`,
);

/**
 * The mission list, page first. The chat rail polls it every 10 s: the page
 * (filter + ORDER BY + LIMIT) is cut BEFORE any aggregate, so the span and
 * event lookups only touch the retained ids. Grouping the whole `trace_spans`
 * table first cost ~0.4 s per call on a 200k-span home (2026-09-26).
 *
 * The event aggregates come from `mission_stats` (trigger-kept, see its
 * schema). `last_event_at` stays MAX(timestamp), not the newest row by id: ids
 * and stamps diverge as soon as a clock steps back. A mission whose stats are
 * not backfilled yet (`ready` not 1) falls back to the subqueries, which cost
 * ~45 ms per 300 rows on a 2.2M-event home (2026-10-27) — hence the table
 * rather than a (mission_id, timestamp) index on the hottest insert path.
 * Span aggregates ride the covering `idx_spans_mission_agg`.
 */
const MISSION_ORIGIN_SQL = missionOriginSql('m', 'ot');

function missionListSql(whereSql: string): string {
  // The origin is computed inside the page so `?origin=` filters before the LIMIT.
  return `WITH page AS (
            SELECT m.*, ${MISSION_ORIGIN_SQL} AS origin FROM missions m
            LEFT JOIN tasks ot ON ot.id = m.task_id
            ${whereSql}
            ORDER BY m.started_at DESC
            LIMIT ?
          )
          SELECT p.*,
                 t.title AS task_title,
                 t.type  AS task_type,
                 CASE WHEN st.ready = 1 THEN st.last_event_at
                      ELSE (SELECT MAX(e.timestamp) FROM events e WHERE e.mission_id = p.id) END AS last_event_at,
                 CASE WHEN st.ready = 1 THEN st.event_count
                      ELSE (SELECT COUNT(*) FROM events e WHERE e.mission_id = p.id) END AS event_count,
                 CASE WHEN st.ready = 1 THEN st.last_result_id
                      ELSE (SELECT MAX(e.id) FROM events e WHERE e.mission_id = p.id AND e.type = 'result') END AS last_result_id,
                 CASE WHEN st.ready = 1 THEN st.last_user_id
                      ELSE (SELECT MAX(e.id) FROM events e WHERE e.mission_id = p.id AND e.type = 'user') END AS last_user_id,
                 COALESCE(st.ready, 0) AS stats_ready,
                 CASE WHEN st.ready = 1 THEN st.last_result_model END AS last_result_model,
                 COALESCE(pt.tools, 0)
                   + (SELECT COUNT(*) FROM trace_spans s WHERE s.mission_id = p.id AND s.kind = 'tool') AS span_tools,
                 COALESCE(pt.errors, 0)
                   + (SELECT COUNT(*) FROM trace_spans s
                       WHERE s.mission_id = p.id AND s.status IN ('error', 'denied', 'timeout', 'interrupted')) AS span_errors,
                 COALESCE(pt.duration_ms, 0)
                   + (SELECT COALESCE(SUM(s.duration_ms), 0) FROM trace_spans s WHERE s.mission_id = p.id) AS duration_ms,
                 ou.name AS owner_name,
                 ou.avatar_url AS owner_avatar_url
            FROM page p
            LEFT JOIN tasks t ON t.id = p.task_id
            LEFT JOIN users ou ON ou.id = p.owner_user_id
            LEFT JOIN mission_stats st ON st.mission_id = p.id
            LEFT JOIN mission_span_totals pt ON pt.mission_id = p.id
           ORDER BY p.started_at DESC`;
}
const listMissionsStmt = db.prepare(missionListSql(''));
const missionOriginStmt = db.prepare(
  `SELECT ${MISSION_ORIGIN_SQL} AS origin FROM missions m LEFT JOIN tasks ot ON ot.id = m.task_id WHERE m.id = ?`,
);
const ACTIVE_MISSIONS_SQL =
  `SELECT id, agent_name, status, started_at, ended_at, source_channel, task_id
     FROM missions
    WHERE (status = 'running' OR ended_at >= ?)`;
const listActiveMissionsStmt = db.prepare(ACTIVE_MISSIONS_SQL);
const listActiveMissionsOwnedStmt = db.prepare(`${ACTIVE_MISSIONS_SQL} AND owner_user_id = ?`);
// ───────────────────────────────────── INSERT OR REPLACE,
// not INSERT: re-indexing an
// already-seen event (catch-up relaunched, batch replayed after a crash) must be a
// semantic no-op, not a duplicate in the results. Last activity trace per agent.
// `ended_at` when the mission is finished, `started_at` otherwise (mission in
// progress). Deliberately WITHOUT a join on
const lastActivityByAgentStmt = db.prepare(
  `SELECT agent_name, MAX(COALESCE(ended_at, started_at)) AS at
     FROM missions
    GROUP BY agent_name`,
);
const latestResultPayloadStmt = db.prepare(
  `SELECT payload FROM events
    WHERE mission_id = ? AND type = 'result'
    ORDER BY id DESC LIMIT 1`,
);
// The newest event that opens or closes a turn: `user`, `result`, or the end of
// a series of replays (`turn_retry_abandoned`, agent.ts).
const latestTurnEdgeStmt = db.prepare(
  `SELECT type, payload FROM events
    WHERE mission_id = ? AND type IN ('result', 'user', 'turn_retry_abandoned')
    ORDER BY id DESC LIMIT 1`,
);
// Last assistant events of a mission, newest first. Bounded on purpose: the
// final report is within the last few turns, and an unbounded scan would read
// every assistant payload of a long mission.
const lastAssistantEventsStmt = db.prepare(
  `SELECT payload FROM events
    WHERE mission_id = ? AND type = 'assistant'
    ORDER BY id DESC LIMIT ?`,
);
// Last event id of a given type in a mission. Two lookups on the
// (mission_id, id) index — the whole point is to answer "has the turn ended?"
// without reading a single payload.
const lastEventIdOfTypeStmt = db.prepare(
  `SELECT MAX(id) AS id FROM events WHERE mission_id = ? AND type = ?`,
);
// Last `result` that ended a turn. Same index walk: only the `result` rows on the
// way have their payload read, and one a steer stopped is the rare one to skip.
const lastTurnEndIdStmt = db.prepare(
  `SELECT id FROM events
    WHERE mission_id = ? AND type = 'result' AND NOT (${steeredResultSql('payload')})
    ORDER BY id DESC LIMIT 1`,
);
const lastTurnEndId = (missionId: string): number =>
  ((lastTurnEndIdStmt.get(missionId) as { id: number } | undefined)?.id) ?? -1;
const countEventsStmt = db.prepare(`SELECT COUNT(*) as n FROM events WHERE mission_id = ?`);
// Inbox items still owed to a mission: addressed to it, or — while it is the
// agent's live mission — to its agent with no mission named. Human escalations
// (`from_agent = 'orchestrator'`) wait for a person and never wake an agent, so
// they are not "owed" to the mission.
const countPendingMessagesStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM agent_messages
    WHERE status = 'pending' AND from_agent != 'orchestrator'
      AND (to_mission = ? OR (? = 1 AND to_mission IS NULL AND to_agent = ?))`,
);
// Requests this mission received and has not answered yet (partial index).
const countOpenDeliveriesStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM agent_request_deliveries WHERE mission_id = ? AND settled_at IS NULL`,
);
const updateUsageStmt = db.prepare(
  `UPDATE missions SET total_cost_usd = COALESCE(?, total_cost_usd),
                       tokens_in = COALESCE(?, tokens_in),
                       tokens_out = COALESCE(?, tokens_out)
   WHERE id = ?`,
);
const updateSessionStmt = db.prepare(
  `UPDATE missions SET session_id = ? WHERE id = ?`,
);
const updateSummaryStmt = db.prepare(
  `UPDATE missions SET summary = ?, summary_at = ?, summary_event_id = ? WHERE id = ?`,
);
const setForkedFromStmt = db.prepare(
  `UPDATE missions SET forked_from = ? WHERE id = ?`,
);
// Trace inheritance once the lineage is known. `createMission` runs before
// the caller knows the parent (spawnAgent → setMissionLineage / setForkedFrom),
// so the row starts as its own root and adopts the ancestor's trace here.
// Only a root-of-itself (or NULL) row is rewritten: a trace posed explicitly
// at creation (workflow run, TIMON_TRACE_ID) wins over the lineage.
const inheritTraceFromMissionStmt = db.prepare(
  `UPDATE missions SET trace_id = COALESCE((SELECT trace_id FROM missions WHERE id = ?), trace_id)
    WHERE id = ? AND (trace_id IS NULL OR trace_id = id)`,
);
const inheritTraceFromLineageStmt = db.prepare(
  `UPDATE missions
      SET trace_id = COALESCE((SELECT p.trace_id FROM missions p WHERE p.id = ?),
                              (SELECT t.trace_id FROM tasks t WHERE t.id = ?),
                              trace_id)
    WHERE id = ? AND (trace_id IS NULL OR trace_id = id)`,
);
const missionTraceStmt = db.prepare(`SELECT trace_id FROM missions WHERE id = ?`);
const setLlmOverridesStmt = db.prepare(
  `UPDATE missions SET backend_override = ?, model_override = ? WHERE id = ?`,
);
const restoreMissionHandoverStmt = db.prepare(
  `UPDATE missions SET backend_override = ?, model_override = ?, session_id = ?, status = ?, ended_at = ?,
                       exit_code = ?, interrupted_reason = ?, return_notified = ?
   WHERE id = ?`,
);
const setReasoningEffortStmt = db.prepare(`UPDATE missions SET reasoning_effort = ? WHERE id = ?`);
const setMissionExtrasStmt = db.prepare(
  `UPDATE missions SET extra_skills = ?, extra_mcp_servers = ?, extra_allowed_tools = ? WHERE id = ?`,
);
const setMissionCwdOverrideStmt = db.prepare(
  `UPDATE missions SET cwd_override = ? WHERE id = ?`,
);
const setMissionPermissionModeOverrideStmt = db.prepare(
  `UPDATE missions SET permission_mode_override = ? WHERE id = ?`,
);
const setMissionMcpOverrideStmt = db.prepare(
  `UPDATE missions SET mcp_servers_override = ? WHERE id = ?`,
);
const maxEventIdForMissionStmt = db.prepare(
  `SELECT COALESCE(MAX(id), 0) AS n FROM events WHERE mission_id = ?`,
);
const setMissionLineageStmt = db.prepare(
  `UPDATE missions SET parent_mission_id = ?, parent_agent = ?, task_id = ?, routine_id = ? WHERE id = ?`,
);
// ── trace spans (W.0) ───────────────────────────────────────────────────────
// `INSERT OR IGNORE`: opening an id that already exists is a no-op, so a
// `tool_use` replayed on `--resume` cannot duplicate or reset a span.
const openSpanStmt = db.prepare(
  `INSERT OR IGNORE INTO trace_spans
     (id, trace_id, mission_id, parent_span_id, workflow_run_id, workflow_node_id, seq, kind, name,
      status, started_at, ended_at, duration_ms, input, output, error, tokens_in, tokens_out, cost_usd,
      event_id_start, event_id_end)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
// Only a `running` span can be closed: re-closing a closed span is a no-op,
// history is written once. COALESCE keeps whatever the open op already knew
// (an instantaneous span carries its output at open time).
const closeSpanStmt = db.prepare(
  `UPDATE trace_spans
      SET status = ?, ended_at = ?, duration_ms = ? - started_at,
          output = COALESCE(?, output), error = COALESCE(?, error),
          tokens_in = COALESCE(?, tokens_in), tokens_out = COALESCE(?, tokens_out),
          cost_usd = COALESCE(?, cost_usd), event_id_end = COALESCE(?, event_id_end)
    WHERE id = ? AND status = 'running'`,
);
const closeOpenSpansStmt = db.prepare(
  `UPDATE trace_spans
      SET status = ?, ended_at = ?, duration_ms = ? - started_at, error = COALESCE(?, error)
    WHERE mission_id = ? AND status = 'running'`,
);
const listSpansStmt = db.prepare(
  `SELECT * FROM trace_spans WHERE mission_id = ? ORDER BY seq ASC, started_at ASC`,
);
const listSpansByTraceStmt = db.prepare(
  `SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY started_at ASC, seq ASC`,
);
const getSpanStmt = db.prepare(`SELECT * FROM trace_spans WHERE id = ? AND mission_id = ?`);

/** What a timeline row needs. `input`, `output` and `error` are the wide
 *  columns (up to TIMON_TRACE_SPAN_MAX_BYTES each): a list never selects them,
 *  `getSpan` serves them for the one span that is opened. Measured on a
 *  50 000-span mission with ~2 KB payloads: 123 MB per refresh with them. */
export const SPAN_SUMMARY_COLUMNS = `id, trace_id, mission_id, parent_span_id, workflow_run_id, workflow_node_id,
  seq, kind, name, status, started_at, ended_at, duration_ms, tokens_in, tokens_out, cost_usd,
  event_id_start, event_id_end`;
export type SpanSummary = Omit<SpanRow, 'input' | 'output' | 'error'>;
/** Position of a span in its mission: `seq` is the starting events.id, which a
 *  parallel tool_use batch shares, so the rowid breaks the tie. */
export type SpanPageRow = SpanSummary & { cursor: string };
export type SpanPage = { spans: SpanPageRow[]; total: number; has_more: boolean };

export const SPAN_CURSOR_PATTERN = /^\d{1,15}\.\d{1,15}$/;
const spanPageStmts = new Map<string, ReturnType<typeof db.prepare>>();
const countMissionSpansStmts = new Map<string, ReturnType<typeof db.prepare>>();
function cachedStmt(cache: Map<string, ReturnType<typeof db.prepare>>, sql: string) {
  let stmt = cache.get(sql);
  if (!stmt) { stmt = db.prepare(sql); cache.set(sql, stmt); }
  return stmt;
}
function splitSpanCursor(cursor: string): { seq: number; rid: number } {
  const [seq, rid] = cursor.split('.');
  return { seq: Number(seq), rid: Number(rid) };
}
const traceSpanAggregatesStmt = db.prepare(
  `SELECT COUNT(*) AS spans,
          COALESCE(SUM(duration_ms), 0) AS duration_ms,
          COALESCE(SUM(tokens_in), 0) AS tokens_in,
          COALESCE(SUM(tokens_out), 0) AS tokens_out,
          COALESCE(SUM(cost_usd), 0) AS cost_usd,
          COALESCE(SUM(kind = 'tool'), 0) AS tools,
          COALESCE(SUM(status IN ('error', 'denied', 'timeout', 'interrupted')), 0) AS errors
     FROM trace_spans
    WHERE trace_id = @trace AND mission_id IN (SELECT value FROM json_each(@missions))`,
);
// A run's own spans (workflow, node) PLUS the turn/tool spans of the missions
// its agent nodes launched: `recordSpans` writes those from the CLI stream,
// where no run id travels, so they carried NULL and the post-run timeline
// showed one box per agent node instead of its Read/Bash/Edit (#53). The
// mission row does carry the ids, so the history fills in too.
//
// Two branches, never one `OR`: SQLite served `s.workflow_run_id IS NULL AND
// m.workflow_run_id = @run` by walking idx_spans_run over every NULL row — nearly
// the whole table, one missions lookup each (2.5 s warm, 10 s cold on a
// 1.2 M-span home), synchronously on the event loop, while the run view stayed
// on "Loading…" (#435). CROSS JOIN pins the order: the run's few missions first,
// then their spans through idx_spans_mission.
export const LIST_SPANS_BY_RUN_SQL = `SELECT * FROM (
  SELECT s.id, s.trace_id, s.mission_id, s.parent_span_id,
         s.workflow_run_id AS workflow_run_id,
         COALESCE(s.workflow_node_id, m.workflow_node_id) AS workflow_node_id,
         s.seq, s.kind, s.name, s.status, s.started_at, s.ended_at, s.duration_ms,
         s.input, s.output, s.error, s.tokens_in, s.tokens_out, s.cost_usd,
         s.event_id_start, s.event_id_end
    FROM trace_spans s LEFT JOIN missions m ON m.id = s.mission_id
   WHERE s.workflow_run_id = @run
  UNION ALL
  SELECT s.id, s.trace_id, s.mission_id, s.parent_span_id,
         m.workflow_run_id AS workflow_run_id,
         COALESCE(s.workflow_node_id, m.workflow_node_id) AS workflow_node_id,
         s.seq, s.kind, s.name, s.status, s.started_at, s.ended_at, s.duration_ms,
         s.input, s.output, s.error, s.tokens_in, s.tokens_out, s.cost_usd,
         s.event_id_start, s.event_id_end
    FROM missions m CROSS JOIN trace_spans s ON s.mission_id = m.id
   WHERE m.workflow_run_id = @run AND s.workflow_run_id IS NULL
) ORDER BY started_at ASC, seq ASC`;
const listSpansByRunStmt = db.prepare(LIST_SPANS_BY_RUN_SQL);
// The run view's own reading of the same spans: summary columns only, the
// run's structure (`workflow`, `node`) always, then the most recent others.
// A long run reached tens of thousands of spans with their payloads in one
// answer, re-read at every refresh (TODO #547).
const listSpanSummariesByRunStmt = db.prepare(
  `SELECT ${SPAN_SUMMARY_COLUMNS} FROM (${LIST_SPANS_BY_RUN_SQL})
    ORDER BY kind IN ('workflow', 'node') DESC, started_at DESC, seq DESC LIMIT @take`,
);
const countSpansByRunStmt = db.prepare(`SELECT COUNT(*) AS total FROM (${LIST_SPANS_BY_RUN_SQL})`);
const getRunSpanStmt = db.prepare(`SELECT * FROM (${LIST_SPANS_BY_RUN_SQL}) WHERE id = @span`);
// Missions first (idx_missions_ended), then their spans (idx_spans_mission):
// a scan of the whole span table by date would read every row each night.
const pruneSpanMissionsStmt = db.prepare(
  `SELECT m.id FROM missions m
    WHERE m.ended_at IS NOT NULL AND m.ended_at < ? AND m.status != 'running'
      AND EXISTS (SELECT 1 FROM trace_spans s WHERE s.mission_id = m.id)`,
);
const pruneSpansPickStmt = db.prepare(
  `SELECT rowid FROM trace_spans
    WHERE mission_id = @mission AND COALESCE(ended_at, started_at) < @cutoff AND workflow_run_id IS NULL
    LIMIT @batch`,
).pluck();
// `WHERE true`: SQLite cannot otherwise parse an upsert fed by a SELECT.
const freezeSpansStmt = db.prepare(
  `INSERT INTO mission_span_totals (mission_id, spans, tools, errors, duration_ms, tokens_in, tokens_out, cost_usd)
   SELECT @mission, COUNT(*), COALESCE(SUM(kind = 'tool'), 0),
          COALESCE(SUM(status IN ('error', 'denied', 'timeout', 'interrupted')), 0),
          COALESCE(SUM(duration_ms), 0), COALESCE(SUM(tokens_in), 0), COALESCE(SUM(tokens_out), 0), COALESCE(SUM(cost_usd), 0)
     FROM trace_spans WHERE rowid IN (SELECT value FROM json_each(@rows)) AND true
   ON CONFLICT(mission_id) DO UPDATE SET
     spans = spans + excluded.spans, tools = tools + excluded.tools, errors = errors + excluded.errors,
     duration_ms = duration_ms + excluded.duration_ms, tokens_in = tokens_in + excluded.tokens_in,
     tokens_out = tokens_out + excluded.tokens_out, cost_usd = cost_usd + excluded.cost_usd`,
);
const deleteSpansStmt = db.prepare(`DELETE FROM trace_spans WHERE rowid IN (SELECT value FROM json_each(?))`);
// One transaction: a span gone without its count, or counted and still there,
// would leave the mission list wrong for good.
const pruneSpansBatch = db.transaction((mission: string, cutoff: number, batch: number): number => {
  const rows = pruneSpansPickStmt.all({ mission, cutoff, batch }) as number[];
  if (rows.length === 0) return 0;
  const list = JSON.stringify(rows);
  freezeSpansStmt.run({ mission, rows: list });
  deleteSpansStmt.run(list);
  return rows.length;
});
const missionSpanTotalsStmt = db.prepare(`SELECT spans FROM mission_span_totals WHERE mission_id = ?`).pluck();
const clearMissionSpanTotalsStmt = db.prepare(`DELETE FROM mission_span_totals WHERE mission_id = ?`);
const prunedTraceTotalsStmt = db.prepare(
  `SELECT COALESCE(SUM(spans), 0) AS spans, COALESCE(SUM(tools), 0) AS tools, COALESCE(SUM(errors), 0) AS errors,
          COALESCE(SUM(duration_ms), 0) AS duration_ms, COALESCE(SUM(tokens_in), 0) AS tokens_in,
          COALESCE(SUM(tokens_out), 0) AS tokens_out, COALESCE(SUM(cost_usd), 0) AS cost_usd
     FROM mission_span_totals WHERE mission_id IN (SELECT value FROM json_each(?))`,
);
const listMissionsByTraceStmt = db.prepare(
  `SELECT * FROM missions WHERE trace_id = ? ORDER BY started_at ASC, id ASC`,
);
const listTasksByTraceStmt = db.prepare(
  `SELECT * FROM tasks WHERE trace_id = ? ORDER BY created_at ASC, id ASC`,
);
const listMessagesByTraceStmt = db.prepare(
  `SELECT * FROM agent_messages WHERE trace_id = ? ORDER BY created_at ASC, id ASC`,
);
const upsertSpansTx = db.transaction((ops: SpanOp[]): { opened: number; closed: number } => {
  let opened = 0;
  let closed = 0;
  for (const op of ops) {
    if (op.op === 'open') {
      const status = op.status ?? 'running';
      const endedAt = status === 'running' ? null : (op.ended_at ?? op.started_at);
      const r = openSpanStmt.run(
        op.id, op.trace_id, op.mission_id, op.parent_span_id ?? null,
        op.workflow_run_id ?? null, op.workflow_node_id ?? null, op.seq, op.kind, op.name,
        status, op.started_at, endedAt, endedAt === null ? null : endedAt - op.started_at,
        op.input ?? null, op.output ?? null, op.error ?? null,
        op.tokens_in ?? null, op.tokens_out ?? null, op.cost_usd ?? null,
        op.event_id_start ?? null, op.event_id_end ?? null,
      );
      opened += r.changes;
    } else {
      const endedAt = op.ended_at ?? Date.now();
      const r = closeSpanStmt.run(
        op.status, endedAt, endedAt,
        op.output ?? null, op.error ?? null,
        op.tokens_in ?? null, op.tokens_out ?? null, op.cost_usd ?? null,
        op.event_id_end ?? null,
        op.id,
      );
      closed += r.changes;
    }
  }
  return { opened, closed };
});

const listChildMissionsStmt = db.prepare(
  `SELECT * FROM missions WHERE parent_mission_id = ? ORDER BY started_at ASC`,
);
const listMissionsByTaskStmt = db.prepare(
  `SELECT * FROM missions WHERE task_id = ? ORDER BY started_at ASC`,
);
const setMissionDocumentedAtStmt = db.prepare(
  `UPDATE missions SET documented_at = ? WHERE id = ?`,
);
const countUserTurnsStmt = db.prepare(
  `SELECT COUNT(*) as n FROM events WHERE mission_id = ? AND type = 'user'`,
);

// `events`: the table grows without bound and
const getAllSettingsStmt = db.prepare(`SELECT key, value FROM settings`);
const setSettingStmt = db.prepare(
  `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
);
const deleteSettingStmt = db.prepare(`DELETE FROM settings WHERE key = ?`);

const insertCommandRequestStmt = db.prepare(
  `INSERT INTO command_requests (id, mission_id, owner_user_id, agent, command, note, session_id, project, mission_title, task_id, choices, origin_kind, origin_id, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
);
const getCommandRequestStmt = db.prepare(`SELECT * FROM command_requests WHERE id = ?`);
const settleCommandRequestStmt = db.prepare(
  `UPDATE command_requests SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
);
const countPendingCommandRequestsStmt = db.prepare(
  `SELECT project, COUNT(*) AS n FROM command_requests
   WHERE owner_user_id = ? AND status = 'pending' GROUP BY project`,
);

// a grouped MAX(timestamp) on it would cost a full scan on every UI poll, for a
const insertNotificationStmt = db.prepare(
  `INSERT INTO notifications (id, type, urgent, title, body, task_id, mission_id, anchor, source, created_at, owner_user_id, dismiss_on, expires_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const listActiveDismissOnByMissionStmt = db.prepare(
  `SELECT * FROM notifications WHERE mission_id = ? AND dismiss_on IS NOT NULL AND dismissed_at IS NULL`,
);
const listActiveDismissOnByTaskStmt = db.prepare(
  `SELECT * FROM notifications WHERE task_id = ? AND dismiss_on IS NOT NULL AND dismissed_at IS NULL`,
);
const listExpiredNotificationsStmt = db.prepare(
  `SELECT * FROM notifications WHERE dismissed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`,
);
const listActiveNotificationsStmt = db.prepare(
  `SELECT * FROM notifications WHERE dismissed_at IS NULL ORDER BY urgent DESC, created_at DESC LIMIT ?`,
);
const listAllNotificationsStmt = db.prepare(
  `SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`,
);
const getNotificationStmt = db.prepare(`SELECT * FROM notifications WHERE id = ?`);
const dismissNotificationStmt = db.prepare(
  `UPDATE notifications SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL`,
);
const dismissByTaskTypeStmt = db.prepare(
  `UPDATE notifications SET dismissed_at = ? WHERE task_id = ? AND type = ? AND dismissed_at IS NULL`,
);
const dismissByMissionTypeStmt = db.prepare(
  `UPDATE notifications SET dismissed_at = ? WHERE mission_id = ? AND type = ? AND dismissed_at IS NULL`,
);
// precision the projects-grid sort does not need (an agent that is working already
// bubbles up via its live state). ── settings prepared statements
const dismissByAnchorTypeStmt = db.prepare(
  `UPDATE notifications SET dismissed_at = ? WHERE anchor = ? AND type = ? AND dismissed_at IS NULL`,
);
// `substr` rather than LIKE: an anchor may hold `%` or `_`, which LIKE would read as wildcards.
const listActiveByAnchorPrefixTypeStmt = db.prepare(
  `SELECT * FROM notifications WHERE dismissed_at IS NULL AND type = ? AND anchor IS NOT NULL
     AND substr(anchor, 1, length(?)) = ? ORDER BY created_at DESC`,
);
const notificationAnchorsByPrefixStmt = db.prepare(
  `SELECT DISTINCT anchor FROM notifications WHERE anchor IS NOT NULL AND substr(anchor, 1, length(?)) = ?`,
);
const listActiveAllStmt = db.prepare(
  `SELECT * FROM notifications WHERE dismissed_at IS NULL ORDER BY created_at DESC`,
);
const listActiveByTypeStmt = db.prepare(
  `SELECT * FROM notifications WHERE dismissed_at IS NULL AND type = ? ORDER BY created_at DESC`,
);
const dismissAllStmt = db.prepare(
  `UPDATE notifications SET dismissed_at = ? WHERE dismissed_at IS NULL`,
);
const dismissAllByTypeStmt = db.prepare(
  `UPDATE notifications SET dismissed_at = ? WHERE dismissed_at IS NULL AND type = ?`,
);
const listActiveByMissionTypeStmt = db.prepare(
  `SELECT * FROM notifications WHERE mission_id = ? AND type = ? AND dismissed_at IS NULL ORDER BY created_at DESC`,
);
const countActiveNotificationsStmt = db.prepare(
  `SELECT COUNT(*) as n FROM notifications WHERE dismissed_at IS NULL`,
);
const countActiveByTypeStmt = db.prepare(
  `SELECT type, COUNT(*) as n FROM notifications WHERE dismissed_at IS NULL GROUP BY type`,
);

// ───────────────────────────────────────────── ── notifications prepared statements
// ──────────────────────────────────────── Targeted dismiss on the anchor (= the
// permission id): a mission can have several pending cards, resolving one must not
const upsertPushSubStmt = db.prepare(
  `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_label, created_at, last_seen_at, last_error)
   VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
   ON CONFLICT(endpoint) DO UPDATE SET
     p256dh = excluded.p256dh,
     auth = excluded.auth,
     device_label = COALESCE(excluded.device_label, push_subscriptions.device_label),
     last_seen_at = excluded.last_seen_at,
     last_error = NULL`,
);
const listPushSubsStmt = db.prepare(`SELECT * FROM push_subscriptions ORDER BY created_at`);
const getPushSubByEndpointStmt = db.prepare(`SELECT * FROM push_subscriptions WHERE endpoint = ?`);
const deletePushSubByEndpointStmt = db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`);
const deletePushSubStmt = db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`);
const setPushSubErrorStmt = db.prepare(`UPDATE push_subscriptions SET last_error = ? WHERE id = ?`);
const recordPushDeliveryStmt = db.prepare(
  `INSERT INTO push_deliveries (notification_id, subscription_id, status, sent_at, error)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(notification_id, subscription_id) DO UPDATE SET
     status = excluded.status, sent_at = excluded.sent_at, error = excluded.error`,
);
const getPushDeliveryStmt = db.prepare(
  `SELECT status FROM push_deliveries WHERE notification_id = ? AND subscription_id = ?`,
);
const deletePushDeliveriesForSubStmt = db.prepare(`DELETE FROM push_deliveries WHERE subscription_id = ?`);

// erase the others. ── web push prepared statements
const activeMissionsStmt = db.prepare(
  `SELECT id, agent_name, started_at FROM missions WHERE status = 'running' ORDER BY started_at DESC LIMIT 10`,
);
const recentEventCountStmt = db.prepare(
  `SELECT COUNT(*) as n FROM events WHERE timestamp >= ?`,
);
const sparklineStmt = db.prepare(
  `SELECT (timestamp / 3600000) as bucket, COUNT(*) as count
   FROM events WHERE timestamp >= ?
   GROUP BY bucket ORDER BY bucket ASC`,
);
const activityByAgentStmt = db.prepare(
  `SELECT m.agent_name as agent, COUNT(e.id) as count
   FROM events e JOIN missions m ON e.mission_id = m.id
   WHERE e.timestamp >= ?
   GROUP BY m.agent_name ORDER BY count DESC LIMIT 5`,
);
const taskCountsStmt = db.prepare(
  `SELECT status, COUNT(*) as n FROM tasks GROUP BY status`,
);

// ───────────────────────────────────────────── Re-subscribe of the same device: the
// browser sometimes returns the SAME endpoint (key
// rotation) — we update the row rather
const latestSessionStmt = db.prepare(
  `SELECT session_id FROM missions
   WHERE agent_name = ? AND session_id IS NOT NULL
   ORDER BY started_at DESC LIMIT 1`,
);

// than fail on UNIQUE. ── stats prepared statements
// ───────────────────────────────────────────────── Latest claude session_id for a
// given agent across all its missions — used
const missionBySessionStmt = db.prepare(
  `SELECT id, agent_name, backend_override, owner_user_id FROM missions
   WHERE session_id = ?
   ORDER BY started_at DESC LIMIT 1`,
);

export type Source = { channel: string; meta?: unknown };

// to pass --resume <sid> when spawning a new
export type WorkspaceRow = {
  slug: string;
  name: string;
  color: string | null;
  lead_agent: string | null;
  created_at: number;
  updated_at: number;
};

export type ProjectRow = {
  slug: string;
  name: string | null;
  color: string | null;
  icon: string | null;
  workspace: string | null;
  cwd: string | null;
  speech: string | null;
  kind: string | null; // mission so the new claude process picks up
  status: string; // where the previous one left off. Owner of
  last_activity: number | null;
  revenue_potential: number | null; // a provider session. Used to refuse a
  revenue_locked: number; // crossed `--resume`: a codex session id passed to
  progress: number | null; // claude (or the reverse) always fails, and the failure is silent in the UI — the
  score_rationale: string | null;
  score_updated_at: number | null;
  grepai_watch: string | null; // conversation restarts empty without saying so. ── Memory & project types (DB
  created_by: string | null; // `plugin:<id>` for a project a plugin registered
  created_at: number;
  updated_at: number;
};

export type LearningRow = {
  id: number;
  mission_id: string | null;
  agent: string | null;
  project: string | null;
  role: string | null;
  kind: string;
  text: string;
  hash: string | null;
  ts: number;
  status: string; // migration) ────────────────────────────────── 'client' | 'perso' | null 'active' |
};

export type MemoryRuleRow = {
  id: number;
  scope: string; // 'paused' | 'done' | 'archived' 0-100, passive revenue potential (scorer or manual)
  project: string | null;
  agent: string | null;
  role: string | null; // 0|1 — 1 = revenue_potential set by hand, scorer does not touch it 0-100, progress
  kind: string;
  text: string;
  source: string;
  created_at: number;
  status: string;      // toward ship (always auto) 'auto' | 'off' | null (= auto) 'raw' | 'synthesized' |
  tier: string;        // 'archived' 'project' | 'agent' | 'role' | 'global' job (scope='role'): coder |
  supersedes: number | null;
  support: number;
};

export type MemoryAuditRow = {
  id: number;
  ts: number;
  run_id: string | null;
  scope: string | null;
  project: string | null;
  agent: string | null;
  action: string;
  rule_id: number | null;
  target_rule_id: number | null;
  candidate_text: string | null;
  rationale: string | null;
  reverted: number;
};

export type MemoryProposalRow = {
  id: number;
  scope: string;
  project: string | null;
  agent: string | null;
  kind: string;
  text: string;
  rationale: string | null;
  cluster_size: number;
  source: string;
  status: string; // reviewer | merger | orchestrator | … 'active' | 'superseded' | 'archived' 'core' |
  created_at: number;
  decided_at: number | null;
  owner_user_id: string | null;
};

export type DreamProposalRow = {
  id: number;
  kind: string; // 'normal' 'pending' | 'accepted' | 'rejected'
  project: string | null;
  title: string;
  body: string;
  rationale: string | null;
  effort: string | null;
  conviction: number | null;
  sources: string | null; // 'improve' | 'opportunity' JSON array of
  status: string; // URLs 'pending' | 'accepted' | 'rejected' | 'snoozed'
  run_id: string | null;
  created_at: number;
  decided_at: number | null;
  snooze_until: number | null;
  owner_user_id: string | null;
};

export type ProjectTodoRow = {
  id: number;
  text: string;
  project: string | null;
  /** Agent name, or `user` when the idea comes from the cockpit. NULL = older than
   *  the column, unknown author. */
  author: string | null;
  status: string; // 'open' | 'done' | 'promoted'
  notes: string | null;
  created_at: number;
  updated_at: number;
  done_at: number | null;
  /** Task born from this idea, `null` if the idea was never promoted. Answers
   *  "where does this task come from?", and forbids a second promotion. */
  promoted_task_id: string | null;
  /** Urgency / nature tag, `null` = unclassified. */
  urgency: TodoUrgency | null;
  /** Progress tag, `null` = older than the tags (equivalent to `todo`). */
  progress: TodoProgress | null;
  owner_user_id: string | null;
};

/** Statuses of an idea. `promoted` CANNOT be set by hand: an idea only becomes it
 *  through the promotion, which creates the task in the same move. */
export type ProjectTodoStatus = 'open' | 'done' | 'promoted';
export type ProjectTodoEditableStatus = 'open' | 'done';

/** A place a task lives outside Timon (`task_external_ref`). */
export type TaskExternalRefRow = {
  id: number;
  task_id: string;
  /** System the ticket lives in (`github`, `linear`, `jira`…). */
  provider: string;
  /** The ticket's id in that system; `(provider, ref)` points at one task. */
  ref: string;
  url: string | null;
  label: string | null;
  /** Plugin that wrote the link, `null` when not said. */
  plugin_id: string | null;
  created_at: number;
};

/** A place an idea lives outside Timon (`todo_external_ref`). */
export type TodoExternalRefRow = {
  id: number;
  todo_id: number;
  /** System the ticket lives in (`github`, `discord`, `jira`…). */
  provider: string;
  /** The ticket's id in that system; `(provider, ref)` points at one idea. */
  ref: string;
  /** http(s) only — checked by `todo-links.ts` before any write. */
  url: string | null;
  label: string | null;
  /** Plugin that wrote the link, `null` when not said. */
  plugin_id: string | null;
  created_at: number;
};

/* ── Kanban series & backend cooldowns ──────────────────────────────────
   A SERIES is the set of tasks of one project, piloted by a single orchestrator
   mission. Its identity (`series_id`) is frozen; the mission that pilots it
   (`creator_mission_id`) can be replaced — backend switch on exhausted quota,
   wake mission taking the helm. Without this split, changing pilot lost the
   project. */

const seriesOfMissionStmt = db.prepare(
  `SELECT series_id FROM tasks
    WHERE (series_id = ? OR creator_mission_id = ?) AND series_id IS NOT NULL
    ORDER BY created_at ASC LIMIT 1`,
);
const listTasksBySeriesStmt = db.prepare(
  `SELECT * FROM tasks WHERE series_id = ? ORDER BY created_at ASC`,
);
const remapSeriesStmt = db.prepare(
  `UPDATE tasks SET creator_mission_id = ?, updated_at = ?
    WHERE series_id = ? AND status IN ('PENDING', 'IN_PROGRESS', 'BLOCKED')`,
);
const setTaskLlmStmt = db.prepare(
  `UPDATE tasks SET backend_override = ?, model_override = ?, scheduled_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'PENDING'`,
);
const setSeriesLlmStmt = db.prepare(
  `UPDATE tasks SET backend_override = ?, model_override = ?, updated_at = ?
    WHERE series_id = ? AND type = ? AND status IN ('PENDING', 'BLOCKED')`,
);
// `IS ?` so that a NULL group (tasks outside any group) matches as a value.
const setSeriesGroupLlmStmt = db.prepare(
  `UPDATE tasks SET backend_override = ?, model_override = ?, updated_at = ?
    WHERE series_id = ? AND type = ? AND plan_group IS ? AND status IN ('PENDING', 'BLOCKED')`,
);
const retargetPendingMessagesStmt = db.prepare(
  `UPDATE agent_messages SET to_mission = ? WHERE to_mission = ? AND status = 'pending'`,
);
const setSeriesFallbackStmt = db.prepare(
  `INSERT INTO series_fallbacks (series_id, scope, backend, model, updated_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(series_id, scope) DO UPDATE SET backend = excluded.backend,
     model = excluded.model, updated_at = excluded.updated_at`,
);
const getSeriesFallbackStmt = db.prepare(
  `SELECT * FROM series_fallbacks WHERE series_id = ? AND scope = ?`,
);
const listSeriesFallbacksStmt = db.prepare(
  `SELECT * FROM series_fallbacks WHERE series_id = ? ORDER BY scope ASC`,
);
const clearSeriesFallbackStmt = db.prepare(
  `DELETE FROM series_fallbacks WHERE series_id = ? AND scope = ?`,
);
const setSeriesRoleStmt = db.prepare(
  `INSERT INTO series_roles (series_id, scope, backend, model, updated_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(series_id, scope) DO UPDATE SET backend = excluded.backend,
     model = excluded.model, updated_at = excluded.updated_at`,
);
const getSeriesRoleStmt = db.prepare(
  `SELECT * FROM series_roles WHERE series_id = ? AND scope = ?`,
);
const listSeriesRolesStmt = db.prepare(
  `SELECT * FROM series_roles WHERE series_id = ? ORDER BY scope ASC`,
);
const clearSeriesRoleStmt = db.prepare(
  `DELETE FROM series_roles WHERE series_id = ? AND scope = ?`,
);
const setSeriesGroupFallbackStmt = db.prepare(
  `INSERT INTO series_group_fallbacks (series_id, plan_group, scope, backend, model, updated_at)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(series_id, plan_group, scope) DO UPDATE SET backend = excluded.backend,
     model = excluded.model, updated_at = excluded.updated_at`,
);
const getSeriesGroupFallbackStmt = db.prepare(
  `SELECT * FROM series_group_fallbacks WHERE series_id = ? AND plan_group = ? AND scope = ?`,
);
const listSeriesGroupFallbacksStmt = db.prepare(
  `SELECT * FROM series_group_fallbacks WHERE series_id = ? ORDER BY plan_group ASC, scope ASC`,
);
const clearSeriesGroupFallbackStmt = db.prepare(
  `DELETE FROM series_group_fallbacks WHERE series_id = ? AND plan_group = ? AND scope = ?`,
);
const setSeriesGroupRoleStmt = db.prepare(
  `INSERT INTO series_group_roles (series_id, plan_group, scope, backend, model, updated_at)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(series_id, plan_group, scope) DO UPDATE SET backend = excluded.backend,
     model = excluded.model, updated_at = excluded.updated_at`,
);
const getSeriesGroupRoleStmt = db.prepare(
  `SELECT * FROM series_group_roles WHERE series_id = ? AND plan_group = ? AND scope = ?`,
);
const listSeriesGroupRolesStmt = db.prepare(
  `SELECT * FROM series_group_roles WHERE series_id = ? ORDER BY plan_group ASC, scope ASC`,
);
const clearSeriesGroupRoleStmt = db.prepare(
  `DELETE FROM series_group_roles WHERE series_id = ? AND plan_group = ? AND scope = ?`,
);

// The causes requeued here are EXACTLY those that move a series onto its
// fallback plan (`BACKEND_FALLBACK_REASONS`), and the list is read from there
// rather than spelled out twice: a cause that switches the series without being
// requeued leaves its task BLOCKED on a plan already applied — movable work that
// nobody moves. All of them describe the state of a BACKEND, not of the work; a
// task blocked by an exhausted account or by the circuit breaker has nothing to
// fix, only somewhere else to start again.
// Task by task and not series-wide, because the caller does not always move the
// WHOLE series: a scope with no fallback (`--backend none`, or a backup that is
// dry itself) stays where it is, and unblocking it would send it back onto the
// dead backend at the next tick — the failure mode of the requeue, inverted.
const requeueRateLimitedStmt = db.prepare(
  `UPDATE tasks SET status = 'PENDING', interrupted_reason = NULL, blocked_reason = NULL,
                    mission_id = NULL, quota_resets_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'BLOCKED'
      AND interrupted_reason IN (${BACKEND_FALLBACK_REASONS.map((r) => `'${r}'`).join(', ')})`,
);

/**
 * Series to attach a task we create to.
 *
 * Without a creating mission, no series: a task created by hand on the CLI is
 * nobody's project. Otherwise we attach to the series this mission ALREADY pilots
 * (case of a pilot that took over an existing series), and failing that we open a
 * new series whose identity is this mission.
 */
/** Trace of a mission, NULL when unknown or when the mission does not exist. */
function missionTrace(missionId: string | null): string | null {
  if (!missionId) return null;
  return (missionTraceStmt.get(missionId) as { trace_id: string | null } | undefined)?.trace_id ?? null;
}

function resolveSeriesId(creatorMissionId: string | null): string | null {
  if (!creatorMissionId) return null;
  return resolveSeriesIdExisting(creatorMissionId) ?? creatorMissionId;
}

/** Series this mission ALREADY pilots, or null. Creates nothing: this is the
 *  question "does this project exist?", not "open one for me". */
function resolveSeriesIdExisting(missionId: string): string | null {
  const row = seriesOfMissionStmt.get(missionId, missionId) as
    | { series_id: string | null }
    | undefined;
  return row?.series_id ?? null;
}

/** Follow-up tasks (review/merge/doc) inherit the owner of the mission or series
 *  that spawned them, so Ada still sees the Kanban cards her work produced. A task
 *  with neither (created by hand, or by a mission without owner) falls back on the
 *  task it follows: a NULL owner is invisible to any viewer without `:read:all`,
 *  and the follow-up's own agent could then not even close it. */
function resolveTaskOwner(
  opts: { ownerUserId?: string | null; creatorMissionId?: string | null; parentTaskId?: string | null },
  seriesId: string | null,
): string | null {
  if (opts.ownerUserId !== undefined) return opts.ownerUserId;
  if (opts.creatorMissionId) {
    const mission = getMissionStmt.get(opts.creatorMissionId) as MissionRow | undefined;
    if (mission?.owner_user_id) return mission.owner_user_id;
  }
  if (seriesId) {
    const sibling = db.prepare(
      `SELECT owner_user_id FROM tasks WHERE series_id = ? AND owner_user_id IS NOT NULL LIMIT 1`,
    ).get(seriesId) as { owner_user_id: string } | undefined;
    if (sibling) return sibling.owner_user_id;
  }
  if (opts.parentTaskId) {
    const parent = getTaskStmt.get(opts.parentTaskId) as TaskRow | undefined;
    if (parent?.owner_user_id) return parent.owner_user_id;
    // The parent can itself predate this inheritance: its chain root may still be owned.
    if (parent?.verification_root_id) {
      const root = getTaskStmt.get(parent.verification_root_id) as TaskRow | undefined;
      if (root?.owner_user_id) return root.owner_user_id;
    }
  }
  return null;
}

function resolveNotificationOwner(n: {
  ownerUserId?: string | null;
  taskId?: string | null;
  missionId?: string | null;
}): string | null {
  if (n.ownerUserId !== undefined) return n.ownerUserId;
  if (n.taskId) {
    const task = getTaskStmt.get(n.taskId) as TaskRow | undefined;
    if (task?.owner_user_id) return task.owner_user_id;
  }
  if (n.missionId) {
    const mission = getMissionStmt.get(n.missionId) as MissionRow | undefined;
    if (mission?.owner_user_id) return mission.owner_user_id;
  }
  return null;
}

/**
 * Owner of a mission by lineage, for a token minted while the mission had no
 * active owner (`system` scope) — a fork, a delegated child or a task spawn can
 * race the owner, or the owner can be inactive at issuance. Walks
 * owner → fork → parent → task (mirroring `resolveTaskOwner` for the task hop),
 * cycle-guarded, so a child of an owned mission still acts as that owner.
 */
function resolveMissionOwner(missionId: string): string | null {
  const seen = new Set<string>();
  let current: string | null = missionId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const mission = getMissionStmt.get(current) as MissionRow | undefined;
    if (!mission) return null;
    if (mission.owner_user_id) return mission.owner_user_id;
    if (mission.forked_from && mission.forked_from !== current) {
      current = mission.forked_from;
      continue;
    }
    if (mission.parent_mission_id && mission.parent_mission_id !== current) {
      current = mission.parent_mission_id;
      continue;
    }
    if (mission.task_id) return resolveTaskOwner({ parentTaskId: mission.task_id }, null);
    return null;
  }
  return null;
}

const setBackendCooldownStmt = db.prepare(
  `INSERT INTO backend_cooldowns (backend, until, quota_window, noted_at, exact, kind)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(backend) DO UPDATE SET until = excluded.until,
     quota_window = excluded.quota_window, noted_at = excluded.noted_at,
     exact = excluded.exact, kind = excluded.kind`,
);
const getBackendCooldownStmt = db.prepare(`SELECT * FROM backend_cooldowns WHERE backend = ?`);
const listBackendCooldownsStmt = db.prepare(`SELECT * FROM backend_cooldowns ORDER BY until DESC`);
const clearBackendCooldownStmt = db.prepare(`DELETE FROM backend_cooldowns WHERE backend = ?`);

/** Scope of a fallback rule within a series. `'*'` applies to every task type not
 *  named explicitly; `'orchestrator'` targets the pilot mission and NEVER inherits
 *  from `'*'` (a review's fallback does not fit the one holding the project plan). */
export type FallbackScope = 'orchestrator' | '*' | TaskType;

export const FALLBACK_SCOPES: readonly FallbackScope[] = Object.freeze([
  'orchestrator', '*', ...TASK_TYPES,
]);

export function isFallbackScope(v: unknown): v is FallbackScope {
  return typeof v === 'string' && (FALLBACK_SCOPES as readonly string[]).includes(v);
}

export type SeriesFallbackRow = {
  series_id: string;
  scope: string;
  backend: string | null;
  model: string | null;
  updated_at: number;
};

/** Series-scoped LLM choice for one task type. Same shape as a fallback rule;
 *  `scope` is always a `TaskType`. */
export type SeriesRoleRow = SeriesFallbackRow;

/** A fallback rule or role choice of ONE group of volets of the series plan
 *  (`series_group_fallbacks` / `series_group_roles`, see their migration). */
export type SeriesGroupRuleRow = SeriesFallbackRow & { plan_group: string };

/**
 * Why a backend is sidelined. Three families, three lifetimes:
 *   - `rate_limit`: a usage window is full and reopens on its own;
 *   - `exhausted`: the account has no credit left (HTTP 402) — only a top-up
 *     brings it back;
 *   - `unavailable`: the circuit breaker (`backend-breaker.ts`) observed N
 *     sterile turns in a row. The cause is UNKNOWN, hence the shortest
 *     cooldown of the three: it may well be transient.
 */
export type BackendCooldownKind = 'rate_limit' | 'exhausted' | 'unavailable';

export type BackendCooldownRow = {
  backend: string;
  until: number;
  quota_window: string | null;
  noted_at: number;
  /** 1 when `until` comes from the provider, 0 when it is estimated. */
  exact: number;
  /** Cf. `BackendCooldownKind`. Kept as a free `string`: an old row written
   *  before a kind existed must stay readable. */
  kind: string;
};

/** A `secrets` row, exactly as stored — `value_enc` is sealed, never plaintext. */
export interface SecretRow {
  id: string;
  name: string;
  value_enc: string;
  mode: SecretMode;
  broker_spec: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

export type SecretGrantRow = SecretGrant;

/**
 * `inject` = resolved at spawn, `broker` = used by the daemon on behalf of an agent,
 * `reveal` = a superadmin re-displayed the value in the UI (attempts included),
 * `create` = an agent deposited a new secret through `/api/secrets/provision`,
 * `request` = the user typed a value an agent asked for (`secret_request`),
 * `erase` = such a value was destroyed at the end of its lifetime (used once, mission over),
 * `fill` = such a value was put into a browser page (`fill_credential`).
 */
export type SecretAccessKind = 'inject' | 'broker' | 'reveal' | 'create' | 'request' | 'erase' | 'fill';
export type SecretAccessOutcome = 'ok' | 'denied';

/** A journal line (§8). There is deliberately no `value` field to forget to omit. */
export interface SecretAccessRow {
  id: number;
  secret_id: string;
  name: string;
  mission_id: string | null;
  agent: string | null;
  at: number;
  kind: SecretAccessKind;
  outcome: SecretAccessOutcome;
  detail: string | null;
}

/** Input of `recordSecretAccess` / `recordSecretAccessMany`. Same fields, still no value. */
export type SecretAccessInput = {
  secret_id: string;
  name: string;
  mission_id?: string | null;
  agent?: string | null;
  kind: SecretAccessKind;
  outcome: SecretAccessOutcome;
  detail?: string | null;
  at?: number;
};

/** What the resolver consumes: a row plus the grants attached to it. */
export type SecretWithGrants = SecretRow & { grants: SecretGrantRow[] };

export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * The only ways an account comes to exist. `setup` is the first superadmin of an
 * install; `provider` is the account provider plugin (`ctx.accountProvider`);
 * `test` is accepted under the test runner only.
 */
export const ACCOUNT_SOURCES = ['setup', 'provider', 'test'] as const;
export type AccountSource = (typeof ACCOUNT_SOURCES)[number];

export class AccountSourceError extends Error {}

export { LEGACY_ACCOUNT_TABLES, type LegacyAccountTable };

function assertAccountSource(source: unknown): asserts source is AccountSource {
  if (!(ACCOUNT_SOURCES as readonly unknown[]).includes(source)) {
    throw new AccountSourceError('an account is created by the setup or by the account provider, nothing else');
  }
  // `NODE_TEST_CONTEXT` is set by the `node --test` runner itself, never by the daemon.
  if (source === 'test' && !process.env.NODE_TEST_CONTEXT) {
    throw new AccountSourceError('test accounts are created under the test runner only');
  }
}

export function isUserStatus(value: unknown): value is UserStatus {
  return typeof value === 'string' && (USER_STATUSES as readonly string[]).includes(value);
}

export type ColorScheme = 'light' | 'dark';

export type UserPrefs = {
  theme: string;
  layout: string;
  scheme: ColorScheme;
};

/**
 * Product defaults when `user_prefs` has no row for the caller.
 * Independent copy lives in `app/src/lib/auth.ts` (`DEFAULT_USER_PREFS`) —
 * keep the two aligned; the packages do not import each other.
 */
export const DEFAULT_USER_PREFS: UserPrefs = {
  // The built-in Timon theme plugin (`plugins/theme-timon`) since 0.1.7.
  // Accounts that existed before keep the product theme: their row is
  // written once when `theme_kept` appears.
  theme: 'theme-timon',
  layout: '@timon/ui-layout',
  scheme: 'dark',
};

export function isColorScheme(value: unknown): value is ColorScheme {
  return value === 'light' || value === 'dark';
}

/** A `users` row as the rest of the daemon sees it. `password_hash` never leaves dbApi. */
/** `users.welcome_stage`: the two screens an account made before the new onboarding is shown once. */
export const WELCOME_STAGES = ['signin', 'mascot'] as const;
export type WelcomeStage = typeof WELCOME_STAGES[number];
export function isWelcomeStage(value: unknown): value is WelcomeStage {
  return typeof value === 'string' && (WELCOME_STAGES as readonly string[]).includes(value);
}

export type UserRow = {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  status: UserStatus;
  is_superadmin: boolean;
  created_at: number;
  last_login_at: number | null;
  /** Service URL of the picture the user uploaded. `null` = show initials. */
  avatar_url: string | null;
};

/** A pending self-service email change, until its token is confirmed. */
export type EmailChangeRow = {
  token_hash: string;
  user_id: string;
  new_email: string;
  created_at: number;
  expires_at: number;
  confirmed_at: number | null;
};

export type SessionRow = {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen: number;
  user_agent: string | null;
};

/** A hashed API token (`docs/MULTI-USER.md` §3 / §6). Plaintext is never stored. */
export type ApiTokenRow = {
  token_hash: string;
  user_id: string | null;
  label: string | null;
  scope: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  mission_id: string | null;
};

/** Resolved live token: still valid, owner still active (when it is a user). */
export type LiveApiToken = {
  token: ApiTokenRow;
  user: UserRow | null;
  actorId: string;
  isSuperadmin: boolean;
  /**
   * Capped grants for a mission-bound token (secu-3). Always set when
   * `token.mission_id` is set; absent otherwise. Never contains `:all`.
   */
  permissions?: readonly string[];
};

export type AuditLogRow = {
  id: string;
  user_id: string | null;
  /** 'daemon' | 'api-token' | null (a user session). See `users/audit-actor.ts`. */
  actor: string | null;
  action: string;
  target: string | null;
  at: number;
  ip: string | null;
};

type UserDbRow = Omit<UserRow, 'is_superadmin' | 'status'> & {
  status: string;
  is_superadmin: number;
};

function toUserRow(row: UserDbRow): UserRow {
  return {
    ...row,
    status: isUserStatus(row.status) ? row.status : 'disabled',
    is_superadmin: row.is_superadmin === 1,
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isUniqueConstraint(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && (err as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function countActiveSuperadmins(exceptId?: string): number {
  if (exceptId) {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM users
        WHERE is_superadmin = 1 AND status = 'active' AND id != ?`,
    ).get(exceptId) as { n: number };
    return row.n;
  }
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE is_superadmin = 1 AND status = 'active'`,
  ).get() as { n: number };
  return row.n;
}

/**
 * `teams` stays out of `OWNED_TABLES`: that list mints a `<table>:read:all`
 * permission and a `scopedDb` member per entry, which is more machinery than a
 * label registry needs. Ownership is enforced here instead — a viewer sees and
 * edits its own teams, a superadmin sees them all, and an internal caller
 * (no viewer) is unscoped like everywhere else in `dbApi`.
 */
function teamOwnerSql(viewer: DbViewer | null | undefined): { sql: string; params: unknown[] } {
  if (!viewer || viewer.isSuperadmin) return { sql: '1=1', params: [] };
  return { sql: 'owner_user_id = ?', params: [viewer.id] };
}

function teamVisible(row: TeamRow, viewer: DbViewer | null | undefined): boolean {
  if (!viewer || viewer.isSuperadmin) return true;
  return row.owner_user_id === viewer.id;
}

export type BackendOverlayRow = {
  id: string; disabled: number; label: string | null; icon: string | null;
  brand: string | null; rank: number | null; models: string | null; updated_at: number;
};

/** Parses `raw`, applies `rename`, and returns the new JSON, or null when
 *  nothing changed (or the stored value is not JSON: left as it is). */
/** An event trigger whose filter a rename could not carry over: its owner has to read it. */
export type RenamedAgentTrigger = { id: string; name: string; owner_user_id: string | null };

function renameAgentInJson(raw: string, rename: (value: unknown) => boolean): string | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  return rename(value) ? JSON.stringify(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Hand-typed like trigger actions: compared without case, as `canonicalAgentName` resolves them. */
function sameAgent(value: unknown, name: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === name.toLowerCase();
}

/** `agent` nodes run `config.ref`; the memory nodes read and write `config.agent`. In place. */
export function renameAgentInWorkflowDefinition(definition: unknown, oldName: string, newName: string): boolean {
  if (!isRecord(definition) || !Array.isArray(definition.nodes)) return false;
  let changed = false;
  for (const node of definition.nodes) {
    if (!isRecord(node) || !isRecord(node.config)) continue;
    const key = node.type === 'agent' ? 'ref' : node.type === 'memory.read' || node.type === 'memory.write' ? 'agent' : null;
    if (key && sameAgent(node.config[key], oldName)) {
      node.config[key] = newName;
      changed = true;
    }
  }
  return changed;
}

/** A pipeline step names the agent its task is assigned to. In place. */
export function renameAgentInPipelineDefinition(definition: unknown, oldName: string, newName: string): boolean {
  if (!isRecord(definition) || !Array.isArray(definition.steps)) return false;
  let changed = false;
  for (const step of definition.steps) {
    if (isRecord(step) && sameAgent(step.agent, oldName)) {
      step.agent = newName;
      changed = true;
    }
  }
  return changed;
}

/**
 * The agent-chat cards (`{ instances: [{ agent, subAgents: [{ agent }] }] }`)
 * and the multichat templates (`{ templates: [{ agents: (string|null)[] }] }`),
 * shapes owned by the front (`agent-chat/instances.ts`, `multichat-templates.ts`).
 * Exact names only: that is how the front compares them. In place.
 */
export function renameAgentInLayout(scope: string, value: unknown, oldName: string, newName: string): boolean {
  if (!isRecord(value)) return false;
  let changed = false;
  if (scope === 'agent-chat' && Array.isArray(value.instances)) {
    for (const card of value.instances) {
      if (!isRecord(card)) continue;
      if (card.agent === oldName) { card.agent = newName; changed = true; }
      if (!Array.isArray(card.subAgents)) continue;
      for (const sub of card.subAgents) {
        if (isRecord(sub) && sub.agent === oldName) { sub.agent = newName; changed = true; }
      }
    }
  }
  if (scope === 'multichat.templates' && Array.isArray(value.templates)) {
    for (const template of value.templates) {
      if (!isRecord(template) || !Array.isArray(template.agents)) continue;
      template.agents = template.agents.map((agent: unknown) => {
        if (agent !== oldName) return agent;
        changed = true;
        return newName;
      });
    }
  }
  return changed;
}

export const dbApi = {
  listBackendOverlays(): BackendOverlayRow[] {
    return db.prepare('SELECT * FROM backend_overlays').all() as BackendOverlayRow[];
  },
  saveBackendOverlay(row: BackendOverlayRow): void {
    db.prepare(`INSERT INTO backend_overlays (id, disabled, label, icon, brand, rank, models, updated_at)
      VALUES (@id, @disabled, @label, @icon, @brand, @rank, @models, @updated_at)
      ON CONFLICT(id) DO UPDATE SET disabled=excluded.disabled, label=excluded.label,
      icon=excluded.icon, brand=excluded.brand, rank=excluded.rank,
      models=excluded.models, updated_at=excluded.updated_at`).run(row);
  },

  // ── tasks ──────────────────────────────────────────────────────────────────
  createTask(
    id: string,
    title: string,
    agentName: string,
    opts: {
      description?: string | null;
      priority?: number;
      deps?: string[];
      scheduledAt?: number | null;
      extraSkills?: string[];
      extraMcpServers?: string[];
      extraAllowedTools?: string[];
      type?: TaskType;
      backendOverride?: string | null;
      modelOverride?: string | null;
      /** EXPLICIT fallback for THIS task (wins over the series and the global setting).
       *  'none' = explicit refusal of any automatic fallback. */
      fallbackBackendOverride?: string | null;
      fallbackModelOverride?: string | null;
      reasoningEffort?: string | null;
      permissionModeOverride?: string | null;
      /** Identifier of the batch of tasks created together by the orchestrator. */
      groupId?: string | null;
      /** Orchestrator mission that created the task (parent lineage). */
      creatorMissionId?: string | null;
      /** Explicit attachment to a series. Pass this for tasks created by the
       *  orchestrator ITSELF in reaction to another task (review, merge, doc,
       *  iteration): it is not an agent mission that creates them, so
       *  `creatorMissionId` is not enough to attach them to the project — without
       *  it they escape the fallback plan and return routing. */
      seriesId?: string | null;
      /** 'full' (default) | 'code-self' | 'code-group' — see isCodeOnlyPipeline. */
      pipeline?: string | null;
      /** Explicit project slug (wins over the one derived from the agent). */
      project?: string | null;
      /** Base branch of the job, recorded at creation. The orchestrator's own
       *  children (review, merge, doc, iteration) pass their root's base so the
       *  merge advances THAT branch instead of the repo's active one. */
      baseBranch?: string | null;
      /** Owning account. Absent → inherit from the creator mission / series,
       *  then from `parentTaskId`. */
      ownerUserId?: string | null;
      /** Task this one follows (review/merge/doc/iteration): last-resort source of
       *  the owner when neither mission nor series carries one. */
      parentTaskId?: string | null;
      /** Causal root. Absent → the creator mission's trace (W.0). */
      traceId?: string | null;
      /** The work return never goes up to the pilot (see `silent_return`). */
      silentReturn?: boolean;
      /** Inert image of an external ticket (see the `mirror` migration). */
      mirror?: boolean;
      /** Group of volets in the series plan (see the `plan_group` migration).
       *  The chain's own children pass their root's, so the whole volet runs
       *  on the group's LLM. */
      planGroup?: string | null;
    } = {},
  ): void {
    const now = Date.now();
    const seriesId = opts.seriesId ?? resolveSeriesId(opts.creatorMissionId ?? null);
    const traceId = opts.traceId ?? missionTrace(opts.creatorMissionId ?? null);
    insertTaskStmt.run(
      id,
      title,
      opts.description ?? null,
      agentName,
      opts.priority ?? 3,
      JSON.stringify(opts.deps ?? []),
      now,
      now,
      opts.scheduledAt ?? null,
      opts.extraSkills?.length ? JSON.stringify(opts.extraSkills) : null,
      opts.extraMcpServers?.length ? JSON.stringify(opts.extraMcpServers) : null,
      opts.extraAllowedTools?.length ? JSON.stringify(opts.extraAllowedTools) : null,
      opts.type ?? 'chore',
      opts.backendOverride ?? null,
      opts.modelOverride ?? null,
      opts.fallbackBackendOverride ?? null,
      opts.fallbackModelOverride ?? null,
      opts.permissionModeOverride ?? null,
      opts.groupId ?? null,
      opts.creatorMissionId ?? null,
      seriesId,
      opts.pipeline ?? null,
      opts.project ?? null,
      resolveTaskOwner(opts, seriesId),
      traceId,
      opts.mirror ? 1 : 0,
      opts.planGroup ?? null,
    );
    if (opts.silentReturn) markTaskSilentReturnStmt.run(id);
    if (opts.baseBranch) setTaskBaseBranchStmt.run(opts.baseBranch, now, id);
    if (opts.parentTaskId) setTaskParentStmt.run(opts.parentTaskId, id);
    bus.publish({ kind: 'task_created', taskId: id });
  },
  getTask(id: string, viewer?: DbViewer | null): TaskRow | undefined {
    return rowVisible(getTaskStmt.get(id) as TaskRow | undefined, viewer, 'tasks');
  },
  listTasks(status?: TaskStatus, viewer?: DbViewer | null): TaskRow[] {
    const owner = ownerSql(viewer, 'tasks');
    if (owner.sql === '1=1') {
      if (status) return listTasksByStatusStmt.all(status) as TaskRow[];
      return listTasksStmt.all() as TaskRow[];
    }
    const where = status ? 'status = ? AND owner_user_id = ?' : 'owner_user_id = ?';
    const params = status ? [status, ...owner.params] : owner.params;
    return db.prepare(
      `SELECT * FROM tasks WHERE ${where} ORDER BY priority DESC, created_at ASC`,
    ).all(...params) as TaskRow[];
  },
  /** Tasks eligible for dispatch: PENDING, deps satisfied (caller checks deps),
   *  scheduled_at in the past or unset. */
  listPendingReady(): TaskRow[] {
    return listPendingReadyStmt.all(Date.now()) as TaskRow[];
  },
  countInProgress(): number {
    return (countInProgressStmt.get() as { n: number }).n;
  },
  updateTaskStatus(
    id: string,
    status: TaskStatus,
    opts: { blockedReason?: string | null; doneComment?: string | null } = {},
  ): void {
    const prev = getTaskStmt.get(id) as TaskRow | undefined;
    // §7, at the entry rather than at the SQL: `guardMergeDone` reads the text
    // (it extracts the merge sha from it, unaffected by masking) and
    // `task_blocked` republishes the reason on the bus. Both inherit the mask.
    opts = {
      ...opts,
      doneComment: redactNullable(opts.doneComment),
      blockedReason: redactNullable(opts.blockedReason),
    };
    const g = guardMergeDone(prev, status, opts.blockedReason ?? null, opts.doneComment ?? prev?.done_comment ?? null);
    updateTaskStatusStmt.run(
      g.status,
      Date.now(),
      g.blockedReason,
      opts.doneComment ?? null,
      id,
    );
    // Sha extracted from the comment (merger fallback) → we persist it for audit. New
    if (g.mergedSha) setTaskMergedShaStmt.run(g.mergedSha, Date.now(), id);
    if (g.status === 'BLOCKED' && prev?.status !== 'BLOCKED') {
      bus.publish({ kind: 'task_blocked', taskId: id, reason: g.blockedReason });
    }
    if (g.status !== 'BLOCKED' && prev?.status === 'BLOCKED') {
      bus.publish({ kind: 'task_unblocked', taskId: id });
    }
    if (g.status === 'DONE' && prev?.status !== 'DONE') {
      bus.publish({ kind: 'task_done', taskId: id });
    }
    publishTaskDiff(prev);
  },
  /** For a writer outside this file that moved a task with its own SQL
   *  (`scope-stop.ts`): `prev` is the row read before the write. */
  publishTaskChange(prev: TaskRow | undefined): void {
    publishTaskDiff(prev);
  },
  assignTaskMission(id: string, missionId: string): void {
    const prev = getTaskStmt.get(id) as TaskRow | undefined;
    assignTaskMissionStmt.run(missionId, Date.now(), id);
    // execution = new reporting cycle: the
    // previous attempt's return must not silence this
    // (a `silent_return` task is re-armed as already reported: it never reports)
    rearmReturnNotifiedStmt.run(id);
    // one's. Same for chaining: a task sent
    // back to the coder (or re-dispatched) must be
    // able to re-create its review / merge at its new closure — and start again with a
    // fresh attempt counter, including after an abandon in CHAIN_FAILED: re-dispatch is
    // precisely how to replay a permanently abandoned chain.
    resetChainStmt.run(id);
    const firstStart = markTaskStartedStmt.run(Date.now(), id).changes === 1;
    publishTaskDiff(prev);
    if (firstStart) bus.publish({ kind: 'task_started', taskId: id, followUp: !!prev?.parent_task_id });
  },
  /** Rename every reference to an agent (the name is the identity key).
   *  Called by renameAgent (agent.ts) after moving the directory. Returns what
   *  could not be carried over safely, for the caller to tell the user.
   *  `otherAgents`: the other names of the install, which a substring filter
   *  may also read. */
  renameAgentRefs(oldName: string, newName: string, otherAgents: readonly string[] = []): { warnings: string[]; triggersToCheck: RenamedAgentTrigger[] } {
    const warnings: string[] = [];
    const triggersToCheck: RenamedAgentTrigger[] = [];
    db.transaction(() => {
      db.prepare('UPDATE missions SET agent_name = ? WHERE agent_name = ?').run(newName, oldName);
      db.prepare('UPDATE missions SET parent_agent = ? WHERE parent_agent = ?').run(newName, oldName);
      db.prepare('UPDATE tasks SET agent_name = ? WHERE agent_name = ?').run(newName, oldName);
      db.prepare('UPDATE routines SET agent_name = ? WHERE agent_name = ?').run(newName, oldName);
      db.prepare('UPDATE agent_messages SET from_agent = ? WHERE from_agent = ?').run(newName, oldName);
      db.prepare('UPDATE agent_messages SET to_agent = ? WHERE to_agent = ?').run(newName, oldName);
      // The memory injected into an agent lives here, not in its directory:
      // left behind, an agent-scoped rule would follow nobody.
      db.prepare('UPDATE memory_rules SET agent = ? WHERE agent = ?').run(newName, oldName);
      // Same for the skills attached to the agent itself.
      db.prepare(`UPDATE OR IGNORE skill_attachments SET target = ? WHERE scope = 'agent' AND target = ?`).run(newName, oldName);
      db.prepare(`DELETE FROM skill_attachments WHERE scope = 'agent' AND target = ?`).run(oldName);
      db.prepare('UPDATE skill_reads SET agent = ? WHERE agent = ?').run(newName, oldName);
      // An approval follows the agent it was given to, not its old name.
      db.prepare('UPDATE approval_rules SET agent = ? WHERE agent = ?').run(newName, oldName);
      db.prepare('UPDATE memory_proposals SET agent = ? WHERE agent = ?').run(newName, oldName);
      db.prepare('UPDATE learnings SET agent = ? WHERE agent = ?').run(newName, oldName);
      // `acting_agent` is re-checked at every run: an old name would make the
      // trigger fail its delegation check from then on.
      db.prepare('UPDATE triggers SET creator_agent = ? WHERE creator_agent = ?').run(newName, oldName);
      db.prepare('UPDATE triggers SET acting_agent = ? WHERE acting_agent = ?').run(newName, oldName);
      db.prepare('UPDATE workspaces SET lead_agent = ? WHERE lead_agent = ?').run(newName, oldName);
      // A secret granted to the agent is injected by name. OR IGNORE: a stale
      // grant to a since-deleted agent of the new name already gives the same
      // access, so the old row is simply dropped.
      db.prepare(`UPDATE OR IGNORE secret_grants SET scope_ref = ? WHERE scope_kind = 'agent' AND scope_ref = ?`).run(newName, oldName);
      db.prepare(`DELETE FROM secret_grants WHERE scope_kind = 'agent' AND scope_ref = ?`).run(oldName);
      // Routines live in `triggers` now: the agent a task action runs is inside
      // the actions JSON, which the frozen `routines` table above no longer feeds.
      const withAgent = db.prepare(`SELECT id, actions FROM triggers WHERE actions LIKE '%"agent"%'`).all() as Array<{ id: string; actions: string }>;
      const setActions = db.prepare('UPDATE triggers SET actions = ? WHERE id = ?');
      for (const row of withAgent) {
        let actions: unknown;
        try { actions = JSON.parse(row.actions); } catch { continue; }
        if (!Array.isArray(actions)) continue;
        let changed = false;
        // Case-insensitive like the hierarchy rewrite: these are typed by hand
        // and `canonicalAgentName` resolves them that way.
        const next = actions.map((a: unknown) => {
          const agent = a && typeof a === 'object' ? (a as { agent?: unknown }).agent : undefined;
          if (typeof agent === 'string' && agent.toLowerCase() === oldName.toLowerCase()) {
            changed = true;
            return { ...(a as Record<string, unknown>), agent: newName };
          }
          return a;
        });
        if (changed) setActions.run(JSON.stringify(next), row.id);
      }
      // An event trigger filtering on the agent stops matching once its name
      // changes. Exact equality and leaves spelling exactly the old name are
      // rewritten; any other pattern or substring naming it is a guess, so it
      // is reported instead. Webhook filters read a foreign payload: not ours.
      const filtered = db.prepare(`SELECT id, name, filter, owner_user_id FROM triggers WHERE source = 'event' AND filter IS NOT NULL`).all() as Array<RenamedAgentTrigger & { filter: string }>;
      const setFilter = db.prepare('UPDATE triggers SET filter = ? WHERE id = ?');
      for (const row of filtered) {
        let filter: unknown;
        try { filter = JSON.parse(row.filter); } catch { continue; }
        const outcome = renameAgentInEventFilter(filter, oldName, newName, otherAgents);
        if (outcome.changed) setFilter.run(JSON.stringify(outcome.filter), row.id);
        if (outcome.unsure) triggersToCheck.push({ id: row.id, name: row.name, owner_user_id: row.owner_user_id });
      }
      // Credentials live in storage keyed by the profile id, so only the
      // reference moves. OR IGNORE, never a delete: a leftover agent profile
      // already holding the new name keeps its own credentials, and the old
      // one is reported rather than dropped.
      db.prepare(`UPDATE OR IGNORE browser_profiles SET scope_ref = ?, updated_at = ? WHERE scope_kind = 'agent' AND scope_ref = ?`).run(newName, Date.now(), oldName);
      const stranded = db.prepare(`SELECT name FROM browser_profiles WHERE scope_kind = 'agent' AND scope_ref = ?`).all(oldName) as Array<{ name: string }>;
      for (const p of stranded) warnings.push(`browser profile "${p.name}": a profile already exists for "${newName}", this one still targets "${oldName}"`);
      // Grant lists compare exactly (`browserProfileAllows`): only the exact
      // name moves, never a differently cased one that never granted access.
      const granted = db.prepare(`SELECT id, grants FROM browser_profiles WHERE grants LIKE '%"agent_names"%'`).all() as Array<{ id: string; grants: string }>;
      const setGrants = db.prepare('UPDATE browser_profiles SET grants = ?, updated_at = ? WHERE id = ?');
      for (const row of granted) {
        let grants: { agent_names?: unknown } & Record<string, unknown>;
        try { grants = JSON.parse(row.grants) as typeof grants; } catch { continue; }
        const names = grants.agent_names;
        if (!Array.isArray(names) || !names.includes(oldName)) continue;
        const next = [...new Set(names.map((n: unknown) => (n === oldName ? newName : n)))];
        setGrants.run(JSON.stringify({ ...grants, agent_names: next }), Date.now(), row.id);
      }
      // A workflow runs its pilot and the agents its nodes name by name; a
      // published version is what the next run reads, so it moves too.
      db.prepare('UPDATE workflows SET agent_name = ? WHERE agent_name = ?').run(newName, oldName);
      const setDraft = db.prepare('UPDATE workflows SET draft = ? WHERE id = ?');
      for (const row of db.prepare(`SELECT id, draft FROM workflows WHERE draft LIKE '%"nodes"%'`).all() as Array<{ id: string; draft: string }>) {
        const next = renameAgentInJson(row.draft, (value) => renameAgentInWorkflowDefinition(value, oldName, newName));
        if (next !== null) setDraft.run(next, row.id);
      }
      const setVersion = db.prepare('UPDATE workflow_versions SET definition = ? WHERE workflow_id = ? AND version = ?');
      for (const row of db.prepare(`SELECT workflow_id, version, definition FROM workflow_versions WHERE definition LIKE '%"nodes"%'`).all() as Array<{ workflow_id: string; version: number; definition: string }>) {
        const next = renameAgentInJson(row.definition, (value) => renameAgentInWorkflowDefinition(value, oldName, newName));
        if (next !== null) setVersion.run(next, row.workflow_id, row.version);
      }
      const setPipeline = db.prepare('UPDATE pipelines SET definition = ?, updated_at = ? WHERE id = ?');
      for (const row of db.prepare(`SELECT id, definition FROM pipelines WHERE definition LIKE '%"agent"%'`).all() as Array<{ id: string; definition: string }>) {
        const next = renameAgentInJson(row.definition, (value) => renameAgentInPipelineDefinition(value, oldName, newName));
        if (next !== null) setPipeline.run(next, Date.now(), row.id);
      }
      // Two layout rows name agents: the agent-chat cards and the multichat
      // templates. The front stores names as `agents/` spells them, so only
      // the exact name moves. A plain UPDATE, not `uiLayoutSet`: a guarded
      // write (`?expected=`) racing this one is refused and reloads.
      const setLayout = db.prepare('UPDATE ui_layout SET value = ?, updated_at = ? WHERE owner = ? AND scope = ?');
      for (const row of db.prepare(`SELECT owner, scope, value, updated_at FROM ui_layout WHERE scope IN ('agent-chat', 'multichat.templates')`).all() as Array<{ owner: string; scope: string; value: string; updated_at: number }>) {
        const next = renameAgentInJson(row.value, (value) => renameAgentInLayout(row.scope, value, oldName, newName));
        if (next !== null) setLayout.run(next, Math.max(Date.now(), row.updated_at + 1), row.owner, row.scope);
      }
      // Left as history on purpose: memory_audit, secret_access and
      // command_requests journal what happened under the old name, and an
      // mcp_tokens row is bound to a mission, which cannot be running here.
    })();
    return { warnings, triggersToCheck };
  },
  updateTask(
    id: string,
    fields: {
      title?: string | null;
      description?: string | null;
      agentName?: string | null;
      priority?: number | null;
      deps?: string[] | null;
      scheduledAt?: number | null;
      /** Erase sentinel: the only way to reset `scheduled_at` to NULL (passing
       *  `scheduledAt: null` is a no-op, see the statement comment). Wins over
       *  `scheduledAt` if both are provided. */
      clearScheduledAt?: boolean;
      extraSkills?: string[] | null;
      extraMcpServers?: string[] | null;
      extraAllowedTools?: string[] | null;
      type?: TaskType | null;
      /** `undefined` keeps the override, `null` clears it so the project role
       *  decides again: a requeue correction must be able to drop a backend that
       *  keeps killing the task (TIM-0065, `isCorrection`). */
      backendOverride?: string | null;
      modelOverride?: string | null;
      fallbackBackendOverride?: string | null;
      fallbackModelOverride?: string | null;
      /** Clear both fallback columns; wins over values sent in the same update. */
      clearFallback?: boolean;
      reasoningEffort?: string | null;
      permissionModeOverride?: string | null;
      /** Restore the agent's mode; `permissionModeOverride: null` stays a no-op. */
      clearPermissionMode?: boolean;
    },
  ): void {
    const prev = getTaskStmt.get(id) as TaskRow | undefined;
    updateTaskStmt.run(
      fields.title ?? null,
      fields.description ?? null,
      fields.agentName ?? null,
      fields.priority ?? null,
      fields.deps !== undefined ? JSON.stringify(fields.deps) : null,
      fields.clearScheduledAt ? 1 : 0,
      fields.scheduledAt ?? null,
      fields.extraSkills !== undefined ? (fields.extraSkills?.length ? JSON.stringify(fields.extraSkills) : null) : undefined,
      fields.extraMcpServers !== undefined ? (fields.extraMcpServers?.length ? JSON.stringify(fields.extraMcpServers) : null) : undefined,
      fields.extraAllowedTools !== undefined ? (fields.extraAllowedTools?.length ? JSON.stringify(fields.extraAllowedTools) : null) : undefined,
      fields.type ?? null,
      fields.backendOverride !== undefined ? 1 : 0,
      fields.backendOverride ?? null,
      fields.modelOverride !== undefined ? 1 : 0,
      fields.modelOverride ?? null,
      fields.clearFallback ? 1 : 0,
      fields.fallbackBackendOverride ?? null,
      fields.clearFallback ? 1 : 0,
      fields.fallbackModelOverride ?? null,
      fields.clearPermissionMode ? 1 : 0,
      fields.permissionModeOverride ?? null,
      Date.now(),
      id,
    );
    // Requalifying a BLOCKED task gives it a new set of guards: the old type's reason
    // no longer describes it (see `clearBlockedReasonsStmt`).
    if (prev?.status === 'BLOCKED' && fields.type && fields.type !== prev.type) {
      clearBlockedReasonsStmt.run(Date.now(), id);
    }
    publishTaskDiff(prev);
  },
  getTaskByMission(missionId: string): TaskRow | undefined {
    return getTaskByMissionStmt.get(missionId) as TaskRow | undefined;
  },
  /**
   * Deletes a task, or with `chain` the whole verification chain it heads
   * (root, iterations, reviews and the merges hanging off them). Every task
   * deleted passes the same guards; `canDelete` lets the caller refuse a task
   * the viewer cannot see, checked inside the transaction like the rest.
   */
  deleteTask(
    id: string,
    opts: { chain?: boolean; canDelete?: (task: TaskRow) => boolean } = {},
  ): TaskDeleteOutcome {
    // Taken inside the transaction, published once it committed: the cascade
    // removes the refs with the row, and a rolled-back delete announces nothing.
    const snapshots: TaskDeletedSnapshot[] = [];
    // Keep guards and deletion atomic so dispatch cannot attach new work between them.
    const result = db.transaction((): TaskDeleteOutcome => {
      const task = getTaskStmt.get(id) as TaskRow | undefined;
      const outcome = (result: TaskDeleteResult, at: string, blockers: TaskRow[], chain: TaskRow[]): TaskDeleteOutcome =>
        ({ result, taskId: at, blockers, chain: chain.map((t) => t.id) });
      if (!task) return outcome('not_found', id, [], []);
      const members = !task.verification_root_id && isVerificationRootStmt.get(id)
        ? dbApi.listVerificationChain(id)
        : [task];
      const targets = opts.chain ? members : [task];
      for (const t of targets) {
        if (opts.canDelete && !opts.canDelete(t)) return outcome('forbidden', t.id, [], members);
        if (t.status === 'IN_PROGRESS') return outcome('state', t.id, [], members);
        // A reference to a folder that is gone (removed by hand with git) protects
        // nothing and would block the delete for good (TIM-0113).
        if (t.worktree_path && existsSync(t.worktree_path)) return outcome('worktree', t.id, [], members);
      }
      const memberIds = new Set(members.map((t) => t.id));
      const external = new Map<string, TaskRow>();
      for (const t of targets) {
        for (const d of listTaskDependentsStmt.all(t.id) as TaskRow[]) {
          if (!memberIds.has(d.id)) external.set(d.id, d);
        }
      }
      if (external.size > 0) return outcome('dependents', task.id, [...external.values()], members);
      if (!opts.chain && members.length > 1) {
        return outcome('chain', task.id, members.filter((t) => t.id !== task.id), members);
      }
      for (const t of targets) {
        if (db.prepare(`SELECT 1 FROM missions WHERE status = 'running'
            AND (task_id = ? OR id = ?) LIMIT 1`).get(t.id, t.mission_id)) return outcome('mission', t.id, [], members);
        if (db.prepare('SELECT 1 FROM pipeline_run_steps WHERE task_id = ? LIMIT 1').get(t.id)) {
          return outcome('pipeline', t.id, [], members);
        }
      }
      // Leaves first: a child is always created after the task it hangs off.
      for (const t of [...targets].sort((a, b) => b.created_at - a.created_at)) {
        const links = (db.prepare(`SELECT * FROM task_external_ref WHERE task_id = ? ORDER BY created_at, id`).all(t.id) as TaskExternalRefRow[])
          .map((l) => Object.freeze({
            provider: l.provider, ref: l.ref, url: l.url, label: l.label, plugin_id: l.plugin_id, created_at: l.created_at,
          }));
        snapshots.push(Object.freeze({
          id: t.id, title: t.title, agent_name: t.agent_name, status: t.status, type: t.type, project: t.project,
          owner_user_id: t.owner_user_id, mirror: t.mirror === 1, links: Object.freeze(links),
        }));
        deleteTaskStmt.run(t.id);
      }
      return outcome('deleted', task.id, [], targets);
    }).immediate();
    for (const snapshot of snapshots) bus.publish({ kind: 'task_deleted', taskId: snapshot.id, task: snapshot });
    return result;
  },
  setTaskWorktree(id: string, path: string, branch: string, base: string): void {
    setTaskWorktreeStmt.run(path, branch, base, Date.now(), id);
  },
  clearTaskWorktree(id: string): void {
    clearTaskWorktreeStmt.run(id);
  },
  /** Drops the worktree folder's path, keeps `branch_name` / `base_branch`. */
  detachTaskWorktree(id: string): void {
    detachTaskWorktreeStmt.run(Date.now(), id);
  },
  /** `null` clears the sha: it then designates a merge judged incorrect, and the
   *  close guard must demand the one from the repair (see merge-integrity). */
  setTaskMergedSha(id: string, sha: string | null): void {
    setTaskMergedShaStmt.run(sha, Date.now(), id);
  },
  /** Adds a note to a closed task's report without a status transition, so
   *  nothing that follows a close (return, chain) runs again. */
  appendTaskDoneComment(id: string, text: string): void {
    const prev = getTaskStmt.get(id) as TaskRow | undefined;
    appendTaskDoneCommentStmt.run({ id, text, now: Date.now() });
    publishTaskDiff(prev);
  },
  setTaskDoneSummary(id: string, summary: string | null): void {
    setTaskDoneSummaryStmt.run(summary, id);
  },
  setTaskRoutine(id: string, routineId: string | null): void {
    setTaskRoutineStmt.run(routineId, Date.now(), id);
  },
  setTaskVerificationMeta(id: string, iteration: number, rootId: string | null): void {
    setTaskVerificationMetaStmt.run(iteration, rootId, Date.now(), id);
  },
  /**
   * Handle SYSTEM DEATH of a task's mission (the agent never had a chance to
   * close). Reserved to the orchestrator: a business block goes through
   * `updateTaskStatus`, which leaves `interrupted_reason` NULL.
   *
   * Two outcomes depending on the cause:
   *   - requeueable cause (see `isRequeueableInterruption`) and cap not reached →
   *     the task goes back to PENDING. An idle-mission reap or an orchestrator restart
   *     says NOTHING about the work: leaving it BLOCKED freezes the task until a
   *     human sees it (night of 2026-08-15).
   *   - otherwise → qualified BLOCKED, as before.
   *
   * No-op if the task is already terminal: when the agent wrote its
   * done_comment/blocked_reason just before exit, its verdict wins.
   *
   * Returns the outcome so the caller logs fairly and escalates at the cap
   * (the notification lives on the dispatcher side: `notify.ts` imports `db.ts`).
   */
  setTaskInterrupted(
    id: string,
    reason: InterruptionReason,
    blockedReason: string,
    quotaResetsAt: number | null = null,
  ): TaskInterruptionOutcome {
    const prev = getTaskStmt.get(id) as TaskRow | undefined;
    // Terminal status = the agent reached its own guard (business verdict, close
    // guard) and its verdict wins. This is the ONLY reliable read: `blocked_reason`
    // may carry the residue of an earlier blockage, it is not reset to NULL on
    // re-dispatch (see assignTaskMissionStmt).
    if (!prev || prev.status === 'DONE' || prev.status === 'BLOCKED') return 'noop';
    const requeueable = isRequeueableInterruption(reason);
    const attempt = (prev.requeue_count ?? 0) + 1;
    if (requeueable && attempt <= MAX_SYSTEM_REQUEUES) {
      // Exponential backoff: replaying a task the instant its mission died
      // hammers a backend that fails in 300 ms (night of 2026-09-01, three
      // respawns in three minutes).
      requeueInterruptedStmt.run(Date.now() + requeueBackoffMs(attempt), Date.now(), id);
      publishTaskDiff(prev);
      return 'requeued';
    }
    // Counted BEFORE the block: `task_blocked` wakes the pilot synchronously,
    // and its recap reads this count to say whether a requeue is still open.
    if (countsTowardCrashLoop(reason)) countSystemDeathStmt.run(id);
    blockOnInterruption(id, reason, blockedReason, quotaResetsAt);
    // Cap reached: this is no longer a fluke, the caller must warn a human.
    return requeueable ? 'escalated' : 'blocked';
  },
  /** A human restarted the task: the deaths before it no longer count. */
  resetTaskRequeues(id: string): void {
    resetTaskRequeuesStmt.run(Date.now(), id);
  },
  /** One more death read as a quota wall on the exclusion alone. */
  countBlindQuotaDeath(id: string): void {
    countBlindQuotaDeathStmt.run(id);
  },
  /** Postpones dispatch until `until` at the earliest, never earlier than a
   *  date already set. */
  deferTask(id: string, until: number): void {
    deferTaskStmt.run(until, Date.now(), id);
  },
  /** Moves a task's status WITHOUT touching the fields an agent may already
   *  have written (done_comment, blocked_reason): the caller uses this
   *  precisely because `updateTaskStatus` clobbers them.
   *
   *  `fallbackDoneComment` is the single exception, and it preserves that
   *  property: it is written ONLY if the task carries no comment at all.
   *  Its purpose is to qualify an automatic closure — so that the pilot and
   *  the verification-loop can tell "the agent had nothing to say" from "the
   *  agent never closed anything". */
  setTaskStatusOnly(id: string, status: TaskStatus, fallbackDoneComment?: string): void {
    const prev = getTaskStmt.get(id) as TaskRow | undefined;
    // The guard keeps reading the AGENT's comment: it mines a merge sha out of
    // it, and a synthetic sentence must never feed that.
    const g = guardMergeDone(prev, status, null, prev?.done_comment ?? null);
    const existing = prev?.done_comment ?? null;
    const comment = existing && existing.trim().length > 0
      ? existing
      : (g.status === 'DONE' ? fallbackDoneComment ?? null : existing);
    if (g.status !== status || comment !== existing) {
      // Merge guard fired (blocked_reason to write), or an automatic closure to
      // qualify: setTaskStatusOnlyStmt writes neither, so we switch to the full
      // statement — with the comment resolved above, never a clobber.
      updateTaskStatusStmt.run(g.status, Date.now(), g.blockedReason, comment, id);
    } else {
      setTaskStatusOnlyStmt.run(status, Date.now(), id);
    }
    // Sha extracted from the comment (merger fallback) → we persist it.
    if (g.mergedSha) setTaskMergedShaStmt.run(g.mergedSha, Date.now(), id);
    if (g.status === 'BLOCKED' && prev?.status !== 'BLOCKED') {
      bus.publish({ kind: 'task_blocked', taskId: id, reason: g.blockedReason ?? prev?.blocked_reason ?? null });
    }
    if (g.status !== 'BLOCKED' && prev?.status === 'BLOCKED') {
      bus.publish({ kind: 'task_unblocked', taskId: id });
    }
    if (g.status === 'DONE' && prev?.status !== 'DONE') {
      bus.publish({ kind: 'task_done', taskId: id });
    }
    publishTaskDiff(prev);
  },
  /** Base branch WANTED for this task, recorded at creation — before any
   *  worktree exists. Without it the dispatcher fell back to the CURRENT branch
   *  of the shared repo, so a worktree could start on another agent's branch
   *  and a `code-self` merge land there (evening of 2026-09-05). */
  setTaskBaseBranch(id: string, base: string): void {
    setTaskBaseBranchStmt.run(base, Date.now(), id);
  },
  /** Repoint ONE requeued task at another backend and release it now. Unlike
   *  `updateTask`, a null model is written as null: COALESCE would keep the slug
   *  of the backend being left, and another CLI fails at launch on it. Only a
   *  PENDING task moves — one already picked up again keeps its mission. */
  setTaskLlm(id: string, backend: string, model: string | null): boolean {
    return setTaskLlmStmt.run(backend, model, Date.now(), id).changes > 0;
  },
  /** Attach (or, with `null`, detach) the TO DO idea this task implements.
   *  Access is the caller's business: routes check the idea is visible to
   *  whoever asks, otherwise linking would let anyone close anyone's idea. */
  setTaskTodoId(id: string, todoId: number | null): void {
    setTaskTodoIdStmt.run(todoId, Date.now(), id);
  },
  listTasksByRoutine(routineId: string, viewer?: DbViewer | null): TaskRow[] {
    return (listTasksByRoutineStmt.all(routineId) as TaskRow[])
      .filter((row) => rowVisible(row, viewer, 'tasks'));
  },
  /** All tasks of a group (batch created together), oldest first. */
  listTasksByGroup(groupId: string): TaskRow[] {
    return listTasksByGroupStmt.all(groupId) as TaskRow[];
  },
  /** All tasks carrying a TO DO idea (`todo_id`), oldest first. */
  listTasksByTodo(todoId: number): TaskRow[] {
    return listTasksByTodoStmt.all(todoId) as TaskRow[];
  },
  /** All tasks attached to a verification chain (same `verification_root_id`),
   *  oldest first. */
  listTasksByVerificationRoot(rootId: string): TaskRow[] {
    return listTasksByVerificationRootStmt.all(rootId) as TaskRow[];
  },
  /** The WHOLE code → review → merge chain of a verification root: the root
   *  itself (its `verification_root_id` is null), the tasks tagged with it
   *  (reviews, repair iterations) and the reviews/merges hanging off them by
   *  `deps`. The verification-loop never tags a `merge`, and a review created by
   *  hand carries no tag either, so `listTasksByVerificationRoot` alone cannot
   *  tell whether a chain has reached its merge. Oldest first. */
  listVerificationChain(rootId: string): TaskRow[] {
    const seen = new Map<string, TaskRow>();
    const root = getTaskStmt.get(rootId) as TaskRow | undefined;
    if (root) seen.set(root.id, root);
    for (const t of listTasksByVerificationRootStmt.all(rootId) as TaskRow[]) seen.set(t.id, t);
    const frontier = [...seen.keys()];
    while (frontier.length > 0) {
      const id = frontier.pop() as string;
      for (const t of listChainDependentsStmt.all(id) as TaskRow[]) {
        if (seen.has(t.id)) continue;
        seen.set(t.id, t);
        frontier.push(t.id);
      }
    }
    return [...seen.values()].sort((a, b) => a.created_at - b.created_at);
  },
  /** True if at least one PENDING or IN_PROGRESS task remains in the group.
   *  DONE/BLOCKED do NOT count as active — a group entirely DONE/BLOCKED is
   *  considered finished (ready to wake the orchestrator). */
  groupHasActiveTasks(groupId: string): boolean {
    return (groupActiveCountStmt.get(groupId) as { n: number }).n > 0;
  },
  /** Mark the whole group as having already woken the orchestrator (idempotent
   *  flag set on every task of the group). */
  /** Mark (or unmark) this task's work return as already delivered to the pilot.
   *  Idempotence guard between task closure and death of its mission, which are
   *  two distinct moments. */
  markTaskReturnNotified(id: string, notified = true): void {
    markReturnNotifiedStmt.run(notified ? 1 : 0, id);
  },
  isTaskReturnNotified(id: string): boolean {
    return ((getTaskStmt.get(id) as TaskRow | undefined)?.return_notified ?? 0) === 1;
  },
  /** Mark (or unmark) this mission's work return as already delivered to its pilot.
   *  Scoped to the CURRENT TURN: cleared when a turn starts, set when the return
   *  goes out (end of turn, or a message the agent wrote to its pilot itself).
   *  One return per turn, never two. */
  markMissionReturnNotified(id: string, notified = true): void {
    markMissionReturnNotifiedStmt.run(notified ? 1 : 0, id);
  },
  isMissionReturnNotified(id: string): boolean {
    const row = missionReturnNotifiedStmt.get(id) as { return_notified?: number } | undefined;
    return (row?.return_notified ?? 0) === 1;
  },
  /** Set the follow-up chaining state of this task (see TaskChainState).
   *  Idempotence guard of `task-chain.ts`: a task's closure can be re-emitted
   *  (re-close after a merge-integrity bounce, reconcile), and each replay would
   *  create one more follow-up task. */
  setTaskChainState(id: string, state: TaskChainState): void {
    setChainStateStmt.run(state, state, Date.now(), state, state, id);
  },
  /** Chaining attempts already consumed by this execution of the task. */
  taskChainAttempts(id: string): number {
    return (getTaskStmt.get(id) as TaskRow | undefined)?.chain_attempts ?? 0;
  },
  taskChainState(id: string): TaskChainState {
    return (getTaskStmt.get(id) as TaskRow | undefined)?.chain_ran ?? CHAIN_NEVER;
  },
  /** True if this task's follow-up chain went all the way. An INTERRUPTED chain
   *  answers `false`: that is the whole point of the tri-state. */
  isTaskChainRan(id: string): boolean {
    return this.taskChainState(id) === CHAIN_DONE;
  },
  /** Tasks whose follow-up chain must (re)start: never attempted, or attempted then
   *  dead in flight. Filtered IN SQL — see `listTasksNeedingChainStmt`.
   *  @param updatedAfter age bound (reconcile catch-up window)
   *  @param staleStartedBefore a CHAIN_RUNNING started before this instant is
   *    considered dead, not in progress. */
  listTasksNeedingChain(updatedAfter: number, staleStartedBefore: number): TaskRow[] {
    return listTasksNeedingChainStmt.all(updatedAfter, staleStartedBefore) as TaskRow[];
  },
  /** True if a non-`doc` task depends on this one: the chain has already resumed
   *  without the pilot, so this return calls for no immediate decision. */
  hasFollowUpTask(taskId: string): boolean {
    return hasFollowUpTaskStmt.get(taskId, taskId) !== undefined;
  },
  markGroupNotified(groupId: string): void {
    markGroupNotifiedStmt.run(Date.now(), groupId);
  },
  /** True if the end of the group has already been notified (at least one task of
   *  the group carries group_notified = 1). Anti-double-wake guard. */
  isGroupNotified(groupId: string): boolean {
    return (groupNotifiedCountStmt.get(groupId) as { n: number }).n > 0;
  },

  /** All tasks of a series (project), oldest first. */
  listTasksBySeries(seriesId: string): TaskRow[] {
    return listTasksBySeriesStmt.all(seriesId) as TaskRow[];
  },
  /** Series piloted by this orchestrator mission, if it pilots one.
   *  Accepts either the series id or the current pilot's id. */
  seriesIdForMission(missionId: string): string | null {
    return resolveSeriesIdExisting(missionId);
  },
  /**
   * Change a series' pilot: all its NON-terminal tasks now point at `newMissionId`,
   * and the messages that were waiting for the old pilot are re-addressed to it.
   *
   * The second point is what avoids the loss: a recap addressed to a dead mission
   * otherwise takes the "spawn a new mission" path, i.e. exactly the dispersion we
   * want to eliminate.
   */
  remapSeriesOrchestratorMission(seriesId: string, oldMissionId: string | null, newMissionId: string): number {
    let changed = 0;
    db.transaction(() => {
      changed = remapSeriesStmt.run(newMissionId, Date.now(), seriesId).changes;
      if (oldMissionId && oldMissionId !== newMissionId) {
        retargetPendingMessagesStmt.run(newMissionId, oldMissionId);
      }
    })();
    return changed;
  },
  /**
   * Requeue the tasks of a series that ONLY the BACKEND stopped: usage limit,
   * account with no credit left (402), or circuit breaker.
   *
   * `types` restricts the requeue to the task types that ACTUALLY moved onto a
   * fallback. Omitted, the whole series is requeued (the caller then knows every
   * actor has somewhere else to go).
   *
   * They were never closed by their agent: their BLOCKED describes the account
   * state, not the work. Leaving them blocked after moving the series onto a
   * backend that has quota would stop the project for a reason that no longer
   * exists. A BUSINESS block (interrupted_reason NULL) is never touched — that one
   * is waiting for a decision.
   */
  requeueRateLimitedTasks(
    seriesId: string,
    /** The (type, plan group) pairs that moved; omitted = every task. A pair
     *  rather than a type: a type may have moved in one group and stayed in
     *  another, whose fallback was refused or dry. */
    moved?: ReadonlyArray<{ type: TaskType; planGroup: string | null }>,
  ): number {
    const targets = (listTasksBySeriesStmt.all(seriesId) as TaskRow[]).filter((t) => {
      const reason = toInterruptionReason(t.interrupted_reason);
      if (t.status !== 'BLOCKED' || reason === null) return false;
      if (moved && !moved.some((m) => m.type === t.type && m.planGroup === (t.plan_group ?? null))) return false;
      return BACKEND_FALLBACK_REASONS.includes(reason);
    });
    let requeued = 0;
    for (const t of targets) if (dbApi.requeueBackendBlockedTask(t.id)) requeued++;
    return requeued;
  },
  /**
   * Requeue ONE task that only its backend stopped (same filter as
   * `requeueRateLimitedTasks`), outside any series switchover: the backend it
   * would leave on reopened, or has a workable fallback (`requeueBackendBlockedTasks`,
   * dispatcher.ts). False when the task is no longer such a block — a human or
   * a switchover got there first.
   */
  requeueBackendBlockedTask(id: string): boolean {
    const prev = getTaskStmt.get(id) as TaskRow | undefined;
    if (!prev || requeueRateLimitedStmt.run(Date.now(), id).changes === 0) return false;
    // `task_unblocked`: that is literally what happens, and the wake-loop
    // anti-loop counters already hook onto it.
    bus.publish({ kind: 'task_unblocked', taskId: id });
    publishTaskDiff(prev);
    return true;
  },
  /** Force backend+model on tasks OF ONE TYPE in a series, when they have not yet
   *  run (PENDING/BLOCKED). Per type, because a long project does not want the same
   *  fallback for its coder and its reviews. In-flight tasks keep theirs: cutting
   *  them mid-run would lose their work for nothing. */
  setSeriesLlmOverride(
    seriesId: string,
    type: TaskType,
    backend: string | null,
    model: string | null,
    /** Omitted: every task of the type. A string: the tasks of that plan
     *  group only; `null`: the tasks outside any group. The fallback of a
     *  group is its own, so a type moves group by group. */
    planGroup?: string | null,
  ): number {
    if (planGroup === undefined) return setSeriesLlmStmt.run(backend, model, Date.now(), seriesId, type).changes;
    return setSeriesGroupLlmStmt.run(backend, model, Date.now(), seriesId, type, planGroup).changes;
  },

  /**
   * Set (or clear, with `backend = null`) the fallback rule of a scope.
   *
   * An EXISTING rule with `backend` null is an explicit "no fallback", distinct
   * from the absence of a rule: it prevents falling back to `'*'` or the global
   * setting. That is what lets us say "this series does not switch", for example
   * on a project we would rather see fail than continue on a weaker model.
   */
  setSeriesFallback(seriesId: string, scope: string, backend: string | null, model: string | null): void {
    setSeriesFallbackStmt.run(seriesId, scope, backend, model, Date.now());
  },
  getSeriesFallback(seriesId: string, scope: string): SeriesFallbackRow | undefined {
    return getSeriesFallbackStmt.get(seriesId, scope) as SeriesFallbackRow | undefined;
  },
  listSeriesFallbacks(seriesId: string): SeriesFallbackRow[] {
    return listSeriesFallbacksStmt.all(seriesId) as SeriesFallbackRow[];
  },
  clearSeriesFallback(seriesId: string, scope: string): void {
    clearSeriesFallbackStmt.run(seriesId, scope);
  },

  /** Series-scoped backend/model for a task type (`series_roles`). Never touches
   *  `roles.json`: the choice dies with the series. */
  setSeriesRole(seriesId: string, scope: TaskType, backend: string | null, model: string | null): void {
    setSeriesRoleStmt.run(seriesId, scope, backend, model, Date.now());
  },
  getSeriesRole(seriesId: string, scope: string): SeriesRoleRow | undefined {
    return getSeriesRoleStmt.get(seriesId, scope) as SeriesRoleRow | undefined;
  },
  listSeriesRoles(seriesId: string): SeriesRoleRow[] {
    return listSeriesRolesStmt.all(seriesId) as SeriesRoleRow[];
  },
  clearSeriesRole(seriesId: string, scope: string): void {
    clearSeriesRoleStmt.run(seriesId, scope);
  },

  /** The same rules for ONE group of volets (`series_group_*`): read before
   *  the series-wide ones for a task whose `plan_group` names the group. */
  setSeriesGroupFallback(seriesId: string, planGroup: string, scope: string, backend: string | null, model: string | null): void {
    setSeriesGroupFallbackStmt.run(seriesId, planGroup, scope, backend, model, Date.now());
  },
  getSeriesGroupFallback(seriesId: string, planGroup: string, scope: string): SeriesGroupRuleRow | undefined {
    return getSeriesGroupFallbackStmt.get(seriesId, planGroup, scope) as SeriesGroupRuleRow | undefined;
  },
  listSeriesGroupFallbacks(seriesId: string): SeriesGroupRuleRow[] {
    return listSeriesGroupFallbacksStmt.all(seriesId) as SeriesGroupRuleRow[];
  },
  clearSeriesGroupFallback(seriesId: string, planGroup: string, scope: string): void {
    clearSeriesGroupFallbackStmt.run(seriesId, planGroup, scope);
  },
  setSeriesGroupRole(seriesId: string, planGroup: string, scope: TaskType, backend: string | null, model: string | null): void {
    setSeriesGroupRoleStmt.run(seriesId, planGroup, scope, backend, model, Date.now());
  },
  getSeriesGroupRole(seriesId: string, planGroup: string, scope: string): SeriesGroupRuleRow | undefined {
    return getSeriesGroupRoleStmt.get(seriesId, planGroup, scope) as SeriesGroupRuleRow | undefined;
  },
  listSeriesGroupRoles(seriesId: string): SeriesGroupRuleRow[] {
    return listSeriesGroupRolesStmt.all(seriesId) as SeriesGroupRuleRow[];
  },
  clearSeriesGroupRole(seriesId: string, planGroup: string, scope: string): void {
    clearSeriesGroupRoleStmt.run(seriesId, planGroup, scope);
  },

  // ── backend cooldowns (quota exhausted) ────────────────────────────────────
  setBackendCooldown(
    backend: string,
    until: number,
    quotaWindow: string | null,
    exact = false,
    kind: BackendCooldownKind = 'rate_limit',
  ): void {
    setBackendCooldownStmt.run(backend, until, quotaWindow, Date.now(), exact ? 1 : 0, kind);
  },
  getBackendCooldown(backend: string): BackendCooldownRow | undefined {
    return getBackendCooldownStmt.get(backend) as BackendCooldownRow | undefined;
  },
  listBackendCooldowns(): BackendCooldownRow[] {
    return listBackendCooldownsStmt.all() as BackendCooldownRow[];
  },
  clearBackendCooldown(backend: string): void {
    clearBackendCooldownStmt.run(backend);
  },

  // ── missions ───────────────────────────────────────────────────────────────
  /** `traceId`: causal root imposed by the caller (workflow run, TIMON_TRACE_ID).
   *  Absent → the mission is its own root until `setMissionLineage` /
   *  `setForkedFrom` name an ancestor, whose trace it then adopts. */
  createMission(
    id: string,
    agent: string,
    mission: string,
    source?: Source,
    ownerUserId?: string | null,
    traceId?: string | null,
    workflow?: { runId: string; nodeId: string | null } | null,
  ): void {
    insertMissionStmt.run(
      id,
      agent,
      mission,
      Date.now(),
      source?.channel ?? null,
      source?.meta !== undefined ? JSON.stringify(source.meta) : null,
      ownerUserId ?? null,
      traceId ?? id,
      workflow?.runId ?? null,
      workflow?.nodeId ?? null,
    );
    dbApi.indexMissionPrompt(id, mission, Date.now());
  },
  setMissionBrowserProfile(id: string, profileId: string | null): void {
    db.prepare(`UPDATE missions SET browser_profile_id=?, browser_profile_resolved=1 WHERE id=?`).run(profileId, id);
  },
  setMissionOwner(id: string, userId: string | null): void {
    setMissionOwnerStmt.run(userId, id);
  },
  /** First-run setup: every existing mission becomes the superadmin's. */
  assignUnownedMissionsTo(userId: string): number {
    return dbApi.assignUnownedOwnedTo(userId).missions;
  },
  /** First-run setup: every unowned row of every owned table is attributed. */
  assignUnownedOwnedTo(userId: string): Record<OwnedTable, number> {
    const out = {} as Record<OwnedTable, number>;
    for (const table of OWNED_TABLES) {
      // A shared system row is nobody's history: attributing it would hide it
      // from every other account.
      if (SHARED_SYSTEM_ROW_TABLES.includes(table)) { out[table] = 0; continue; }
      out[table] = db.prepare(
        `UPDATE ${table} SET owner_user_id = ? WHERE owner_user_id IS NULL`,
      ).run(userId).changes;
    }
    return out;
  },
  /**
   * Derive a mission's death cause from its EVENTS, the only reliable source.
   * The exit code is not: measured on the 11 missions killed by quota on
   * 29-30/07/2026, 9 had `exit_code = 0` and `status = 'terminated'` — bitwise
   * indistinguishable from a mission that finished its work if one only looks at
   * the `missions` table.
   *
   * Discrimination rule (validated on real data): we only keep a signal if it is
   * within WINDOW of the mission's LAST event, of any kind. Meaning: the mission
   * did nothing after that. We compare to the last event and NOT to `ended_at`
   * because the reaper finalises ~12 min later (measured delta: 668–719 s). On
   * missions that saw a `rejected`, the two families separate without ambiguity:
   * quota deaths at ~0 s, false positives (missions that lived hours after a
   * refusal) at 15 000 s and more.
   *
   * Priority rate_limit > permission_denied: a 429 also comes back as a `result`
   * carrying an `api_error_status`, it must not be read as a permission refusal.
   */
  detectMissionDeathSignal(missionId: string): MissionDeathSignal | null {
    const rows = lastMissionEventsStmt.all(missionId, DEATH_SIGNAL_SCAN) as EventRow[];
    const last = rows[0];
    if (!last) return null;
    const parse = (r: EventRow): Record<string, unknown> | null => {
      try {
        const p: unknown = JSON.parse(r.payload);
        return p !== null && typeof p === 'object' ? (p as Record<string, unknown>) : null;
      } catch {
        return null; // unreadable payload → no signal, never throw Window: events contemporaneous with the
      }
    };
    // mission's death. 1. Usage limit. Detection
    const recent = rows.filter((r) => last.timestamp - r.timestamp <= DEATH_SIGNAL_WINDOW_MS);

    // lives in `rate-limit.ts`, shared with the
    // live stream (agent.ts): it covers the
    // THREE known forms (dedicated event, `result` as
    // 429, text message). This last case was missing
    // here, so a mission killed by quota on
    const hit = bestRateLimit(recent.map((r) => ({ type: r.type, payload: parse(r) })));
    if (hit) {
      // A 402 is not a quota window (`kind`, cf. rate-limit.ts): flattening the
      // two wrote "quota reopens at HH:MM" onto the Kanban for an account that
      // only a top-up brings back. The two causes trigger the same series
      // switchover, they just do not tell the human the same thing.
      return hit.kind === 'exhausted'
        ? { reason: 'exhausted' }
        : { reason: 'rate_limit', rateLimitType: hit.window, resetsAt: hit.resetsAt };
    }
    const queued = queuedQuotaWall(rows.map((r) => ({ type: r.type, payload: parse(r) })));
    if (queued) return { reason: 'rate_limit', rateLimitType: queued.window, resetsAt: queued.resetsAt, pending: true };
    // A model at capacity is read after the quota (a message naming both is a
    // quota) and before the permission refusal, whose shape it would otherwise
    // never reach: both are error `result`s.
    if (recent.some((r) => isOverloadedEvent(r.type, parse(r)))) return { reason: 'overloaded' };
    // a backend that only surfaces text died without a signal → mute BLOCKED task. 2.
    // Permission refusal: the classifier refuses a tool use → the CLI stops dead on an
    // error `result` whose stop_reason stays `tool_use` (work possibly finished, but never
    // closed). Tested on the LAST event only: that is the death mode, not a refusal
    // digested along the way that the agent recovered from.
    if (last.type === 'result') {
      const p = parse(last);
      if (p?.is_error === true && p.stop_reason === 'tool_use' && p.api_error_status === undefined) {
        return { reason: 'permission_denied' };
      }
    }
    return null;
  },
  /**
   * Finalise a mission and return the EFFECTIVE death cause. The caller uses it to
   * qualify the corresponding task without re-reading the row.
   *
   * Priority order, from most to least reliable:
   *   1. signal derived from events (detectMissionDeathSignal) — direct observation
   *      of the stream, contemporaneous with death;
   *   2. cause already persisted on the row (set at exit, with the agent's in-memory
   *      state in sight);
   *   3. `reason` passed by the caller — a GUESS made without context by the orphan
   *      reaper or the boot zombie sweep.
   *
   * No short-circuit on `status === 'completed'`: that is precisely the profile of
   * missions killed by quota with a clean exit. A genuinely clean end has no signal
   * → we clear any marker that became obsolete (rate-limited mission, resumed, then
   * finished normally) and return null.
   */
  finishMission(
    id: string,
    status: 'completed' | 'failed' | 'terminated',
    exitCode: number | null,
    reason: InterruptionReason | null = null,
  ): InterruptionReason | null {
    const closeSpans = (effectiveReason: InterruptionReason | null): InterruptionReason | null => {
      // The trace is an index, never a reason to fail mission finalisation.
      // A terminal mission cannot keep a running span (§12.3), but an I/O
      // failure here must not prevent its lifecycle event from being emitted.
      try {
        dbApi.closeOpenSpans(
          id,
          status === 'completed' && effectiveReason === null ? 'ok' : 'interrupted',
          effectiveReason,
        );
      } catch (err) {
        console.warn(`[trace:${id.slice(0, 8)}] could not close open spans: ${(err as Error).message}`);
      }
      return effectiveReason;
    };
    // Mission tokens die with the mission (`docs/MULTI-USER.md` §6), even
    // if a later reopen issues a fresh one.
    dbApi.revokeApiTokensForMission(id);
    db.prepare(`DELETE FROM mcp_tokens WHERE mission_id = ?`).run(id);
    // So do the approvals given "for this session": a reopen is a new session.
    db.prepare(`DELETE FROM approval_rules WHERE scope = 'session' AND mission_id = ?`).run(id);
    // An ended mission has nothing left to reattach.
    deleteRemoteResumeStmt.run(id);
    const signal = dbApi.detectMissionDeathSignal(id);
    if (signal) {
      // DRY write (no COALESCE): the events
      // signal takes precedence over anything that may
      finishMissionStmt.run(status, Date.now(), exitCode, signal.reason, id);
      setMissionInterruptedStmt.run(signal.reason, id);
      return closeSpans(signal.reason);
    }
    if (status === 'completed') {
      finishMissionStmt.run(status, Date.now(), exitCode, null, id);
      setMissionInterruptedStmt.run(null, id);
      return closeSpans(null);
    }
    finishMissionStmt.run(status, Date.now(), exitCode, reason, id);
    const row = getMissionStmt.get(id) as MissionRow | undefined;
    // have been guessed earlier. Last net: mission dead WITHOUT a clean end, without a
    // signal in its stream and without a cause guessed by the caller. We write `unknown`
    // rather than leave NULL — a NULL reads as "we did not look" and becomes
    // indistinguishable from a business block, which
    // is exactly what this column exists to
    // avoid. Typical case: a dialect whose CLI says nothing about its usage limits
    // (`rateLimitReporting: 'none'`), where silence proves nothing at all.
    const effective = toInterruptionReason(row?.interrupted_reason);
    if (effective) return closeSpans(effective);
    setMissionInterruptedStmt.run('unknown', id);
    return closeSpans('unknown');
  },
  /** Mark a death cause observed BEFORE the mission is finalised.
   *  Use case: the CLI exits on usage limit — the mission stays `running`
   *  (resume possible when quota returns) and will only be finalised much later
   *  by the reaper, which will have no context left. */
  setMissionInterrupted(id: string, reason: InterruptionReason | null): void {
    setMissionInterruptedStmt.run(reason, id);
  },
  reopenMission(id: string): void {
    reopenMissionStmt.run(id);
  },
  /** Decision already taken for this (mission, tool_use_id), or null. Read from
   *  persisted events → survives an orchestrator restart, so the shim that
   *  re-POSTs the same tool_use_id recovers the answer instead of re-blocking or
   *  recreating a card. */
  findResolvedPermission(
    missionId: string,
    toolUseId: string,
  ): { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message: string } | null {
    const rows = resolvedPermissionsStmt.all(missionId) as Array<{ payload: string }>;
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload) as { tool_use_id?: string; decision?: unknown };
        if (p.tool_use_id === toolUseId && p.decision) {
          return p.decision as ReturnType<typeof dbApi.findResolvedPermission>;
        }
      } catch { /* malformed payload — ignore */ }
    }
    return null;
  },
  /** Whether `anchor` is the id of a permission card this mission once raised (its persisted `permission_request`). */
  hasPermissionRequest(missionId: string, anchor: string): boolean {
    return hasPermissionRequestStmt.get(missionId, anchor) !== undefined;
  },
  getMission(id: string, viewer?: DbViewer | null): MissionRow | undefined {
    return rowVisible(getMissionStmt.get(id) as MissionRow | undefined, viewer, 'missions');
  },
  /** Agent and `source_meta` of a mission, for the board (TIM-0109). The
   *  caller has already checked the task the mission runs. */
  getMissionRunner(id: string): Pick<MissionRow, 'agent_name' | 'source_meta'> | undefined {
    return missionRunnerStmt.get(id) as Pick<MissionRow, 'agent_name' | 'source_meta'> | undefined;
  },
  /** Who started the mission (`mission-origin.ts`), by the list's own SQL.
   *  A label, not a read: the caller has already checked the mission. */
  getMissionOrigin(id: string): MissionOrigin | null {
    const row = missionOriginStmt.get(id) as { origin: MissionOrigin } | undefined;
    return row?.origin ?? null;
  },
  /** Display card of a mission's owner. The caller has already checked the
   *  mission is visible: only the owner of a row the viewer sees is read. */
  missionOwner(ownerUserId: string | null): MissionOwner | null {
    if (!ownerUserId) return null;
    const user = this.getUserById(ownerUserId);
    return user ? { id: user.id, name: user.name, avatar_url: user.avatar_url } : null;
  },
  /** Account a mission acts as: its own owner, else the owner of its lineage. */
  missionOwnerId(missionId: string): string | null {
    return resolveMissionOwner(missionId);
  },
  insertEvent(missionId: string, type: string, payload: unknown): EventRow {
    const ts = Date.now();
    // §7: masked BEFORE storage, and before the search index — the payload has
    // two consumers here, and indexing the plaintext would leave the value
    // readable in `mission_search` while the `events` row looks clean.
    payload = redactDeep(payload);
    const json = JSON.stringify(payload);
    const info = insertEventStmt.run(missionId, type, ts, json);
    // Online full-text indexing: it only costs on events that actually carry text
    // (assistant/user), and guarantees a mission is searchable while it runs, not only
    // after a catch-up.
    dbApi.indexMissionEvent(missionId, Number(info.lastInsertRowid), type, payload, ts);
    return {
      id: Number(info.lastInsertRowid),
      mission_id: missionId,
      type,
      timestamp: ts,
      payload: json,
    };
  },
  /**
   * Cuts a mission's thread at `fromEventId` (docs/specs/rewind.md § 9-10): appends
   * a `rewind` event and stamps its id on every still-visible row from
   * `fromEventId` on, so each thread reader leaves them out. Nothing is deleted;
   * rewinding further back stamps the earlier rewind event too. The cut rows
   * leave `mission_search`; costs and `mission_stats` stay as they are.
   * Returns the id of the `rewind` event.
   */
  rewindMission(missionId: string, fromEventId: number): number {
    return db.transaction(() => {
      const rewindId = dbApi.insertEvent(missionId, 'rewind', { type: 'rewind', from_event_id: fromEventId }).id;
      for (const table of listEventsUnionStmt ? ['events', 'archive.events'] : ['events']) {
        db.prepare(
          `UPDATE ${table} SET rewound_by = ?
            WHERE mission_id = ? AND id >= ? AND id < ? AND rewound_by IS NULL`,
        ).run(rewindId, missionId, fromEventId, rewindId);
      }
      db.prepare(
        `DELETE FROM mission_search WHERE mission_id = ? AND event_id >= ? AND event_id < ?`,
      ).run(missionId, fromEventId, rewindId);
      return rewindId;
    })();
  },
  listEvents(missionId: string): EventRow[] {
    if (listEventsUnionStmt) return listEventsUnionStmt.all(missionId, missionId) as EventRow[];
    return listEventsStmt.all(missionId) as EventRow[];
  },
  /** The events a conversation is rebuilt from: {@link listEvents} without the
   *  per-token rows, then only the last `init` / `rate_limit_event` of each
   *  kind (mission-events-view.ts). Hot and archived rows alike. */
  listChatEvents(missionId: string): EventRow[] {
    const rows = (listChatEventsUnionStmt
      ? listChatEventsUnionStmt.all(missionId, missionId)
      : listChatEventsStmt.all(missionId)) as EventRow[];
    return keepLatestState(rows);
  },
  /** Rows of one mission under a condition (mission-history-page.ts), archive included. */
  scanMissionEvents(missionId: string, scan: MissionEventScan): unknown[] {
    return scanMissionEvents(missionId, scan);
  },
  /** The stored fold of a mission's prelude (mission-history-page.ts). */
  getMissionPreludeFold(missionId: string): { version: number; up_to: number; state: string } | null {
    return (getPreludeFoldStmt.get(missionId) as { version: number; up_to: number; state: string } | undefined) ?? null;
  },
  setMissionPreludeFold(missionId: string, version: number, upTo: number, state: string): void {
    upsertPreludeFoldStmt.run(missionId, version, upTo, state, Date.now());
  },
  /** The newest `limit` rows of a mission's chat view, oldest first (bounded
   *  SSE replay): no per-token noise, only the last `init` / `rate_limit_event`. */
  listEventsTail(missionId: string, limit: number): EventRow[] {
    const n = Math.max(1, Math.floor(limit));
    const rows = (listEventsTailUnionStmt
      ? listEventsTailUnionStmt.all(missionId, missionId, n)
      : listEventsTailStmt.all(missionId, n)) as EventRow[];
    return keepLatestState(rows);
  },
  /** Timestamp of the mission's last event, null if it has none. */
  lastEventAt(missionId: string): number | null {
    const row = lastMissionEventAtStmt.get(missionId) as { ts: number | null } | undefined;
    return row?.ts ?? null;
  },
  /** N last events across all missions, chronological ascending order on the API
   *  side. Used for the initial seed of the Event Stream sidebar so it is not empty
   *  at mount (before live SSE). */
  listRecentEvents(limit: number): EventRow[] {
    const rows = listRecentEventsStmt.all(Math.max(1, Math.min(1000, limit))) as EventRow[];
    return rows.reverse();
  },
  /** Index a mission's initial prompt. Best-effort: a degraded search must never
   *  prevent a mission from starting. */
  indexMissionPrompt(missionId: string, text: string, ts: number): void {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    try {
      insertMissionSearchStmt.run(missionId, null, 0, 'prompt', ts, trimmed.slice(0, 20_000));
    } catch { /* convenience index — never blocking */ }
  },
  /** Index the useful text of an event. Called inline by `insertEvent` and by
   *  catch-up. Idempotent: replaying the same event duplicates nothing. */
  indexMissionEvent(
    missionId: string,
    eventId: number,
    type: string,
    payload: unknown,
    ts: number,
  ): number {
    let fragments: ReturnType<typeof extractSearchFragments>;
    try {
      fragments = extractSearchFragments(type, payload);
    } catch { return 0; }
    if (!fragments.length) return 0;
    try {
      // Purge first: an event re-indexed with FEWER fragments than before would
      // otherwise leave the extras behind.
      deleteMissionSearchEventStmt.run(eventId);
      let seq = 0;
      for (const f of fragments) {
        insertMissionSearchStmt.run(missionId, eventId, seq++, f.role, ts, f.text);
      }
      return fragments.length;
    } catch { return 0; }
  },
  /**
   * Incremental catch-up of the index, in batches and resumable.
   *
   * Returns `done: true` when the cursor has caught up with the last event. The
   * caller (orchestrator boot, or `timon mission reindex`) retries while it is
   * `false` — we never scan 500 000 events in one go, that would freeze the
   * event-loop for tens of seconds.
   */
  reindexMissionSearch(batch = 500): {
    scanned: number; indexed: number; cursor: number; maxEventId: number; done: boolean;
  } {
    // Mission prompts first: a few thousand rows, once, and it is the most
    // discriminating field of a search.
    if (!(getSearchStateStmt.get('prompts_done') as { v: number } | undefined)?.v) {
      const rows = unindexedMissionsStmt.all() as { id: string; mission: string; started_at: number }[];
      for (const m of rows) dbApi.indexMissionPrompt(m.id, m.mission, m.started_at);
      setSearchStateStmt.run('prompts_done', 1);
    }
    const cursor = ((getSearchStateStmt.get('event_cursor') as { v: number } | undefined)?.v) ?? 0;
    const maxEventId = (maxEventIdStmt.get() as { id: number }).id;
    const rows = eventsAfterStmt.all(cursor, Math.max(1, Math.min(5000, batch))) as {
      id: number; mission_id: string; type: string; timestamp: number; payload: string;
    }[];
    let indexed = 0;
    let last = cursor;
    const run = db.transaction(() => {
      for (const e of rows) {
        last = e.id;
        if (e.type !== 'assistant' && e.type !== 'user') continue;
        let payload: unknown;
        try { payload = JSON.parse(e.payload); } catch { continue; }
        indexed += dbApi.indexMissionEvent(e.mission_id, e.id, e.type, payload, e.timestamp);
      }
      setSearchStateStmt.run('event_cursor', last);
    });
    run();
    return { scanned: rows.length, indexed, cursor: last, maxEventId, done: rows.length === 0 || last >= maxEventId };
  },
  /** Catch-up progress, to display it rather than let people believe the index is
   *  complete when it is at 12 %. */
  missionSearchProgress(): { cursor: number; maxEventId: number; fragments: number; done: boolean } {
    const cursor = ((getSearchStateStmt.get('event_cursor') as { v: number } | undefined)?.v) ?? 0;
    const maxEventId = (maxEventIdStmt.get() as { id: number }).id;
    const fragments = (db.prepare(`SELECT COUNT(*) AS c FROM mission_search`).get() as { c: number }).c;
    return { cursor, maxEventId, fragments, done: cursor >= maxEventId };
  },
  /**
   * Full-text search in mission history.
   *
   * `agents` filters on a set of agent names (project resolution on the caller
   * side, same convention as `listMissions`). `since`/`until` are Unix ms. Sort is
   * FTS5's (bm25): we look for the most relevant conversation, not the most recent.
   */
  searchMissions(opts: {
    q: string; agents?: string[]; since?: number; until?: number; limit?: number;
    viewer?: DbViewer | null;
  }): MissionSearchHit[] {
    const fts = toMissionFtsQuery(opts.q);
    if (!fts) return [];
    const limit = Math.max(1, Math.min(200, opts.limit ?? 30));
    const where: string[] = ['f.text MATCH ?'];
    const params: unknown[] = [fts];
    if (opts.agents) {
      if (!opts.agents.length) return [];
      where.push(`m.agent_name IN (${opts.agents.map(() => '?').join(', ')})`);
      params.push(...opts.agents);
    }
    if (typeof opts.since === 'number') { where.push('s.ts >= ?'); params.push(opts.since); }
    if (typeof opts.until === 'number') { where.push('s.ts <= ?'); params.push(opts.until); }
    {
      const owner = ownerSql(opts.viewer, 'missions', 'm.owner_user_id');
      if (owner.sql !== '1=1') {
        where.push(owner.sql);
        params.push(...owner.params);
      }
    }
    params.push(limit);
    try {
      return db.prepare(
        `SELECT s.mission_id, s.role, s.ts, s.event_id,
                m.agent_name, m.status, m.started_at, m.mission,
                t.id AS task_id, t.title AS task_title,
                -- french-ok: the guillemets that mark a match in a snippet
                snippet(mission_search_fts, 0, '«', '»', '…', 20) AS snippet
           FROM mission_search_fts f
           JOIN mission_search s ON s.id = f.rowid
           JOIN missions m ON m.id = s.mission_id
           LEFT JOIN tasks t ON t.id = m.task_id
          WHERE ${where.join(' AND ')}
          ORDER BY f.rank
          LIMIT ?`,
      ).all(...params) as MissionSearchHit[];
    } catch {
      // Invalid FTS5 query despite sanitising: we return empty rather than propagate an
      // unreadable SqliteError up to the calling agent. The `status` filter used to be
      return [];
    }
  },
  listMissions(
    limit = 100,
    agentNames?: string[],
    status?: string,
    viewer?: DbViewer | null,
    origin?: MissionOriginFilter,
  ): MissionListRow[] {
    const owner = ownerSql(viewer, 'missions', 'm.owner_user_id');
    const scoped = owner.sql !== '1=1';
    if (!agentNames && !status && !scoped && !origin) return listMissionsStmt.all(limit) as MissionListRow[];
    if (agentNames && agentNames.length === 0) return [];
    // missing: `/api/missions?status=running` returned the N latest missions of ALL
    // statuses, in silence. An agent diagnosing
    // cap saturation read 100 "running" missions
    // where there were 11 (2026-08-22) — an ignored filter lies more efficiently than an
    // error.
    const where: string[] = [];
    const params: unknown[] = [];
    if (agentNames) {
      where.push(`m.agent_name IN (${agentNames.map(() => '?').join(', ')})`);
      params.push(...agentNames);
    }
    if (status) {
      where.push('m.status = ?');
      params.push(status);
    }
    if (origin === 'automated') {
      where.push(`(${MISSION_ORIGIN_SQL}) <> 'user'`);
    } else if (origin) {
      where.push(`(${MISSION_ORIGIN_SQL}) = ?`);
      params.push(origin);
    }
    if (scoped) {
      where.push(owner.sql);
      params.push(...owner.params);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const stmt = db.prepare(missionListSql(whereSql));
    return stmt.all(...params, limit) as MissionListRow[];
  },
  /**
   * The candidates the chat binds when its URL names no mission: the agent's
   * `window` newest missions (the list's window), light columns only, most
   * recent activity first. Same owner scope as `listMissions`. The caller
   * picks the first running one, else the first — what the chat did with the
   * full list, minus the 300 briefs and per-row aggregates.
   */
  listLatestMissionCandidates(agent: string, viewer?: DbViewer | null, window = 300): LatestMissionCandidate[] {
    const owner = ownerSql(viewer, 'missions', 'm.owner_user_id');
    return db.prepare(
      `WITH page AS (
         SELECT m.id, m.agent_name, m.status, m.started_at, m.source_channel FROM missions m
          WHERE m.agent_name = ? AND ${owner.sql}
          ORDER BY m.started_at DESC
          LIMIT ?
       )
       SELECT * FROM (
         SELECT p.*,
                CASE WHEN st.ready = 1 THEN st.last_event_at
                     ELSE (SELECT MAX(e.timestamp) FROM events e WHERE e.mission_id = p.id) END AS last_event_at
           FROM page p
           LEFT JOIN mission_stats st ON st.mission_id = p.id
          WHERE COALESCE(p.source_channel, '') <> 'setup'
       )
       -- Sorted outside the join: there, last_event_at would name the column of st, not the alias.
       ORDER BY COALESCE(last_event_at, started_at) DESC, started_at DESC`,
    ).all(agent, ...owner.params, window) as LatestMissionCandidate[];
  },
  /**
   * Missions still running or ended since `endedSince` (epoch ms), with only the
   * columns the activity strip reads. Deliberately not `listMissions`: its
   * trace_spans aggregate and last-event subquery cost hundreds of ms on a large
   * install, and /api/agents/active runs this every few seconds per window.
   */
  listActiveMissions(endedSince: number, viewer?: DbViewer | null): ActiveMissionRow[] {
    const owner = ownerSql(viewer, 'missions', 'owner_user_id');
    return (owner.sql === '1=1'
      ? listActiveMissionsStmt.all(endedSince)
      : listActiveMissionsOwnedStmt.all(endedSince, ...owner.params)) as ActiveMissionRow[];
  },
  /** Last known activity of each agent (epoch ms), missions combined.
   *  Used for the "project I am working on" sort of the agents grid: the
   *  `projects.last_activity` column only moves at mission_complete, so it misses
   *  everything still running and everything that failed. */
  lastActivityByAgent(): Array<{ agent_name: string; at: number }> {
    return lastActivityByAgentStmt.all() as Array<{ agent_name: string; at: number }>;
  },
  /** Returns the `model` (provider slug) captured on the mission's last `result`
   *  event, or null if no result has landed yet. This is the model the backend
   *  actually used for the last turn — more reliable than the agent's static
   *  config. */
  getLastResultModel(missionId: string): string | null {
    const row = latestResultPayloadStmt.get(missionId) as { payload: string } | undefined;
    return row ? resultModelOf(row.payload) : null;
  },
  /** True when the mission's last turn ended on a failure Timon had scheduled
   *  for a replay (`timon_retry`, agent.ts) and nothing came after: no replay
   *  input, no new input, no `turn_retry_abandoned`. The replay timer lives in
   *  memory, so after a daemon restart this is a turn nobody will ever finish. */
  lastTurnAwaitsReplay(missionId: string): boolean {
    const row = latestTurnEdgeStmt.get(missionId) as { type: string; payload: string } | undefined;
    if (row?.type !== 'result') return false;
    try {
      const retry = (JSON.parse(row.payload) as { timon_retry?: unknown } | null)?.timon_retry;
      return retry !== undefined && retry !== null;
    } catch {
      return false;
    }
  },
  /** Last text an agent wrote in a mission — its final report.
   *
   *  The very last event of a mission is usually a `result`, and the assistant
   *  events in between often carry only a `tool_use` block: the report is the
   *  newest assistant event holding at least one non-empty `text` block.
   *  Returns null when the mission was killed mid-turn (no text at all). */
  getMissionFinalText(missionId: string, scan = 40): string | null {
    const rows = lastAssistantEventsStmt.all(missionId, scan) as { payload: string }[];
    for (const row of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.payload); } catch { continue; }
      const content = (parsed as { message?: { content?: unknown } } | null)?.message?.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .filter((b): b is { type: string; text: string } =>
          !!b && typeof b === 'object'
          && (b as { type?: unknown }).type === 'text'
          && typeof (b as { text?: unknown }).text === 'string')
        .map((b) => b.text.trim())
        .filter((t) => t.length > 0)
        .join('\n\n');
      if (text.length > 0) return text;
    }
    return null;
  },
  /** True when the mission's last turn is over: a `result` landed after the
   *  most recent user input.
   *
   *  The state that a persistent backend makes ambiguous — `status` stays
   *  `running` until the idle reap, long after the agent stopped working. This
   *  predicate is persisted, so it survives an orchestrator restart, unlike
   *  `turn_active` (in-memory `getTurnState`). Tool results are persisted as
   *  `user` events too, which changes nothing here: they always precede their
   *  own turn's `result`. The first turn has no `user`
   *  event at all — the brief is passed on the command line — hence the -1
   *  floor rather than a join.
   *
   *  The `result` of a turn a steer stopped does not count: between it and the
   *  instruction, a wait already polling would take the half-written text for
   *  the answer (TODO #662). It may even land after the instruction, when the
   *  stop is acknowledged late. If the instruction then never reaches the agent,
   *  the mission reads as open, not as answered, until its next turn or its end. */
  missionTurnEnded(missionId: string): boolean {
    const result = lastTurnEndId(missionId);
    const lastUser = ((lastEventIdOfTypeStmt.get(missionId, 'user') as { id: number | null } | undefined)?.id) ?? -1;
    return result >= 0 && result > lastUser;
  },
  /** True when the mission's last turn neither ended nor was already marked
   *  cut: no `result`, `turn_interrupted` or `spawn_failed` after the most
   *  recent user input. Unlike `missionTurnEnded`, a turn the user already
   *  interrupted counts as closed — its thread carries its notice already. */
  missionTurnOpen(missionId: string): boolean {
    const lastId = (type: string): number =>
      ((lastEventIdOfTypeStmt.get(missionId, type) as { id: number | null } | undefined)?.id) ?? -1;
    // A steer's stop never closes the turn on its own: it follows its own
    // `turn_interrupted`, and when it lands late the steered turn is the open one.
    const closed = Math.max(lastTurnEndId(missionId), lastId('turn_interrupted'), lastId('spawn_failed'));
    return closed < 0 || closed < lastId('user');
  },
  countEvents(missionId: string): number {
    return (countEventsStmt.get(missionId) as { n: number }).n;
  },
  /** Messages and request deliveries still pending for a mission (see the
   *  statements above) — what its agent has yet to read or answer. The agent's
   *  unaddressed inbox counts only for a mission still `running`: it goes to the
   *  agent's next mission, so crediting it to every finished one would stamp the
   *  same count on the whole history. */
  missionPendingWork(missionId: string, agent: string, status: string): { pending_messages: number; open_deliveries: number } {
    return {
      pending_messages: (countPendingMessagesStmt.get(missionId, status === 'running' ? 1 : 0, agent) as { n: number }).n,
      open_deliveries: (countOpenDeliveriesStmt.get(missionId) as { n: number }).n,
    };
  },
  updateMissionUsage(
    id: string,
    cost: number | null,
    tokensIn: number | null,
    tokensOut: number | null,
  ): void {
    updateUsageStmt.run(cost, tokensIn, tokensOut, id);
  },
  setMissionSession(id: string, sessionId: string): void {
    updateSessionStmt.run(sessionId, id);
    // A new session started after a rewind was built from the visible thread:
    // the pending cut is spent, whichever path opened it (a backend switch…).
    db.prepare(`DELETE FROM mission_rewind_pending WHERE mission_id = ?`).run(id);
  },
  /** Records a rewind for the next spawn; a further rewind replaces it but keeps
   *  the session the first one cut (the one the conversation was spoken in). */
  setPendingRewind(id: string, sessionId: string | null, rewindEventId: number): void {
    db.prepare(
      `INSERT INTO mission_rewind_pending (mission_id, session_id, rewind_event_id) VALUES (?, ?, ?)
       ON CONFLICT(mission_id) DO UPDATE SET rewind_event_id = excluded.rewind_event_id,
         session_id = COALESCE(mission_rewind_pending.session_id, excluded.session_id)`,
    ).run(id, sessionId, rewindEventId);
  },
  getPendingRewind(id: string): { session_id: string | null; rewind_event_id: number } | null {
    return (db.prepare(`SELECT session_id, rewind_event_id FROM mission_rewind_pending WHERE mission_id = ?`)
      .get(id) as { session_id: string | null; rewind_event_id: number } | undefined) ?? null;
  },
  clearPendingRewind(id: string): void {
    db.prepare(`DELETE FROM mission_rewind_pending WHERE mission_id = ?`).run(id);
  },
  /** Detach the mission from its provider session. Called on backend switch: the
   *  id belongs to the old CLI and means nothing to the new one — leaving it in
   *  place would attempt an impossible resume on the next turn (`sendToAgent`
   *  passes `m.session_id` as-is to one-shot backends). */
  clearMissionSession(id: string): void {
    updateSessionStmt.run(null, id);
  },
  /** Sweep any mission left `running` from a previous orchestrator
   *  process — its subprocess is gone, so the row is a zombie. Marks
   *  them failed with exit_code=-1 and returns the affected ids so
   *  callers can emit bus events for live UI clients. */
  /** All currently `running` missions, complete rows. Used by the reaper (agent.ts)
   *  to sweep ghosts without depending on listMissions' LIMIT. */
  listRunningMissions(): MissionRow[] {
    return listRunningMissionRowsStmt.all() as MissionRow[];
  },
  /** Mark failed every mission left `running` from a previous process and return,
   *  for each, its qualified death cause (see the statement's COALESCE: `crash` by
   *  default, the already-observed cause otherwise). */
  markZombiesAsFailed(keep: ReadonlySet<string> = new Set()): Array<{ id: string; reason: InterruptionReason }> {
    // `keep`: the missions this boot reattached (a remote session still alive
    // on its server). The ids returned and the rows updated must be the same
    // set, or a reattached mission gets a `mission_complete` and returns twice.
    const rows = (listRunningMissionsStmt.all() as { id: string }[]).filter((r) => !keep.has(r.id));
    if (rows.length === 0) return [];
    const now = Date.now();
    db.transaction(() => {
      if (keep.size === 0) markZombiesFailedStmt.run(now);
      else for (const r of rows) markZombieFailedStmt.run(now, r.id);
      for (const r of rows) deleteRemoteResumeStmt.run(r.id);
    })();
    return rows.map((r) => {
      const m = getMissionStmt.get(r.id) as MissionRow | undefined;
      return { id: r.id, reason: toInterruptionReason(m?.interrupted_reason) ?? 'crash' };
    });
  },
  /** Persist (or, with null, forget) the resume state of a remote mission —
   *  JSON already validated by `serializeResumeState`. */
  setMissionRemoteResume(id: string, json: string | null): void {
    if (json === null) deleteRemoteResumeStmt.run(id);
    else upsertRemoteResumeStmt.run(id, json, Date.now());
  },
  getMissionRemoteResume(id: string): string | null {
    return (getRemoteResumeStmt.get(id) as { state: string } | undefined)?.state ?? null;
  },
  /** See the `user_engaged` column. Never cleared: a conversation a person took part in stays theirs. */
  markMissionUserEngaged(id: string): void {
    db.prepare(`UPDATE missions SET user_engaged = 1 WHERE id = ? AND user_engaged = 0`).run(id);
  },
  getLatestSessionForAgent(agentName: string, ownerUserId?: string | null): string | null {
    const row = (ownerUserId === undefined ? latestSessionStmt.get(agentName)
      : db.prepare(`SELECT session_id FROM missions WHERE agent_name = ? AND owner_user_id IS ?
          AND session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1`).get(agentName, ownerUserId)) as
      { session_id: string } | undefined;
    return row?.session_id ?? null;
  },
  /** Mission a provider session belongs to (the most recent if several share it,
   *  which happens when a mission is resumed in place). Returns enough to recover
   *  its effective backend. */
  getMissionBySessionId(
    sessionId: string,
  ): { id: string; agentName: string; backendOverride: string | null; ownerUserId: string | null } | null {
    const row = missionBySessionStmt.get(sessionId) as
      | { id: string; agent_name: string; backend_override: string | null; owner_user_id: string | null }
      | undefined;
    if (!row) return null;
    return { id: row.id, agentName: row.agent_name, backendOverride: row.backend_override,
      ownerUserId: row.owner_user_id };
  },
  /**
   * The user (or a plugin acting as one) renames a mission: `manual`, which no
   * automatic source ever overwrites. Null or blank clears BOTH the title and
   * its source — the list falls back to the first message — but does NOT re-arm
   * the one-shot: `title_generation` stays as it was, because the generation
   * belongs to the first turn, which is over by the time anyone clears a title.
   * The change is announced on the bus with who made it; a no-op write (same
   * title, same source) is announced too — the caller wanted it said.
   */
  setMissionTitle(id: string, title: string | null, origin: MissionTitleOrigin = { kind: 'user', id: null }): void {
    const clean = title && title.trim() ? title : null;
    const source: MissionTitleSource | null = clean ? 'manual' : null;
    const changed = db.prepare(`UPDATE missions SET title = ?, title_source = ? WHERE id = ?`).run(clean, source, id).changes;
    if (changed) bus.publish({ kind: 'mission_title_changed', missionId: id, title: clean, source, origin });
  },
  /**
   * The launcher names the mission at spawn (`preset`): a task title, a
   * workflow node, a `title` passed to `mission_spawn`. Written once, before the
   * first turn, so it is never raced by a rename.
   */
  setMissionPresetTitle(id: string, title: string): void {
    const clean = title.trim();
    if (!clean) return;
    const changed = db.prepare(`UPDATE missions SET title = ?, title_source = 'preset' WHERE id = ?`).run(clean, id).changes;
    if (changed) bus.publish({ kind: 'mission_title_changed', missionId: id, title: clean, source: 'preset', origin: { kind: 'system', id: null } });
  },
  /**
   * An automatic title (`generated` or `native`) lands ONLY where no human or
   * launcher spoke: the rank check and the write are one statement, so a rename
   * that races the one-shot wins whatever the ordering. Returns whether the
   * row was written. A `native` title also leaves an identical title alone.
   */
  setMissionTitleIfUnclaimed(id: string, title: string, source: 'generated' | 'native'): boolean {
    const clean = title.trim();
    if (!clean) return false;
    const changed = db.prepare(
      `UPDATE missions SET title = ?, title_source = ?
        WHERE id = ?
          AND (title_source IS NULL OR title_source IN ('generated', 'native'))
          AND (title IS NULL OR title <> ?)`,
    ).run(clean, source, id, clean).changes;
    if (changed) bus.publish({ kind: 'mission_title_changed', missionId: id, title: clean, source, origin: { kind: 'system', id: null } });
    return changed > 0;
  },
  /**
   * Claims the one-shot generation of a mission's title: true exactly once per
   * mission, and only while it has no title at all. The claim is the
   * idempotence marker; it is taken before the one-shot runs, so a failed
   * generation is not retried either (a title is a nicety, a second quota hit
   * is not).
   */
  claimMissionTitleGeneration(id: string): boolean {
    return db.prepare(
      `UPDATE missions SET title_generation = 1 WHERE id = ? AND title_generation = 0 AND title IS NULL`,
    ).run(id).changes > 0;
  },
  setMissionSummary(id: string, summary: string, throughEventId: number): void {
    updateSummaryStmt.run(summary, Date.now(), throughEventId, id);
  },
  setForkedFrom(id: string, parent: string): void {
    setForkedFromStmt.run(parent, id);
    inheritTraceFromMissionStmt.run(parent, id);
  },
  /** Set or clear the per-mission LLM overrides. Pass null for either
   *  field to fall back to the agent's config.json value for spawns. */
  setMissionLlmOverrides(
    id: string,
    backend: string | null,
    model: string | null,
  ): void {
    setLlmOverridesStmt.run(backend, model, id);
  },
  /** A backend switch whose turn never started gives the row back as it found
   *  it, so the conversation resumes where it was and another try stays possible. */
  restoreMissionHandover(row: MissionRow): void {
    restoreMissionHandoverStmt.run(
      row.backend_override, row.model_override, row.session_id, row.status, row.ended_at,
      row.exit_code, row.interrupted_reason, row.return_notified, row.id,
    );
  },
  /** Set or clear the per-mission reasoning effort. Pass null to use the
   *  model's default. */
  setMissionReasoningEffort(
    id: string,
    effort: string | null,
  ): void {
    setReasoningEffortStmt.run(effort, id);
  },
  /** Persist per-spawn skill/MCP extras so all turns of a mission
   *  (including codex one-shot respawns) inherit the same injections. */
  setMissionExtras(
    id: string,
    extraSkills: string[] | null,
    extraMcpServers: string[] | null,
    extraAllowedTools: string[] | null = null,
  ): void {
    setMissionExtrasStmt.run(
      extraSkills?.length ? JSON.stringify(extraSkills) : null,
      extraMcpServers?.length ? JSON.stringify(extraMcpServers) : null,
      extraAllowedTools?.length ? JSON.stringify(extraAllowedTools) : null,
      id,
    );
  },
  setMissionCwdOverride(id: string, cwd: string | null): void {
    setMissionCwdOverrideStmt.run(cwd, id);
  },
  setMissionPermissionModeOverride(id: string, mode: string | null): void {
    setMissionPermissionModeOverrideStmt.run(mode, id);
  },
  /** Set the mission's MCP override. When non-null, spawnTurn replaces
   *  cfg.mcp_servers with this array (even empty = zero MCP). NULL = legacy merge. */
  setMissionMcpOverride(id: string, mcpIds: string[]): void {
    setMissionMcpOverrideStmt.run(JSON.stringify(mcpIds), id);
  },
  setMissionLineage(
    id: string,
    lineage: {
      parentMissionId?: string | null;
      parentAgent?: string | null;
      taskId?: string | null;
      routineId?: string | null;
    },
  ): void {
    setMissionLineageStmt.run(
      lineage.parentMissionId ?? null,
      lineage.parentAgent ?? null,
      lineage.taskId ?? null,
      lineage.routineId ?? null,
      id,
    );
    if (lineage.parentMissionId || lineage.taskId) {
      inheritTraceFromLineageStmt.run(lineage.parentMissionId ?? null, lineage.taskId ?? null, id);
    }
    // The lineage is what makes the mission a CHILD, and it is set after the
    // spawn: `mission_start` fires while the row is still parentless, so it
    // cannot serve as the arrival signal. Published here, at the single point
    // every spawn path goes through (dispatcher, delegation, http-helpers,
    // librarian, agent). Consumers treat it as an invalidation, not as data:
    // a path calling this twice costs one refetch, never a duplicate line.
    if (lineage.parentMissionId) {
      const row = getMissionStmt.get(id) as MissionRow | undefined;
      bus.publish({
        kind: 'mission_child_started',
        missionId: id,
        parentMissionId: lineage.parentMissionId,
        agent: row?.agent_name ?? '',
      });
    }
  },
  // ── trace spans (W.0) ─────────────────────────────────────────────────────
  /** Apply span operations in one transaction. Idempotent: opening an existing
   *  id or closing a non-running span changes nothing. Returns what really
   *  changed. Callers on the mission path wrap this in try/catch — a span
   *  failure must never fail the mission (PRD workflows §12.1). */
  upsertSpans(ops: SpanOp[]): { opened: number; closed: number } {
    if (ops.length === 0) return { opened: 0, closed: 0 };
    return upsertSpansTx(ops);
  },
  listSpans(missionId: string): SpanRow[] {
    return listSpansStmt.all(missionId) as SpanRow[];
  },
  listSpansByTrace(traceId: string): SpanRow[] {
    return listSpansByTraceStmt.all(traceId) as SpanRow[];
  },
  /** One window of a mission's timeline, ordered like `listSpans` (seq, then
   *  insertion). No cursor = the most recent `limit`; `before` = the `limit`
   *  spans just older than that cursor (exclusive); `from` = the spans at or
   *  after it (inclusive, so a refresh can re-read the spans that were still
   *  running when it last looked). `has_more` is relative to the direction
   *  asked: older for the first two, newer for `from`. Summary columns only. */
  listSpansPage(missionId: string, opts: { limit: number; kind?: string | null; before?: string | null; from?: string | null }): SpanPage {
    const params: Record<string, string | number> = { mission: missionId, take: opts.limit + 1 };
    const where = ['mission_id = @mission'];
    if (opts.kind) { where.push('kind = @kind'); params.kind = opts.kind; }
    const forward = Boolean(opts.from);
    const cursor = opts.from ?? opts.before ?? null;
    if (cursor) {
      const { seq, rid } = splitSpanCursor(cursor);
      params.seq = seq; params.rid = rid;
      where.push(`(seq, rowid) ${forward ? '>=' : '<'} (@seq, @rid)`);
    }
    const order = forward ? 'ASC' : 'DESC';
    const rows = cachedStmt(spanPageStmts,
      `SELECT rowid AS rid, ${SPAN_SUMMARY_COLUMNS} FROM trace_spans WHERE ${where.join(' AND ')}
        ORDER BY seq ${order}, rowid ${order} LIMIT @take`,
    ).all(params) as Array<SpanSummary & { rid: number }>;
    const has_more = rows.length > opts.limit;
    const kept = has_more ? rows.slice(0, opts.limit) : rows;
    if (!forward) kept.reverse();
    const spans = kept.map(({ rid, ...span }) => ({ ...span, cursor: `${span.seq}.${rid}` }));
    const countParams: Record<string, string> = { mission: missionId };
    if (opts.kind) countParams.kind = opts.kind;
    const { total } = cachedStmt(countMissionSpansStmts,
      `SELECT COUNT(*) AS total FROM trace_spans WHERE mission_id = @mission${opts.kind ? ' AND kind = @kind' : ''}`,
    ).get(countParams) as { total: number };
    return { spans, total, has_more };
  },
  /** Summary rows of the given spans of a mission: how a timeline re-reads the
   *  spans it holds as `running`, whose position is far behind its tail (a turn
   *  span stays open for the whole turn). */
  listSpansByIds(missionId: string, ids: string[]): SpanPageRow[] {
    const rows = cachedStmt(spanPageStmts,
      `SELECT rowid AS rid, ${SPAN_SUMMARY_COLUMNS} FROM trace_spans
        WHERE mission_id = @mission AND id IN (SELECT value FROM json_each(@ids)) ORDER BY seq ASC, rowid ASC`,
    ).all({ mission: missionId, ids: JSON.stringify(ids) }) as Array<SpanSummary & { rid: number }>;
    return rows.map(({ rid, ...span }) => ({ ...span, cursor: `${span.seq}.${rid}` }));
  },
  /** The full row of one span (payloads included), scoped to its mission so a
   *  span id cannot be read through another mission's URL. */
  getSpan(missionId: string, spanId: string): SpanRow | undefined {
    return getSpanStmt.get(spanId, missionId) as SpanRow | undefined;
  },
  /** Exact aggregates of a trace over the missions the caller may see, plus
   *  its latest `limit` spans in chronological order. The aggregates run in SQL
   *  so they stay exact when `spans` is capped. */
  summarizeTraceSpans(traceId: string, missionIds: string[], opts: { limit: number; payload: boolean }): {
    spans: Array<SpanSummary | SpanRow>;
    aggregates: { spans: number; duration_ms: number; tokens_in: number; tokens_out: number; cost_usd: number; tools: number; errors: number };
    /** Spans removed by retention, already counted in the sums of `aggregates` but not in its `spans`. */
    pruned: number;
  } {
    const missions = JSON.stringify(missionIds);
    type Sums = { spans: number; duration_ms: number; tokens_in: number; tokens_out: number; cost_usd: number; tools: number; errors: number };
    const live = traceSpanAggregatesStmt.get({ trace: traceId, missions }) as Sums;
    const gone = prunedTraceTotalsStmt.get(missions) as Sums;
    const aggregates: Sums = {
      spans: live.spans, duration_ms: live.duration_ms + gone.duration_ms, tokens_in: live.tokens_in + gone.tokens_in,
      tokens_out: live.tokens_out + gone.tokens_out, cost_usd: live.cost_usd + gone.cost_usd,
      tools: live.tools + gone.tools, errors: live.errors + gone.errors,
    };
    const columns = opts.payload ? '*' : SPAN_SUMMARY_COLUMNS;
    const spans = (cachedStmt(spanPageStmts,
      `SELECT ${columns} FROM trace_spans
        WHERE trace_id = @trace AND mission_id IN (SELECT value FROM json_each(@missions))
          -- a rewound turn leaves the listing; the aggregates keep its cost (docs/specs/rewind.md § 10)
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = trace_spans.event_id_start AND e.rewound_by IS NOT NULL)
        ORDER BY started_at DESC, seq DESC, rowid DESC LIMIT @take`,
    ).all({ trace: traceId, missions, take: opts.limit }) as Array<SpanSummary | SpanRow>).reverse();
    return { spans, aggregates, pruned: gone.spans };
  },
  listSpansByRun(runId: string): SpanRow[] {
    return listSpansByRunStmt.all({ run: runId }) as SpanRow[];
  },
  /** At most `limit` spans of a run, without payloads, in timeline order:
   *  every `workflow` / `node` span, then the most recent others. */
  listSpanSummariesByRun(runId: string, limit: number): { spans: SpanSummary[]; total: number; truncated: boolean } {
    const spans = (listSpanSummariesByRunStmt.all({ run: runId, take: limit }) as SpanSummary[])
      .sort((a, b) => a.started_at - b.started_at || a.seq - b.seq);
    const { total } = countSpansByRunStmt.get({ run: runId }) as { total: number };
    return { spans, total, truncated: total > spans.length };
  },
  /** One span of a run, payloads included; undefined when the span is not part of that run. */
  getRunSpan(runId: string, spanId: string): SpanRow | undefined {
    return getRunSpanStmt.get({ run: runId, span: spanId }) as SpanRow | undefined;
  },
  /**
   * Deletes the spans that ended before `cutoff` in missions that are over
   * (PRD workflows §13.1), keeping their totals in `mission_span_totals`. A live
   * mission keeps its whole timeline, whatever its age. So do a workflow run's
   * own spans (`workflow`, `node`): they are written by the engine, not derived
   * from a mission's events, so nothing could rebuild them. The rest is an index
   * of the events: `rebuildMissionSpans` brings it back.
   *
   * Stops once past `maxRows` so the caller can hand the event loop back: a
   * first pass over a large home is hundreds of thousands of rows.
   */
  pruneTraceSpans(cutoff: number, batch = 5_000, maxRows = Number.POSITIVE_INFINITY): number {
    const missions = pruneSpanMissionsStmt.all(cutoff) as { id: string }[];
    let dropped = 0;
    for (const { id } of missions) {
      for (;;) {
        const changes = pruneSpansBatch(id, cutoff, batch);
        dropped += changes;
        if (dropped >= maxRows) return dropped;
        if (changes < batch) break;
      }
    }
    return dropped;
  },
  /** How many spans of this mission retention removed; 0 when none. */
  prunedSpanCount(missionId: string): number {
    return (missionSpanTotalsStmt.get(missionId) as number | undefined) ?? 0;
  },
  /** The spans are back: the live rows count again, or the list would count them twice. */
  clearPrunedSpanTotals(missionId: string): void {
    clearMissionSpanTotalsStmt.run(missionId);
  },
  listMissionsByTrace(traceId: string, viewer?: DbViewer | null): MissionRow[] {
    return (listMissionsByTraceStmt.all(traceId) as MissionRow[])
      .filter((row) => rowVisible(row, viewer, 'missions'));
  },
  listTasksByTrace(traceId: string, viewer?: DbViewer | null): TaskRow[] {
    return (listTasksByTraceStmt.all(traceId) as TaskRow[])
      .filter((row) => rowVisible(row, viewer, 'tasks'));
  },
  listMessagesByTrace(traceId: string, viewer?: DbViewer | null): AgentMessageRow[] {
    return (listMessagesByTraceStmt.all(traceId) as AgentMessageRow[])
      .filter((row) => rowVisible(row, viewer, 'agent_messages'));
  },
  /** Close every `running` span of a mission (reap, crash, mission_complete).
   *  Returns the number of spans closed. */
  closeOpenSpans(missionId: string, status: Exclude<SpanStatus, 'running'>, error?: string | null): number {
    const now = Date.now();
    return closeOpenSpansStmt.run(status, now, now, error ?? null, missionId).changes;
  },
  listChildMissions(parentId: string, viewer?: DbViewer | null): MissionRow[] {
    return (listChildMissionsStmt.all(parentId) as MissionRow[])
      .filter((row) => rowVisible(row, viewer, 'missions'));
  },
  listMissionsByTask(taskId: string, viewer?: DbViewer | null): MissionRow[] {
    return (listMissionsByTaskStmt.all(taskId) as MissionRow[])
      .filter((row) => rowVisible(row, viewer, 'missions'));
  },
  setMissionDocumentedAt(id: string, ts: number | null): void {
    setMissionDocumentedAtStmt.run(ts, id);
  },
  countUserTurns(missionId: string): number {
    return (countUserTurnsStmt.get(missionId) as { n: number }).n;
  },
  /** Highest events.id currently stored for a mission. Used to know
   *  whether an existing summary is up-to-date. Returns 0 if empty. */
  getLastEventId(missionId: string): number {
    const row = maxEventIdForMissionStmt.get(missionId) as { n: number };
    return row.n;
  },
  /** Did a turn run to its end on `backend` without reporting a session, since
   *  the mission's last context handover (a replay or a backend switch), or since
   *  its start if it had none? A turn that failed proves nothing, and neither does
   *  a handover made on another backend, or one whose context is still owed (a
   *  dead pilot repointed: a turn nobody gave the thread to settles nothing). */
  turnEndedWithoutSession(missionId: string, backend: string): boolean {
    return db
      .prepare(
        `WITH handover AS (
           SELECT COALESCE(MAX(id), 0) AS id FROM events
           WHERE mission_id = @mission AND type IN ('context_recovery', 'backend_switch')
         )
         SELECT 1 FROM handover
         WHERE COALESCE(
             (SELECT json_extract(payload, '$.backend') FROM events WHERE id = handover.id),
             @backend
           ) = @backend
           AND COALESCE(
             (SELECT json_extract(payload, '$.context_mode') FROM events WHERE id = handover.id),
             ''
           ) <> 'pending'
           AND EXISTS (
             SELECT 1 FROM events
             WHERE mission_id = @mission AND type = 'result' AND id > handover.id AND rewound_by IS NULL
               AND json_extract(payload, '$.subtype') = 'success'
               AND COALESCE(json_extract(payload, '$.is_error'), 0) = 0
           )
           AND NOT EXISTS (
             SELECT 1 FROM events
             WHERE mission_id = @mission AND type = 'system' AND id > handover.id AND rewound_by IS NULL
               AND json_extract(payload, '$.subtype') = 'init'
               AND COALESCE(json_extract(payload, '$.session_id'), '') <> ''
           )`,
      )
      .get({ mission: missionId, backend }) !== undefined;
  },
  /** Has the thread already said, since the last context handover, that this
   *  backend starts each turn from the message alone? Once per backend it lands
   *  on: repeating it at every turn would make it noise. */
  sessionlessTurnAnnounced(missionId: string): boolean {
    return db
      .prepare(
        `SELECT 1 FROM events
         WHERE mission_id = @mission AND type = 'sessionless_turn'
           AND id > (
             SELECT COALESCE(MAX(id), 0) FROM events
             WHERE mission_id = @mission AND type IN ('context_recovery', 'backend_switch')
           )`,
      )
      .get({ mission: missionId }) !== undefined;
  },
  /** Most recent system:init payload across all missions — used at boot
   *  to re-seed the MCP discovery cache so the UI lists claude.ai
   *  connectors without waiting for a fresh spawn. */
  getLatestInitPayload(): unknown {
    const row = db
      .prepare(
        `SELECT payload FROM events
         WHERE type = 'system' AND payload LIKE '%"subtype":"init"%'
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as { payload: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.payload); } catch { return null; }
  },

  // ── settings ───────────────────────────────────────────────────────────────
  /** Overridden keys only. A missing key = the registry default. */
  getAllSettings(): Record<string, string> {
    const rows = getAllSettingsStmt.all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
  setSetting(key: string, value: string): void {
    setSettingStmt.run(key, value, Date.now());
  },
  deleteSetting(key: string): void {
    deleteSettingStmt.run(key);
  },

  // ── notifications ──────────────────────────────────────────────────────────
  createNotification(n: {
    id: string;
    type: NotificationType;
    urgent?: boolean;
    title: string;
    body?: string | null;
    taskId?: string | null;
    missionId?: string | null;
    anchor?: string | null;
    /** Provenance, `plugin:<id>` for a third-party plugin. Absent = the daemon. */
    source?: string | null;
    ownerUserId?: string | null;
    traceId?: string | null;
    dismissOn?: readonly NotificationDismissOn[] | null;
    expiresAt?: number | null;
  }): NotificationRow {
    const now = Date.now();
    // §7: the title carries as much prose as the body — a report headline is a
    // frequent place to paste what an agent just read.
    n = { ...n, title: redactText(n.title), body: redactNullable(n.body) };
    const owner = resolveNotificationOwner(n);
    const dismissOn = n.dismissOn && n.dismissOn.length > 0 ? JSON.stringify(n.dismissOn) : null;
    insertNotificationStmt.run(
      n.id,
      n.type,
      n.urgent ? 1 : 0,
      n.title,
      n.body ?? null,
      n.taskId ?? null,
      n.missionId ?? null,
      n.anchor ?? null,
      n.source ?? null,
      now,
      owner,
      dismissOn,
      n.expiresAt ?? null,
    );
    return {
      id: n.id,
      type: n.type,
      urgent: n.urgent ? 1 : 0,
      title: n.title,
      body: n.body ?? null,
      task_id: n.taskId ?? null,
      mission_id: n.missionId ?? null,
      anchor: n.anchor ?? null,
      source: n.source ?? null,
      dismiss_on: dismissOn,
      expires_at: n.expiresAt ?? null,
      created_at: now,
      read_at: null,
      dismissed_at: null,
      owner_user_id: owner,
    };
  },
  listNotifications(opts: { archived?: boolean; limit?: number; viewer?: DbViewer | null } = {}): NotificationRow[] {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const owner = ownerSql(opts.viewer, 'notifications');
    if (owner.sql === '1=1') {
      if (opts.archived) return listAllNotificationsStmt.all(limit) as NotificationRow[];
      return listActiveNotificationsStmt.all(limit) as NotificationRow[];
    }
    if (opts.archived) {
      return db.prepare(
        `SELECT * FROM notifications WHERE ${owner.sql} ORDER BY created_at DESC LIMIT ?`,
      ).all(...owner.params, limit) as NotificationRow[];
    }
    return db.prepare(
      `SELECT * FROM notifications WHERE dismissed_at IS NULL AND ${owner.sql} ORDER BY urgent DESC, created_at DESC LIMIT ?`,
    ).all(...owner.params, limit) as NotificationRow[];
  },
  /**
   * Agent behind each notification, read from its mission, else its task.
   * Resolved at read time rather than stored: every notification ever raised
   * gets one, with no migration. Absent for the daemon's own notifications.
   */
  notificationAgents(rows: readonly Pick<NotificationRow, 'id' | 'mission_id' | 'task_id'>[]): Map<string, string> {
    const byMission = new Map<string, string>();
    const byTask = new Map<string, string>();
    const missionIds = [...new Set(rows.map((r) => r.mission_id).filter((id): id is string => !!id))];
    const taskIds = [...new Set(rows.map((r) => r.task_id).filter((id): id is string => !!id))];
    if (missionIds.length) {
      const found = db.prepare(`SELECT id, agent_name FROM missions WHERE id IN (${missionIds.map(() => '?').join(',')})`)
        .all(...missionIds) as { id: string; agent_name: string }[];
      for (const m of found) byMission.set(m.id, m.agent_name);
    }
    if (taskIds.length) {
      const found = db.prepare(`SELECT id, agent_name FROM tasks WHERE id IN (${taskIds.map(() => '?').join(',')})`)
        .all(...taskIds) as { id: string; agent_name: string }[];
      for (const t of found) byTask.set(t.id, t.agent_name);
    }
    const out = new Map<string, string>();
    for (const r of rows) {
      const agent = (r.mission_id && byMission.get(r.mission_id)) || (r.task_id && byTask.get(r.task_id)) || null;
      if (agent) out.set(r.id, agent);
    }
    return out;
  },
  getNotification(id: string, viewer?: DbViewer | null): NotificationRow | undefined {
    return rowVisible(getNotificationStmt.get(id) as NotificationRow | undefined, viewer, 'notifications');
  },
  dismissNotification(id: string): boolean {
    const result = dismissNotificationStmt.run(Date.now(), id);
    return result.changes > 0;
  },
  dismissNotificationsByTask(taskId: string, type: NotificationType): number {
    return dismissByTaskTypeStmt.run(Date.now(), taskId, type).changes;
  },
  dismissNotificationsByMission(missionId: string, type: NotificationType): number {
    return dismissByMissionTypeStmt.run(Date.now(), missionId, type).changes;
  },
  dismissNotificationsByAnchor(anchor: string, type: NotificationType): number {
    return dismissByAnchorTypeStmt.run(Date.now(), anchor, type).changes;
  },
  /** Active cards of `type` whose anchor starts with `prefix` (compared literally). */
  listActiveNotificationsByAnchorPrefix(prefix: string, type: NotificationType): NotificationRow[] {
    return listActiveByAnchorPrefixTypeStmt.all(type, prefix, prefix) as NotificationRow[];
  },
  /** Every anchor that starts with `prefix` (compared literally), open or long dismissed. */
  listNotificationAnchorsByPrefix(prefix: string): string[] {
    return (notificationAnchorsByPrefixStmt.all(prefix, prefix) as { anchor: string }[]).map((row) => row.anchor);
  },
  /** Active cards of a mission (or a task) that close on `trigger`. */
  listActiveNotificationsDismissedOn(
    link: { missionId: string } | { taskId: string },
    trigger: NotificationDismissOn,
  ): NotificationRow[] {
    const rows = ('missionId' in link
      ? listActiveDismissOnByMissionStmt.all(link.missionId)
      : listActiveDismissOnByTaskStmt.all(link.taskId)) as NotificationRow[];
    return rows.filter((n) => parseDismissOn(n.dismiss_on).includes(trigger));
  },
  listExpiredNotifications(now = Date.now()): NotificationRow[] {
    return listExpiredNotificationsStmt.all(now) as NotificationRow[];
  },
  listActiveNotifications(type?: NotificationType, viewer?: DbViewer | null): NotificationRow[] {
    const owner = ownerSql(viewer, 'notifications');
    if (owner.sql === '1=1') {
      return (type ? listActiveByTypeStmt.all(type) : listActiveAllStmt.all()) as NotificationRow[];
    }
    if (type) {
      return db.prepare(
        `SELECT * FROM notifications WHERE dismissed_at IS NULL AND type = ? AND ${owner.sql} ORDER BY created_at DESC`,
      ).all(type, ...owner.params) as NotificationRow[];
    }
    return db.prepare(
      `SELECT * FROM notifications WHERE dismissed_at IS NULL AND ${owner.sql} ORDER BY created_at DESC`,
    ).all(...owner.params) as NotificationRow[];
  },
  dismissAllNotifications(type?: NotificationType, viewer?: DbViewer | null): number {
    const now = Date.now();
    const owner = ownerSql(viewer, 'notifications');
    if (owner.sql === '1=1') {
      return (type ? dismissAllByTypeStmt.run(now, type) : dismissAllStmt.run(now)).changes;
    }
    if (type) {
      return db.prepare(
        `UPDATE notifications SET dismissed_at = ? WHERE dismissed_at IS NULL AND type = ? AND ${owner.sql}`,
      ).run(now, type, ...owner.params).changes;
    }
    return db.prepare(
      `UPDATE notifications SET dismissed_at = ? WHERE dismissed_at IS NULL AND ${owner.sql}`,
    ).run(now, ...owner.params).changes;
  },
  /** §7: the command and its note are masked before storage, like any event. */
  insertCommandRequest(r: Omit<CommandRequestRow, 'status' | 'created_at' | 'resolved_at'>): CommandRequestRow {
    const now = Date.now();
    insertCommandRequestStmt.run(
      r.id, r.mission_id, r.owner_user_id, r.agent, redactText(r.command), redactNullable(r.note),
      r.session_id, r.project, r.mission_title, r.task_id, r.choices, r.origin_kind, r.origin_id, now,
    );
    return getCommandRequestStmt.get(r.id) as CommandRequestRow;
  },
  insertApprovalRule(r: Omit<ApprovalRuleRow, 'created_at'>): ApprovalRuleRow {
    const now = Date.now();
    db.prepare(
      `INSERT INTO approval_rules (id, scope, owner_user_id, agent, mission_id, tool_name, command, command_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.scope, r.owner_user_id, r.agent, r.mission_id, r.tool_name, redactNullable(r.command), r.command_hash, now);
    return db.prepare(`SELECT * FROM approval_rules WHERE id = ?`).get(r.id) as ApprovalRuleRow;
  },
  /** The rule that answers this motif for this mission, if any: one of the
   *  mission's own `session` rules, or an `always` rule of its agent and owner. */
  findApprovalRule(q: { missionId: string; ownerUserId: string; agent: string; toolName: string; commandHash: string | null }): ApprovalRuleRow | undefined {
    return db.prepare(
      `SELECT * FROM approval_rules
       WHERE tool_name = ? AND command_hash IS ? AND owner_user_id = ? AND agent = ?
         AND ((scope = 'session' AND mission_id = ?) OR scope = 'always')
       ORDER BY created_at LIMIT 1`,
    ).get(q.toolName, q.commandHash, q.ownerUserId, q.agent, q.missionId) as ApprovalRuleRow | undefined;
  },
  /** `always` rules of an agent; `ownerUserId` null = every owner (operator). */
  listAlwaysApprovalRules(agent: string, ownerUserId: string | null): ApprovalRuleRow[] {
    return ownerUserId === null
      ? db.prepare(`SELECT * FROM approval_rules WHERE agent = ? AND scope = 'always' ORDER BY created_at`).all(agent) as ApprovalRuleRow[]
      : db.prepare(`SELECT * FROM approval_rules WHERE agent = ? AND scope = 'always' AND owner_user_id = ? ORDER BY created_at`)
        .all(agent, ownerUserId) as ApprovalRuleRow[];
  },
  /** Same reach as `listAlwaysApprovalRules`: a rule outside it is not found. */
  deleteApprovalRule(id: string, agent: string, ownerUserId: string | null): boolean {
    return (ownerUserId === null
      ? db.prepare(`DELETE FROM approval_rules WHERE id = ? AND agent = ?`).run(id, agent)
      : db.prepare(`DELETE FROM approval_rules WHERE id = ? AND agent = ? AND owner_user_id = ?`).run(id, agent, ownerUserId)
    ).changes > 0;
  },
  pruneApprovalRules,
  deleteApprovalRulesForAgent(agent: string): number {
    return db.prepare(`DELETE FROM approval_rules WHERE agent = ?`).run(agent).changes;
  },
  insertLayoutProposal(r: Omit<LayoutProposalRow, 'status' | 'created_at' | 'resolved_at'>): LayoutProposalRow {
    db.prepare(
      `INSERT INTO layout_proposals (id, kind, mission_id, owner_user_id, agent, payload, note, project, mission_title, task_id, origin_kind, origin_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(r.id, r.kind, r.mission_id, r.owner_user_id, r.agent, r.payload, redactNullable(r.note), r.project, r.mission_title, r.task_id, r.origin_kind, r.origin_id, Date.now());
    return db.prepare(`SELECT * FROM layout_proposals WHERE id = ?`).get(r.id) as LayoutProposalRow;
  },
  getLayoutProposal(id: string): LayoutProposalRow | undefined {
    return db.prepare(`SELECT * FROM layout_proposals WHERE id = ?`).get(id) as LayoutProposalRow | undefined;
  },
  /** Pending → decided, once: false when it was already decided. */
  settleLayoutProposal(id: string, status: Exclude<LayoutProposalStatus, 'pending'>): boolean {
    return db.prepare(`UPDATE layout_proposals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`)
      .run(status, Date.now(), id).changes > 0;
  },
  listLayoutProposals(filter: { ownerUserId: string; missionId?: string; status?: LayoutProposalStatus; limit?: number }): LayoutProposalRow[] {
    const where = ['owner_user_id = ?'];
    const params: (string | number)[] = [filter.ownerUserId];
    if (filter.missionId) { where.push('mission_id = ?'); params.push(filter.missionId); }
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    params.push(Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100))));
    return db.prepare(
      `SELECT * FROM layout_proposals WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params) as LayoutProposalRow[];
  },
  /** One kind across accounts (`ownerUserId` undefined: a superadmin's view). */
  listLayoutProposalsByKind(kind: string, filter: { ownerUserId?: string; status?: LayoutProposalStatus; limit?: number } = {}): LayoutProposalRow[] {
    const where = ['kind = ?'];
    const params: (string | number)[] = [kind];
    if (filter.ownerUserId !== undefined) { where.push('owner_user_id = ?'); params.push(filter.ownerUserId); }
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    params.push(Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100))));
    return db.prepare(
      `SELECT * FROM layout_proposals WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params) as LayoutProposalRow[];
  },
  /** §7: title and HTML are masked before storage, like a command request. */
  insertUiDocument(r: Omit<UiDocumentRow, 'status' | 'reply' | 'resolved_by_kind' | 'resolved_by_id' | 'resolved_at' | 'created_at'>): UiDocumentRow {
    db.prepare(
      `INSERT INTO ui_documents (id, mission_id, owner_user_id, origin_kind, origin_id, title, html, bridge, height,
         expects_reply, status, ref_provider, ref, project, mission_title, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.id, r.mission_id, r.owner_user_id, r.origin_kind, r.origin_id, redactText(r.title), redactText(r.html),
      r.bridge, r.height, r.expects_reply, r.expects_reply ? 'pending' : 'shown', r.ref_provider, r.ref,
      r.project, r.mission_title, r.task_id, Date.now(),
    );
    return db.prepare(`SELECT * FROM ui_documents WHERE id = ?`).get(r.id) as UiDocumentRow;
  },
  getUiDocument(id: string): UiDocumentRow | undefined {
    return db.prepare(`SELECT * FROM ui_documents WHERE id = ?`).get(id) as UiDocumentRow | undefined;
  },
  /** The document a plugin linked to an external reference (unique per plugin). */
  findUiDocumentByRef(originId: string, provider: string, ref: string): UiDocumentRow | undefined {
    return db.prepare(
      `SELECT * FROM ui_documents WHERE origin_kind = 'plugin' AND origin_id = ? AND ref_provider = ? AND ref = ?`,
    ).get(originId, provider, ref) as UiDocumentRow | undefined;
  },
  listUiDocuments(filter: {
    missionId?: string; missionIds?: readonly string[]; ownerUserId?: string;
    originKind?: UiDocumentOriginKind; originId?: string; status?: UiDocumentStatus; limit?: number;
  }): UiDocumentRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.missionId) { where.push('mission_id = ?'); params.push(filter.missionId); }
    if (filter.missionIds) {
      if (!filter.missionIds.length) return [];
      where.push(`mission_id IN (${filter.missionIds.map(() => '?').join(', ')})`);
      params.push(...filter.missionIds);
    }
    if (filter.ownerUserId) { where.push('owner_user_id = ?'); params.push(filter.ownerUserId); }
    if (filter.originKind) { where.push('origin_kind = ?'); params.push(filter.originKind); }
    if (filter.originId) { where.push('origin_id = ?'); params.push(filter.originId); }
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    params.push(Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100))));
    return db.prepare(
      `SELECT * FROM ui_documents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params) as UiDocumentRow[];
  },
  /** Every document of a mission, and those still waiting for an answer: the caps of ADR-MCPUI D2. */
  countUiDocuments(missionId: string): { total: number; pending: number } {
    const row = db.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'pending'), 0) AS pending FROM ui_documents WHERE mission_id = ?`,
    ).get(missionId) as { total: number; pending: number };
    return { total: row.total, pending: row.pending };
  },
  /**
   * Settles a document once: `answered` only from `pending`, `dismissed` from
   * `shown` or `pending`. False when it was already settled. The reply is
   * masked like the HTML.
   */
  settleUiDocument(id: string, outcome: {
    status: 'answered' | 'dismissed'; reply?: string | null; resolvedByKind: string; resolvedById: string | null;
  }): boolean {
    const from = outcome.status === 'answered' ? `status = 'pending'` : `status IN ('shown', 'pending')`;
    return db.prepare(
      `UPDATE ui_documents SET status = ?, reply = ?, resolved_by_kind = ?, resolved_by_id = ?, resolved_at = ?
       WHERE id = ? AND ${from}`,
    ).run(
      outcome.status, outcome.reply == null ? null : redactText(outcome.reply),
      outcome.resolvedByKind, outcome.resolvedById, Date.now(), id,
    ).changes > 0;
  },
  /**
   * Removes the documents whose mission `expired` says may go (finished longer
   * than the retention, or gone). Returns the removed rows, HTML dropped.
   */
  purgeUiDocuments(expired: (missionId: string) => boolean): Array<Omit<UiDocumentRow, 'html'>> {
    const missions = (db.prepare(`SELECT DISTINCT mission_id FROM ui_documents`).all() as Array<{ mission_id: string }>)
      .map((r) => r.mission_id)
      .filter((missionId) => expired(missionId));
    const removed: Array<Omit<UiDocumentRow, 'html'>> = [];
    const select = db.prepare(
      `SELECT id, mission_id, owner_user_id, origin_kind, origin_id, title, bridge, height, expects_reply, status, reply,
         resolved_by_kind, resolved_by_id, resolved_at, ref_provider, ref, project, mission_title, task_id, created_at
       FROM ui_documents WHERE mission_id = ?`,
    );
    const del = db.prepare(`DELETE FROM ui_documents WHERE mission_id = ?`);
    db.transaction(() => {
      for (const missionId of missions) {
        removed.push(...(select.all(missionId) as Array<Omit<UiDocumentRow, 'html'>>));
        del.run(missionId);
      }
    })();
    return removed;
  },
  getCommandRequest(id: string): CommandRequestRow | undefined {
    return getCommandRequestStmt.get(id) as CommandRequestRow | undefined;
  },
  /** Pending → decided, once: false when it was already decided. */
  settleCommandRequest(id: string, status: Exclude<CommandRequestStatus, 'pending'>): boolean {
    return settleCommandRequestStmt.run(status, Date.now(), id).changes > 0;
  },
  listCommandRequests(filter: { ownerUserId: string; missionId?: string; status?: CommandRequestStatus; limit?: number }): CommandRequestRow[] {
    const where = ['owner_user_id = ?'];
    const params: (string | number)[] = [filter.ownerUserId];
    if (filter.missionId) { where.push('mission_id = ?'); params.push(filter.missionId); }
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    params.push(Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100))));
    return db.prepare(
      `SELECT * FROM command_requests WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params) as CommandRequestRow[];
  },
  /** Pending requests of one owner, per project (`null` = no project). */
  countPendingCommandRequests(ownerUserId: string): Array<{ project: string | null; n: number }> {
    return countPendingCommandRequestsStmt.all(ownerUserId) as Array<{ project: string | null; n: number }>;
  },
  listActiveNotificationsByMission(missionId: string, type: NotificationType): NotificationRow[] {
    return listActiveByMissionTypeStmt.all(missionId, type) as NotificationRow[];
  },
  countActiveNotifications(viewer?: DbViewer | null): number {
    const owner = ownerSql(viewer, 'notifications');
    if (owner.sql === '1=1') return (countActiveNotificationsStmt.get() as { n: number }).n;
    return (db.prepare(
      `SELECT COUNT(*) as n FROM notifications WHERE dismissed_at IS NULL AND ${owner.sql}`,
    ).get(...owner.params) as { n: number }).n;
  },
  countActiveByType(viewer?: DbViewer | null): Record<NotificationType, number> {
    const owner = ownerSql(viewer, 'notifications');
    const rows = (owner.sql === '1=1'
      ? countActiveByTypeStmt.all()
      : db.prepare(
          `SELECT type, COUNT(*) as n FROM notifications WHERE dismissed_at IS NULL AND ${owner.sql} GROUP BY type`,
        ).all(...owner.params)) as Array<{ type: string; n: number }>;
    const result: Record<string, number> = { action_required: 0, alert: 0, report: 0 };
    for (const r of rows) result[r.type] = r.n;
    return result as Record<NotificationType, number>;
  },

  // ── web push ───────────────────────────────────────────────────────────────
  upsertPushSubscription(s: {
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    deviceLabel?: string | null;
  }): PushSubscriptionRow {
    const now = Date.now();
    upsertPushSubStmt.run(s.id, s.endpoint, s.p256dh, s.auth, s.deviceLabel ?? null, now, now);
    return getPushSubByEndpointStmt.get(s.endpoint) as PushSubscriptionRow;
  },
  listPushSubscriptions(): PushSubscriptionRow[] {
    return listPushSubsStmt.all() as PushSubscriptionRow[];
  },
  getPushSubscriptionByEndpoint(endpoint: string): PushSubscriptionRow | undefined {
    return getPushSubByEndpointStmt.get(endpoint) as PushSubscriptionRow | undefined;
  },
  deletePushSubscriptionByEndpoint(endpoint: string): boolean {
    const row = getPushSubByEndpointStmt.get(endpoint) as PushSubscriptionRow | undefined;
    if (!row) return false;
    deletePushDeliveriesForSubStmt.run(row.id);
    return deletePushSubByEndpointStmt.run(endpoint).changes > 0;
  },
  /** Purge a dead subscription (404/410 at send time). We also delete its delivery
   *  traces: without that the table grows without bound with rows that no longer
   *  reference anything. */
  deletePushSubscription(id: string): boolean {
    deletePushDeliveriesForSubStmt.run(id);
    return deletePushSubStmt.run(id).changes > 0;
  },
  setPushSubscriptionError(id: string, error: string | null): void {
    setPushSubErrorStmt.run(error, id);
  },
  recordPushDelivery(
    notificationId: string,
    subscriptionId: string,
    status: 'sent' | 'failed' | 'gone',
    error?: string | null,
  ): void {
    recordPushDeliveryStmt.run(notificationId, subscriptionId, status, Date.now(), error ?? null);
  },
  /** true if THIS (notification, subscription) tuple has already been delivered
   *  successfully. Voluntarily by tuple: a failing device must not make it look as
   *  if the notification is handled for the others. */
  wasPushDelivered(notificationId: string, subscriptionId: string): boolean {
    const row = getPushDeliveryStmt.get(notificationId, subscriptionId) as { status: string } | undefined;
    return row?.status === 'sent';
  },

  // ── routines ───────────────────────────────────────────────────────────────
  // A view over `triggers` since TODO #216: the rows live there, as schedule
  // triggers `created_by = 'routine'`, and keep their RoutineRow shape here so
  // every reader (graph, backup, workflows import, /api/routines) is unchanged.
  // Update semantics are the historical COALESCE ones: a null keeps the value.
  createRoutine(
    r: Omit<RoutineRow, 'created_at' | 'updated_at' | 'last_run_at' | 'owner_user_id'>
      & { last_run_at?: number | null; owner_user_id?: string | null },
  ): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO triggers (id, name, source, enabled, config, actions, created_by, owner_user_id, last_run_at, next_run_at, created_at, updated_at)
       VALUES (?, ?, 'schedule', ?, ?, ?, 'routine', ?, ?, ?, ?, ?)`,
    ).run(
      r.id, r.name,
      r.enabled ? 1 : 0,
      JSON.stringify({ cron: r.cron_expr }),
      JSON.stringify([routineAction(r)]),
      r.owner_user_id ?? null,
      r.last_run_at ?? null,
      r.next_run_at ?? null,
      now, now,
    );
  },
  getRoutine(id: string): RoutineRow | undefined {
    return db.prepare(`${ROUTINE_VIEW} AND id = ?`).get(id) as RoutineRow | undefined;
  },
  listRoutines(): RoutineRow[] {
    return db.prepare(`${ROUTINE_VIEW} ORDER BY created_at DESC`).all() as RoutineRow[];
  },
  /** Enabled routines whose next_run_at has passed. The tick loops over them. */
  listDueRoutines(now: number = Date.now()): RoutineRow[] {
    return db.prepare(
      `${ROUTINE_VIEW} AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
    ).all(now) as RoutineRow[];
  },
  updateRoutine(
    id: string,
    fields: {
      name?: string;
      agent_name?: string;
      prompt?: string;
      task_type?: TaskType;
      cron_expr?: string;
      enabled?: boolean;
      project?: string | null;
      next_run_at?: number | null;
    },
  ): void {
    const current = this.getRoutine(id);
    if (!current) return;
    const merged = {
      agent_name: fields.agent_name ?? current.agent_name,
      prompt: fields.prompt ?? current.prompt,
      task_type: fields.task_type ?? current.task_type,
      project: fields.project ?? current.project,
    };
    db.prepare(
      `UPDATE triggers SET
         name = COALESCE(?, name),
         config = ?,
         actions = ?,
         enabled = COALESCE(?, enabled),
         next_run_at = COALESCE(?, next_run_at),
         updated_at = ?
       WHERE id = ? AND created_by = 'routine'`,
    ).run(
      fields.name ?? null,
      JSON.stringify({ cron: fields.cron_expr ?? current.cron_expr }),
      JSON.stringify([routineAction(merged)]),
      fields.enabled === undefined ? null : (fields.enabled ? 1 : 0),
      fields.next_run_at === undefined ? null : fields.next_run_at,
      Date.now(),
      id,
    );
  },
  markRoutineRun(id: string, lastAt: number, nextAt: number | null): void {
    db.prepare(
      `UPDATE triggers SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND created_by = 'routine'`,
    ).run(lastAt, nextAt, Date.now(), id);
  },
  deleteRoutine(id: string): void {
    db.prepare(`DELETE FROM triggers WHERE id = ? AND created_by = 'routine'`).run(id);
  },

  // ── agent messages ─────────────────────────────────────────────────────────
  enqueueMessage(m: {
    id: string;
    fromMission: string;
    fromAgent: string;
    toAgent: string;
    toMission?: string | null;
    kind?: MessageKind;
    payload: string;
    inReplyTo?: string | null;
    ownerUserId?: string | null;
    traceId?: string | null;
  }): AgentMessageRow {
    const now = Date.now();
    // A message with no owner is later delivered by a mission with no owner, which
    // a Claude/Codex account that belongs to a user refuses (TIM-0109, TIM-0112):
    // the owner is therefore settled here, from the sender's lineage (parent,
    // fork, task) and then from the mission the message is pinned to. A system
    // sender (wake/notify mission) has none, and the caller passes it explicitly.
    const owner = m.ownerUserId !== undefined
      ? m.ownerUserId
      : (getMissionStmt.get(m.fromMission) as MissionRow | undefined)?.owner_user_id
        ?? resolveMissionOwner(m.fromMission)
        ?? (m.toMission ? resolveMissionOwner(m.toMission) : null);
    const row: AgentMessageRow = {
      id: m.id,
      from_mission: m.fromMission,
      from_agent: m.fromAgent,
      to_agent: m.toAgent,
      to_mission: m.toMission ?? null,
      kind: m.kind ?? 'msg',
      payload: m.payload,
      in_reply_to: m.inReplyTo ?? null,
      created_at: now,
      picked_at: null,
      status: 'pending',
      owner_user_id: owner,
      trace_id: m.traceId ?? missionTrace(m.fromMission),
    };
    db.prepare(
      `INSERT INTO agent_messages (id, from_mission, from_agent, to_agent, to_mission, kind, payload, in_reply_to, created_at, status, owner_user_id, trace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      row.id, row.from_mission, row.from_agent, row.to_agent, row.to_mission,
      row.kind, row.payload, row.in_reply_to, row.created_at, row.owner_user_id, row.trace_id,
    );
    if (row.trace_id) {
      dbApi.upsertSpans([{ op: 'open', id: `message:${row.id}`, trace_id: row.trace_id,
        mission_id: row.from_mission, seq: row.created_at, kind: 'message', name: row.to_agent,
        started_at: row.created_at, input: row.payload }]);
    }
    // Single chokepoint: EVERY inbox arrival (notification, mission_complete,
    // request, recap) emits `agent_message` so the wake-loop can re-spawn an
    // idle recipient to drain it. Previously only the agent_send HTTP path
    // published this → notifications/recaps left the recipient asleep.
    bus.publish({
      kind: 'agent_message',
      missionId: row.from_mission,
      messageId: row.id,
      toAgent: row.to_agent,
      fromAgent: row.from_agent,
      fromMission: row.from_mission,
    });
    return row;
  },
  getMessage(id: string, viewer?: DbViewer | null): AgentMessageRow | undefined {
    return rowVisible(
      db.prepare(`SELECT * FROM agent_messages WHERE id = ?`).get(id) as AgentMessageRow | undefined,
      viewer,
      'agent_messages',
    );
  },
  listInbox(
    toAgent: string,
    opts: { status?: MessageStatus; fromAgent?: string; limit?: number; viewer?: DbViewer | null } = {},
  ): AgentMessageRow[] {
    const limit = opts.limit ?? 50;
    const owner = ownerSql(opts.viewer, 'agent_messages');
    const extra = owner.sql === '1=1' ? '' : ` AND ${owner.sql}`;
    const extraParams = owner.sql === '1=1' ? [] : owner.params;
    if (opts.status && opts.fromAgent) {
      return db.prepare(
        `SELECT * FROM agent_messages WHERE to_agent = ? AND status = ? AND from_agent = ?${extra}
         ORDER BY created_at DESC LIMIT ?`,
      ).all(toAgent, opts.status, opts.fromAgent, ...extraParams, limit) as AgentMessageRow[];
    }
    if (opts.status) {
      return db.prepare(
        `SELECT * FROM agent_messages WHERE to_agent = ? AND status = ?${extra}
         ORDER BY created_at DESC LIMIT ?`,
      ).all(toAgent, opts.status, ...extraParams, limit) as AgentMessageRow[];
    }
    return db.prepare(
      `SELECT * FROM agent_messages WHERE to_agent = ?${extra} ORDER BY created_at DESC LIMIT ?`,
    ).all(toAgent, ...extraParams, limit) as AgentMessageRow[];
  },
  /** Expire pending messages older than maxAgeMs (stale, never reprocess).
   *  Returns the number of messages expired.
   *
   *  EXEMPTION: a message addressed to a specific mission (`to_mission` that still
   *  resolves) never expires. It is destined for the mission that commissioned the
   *  work; that mission will be resurrected to read it whatever its age — expiry
   *  only targets the obsolete backlog a NEW orchestrator would surface at boot.
   *  Without this clause the wake-loop filter would be useless: this reaper would
   *  erase the messages 2 h later. */
  expireStalePending(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const r = db
      .prepare(
        `UPDATE agent_messages SET status = 'expired'
          WHERE status = 'pending' AND created_at < ?
            AND (to_mission IS NULL
                 OR NOT EXISTS (SELECT 1 FROM missions WHERE missions.id = agent_messages.to_mission))`,
      )
      .run(cutoff);
    return r.changes;
  },
  /** Take these still-pending messages out of delivery for good (recipient gone,
   *  or delivery abandoned after repeated failures). They stay listable as
   *  `expired`. Returns how many were pending. */
  expirePendingMessages(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const stmt = db.prepare(`UPDATE agent_messages SET status = 'expired' WHERE id = ? AND status = 'pending'`);
    return db.transaction(() => ids.reduce((n, id) => n + stmt.run(id).changes, 0))();
  },
  /** An agent was deleted: what is still waiting for it will never be read.
   *  Messages from `orchestrator` are human alerts (Inbox UI), not agent mail:
   *  they stay. Returns the number expired. */
  expirePendingForAgent(agent: string): number {
    return db.prepare(
      `UPDATE agent_messages SET status = 'expired'
        WHERE status = 'pending' AND to_agent = ? AND from_agent <> 'orchestrator'`,
    ).run(agent).changes;
  },
  /** Take a still-pending message out of delivery. True if it was pending. */
  holdMessage(id: string): boolean {
    return db.prepare(`UPDATE agent_messages SET status = 'held' WHERE id = ? AND status = 'pending'`)
      .run(id).changes > 0;
  },
  /** Inbox across ALL agents (recipient-agnostic) — powers the "ALL" view. */
  listAllInbox(opts: { status?: MessageStatus; limit?: number; viewer?: DbViewer | null } = {}): AgentMessageRow[] {
    const limit = opts.limit ?? 200;
    const owner = ownerSql(opts.viewer, 'agent_messages');
    const extra = owner.sql === '1=1' ? '' : ` AND ${owner.sql}`;
    const extraParams = owner.sql === '1=1' ? [] : owner.params;
    if (opts.status) {
      return db.prepare(
        `SELECT * FROM agent_messages WHERE status = ?${extra} ORDER BY created_at DESC LIMIT ?`,
      ).all(opts.status, ...extraParams, limit) as AgentMessageRow[];
    }
    const where = extra ? `WHERE ${owner.sql}` : '';
    return db.prepare(
      `SELECT * FROM agent_messages ${where} ORDER BY created_at DESC LIMIT ?`,
    ).all(...extraParams, limit) as AgentMessageRow[];
  },
  pickMessage(id: string, viewer?: DbViewer | null): AgentMessageRow | null {
    const tx = db.transaction((mid: string) => {
      const row = rowVisible(
        db.prepare(
          `SELECT * FROM agent_messages WHERE id = ? AND status = 'pending'`,
        ).get(mid) as AgentMessageRow | undefined,
        viewer,
        'agent_messages',
      );
      if (!row) return null;
      db.prepare(`UPDATE agent_messages SET status = 'picked', picked_at = ? WHERE id = ?`).run(Date.now(), mid);
      row.status = 'picked';
      row.picked_at = Date.now();
      dbApi.upsertSpans([{ op: 'close', id: `message:${row.id}`, status: 'ok', ended_at: row.picked_at,
        event_id_end: row.picked_at }]);
      return row;
    });
    return tx(id);
  },
  listMessagesForMission(missionId: string, limit = 100, viewer?: DbViewer | null): AgentMessageRow[] {
    const owner = ownerSql(viewer, 'agent_messages');
    const extra = owner.sql === '1=1' ? '' : ` AND ${owner.sql}`;
    const extraParams = owner.sql === '1=1' ? [] : owner.params;
    return db.prepare(
      `SELECT * FROM agent_messages WHERE (from_mission = ? OR to_mission = ?)${extra}
       ORDER BY created_at DESC LIMIT ?`,
    ).all(missionId, missionId, ...extraParams, limit) as AgentMessageRow[];
  },

  // ── pipelines (declarative → auto-wired Kanban tasks) ─────────────────────
  insertPipeline(row: PipelineRow): void {
    db.prepare(
      `INSERT INTO pipelines (id, name, description, definition, owner_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.name, row.description, row.definition, row.owner_user_id ?? null, row.created_at, row.updated_at);
  },
  updatePipeline(id: string, fields: Partial<Pick<PipelineRow, 'name' | 'description' | 'definition'>>): void {
    db.prepare(
      `UPDATE pipelines SET
         name = COALESCE(?, name),
         description = COALESCE(?, description),
         definition = COALESCE(?, definition),
         updated_at = ?
       WHERE id = ?`,
    ).run(
      fields.name ?? null,
      fields.description ?? null,
      fields.definition ?? null,
      Date.now(),
      id,
    );
  },
  getPipeline(id: string): PipelineRow | undefined {
    return db.prepare(`SELECT * FROM pipelines WHERE id = ?`).get(id) as PipelineRow | undefined;
  },
  listPipelines(): PipelineRow[] {
    return db.prepare(`SELECT * FROM pipelines ORDER BY updated_at DESC`).all() as PipelineRow[];
  },
  deletePipeline(id: string): void {
    // The runs point at the pipeline (foreign key): a pipeline that ran could not be deleted.
    // The tasks the runs opened stay; only the run records go.
    db.transaction(() => {
      db.prepare(`DELETE FROM pipeline_run_steps WHERE run_id IN (SELECT id FROM pipeline_runs WHERE pipeline_id = ?)`).run(id);
      db.prepare(`DELETE FROM pipeline_runs WHERE pipeline_id = ?`).run(id);
      db.prepare(`DELETE FROM pipelines WHERE id = ?`).run(id);
    })();
  },
  insertPipelineRun(run: PipelineRunRow): void {
    db.prepare(
      `INSERT INTO pipeline_runs (id, pipeline_id, input_payload, owner_user_id, plugin_id, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(run.id, run.pipeline_id, run.input_payload, run.owner_user_id ?? null, run.plugin_id ?? null, run.started_at);
  },
  /** Runs a plugin started that still have a task to do (pending or running). */
  countOpenPluginPipelineRuns(pluginId: string): number {
    return (db.prepare(
      `SELECT COUNT(DISTINCT r.id) AS n FROM pipeline_runs r
         JOIN pipeline_run_steps s ON s.run_id = r.id
         JOIN tasks t ON t.id = s.task_id
        WHERE r.plugin_id = ? AND t.status IN ('PENDING', 'IN_PROGRESS')`,
    ).get(pluginId) as { n: number }).n;
  },
  insertPipelineRunStep(step: PipelineRunStepRow): void {
    db.prepare(
      `INSERT INTO pipeline_run_steps (run_id, step_id, task_id) VALUES (?, ?, ?)`,
    ).run(step.run_id, step.step_id, step.task_id);
  },
  getPipelineRun(runId: string): PipelineRunRow | undefined {
    return db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`).get(runId) as PipelineRunRow | undefined;
  },
  listPipelineRuns(pipelineId: string, limit = 20): PipelineRunRow[] {
    return db.prepare(
      `SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY started_at DESC LIMIT ?`,
    ).all(pipelineId, limit) as PipelineRunRow[];
  },
  listPipelineRunSteps(runId: string): PipelineRunStepRow[] {
    return db.prepare(
      `SELECT * FROM pipeline_run_steps WHERE run_id = ?`,
    ).all(runId) as PipelineRunStepRow[];
  },

  // ── workflows ────────────────────────────────────────────────────────────
  insertWorkflow(row: WorkflowRow): void { db.prepare(`INSERT INTO workflows (id,slug,name,description,project,owner_user_id,draft,published_version,enabled,created_at,updated_at,agent_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id,row.slug,row.name,row.description,row.project,row.owner_user_id,row.draft,row.published_version,row.enabled,row.created_at,row.updated_at,row.agent_name??null); },
  getWorkflow(id: string, viewer?: DbViewer | null): WorkflowRow | undefined { return rowVisible(db.prepare(`SELECT * FROM workflows WHERE id=? OR slug=?`).get(id,id) as WorkflowRow | undefined, viewer, 'workflows'); },
  listWorkflows(viewer?: DbViewer | null): WorkflowRow[] { const o=ownerSql(viewer,'workflows'); return db.prepare(`SELECT * FROM workflows WHERE ${o.sql} ORDER BY updated_at DESC`).all(...o.params) as WorkflowRow[]; },
  updateWorkflow(id: string, fields: Partial<Pick<WorkflowRow,'name'|'description'|'project'|'draft'|'enabled'|'agent_name'>>, viewer?: DbViewer | null): WorkflowRow | undefined { const row=this.getWorkflow(id,viewer); if(!row)return undefined; db.prepare(`UPDATE workflows SET name=COALESCE(?,name),description=COALESCE(?,description),project=COALESCE(?,project),draft=COALESCE(?,draft),enabled=COALESCE(?,enabled),agent_name=COALESCE(?,agent_name),updated_at=? WHERE id=?`).run(fields.name??null,fields.description??null,fields.project??null,fields.draft??null,fields.enabled??null,fields.agent_name??null,Date.now(),row.id); return this.getWorkflow(row.id,viewer); },
  deleteWorkflow(id: string, viewer?: DbViewer | null): boolean { const row=this.getWorkflow(id,viewer); return !!row && db.prepare(`DELETE FROM workflows WHERE id=?`).run(row.id).changes > 0; },
  insertWorkflowVersion(row: WorkflowVersionRow): void { db.prepare(`INSERT INTO workflow_versions (workflow_id,version,definition,published_at,published_by) VALUES (?,?,?,?,?)`).run(row.workflow_id,row.version,row.definition,row.published_at,row.published_by); db.prepare(`UPDATE workflows SET published_version=?, updated_at=? WHERE id=?`).run(row.version,row.published_at,row.workflow_id); },
  getWorkflowVersion(workflowId: string, version: number): WorkflowVersionRow | undefined { return db.prepare(`SELECT * FROM workflow_versions WHERE workflow_id=? AND version=?`).get(workflowId,version) as WorkflowVersionRow | undefined; },
  insertWorkflowRun(row: WorkflowRunRow): void { db.prepare(`INSERT INTO workflow_runs (id,workflow_id,version,status,trigger,input,context,error,started_at,ended_at,owner_user_id,tokens_in,tokens_out,cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id,row.workflow_id,row.version,row.status,row.trigger,row.input,row.context,row.error,row.started_at,row.ended_at,row.owner_user_id,row.tokens_in,row.tokens_out,row.cost_usd); },
  getWorkflowRun(id: string, viewer?: DbViewer | null): WorkflowRunRow | undefined { return rowVisible(db.prepare(`SELECT * FROM workflow_runs WHERE id=?`).get(id) as WorkflowRunRow | undefined,viewer,'workflow_runs'); },
  listWorkflowRuns(workflowId: string, viewer?: DbViewer | null): WorkflowRunRow[] { const o=ownerSql(viewer,'workflow_runs'); return db.prepare(`SELECT * FROM workflow_runs WHERE workflow_id=? AND ${o.sql} ORDER BY started_at DESC`).all(workflowId,...o.params) as WorkflowRunRow[]; },
  updateWorkflowRun(id: string, fields: Partial<Pick<WorkflowRunRow,'status'|'context'|'error'|'ended_at'|'tokens_in'|'tokens_out'|'cost_usd'>>): void { db.prepare(`UPDATE workflow_runs SET status=COALESCE(?,status),context=COALESCE(?,context),error=COALESCE(?,error),ended_at=COALESCE(?,ended_at),tokens_in=COALESCE(?,tokens_in),tokens_out=COALESCE(?,tokens_out),cost_usd=COALESCE(?,cost_usd) WHERE id=?`).run(fields.status??null,fields.context??null,fields.error??null,fields.ended_at??null,fields.tokens_in??null,fields.tokens_out??null,fields.cost_usd??null,id); },
  insertWorkflowRunNode(row: WorkflowRunNodeRow): void { db.prepare(`INSERT OR IGNORE INTO workflow_run_nodes (run_id,node_id,attempt,status,mission_id,input,output,error,taken_port,started_at,ended_at,tokens_in,tokens_out) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.run_id,row.node_id,row.attempt,row.status,row.mission_id,row.input,row.output,row.error,row.taken_port,row.started_at,row.ended_at,row.tokens_in,row.tokens_out); },
  listWorkflowRunNodes(runId: string): WorkflowRunNodeRow[] { return db.prepare(`SELECT * FROM workflow_run_nodes WHERE run_id=? ORDER BY node_id,attempt`).all(runId) as WorkflowRunNodeRow[]; },
  updateWorkflowRunNode(runId:string,nodeId:string,fields:Partial<Pick<WorkflowRunNodeRow,'status'|'input'|'output'|'error'|'taken_port'|'started_at'|'ended_at'>>): void { db.prepare('UPDATE workflow_run_nodes SET status=COALESCE(?,status),input=COALESCE(?,input),output=COALESCE(?,output),error=COALESCE(?,error),taken_port=COALESCE(?,taken_port),started_at=COALESCE(?,started_at),ended_at=COALESCE(?,ended_at) WHERE run_id=? AND node_id=? AND attempt=(SELECT MAX(attempt) FROM workflow_run_nodes WHERE run_id=? AND node_id=?)').run(fields.status??null,fields.input??null,fields.output??null,fields.error??null,fields.taken_port??null,fields.started_at??null,fields.ended_at??null,runId,nodeId,runId,nodeId); },

  // ── dashboard stats ───────────────────────────────────────────────────────
  getStats(viewer?: DbViewer | null) {
    const now = Date.now();
    const todayMs = new Date().setHours(0, 0, 0, 0);
    const h24Ago = now - 86400_000;
    const missionOwner = ownerSql(viewer, 'missions', 'm.owner_user_id');
    const taskOwner = ownerSql(viewer, 'tasks');
    const scopedMissions = missionOwner.sql !== '1=1';
    const scopedTasks = taskOwner.sql !== '1=1';

    const activeMissions = (scopedMissions
      ? db.prepare(
          `SELECT id, agent_name, started_at FROM missions m
            WHERE status = 'running' AND ${missionOwner.sql}
            ORDER BY started_at DESC LIMIT 10`,
        ).all(...missionOwner.params)
      : activeMissionsStmt.all()) as {
      id: string; agent_name: string | null; started_at: number;
    }[];
    const { n: recentEvents } = (scopedMissions
      ? db.prepare(
          `SELECT COUNT(*) as n FROM events e JOIN missions m ON e.mission_id = m.id
            WHERE e.timestamp >= ? AND ${missionOwner.sql}`,
        ).get(now - 60_000, ...missionOwner.params)
      : recentEventCountStmt.get(now - 60_000)) as { n: number };
    const sparklineRaw = (scopedMissions
      ? db.prepare(
          `SELECT (e.timestamp / 3600000) as bucket, COUNT(*) as count
             FROM events e JOIN missions m ON e.mission_id = m.id
            WHERE e.timestamp >= ? AND ${missionOwner.sql}
            GROUP BY bucket ORDER BY bucket ASC`,
        ).all(h24Ago, ...missionOwner.params)
      : sparklineStmt.all(h24Ago)) as { bucket: number; count: number }[];
    const activityByAgent = (scopedMissions
      ? db.prepare(
          `SELECT m.agent_name as agent, COUNT(e.id) as count
             FROM events e JOIN missions m ON e.mission_id = m.id
            WHERE e.timestamp >= ? AND ${missionOwner.sql}
            GROUP BY m.agent_name ORDER BY count DESC LIMIT 5`,
        ).all(todayMs, ...missionOwner.params)
      : activityByAgentStmt.all(todayMs)) as {
      agent: string | null; count: number;
    }[];
    const taskCountsRaw = (scopedTasks
      ? db.prepare(
          `SELECT status, COUNT(*) as n FROM tasks WHERE ${taskOwner.sql} GROUP BY status`,
        ).all(...taskOwner.params)
      : taskCountsStmt.all()) as { status: string; n: number }[];

    const startBucket = Math.floor(h24Ago / 3_600_000);
    const bucketMap = new Map(sparklineRaw.map((r) => [r.bucket, r.count]));
    const sparkline = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      count: bucketMap.get(startBucket + i) ?? 0,
    }));

    const taskCounts = { PENDING: 0, IN_PROGRESS: 0, DONE: 0, BLOCKED: 0 };
    for (const row of taskCountsRaw) {
      if (row.status in taskCounts) {
        taskCounts[row.status as keyof typeof taskCounts] = row.n;
      }
    }

    return {
      activeMissions,
      messagesPerSec: recentEvents / 60,
      sparkline,
      activityByAgent: activityByAgent.map((r) => ({
        agent: r.agent ?? '—',
        count: r.count,
      })),
      taskCounts,
    };
  },

  // ── projects ────────────────────────────────────────────────────────────────
  getProjectRow(slug: string): ProjectRow | undefined {
    return db.prepare(`SELECT * FROM projects WHERE slug = ?`).get(slug) as ProjectRow | undefined;
  },
  /** The one door for the `created_by` mark: no route or `upsertProject` payload reaches it. */
  setProjectCreatedBy(slug: string, origin: string): void {
    db.prepare(`UPDATE projects SET created_by = ? WHERE slug = ?`).run(origin, slug);
  },
  listProjectRows(): ProjectRow[] {
    return db.prepare(`SELECT * FROM projects ORDER BY slug`).all() as ProjectRow[];
  },
  /** Partial upsert: only defined fields are written (merge with the existing). */
  upsertProject(
    slug: string,
    fields: Partial<Omit<ProjectRow, 'slug' | 'created_at' | 'updated_at' | 'created_by'>> = {},
  ): void {
    const now = Date.now();
    const cur = this.getProjectRow(slug);
    const pick = <T>(k: keyof typeof fields, fallback: T): T =>
      (fields[k] === undefined ? fallback : (fields[k] as T));
    if (cur) {
      db.prepare(
        `UPDATE projects SET name=?, color=?, icon=?, workspace=?, cwd=?, speech=?,
           kind=?, status=?, last_activity=?, grepai_watch=?, updated_at=? WHERE slug=?`,
      ).run(
        pick('name', cur.name), pick('color', cur.color), pick('icon', cur.icon),
        pick('workspace', cur.workspace), pick('cwd', cur.cwd), pick('speech', cur.speech),
        pick('kind', cur.kind), pick('status', cur.status), pick('last_activity', cur.last_activity),
        pick('grepai_watch', cur.grepai_watch),
        now, slug,
      );
    } else {
      db.prepare(
        `INSERT INTO projects (slug, name, color, icon, workspace, cwd, speech, kind, status, last_activity, grepai_watch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        slug, pick('name', null), pick('color', null), pick('icon', null),
        pick('workspace', null), pick('cwd', null), pick('speech', null),
        pick('kind', null), pick('status', 'active'), pick('last_activity', null),
        pick('grepai_watch', null),
        now, now,
      );
    }
  },
  deleteProjectRow(slug: string): void {
    db.prepare(`DELETE FROM projects WHERE slug = ?`).run(slug);
  },

  // ── workspaces ──────────────────────────────────────────────────────────────
  getWorkspaceRow(slug: string): WorkspaceRow | undefined {
    return db.prepare(`SELECT * FROM workspaces WHERE slug = ?`).get(slug) as WorkspaceRow | undefined;
  },
  listWorkspaceRows(): WorkspaceRow[] {
    return db.prepare(`SELECT * FROM workspaces ORDER BY slug`).all() as WorkspaceRow[];
  },
  insertWorkspace(row: Pick<WorkspaceRow, 'slug' | 'name' | 'color' | 'lead_agent'>): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO workspaces (slug, name, color, lead_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.slug, row.name, row.color, row.lead_agent, now, now);
  },
  updateWorkspace(slug: string, fields: Partial<Pick<WorkspaceRow, 'name' | 'color' | 'lead_agent'>>): void {
    const cur = this.getWorkspaceRow(slug);
    if (!cur) return;
    db.prepare(`UPDATE workspaces SET name=?, color=?, lead_agent=?, updated_at=? WHERE slug=?`).run(
      fields.name ?? cur.name,
      fields.color === undefined ? cur.color : fields.color,
      fields.lead_agent === undefined ? cur.lead_agent : fields.lead_agent,
      Date.now(),
      slug,
    );
  },
  /** Removes the pole and detaches the given projects (they keep existing). */
  deleteWorkspace(slug: string, projectSlugs: readonly string[]): void {
    db.transaction(() => {
      const detach = db.prepare(`UPDATE projects SET workspace = NULL, updated_at = ? WHERE slug = ?`);
      const now = Date.now();
      for (const p of projectSlugs) detach.run(now, p);
      db.prepare(`DELETE FROM workspaces WHERE slug = ?`).run(slug);
    })();
  },
  /** Update last_activity (auto, never by hand). Creates the row if missing. */
  touchProjectActivity(slug: string, ts: number = Date.now()): void {
    const res = db.prepare(`UPDATE projects SET last_activity=?, updated_at=? WHERE slug=?`).run(ts, ts, slug);
    if (res.changes === 0) this.upsertProject(slug, { last_activity: ts });
  },
  /**
   * Write a project's auto score (night scorer). `progress` and the rationale are
   * always updated; `revenue_potential` is overwritten only if `revenue_locked != 1`
   * (otherwise the user's manual value wins). Always stamps `score_updated_at`
   * (staleness-gate). No-op if the project does not exist.
   */
  updateProjectScore(
    slug: string,
    s: { revenue_potential?: number | null; progress?: number | null; rationale?: string | null },
    ts: number = Date.now(),
  ): void {
    const cur = this.getProjectRow(slug);
    if (!cur) return;
    const locked = cur.revenue_locked === 1;
    const rev = locked ? cur.revenue_potential : (s.revenue_potential ?? cur.revenue_potential);
    const prog = s.progress ?? cur.progress;
    const rationale = s.rationale ?? cur.score_rationale;
    db.prepare(
      `UPDATE projects SET revenue_potential=?, progress=?, score_rationale=?, score_updated_at=?, updated_at=? WHERE slug=?`,
    ).run(rev, prog, rationale, ts, ts, slug);
  },
  /** Set revenue potential by hand (UI) and lock it against the scorer. */
  setRevenuePotentialManual(slug: string, value: number | null, ts: number = Date.now()): void {
    const cur = this.getProjectRow(slug);
    if (!cur) return;
    db.prepare(
      `UPDATE projects SET revenue_potential=?, revenue_locked=?, updated_at=? WHERE slug=?`,
    ).run(value, value == null ? 0 : 1, ts, slug);
  },

  // ── learnings ───────────────────────────────────────────────────────────────
  insertLearning(l: {
    missionId?: string | null; agent?: string | null; project?: string | null;
    role?: string | null; kind: string; text: string; hash?: string | null; ts?: number;
  }): void {
    db.prepare(
      `INSERT INTO learnings (mission_id, agent, project, role, kind, text, hash, ts, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'raw')`,
    ).run(
      l.missionId ?? null, l.agent ?? null, l.project ?? null, l.role ?? null,
      l.kind, l.text, l.hash ?? null, l.ts ?? Date.now(),
    );
  },
  /** Capture idempotence: does the mission already have facts? */
  missionHasLearnings(missionId: string): boolean {
    return !!db.prepare(`SELECT 1 FROM learnings WHERE mission_id=? LIMIT 1`).get(missionId);
  },
  /** Raw facts not yet synthesised. project=null → every project combined. */
  listRawLearnings(project: string | null): LearningRow[] {
    if (project === null) {
      return db.prepare(`SELECT * FROM learnings WHERE status='raw' ORDER BY ts`).all() as LearningRow[];
    }
    return db.prepare(`SELECT * FROM learnings WHERE status='raw' AND project=? ORDER BY ts`).all(project) as LearningRow[];
  },
  /** List the distinct slugs that have raw learnings (to iterate the synthesiser). */
  projectsWithRawLearnings(): (string | null)[] {
    return (db.prepare(`SELECT DISTINCT project FROM learnings WHERE status='raw'`).all() as { project: string | null }[])
      .map((r) => r.project);
  },
  markLearningsSynthesized(ids: number[]): void {
    if (!ids.length) return;
    const stmt = db.prepare(`UPDATE learnings SET status='synthesized' WHERE id=?`);
    const tx = db.transaction((rows: number[]) => { for (const id of rows) stmt.run(id); });
    tx(ids);
  },
  /** Count by hash (succeeds the dead recurrence; diagnostic/UI only). */
  countLearnings(): number {
    return (db.prepare(`SELECT COUNT(*) n FROM learnings`).get() as { n: number }).n;
  },
  /** Aggregated counters for the Memory page. */
  memoryCounts(): { learnings: number; pitfalls: number; rules: number } {
    return {
      learnings: (db.prepare(`SELECT COUNT(*) n FROM learnings`).get() as { n: number }).n,
      pitfalls: (db.prepare(`SELECT COUNT(*) n FROM learnings WHERE kind='pitfall'`).get() as { n: number }).n,
      rules: (db.prepare(`SELECT COUNT(*) n FROM memory_rules`).get() as { n: number }).n,
    };
  },
  /** An agent's learnings grouped by hash (count = occurrences, text/kind =
   *  the most recent). Replaces groupLearnings(file) for the legacy route. */
  groupedLearnings(agent: string): { hash: string; kind: string; text: string; count: number; lastTs: string }[] {
    const rows = db.prepare(`SELECT hash, kind, text, ts FROM learnings WHERE agent=? ORDER BY ts`)
      .all(agent) as { hash: string | null; kind: string; text: string; ts: number }[];
    const byHash = new Map<string, { hash: string; kind: string; text: string; count: number; lastTsNum: number }>();
    for (const r of rows) {
      const key = r.hash ?? `${r.kind}:${r.text}`;
      const cur = byHash.get(key);
      if (!cur) byHash.set(key, { hash: key, kind: r.kind, text: r.text, count: 1, lastTsNum: r.ts });
      else { cur.count++; if (r.ts >= cur.lastTsNum) { cur.lastTsNum = r.ts; cur.text = r.text; cur.kind = r.kind; } }
    }
    return [...byHash.values()]
      .sort((a, b) => b.count - a.count || b.lastTsNum - a.lastTsNum)
      .map((g) => ({ hash: g.hash, kind: g.kind, text: g.text, count: g.count, lastTs: new Date(g.lastTsNum).toISOString() }));
  },
  /** Cross-cutting DB search (FTS5 rules + learnings LIKE), deduplicated.
   *  Replaces the file scan of /api/memory/search. */
  searchMemory(query: string, limit = 40, onlySource?: string): { scope: string; id: string; file: string; kind: string; text: string }[] {
    const out: { scope: string; id: string; file: string; kind: string; text: string }[] = [];
    const fts = toFtsQuery(query);
    if (fts) {
      try {
        // `onlySource` filters inside the query: a LIMIT applied before it would
        // starve the caller of its own rules whenever others fill the cap.
        const rules = db.prepare(
          `SELECT r.* FROM memory_rules_fts f JOIN memory_rules r ON r.id=f.rowid
            WHERE f.text MATCH ? AND (r.agent IS NULL OR r.agent NOT LIKE 'trash:%')${onlySource === undefined ? '' : ' AND r.source = ?'} ORDER BY f.rank LIMIT ?`,
        ).all(...(onlySource === undefined ? [fts, limit] : [fts, onlySource, limit])) as MemoryRuleRow[];
        for (const r of rules) {
          out.push({ scope: r.scope, id: r.project ?? r.agent ?? '(global)', file: 'rules', kind: r.kind, text: r.text });
        }
      } catch { /* invalid FTS → keep just the learnings */ }
    }
    if (onlySource !== undefined) return out.slice(0, limit); // learnings belong to no plugin
    const like = `%${query.replace(/[%_\\]/g, '')}%`;
    const learns = db.prepare(`SELECT agent, kind, text FROM learnings WHERE text LIKE ? AND (agent IS NULL OR agent NOT LIKE 'trash:%') ORDER BY ts DESC LIMIT ?`)
      .all(like, limit) as { agent: string | null; kind: string; text: string }[];
    for (const l of learns) out.push({ scope: 'agent', id: l.agent ?? '?', file: 'learnings', kind: l.kind, text: l.text });
    const seen = new Set<string>();
    const dedup: typeof out = [];
    for (const h of out) {
      const k = `${h.scope}|${h.id}|${h.text}`;
      if (seen.has(k)) continue;
      seen.add(k); dedup.push(h);
      if (dedup.length >= limit) break;
    }
    return dedup;
  },
  /** Recent raw pitfalls of a project: problem-awareness before the night synthesis. */
  recentPitfalls(project: string | null, limit = 5): LearningRow[] {
    if (project === null) {
      return db.prepare(`SELECT * FROM learnings WHERE kind='pitfall' ORDER BY ts DESC LIMIT ?`).all(limit) as LearningRow[];
    }
    return db.prepare(`SELECT * FROM learnings WHERE kind='pitfall' AND project=? ORDER BY ts DESC LIMIT ?`)
      .all(project, limit) as LearningRow[];
  },

  // ── memory_rules ──────────────────────────────────────────────────────────────
  insertRule(r: {
    scope: string; project?: string | null; agent?: string | null; role?: string | null;
    kind: string; text: string; source?: string;
    tier?: string; status?: string; supersedes?: number | null; support?: number;
  }): number {
    const info = db.prepare(
      `INSERT INTO memory_rules (scope, project, agent, role, kind, text, source, created_at, tier, status, supersedes, support)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.scope, r.project ?? null, r.agent ?? null, r.role ?? null, r.kind, r.text, r.source ?? 'manual', Date.now(),
      r.tier ?? 'normal', r.status ?? 'active', r.supersedes ?? null, r.support ?? 1,
    );
    return Number(info.lastInsertRowid);
  },
  /** Manual edit of a rule (human override: re-scope, re-tier, reactivate, fix the
   *  text). Missing fields = unchanged. The FTS trigger handles the text. */
  updateRule(id: number, patch: {
    scope?: string; project?: string | null; agent?: string | null; role?: string | null;
    kind?: string; text?: string; tier?: string; status?: string; supersedes?: number | null;
  }): MemoryRuleRow | undefined {
    const cur = db.prepare(`SELECT * FROM memory_rules WHERE id=?`).get(id) as MemoryRuleRow | undefined;
    if (!cur) return undefined;
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const k of ['scope', 'project', 'agent', 'role', 'kind', 'text', 'tier', 'status', 'supersedes'] as const) {
      if (patch[k] !== undefined) { sets.push(`${k}=?`); args.push(patch[k]); }
    }
    if (!sets.length) return cur;
    db.prepare(`UPDATE memory_rules SET ${sets.join(', ')} WHERE id=?`).run(...args, id);
    return db.prepare(`SELECT * FROM memory_rules WHERE id=?`).get(id) as MemoryRuleRow;
  },
  /** Mark a replaced rule (non-destructive) — excluded from recall, kept. */
  supersedeRule(oldId: number, byNewId: number | null = null): void {
    db.prepare(`UPDATE memory_rules SET status='superseded' WHERE id=?`).run(oldId);
    if (byNewId != null) db.prepare(`UPDATE memory_rules SET supersedes=? WHERE id=?`).run(oldId, byNewId);
  },
  bumpRuleSupport(id: number, by = 1): void {
    db.prepare(`UPDATE memory_rules SET support = support + ? WHERE id=?`).run(by, id);
  },
  /** Number of ACTIVE rules visible in a scope — used for adaptive sizing of recall
   *  (a large project has more rules → wider recall). */
  countActiveRules(opts: { project?: string | null; tier?: string } = {}): number {
    const where = [`status='active'`];
    const args: unknown[] = [];
    if (opts.project) { where.push(`scope='project' AND project=?`); args.push(opts.project); }
    if (opts.tier) { where.push(`tier=?`); args.push(opts.tier); }
    return (db.prepare(`SELECT COUNT(*) n FROM memory_rules WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n;
  },
  logMemoryAudit(a: {
    runId?: string | null; scope?: string | null; project?: string | null; agent?: string | null;
    action: string; ruleId?: number | null; targetRuleId?: number | null;
    candidateText?: string | null; rationale?: string | null;
  }): void {
    db.prepare(
      `INSERT INTO memory_audit (ts, run_id, scope, project, agent, action, rule_id, target_rule_id, candidate_text, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(Date.now(), a.runId ?? null, a.scope ?? null, a.project ?? null, a.agent ?? null,
      a.action, a.ruleId ?? null, a.targetRuleId ?? null, a.candidateText ?? null, a.rationale ?? null);
  },
  listMemoryAudit(opts: { runId?: string; project?: string | null; limit?: number } = {}): MemoryAuditRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.runId) { where.push('run_id=?'); args.push(opts.runId); }
    if (opts.project !== undefined) { where.push('project IS ?'); args.push(opts.project); }
    const sql = `SELECT * FROM memory_audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
    return db.prepare(sql).all(...args, opts.limit ?? 100) as MemoryAuditRow[];
  },
  listRules(opts: { scope?: string; project?: string | null; agent?: string | null; source?: string } = {}): MemoryRuleRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.source !== undefined) { where.push('source=?'); args.push(opts.source); }
    if (opts.scope) { where.push('scope=?'); args.push(opts.scope); }
    if (opts.project !== undefined) { where.push('project IS ?'); args.push(opts.project); }
    if (opts.agent !== undefined) { where.push('agent IS ?'); args.push(opts.agent); }
    // A trashed agent's rules (TODO #670, `agent-memory-trash.ts`) are not
    // anyone's until a restore: out of every list that does not ask for them.
    else where.push(`(agent IS NULL OR agent NOT LIKE 'trash:%')`);
    const sql = `SELECT * FROM memory_rules ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return db.prepare(sql).all(...args) as MemoryRuleRow[];
  },
  /**
   * ACTIVE `core` rules explicitly attached to a project.
   *
   * Used at recall: a rule we bothered to mark `core` AND attach to a specific
   * project is by construction always relevant for that project's agents — it must
   * not depend on the chance of an FTS MATCH on the mission text. Without that, a
   * rule of the form "in a correction loop, run the targeted tests" is skipped as
   * soon as the mission does not mention tests, i.e. precisely when the agent is not
   * already thinking of them.
   *
   * Volume bounded by nature (12 rules in total across all projects, 5 at most for
   * a single project), so injectable without a budget.
   */
  coreRulesForProject(project: string): MemoryRuleRow[] {
    return db.prepare(
      `SELECT * FROM memory_rules
        WHERE scope='project' AND project=? AND tier='core' AND status='active'
        ORDER BY created_at DESC`,
    ).all(project) as MemoryRuleRow[];
  },
  /**
   * Recall: rules relevant to `query` (the task description), bounded to the scopes
   * visible to the agent. FTS5 MATCH ranked by rank; if `query` is empty or matches
   * nothing, fall back to the most recent rules of the scope.
   */
  searchRules(
    query: string,
    opts: { project?: string | null; agent?: string | null; role?: string | null; includeGlobal?: boolean; limit?: number; tier?: string } = {},
  ): MemoryRuleRow[] {
    const limit = opts.limit ?? 12;
    // Visibility filter: project rules of the current project, agent rules of the
    // current agent, JOB rules of its role (across projects), + global if requested.
    // Always bounded to ACTIVE rules (never superseded/archived at recall) — on BOTH
    // paths (FTS + fallback).
    const scopeClauses: string[] = [];
    const scopeArgs: unknown[] = [];
    if (opts.project) { scopeClauses.push(`(r.scope='project' AND r.project=?)`); scopeArgs.push(opts.project); }
    if (opts.agent) { scopeClauses.push(`(r.scope='agent' AND r.agent=?)`); scopeArgs.push(opts.agent); }
    // Job rule: of the agent's role, and either cross-cutting (project NULL) or
    // restricted to the current project.
    if (opts.role) {
      scopeClauses.push(`(r.scope='role' AND r.role=? AND (r.project IS NULL OR r.project=?))`);
      scopeArgs.push(opts.role, opts.project ?? null);
    }
    if (opts.includeGlobal) scopeClauses.push(`(r.scope='global')`);
    if (!scopeClauses.length) return [];
    const scopeSql = scopeClauses.join(' OR ');
    const extra = [`r.status='active'`];
    const extraArgs: unknown[] = [];
    if (opts.tier) { extra.push(`r.tier=?`); extraArgs.push(opts.tier); }
    const extraSql = extra.join(' AND ');
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery) {
      try {
        const rows = db.prepare(
          `SELECT r.* FROM memory_rules_fts f
             JOIN memory_rules r ON r.id = f.rowid
            WHERE f.text MATCH ? AND (${scopeSql}) AND ${extraSql}
            ORDER BY f.rank LIMIT ?`,
        ).all(ftsQuery, ...scopeArgs, ...extraArgs, limit) as MemoryRuleRow[];
        if (rows.length) return rows;
      } catch {
        /* invalid FTS query → recency fallback */
      }
    }
    return db.prepare(
      `SELECT r.* FROM memory_rules r WHERE (${scopeSql}) AND ${extraSql}
        ORDER BY r.support DESC, r.created_at DESC LIMIT ?`,
    ).all(...scopeArgs, ...extraArgs, limit) as MemoryRuleRow[];
  },
  getRule(id: number): MemoryRuleRow | undefined {
    return db.prepare(`SELECT * FROM memory_rules WHERE id=?`).get(id) as MemoryRuleRow | undefined;
  },
  /**
   * Find an ACTIVE rule with identical text in the SAME scope (same target: agent,
   * project or role). Used by the anti-duplicate guard of `memory rule add`: an
   * agent that re-notes the same pitfall twice must be refused the insert, not pollute
   * recall with two copies fighting for the same tokens.
   *
   * Comparison on normalised text (trim + compacted spaces + case ignored): a
   * rewording off by a space remains the same duplicate.
   */
  findActiveRuleByText(q: {
    scope: string; project?: string | null; agent?: string | null; role?: string | null; text: string;
  }): MemoryRuleRow | undefined {
    const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();
    const target = norm(q.text);
    const rows = db.prepare(
      `SELECT * FROM memory_rules
        WHERE status='active' AND scope=? AND project IS ? AND agent IS ? AND role IS ?`,
    ).all(q.scope, q.project ?? null, q.agent ?? null, q.role ?? null) as MemoryRuleRow[];
    return rows.find((r) => norm(r.text) === target);
  },
  deleteRule(id: number): void {
    db.prepare(`DELETE FROM memory_rules WHERE id=?`).run(id);
  },

  // ── memory_proposals ──────────────────────────────────────────────────────────
  insertProposal(p: {
    scope?: string; project?: string | null; agent?: string | null;
    kind: string; text: string; rationale?: string | null; clusterSize?: number; source?: string;
    ownerUserId?: string | null;
  }): number {
    const info = db.prepare(
      `INSERT INTO memory_proposals (scope, project, agent, kind, text, rationale, cluster_size, source, status, created_at, owner_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      p.scope ?? 'project', p.project ?? null, p.agent ?? null, p.kind, p.text,
      p.rationale ?? null, p.clusterSize ?? 1, p.source ?? 'synthesis', Date.now(),
      p.ownerUserId ?? null,
    );
    return Number(info.lastInsertRowid);
  },
  listPendingProposals(project?: string | null, viewer?: DbViewer | null): MemoryProposalRow[] {
    const owner = ownerSql(viewer, 'memory_proposals');
    // A trashed agent's proposals wait for its restore, not for a decision.
    const extra = `${owner.sql === '1=1' ? '' : ` AND ${owner.sql}`} AND (agent IS NULL OR agent NOT LIKE 'trash:%')`;
    const extraParams = owner.sql === '1=1' ? [] : owner.params;
    if (project === undefined) {
      return db.prepare(
        `SELECT * FROM memory_proposals WHERE status='pending'${extra} ORDER BY created_at DESC`,
      ).all(...extraParams) as MemoryProposalRow[];
    }
    return db.prepare(
      `SELECT * FROM memory_proposals WHERE status='pending' AND project IS ?${extra} ORDER BY created_at DESC`,
    ).all(project, ...extraParams) as MemoryProposalRow[];
  },
  getProposal(id: number, viewer?: DbViewer | null): MemoryProposalRow | undefined {
    return rowVisible(
      db.prepare(`SELECT * FROM memory_proposals WHERE id=?`).get(id) as MemoryProposalRow | undefined,
      viewer,
      'memory_proposals',
    );
  },
  countPendingProposals(): number {
    return (db.prepare(`SELECT COUNT(*) n FROM memory_proposals WHERE status='pending'`).get() as { n: number }).n;
  },
  /** Decide a proposal. On 'accepted': insert the corresponding curated rule. */
  decideProposal(id: number, status: 'accepted' | 'rejected'): MemoryRuleRow | undefined {
    const p = this.getProposal(id);
    if (!p || p.status !== 'pending') return undefined;
    const now = Date.now();
    let rule: MemoryRuleRow | undefined;
    const tx = db.transaction(() => {
      db.prepare(`UPDATE memory_proposals SET status=?, decided_at=? WHERE id=?`).run(status, now, id);
      if (status === 'accepted') {
        const ruleId = this.insertRule({
          scope: p.scope, project: p.project, agent: p.agent,
          kind: p.kind, text: p.text, source: 'synthesis',
        });
        rule = db.prepare(`SELECT * FROM memory_rules WHERE id=?`).get(ruleId) as MemoryRuleRow;
      }
    });
    tx();
    return rule;
  },

  // ── dream_proposals (Dreaming nocturne) ──────────────────────────────────────
  insertDreamProposal(d: {
    kind: 'improve' | 'opportunity';
    project: string | null;
    title: string;
    body: string;
    rationale?: string | null;
    effort?: string | null;
    conviction?: number | null;
    sources?: string[] | null;
    runId?: string | null;
    ownerUserId?: string | null;
  }): number {
    const r = db.prepare(
      `INSERT INTO dream_proposals (kind, project, title, body, rationale, effort, conviction, sources, run_id, status, created_at, owner_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      d.kind, d.project ?? null, d.title, d.body, d.rationale ?? null, d.effort ?? null,
      d.conviction ?? null, d.sources && d.sources.length ? JSON.stringify(d.sources) : null,
      d.runId ?? null, Date.now(), d.ownerUserId ?? null,
    );
    return Number(r.lastInsertRowid);
  },
  listDreamProposals(opts: { status?: string; kind?: string; limit?: number; viewer?: DbViewer | null } = {}): DreamProposalRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.status) { where.push('status = ?'); args.push(opts.status); }
    if (opts.kind) { where.push('kind = ?'); args.push(opts.kind); }
    const owner = ownerSql(opts.viewer, 'dream_proposals');
    if (owner.sql !== '1=1') { where.push(owner.sql); args.push(...owner.params); }
    const sql = `SELECT * FROM dream_proposals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
    args.push(opts.limit ?? 200);
    return db.prepare(sql).all(...args) as DreamProposalRow[];
  },
  /** Review queue: pending + snoozed whose snooze has expired. */
  listActiveDreams(now: number = Date.now(), viewer?: DbViewer | null): DreamProposalRow[] {
    const owner = ownerSql(viewer, 'dream_proposals');
    const extra = owner.sql === '1=1' ? '' : ` AND ${owner.sql}`;
    const extraParams = owner.sql === '1=1' ? [] : owner.params;
    return db.prepare(
      `SELECT * FROM dream_proposals
       WHERE (status='pending' OR (status='snoozed' AND (snooze_until IS NULL OR snooze_until <= ?)))${extra}
       ORDER BY created_at DESC`,
    ).all(now, ...extraParams) as DreamProposalRow[];
  },
  /** Recent titles (all statuses) for dedup — avoids re-proposing the same idea. */
  recentDreamTitles(kind: string, sinceDays = 30, project: string | null = null): string[] {
    const since = Date.now() - sinceDays * 86400_000;
    const rows = project
      ? db.prepare(`SELECT title FROM dream_proposals WHERE kind=? AND project IS ? AND created_at>=?`).all(kind, project, since)
      : db.prepare(`SELECT title FROM dream_proposals WHERE kind=? AND created_at>=?`).all(kind, since);
    return (rows as { title: string }[]).map((r) => r.title);
  },
  getDreamProposal(id: number, viewer?: DbViewer | null): DreamProposalRow | undefined {
    return rowVisible(
      db.prepare(`SELECT * FROM dream_proposals WHERE id=?`).get(id) as DreamProposalRow | undefined,
      viewer,
      'dream_proposals',
    );
  },
  countActiveDreams(now: number = Date.now(), viewer?: DbViewer | null): number {
    const owner = ownerSql(viewer, 'dream_proposals');
    const extra = owner.sql === '1=1' ? '' : ` AND ${owner.sql}`;
    const extraParams = owner.sql === '1=1' ? [] : owner.params;
    return (db.prepare(
      `SELECT COUNT(*) n FROM dream_proposals WHERE (status='pending' OR (status='snoozed' AND (snooze_until IS NULL OR snooze_until <= ?)))${extra}`,
    ).get(now, ...extraParams) as { n: number }).n;
  },
  decideDream(id: number, status: 'accepted' | 'rejected' | 'snoozed', snoozeUntil: number | null = null): DreamProposalRow | undefined {
    const d = this.getDreamProposal(id);
    if (!d) return undefined;
    db.prepare(`UPDATE dream_proposals SET status=?, decided_at=?, snooze_until=? WHERE id=?`)
      .run(status, Date.now(), status === 'snoozed' ? snoozeUntil : null, id);
    return this.getDreamProposal(id);
  },

  // ── project_todo (idea notebook outside the Kanban) ─────────────────────────────────
  insertProjectTodo(
    t: {
      text: string; project?: string | null; notes?: string | null; author?: string | null; ownerUserId?: string | null;
      urgency?: TodoUrgency | null; progress?: TodoProgress;
    },
  ): ProjectTodoRow {
    const now = Date.now();
    const r = db.prepare(
      `INSERT INTO project_todo (text, project, author, status, notes, created_at, updated_at, owner_user_id, urgency, progress)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    ).run(
      t.text, t.project ?? null, t.author ?? null, t.notes ?? null, now, now, t.ownerUserId ?? null,
      t.urgency ?? null, t.progress ?? 'todo',
    );
    return this.getProjectTodo(Number(r.lastInsertRowid)) as ProjectTodoRow;
  },
  listProjectTodo(opts: {
    status?: ProjectTodoStatus; project?: string; limit?: number; viewer?: DbViewer | null;
    urgency?: TodoUrgency; progress?: TodoProgress;
  } = {}): ProjectTodoRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.status) { where.push('status = ?'); args.push(opts.status); }
    if (opts.urgency) { where.push('urgency = ?'); args.push(opts.urgency); }
    // Untagged legacy rows count as `todo`.
    if (opts.progress) { where.push(opts.progress === 'todo' ? "(progress = 'todo' OR progress IS NULL)" : 'progress = ?'); if (opts.progress !== 'todo') args.push(opts.progress); }
    if (opts.project) { where.push('project = ?'); args.push(opts.project); }
    const owner = ownerSql(opts.viewer, 'project_todo');
    if (owner.sql !== '1=1') { where.push(owner.sql); args.push(...owner.params); }
    // Open items bubble to the top: the cockpit shows a short list. Promoted
    // ideas sink below the done ones — they left the notebook for the board.
    const sql = `SELECT * FROM project_todo ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY (status = 'open') DESC, (status = 'promoted') ASC, created_at DESC LIMIT ?`;
    args.push(opts.limit ?? 200);
    return db.prepare(sql).all(...args) as ProjectTodoRow[];
  },
  getProjectTodo(id: number, viewer?: DbViewer | null): ProjectTodoRow | undefined {
    return rowVisible(
      db.prepare(`SELECT * FROM project_todo WHERE id=?`).get(id) as ProjectTodoRow | undefined,
      viewer,
      'project_todo',
    );
  },
  countOpenProjectTodo(viewer?: DbViewer | null): number {
    const owner = ownerSql(viewer, 'project_todo');
    const extra = owner.sql === '1=1' ? '' : ` AND ${owner.sql}`;
    const extraParams = owner.sql === '1=1' ? [] : owner.params;
    return (db.prepare(`SELECT COUNT(*) n FROM project_todo WHERE status='open'${extra}`).get(...extraParams) as { n: number }).n;
  },
  updateProjectTodo(
    id: number,
    fields: {
      text?: string;
      project?: string | null;
      notes?: string | null;
      author?: string | null;
      status?: ProjectTodoEditableStatus;
      urgency?: TodoUrgency | null;
      progress?: TodoProgress;
    },
    /** What the plugins extending this write asked for (`project-todo-extensions.ts`). */
    hooks?: { close?: boolean; afterWrite?: (updated: ProjectTodoRow, existing: ProjectTodoRow) => void },
  ): ProjectTodoRow | undefined {
    const existing = this.getProjectTodo(id);
    if (!existing) return undefined;
    if (hooks?.close && existing.status !== 'promoted' && fields.progress === undefined && fields.status === undefined) {
      fields.progress = 'done';
    }
    // `status` stays the technical state, `progress` the human one; the two are
    // kept in step so checking a box and tagging "done" never disagree. A
    // promoted idea left the notebook: its status is not ours to touch.
    if (existing.status !== 'promoted') {
      if (fields.progress !== undefined && fields.status === undefined) {
        if (fields.progress === 'done') fields.status = 'done';
        else if (existing.status === 'done') fields.status = 'open';
      } else if (fields.status !== undefined && fields.progress === undefined) {
        if (fields.status === 'done') fields.progress = 'done';
        else if (existing.progress === 'done') fields.progress = 'todo';
      }
    }
    const sets: string[] = [];
    const args: unknown[] = [];
    if (fields.text !== undefined) { sets.push('text = ?'); args.push(fields.text); }
    if (fields.project !== undefined) { sets.push('project = ?'); args.push(fields.project); }
    if (fields.notes !== undefined) { sets.push('notes = ?'); args.push(fields.notes); }
    if (fields.author !== undefined) { sets.push('author = ?'); args.push(fields.author); }
    if (fields.urgency !== undefined) { sets.push('urgency = ?'); args.push(fields.urgency); }
    if (fields.progress !== undefined) { sets.push('progress = ?'); args.push(fields.progress); }
    if (fields.status !== undefined) {
      sets.push('status = ?'); args.push(fields.status);
      // done_at is only set on the transition to done, and cleared on uncheck.
      sets.push('done_at = ?'); args.push(fields.status === 'done' ? Date.now() : null);
    }
    // An extension writing its own data still changes the idea: `updated_at` moves.
    if (!sets.length && !hooks?.afterWrite) return existing;
    sets.push('updated_at = ?'); args.push(Date.now());
    args.push(id);
    db.prepare(`UPDATE project_todo SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    const updated = this.getProjectTodo(id);
    if (updated && hooks?.afterWrite) hooks.afterWrite(updated, existing);
    // On the transition only: re-saving a done idea is not a second closure.
    if (updated?.progress === 'done' && existing.progress !== 'done') {
      bus.publish({ kind: 'todo_done', todoId: id, previousProgress: existing.progress });
    }
    return updated;
  },
  /**
   * Marks an idea as promoted and keeps the link to its task.
   *
   * The link is written BEFORE the status in the same query: it carries
   * the fact (the status is only a view of it), and it is what the
   * anti-double-promotion guard reads. Returns `undefined` if the idea vanished in the meantime.
   */
  markProjectTodoPromoted(id: number, taskId: string): ProjectTodoRow | undefined {
    if (!this.getProjectTodo(id)) return undefined;
    db.prepare(
      `UPDATE project_todo SET promoted_task_id = ?, status = 'promoted', updated_at = ? WHERE id = ?`,
    ).run(taskId, Date.now(), id);
    return this.getProjectTodo(id);
  },
  deleteProjectTodo(id: number): boolean {
    const row = this.getProjectTodo(id);
    if (!row) return false;
    // Before the delete: the cascade takes the links with the row.
    const links = this.listTodoExternalRefs([id]).map((l) => Object.freeze({
      provider: l.provider, ref: l.ref, url: l.url, label: l.label, plugin_id: l.plugin_id, created_at: l.created_at,
    }));
    if (db.prepare(`DELETE FROM project_todo WHERE id=?`).run(id).changes === 0) return false;
    const todo = Object.freeze({
      id: row.id, text: row.text, project: row.project, owner_user_id: row.owner_user_id, links: Object.freeze(links),
    });
    bus.publish({ kind: 'todo_deleted', todoId: id, todo });
    return true;
  },

  // ── todo_external_ref (where an idea lives outside Timon) ────────────────────
  // No viewer here: these reads serve plugins and routes that already hold a
  // row the caller may see. Visibility of a link is that of its idea.
  listTodoExternalRefs(todoIds: readonly number[]): TodoExternalRefRow[] {
    if (!todoIds.length) return [];
    const marks = todoIds.map(() => '?').join(',');
    return db.prepare(
      `SELECT * FROM todo_external_ref WHERE todo_id IN (${marks}) ORDER BY todo_id, created_at, id`,
    ).all(...todoIds) as TodoExternalRefRow[];
  },
  getTodoExternalRef(provider: string, ref: string): TodoExternalRefRow | undefined {
    return db.prepare(`SELECT * FROM todo_external_ref WHERE provider = ? AND ref = ?`)
      .get(provider, ref) as TodoExternalRefRow | undefined;
  },
  /** Insert, or refresh url/label/plugin of the same idea's link. The caller
   *  checked the ref is not bound to another idea; UNIQUE refuses it otherwise. */
  putTodoExternalRef(r: {
    todoId: number; provider: string; ref: string; url: string | null; label: string | null; pluginId: string | null;
  }): TodoExternalRefRow {
    db.prepare(`
      INSERT INTO todo_external_ref (todo_id, provider, ref, url, label, plugin_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, ref) DO UPDATE SET url = excluded.url, label = excluded.label,
        plugin_id = COALESCE(excluded.plugin_id, todo_external_ref.plugin_id)
      WHERE todo_external_ref.todo_id = excluded.todo_id`,
    ).run(r.todoId, r.provider, r.ref, r.url, r.label, r.pluginId, Date.now());
    return this.getTodoExternalRef(r.provider, r.ref) as TodoExternalRefRow;
  },
  deleteTodoExternalRef(todoId: number, provider: string, ref: string): boolean {
    return db.prepare(`DELETE FROM todo_external_ref WHERE todo_id = ? AND provider = ? AND ref = ?`)
      .run(todoId, provider, ref).changes > 0;
  },

  // ── task_external_ref (where a task lives outside Timon) ─────────────────────
  // Same contract as the TO DO links: no viewer here, the caller already holds
  // a task it may see, and a link is as visible as its task.
  listTaskExternalRefs(taskIds: readonly string[]): TaskExternalRefRow[] {
    if (!taskIds.length) return [];
    const marks = taskIds.map(() => '?').join(',');
    return db.prepare(
      `SELECT * FROM task_external_ref WHERE task_id IN (${marks}) ORDER BY task_id, created_at, id`,
    ).all(...taskIds) as TaskExternalRefRow[];
  },
  getTaskExternalRef(provider: string, ref: string): TaskExternalRefRow | undefined {
    return db.prepare(`SELECT * FROM task_external_ref WHERE provider = ? AND ref = ?`)
      .get(provider, ref) as TaskExternalRefRow | undefined;
  },
  /** Insert, or refresh url/label/plugin of the same task's link. The caller
   *  checked the ref is not bound to another task; UNIQUE refuses it otherwise. */
  putTaskExternalRef(r: {
    taskId: string; provider: string; ref: string; url: string | null; label: string | null; pluginId: string | null;
  }): TaskExternalRefRow {
    db.prepare(`
      INSERT INTO task_external_ref (task_id, provider, ref, url, label, plugin_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, ref) DO UPDATE SET url = excluded.url, label = excluded.label,
        plugin_id = COALESCE(excluded.plugin_id, task_external_ref.plugin_id)
      WHERE task_external_ref.task_id = excluded.task_id`,
    ).run(r.taskId, r.provider, r.ref, r.url, r.label, r.pluginId, Date.now());
    return this.getTaskExternalRef(r.provider, r.ref) as TaskExternalRefRow;
  },
  deleteTaskExternalRef(taskId: string, provider: string, ref: string): boolean {
    return db.prepare(`DELETE FROM task_external_ref WHERE task_id = ? AND provider = ? AND ref = ?`)
      .run(taskId, provider, ref).changes > 0;
  },

  // ── teams (bot teams; membership is in each agent's config.json) ──────────
  listTeams(viewer?: DbViewer | null): TeamRow[] {
    const owner = teamOwnerSql(viewer);
    return db.prepare(`SELECT * FROM teams WHERE ${owner.sql} ORDER BY name, id`)
      .all(...owner.params) as TeamRow[];
  },
  getTeam(id: string, viewer?: DbViewer | null): TeamRow | undefined {
    const row = db.prepare('SELECT * FROM teams WHERE id=?').get(id) as TeamRow | undefined;
    if (!row) return undefined;
    return teamVisible(row, viewer) ? row : undefined;
  },
  createTeam(id: string, name: string, opts: { color?: string | null; ownerUserId?: string | null } = {}): TeamRow {
    const row: TeamRow = {
      id, owner_user_id: opts.ownerUserId ?? null, name,
      color: opts.color ?? null, created_at: Date.now(),
    };
    db.prepare('INSERT INTO teams (id, owner_user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.owner_user_id, row.name, row.color, row.created_at);
    return row;
  },
  updateTeam(id: string, patch: { name?: string; color?: string | null }, viewer?: DbViewer | null): TeamRow | undefined {
    const current = dbApi.getTeam(id, viewer);
    if (!current) return undefined;
    const next: TeamRow = {
      ...current,
      name: patch.name ?? current.name,
      color: patch.color !== undefined ? patch.color : current.color,
    };
    db.prepare('UPDATE teams SET name=?, color=? WHERE id=?').run(next.name, next.color, id);
    return next;
  },
  /** Deleting a team never deletes a bot: callers clear the `team` field of its
   *  members, which puts them back outside any team (historical behaviour). */
  deleteTeam(id: string, viewer?: DbViewer | null): boolean {
    if (!dbApi.getTeam(id, viewer)) return false;
    db.prepare('DELETE FROM teams WHERE id=?').run(id);
    return true;
  },

  // ── browser_sessions (embedded browsers, one container per project) ───────
  getBrowserSession(project: string, viewer?: DbViewer | null): BrowserSessionRow | undefined {
    return rowVisible(
      db.prepare(`SELECT * FROM browser_sessions WHERE project=?`)
        .get(project) as BrowserSessionRow | undefined,
      viewer,
      'browser_sessions',
    );
  },
  /** Every row, including `stopped`: they carry the port assigned to the project,
   *  information still useful with the browser off. */
  listBrowserSessions(viewer?: DbViewer | null): BrowserSessionRow[] {
    const owner = ownerSql(viewer, 'browser_sessions');
    const where = owner.sql === '1=1' ? '' : `WHERE ${owner.sql}`;
    return db.prepare(
      `SELECT * FROM browser_sessions ${where} ORDER BY (status='running') DESC, project`,
    ).all(...(owner.sql === '1=1' ? [] : owner.params)) as BrowserSessionRow[];
  },
  /**
   * Distinguishes "no row" from "someone else's row" without leaking the
   * latter through getBrowserSession. Start/stop use this so a hidden
   * session is a 404, not a takeover.
   */
  browserSessionAccess(project: string, viewer?: DbViewer | null): 'missing' | 'ok' | 'forbidden' {
    const raw = db.prepare(`SELECT * FROM browser_sessions WHERE project=?`)
      .get(project) as BrowserSessionRow | undefined;
    if (!raw) return 'missing';
    return rowVisible(raw, viewer, 'browser_sessions') ? 'ok' : 'forbidden';
  },
  /** CDP ports reserved by a project OTHER than `exceptProject`. Used for
   *  allocation: a port still recorded for a stopped project stays reserved,
   *  otherwise the next start would steal a resting browser's port and invalidate
   *  the MCP config that targeted it. */
  reservedBrowserCdpPorts(exceptProject?: string): number[] {
    const rows = db.prepare(
      `SELECT cdp_port FROM browser_sessions WHERE project IS NOT ?`,
    ).all(exceptProject ?? null) as { cdp_port: number }[];
    return rows.map((r) => r.cdp_port);
  },
  upsertBrowserSession(s: {
    project: string;
    containerName: string;
    cdpPort: number;
    novncPort: number;
    status: BrowserSessionStatus;
    startedAt?: number | null;
    stoppedAt?: number | null;
    ownerUserId?: string | null;
  }): BrowserSessionRow {
    // `last_used_at` is seeded from `startedAt`, NOT left NULL: a session that has just
    // opened must get the full idle threshold
    // before being considered idle, even if nothing
    // has explicitly touched it yet (agent not yet spawned, human not yet clicked).
    // `open_tabs` is deliberately ABSENT from this
    // query: neither in the INSERT columns (a
    // new project has nothing to restore) nor in the conflict SET (it must survive intact
    // from one restart to the next until `restoreOpenTabs` consumes it — overwriting it
    // here would clear it before we could use it).
    // owner_user_id is sticky: a restart must not steal the session from the
    // user who first opened it. COALESCE keeps a NULL (system) fillable.
    db.prepare(
      `INSERT INTO browser_sessions (project, container_name, cdp_port, novnc_port, status, started_at, stopped_at, last_used_at, owner_user_id)
       VALUES (@project, @containerName, @cdpPort, @novncPort, @status, @startedAt, @stoppedAt, @startedAt, @ownerUserId)
       ON CONFLICT(project) DO UPDATE SET
         container_name = excluded.container_name,
         cdp_port       = excluded.cdp_port,
         novnc_port     = excluded.novnc_port,
         status         = excluded.status,
         started_at     = excluded.started_at,
         stopped_at     = excluded.stopped_at,
         last_used_at   = excluded.last_used_at,
         owner_user_id  = COALESCE(browser_sessions.owner_user_id, excluded.owner_user_id)`,
    ).run({
      project: s.project,
      containerName: s.containerName,
      cdpPort: s.cdpPort,
      novncPort: s.novncPort,
      status: s.status,
      startedAt: s.startedAt ?? null,
      stoppedAt: s.stoppedAt ?? null,
      ownerUserId: s.ownerUserId ?? null,
    });
    return this.getBrowserSession(s.project) as BrowserSessionRow;
  },
  /** Mark a browser stopped WITHOUT touching the port or the profile: the row
   *  survives so the next start finds the same port. */
  setBrowserSessionStatus(
    project: string,
    status: BrowserSessionStatus,
    at: number = Date.now(),
  ): BrowserSessionRow | undefined {
    if (!this.getBrowserSession(project)) return undefined;
    if (status === 'running') {
      db.prepare(`UPDATE browser_sessions SET status='running', started_at=?, stopped_at=NULL WHERE project=?`)
        .run(at, project);
    } else {
      db.prepare(`UPDATE browser_sessions SET status='stopped', stopped_at=? WHERE project=?`)
        .run(at, project);
    }
    return this.getBrowserSession(project);
  },
  /** Bump the activity signal. Restricted to `status='running'`: a browser already
   *  stopped (or never started) no longer has an idle window to extend — a late
   *  signal (in-flight network request at stop time) must not resurrect an
   *  extinguished row. */
  touchBrowserSessionActivity(project: string, at: number = Date.now()): void {
    db.prepare(`UPDATE browser_sessions SET last_used_at=? WHERE project=? AND status='running'`)
      .run(at, project);
  },
  /** Tabs captured just before stop (restore safety net), or `null` to consume them.
   *  An empty array is stored as `null`: "no tabs" and "nothing to say" are the
   *  same thing for `parseStoredTabs`. */
  setBrowserSessionOpenTabs(project: string, tabs: readonly { url: string; title: string }[] | null): void {
    const json = tabs && tabs.length ? JSON.stringify(tabs) : null;
    db.prepare(`UPDATE browser_sessions SET open_tabs=? WHERE project=?`).run(json, project);
  },

  // ── ui_layout : widget placement (T.1) ──────────────────────────────────
  /**
   * Read the caller's row, or the machine template (`owner=''`) when they
   * have not written yet. A missing template is `undefined`, not an error:
   * the front falls back to registry defaults.
   */
  uiLayoutGet(owner: string, scope: string): { value: string; updated_at: number } | undefined {
    const own = db.prepare(`SELECT value, updated_at FROM ui_layout WHERE owner=? AND scope=?`)
      .get(owner, scope) as { value: string; updated_at: number } | undefined;
    if (own) return own;
    if (owner === '') return undefined;
    return db.prepare(`SELECT value, updated_at FROM ui_layout WHERE owner='' AND scope=?`)
      .get(scope) as { value: string; updated_at: number } | undefined;
  },
  /** The caller's own row, never the machine template: for a row that is nobody's but theirs. */
  uiLayoutGetOwn(owner: string, scope: string): { value: string; updated_at: number } | undefined {
    return db.prepare(`SELECT value, updated_at FROM ui_layout WHERE owner=? AND scope=?`)
      .get(owner, scope) as { value: string; updated_at: number } | undefined;
  },
  /**
   * Every row of the caller under `prefix`, the machine template filling in
   * the scopes they have not written themselves — the same fallback as
   * `uiLayoutGet`, applied to a whole family at once.
   *
   * A workspace does not store its arrangement in one row but in a fan of
   * them (`<key>.widgets`, `<key>.columns`, and whatever scope a plugin
   * decided to open). Listing them is what lets a caller photograph the
   * arrangement without holding a list of suffixes that goes stale the first
   * time a plugin adds its own.
   */
  uiLayoutList(owner: string, prefix: string): { scope: string; value: string; updated_at: number }[] {
    // `_` and `%` are LIKE wildcards and scopes legitimately contain `_`.
    const pattern = prefix.replace(/[\\%_]/g, '\\$&') + '%';
    const rows = new Map<string, { scope: string; value: string; updated_at: number }>();
    const owners = owner === '' ? [''] : ['', owner];
    for (const who of owners) {
      const found = db.prepare(
        `SELECT scope, value, updated_at FROM ui_layout WHERE owner=? AND scope LIKE ? ESCAPE '\\'`,
      ).all(who, pattern) as { scope: string; value: string; updated_at: number }[];
      // The caller's own rows come last and therefore win.
      for (const row of found) rows.set(row.scope, row);
    }
    return [...rows.values()].sort((a, b) => a.scope.localeCompare(b.scope));
  },
  /** `value` is JSON serialised by the caller; the daemon never parses it.
   *  Always writes `(owner, scope)` — copy-on-write is the GET fallback,
   *  not a copy of the template at PUT time.
   *
   *  `updated_at` is the version a guarded write compares against
   *  (`PUT /api/layout?expected=`), so it must change at every write: two
   *  writes in the same millisecond, or a clock stepping back, would otherwise
   *  hand a stale reader the version it holds. Returns the new version. */
  uiLayoutSet(owner: string, scope: string, value: string): number {
    const prev = dbApi.uiLayoutGet(owner, scope)?.updated_at ?? 0;
    const at = Math.max(Date.now(), prev + 1);
    db.prepare(
      `INSERT INTO ui_layout (owner, scope, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(owner, scope) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(owner, scope, value, at);
    return at;
  },

  /**
   * Forget the caller's row. Not a soft "empty layout": a stored `null` and
   * an absent row read back the same way on the front (defaults), and keeping
   * an empty row would leave a value behind in `timon export`.
   *
   * Recalling a named arrangement is what needs this — a preset that only
   * ever added rows would give a different screen depending on what was on it
   * beforehand (`docs/LAYOUT-PRESETS.md`).
   */
  uiLayoutDelete(owner: string, scope: string): void {
    db.prepare(`DELETE FROM ui_layout WHERE owner=? AND scope=?`).run(owner, scope);
  },

  // ── user_prefs : chrome (T.2) ───────────────────────────────────────────
  /**
   * Caller's stored chrome, or product defaults when they have never
   * written. `userId` empty / absent is not a row — it is "no account",
   * and the defaults come back without touching the table.
   */
  userPrefsGet(userId: string | null | undefined): UserPrefs {
    if (!userId) return { ...DEFAULT_USER_PREFS };
    const row = db.prepare(
      `SELECT theme, layout, scheme FROM user_prefs WHERE user_id=?`,
    ).get(userId) as { theme: string; layout: string; scheme: string } | undefined;
    if (!row) return { ...DEFAULT_USER_PREFS };
    return {
      theme: row.theme,
      layout: row.layout,
      scheme: isColorScheme(row.scheme) ? row.scheme : DEFAULT_USER_PREFS.scheme,
    };
  },
  /**
   * Partial merge. Present keys replace the stored (or product-default)
   * values; omitted keys stay. Plugin identity of `theme` / `layout` is
   * validated at PUT `/api/prefs` (T.7), not here. `userId` must be a
   * real account id — never `''`.
   */
  userPrefsSet(userId: string, patch: {
    theme?: string;
    layout?: string;
    scheme?: ColorScheme;
  }): UserPrefs {
    if (!userId) throw new Error('user_prefs.user_id must not be empty');
    if (patch.scheme !== undefined && !isColorScheme(patch.scheme)) {
      throw new Error('scheme must be light or dark');
    }
    const current = this.userPrefsGet(userId);
    const next: UserPrefs = {
      theme: patch.theme ?? current.theme,
      layout: patch.layout ?? current.layout,
      scheme: patch.scheme ?? current.scheme,
    };
    db.prepare(
      `INSERT INTO user_prefs (user_id, theme, layout, scheme, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         theme=excluded.theme,
         layout=excluded.layout,
         scheme=excluded.scheme,
         updated_at=excluded.updated_at`,
    ).run(userId, next.theme, next.layout, next.scheme, Date.now());
    return next;
  },

  /** The account's title-model choice (raw string, `mission-title-model.ts` parses it); null = instance setting. */
  userMissionTitleModelGet(userId: string | null | undefined): string | null {
    if (!userId) return null;
    const row = db.prepare(`SELECT mission_title_model FROM user_prefs WHERE user_id=?`).get(userId) as { mission_title_model: string | null } | undefined;
    return row?.mission_title_model ?? null;
  },
  /** Writes (or clears with null) the account's title-model choice; the chrome columns keep their defaults when the row is new. */
  userMissionTitleModelSet(userId: string, value: string | null): void {
    if (!userId) throw new Error('user_prefs.user_id must not be empty');
    db.prepare(
      `INSERT INTO user_prefs (user_id, theme, layout, scheme, updated_at, mission_title_model)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         mission_title_model=excluded.mission_title_model,
         updated_at=excluded.updated_at`,
    ).run(userId, DEFAULT_USER_PREFS.theme, DEFAULT_USER_PREFS.layout, DEFAULT_USER_PREFS.scheme, Date.now(), value);
  },

  /** The account's favourite models, in their order; `[]` with no account, no row or a malformed value. */
  userModelFavoritesGet(userId: string | null | undefined): ModelFavorite[] {
    if (!userId) return [];
    const row = db.prepare(`SELECT model_favorites FROM user_prefs WHERE user_id=?`).get(userId) as { model_favorites: string | null } | undefined;
    return parseStoredModelFavorites(row?.model_favorites);
  },
  /** Replaces the whole list (already validated by the route); the chrome columns keep their defaults when the row is new. */
  userModelFavoritesSet(userId: string, favorites: readonly ModelFavorite[]): ModelFavorite[] {
    if (!userId) throw new Error('user_prefs.user_id must not be empty');
    const next = dedupeModelFavorites(favorites);
    db.prepare(
      `INSERT INTO user_prefs (user_id, theme, layout, scheme, updated_at, model_favorites)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         model_favorites=excluded.model_favorites,
         updated_at=excluded.updated_at`,
    ).run(userId, DEFAULT_USER_PREFS.theme, DEFAULT_USER_PREFS.layout, DEFAULT_USER_PREFS.scheme, Date.now(), JSON.stringify(next));
    return next;
  },

  /** The account's series-planner presets, in their order; `[]` with no account, no row or a malformed value. */
  userPlanPresetsGet(userId: string | null | undefined): PlanPreset[] {
    if (!userId) return [];
    const row = db.prepare(`SELECT plan_presets FROM user_prefs WHERE user_id=?`).get(userId) as { plan_presets: string | null } | undefined;
    return parseStoredPlanPresets(row?.plan_presets);
  },
  /** Replaces the whole list (already validated by the route), stamping what changed; the chrome columns keep their defaults when the row is new. */
  userPlanPresetsSet(userId: string, presets: readonly PlanPresetInput[]): PlanPreset[] {
    if (!userId) throw new Error('user_prefs.user_id must not be empty');
    const now = Date.now();
    const next = stampPlanPresets(presets, this.userPlanPresetsGet(userId), now);
    db.prepare(
      `INSERT INTO user_prefs (user_id, theme, layout, scheme, updated_at, plan_presets)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         plan_presets=excluded.plan_presets,
         updated_at=excluded.updated_at`,
    ).run(userId, DEFAULT_USER_PREFS.theme, DEFAULT_USER_PREFS.layout, DEFAULT_USER_PREFS.scheme, now, JSON.stringify(next));
    return next;
  },

  // ── plugin_kv : third-party plugin storage ──────────────────────────────
  // Every method takes `pluginId` as FIRST argument and carries it in its
  // WHERE. None of them lets you read or write without naming it: isolation
  // does not depend on the caller's discipline, but on the absence of an
  // API able to bypass it. `value` is opaque JSON (or, for a setting of
  // type `secret`, a vault envelope wrapping that JSON), serialised by the
  // facade.
  pluginKvGet(pluginId: string, key: string): string | undefined {
    const row = db.prepare(`SELECT value FROM plugin_kv WHERE plugin_id=? AND key=?`)
      .get(pluginId, key) as { value: string } | undefined;
    return row?.value;
  },
  pluginKvSet(pluginId: string, key: string, value: string): void {
    db.prepare(
      `INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(plugin_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(pluginId, key, value, Date.now());
    if (pluginId === '@timon/browser-embedded' && key.startsWith('@settings/browser-credentials/')) invalidateRedactionCache();
  },
  pluginKvDelete(pluginId: string, key: string): void {
    db.prepare(`DELETE FROM plugin_kv WHERE plugin_id=? AND key=?`).run(pluginId, key);
    if (pluginId === '@timon/browser-embedded' && key.startsWith('@settings/browser-credentials/')) invalidateRedactionCache();
  },
  /** Plugin keys, filtered by prefix. Sorted so two successive calls return the
   *  same order — a plugin that paginates depends on it. */
  pluginKvList(pluginId: string, prefix = ''): { key: string; value: string; updated_at: number }[] {
    return db.prepare(
      `SELECT key, value, updated_at FROM plugin_kv WHERE plugin_id=? AND key LIKE ? ESCAPE '\\' ORDER BY key`,
    ).all(pluginId, `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as
      { key: string; value: string; updated_at: number }[];
  },
  /** Wipe all of a plugin's storage — its uninstallation (P.3). */
  pluginKvClear(pluginId: string): number {
    const removed = db.prepare(`DELETE FROM plugin_kv WHERE plugin_id=?`).run(pluginId).changes;
    if (pluginId === '@timon/browser-embedded') invalidateRedactionCache();
    return removed;
  },
  /**
   * Vault-internal: whether any plugin setting is a sealed envelope. Not a
   * plugin-facing read of the table — it names no plugin — so it does not
   * puncture the isolation of `pluginKvGet`. Used only to refuse creating a
   * new master key while encrypted settings exist (§4.4).
   */
  pluginKvHasSealed(valuePrefix: string, keyPrefix = ''): boolean {
    const like = (s: string) => `${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const row = db.prepare(
      `SELECT 1 AS ok FROM plugin_kv WHERE key LIKE ? ESCAPE '\\' AND value LIKE ? ESCAPE '\\' LIMIT 1`,
    ).get(like(keyPrefix), like(valuePrefix)) as { ok: number } | undefined;
    return !!row;
  },
  /** Vault-internal: every sealed plugin-setting envelope, for rotation. */
  pluginKvListSealed(valuePrefix: string, keyPrefix = ''): { plugin_id: string; key: string; value: string }[] {
    const like = (s: string) => `${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return db.prepare(
      `SELECT plugin_id, key, value FROM plugin_kv WHERE key LIKE ? ESCAPE '\\' AND value LIKE ? ESCAPE '\\'`,
    ).all(like(keyPrefix), like(valuePrefix)) as { plugin_id: string; key: string; value: string }[];
  },

  // ── secrets vault (SECRETS-VAULT.md §5, §8) ─────────────────────────
  // No accessor here ever decrypts: `value_enc` goes in and out sealed. The
  // callers that need the plaintext open it themselves, at the last moment.

  /** Every secret, grants attached — the input shape of `resolveSecretsFor`. */
  listSecrets(): SecretWithGrants[] {
    const rows = db.prepare(
      `SELECT id, name, value_enc, mode, broker_spec, note, created_at, updated_at FROM secrets ORDER BY name, id`,
    ).all() as SecretRow[];
    const grants = db.prepare(`SELECT secret_id, scope_kind, scope_ref FROM secret_grants`)
      .all() as (SecretGrantRow & { secret_id: string })[];
    const bySecret = new Map<string, SecretGrantRow[]>();
    for (const g of grants) {
      const list = bySecret.get(g.secret_id) ?? [];
      list.push({ scope_kind: g.scope_kind, scope_ref: g.scope_ref });
      bySecret.set(g.secret_id, list);
    }
    return rows.map((row) => ({ ...row, grants: bySecret.get(row.id) ?? [] }));
  },

  getSecret(id: string): SecretWithGrants | undefined {
    const row = db.prepare(
      `SELECT id, name, value_enc, mode, broker_spec, note, created_at, updated_at FROM secrets WHERE id=?`,
    ).get(id) as SecretRow | undefined;
    if (!row) return undefined;
    return { ...row, grants: this.listSecretGrants(id) };
  },

  /** `plugin:<id>` when a plugin deposited this secret, `null` for any other. Never part of `SecretRow`. */
  secretCreatedBy(id: string): string | null {
    const row = db.prepare(`SELECT created_by FROM secrets WHERE id=?`).get(id) as { created_by: string | null } | undefined;
    return row?.created_by ?? null;
  },

  setSecretCreatedBy(id: string, origin: string): void {
    db.prepare(`UPDATE secrets SET created_by=? WHERE id=?`).run(origin, id);
  },

  /** All the rows carrying this name — several are legal, one per scope (§5.1). */
  getSecretsByName(name: string): SecretWithGrants[] {
    return this.listSecrets().filter((s) => s.name === name);
  },

  /**
   * Create a secret. Validates at the write, not at the read: an invalid name
   * would only surface at injection time, where it would be a silently missing
   * variable rather than an error.
   */
  createSecret(input: {
    id?: string;
    name: string;
    value_enc: string;
    mode: SecretMode;
    broker_spec?: string | null;
    note?: string | null;
    at?: number;
  }): SecretWithGrants {
    if (!isValidSecretName(input.name)) throw new Error(`invalid secret name: ${input.name}`);
    if (!isSecretMode(input.mode)) throw new Error(`invalid secret mode: ${input.mode}`);
    assertBrokerSpecFor(input.mode, input.broker_spec ?? null);
    const id = input.id ?? randomUUID();
    const at = input.at ?? Date.now();
    db.prepare(
      `INSERT INTO secrets (id, name, value_enc, mode, broker_spec, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.name, input.value_enc, input.mode, input.broker_spec ?? null, input.note ?? null, at, at);
    // §7: unconditionally, without checking whether the ciphertext moved. Being
    // wrong here means the value just stored is the one that keeps leaking.
    invalidateRedactionCache();
    return this.getSecret(id)!;
  },

  /** Partial update; `updated_at` always moves, which is what settles ties (§5.3). */
  updateSecret(
    id: string,
    patch: { name?: string; value_enc?: string; mode?: SecretMode; broker_spec?: string | null; note?: string | null },
    at: number = Date.now(),
  ): SecretWithGrants | undefined {
    const before = this.getSecret(id);
    if (!before) return undefined;
    if (patch.name !== undefined && !isValidSecretName(patch.name)) throw new Error(`invalid secret name: ${patch.name}`);
    if (patch.mode !== undefined && !isSecretMode(patch.mode)) throw new Error(`invalid secret mode: ${patch.mode}`);
    // Validate the RESULTING row, not the patch: switching an `inject` row to
    // `broker` without sending a spec, or emptying `hosts` on a row already in
    // broker mode, are both patches that look innocent field by field.
    assertBrokerSpecFor(
      patch.mode ?? before.mode,
      patch.broker_spec !== undefined ? patch.broker_spec : before.broker_spec,
    );
    const sets: string[] = [];
    const args: (string | null)[] = [];
    for (const key of ['name', 'value_enc', 'mode', 'broker_spec', 'note'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${key}=?`);
      args.push(value);
    }
    if (sets.length) {
      db.prepare(`UPDATE secrets SET ${sets.join(', ')}, updated_at=? WHERE id=?`).run(...args, at, id);
    }
    invalidateRedactionCache();
    return this.getSecret(id);
  },

  /** Grants go with it (FK cascade); the explicit delete keeps it true even if
   *  `foreign_keys` were ever off on some connection. */
  deleteSecret(id: string): boolean {
    const tx = db.transaction((secretId: string) => {
      db.prepare(`DELETE FROM secret_grants WHERE secret_id=?`).run(secretId);
      return db.prepare(`DELETE FROM secrets WHERE id=?`).run(secretId).changes;
    });
    const deleted = tx(id) > 0;
    invalidateRedactionCache();
    return deleted;
  },

  listSecretGrants(secretId: string): SecretGrantRow[] {
    return db.prepare(
      `SELECT scope_kind, scope_ref FROM secret_grants WHERE secret_id=? ORDER BY scope_kind, scope_ref`,
    ).all(secretId) as SecretGrantRow[];
  },

  /** Idempotent: re-granting an existing scope is a no-op, not a duplicate row. */
  addSecretGrant(secretId: string, scopeKind: SecretScopeKind, scopeRef: string | null = null): void {
    if (!isSecretScopeKind(scopeKind)) throw new Error(`invalid secret scope: ${scopeKind}`);
    // A `project`/`agent` grant without a reference would name nobody, and
    // `secretScopeFor` ignores it — so refuse it here rather than store a row
    // that can never match.
    const ref = scopeKind === 'global' ? null : (scopeRef ?? '').trim();
    if (scopeKind !== 'global' && !ref) throw new Error(`scope ${scopeKind} requires a reference`);
    db.prepare(
      `INSERT INTO secret_grants (secret_id, scope_kind, scope_ref) VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).run(secretId, scopeKind, ref);
  },

  /**
   * Rewrite every envelope at once, inside ONE transaction (§4.5).
   *
   * Rotation is all-or-nothing: a half-rotated table would hold rows sealed
   * under two different keys, and only one of them would still have a key file
   * on disk. `updated_at` is deliberately NOT moved — re-encrypting a value is
   * not a modification of the secret, and bumping it would silently flip the
   * tie-breaker of §5.3 for every colliding name in the vault.
   */
  replaceSecretEnvelopes(
    rows: readonly { id: string; value_enc: string }[],
    pluginKv: readonly { plugin_id: string; key: string; value: string }[] = [],
  ): number {
    const stmt = db.prepare(`UPDATE secrets SET value_enc=? WHERE id=?`);
    const kvStmt = db.prepare(
      `UPDATE plugin_kv SET value=?, updated_at=? WHERE plugin_id=? AND key=?`,
    );
    const tx = db.transaction(() => {
      let n = 0;
      for (const row of rows) n += stmt.run(row.value_enc, row.id).changes;
      const now = Date.now();
      for (const row of pluginKv) n += kvStmt.run(row.value, now, row.plugin_id, row.key).changes;
      return n;
    });
    const replaced = tx();
    invalidateRedactionCache();
    return replaced;
  },

  removeSecretGrant(secretId: string, scopeKind: SecretScopeKind, scopeRef: string | null = null): boolean {
    const ref = scopeKind === 'global' ? null : scopeRef;
    const sql = ref === null
      ? `DELETE FROM secret_grants WHERE secret_id=? AND scope_kind=? AND scope_ref IS NULL`
      : `DELETE FROM secret_grants WHERE secret_id=? AND scope_kind=? AND scope_ref=?`;
    const args = ref === null ? [secretId, scopeKind] : [secretId, scopeKind, ref];
    return db.prepare(sql).run(...args).changes > 0;
  },

  /**
   * Every grant naming `agent` (TODO #668). A grant is matched by name at each
   * injection: left behind a deleted agent, it would hand the secret to
   * whoever is created later under that name. Returns how many went.
   */
  deleteSecretGrantsForAgent(agent: string): number {
    return db.prepare(`DELETE FROM secret_grants WHERE scope_kind = 'agent' AND scope_ref = ?`).run(agent).changes;
  },

  /** The distinct names agent-scope grants point at, plugin addresses included. */
  listSecretGrantAgents(): string[] {
    return (db.prepare(`SELECT DISTINCT scope_ref FROM secret_grants WHERE scope_kind = 'agent' AND scope_ref IS NOT NULL`)
      .all() as Array<{ scope_ref: string }>).map((r) => r.scope_ref);
  },

  /**
   * Append a line to the access journal (§8).
   *
   * Deliberately takes no value and offers no field to put one in: the journal
   * records THAT a secret was used, never WHAT it is. `detail` explains a
   * refusal ("host not allowed", "no grant") and is written by us, never echoed
   * from a caller's payload.
   */
  recordSecretAccess(entry: SecretAccessInput): void {
    db.prepare(
      `INSERT INTO secret_access (secret_id, name, mission_id, agent, at, kind, outcome, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.secret_id,
      entry.name,
      entry.mission_id ?? null,
      entry.agent ?? null,
      entry.at ?? Date.now(),
      entry.kind,
      entry.outcome,
      entry.detail ?? null,
    );
  },

  /**
   * Append several journal lines in ONE transaction. Spawn injects N secrets
   * at once; a round-trip per secret would stall the launch for nothing, and
   * an empty list is not an access — it is a no-op, not a dummy row.
   */
  recordSecretAccessMany(entries: readonly SecretAccessInput[]): void {
    if (entries.length === 0) return;
    const stmt = db.prepare(
      `INSERT INTO secret_access (secret_id, name, mission_id, agent, at, kind, outcome, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    const tx = db.transaction((batch: readonly SecretAccessInput[]) => {
      for (const entry of batch) {
        stmt.run(
          entry.secret_id,
          entry.name,
          entry.mission_id ?? null,
          entry.agent ?? null,
          entry.at ?? now,
          entry.kind,
          entry.outcome,
          entry.detail ?? null,
        );
      }
    });
    tx(entries);
  },

  /** The journal of one secret, most recent first — what `GET /api/secrets/:id/access` serves. */
  listSecretAccess(secretId: string, limit = 200): SecretAccessRow[] {
    return db.prepare(
      `SELECT id, secret_id, name, mission_id, agent, at, kind, outcome, detail
         FROM secret_access WHERE secret_id=? ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(secretId, Math.max(1, Math.min(limit, 1000))) as SecretAccessRow[];
  },

  /**
   * Drop journal lines older than `cutoff`. Returns how many went.
   *
   * Deleted rather than archived like events: a line holds no value, only the
   * fact of a use, and the archive database exists to keep `timon.db` movable —
   * a journal that never grew that large has nothing to gain from it.
   */
  pruneSecretAccess(cutoff: number): number {
    return db.prepare(`DELETE FROM secret_access WHERE at < ?`).run(cutoff).changes;
  },

  // ── users & sessions (Phase M.1) ──────────────────────────────────────────
  createUser(input: {
    id?: string;
    email: string;
    name: string;
    passwordHash: string;
    status?: UserStatus;
    isSuperadmin?: boolean;
    createdAt?: number;
    /** Who creates the account: the core opens no other way to add one (`ACCOUNT_SOURCES`). */
    source: AccountSource;
  }): UserRow {
    assertAccountSource(input.source);
    const email = normalizeEmail(input.email);
    const name = input.name.trim();
    if (!email) throw new Error('email is required');
    if (!name) throw new Error('name is required');
    if (!input.passwordHash) throw new Error('passwordHash is required');
    const status = input.status ?? 'active';
    if (!isUserStatus(status)) throw new Error(`invalid user status: ${String(input.status)}`);
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? Date.now();
    try {
      db.transaction(() => {
        assertAccountWrite(mutationLicenseState(), { isSuperadmin: input.isSuperadmin === true, status }, this.countUsersInUse(), true);
        db.prepare(
          `INSERT INTO users (id, email, name, password_hash, status, is_superadmin, created_at, last_login_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run(id, email, name, input.passwordHash, status, input.isSuperadmin ? 1 : 0, createdAt);
      }).immediate();
    } catch (err) {
      if (isUniqueConstraint(err)) throw new DuplicateEmailError(email);
      throw err;
    }
    return this.getUserById(id)!;
  },

  getUserById(id: string): UserRow | undefined {
    const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserDbRow | undefined;
    return row ? toUserRow(row) : undefined;
  },

  getUserByEmail(email: string): UserRow | undefined {
    const row = db.prepare(`SELECT * FROM users WHERE email = ?`)
      .get(normalizeEmail(email)) as UserDbRow | undefined;
    return row ? toUserRow(row) : undefined;
  },

  listUsers(): UserRow[] {
    return (db.prepare(`SELECT * FROM users ORDER BY created_at ASC`).all() as UserDbRow[])
      .map(toUserRow);
  },

  countUsers(): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n;
  },

  /**
   * Profiles that really occupy a place: `active` and `invited`. A disabled
   * account keeps its row for history but nobody can sign in with it, so it
   * takes no seat. `invited` does: the row exists, only the password is
   * missing, and letting invitations grow unchecked would move a refusal from
   * whoever over-invited to whoever accepts (`users/quota.ts`).
   */
  countUsersInUse(): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE status <> 'disabled'`).get() as { n: number }).n;
  },

  countActiveSuperadmins(): number {
    return countActiveSuperadmins();
  },

  setUserStatus(id: string, status: UserStatus): UserRow {
    if (!isUserStatus(status)) throw new Error(`invalid user status: ${String(status)}`);
    const current = this.getUserById(id);
    if (!current) throw new Error(`user not found: ${id}`);
    if (
      current.is_superadmin
      && current.status === 'active'
      && status !== 'active'
      && countActiveSuperadmins(id) < 1
    ) {
      throw new LastSuperadminError();
    }
    db.transaction(() => {
      const latest = this.getUserById(id)!;
      assertAccountWrite(mutationLicenseState(), { isSuperadmin: latest.is_superadmin, status }, this.countUsersInUse(), latest.status === 'disabled' && status !== 'disabled');
      db.prepare(`UPDATE users SET status = ? WHERE id = ?`).run(status, id);
    }).immediate();
    if (current.status !== status) emitAccountChange({ userId: id, status, previous: current.status });
    return this.getUserById(id)!;
  },

  setUserSuperadmin(id: string, isSuperadmin: boolean): UserRow {
    const current = this.getUserById(id);
    if (!current) throw new Error(`user not found: ${id}`);
    if (current.is_superadmin && !isSuperadmin && countActiveSuperadmins(id) < 1) {
      throw new LastSuperadminError();
    }
    assertAccountWrite(mutationLicenseState(), { isSuperadmin, status: current.status }, this.countUsersInUse(), false);
    db.prepare(`UPDATE users SET is_superadmin = ? WHERE id = ?`).run(isSuperadmin ? 1 : 0, id);
    return this.getUserById(id)!;
  },

  touchUserLogin(id: string, at: number = Date.now()): void {
    db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(at, id);
  },

  /** First active superadmin, used to map the legacy daemon-token onto a real user. */
  getActiveSuperadmin(): UserRow | undefined {
    const row = db.prepare(
      `SELECT * FROM users WHERE is_superadmin = 1 AND status = 'active' ORDER BY created_at ASC, id ASC LIMIT 1`,
    ).get() as UserDbRow | undefined;
    return row ? toUserRow(row) : undefined;
  },

  createSession(input: {
    tokenHash: string;
    userId: string;
    expiresAt: number;
    userAgent?: string | null;
    createdAt?: number;
  }): SessionRow {
    if (!input.tokenHash) throw new Error('tokenHash is required');
    const createdAt = input.createdAt ?? Date.now();
    db.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.tokenHash,
      input.userId,
      createdAt,
      input.expiresAt,
      createdAt,
      input.userAgent ?? null,
    );
    return this.getSessionByTokenHash(input.tokenHash)!;
  },

  getSessionByTokenHash(tokenHash: string): SessionRow | undefined {
    return db.prepare(`SELECT * FROM sessions WHERE token_hash = ?`).get(tokenHash) as SessionRow | undefined;
  },

  /**
   * Live session: not expired, owner still `active`. Used by the auth
   * middleware — a disabled account must drop every cookie immediately.
   */
  getLiveSession(tokenHash: string, now: number = Date.now()): { session: SessionRow; user: UserRow } | undefined {
    const session = this.getSessionByTokenHash(tokenHash);
    if (!session || session.expires_at <= now) return undefined;
    const user = this.getUserById(session.user_id);
    if (!user || user.status !== 'active') return undefined;
    return { session, user };
  },

  touchSession(tokenHash: string, at: number = Date.now()): void {
    db.prepare(`UPDATE sessions SET last_seen = ? WHERE token_hash = ?`).run(at, tokenHash);
  },

  setSessionExpiry(tokenHash: string, expiresAt: number): void {
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE token_hash = ?`).run(expiresAt, tokenHash);
  },

  deleteSession(tokenHash: string): void {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
  },

  deleteExpiredSessions(now: number = Date.now()): number {
    return db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now).changes;
  },

  setUserPassword(id: string, passwordHash: string): UserRow {
    if (!passwordHash) throw new Error('passwordHash is required');
    const current = this.getUserById(id);
    if (!current) throw new Error(`user not found: ${id}`);
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(passwordHash, id);
    return this.getUserById(id)!;
  },

  setUserName(id: string, name: string): UserRow {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('name is required');
    const current = this.getUserById(id);
    if (!current) throw new Error(`user not found: ${id}`);
    db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(trimmed, id);
    return this.getUserById(id)!;
  },

  /** `null` clears the picture and sends the UI back to the initials. */
  setUserAvatar(id: string, avatarUrl: string | null): UserRow {
    const current = this.getUserById(id);
    if (!current) throw new Error(`user not found: ${id}`);
    db.prepare(`UPDATE users SET avatar_url = ? WHERE id = ?`).run(avatarUrl, id);
    return this.getUserById(id)!;
  },

  /** Moves the login identity. Raises `DuplicateEmailError` like `createUser`. */
  setUserEmail(id: string, email: string): UserRow {
    const normalized = normalizeEmail(email);
    if (!normalized) throw new Error('email is required');
    const current = this.getUserById(id);
    if (!current) throw new Error(`user not found: ${id}`);
    try {
      db.prepare(`UPDATE users SET email = ? WHERE id = ?`).run(normalized, id);
    } catch (err) {
      if (isUniqueConstraint(err)) throw new DuplicateEmailError(normalized);
      throw err;
    }
    return this.getUserById(id)!;
  },

  // ── email changes (self-service) ──────────────────────────────────────────

  /**
   * Records a pending change. Only one at a time per account: asking again
   * replaces the previous request, so an abandoned token stops working the
   * moment its owner starts over.
   */
  createEmailChange(input: {
    tokenHash: string;
    userId: string;
    newEmail: string;
    expiresAt: number;
    createdAt?: number;
  }): EmailChangeRow {
    const email = normalizeEmail(input.newEmail);
    if (!email) throw new Error('newEmail is required');
    const createdAt = input.createdAt ?? Date.now();
    db.prepare(`DELETE FROM email_changes WHERE user_id = ?`).run(input.userId);
    db.prepare(
      `INSERT INTO email_changes (token_hash, user_id, new_email, created_at, expires_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(input.tokenHash, input.userId, email, createdAt, input.expiresAt);
    return db.prepare(`SELECT * FROM email_changes WHERE token_hash = ?`)
      .get(input.tokenHash) as EmailChangeRow;
  },

  /** Pending, unexpired, unconsumed request for this token — nothing else. */
  getPendingEmailChange(tokenHash: string, now: number = Date.now()): EmailChangeRow | undefined {
    const row = db.prepare(`SELECT * FROM email_changes WHERE token_hash = ?`)
      .get(tokenHash) as EmailChangeRow | undefined;
    if (!row || row.confirmed_at !== null || row.expires_at <= now) return undefined;
    return row;
  },

  markEmailChangeConfirmed(tokenHash: string, at: number = Date.now()): void {
    db.prepare(`UPDATE email_changes SET confirmed_at = ? WHERE token_hash = ?`).run(at, tokenHash);
  },

  deleteEmailChangesForUser(userId: string): number {
    return db.prepare(`DELETE FROM email_changes WHERE user_id = ?`).run(userId).changes;
  },

  deleteExpiredEmailChanges(now: number = Date.now()): number {
    return db.prepare(`DELETE FROM email_changes WHERE expires_at <= ?`).run(now).changes;
  },

  deleteSessionsForUser(userId: string): number {
    return db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId).changes;
  },

  /** Where this account stands in the upgrade welcome; `null`: nothing to show. */
  userWelcomeStage(userId: string): WelcomeStage | null {
    const row = db.prepare(`SELECT welcome_stage FROM users WHERE id = ?`).get(userId) as { welcome_stage: string | null } | undefined;
    return isWelcomeStage(row?.welcome_stage) ? row.welcome_stage : null;
  },

  setUserWelcomeStage(userId: string, stage: WelcomeStage | null): void {
    db.prepare(`UPDATE users SET welcome_stage = ? WHERE id = ?`).run(stage, userId);
  },

  /** Does an active account still have to sign in again through the onboarding? */
  anyUserAwaitingWelcomeSignin(): boolean {
    return db.prepare(`SELECT 1 FROM users WHERE welcome_stage = 'signin' AND status = 'active' LIMIT 1`).get() !== undefined;
  },

  /**
   * Drop every live cookie and API token for this account. A disabled
   * (or reset) user must lose access on the next request, not at the
   * next login — there is no auth cache (`docs/MULTI-USER.md` §12).
   */
  revokeUserAccess(userId: string): { sessions: number; tokens: number } {
    const sessions = this.deleteSessionsForUser(userId);
    const tokens = this.revokeApiTokensForUser(userId);
    return { sessions, tokens };
  },

  /**
   * One of the former account tables, whole, for the plugin that migrates them
   * (`ctx.accountProvider.readLegacy`): read from the file they were moved to when
   * they left the schema, `[]` when there is none. The name is checked against the
   * closed list.
   */
  readLegacyAccountTable(table: LegacyAccountTable): Record<string, unknown>[] {
    if (!(LEGACY_ACCOUNT_TABLES as readonly string[]).includes(table)) throw new Error(`not a legacy account table: ${table}`);
    return readLegacyAccountRows(LEGACY_ACCOUNT_TABLES_FILE, table);
  },

  /**
   * An account's rights, as the plugin serving the accounts gives them (seam C,
   * `ctx.permissionSource`). Without one, nothing: refused by default. A
   * superadmin never asks (the evaluator short-circuits on the flag).
   */
  listPermissionsForUser(userId: string): string[] {
    return permissionsFromSource(userId) ?? [];
  },

  // ── api_tokens (Phase M.5) ────────────────────────────────────────────────
  createApiToken(input: {
    tokenHash: string;
    userId?: string | null;
    label?: string | null;
    scope: string;
    createdAt?: number;
    expiresAt?: number | null;
    missionId?: string | null;
  }): ApiTokenRow {
    if (!input.tokenHash) throw new Error('tokenHash is required');
    if (!input.scope) throw new Error('scope is required');
    const createdAt = input.createdAt ?? Date.now();
    db.prepare(
      `INSERT INTO api_tokens (token_hash, user_id, label, scope, created_at, last_used_at, expires_at, mission_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      input.tokenHash,
      input.userId ?? null,
      input.label ?? null,
      input.scope,
      createdAt,
      input.expiresAt ?? null,
      input.missionId ?? null,
    );
    return this.getApiTokenByHash(input.tokenHash)!;
  },

  getApiTokenByHash(tokenHash: string): ApiTokenRow | undefined {
    return db.prepare(`SELECT * FROM api_tokens WHERE token_hash = ?`).get(tokenHash) as ApiTokenRow | undefined;
  },

  /**
   * Live token: not expired, mission still running when bound, owner still
   * `active` when it is a user. Plugin/system tokens have no user row.
   */
  getLiveApiToken(tokenHash: string, now: number = Date.now()): LiveApiToken | undefined {
    const token = this.getApiTokenByHash(tokenHash);
    if (!token) return undefined;
    // An egress proxy credential is no API identity: resolved, a mission-bound
    // row with no user would inherit its owner's grants below (TODO #590).
    if (token.scope === EGRESS_PROXY_TOKEN_SCOPE) return undefined;
    if (token.expires_at != null && token.expires_at <= now) return undefined;
    if (token.mission_id) {
      const mission = getMissionStmt.get(token.mission_id) as { status: string } | undefined;
      if (!mission || mission.status !== 'running') return undefined;
    }
    const asMissionActor = (user: UserRow): LiveApiToken => {
      const developer = isDeveloperAccount(user);
      return {
        token,
        user,
        actorId: user.id,
        isSuperadmin: developer,
        permissions: developer ? ['*'] : intersectMissionTokenPermissions(user, this.listPermissionsForUser(user.id)),
      };
    };
    if (token.user_id) {
      const user = this.getUserById(token.user_id);
      if (!user || user.status !== 'active') return undefined;
      // Developer-owner missions inherit account authority. Ordinary missions
      // keep the cap; licence expiry and account changes are checked per request.
      if (token.mission_id) return asMissionActor(user);
      return { token, user, actorId: user.id, isSuperadmin: user.is_superadmin };
    }
    const actorId = token.scope.startsWith('plugin:') ? token.scope : 'system';
    if (token.mission_id) {
      // A `system`-scope token was minted while the mission had no active owner.
      // Resolve the owner by lineage first so a fork/child of an owned mission
      // acts as that owner (not as the empty `system` identity); only a
      // genuinely unattributed mission stays system with no grants.
      const ownerId = token.scope.startsWith('plugin:') ? null : resolveMissionOwner(token.mission_id);
      if (ownerId) {
        const user = this.getUserById(ownerId);
        if (user && user.status === 'active') return asMissionActor(user);
      }
      return { token, user: null, actorId, isSuperadmin: false, permissions: [] };
    }
    return { token, user: null, actorId, isSuperadmin: false };
  },

  touchApiToken(tokenHash: string, at: number = Date.now()): void {
    db.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?`).run(at, tokenHash);
  },

  revokeApiToken(tokenHash: string): void {
    db.prepare(`DELETE FROM api_tokens WHERE token_hash = ?`).run(tokenHash);
  },

  /** Every token bound to the mission, or only one scope, or all but one scope. */
  revokeApiTokensForMission(missionId: string, opts: { onlyScope?: string; keepScope?: string } = {}): number {
    if (opts.onlyScope !== undefined) {
      return db.prepare(`DELETE FROM api_tokens WHERE mission_id = ? AND scope = ?`).run(missionId, opts.onlyScope).changes;
    }
    if (opts.keepScope !== undefined) {
      return db.prepare(`DELETE FROM api_tokens WHERE mission_id = ? AND scope != ?`).run(missionId, opts.keepScope).changes;
    }
    return db.prepare(`DELETE FROM api_tokens WHERE mission_id = ?`).run(missionId).changes;
  },

  deleteExpiredApiTokens(now: number = Date.now()): number {
    return db.prepare(
      `DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?`,
    ).run(now).changes;
  },

  revokeApiTokensForUser(userId: string): number {
    return db.prepare(`DELETE FROM api_tokens WHERE user_id = ?`).run(userId).changes;
  },

  // ── audit_log (Phase M.6) ─────────────────────────────────────────────────
  insertAuditLog(input: {
    userId?: string | null;
    /** Non-human caller behind the row: 'daemon', 'api-token', or null. */
    actor?: string | null;
    action: string;
    target?: string | null;
    ip?: string | null;
    at?: number;
  }): AuditLogRow {
    if (!input.action.trim()) throw new Error('action is required');
    const id = randomUUID();
    const at = input.at ?? Date.now();
    db.prepare(
      `INSERT INTO audit_log (id, user_id, actor, action, target, at, ip) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.userId ?? null,
      input.actor ?? null,
      input.action.trim(),
      input.target ?? null,
      at,
      input.ip ?? null,
    );
    return this.getAuditLogById(id)!;
  },

  getAuditLogById(id: string): AuditLogRow | undefined {
    return db.prepare(`SELECT * FROM audit_log WHERE id = ?`).get(id) as AuditLogRow | undefined;
  },

  listAuditLog(limit = 200): AuditLogRow[] {
    return db.prepare(
      `SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(limit, 1000))) as AuditLogRow[];
  },
};

/**
 * A `broker` secret without a usable spec would be an identity the daemon
 * cannot honour — and, worse, a spec with an empty `hosts` would be an identity
 * it would honour towards ANY host (§6.2). Enforced here rather than in the
 * routes so the CLI, the migration and S.5's API all inherit the same refusal.
 */
function assertBrokerSpecFor(mode: SecretMode, brokerSpec: string | null): void {
  if (mode !== 'broker') return;
  if (!brokerSpec) throw new Error('broker: `broker_spec` is required when mode is `broker`');
  parseBrokerSpec(brokerSpec); // throws BrokerSpecError with a readable reason
}

/**
 * Plaintext of every stored secret, for the output redaction filter
 * (SECRETS-VAULT.md §7). This is the ONE place where values leave the vault
 * without a grant behind them — legitimately, because the daemon already knows
 * them and here it only uses them to recognise its own leaks.
 *
 * It must never throw: redaction is a safety net, and a net that takes the
 * process down when a single row is damaged is worse than no net. So the key
 * being absent yields an empty list, and a row that fails to open is skipped
 * without disturbing the others. Nothing is ever logged but a count — §13
 * forbids logging a value, even truncated, even in debug.
 */
function vaultValues(): string[] {
  let rows: SecretRow[];
  try {
    rows = db.prepare(`SELECT id, name, value_enc FROM secrets`).all() as SecretRow[];
  } catch {
    return []; // table not migrated yet (an older database opened read-only)
  }
  let browserRows: { plugin_id: string; key: string; value: string }[] = [];
  try {
    browserRows = db.prepare(`SELECT plugin_id, key, value FROM plugin_kv
      WHERE plugin_id='@timon/browser-embedded' AND key LIKE '@settings/browser-credentials/%'`)
      .all() as typeof browserRows;
  } catch { /* Older databases may not have plugin storage yet. */ }
  // Opaque provider credentials and secret plugin settings share sealed @settings identities.
  // Reading them here also redacts CLI writes before the corresponding plugin has loaded.
  let providerTokens: { plugin_id: string; key: string; value: string }[] = [];
  try {
    providerTokens = db.prepare(`SELECT plugin_id, key, value FROM plugin_kv
      WHERE key LIKE '@settings/%' AND plugin_id != '@timon/browser-embedded'`)
      .all() as typeof providerTokens;
  } catch { /* Older databases may not have plugin storage yet. */ }
  if (!rows.length && !browserRows.length && !providerTokens.length) return [];
  let key: Buffer | null = null;
  // Tri-state with `key`: resolving the master key is a file read, so it is
  // attempted at most once — but a failure must not abandon the loop. Degraded
  // mode (§4.4) leaves sealed values unreadable, hence unredactable; the legacy
  // plaintext rows need no key at all and stay masked, and those are precisely
  // the most exposed ones (§10.4).
  let keyTried = false;
  const values: string[] = [];
  let failed = 0;
  for (const row of rows) {
    // A value from before the migration (§10.4) is stored in the clear: it is
    // exactly the one we most want masked, so take it as it is.
    if (!isSealed(row.value_enc)) {
      values.push(row.value_enc);
      continue;
    }
    if (!key) {
      if (keyTried) continue;
      keyTried = true;
      try {
        key = requireMasterKey();
      } catch {
        continue;
      }
    }
    try {
      values.push(openSecret(row.value_enc, key, { secretId: row.id, name: row.name }));
    } catch {
      failed++;
    }
  }
  // Browser credentials are sealed JSON, not generic plugin settings. Extract
  // only the password for the internal trace filter; never expose a
  // decrypt operation to API callers or fall back to unsealed browser data.
  for (const row of browserRows) {
    if (!isSealed(row.value)) continue;
    if (!key) {
      if (keyTried) continue;
      keyTried = true;
      try { key = requireMasterKey(); } catch { continue; }
    }
    try {
      const credential = JSON.parse(openSecret(row.value, key, { secretId: `plugin_kv:${row.plugin_id}`, name: row.key })) as Record<string, unknown>;
      if (credential.version !== 1 || typeof credential.password !== 'string' || typeof credential.username !== 'string') throw new Error();
      values.push(credential.password);
    } catch { failed++; }
  }
  for (const credential of providerTokens) {
    if (!isSealed(credential.value)) continue;
    if (!key && !keyTried) {
      keyTried = true;
      try { key = requireMasterKey(); } catch { /* degraded: nothing to open */ }
    }
    if (key) {
      try {
        const value = openSecret(credential.value, key, { secretId: `plugin_kv:${credential.plugin_id}`, name: credential.key });
        values.push(value);
        // Secret settings are JSON strings; opaque provider tokens are raw strings.
        try { const parsed: unknown = JSON.parse(value); if (typeof parsed === 'string') values.push(parsed); } catch { /* opaque token */ }
      } catch { failed++; }
    }
  }
  if (failed && !warnedVaultOpenFailures) {
    warnedVaultOpenFailures = true;
    console.warn(`[secrets] ${failed} secret(s) could not be opened for output redaction`);
  }
  return values;
}

/** One warning per process: a damaged row stays damaged, and repeating it on
 *  every cache refresh would drown the log. */
let warnedVaultOpenFailures = false;

// Registered at import time rather than at boot, so that every process holding
// the database redacts what it writes — the daemon, but also `timon task done`,
// which writes a `done_comment` straight to SQLite.
setRedactionSource(vaultValues);

// Every migration above has run: the next packaged process may open the data. A migration that
// throws leaves the lock to this process's exit — or to the waiting daemon, which releases it.
releaseDataOpenLock(TIMON_HOME);


/**
 * Turn a task description into a safe FTS5 query: we extract significant words
 * (>2 letters), escape them as quoted tokens and OR-join them. Avoids FTS syntax
 * errors on prose punctuation.
 */
function toFtsQuery(text: string): string | null {
  const tokens = (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 24);
  if (!tokens.length) return null;
  return Array.from(new Set(tokens)).map((w) => `"${w}"`).join(' OR ');
}
