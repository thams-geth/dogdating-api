import { Router } from 'express';
import type { Pool } from 'pg';
import { asyncHandler } from '../../http/async-handler.js';

export function breedRoutes(database: Pool): Router {
  const router = Router();
  router.get('/', asyncHandler(async (_req, res) => {
    const result = await database.query(`SELECT id, canonical_name AS name,
      size_class::text AS "sizeClass", typical_energy AS "typicalEnergy",
      required_health_tests AS "requiredHealthTests", extreme_conformation_flags AS "conformationFlags"
      FROM graph.breeds ORDER BY canonical_name`);
    res.json({ breeds: result.rows });
  }));
  return router;
}
