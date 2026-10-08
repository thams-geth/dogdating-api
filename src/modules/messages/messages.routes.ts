import { Router } from 'express';
import { z } from 'zod';
import { authenticate,currentUser } from '../../http/authenticate.js';
import { asyncHandler } from '../../http/async-handler.js';
import { pageQuery } from '../../http/pagination.js';
import type { AuthService } from '../auth/auth.service.js';
import type { MessagesService } from './messages.service.js';
import { messageInput,historyQuery,readInput,conversationPreferences } from './messages.schemas.js';
export function messageRoutes(service:MessagesService,auth?:AuthService){
 const router=Router();router.use(authenticate(auth));const id=(value:unknown)=>z.string().uuid().parse(value);
 router.get('/conversations',asyncHandler(async(req,res)=>{const q=pageQuery.parse(req.query);res.json(await service.list(currentUser(res).userId,q.limit,q.cursor));}));
 router.get('/conversations/:id/messages',asyncHandler(async(req,res)=>{res.json(await service.history(currentUser(res).userId,id(req.params.id),historyQuery.parse(req.query)));}));
 router.post('/conversations/:id/messages',asyncHandler(async(req,res)=>{res.json(await service.send(currentUser(res).userId,id(req.params.id),messageInput.parse(req.body)));}));
 router.post('/conversations/:id/read',asyncHandler(async(req,res)=>{res.json(await service.read(currentUser(res).userId,id(req.params.id),readInput.parse(req.body).upToSeq));}));
 router.patch('/conversations/:id/preferences',asyncHandler(async(req,res)=>{res.json(await service.preferences(currentUser(res).userId,id(req.params.id),conversationPreferences.parse(req.body)));}));
 return router;
}
