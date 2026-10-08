import { Router } from 'express';
import { authenticate,currentUser } from '../../http/authenticate.js';
import { asyncHandler } from '../../http/async-handler.js';
import { pageQuery } from '../../http/pagination.js';
import type { AuthService } from '../auth/auth.service.js';
import { uuidSchema } from '../auth/auth.schemas.js';
import { emptyBody } from '../onboarding/onboarding.schemas.js';
import type { DogsService } from './dogs.service.js';
import { createDogSchema,updateDogSchema,breedsSchema,temperamentSchema,dogPreferencesSchema,availabilitySchema,beaconSchema } from './dogs.schemas.js';
export function dogRoutes(service:DogsService,auth?:AuthService){
 const router=Router();router.use(authenticate(auth));
 router.post('/',asyncHandler(async(req,res)=>res.status(201).json(await service.create(currentUser(res).userId,createDogSchema.parse(req.body)))));
 router.get('/',asyncHandler(async(req,res)=>{const q=pageQuery.parse(req.query);res.json(await service.list(currentUser(res).userId,q.limit,q.cursor));}));
 router.get('/:id',asyncHandler(async(req,res)=>res.json(await service.detail(currentUser(res).userId,uuidSchema.parse(req.params.id)))));
 router.patch('/:id',asyncHandler(async(req,res)=>res.json(await service.update(currentUser(res).userId,uuidSchema.parse(req.params.id),updateDogSchema.parse(req.body)))));
 router.put('/:id/breeds',asyncHandler(async(req,res)=>res.json(await service.breeds(currentUser(res).userId,uuidSchema.parse(req.params.id),breedsSchema.parse(req.body)))));
 router.put('/:id/temperament',asyncHandler(async(req,res)=>res.json(await service.temperament(currentUser(res).userId,uuidSchema.parse(req.params.id),temperamentSchema.parse(req.body)))));
 router.put('/:id/preferences',asyncHandler(async(req,res)=>res.json(await service.preferences(currentUser(res).userId,uuidSchema.parse(req.params.id),dogPreferencesSchema.parse(req.body)))));
 router.put('/:id/availability',asyncHandler(async(req,res)=>res.json(await service.availability(currentUser(res).userId,uuidSchema.parse(req.params.id),availabilitySchema.parse(req.body)))));
 for(const action of ['publish','pause','memorialise'] as const)router.post(`/:id/${action}`,asyncHandler(async(req,res)=>{
  emptyBody.parse(req.body??{});res.json(await service.state(currentUser(res).userId,uuidSchema.parse(req.params.id),action));
 }));
 router.post('/:id/beacon',asyncHandler(async(req,res)=>res.json(await service.beacon(currentUser(res).userId,uuidSchema.parse(req.params.id),beaconSchema.parse(req.body).durationMinutes))));
 router.delete('/:id/beacon',asyncHandler(async(req,res)=>{await service.beacon(currentUser(res).userId,uuidSchema.parse(req.params.id),null);res.sendStatus(204);}));
 return router;
}
