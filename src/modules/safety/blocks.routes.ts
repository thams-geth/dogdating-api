import { Router } from 'express';
import { z } from 'zod';
import { authenticate, currentUser } from '../../http/authenticate.js';
import { asyncHandler } from '../../http/async-handler.js';
import { pageQuery } from '../../http/pagination.js';
import type { AuthService } from '../auth/auth.service.js';
import type { BlocksService } from './blocks.service.js';
export function blockRoutes(service: BlocksService, auth?: AuthService) {
  const router = Router(); router.use(authenticate(auth));
  router.get('/', asyncHandler(async(req,res) => { const q=pageQuery.parse(req.query); res.json(await service.list(currentUser(res).userId,q.limit,q.cursor)); }));
  router.post('/', asyncHandler(async(req,res) => {
    const input=z.object({userId:z.string().uuid()}).strict().parse(req.body);
    await service.add(currentUser(res).userId,input.userId); res.sendStatus(204);
  }));
  router.delete('/:userId', asyncHandler(async(req,res) => { await service.remove(currentUser(res).userId,z.string().uuid().parse(req.params.userId)); res.sendStatus(204); }));
  return router;
}
