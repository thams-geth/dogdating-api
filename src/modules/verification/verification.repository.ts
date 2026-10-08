import type { PoolClient } from 'pg';
import { ApiError } from '../../middleware/error.js';
import { DogsRepository } from '../dogs/dogs.repository.js';
export const verificationProjection = `id,subject_type AS "subjectType",subject_id AS "subjectId",target_tier AS "targetTier",
 state,decision_reason_code AS "reasonCode",created_at AS "createdAt",updated_at AS "updatedAt",
 CASE WHEN state IN ('approved','rejected','expired','withdrawn') THEN 'none' WHEN provider IS NULL THEN 'awaiting_provider_setup'
 WHEN state='needs_more_info' THEN 'contact_support' ELSE 'awaiting_review' END AS "nextAction"`;
export const healthProjection = `id,dog_id AS "dogId",record_type AS "recordType",tested_at::text AS "testedAt",
 expires_at::text AS "expiresAt",result_code AS "resultCode",verified_at AS "verifiedAt",created_at AS "createdAt",
 CASE WHEN verified_at IS NULL THEN 'self_reported' ELSE 'reviewed' END AS provenance,
 (expires_at IS NOT NULL AND expires_at < (now() AT TIME ZONE 'UTC')::date) AS expired`;
export class VerificationRepository {
  readonly dogs = new DogsRepository();
  async lockUser(tx: PoolClient, id: string) { await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE', [id]); }
  async request(tx: PoolClient, id: string, userId: string) {
    const row = (await tx.query('SELECT * FROM verify.verification_requests WHERE id=$1 AND requested_by=$2', [id, userId])).rows[0];
    if (!row) throw new ApiError(404, 'not-found', 'Verification request not found.');
    if (row.subject_type === 'dog') await this.dogs.lock(tx, row.subject_id, userId);
    return row;
  }
  async status(tx: PoolClient, id: string) {
    return (await tx.query(`SELECT ${verificationProjection} FROM verify.verification_requests WHERE id=$1`, [id])).rows[0];
  }
}
