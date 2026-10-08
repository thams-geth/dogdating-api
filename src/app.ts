import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { pool } from './db/pool.js';
import { ApiError, errorHandler, notFound } from './middleware/error.js';
import { asyncHandler } from './http/async-handler.js';
import { appRoutes } from './modules/app/app.routes.js';
import { defaultPolicy, policySchema, type AppPolicy } from './modules/app/policy.js';
import { breedRoutes } from './modules/breeds/breeds.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { AuthService } from './modules/auth/auth.service.js';
import { DevelopmentOtpSender } from './modules/auth/otp-sender.js';
import { OnboardingService } from './modules/onboarding/onboarding.service.js';
import { legalRoutes,onboardingRoutes } from './modules/onboarding/onboarding.routes.js';
import { HouseholdsService } from './modules/households/households.service.js';
import { householdRoutes,invitationRoutes } from './modules/households/households.routes.js';
import { DogsService } from './modules/dogs/dogs.service.js';
import { dogRoutes } from './modules/dogs/dogs.routes.js';
import { config } from './config.js';

export function createApp(deps: { database?: Pool; policy?: AppPolicy; auth?: AuthService } = {}) {
  const database = deps.database ?? pool;
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.get('/v1/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/v1/ready', asyncHandler(async (_req, res) => {
    try {
      const result = await database.query('SELECT version FROM ops.schema_migrations WHERE version = $1', ['0014']);
      if (!result.rowCount) throw new Error('Schema not ready');
    } catch {
      throw new ApiError(503, 'not-ready', 'Database or required schema is unavailable.');
    }
    res.json({ status: 'ready' });
  }));
  app.use('/v1/app', appRoutes(policySchema.parse(deps.policy ?? defaultPolicy)));
  app.use('/v1/dogs/breeds', breedRoutes(database));
  const auth = deps.auth ?? (config.OTP_MODE === 'development' && config.AUTH_SECRET
    ? new AuthService(database, config.AUTH_SECRET, new DevelopmentOtpSender(config.NODE_ENV)) : undefined);
  app.use('/v1', authRoutes(auth));
  const onboarding=new OnboardingService(database);
  app.use('/v1/legal',legalRoutes(onboarding));
  app.use('/v1/me',onboardingRoutes(onboarding,auth));
  const households=new HouseholdsService(database,(phone)=> {
    if(!auth)throw new ApiError(503,'auth-unavailable','Authentication is not configured.');
    return auth.phoneIndex(phone);
  });
  app.use('/v1/households',householdRoutes(households,auth));
  app.use('/v1/household-invitations',invitationRoutes(households,auth));
  app.use('/v1/dogs',dogRoutes(new DogsService(database),auth));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

export const app = createApp();
