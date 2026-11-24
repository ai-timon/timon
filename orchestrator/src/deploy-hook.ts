/**
 * Post-merge deploy hook: when a `merge` task goes DONE, deploy what the
 * merge touched, to close the "code merged on main ≠ code deployed" gap
 * (a feature could stay invisible because nobody rebuilt after the merge).
 *
 * Safety policy:
 *  - Docker containers (`app/`, `channels/`, `remote/`) → AUTO REBUILD. It is safe:
 *    each service runs in its own container, the rebuild touches neither
 *    the orchestrator nor the missions in flight. The orchestrator runs in host-mode
 *    and has access to the Docker daemon (it already shells out to `git`).
 *  - `orchestrator/` → NEVER automatic. A restart of the orchestrator kills every
 *    living mission (see CLAUDE.md). The user is NOTIFIED with the exact command,
 *    and does it when they can.
 *
 * Trigger: bus `mission_complete` (completed), same hook point as
 * doc-task. To register AFTER the dispatcher (which sets status=DONE).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** docker binary resolved as an absolute path (systemd --user services have a
 *  restricted PATH; we do not depend on PATH resolution). Fallback 'docker'. */
const DOCKER_BIN =
  ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker'].find((p) => existsSync(p)) ?? 'docker';
import type { BusEvent } from './bus.js';
import { bus } from './bus.js';
import { dbApi, type TaskRow } from './db.js';
import { loadConfig } from './agent.js';
import { getHost } from './host/index.js';
import { notifyUser } from './notify.js';
import { daemonMessage } from './daemon-message.js';
import { restartStatus } from './onboarding-restart.js';

/** top-level folder of the repo → docker compose service to rebuild (automatic, safe). */
const DOCKER_DIRS: Record<string, string> = {
  app: 'app',
  channels: 'channels',
  remote: 'remote',
};
/** Top-level folders whose change needs a daemon restart, REPORTED (never automatic). */
const NOTIFY_ONLY_DIRS = new Set(['orchestrator']);

/**
 * The restart line of THIS machine's daemon: the unit, label or task it really
 * runs under (a package's own unit on Linux, launchd, the scheduled task), not
 * the source checkout's systemd unit, which does nothing on any other install.
 */
function restartLine(): string {
  return restartStatus().command ?? 'quit and reopen Timon';
}

/** Builds in progress, key `${repoDir}::${service}` — avoids two concurrent `docker compose
 *  up --build` of the same service (a build already includes the HEAD on disk,
 *  so the build in progress covers the merges that arrived in the meantime). */
const inFlight = new Set<string>();

/** Merge missions already handled — `mission_complete` can be re-emitted for
 *  the same missionId (several finishMission paths, reaper). We deploy
 *  only once per mission. */
const handled = new Set<string>();

/** Files modified by a commit (merge or normal). `<sha>^..<sha>` gives the
 *  first-parent diff (= what the merge brought); fallback `git show` if the
 *  commit has no usable parent. */
function gitChangedFiles(dir: string, sha: string): Promise<string[]> {
  const parse = (out: string) => out.split('\n').map((s) => s.trim()).filter(Boolean);
  const host = getHost();
  const opts = { maxBuffer: 8 * 1024 * 1024 };
  return host.execAsync('git', ['-C', dir, 'diff', '--name-only', `${sha}^`, sha], opts)
    .then((r) => (r.code === 0
      ? parse(r.stdout)
      : host.execAsync('git', ['-C', dir, 'show', '--name-only', '--format=', sha], opts)
        .then((r2) => (r2.code === 0 ? parse(r2.stdout) : []))))
    .catch(() => []);
}

function rebuildService(repoDir: string, service: string, task: TaskRow, sha: string): void {
  const key = `${repoDir}::${service}`;
  if (inFlight.has(key)) {
    console.log(`[deploy] rebuild of ${service} already running — skip (the running build includes HEAD)`);
    return;
  }
  inFlight.add(key);
  console.log(`[deploy] automatic rebuild of service \`${service}\` (merge ${sha.slice(0, 8)}, repo ${repoDir})`);
  void getHost().execAsync(
    DOCKER_BIN,
    ['compose', 'up', '-d', '--build', service],
    { cwd: repoDir, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 },
  ).then((r) => {
    inFlight.delete(key);
    if (r.code !== 0) {
      const stderr = r.stderr || r.stdout;
      console.error(`[deploy] rebuild of ${service} failed: ${stderr.trim() || `code ${r.code}`}`);
      notifyUser(
        `Automatic rebuild failed: ${service}`,
        `The Docker rebuild of service \`${service}\` after merge ${sha.slice(0, 8)} ` +
          `("${task.title}") failed.\n\n${stderr.slice(-1500)}\n\n` +
          `Manual rebuild: \`docker compose up -d --build ${service}\` (in ${repoDir}).`,
        {
          taskId: task.id,
          message: daemonMessage('deploy_rebuild_failed', {
            service, sha: sha.slice(0, 8), title: task.title, output: stderr.slice(-1500), dir: repoDir,
          }),
        },
      );
      return;
    }
    console.log(`[deploy] service \`${service}\` rebuilt + restarted (merge ${sha.slice(0, 8)})`);
    notifyUser(
      `Automatic deploy: \`${service}\` rebuilt ✅`,
      `Merge ${sha.slice(0, 8)} ("${task.title}") changed \`${service}/\` → container ` +
        `rebuilt and restarted automatically. The change is live.`,
      { taskId: task.id, message: daemonMessage('deploy_rebuilt', { service, sha: sha.slice(0, 8), title: task.title }) },
    );
  });
}

