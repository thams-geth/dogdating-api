import { Router } from 'express';import { z } from 'zod';import type { Pool } from 'pg';
import { transaction } from '../../db/transaction.js';import { ApiError } from '../../middleware/error.js';import { authenticate,currentUser } from '../../http/authenticate.js';import { asyncHandler } from '../../http/async-handler.js';import type { AuthService } from '../auth/auth.service.js';
export function waitlistRoutes(db:Pool,auth?:AuthService){const router=Router();router.use(authenticate(auth));
 router.post('/',asyncHandler(async(req,res)=>{const input=z.object({metroId:z.string().uuid()}).strict().parse(req.body),userId=currentUser(res).userId;
  const result=await transaction(db,async tx=>{
   await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE',[userId]);
   if(!(await tx.query("SELECT 1 FROM ops.metros m JOIN identity.users u ON u.country_code=m.country WHERE m.id=$1 AND u.id=$2 AND m.launch_state IN ('seeding','waitlist','gated')",[input.metroId,userId])).rowCount)throw new ApiError(409,'waitlist-unavailable','Choose an area currently accepting waitlist interest.');
   const previous=(await tx.query('SELECT id,metro_id AS "metroId",created_at AS "createdAt" FROM identity.waitlist WHERE user_id=$1 AND metro_id=$2',[userId,input.metroId])).rows[0];if(previous)return previous;
   if((await tx.query('SELECT count(*)::int n FROM identity.waitlist WHERE user_id=$1',[userId])).rows[0].n>=5)throw new ApiError(409,'waitlist-limit','At most five areas may be saved.');
   return (await tx.query('INSERT INTO identity.waitlist(user_id,metro_id) VALUES($1,$2) RETURNING id,metro_id AS "metroId",created_at AS "createdAt"',[userId,input.metroId])).rows[0];
  });res.status(201).json({...result,notificationDelivery:'unavailable'});
 }));
 router.get('/',asyncHandler(async(_req,res)=>{res.json({items:(await db.query('SELECT id,metro_id AS "metroId",created_at AS "createdAt" FROM identity.waitlist WHERE user_id=$1 ORDER BY id',[currentUser(res).userId])).rows});}));
 router.delete('/:id',asyncHandler(async(req,res)=>{await db.query('DELETE FROM identity.waitlist WHERE id=$1 AND user_id=$2',[z.string().uuid().parse(req.params.id),currentUser(res).userId]);res.sendStatus(204);}));return router;
}
