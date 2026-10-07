import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pool } from './pool.js';

const migrationsDir = resolve(fileURLToPath(new URL('../../migrations/', import.meta.url)));

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [8791701]);
    await client.query('CREATE SCHEMA IF NOT EXISTS ops');
    await client.query(`CREATE TABLE IF NOT EXISTS ops.schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);

    const files = (await readdir(migrationsDir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    for (const file of files) {
      const version = file.slice(0, 4);
      const sql = await readFile(resolve(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM ops.schema_migrations WHERE version = $1', [version],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Migration ${file} changed after application`);
        continue;
      }
      const started = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO ops.schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)',
          [version, checksum, Date.now() - started],
        );
        await client.query('COMMIT');
        process.stdout.write(`Applied ${file}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [8791701]);
    client.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  }).finally(() => pool.end());
}
