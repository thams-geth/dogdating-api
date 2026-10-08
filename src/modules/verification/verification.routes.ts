import { Router } from 'express';
import { z } from 'zod';
import { authenticate, currentUser } from '../../http/authenticate.js';
import { asyncHandler } from '../../http/async-handler.js';
import { pageQuery } from '../../http/pagination.js';
import type { AuthService } from '../auth/auth.service.js';
import type { VerificationService } from './verification.service.js';
import { verificationSchema, healthSchema } from './verification.schemas.js';
const uuid = z.string().uuid();
export function verificationRoutes(service: VerificationService, auth?: AuthService) {
  const router = Router();
  router.use(authenticate(auth));
  router.post('/verifications', asyncHandler(async (req,res) => res.status(201).json(await service.create(currentUser(res).userId, verificationSchema.parse(req.body)))));
  router.get('/verifications/:id', asyncHandler(async (req,res) => res.json(await service.status(currentUser(res).userId, uuid.parse(req.params.id)))));
  router.post('/verifications/:id/withdraw', asyncHandler(async (req,res) => {
    z.object({}).strict().parse(req.body); res.json(await service.withdraw(currentUser(res).userId, uuid.parse(req.params.id)));
  }));
  router.post('/dogs/:dogId/health-records', asyncHandler(async (req,res) => res.status(201).json(await service.addHealth(currentUser(res).userId, uuid.parse(req.params.dogId), healthSchema.parse(req.body)))));
  router.get('/dogs/:dogId/health-records', asyncHandler(async (req,res) => {
    const query = pageQuery.parse(req.query);
    res.json(await service.listHealth(currentUser(res).userId, uuid.parse(req.params.dogId), query.limit, query.cursor));
  }));
  router.delete('/dogs/:dogId/health-records/:id', asyncHandler(async (req,res) => {
    await service.removeHealth(currentUser(res).userId, uuid.parse(req.params.dogId), uuid.parse(req.params.id)); res.sendStatus(204);
  }));
  return router;
}
