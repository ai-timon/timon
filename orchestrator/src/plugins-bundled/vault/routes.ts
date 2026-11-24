/**
 * Module `vault` — access to the knowledge vault (graph, disc, notes).
 *
 * Routes extracted verbatim from `index.ts` (step 1.4). No logic
 * changed: only the place where they are registered moves.
 */
import { configuredVaultRoot } from '../../vault-root.js';
import type { Router } from 'express';
import { getVaultDisc } from '../../vault-disc.js';
import { getVaultGraph, getVaultNote } from '../../vault-graph.js';
import { apiError } from '../../api-error.js';

export function registerRoutes(app: Router): void {
  app.get('/api/vault/graph', (_req, res) => {
    res.json({ ...getVaultGraph(), configured: Boolean(configuredVaultRoot()) });
  });

  app.get('/api/vault/disc', (_req, res) => {
    res.json(getVaultDisc());
  });

  app.get('/api/vault/note', (req, res) => {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    if (!id) {
      res.status(400).json(apiError('vault_note_id_required', 'id required'));
      return;
    }
    const note = getVaultNote(id);
    if (!note) {
      res.status(404).json(apiError('vault_note_not_found', 'note not found'));
      return;
    }
    res.json(note);
  });
}
