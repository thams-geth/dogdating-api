import { z } from 'zod';
import { authenticate } from '../../http/authenticate.js';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { asyncHandler } from '../../http/async-handler.js';
import { ApiError } from '../../middleware/error.js';
import type { AuthService, Principal } from './auth.service.js';
import { requestOtpSchema, verifyOtpSchema, refreshSchema, profileSchema, uuidSchema } from './auth.schemas.js';

export function authRoutes(service?: AuthService): Router {
  const router = Router();
  router.use((req, _res, next) => {
    if (req.path !== '/me' && !req.path.startsWith('/auth/')) return next('router');
    next();
  });
  // Process-local IP defence for the development milestone. Shared enforcement is a launch gate.
  const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req, _res, next) => next(new ApiError(429, 'rate-limited', 'Too many requests. Try again later.')) });
  router.use((_req, _res, next) => service ? next() : next(new ApiError(503, 'auth-unavailable', 'Authentication is not configured.')));
  router.post('/auth/otp/request', limiter, asyncHandler(async (req, res) => {
    const input = requestOtpSchema.parse(req.body);
    await service!.requestOtp(input.phoneE164, input.countryCode);
    res.status(202).json({ status: 'accepted' });
  }));
  router.post('/auth/otp/verify', limiter, asyncHandler(async (req, res) => res.json(await service!.verifyOtp(verifyOtpSchema.parse(req.body)))));
  router.post('/auth/refresh', limiter, asyncHandler(async (req, res) => res.json(await service!.refresh(refreshSchema.parse(req.body).refreshToken))));
  router.use(authenticate(service));
  const principal = (locals: Record<string, unknown>) => locals.principal as Principal;
  router.post('/auth/phone-change/request',limiter,asyncHandler(async(req,res)=>{const input=requestOtpSchema.parse(req.body);await service!.requestPhoneChange(principal(res.locals),input.phoneE164,input.countryCode);res.status(202).json({status:'accepted'});}));
  router.post('/auth/phone-change/verify',limiter,asyncHandler(async(req,res)=>{const input=z.object({phoneE164:requestOtpSchema.shape.phoneE164,code:z.string().regex(/^\d{6}$/)}).strict().parse(req.body);res.json(await service!.verifyPhoneChange(principal(res.locals),input.phoneE164,input.code));}));
  router.post('/auth/logout', asyncHandler(async (_req, res) => { await service!.logout(principal(res.locals)); res.sendStatus(204); }));
  router.post('/auth/logout-all', asyncHandler(async (_req, res) => { await service!.logoutAll(principal(res.locals)); res.sendStatus(204); }));
  router.get('/auth/sessions', asyncHandler(async (_req, res) => res.json(await service!.sessions(principal(res.locals)))));
  router.delete('/auth/sessions/:id', asyncHandler(async (req, res) => {
    await service!.revokeSession(principal(res.locals), uuidSchema.parse(req.params.id)); res.sendStatus(204);
  }));
  router.get('/me', asyncHandler(async (_req, res) => res.json(await service!.me(principal(res.locals)))));
  router.patch('/me', asyncHandler(async (req, res) => res.json(await service!.updateMe(principal(res.locals), profileSchema.parse(req.body)))));
  return router;
}
