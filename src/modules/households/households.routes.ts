import { Router } from 'express';
import type { AuthService } from '../auth/auth.service.js';
import { authenticate,currentUser } from '../../http/authenticate.js';
import { asyncHandler } from '../../http/async-handler.js';
import { pageQuery } from '../../http/pagination.js';
import { uuidSchema } from '../auth/auth.schemas.js';
import { householdSchema,inviteSchema,roleSchema,inviteTokenSchema } from './households.schemas.js';
import type { HouseholdsService } from './households.service.js';
import { emptyBody } from '../onboarding/onboarding.schemas.js';
export function householdRoutes(service:HouseholdsService,auth?:AuthService){
 const router=Router();router.use(authenticate(auth));
 router.post('/',asyncHandler(async(req,res)=>res.status(201).json(await service.create(currentUser(res).userId,householdSchema.parse(req.body).name))));
 router.get('/',asyncHandler(async(req,res)=>{const q=pageQuery.parse(req.query);res.json(await service.list(currentUser(res).userId,q.limit,q.cursor));}));
 router.get('/:id',asyncHandler(async(req,res)=>res.json(await service.detail(currentUser(res).userId,uuidSchema.parse(req.params.id)))));
 router.patch('/:id',asyncHandler(async(req,res)=>res.json(await service.rename(currentUser(res).userId,uuidSchema.parse(req.params.id),householdSchema.parse(req.body).name))));
 router.get('/:id/members',asyncHandler(async(req,res)=>res.json(await service.members(currentUser(res).userId,uuidSchema.parse(req.params.id)))));
 router.patch('/:id/members/:userId',asyncHandler(async(req,res)=>{await service.changeMember(currentUser(res).userId,uuidSchema.parse(req.params.id),uuidSchema.parse(req.params.userId),roleSchema.parse(req.body).role);res.sendStatus(204);}));
 router.delete('/:id/members/:userId',asyncHandler(async(req,res)=>{await service.changeMember(currentUser(res).userId,uuidSchema.parse(req.params.id),uuidSchema.parse(req.params.userId),null);res.sendStatus(204);}));
 router.post('/:id/invitations',asyncHandler(async(req,res)=>res.status(201).json(await service.invite(currentUser(res).userId,uuidSchema.parse(req.params.id),inviteSchema.parse(req.body)))));
 return router;
}
export function invitationRoutes(service:HouseholdsService,auth?:AuthService){
 const router=Router();router.use(authenticate(auth));
 router.post('/:token/accept',asyncHandler(async(req,res)=>{emptyBody.parse(req.body??{});res.json(await service.accept(currentUser(res).userId,inviteTokenSchema.parse(req.params.token)));}));
 return router;
}
