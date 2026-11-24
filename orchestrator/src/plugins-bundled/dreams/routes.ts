/**
 * Module `dreams` — the nightly dream pass and project scoring.
 *
 * Routes extracted verbatim from the former core module: same paths, same status
 * codes, same payloads. Only their host module changes.
 */
import express, { type Router } from 'express';
import { dbApi } from '../../db.js';
import { viewerFromRequest } from '../../users/identity.js';
import { scopedDb } from '../../users/scoped-db.js';
import { closeDreamsCardIfDone, isDreamEnabled, readDreamInstructionsRaw, runDreamNow, setDreamEnabled, writeDreamInstructions } from '../../dreaming.js';
import { runScoringNow } from '../../memory-score.js';
import { autoColorFor, readMeta } from '../../projects.js';
import { apiError } from '../../api-error.js';

export function registerRoutes(app: Router): void {
  app.post('/api/projects/score', (req, res) => {
    const force = req.query.force !== '0';
    runScoringNow(force)
      .then((r) => res.json({ ok: true, ...r }))
      .catch((err) => res.status(500).json(apiError('project_scoring_failed', (err as Error).message, { detail: (err as Error).message })));
  });

  app.get('/api/dreams', (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const scope = scopedDb(viewerFromRequest(req));
      // By default: the review queue (pending + expired snoozed). status=all → everything.
      const rows = !status || status === 'active'
        ? scope.listActiveDreams()
        : status === 'all'
          ? scope.listDreamProposals({})
          : scope.listDreamProposals({ status });
      res.json({ dreams: rows, active: scope.countActiveDreams() });
    } catch (err) { res.status(500).json(apiError('dreams_read_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.post('/api/dreams/:id/decide', (req, res) => {
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as { status?: string; snooze_days?: number };
    const status = body.status;
    if (status !== 'accepted' && status !== 'rejected' && status !== 'snoozed') {
      res.status(400).json(apiError('dream_status_invalid', 'status must be accepted|rejected|snoozed'));
      return;
    }
    const snoozeUntil = status === 'snoozed'
      ? Date.now() + (Number(body.snooze_days) || 14) * 86400_000
      : null;
    if (!scopedDb(viewerFromRequest(req)).getDreamProposal(id)) {
      res.status(404).json(apiError('dream_not_found', 'dream not found')); return;
    }
    const row = dbApi.decideDream(id, status, snoozeUntil);
    if (!row) { res.status(404).json(apiError('dream_not_found', 'dream not found')); return; }
    // The "N tracks to review" card has nothing left to ask once the queue is empty.
    closeDreamsCardIfDone();
    res.json({ ok: true, dream: row });
  });

  app.post('/api/dreams/run', (_req, res) => {
    runDreamNow()
      .then((r) => res.json({ ok: true, ...r }))
      .catch((err) => res.status(500).json(apiError('dream_run_failed', (err as Error).message, { detail: (err as Error).message })));
  });

  app.get('/api/dreams/instructions', (_req, res) => {
    res.json({ text: readDreamInstructionsRaw() });
  });

  app.put('/api/dreams/instructions', express.text({ type: '*/*', limit: '256kb' }), (req, res) => {
    try {
      const text = typeof req.body === 'string' ? req.body : '';
      writeDreamInstructions(text);
      res.json({ ok: true });
    } catch (err) { res.status(500).json(apiError('dream_instructions_save_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.get('/api/dreams/config', (_req, res) => {
    res.json({ enabled: isDreamEnabled() });
  });

  app.put('/api/dreams/config', (req, res) => {
    try {
      const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== 'boolean') { res.status(400).json(apiError('enabled_required', 'enabled (boolean) required')); return; }
      setDreamEnabled(enabled);
      res.json({ enabled });
    } catch (err) { res.status(500).json(apiError('dream_config_save_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.get('/api/projects/scores', (_req, res) => {
    try {
      const rows = dbApi.listProjectRows();
      const projects = rows.map((r) => {
        const meta = readMeta(r.slug);
        return {
          slug: r.slug,
          name: meta.name || r.name || r.slug,
          color: meta.color || autoColorFor(meta.name || r.slug),
          icon: meta.icon ?? null,
          kind: r.kind ?? null,
          status: r.status,
          revenue_potential: r.revenue_potential,
          revenue_locked: r.revenue_locked === 1,
          progress: r.progress,
          score_rationale: r.score_rationale,
          score_updated_at: r.score_updated_at,
        };
      });
      res.json({ projects });
    } catch (err) {
      res.status(500).json(apiError('project_scores_read_failed', (err as Error).message, { detail: (err as Error).message }));
    }
  });
}
