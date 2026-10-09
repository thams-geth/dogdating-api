import { Router } from 'express';import { z } from 'zod';
import { authenticate,currentUser } from '../../http/authenticate.js';import { asyncHandler } from '../../http/async-handler.js';import { pageQuery } from '../../http/pagination.js';
import type { AuthService } from '../auth/auth.service.js';import type { MeetupsService } from './meetups.service.js';
import { placeQuery,placeSuggestion,proposeInput,respondInput,cancelInput,revisionInput,reviewInput } from './meetups.schemas.js';
export function meetupRoutes(service:MeetupsService,auth?:AuthService){const router=Router();router.use(authenticate(auth));const id=(v:unknown)=>z.string().uuid().parse(v);
 router.get('/places',asyncHandler(async(req,res)=>{const q=placeQuery.parse(req.query);res.json(await service.places(q.metroId,q.limit,q.cursor));}));
 router.post('/places/suggestions',asyncHandler(async(req,res)=>{res.status(201).json(await service.suggest(currentUser(res).userId,placeSuggestion.parse(req.body)));}));
 router.get('/places/:id',asyncHandler(async(req,res)=>{res.json(await service.place(id(req.params.id)));}));
 router.post('/meetups',asyncHandler(async(req,res)=>{res.status(201).json(await service.propose(currentUser(res).userId,proposeInput.parse(req.body),id(req.get('Idempotency-Key'))));}));
 router.get('/meetups',asyncHandler(async(req,res)=>{const q=pageQuery.parse(req.query);res.json(await service.list(currentUser(res).userId,q.limit,q.cursor));}));
 router.get('/meetups/:id',asyncHandler(async(req,res)=>{res.json(await service.get(currentUser(res).userId,id(req.params.id)));}));
 router.post('/meetups/:id/respond',asyncHandler(async(req,res)=>{res.json(await service.respond(currentUser(res).userId,id(req.params.id),respondInput.parse(req.body)));}));
 router.post('/meetups/:id/cancel',asyncHandler(async(req,res)=>{res.json(await service.cancel(currentUser(res).userId,id(req.params.id),cancelInput.parse(req.body)));}));
 for(const action of ['check-in','check-out'] as const)router.post(`/meetups/:id/${action}`,asyncHandler(async(req,res)=>{res.json(await service.attendance(currentUser(res).userId,id(req.params.id),revisionInput.parse(req.body).revision,action));}));
 router.post('/meetups/:id/reviews',asyncHandler(async(req,res)=>{res.status(201).json(await service.review(currentUser(res).userId,id(req.params.id),reviewInput.parse(req.body)));}));
 router.get('/meetups/:id/reviews',asyncHandler(async(req,res)=>{res.json(await service.reviews(currentUser(res).userId,id(req.params.id)));}));return router;
}
