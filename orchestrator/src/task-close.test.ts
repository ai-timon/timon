/**
 * Clôture typée d'une task : `POST /api/tasks/close`.
 *
 * Ce que ces tests verrouillent, c'est le diagnostic du 2026-09-05 : selon le
 * backend LLM, les agents n'arrivaient pas à clore leur task et l'orchestrateur
 * ne recevait jamais leur retour. Les trois causes tenaient au geste lui-même —
 * un id à recopier depuis le texte du brief, un commentaire à faire survivre au
 * quoting shell, et un ordre sha→statut à respecter. La route les supprime :
 * résolution par la mission courante, commentaire obligatoire, sha posé avant
 * le statut.
 *
 * `node --test --import tsx src/task-close.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { getHost } from './host/index.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-task-close-test-'));

const { dbApi } = await import('./db.js');
const { parseReviewVerdict } = await import('./review-verdict.js');
const { registerRoutes, CLOSED_TASK_STOP_DELAY_MS } = await import('./plugins-bundled/kanban/routes.js');
const { bus } = await import('./bus.js');

/** Une task dispatchée : une mission qui tourne, la task qui lui est attachée. */
function dispatched(type: 'code' | 'review' | 'merge' | 'chore' = 'chore') {
  const missionId = randomUUID();
  const taskId = randomUUID();
  dbApi.createMission(missionId, 'p.coder', 'brief de la task');
  dbApi.createTask(taskId, `volet ${type}`, 'p.coder', { type });
  dbApi.assignTaskMission(taskId, missionId);
  return { missionId, taskId };
}

