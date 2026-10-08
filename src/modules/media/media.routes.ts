import express, { Router } from 'express';
import { z } from 'zod';
import { authenticate, currentUser } from '../../http/authenticate.js';
import { asyncHandler } from '../../http/async-handler.js';
import { ApiError } from '../../middleware/error.js';
import type { AuthService } from '../auth/auth.service.js';
import type { MediaService } from './media.service.js';
import { orderSchema, uploadSchema } from './media.schemas.js';
const uuid = z.string().uuid();
export function mediaRoutes(service: MediaService, auth?: AuthService) {
  const router = Router();
  router.use(authenticate(auth));
  router.post('/dogs/:dogId/media/uploads', asyncHandler(async (req, res) => res.status(201).json(await service.create(currentUser(res).userId, uuid.parse(req.params.dogId), uploadSchema.parse(req.body)))));
  router.get('/dogs/:dogId/media', asyncHandler(async (req, res) => res.json(await service.list(currentUser(res).userId, uuid.parse(req.params.dogId)))));
  router.patch('/dogs/:dogId/media/order', asyncHandler(async (req, res) => {
    await service.order(currentUser(res).userId, uuid.parse(req.params.dogId), orderSchema.parse(req.body).mediaIds); res.sendStatus(204);
  }));
  router.delete('/dogs/:dogId/media/:id', asyncHandler(async (req, res) => {
    await service.remove(currentUser(res).userId, uuid.parse(req.params.dogId), uuid.parse(req.params.id)); res.sendStatus(204);
  }));
  router.put('/media/:id/content', (req, _res, next) => {
    if (!['image/jpeg', 'image/png'].includes(req.headers['content-type'] ?? '')) return next(new ApiError(415, 'unsupported-media', 'Use image/jpeg or image/png.'));
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return next(new ApiError(415, 'unsupported-encoding', 'Compressed request bodies are not accepted.'));
    next();
  }, express.raw({ type: ['image/jpeg', 'image/png'], limit: '8mb', inflate: false }), asyncHandler(async (req, res) => {
    res.json(await service.upload(currentUser(res).userId, uuid.parse(req.params.id), req.headers['content-type']!, req.body));
  }));
  router.post('/media/:id/complete', asyncHandler(async (req, res) => {
    z.object({}).strict().parse(req.body); res.json(await service.complete(currentUser(res).userId, uuid.parse(req.params.id)));
  }));
  router.get('/media/:id', asyncHandler(async (req, res) => res.json(await service.status(currentUser(res).userId, uuid.parse(req.params.id)))));
  return router;
}
