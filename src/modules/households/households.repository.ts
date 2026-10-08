import type { PoolClient } from 'pg';
export class HouseholdsRepository {
  async detail(tx:PoolClient,id:string,userId:string) {
    return (await tx.query(`SELECT h.id,h.name,h.created_at AS "createdAt",h.updated_at AS "updatedAt",m.role
      FROM identity.households h JOIN identity.household_members m ON m.household_id=h.id
      WHERE h.id=$1 AND m.user_id=$2 AND m.accepted_at IS NOT NULL AND h.deleted_at IS NULL`,[id,userId])).rows[0];
  }
  async audit(tx:PoolClient,userId:string,action:string,householdId:string) {
    await tx.query(`INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id)
      VALUES ($1,'user',$2,'household',$3)`,[userId,action,householdId]);
  }
}
