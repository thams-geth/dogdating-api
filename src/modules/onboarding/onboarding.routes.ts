import { Router } from 'express';
import { asyncHandler } from '../../http/async-handler.js';
import { authenticate,currentUser } from '../../http/authenticate.js';
import type { AuthService } from '../auth/auth.service.js';
import type { OnboardingService } from './onboarding.service.js';
import { purposeSchema,legalQuery,consentSchema,onboardingPreferencesSchema,activeDogSchema,preferencesSchema,emptyBody } from './onboarding.schemas.js';

export function legalRoutes(service: OnboardingService) {
  const router=Router();
  router.get('/documents/:kind',asyncHandler(async (req,res)=>res.json(await service.document(purposeSchema.parse(req.params.kind),legalQuery.parse(req.query)))));
  return router;
}
export function onboardingRoutes(service: OnboardingService, auth?: AuthService) {
  const router=Router(); router.use(authenticate(auth));
  router.get('/onboarding',asyncHandler(async (_req,res)=>res.json(await service.progress(currentUser(res).userId))));
  router.put('/onboarding/preferences',asyncHandler(async (req,res)=>res.json(await service.saveOnboarding(currentUser(res).userId,onboardingPreferencesSchema.parse(req.body)))));
  router.post('/onboarding/complete',asyncHandler(async (req,res)=>{ emptyBody.parse(req.body??{}); res.json(await service.complete(currentUser(res).userId)); }));
  router.get('/consents',asyncHandler(async (_req,res)=>res.json(await service.consentState(currentUser(res).userId))));
  router.post('/consents',asyncHandler(async (req,res)=>res.json(await service.accept(currentUser(res).userId,consentSchema.parse(req.body).documentId))));
  router.delete('/consents/:purpose',asyncHandler(async (req,res)=>{ await service.withdraw(currentUser(res).userId,purposeSchema.parse(req.params.purpose));res.sendStatus(204); }));
  router.put('/active-dog',asyncHandler(async (req,res)=>res.json(await service.selectDog(currentUser(res).userId,activeDogSchema.parse(req.body).dogId))));
  router.get('/preferences',asyncHandler(async (_req,res)=>res.json(await service.preferences(currentUser(res).userId))));
  router.patch('/preferences',asyncHandler(async (req,res)=>res.json(await service.savePreferences(currentUser(res).userId,preferencesSchema.parse(req.body)))));
  return router;
}
