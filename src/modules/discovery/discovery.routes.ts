import { Router } from 'express';
import { z } from 'zod';
import { authenticate,currentUser } from '../../http/authenticate.js';
import { asyncHandler } from '../../http/async-handler.js';
import type { AuthService } from '../auth/auth.service.js';
import type { DiscoveryService } from './discovery.service.js';
import { actorQuery,feedQuery,profileQuery } from './discovery.schemas.js';
export function discoveryRoutes(service:DiscoveryService,auth?:AuthService){
  const router=Router();router.use(authenticate(auth));
  router.get('/home',asyncHandler(async(req,res)=>res.json(await service.home(currentUser(res).userId,actorQuery.parse(req.query).dogId))));
  router.get('/feed',asyncHandler(async(req,res)=>res.json(await service.feed(currentUser(res).userId,feedQuery.parse(req.query)))));
  router.get('/feed/empty-reason',asyncHandler(async(req,res)=>res.json(await service.emptyReason(currentUser(res).userId,actorQuery.parse(req.query).dogId))));
  router.get('/dogs/:id/profile',asyncHandler(async(req,res)=>{const q=profileQuery.parse(req.query);res.json(await service.profile(currentUser(res).userId,z.string().uuid().parse(req.params.id),q.dogId,q.impressionToken));}));
  router.get('/dogs/:id/discovery-preferences',asyncHandler(async(req,res)=>res.json(await service.preferences(currentUser(res).userId,z.string().uuid().parse(req.params.id)))));
  return router;
}
