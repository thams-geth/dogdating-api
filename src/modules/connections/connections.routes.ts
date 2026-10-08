import { Router } from 'express';
import { z } from 'zod';
import { authenticate,currentUser } from '../../http/authenticate.js';
import { asyncHandler } from '../../http/async-handler.js';
import { pageQuery } from '../../http/pagination.js';
import type { AuthService } from '../auth/auth.service.js';
import type { ConnectionsService } from './connections.service.js';
import { connectionQuery,decisionSchema } from './connections.schemas.js';
export function connectionRoutes(service:ConnectionsService,auth?:AuthService){
 const router=Router();router.use(authenticate(auth));
 router.post('/decisions',asyncHandler(async(req,res)=>{res.json(await service.decide(currentUser(res).userId,decisionSchema.parse(req.body),z.string().uuid().parse(req.get('Idempotency-Key'))));}));
 router.get('/me/entitlements',asyncHandler(async(_req,res)=>{res.json(await service.entitlements(currentUser(res).userId));}));
 for(const direction of ['sent','received'] as const)router.get(`/likes/${direction}`,asyncHandler(async(req,res)=>{const q=connectionQuery.parse(req.query);res.json(await service.likes(currentUser(res).userId,q.dogId,direction,q.limit,q.cursor));}));
 router.delete('/likes/:id',asyncHandler(async(req,res)=>{await service.withdraw(currentUser(res).userId,z.string().uuid().parse(req.params.id));res.sendStatus(204);}));
 router.get('/matches',asyncHandler(async(req,res)=>{const q=pageQuery.parse(req.query);res.json(await service.matches(currentUser(res).userId,q.limit,q.cursor));}));
 router.get('/matches/:id',asyncHandler(async(req,res)=>{res.json(await service.match(currentUser(res).userId,z.string().uuid().parse(req.params.id)));}));
 router.delete('/matches/:id',asyncHandler(async(req,res)=>{await service.unmatch(currentUser(res).userId,z.string().uuid().parse(req.params.id));res.sendStatus(204);}));
 return router;
}
