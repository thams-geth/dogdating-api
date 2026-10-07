import { Router } from 'express';
import { bootstrap, bootstrapQuery } from './app.service.js';
import { countries, type AppPolicy } from './policy.js';

export function appRoutes(policy: AppPolicy): Router {
  const router = Router();
  router.get('/bootstrap', (req, res) => res.json(bootstrap(bootstrapQuery.parse(req.query), policy)));
  router.get('/countries', (_req, res) => res.json({ countries }));
  return router;
}
