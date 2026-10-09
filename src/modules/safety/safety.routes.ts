import { Router } from 'express';import { z } from 'zod';import { rateLimit } from 'express-rate-limit';
import { asyncHandler } from '../../http/async-handler.js';import { ApiError } from '../../middleware/error.js';import { pageQuery } from '../../http/pagination.js';
import type { AuthService } from '../auth/auth.service.js';import { requestOtpSchema } from '../auth/auth.schemas.js';
import type { SafetyService } from './safety.service.js';import type { PrivacyService } from './privacy.service.js';import { reportInput,ticketInput,supportMessage,appealInput } from './safety.schemas.js';
export function safetyRoutes(service:SafetyService,privacy:PrivacyService,auth?:AuthService){const router=Router(),id=(v:unknown)=>z.string().uuid().parse(v);
 router.use((req,_res,next)=>/^\/(reports(?:\/|$)|support\/tickets(?:\/|$)|me\/(safety-notices|appeals|data-exports|deletion-requests)(?:\/|$)|privacy\/deletion\/otp\/)/.test(req.path)?next():next('router'));
 const limiter=rateLimit({windowMs:15*60000,limit:30,standardHeaders:'draft-7',legacyHeaders:false});
 router.post('/privacy/deletion/otp/request',limiter,asyncHandler(async(req,res)=>{if(!auth)throw new ApiError(503,'auth-unavailable','Phone verification is unavailable.');const input=requestOtpSchema.parse(req.body);await auth.requestOtp(input.phoneE164,input.countryCode,'privacy');res.status(202).json({status:'accepted'});}));
 router.post('/privacy/deletion/otp/verify',limiter,asyncHandler(async(req,res)=>{if(!auth)throw new ApiError(503,'auth-unavailable','Phone verification is unavailable.');const input=z.object({phoneE164:requestOtpSchema.shape.phoneE164,code:z.string().regex(/^\d{6}$/)}).strict().parse(req.body);res.json(await auth.verifyPrivacyOtp(input.phoneE164,input.code));}));
 for(const path of ['data-exports','deletion-requests'])router.get(`/me/${path}/:id`,asyncHandler(async(req,res)=>{res.json(await privacy.status(id(req.params.id),req.get('Privacy-Status-Token')??'',path==='data-exports'?'export':'deletion'));}));
 router.use(asyncHandler(async(req,res,next)=>{
  if(!auth)throw new ApiError(503,'auth-unavailable','Authentication is unavailable.');const token=req.get('Privacy-Token');
  if(token)res.locals.safetyPrincipal=await auth.authenticatePrivacy(token);else{const header=req.get('Authorization');if(!header?.startsWith('Bearer ')||header.length>4096)throw new ApiError(401,'unauthenticated','Authentication is required.');res.locals.safetyPrincipal=await auth.authenticate(header.slice(7));}next();
 }));const user=(res:{locals:Record<string,any>})=>res.locals.safetyPrincipal as {userId:string;familyId?:string};
 router.get('/me/data-exports/:id/download',asyncHandler(async(req,res)=>{const p=user(res),requestId=id(req.params.id);const artifact=await privacy.download(p.userId,requestId,p.familyId);res.setHeader('Content-Disposition',`attachment; filename=waggle-account-${requestId}.json`);res.json(artifact);}));
 router.post('/reports',asyncHandler(async(req,res)=>{res.status(201).json(await service.report(user(res).userId,reportInput.parse(req.body),id(req.get('Idempotency-Key'))));}));
 router.get('/reports/:id',asyncHandler(async(req,res)=>{res.json(await service.reportStatus(user(res).userId,id(req.params.id)));}));
 router.post('/support/tickets',asyncHandler(async(req,res)=>{res.status(201).json(await service.ticket(user(res).userId,ticketInput.parse(req.body),id(req.get('Idempotency-Key'))));}));
 router.get('/support/tickets',asyncHandler(async(req,res)=>{const q=pageQuery.parse(req.query);res.json(await service.tickets(user(res).userId,q.limit,q.cursor));}));
 router.get('/support/tickets/:id',asyncHandler(async(req,res)=>{const q=pageQuery.parse(req.query);res.json(await service.ticketDetail(user(res).userId,id(req.params.id),q.limit,q.cursor));}));
 router.post('/support/tickets/:id/messages',asyncHandler(async(req,res)=>{res.status(201).json(await service.reply(user(res).userId,id(req.params.id),supportMessage.parse(req.body).message,id(req.get('Idempotency-Key'))));}));
 router.get('/me/safety-notices',asyncHandler(async(req,res)=>{const q=pageQuery.parse(req.query);res.json(await service.notices(user(res).userId,q.limit,q.cursor));}));
 router.get('/me/appeals',asyncHandler(async(req,res)=>{const q=pageQuery.parse(req.query);res.json(await service.appeals(user(res).userId,q.limit,q.cursor));}));
 router.post('/me/appeals',asyncHandler(async(req,res)=>{res.status(201).json(await service.appeal(user(res).userId,appealInput.parse(req.body)));}));
 for(const [path,kind]of [['data-exports','export'],['deletion-requests','deletion']] as const)router.post(`/me/${path}`,asyncHandler(async(req,res)=>{z.object({}).strict().parse(req.body);const p=user(res);res.status(202).json(await privacy.request(p.userId,kind,p.familyId));}));return router;
}