async function withApi<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  // The operator: writing a task needs an identity holding kanban:write (TODO #752).
  app.use((req, _res, next) => { req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true }; next(); });
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function close(base: string, body: Record<string, unknown>, missionId?: string) {
  return fetch(`${base}/api/tasks/close`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(missionId ? { 'X-TIMON-Mission': missionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('la task se résout depuis la mission courante — aucun id à recopier', async () => {
  const { missionId, taskId } = dispatched();
  await withApi(async (base) => {
    const r = await close(base, { outcome: 'done', comment: 'volet livré, 2 fichiers touchés' }, missionId);
    assert.equal(r.status, 200);
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'DONE');
    assert.equal(task?.done_comment, 'volet livré, 2 fichiers touchés');
  });
});

test('sans mission ni id, la clôture est refusée plutôt que devinée', async () => {
  await withApi(async (base) => {
    const r = await close(base, { outcome: 'done', comment: 'fini' });
    assert.equal(r.status, 400);
  });
});

test('un commentaire vide est refusé : c\'est la clôture muette qu\'on interdit', async () => {
  const { missionId, taskId } = dispatched();
  await withApi(async (base) => {
    for (const body of [{ outcome: 'done' }, { outcome: 'done', comment: '   ' }]) {
      const r = await close(base, body, missionId);
      assert.equal(r.status, 400);
    }
    // La task n'a pas bougé : refuser ne clôt pas à moitié.
    assert.equal(dbApi.getTask(taskId)?.status, 'IN_PROGRESS');
  });
});

test('le verdict d\'une review est rendu en 1re ligne, lisible par parseReviewVerdict', async () => {
  const { missionId, taskId } = dispatched('review');
  await withApi(async (base) => {
    const r = await close(base, {
      outcome: 'done',
      verdict: 'changes_requested',
      comment: '{"findings":["fuite de secret ligne 12"]}',
    }, missionId);
    assert.equal(r.status, 200);
    const comment = dbApi.getTask(taskId)?.done_comment ?? null;
    assert.ok(comment?.startsWith('verdict: changes_requested'));
    assert.equal(parseReviewVerdict(comment).verdict, 'changes_requested');
  });
});

test('un verdict déjà écrit par l\'agent n\'est pas redoublé', async () => {
  const { missionId, taskId } = dispatched('review');
  await withApi(async (base) => {
    await close(base, { outcome: 'done', verdict: 'pass', comment: 'verdict: pass\n\nRAS' }, missionId);
    const comment = dbApi.getTask(taskId)?.done_comment ?? '';
    assert.equal(comment.match(/verdict:/g)?.length, 1);
    assert.equal(parseReviewVerdict(comment).verdict, 'pass');
  });
});

test('un verdict hors enum est refusé', async () => {
  const { missionId } = dispatched('review');
  await withApi(async (base) => {
    const r = await close(base, { outcome: 'done', verdict: 'peut-être', comment: 'bof' }, missionId);
    assert.equal(r.status, 400);
  });
});

test('le sha de merge est posé AVANT le statut : la task merge passe DONE, pas BLOCKED', async () => {
  const { missionId, taskId } = dispatched('merge');
  const sha = 'a'.repeat(40);
  await withApi(async (base) => {
    const r = await close(base, { outcome: 'done', comment: 'mergé sur main', merged_sha: sha }, missionId);
    assert.equal(r.status, 200);
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'DONE');
    assert.equal(task?.merged_commit_sha, sha);
  });
});

test('un sha malformé est refusé, et la task reste ouverte', async () => {
  const { missionId, taskId } = dispatched('merge');
  await withApi(async (base) => {
    const r = await close(base, { outcome: 'done', comment: 'mergé', merged_sha: 'HEAD~1' }, missionId);
    assert.equal(r.status, 400);
    assert.equal(dbApi.getTask(taskId)?.status, 'IN_PROGRESS');
  });
});

test('mark_as_failed pose BLOCKED avec sa raison, et exige cette raison', async () => {
  const { missionId, taskId } = dispatched();
  await withApi(async (base) => {
    const refused = await close(base, { outcome: 'failed' }, missionId);
    assert.equal(refused.status, 400);
    assert.equal(dbApi.getTask(taskId)?.status, 'IN_PROGRESS');

    const r = await close(base, { outcome: 'failed', reason: 'dépendance npm indisponible' }, missionId);
    assert.equal(r.status, 200);
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'BLOCKED');
    assert.equal(task?.blocked_reason, 'dépendance npm indisponible');
  });
});

test('un id explicite permet de clore une AUTRE task que la sienne', async () => {
  const { missionId } = dispatched();
  const other = dispatched();
  await withApi(async (base) => {
    const r = await close(base, { outcome: 'done', id: other.taskId, comment: 'reprise manuelle' }, missionId);
    assert.equal(r.status, 200);
    assert.equal(dbApi.getTask(other.taskId)?.status, 'DONE');
  });
});

test('une mission sans task, ou un id inconnu, rend 404', async () => {
  const orphan = randomUUID();
  dbApi.createMission(orphan, 'p.coder', 'mission de chat, sans task');
  await withApi(async (base) => {
    assert.equal((await close(base, { outcome: 'done', comment: 'x' }, orphan)).status, 404);
    assert.equal((await close(base, { outcome: 'done', id: randomUUID(), comment: 'x' })).status, 404);
  });
});


for (const method of ['POST', 'PUT'] as const) {
  for (const pipeline of ['code-self', 'code-group'] as const) {
    test(`${method} ${pipeline}: closing follows the pipeline contract`, async (t) => {
      const repo = mkdtempSync(join(tmpdir(), 'timon-close-git-'));
      t.after(() => rmSync(repo, { recursive: true, force: true }));
      const git = (...args: string[]) => {
        const result = getHost().exec('git', args, { cwd: repo, timeout: 5_000 });
        assert.equal(result.code, 0, result.stderr);
        return result.stdout.trim();
      };
      git('init', '-b', 'main');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'integrated work');
      const sha = git('rev-parse', 'HEAD');
      git('checkout', '-b', 'task');
      if (pipeline === 'code-group') {
        git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'awaiting group merge');
      }
      const taskId = randomUUID();
      dbApi.createTask(taskId, 'Integrated code', 'p.coder', { type: 'code', pipeline });
      dbApi.setTaskWorktree(taskId, repo, 'task', 'main');
      await withApi(async (base) => {
        const response = method === 'POST'
          ? await close(base, {
            id: taskId, comment: 'Delivered',
            ...(pipeline === 'code-self' ? { merged_sha: sha } : {}),
          })
          : await fetch(`${base}/api/tasks/${taskId}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              status: 'DONE', done_comment: 'Delivered',
              ...(pipeline === 'code-self' ? { merged_commit_sha: sha } : {}),
            }),
          });
        assert.equal(response.status, 200);
        const task = dbApi.getTask(taskId);
        assert.equal(task?.status, 'DONE');
        assert.equal(task?.merged_commit_sha, pipeline === 'code-self' ? sha : null);
        assert.equal(task?.done_comment, 'Delivered');
      });
    });
  }
}

test('a stacked pull request is checked against the destination passed at close', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'timon-close-stack-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = getHost().exec('git', args, { cwd: repo, timeout: 5_000 });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'base');
  git('checkout', '-b', 'pr-head');
  writeFileSync(join(repo, 'feature.txt'), 'feature\n');
  git('add', 'feature.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'feature');
  const feature = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/pr-head', feature);
  git('checkout', 'main');
  git('merge', '--squash', 'pr-head');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'squash onto destination');
  const squash = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', squash);

  const open = () => {
    const taskId = randomUUID();
    dbApi.createTask(taskId, 'Stacked close', 'p.coder', {
      type: 'code',
      pipeline: 'code-self',
      baseBranch: 'pr-head',
      integrationMode: 'pull-request',
      baseRef: 'origin/pr-head',
    });
    dbApi.setTaskWorktree(taskId, repo, 'task', 'pr-head');
    return taskId;
  };

  await withApi(async (base) => {
    const warned = open();
    const without = await close(base, { id: warned, comment: 'Delivered', merged_sha: squash });
    assert.equal(without.status, 200);
    assert.match(dbApi.getTask(warned)?.done_comment ?? '', /not contained in base pr-head/);
    assert.equal(dbApi.getTask(warned)?.base_ref, 'origin/pr-head');

    const posted = open();
    const post = await close(base, { id: posted, comment: 'Delivered', merged_sha: squash, merged_base: 'main' });
    assert.equal(post.status, 200);
    assert.equal(dbApi.getTask(posted)?.done_comment, 'Delivered');
    assert.equal(dbApi.getTask(posted)?.base_ref, 'origin/pr-head', 'the worktree pin is not the destination');

    const putId = open();
    const put = await fetch(`${base}/api/tasks/${putId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'DONE',
        done_comment: 'Delivered',
        merged_commit_sha: squash,
        merged_base: 'origin/main',
      }),
    });
    assert.equal(put.status, 200);
    assert.equal(dbApi.getTask(putId)?.done_comment, 'Delivered');

    const refused = open();
    const bad = await close(base, { id: refused, comment: 'Delivered', merged_sha: squash, merged_base: 'foo..bar' });
    assert.equal(bad.status, 400);
    assert.equal(dbApi.getTask(refused)?.status, 'PENDING');
    assert.equal(dbApi.getTask(refused)?.merged_commit_sha, null);
  });
});

