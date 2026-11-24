/**
 * Read side of the outcome. Writing goes through `PATCH /api/project-todo/:id`
 * (see `outcome.ts`): one save of an idea, one write, one order of events.
 */
import type { Router } from 'express';
import { requireAuth, viewerFromRequest } from '../../users/identity.js';
import { scopedDb } from '../../users/scoped-db.js';
import { settingBool } from '../../settings.js';
import { getOutcome } from './store.js';
import { OUTCOME_SETTING } from './outcome.js';
import { apiError } from '../../api-error.js';

export function registerRoutes(app: Router): void {
  // The settings list is admin-only; the detail dialog only needs this bit.
  app.get('/api/todo-outcomes/config', (req, res) => {
    if (!requireAuth(req, res)) return;
    res.json({ enabled: settingBool(OUTCOME_SETTING) });
  });

  app.get('/api/todo-outcomes/outcome/:todoId', (req, res) => {
    if (!requireAuth(req, res)) return;
    const id = Number(req.params.todoId);
    if (!Number.isInteger(id)) { res.status(400).json(apiError('invalid_id', 'invalid todo id')); return; }
    // Same visibility as the idea itself: an outcome is never read past its owner.
    if (!scopedDb(viewerFromRequest(req)).getProjectTodo(id)) {
      res.status(404).json(apiError('todo_not_found', 'project-todo item not found'));
      return;
    }
    res.json({ outcome: getOutcome(id) });
  });
}
