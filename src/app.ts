import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { pool } from './db/pool.js';
import { ApiError, errorHandler, notFound } from './middleware/error.js';
import { asyncHandler } from './http/async-handler.js';
import { appRoutes } from './modules/app/app.routes.js';
import { defaultPolicy, policySchema, type AppPolicy } from './modules/app/policy.js';
import { breedRoutes } from './modules/breeds/breeds.routes.js';

export function createApp(deps: { database?: Pool; policy?: AppPolicy } = {}) {
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
      const result = await database.query('SELECT version FROM ops.schema_migrations WHERE version = $1', ['0011']);
      if (!result.rowCount) throw new Error('Schema not ready');
    } catch {
      throw new ApiError(503, 'not-ready', 'Database or required schema is unavailable.');
    }
    res.json({ status: 'ready' });
  }));
  app.use('/v1/app', appRoutes(policySchema.parse(deps.policy ?? defaultPolicy)));
  app.use('/v1/dogs/breeds', breedRoutes(database));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

export const app = createApp();