async function handleMerge(missionId: string): Promise<void> {
  if (handled.has(missionId)) return; // mission_complete re-emitted → a single deployment
  const task = dbApi.getTaskByMission(missionId);
  if (!task || task.type !== 'merge' || task.status !== 'DONE') return;
  const sha = task.merged_commit_sha;
  if (!sha) return; // merge guard → no DONE without a sha, but stay defensive
  // Anti-replay: only act on a FRESHLY finished merge. Avoids re-deploying
  // an old merge if a late/replayed mission_complete comes up (e.g. at boot).
  if (Date.now() - (task.updated_at ?? 0) > 10 * 60_000) return;
  handled.add(missionId);

  const repoDir = loadConfig(task.agent_name).cwd;
  if (!repoDir || !existsSync(repoDir)) {
    console.warn(`[deploy] repo not found for task ${task.id} (cwd=${repoDir}) — skip`);
    return;
  }

  const changed = await gitChangedFiles(repoDir, sha);
  if (changed.length === 0) return;
  const topDirs = new Set<string>(changed.map((f) => f.split('/')[0] ?? '').filter(Boolean));

  // 1. Docker containers → automatic rebuild (safe). Gated on the presence of a
  //    docker-compose.yml at the root of the repo (projects without compose are
  //    ignored silently).
  const hasCompose =
    existsSync(join(repoDir, 'docker-compose.yml')) || existsSync(join(repoDir, 'compose.yml'));
  if (hasCompose) {
    const services = [...new Set([...topDirs].filter((d) => DOCKER_DIRS[d]).map((d) => DOCKER_DIRS[d]!))];
    for (const svc of services) rebuildService(repoDir, svc, task, sha);
  }

  // 2. orchestrator/ → notification only (never automatic: restart = death of the missions).
  const notifyDirs = [...topDirs].filter((d) => NOTIFY_ONLY_DIRS.has(d));
  if (notifyDirs.length) {
    console.log(`[deploy] merge ${sha.slice(0, 8)} touched ${notifyDirs.join(', ')}/ → orchestrator restart notice`);
    const notice = restartRequiredNotice(sha, task.title, notifyDirs);
    notifyUser(notice.title, notice.body, { taskId: task.id, message: notice.message });
  }
}

/** The notice a merge that touched the daemon's own folders posts, with this machine's restart line. */
export function restartRequiredNotice(sha: string, title: string, dirs: readonly string[]): {
  title: string; body: string; message: ReturnType<typeof daemonMessage>;
} {
  const cmds = `  ${restartLine()}`;
  return {
    title: `Orchestrator restart required`,
    body: `Merge ${sha.slice(0, 8)} ("${title}") changed \`${dirs.join('/`, `')}/\` — ` +
      `not deployed until the orchestrator restarts.\n\n` +
      `When you can (it stops the missions in flight):\n${cmds}`,
    message: daemonMessage('orchestrator_restart_required', {
      sha: sha.slice(0, 8), title, dirs: dirs.join('/`, `'), commands: cmds,
    }),
  };
}

export function startDeployHook(): () => void {
  const onBusEvent = (ev: BusEvent) => {
    if (ev.kind !== 'mission_complete' || ev.status !== 'completed') return;
    // No guard on `ev.reason` here: a merge mission killed by the quota
    // exits as `completed` (exit 0) but the dispatcher, registered BEFORE this
    // handler, will already have set its task to BLOCKED — `handleMerge` filters it on
    // `status === 'DONE'` + sha present. An `ev.reason` guard would even be wrong:
    // if the agent wrote `timon task done --merged-sha` THEN got killed, the
    // merge is real and must be deployed.
    handleMerge(ev.missionId).catch((err) =>
      console.error(`[deploy] handler error for ${ev.missionId}: ${(err as Error).message}`),
    );
  };
  bus.on('event', onBusEvent);
  console.log(`[deploy] post-merge deploy-hook started (docker=${DOCKER_BIN}, rebuild auto app/channels/remote, notif orchestrateur)`);
  return () => void bus.off('event', onBusEvent);
}
