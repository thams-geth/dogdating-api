import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { z } from 'zod';
import { transaction } from '../../db/transaction.js';
import { ApiError } from '../../middleware/error.js';
import { decodeCursor, page } from '../../http/pagination.js';
import { VerificationRepository, healthProjection } from './verification.repository.js';
import type { verificationSchema, healthSchema } from './verification.schemas.js';

export class VerificationService {
  private readonly repo = new VerificationRepository();
  constructor(private readonly db: Pool) {}
  create(userId: string, input: z.infer<typeof verificationSchema>) { return transaction(this.db, async tx => {
    await this.repo.lockUser(tx, userId);
    const subjectType = input.kind === 'guardian' ? 'user' : 'dog';
    const subjectId = input.kind === 'guardian' ? userId : input.dogId;
    const tier = input.kind === 'guardian' ? 1 : 2;
    if (input.kind === 'dog') {
      const dog = await this.repo.dogs.lock(tx, subjectId, userId, ['owner', 'co_guardian']);
      if (dog.status !== 'active') throw new ApiError(409, 'dog-inactive', 'This dog profile can no longer be edited.');
    }
    const active = (await tx.query(`SELECT id FROM verify.verification_requests WHERE requested_by=$1 AND subject_type=$2 AND subject_id=$3 AND target_tier=$4
      AND state IN ('pending','in_review','needs_more_info')`, [userId, subjectType, subjectId, tier])).rows[0];
    if (active) return this.repo.status(tx, active.id);
    const recent = (await tx.query("SELECT count(*)::int AS n FROM verify.verification_requests WHERE requested_by=$1 AND created_at>now()-interval '1 day'", [userId])).rows[0]!.n;
    if (recent >= 3) throw new ApiError(429, 'verification-limit', 'At most three new verification requests per day are allowed.');
    const id = randomUUID();
    await tx.query(`INSERT INTO verify.verification_requests(id,subject_type,subject_id,target_tier,requested_by) VALUES ($1,$2,$3,$4,$5)`, [id, subjectType, subjectId, tier, userId]);
    await tx.query("INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id) VALUES ($1,'user','verification.request','verification',$2)", [userId, id]);
    return this.repo.status(tx, id);
  }); }
  status(userId: string, id: string) { return transaction(this.db, async tx => {
    await this.repo.lockUser(tx, userId); await this.repo.request(tx, id, userId); return this.repo.status(tx, id);
  }); }
  withdraw(userId: string, id: string) { return transaction(this.db, async tx => {
    await this.repo.lockUser(tx, userId); const row = await this.repo.request(tx, id, userId);
    if (row.state === 'withdrawn') return this.repo.status(tx, id);
    if (!['pending', 'in_review', 'needs_more_info'].includes(row.state)) throw new ApiError(409, 'verification-final', 'Only an open request can be withdrawn.');
    await tx.query("UPDATE verify.verification_requests SET state='withdrawn',updated_at=now() WHERE id=$1", [id]);
    await tx.query("INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id) VALUES ($1,'user','verification.withdraw','verification',$2)", [userId, id]);
    return this.repo.status(tx, id);
  }); }
  addHealth(userId: string, dogId: string, input: z.infer<typeof healthSchema>) { return transaction(this.db, async tx => {
    const dog = await this.repo.dogs.lock(tx, dogId, userId, ['owner', 'co_guardian']);
    if (dog.status !== 'active') throw new ApiError(409, 'dog-inactive', 'This dog profile can no longer be edited.');
    if (dog.dateOfBirth && input.testedAt < dog.dateOfBirth) throw new ApiError(400, 'invalid-dates', 'Health record cannot predate birth.');
    const count = (await tx.query(`SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS live,
      count(*) FILTER (WHERE created_at>now()-interval '1 day')::int AS recent FROM verify.health_records WHERE dog_id=$1`, [dogId])).rows[0]!;
    if (count.live >= 100 || count.recent >= 10) throw new ApiError(429, 'health-record-limit', 'Health record limit reached.');
    const id = randomUUID();
    await tx.query(`INSERT INTO verify.health_records(id,dog_id,record_type,tested_at,expires_at,result_code,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, dogId, input.recordType, input.testedAt, input.expiresAt, input.resultCode, userId]);
    return (await tx.query(`SELECT ${healthProjection} FROM verify.health_records WHERE id=$1`, [id])).rows[0];
  }); }
  listHealth(userId: string, dogId: string, limit: number, cursor?: string) { return transaction(this.db, async tx => {
    await this.repo.dogs.lock(tx, dogId, userId);
    const scope = `health:${userId}:${dogId}`, after = decodeCursor(cursor, scope);
    const rows = (await tx.query(`SELECT ${healthProjection} FROM verify.health_records WHERE dog_id=$1 AND deleted_at IS NULL
      AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`, [dogId, after, limit + 1])).rows;
    const result = page(rows as ({id:string}&Record<string,unknown>)[], limit, scope);
    return { records: result.items, nextCursor: result.nextCursor };
  }); }
  removeHealth(userId: string, dogId: string, id: string) { return transaction(this.db, async tx => {
    const dog = await this.repo.dogs.lock(tx, dogId, userId, ['owner', 'co_guardian']);
    if (dog.status !== 'active') throw new ApiError(409, 'dog-inactive', 'This dog profile can no longer be edited.');
    const row = (await tx.query('SELECT verified_at,deleted_at FROM verify.health_records WHERE id=$1 AND dog_id=$2', [id, dogId])).rows[0];
    if (!row) throw new ApiError(404, 'not-found', 'Health record not found.');
    if (row.deleted_at) return;
    await tx.query('UPDATE verify.health_records SET deleted_at=now() WHERE id=$1', [id]);
    if (row.verified_at) {
      await tx.query(`UPDATE verify.tiers_granted SET revoked_at=now(),revoked_reason='health_evidence_deleted' WHERE subject_type='dog' AND subject_id=$1 AND tier>=3 AND revoked_at IS NULL`, [dogId]);
      await this.repo.dogs.invalidate(tx, dogId);
    }
    await tx.query("INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id) VALUES ($1,'user','health_record.delete','health_record',$2)", [userId, id]);
  }); }
}
