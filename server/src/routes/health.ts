import { Router } from 'express';
import { handleHealth } from '../handlers/health.ts';
import type { AppConfig } from '../config/env.ts';
import type { Database } from '../db/types.ts';

/**
 * Routes are thin by policy: parse, call the handler, send what it returns.
 *
 * The config is passed explicitly rather than letting the handler fall back to
 * the module singleton. An app built from an explicit config — every test, and
 * any future harness — would otherwise be described by the process's config
 * instead of its own, and a status surface that contradicts the system it
 * reports on is worse than no status surface.
 */
export function createHealthRouter(db: Database, config?: AppConfig): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const result = await handleHealth(config ? { db, config } : { db });
    res.status(result.status).json(result.body);
  });

  return router;
}
