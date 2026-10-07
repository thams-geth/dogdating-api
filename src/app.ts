import express from 'express';
import { randomUUID } from 'node:crypto';
import { pool } from './db/pool.js';
import { errorHandler, notFound } from './middleware/error.js';

export const app = express();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Request-Id', randomUUID());
  next();
});
app.use(express.json({ limit: '64kb' }));

app.get('/v1/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/v1/ready', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch (error) {
    next(error);
  }
});

app.get('/v1/dogs/breeds', async (_req, res, next) => {
  try {
    const result = await pool.query<{
      id: string;
      canonical_name: string;
      size_class: string;
      typical_energy: number | null;
      required_health_tests: string[];
      extreme_conformation_flags: string[];
    }>(`SELECT id, canonical_name, size_class::text AS size_class, typical_energy,
                required_health_tests, extreme_conformation_flags
           FROM graph.breeds ORDER BY canonical_name`);
    res.json({ breeds: result.rows.map((row) => ({
      id: row.id,
      name: row.canonical_name,
      sizeClass: row.size_class,
      typicalEnergy: row.typical_energy,
      requiredHealthTests: row.required_health_tests,
      conformationFlags: row.extreme_conformation_flags,
    })) });
  } catch (error) {
    next(error);
  }
});

app.use(notFound);
app.use(errorHandler);