test('le résumé humain est stocké, plafonné, et effacé par une clôture qui n\'en donne pas', async () => {
  const { missionId, taskId } = dispatched();
  await withApi(async (base) => {
    const r = await close(base, { outcome: 'done', comment: 'rapport complet', summary: '  Le widget TO DO affiche les numéros.  ' }, missionId);
    assert.equal(r.status, 200);
    assert.equal(dbApi.getTask(taskId)?.done_summary, 'Le widget TO DO affiche les numéros.');

    // A summary too long is clamped, never refused: the close must not fail.
    const long = await close(base, { outcome: 'done', id: taskId, comment: 'rapport', summary: 'x'.repeat(1_000) });
    assert.equal(long.status, 200);
    const clamped = dbApi.getTask(taskId)?.done_summary ?? '';
    assert.ok(clamped.length <= 400 && clamped.endsWith('…'));

    // A non-string summary is ignored, and a close without one clears the old.
    const odd = await close(base, { outcome: 'done', id: taskId, comment: 'rapport', summary: 42 });
    assert.equal(odd.status, 200);
    assert.equal(dbApi.getTask(taskId)?.done_summary, null);
  });
});

test('mark_as_failed n\'hérite pas du résumé d\'une clôture précédente', async () => {
  const { missionId, taskId } = dispatched();
  await withApi(async (base) => {
    await close(base, { outcome: 'done', comment: 'livré', summary: 'Tout est livré.' }, missionId);
    await close(base, { outcome: 'failed', id: taskId, reason: 'régression trouvée' });
    assert.equal(dbApi.getTask(taskId)?.done_summary, null);
  });
});

/** Polls a condition: the stop is deferred, so its effect lands a tick later. */
async function until(check: () => boolean, label: string, ms = CLOSED_TASK_STOP_DELAY_MS * 4): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

for (const method of ['POST', 'PUT'] as const) {
  test(`${method}: the answer goes out before the agent's process is stopped, and it is stopped once`, async () => {
    // The agent closes through a stdio MCP server, child of its own process:
    // stopped in the same tick, it never relayed the answer ("Connection closed").
    const { missionId, taskId } = dispatched();
    let completions = 0;
    const onEvent = (ev: { kind: string; missionId?: string }) => {
      if (ev.kind === 'mission_complete' && ev.missionId === missionId) completions += 1;
    };
    bus.on('event', onEvent);
    try {
      await withApi(async (base) => {
        const closeOnce = () => method === 'POST'
          ? close(base, { outcome: 'done', comment: 'livré' }, missionId)
          : fetch(`${base}/api/tasks/${taskId}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'DONE', done_comment: 'livré' }),
          });
        const r = await closeOnce();
        assert.equal(r.status, 200);
        assert.equal(dbApi.getTask(taskId)?.status, 'DONE');
        assert.equal(dbApi.getMission(missionId)?.status, 'running', 'the process outlives the answer');
        // A retried close (the very symptom) must not schedule a second stop.
        if (method === 'POST') assert.equal((await closeOnce()).status, 200);
        else await close(base, { outcome: 'done', id: taskId, comment: 'livré' });
        await until(() => dbApi.getMission(missionId)?.status !== 'running', 'the mission is stopped');
        assert.equal(dbApi.getMission(missionId)?.status, 'terminated');
        await new Promise((r) => setTimeout(r, CLOSED_TASK_STOP_DELAY_MS + 100));
        assert.equal(completions, 1, 'mission_complete still starts the pipeline, once');
      });
    } finally {
      bus.off('event', onEvent);
    }
  });
}
