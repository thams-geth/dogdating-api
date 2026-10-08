import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler.js';
import { authenticate, currentUser } from '../../http/authenticate.js';
import type { AuthService } from '../auth/auth.service.js';
import type { LocationService } from './location.service.js';
import { areaQuery, locationSchema } from './location.schemas.js';
const uuid = z.string().uuid();
export function areaRoutes(service: LocationService) {
  const router = Router();
  router.get('/', asyncHandler(async (req, res) => res.json(await service.areas(areaQuery.parse(req.query)))));
  return router;
}
export function locationRoutes(service: LocationService, auth?: AuthService) {
  const router = Router(); router.use(authenticate(auth));
  router.get('/:id/location', asyncHandler(async (req,res) => res.json(await service.get(currentUser(res).userId, uuid.parse(req.params.id)))));
  router.put('/:id/location', asyncHandler(async (req,res) => res.json(await service.save(currentUser(res).userId, uuid.parse(req.params.id), locationSchema.parse(req.body).areaId))));
  router.delete('/:id/location', asyncHandler(async (req,res) => { await service.clear(currentUser(res).userId, uuid.parse(req.params.id)); res.sendStatus(204); }));
  return router;
}
