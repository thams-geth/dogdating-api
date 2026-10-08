import type { Pool } from 'pg';
import { transaction } from '../../db/transaction.js';
import { ApiError } from '../../middleware/error.js';
import { decodeCursor, page } from '../../http/pagination.js';

export class BlocksService {
  constructor(private readonly db: Pool) {}
  async list(userId: string, limit: number, cursor?: string) {
    const scope = `blocks:${userId}`, after = decodeCursor(cursor, scope);
    const rows = (await this.db.query(`SELECT blocked_user_id AS id,created_at AS "createdAt" FROM safety.blocks
      WHERE blocker_user_id=$1 AND ($2::uuid IS NULL OR blocked_user_id>$2) ORDER BY blocked_user_id LIMIT $3`, [userId, after, limit+1])).rows;
    const result = page(rows as {id:string;createdAt:Date}[], limit, scope);
    return { blocks: result.items.map(row => ({userId: row.id, createdAt: row.createdAt})), nextCursor: result.nextCursor };
  }
  add(userId: string, targetId: string) { return transaction(this.db, async tx => {
    if (userId === targetId) throw new ApiError(400, 'self-block', 'You cannot block yourself.');
    // Stable user lock order serializes reciprocal blocks. No household locks are acquired.
    await tx.query('SELECT id FROM identity.users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[userId,targetId]]);
    const target = await tx.query('SELECT id FROM identity.users WHERE id=$1 AND deleted_at IS NULL AND deletion_requested_at IS NULL', [targetId]);
    if (!target.rowCount) throw new ApiError(404, 'not-found', 'User not found.');
    const existing = await tx.query('SELECT 1 FROM safety.blocks WHERE blocker_user_id=$1 AND blocked_user_id=$2', [userId,targetId]);
    if (existing.rowCount) return;
    const count = (await tx.query('SELECT count(*)::int AS n FROM safety.blocks WHERE blocker_user_id=$1', [userId])).rows[0]!.n;
    if (count >= 500) throw new ApiError(409, 'block-limit', 'The maximum of five hundred blocked users has been reached.');
    await tx.query('INSERT INTO safety.blocks(blocker_user_id,blocked_user_id) VALUES ($1,$2)', [userId,targetId]);
    await tx.query(`WITH affected AS (
      UPDATE meetup.matches m SET state='blocked',ended_at=now(),ended_by=$1,end_reason='user_block'
      FROM graph.dogs a,graph.dogs b
      WHERE a.id=m.dog_a_id AND b.id=m.dog_b_id AND m.state='active'
      AND EXISTS (SELECT 1 FROM identity.household_members x JOIN identity.household_members y ON y.user_id=$2 AND y.accepted_at IS NOT NULL
        WHERE x.user_id=$1 AND x.accepted_at IS NOT NULL
        AND ((x.household_id=a.household_id AND y.household_id=b.household_id) OR (x.household_id=b.household_id AND y.household_id=a.household_id)))
      RETURNING m.id)
      UPDATE meetup.conversations SET state='closed' WHERE match_id IN (SELECT id FROM affected)`, [userId,targetId]);
    await tx.query("INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id) VALUES ($1,'user','user.block','user',$2)", [userId,targetId]);
  }); }
  remove(userId: string, targetId: string) { return transaction(this.db, async tx => {
    await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE', [userId]);
    const result = await tx.query('DELETE FROM safety.blocks WHERE blocker_user_id=$1 AND blocked_user_id=$2', [userId,targetId]);
    if (result.rowCount) await tx.query("INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id) VALUES ($1,'user','user.unblock','user',$2)", [userId,targetId]);
    // An unblock never reopens old matches/conversations or removes the other user's block.
  }); }
}
