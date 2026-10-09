import { Router } from 'express';
import { z } from 'zod';
import { authenticate,currentUser } from '../../http/authenticate.js';
import { asyncHandler } from '../../http/async-handler.js';
import { pageQuery } from '../../http/pagination.js';
import type { AuthService } from '../auth/auth.service.js';
import type { NotificationsService } from './notifications.service.js';
import { deviceInput,preferencesInput,notificationRead } from './notifications.schemas.js';
export function notificationRoutes(service:NotificationsService,auth?:AuthService){
 const router=Router();router.use(authenticate(auth));
 router.get('/notifications',asyncHandler(async(req,res)=>{const q=pageQuery.parse(req.query);res.json(await service.list(currentUser(res).userId,q.limit,q.cursor));}));
 router.post('/notifications/read',asyncHandler(async(req,res)=>{await service.read(currentUser(res).userId,notificationRead.parse(req.body).ids);res.sendStatus(204);}));
 router.get('/me/notification-preferences',asyncHandler(async(_req,res)=>{res.json(await service.preferences(currentUser(res).userId));}));
 router.put('/me/notification-preferences',asyncHandler(async(req,res)=>{res.json(await service.savePreferences(currentUser(res).userId,preferencesInput.parse(req.body)));}));
 router.put('/me/devices/:id',asyncHandler(async(req,res)=>{res.json(await service.register(currentUser(res),z.string().uuid().parse(req.params.id),deviceInput.parse(req.body)));}));
 router.delete('/me/devices/:id',asyncHandler(async(req,res)=>{await service.remove(currentUser(res).userId,z.string().uuid().parse(req.params.id));res.sendStatus(204);}));return router;
}
